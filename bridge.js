#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {atomic,applyProxy,restoreProxy} from './lib/settings.js';
import {gatewayModels} from './lib/config.js';
import {read as readBridgeSettings,applyModelPreferences} from './lib/bridge-settings.js';
import platform from './lib/platform.js';
import {createSupervisor} from './lib/supervisor.js';
import {pruneDatabase} from './control/database.js';
import {version} from './version.js';

const packageDir=path.dirname(fileURLToPath(import.meta.url));
const root=process.env.CURSOR_BRIDGE_ROOT||platform.current.paths().config;
const settings=process.env.CURSOR_BRIDGE_SETTINGS||platform.current.cursorSettings();
const file=name=>path.join(root,name);
let lastStatus='';
const status=(state,extra={})=>{const signature=JSON.stringify({version,state,...extra});if(signature!==lastStatus){atomic(file('status.json'),JSON.stringify({version,state,...extra,updated:new Date().toISOString()},null,2));lastStatus=signature;}};
// On Windows Magpie's agent sandbox writes connection.json to its own
// fallback path (see connectionFilesFor); accept the first file that exists.
// A rooted install (tests, portable copies) must not fall back to the real
// profile, so its own connection.json is tried first.
const connectionFiles=process.env.CURSOR_BRIDGE_ROOT
  ?[file('connection.json'),...platform.current.connectionFiles()]
  :platform.current.connectionFiles();
function connectionText() {
  for(const candidate of connectionFiles) {
    try {return fs.readFileSync(candidate,'utf8');} catch { /* try the next candidate */ }
  }
  return '{}';
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Native diagnostics stay local: 0600 file next to the other bridge state,
// rotated at the size the control panel configured (default 4 MiB). Writes go
// through a descriptor so rotation happens while the supervisor runs; a stream
// created once would let engine.log grow without bound until the next restart.
let engineLogFd=null;
let engineLogSize=0;
let engineLogLimit=0;
function openEngineLog() {
  if(engineLogFd!==null) return engineLogFd;
  const log=file('engine.log');
  if(!engineLogLimit) engineLogLimit=readBridgeSettings(root).logLimitMB*1024*1024;
  try {engineLogSize=fs.statSync(log).size;} catch {engineLogSize=0;}
  if(engineLogSize>engineLogLimit) {
    try {fs.renameSync(log,file('engine.log.1'));} catch {}
    engineLogSize=0;
  }
  engineLogFd=fs.openSync(log,'a',0o600);
  return engineLogFd;
}
function appendEngineLog(chunk) {
  try {
    const fd=openEngineLog();
    fs.writeSync(fd,chunk);
    engineLogSize+=chunk.length;
    if(engineLogSize>engineLogLimit) {
      try {fs.closeSync(fd);} catch {}
      engineLogFd=null;
      try {fs.renameSync(file('engine.log'),file('engine.log.1'));} catch {}
      engineLogSize=0;
    }
  } catch { /* logging must never take the supervisor down */ }
}
// A reused pid must not look like a live supervisor: match the command line too.
function isLiveSupervisor(pid) {
  if(!Number.isInteger(pid)||pid<=0||pid===process.pid) return false;
  try {process.kill(pid,0);} catch {return false;}
  try {
    const probe=platform.current.processCommand(pid);
    if(!probe) return false;
    const line=execFileSync(probe.command,probe.args,{encoding:'utf8',stdio:['ignore','pipe','ignore'],windowsHide:true}).trim();
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
  if(!platform.IS_WIN) process.umask(0o077);
  const lock=file('supervisor.lock');
  try {fs.mkdirSync(lock);} catch(error) {
    let live=false;
    try {live=isLiveSupervisor(Number(fs.readFileSync(path.join(lock,'pid'),'utf8')));} catch {}
    if(live) throw new Error('bridge supervisor already running');
    fs.rmSync(lock,{recursive:true,force:true}); fs.mkdirSync(lock);
  }
  fs.writeFileSync(path.join(lock,'pid'),String(process.pid));
  let ending=false;
  // Lite mode starts from an empty in-memory database, so the proxy port cannot
  // be read back from SQLite. Carry the last port across restarts: Cursor does
  // not re-read http.proxy until it restarts.
  let preferredProxyPort='';
  try {const last=JSON.parse(fs.readFileSync(file('status.json'),'utf8'));const url=new URL(last.proxy);if(url.port) preferredProxyPort=url.port;} catch {}
  const supervisor=createSupervisor({
    initialProxyPort:preferredProxyPort,
    readSettings:()=>readBridgeSettings(root),
    readConnection:connectionText,
    // gatewayModels returns the whole connection object; only its models array
    // takes the display-name and order overrides.
    fetchCatalogue:async(connection,config)=>{
      const catalogue=await gatewayModels(connection);
      return {...catalogue,models:applyModelPreferences(catalogue.models,{modelNames:config.modelNames,modelOrder:config.modelOrder,modelHidden:config.modelHidden,keep:connection.model})};
    },
    writeEffective:text=>atomic(file('effective.json'),text),
    // status.json always advertises the configured mode, so the control panel
    // can tell "saved but not yet applied" apart from the running engine's mode.
    publish:(state,extra)=>status(state,extra),
    applyProxy:proxy=>applyProxy(settings,file('settings-journal.json'),proxy),
    restoreProxy:()=>restoreProxy(file('settings-journal.json')),
    // Automatic retention runs in this process, online: it batches deletes and
    // never stops the engine or vacuums. The result is kept for the console.
    pruneDatabase:({tracesDays,sessionsDays})=>pruneDatabase(file('data/bridge.db'),{tracesDays,sessionsDays}),
    onPrune:result=>atomic(file('retention.json'),JSON.stringify(result,null,2)),
    spawnEngine:({mode,subagentMode,preferredProxyPort:port})=>spawn(platform.enginePathFor(packageDir),[file('effective.json')],{
      env:{...process.env,CURSOR_BYOK_DATA_DIR:file('data'),CURSOR_BRIDGE_RUN_MODE:mode,CURSOR_BRIDGE_SUBAGENT_MODE:subagentMode,...(port?{CURSOR_BRIDGE_PROXY_PORT:port}:{})},stdio:['pipe','pipe','pipe'],windowsHide:true
    }),
    // Native diagnostics can contain request information; keep them in a private local file.
    onEngineStderr:appendEngineLog,
    wait,
    isEnding:()=>ending
  });
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{ending=true;});
  try {
    await supervisor.run();
  } finally {
    fs.rmSync(lock,{recursive:true,force:true});
  }
} else {throw new Error('usage: node bridge.js status|supervise|restore');}
