#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {atomic,applyProxy,restoreProxy} from './lib/settings.js';
import {validate,gatewayModels} from './lib/config.js';
import {read as readBridgeSettings} from './lib/bridge-settings.js';
import platform from './lib/platform.js';

const packageDir=path.dirname(fileURLToPath(import.meta.url));
const version=JSON.parse(fs.readFileSync(path.join(packageDir,'package.json'),'utf8')).version;
const root=process.env.CURSOR_BRIDGE_ROOT||platform.current.paths().config;
const settings=process.env.CURSOR_BRIDGE_SETTINGS||platform.current.cursorSettings();
const file=name=>path.join(root,name);
let lastStatus='';
const status=(state,extra={})=>{const signature=JSON.stringify({version,state,...extra});if(signature!==lastStatus){atomic(file('status.json'),JSON.stringify({version,state,...extra,updated:new Date().toISOString()},null,2));lastStatus=signature;}};
const read=name=>JSON.parse(fs.readFileSync(file(name),'utf8'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Native diagnostics stay local: 0600 file next to the other bridge state,
// rotated at the size the control panel configured (default 4 MiB).
let engineLogStream=null;
function engineLog() {
  if(engineLogStream) return engineLogStream;
  const log=file('engine.log');
  const limit=readBridgeSettings(root).logLimitMB*1024*1024;
  try {if(fs.statSync(log).size>limit) fs.renameSync(log,file('engine.log.1'));} catch {}
  engineLogStream=fs.createWriteStream(log,{flags:'a',mode:0o600});
  engineLogStream.on('error',()=>{engineLogStream=null;});
  return engineLogStream;
}
// A reused pid must not look like a live supervisor: match the command line too.
function isLiveSupervisor(pid) {
  if(!Number.isInteger(pid)||pid<=0||pid===process.pid) return false;
  try {process.kill(pid,0);} catch {return false;}
  try {
    const probe=platform.current.processCommand(pid);
    if(!probe) return false;
    const line=execFileSync(probe.command,probe.args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    return line.includes('bridge.js')&&line.includes('supervise');
  } catch {return false;}
}
const command=process.argv[2]||'status';
if(command==='status') {
  console.log(fs.existsSync(file('status.json'))?fs.readFileSync(file('status.json'),'utf8'):'未安装或尚未运行');
} else if(command==='restore') {
  console.log(JSON.stringify({preservedExternalChanges:restoreProxy(file('settings-journal.json'))}));
} else if(command==='supervise') {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  process.umask(0o077);
  const lock=file('supervisor.lock');
  try {fs.mkdirSync(lock);} catch(error) {
    let live=false;
    try {live=isLiveSupervisor(Number(fs.readFileSync(path.join(lock,'pid'),'utf8')));} catch {}
    if(live) throw new Error('bridge supervisor already running');
    fs.rmSync(lock,{recursive:true,force:true}); fs.mkdirSync(lock);
  }
  fs.writeFileSync(path.join(lock,'pid'),String(process.pid));
  let child=null,ready=null,ending=false,lastConfig='',nextRefresh=0,paused=false,catalogueDownSince=0,lastModelCount=0,lastEffective='',runningMode='default',activeMode='default',runningSubagentMode='async';
  // Lite mode starts from an empty in-memory database, so the proxy port cannot
  // be read back from SQLite. Carry the last port across restarts: Cursor does
  // not re-read http.proxy until it restarts.
  let preferredProxyPort='';
  try {const last=JSON.parse(fs.readFileSync(file('status.json'),'utf8'));const url=new URL(last.proxy);if(url.port) preferredProxyPort=url.port;} catch {}
  // status.json always advertises the configured mode, so the control panel can
  // tell "saved but not yet applied" apart from the running engine's mode.
  const update=(state,extra={})=>status(state,{mode:activeMode,engineMode:runningMode||null,...extra});
  async function stop() {
    // Restore before stopping the listener so Cursor does not point at a dead port.
    const old=child;child=null;ready=null;runningMode='';runningSubagentMode='';
    try {
      return restoreProxy(file('settings-journal.json'));
    } finally {
      if(old && old.exitCode===null && old.signalCode===null) {
        old.kill('SIGTERM');
        await Promise.race([new Promise(r=>old.once('exit',r)),wait(12000)]);
        if(old.exitCode===null && old.signalCode===null) {
          old.kill('SIGKILL');
          await new Promise(r=>old.once('exit',r));
        }
      }
    }
  }
  async function start(c,mode,subagentMode) {
    const serialized=JSON.stringify(c);
    atomic(file('effective.json'),serialized);
    lastEffective=serialized;
    const engine=spawn(path.join(packageDir,'bin/cursor-magpie-bridge'),[file('effective.json')],{
      env:{...process.env,CURSOR_BYOK_DATA_DIR:file('data'),CURSOR_BRIDGE_RUN_MODE:mode,CURSOR_BRIDGE_SUBAGENT_MODE:subagentMode,...(preferredProxyPort?{CURSOR_BRIDGE_PROXY_PORT:preferredProxyPort}:{})},stdio:['pipe','pipe','pipe']
    });
    runningMode=mode;runningSubagentMode=subagentMode;
    child=engine;
    // Native diagnostics can contain request information; keep them in a private local file.
    engine.stderr.pipe(engineLog(),{end:false});
    ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('bridge startup timed out')),30000);
      const lines=createInterface({input:engine.stdout});
      lines.on('line',line=>{try{const msg=JSON.parse(line);if(msg.event==='ready'){clearTimeout(timer);resolve(msg);}}catch{}});
      engine.once('error',(error)=>{clearTimeout(timer);reject(new Error(`cannot start bridge engine (${error.code||error.message}); this build ships a ${process.platform} engine only when its binary matches the platform`));});
      engine.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error(`bridge engine stopped (${signal||code}); check certificate trust`));});
    });
    try {const url=new URL(ready.proxy);if(url.port) preferredProxyPort=url.port;} catch {}
    applyProxy(settings,file('settings-journal.json'),ready.proxy);
  }
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{ending=true;});
  try {
    restoreProxy(file('settings-journal.json'));
    while(!ending) {
      const cfg=readBridgeSettings(root);
      activeMode=cfg.runMode;
      try {
        const raw=fs.existsSync(file('connection.json'))?fs.readFileSync(file('connection.json'),'utf8'):'{}';
        const c=validate(JSON.parse(raw));
        if(!c) {await stop();update('disconnected');paused=false;lastConfig='';}
        else if(paused && raw===lastConfig) {update('paused',{reason:'Cursor 代理设置由其他程序改动；请在 Magpie 中断开后重新连接。'});}
        else {
          const changed=raw!==lastConfig;
          const engineAlive=!!child && child.exitCode===null && child.signalCode===null;
          // A saved run mode is applied by restarting the engine once; the
          // supervisor never rewrites effective.json just for a mode switch.
          const modeChanged=engineAlive && runningMode!==cfg.runMode;
          const subagentModeChanged=engineAlive && runningSubagentMode!==cfg.subagentMode;
          if(changed || Date.now()>=nextRefresh || !engineAlive || modeChanged || subagentModeChanged) {
            let effective=null,failure=null;
            try {effective=await gatewayModels(c);} catch(e) {failure=e;}
            nextRefresh=Date.now()+cfg.refreshSeconds*1000;
            if(failure) {
              // A transient Magpie hiccup must not drop Cursor's proxy: keep the running
              // engine (and its port) and only fall back once the outage is sustained.
              if(!catalogueDownSince) catalogueDownSince=Date.now();
              const downFor=Date.now()-catalogueDownSince;
              if(!engineAlive || downFor>=cfg.gatewayGraceSeconds*1000) throw failure;
              update('connected',{model:c.model,models:lastModelCount,proxy:ready.proxy,backend:ready.backend,pid:child.pid,warning:`Magpie gateway unavailable for ${Math.round(downFor/1000)}s: ${failure.message}`});
              await wait(2000);
              continue;
            }
            catalogueDownSince=0;
            if(!engineAlive || modeChanged || subagentModeChanged) {
              await stop();await start(effective,cfg.runMode,cfg.subagentMode);
            } else {
              const serialized=JSON.stringify(effective);
              if(serialized!==lastEffective) {atomic(file('effective.json'),serialized);lastEffective=serialized;}
            }
            lastConfig=raw;paused=false;lastModelCount=effective.models.length;
            update('connected',{model:c.model,models:effective.models.length,proxy:ready.proxy,backend:ready.backend,pid:child.pid});
          }
          try {applyProxy(settings,file('settings-journal.json'),ready.proxy);} catch(e) {
            await stop();paused=true;lastConfig=raw;throw e;
          }
        }
      } catch(e) {
        try {await stop();} catch { /* keep journal for recovery after malformed settings are fixed */ }
        update('error',{reason:e.message});
      }
      if(!ending) await wait(2000);
    }
  } finally {
    await stop();update('stopped');fs.rmSync(lock,{recursive:true,force:true});
  }
} else {throw new Error('usage: node bridge.js status|supervise|restore');}
