import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {atomic,restoreProxy} from './settings.js';
import platform from './platform.js';

export const label='local.magpie.cursor-bridge';
export const payload=['agent.js','agent-platform.js','bridge.js','install.js','setup.command','package.json','lib','vendor','control','ui','bin','README.md','LICENSE','THIRD_PARTY_NOTICES.md'];
export function run(command,args,options={}) {
  const result=spawnSync(command,args,{encoding:'utf8',...options});
  if(result.status!==0&&!options.optional) throw new Error(`${path.basename(command)} failed: ${(result.stderr||result.stdout||result.error?.message||'').slice(0,1000)}`);
  return result;
}
export function paths(home) {
  const layout=platform.pathsFor(home);
  return {home,root:layout.config,target:layout.share,plist:layout.plist};
}
function dependencyDirectory(source) {
  // The JSONC parser is vendored so a GitHub install works without npm install.
  const directory=path.join(source,'vendor/jsonc-parser');
  const manifest=path.join(directory,'package.json');
  if(JSON.parse(fs.readFileSync(manifest,'utf8')).version!=='3.3.1') throw new Error('jsonc-parser 依赖版本不一致，请重新安装插件');
  return directory;
}
export function verifyPackage(source,exec=run) {
  dependencyDirectory(source);
  for(const name of payload) fs.accessSync(path.join(source,name),fs.constants.R_OK);
  const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  if(!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('无效的发布版本');
  const engine=platform.enginePathFor(source);
  const actual=createHash('sha256').update(fs.readFileSync(engine)).digest('hex');
  const checksums=JSON.parse(fs.readFileSync(path.join(source,'integrity.json'),'utf8'));
  const key=`${process.platform}-${process.arch}`;
  // Older packages only pinned the macOS engine; keep reading that field so a
  // previously released archive still verifies.
  const pinned=checksums.platforms?.[key]||(key===['darwin','arm64'].join('-')?checksums.engine:null);
  if(checksums.version!==manifest.version||!pinned||pinned!==actual) throw new Error(`桥接程序校验失败（${key}），请重新下载完整安装包`);
  if(exec(engine,['--version']).stdout.trim()!==manifest.version) throw new Error('插件与后台程序版本不一致');
  return manifest;
}
export function initializeCertificate(engine,p,exec=run,{trust=true}={}) {
  if(!platform.serviceSupported) throw new Error('当前平台暂不支持自动信任桥接证书');
  const output=exec(engine,['--init-ca'],{env:{...process.env,CURSOR_BYOK_DATA_DIR:path.join(p.root,'data')}});
  const state=JSON.parse(output.stdout);
  const cert=path.join(p.root,'data/ca/ca.crt');
  if(platform.IS_WIN) {
    if(!trust) throw new Error('本机证书尚未受信任，请运行初始化并完成证书安装');
    const certutil=platform.findExecutable([
      path.join(process.env.SystemRoot||'C:\\Windows','System32','certutil.exe'),
      'certutil'
    ])||'certutil';
    console.log('正在信任本机生成的桥接证书；Windows 可能弹出确认窗口。私钥只保存在本机。');
    exec(certutil,['-addstore','-user','Root',cert],{stdio:'inherit'});
    return state;
  }
  const verify=()=>exec('/usr/bin/security',['verify-cert','-c',cert,'-p','ssl'],{optional:true}).status===0;
  if(!verify()) {
    if(!trust) throw new Error('本机证书尚未受信任，请在终端运行初始化并完成 macOS 授权');
    console.log('正在信任本机生成的桥接证书；macOS 可能要求确认或密码。私钥只保存在本机。');
    exec('/usr/bin/security',['add-trusted-cert','-r','trustRoot','-p','ssl','-k',path.join(p.home,'Library/Keychains/login.keychain-db'),cert],{stdio:'inherit'});
    if(!verify()) throw new Error('证书信任未完成；后台服务尚未安装，可完成授权后重试');
  }
  return state;
}
export function plistText(p,runtime,release) {
  const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const args=[runtime,path.join(release,'bridge.js'),'supervise'].map(s=>`<string>${esc(s)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>20</integer><key>Umask</key><integer>63</integer><key>LimitLoadToSessionType</key><string>Aqua</string><key>StandardOutPath</key><string>${esc(path.join(p.root,'supervisor.log'))}</string><key>StandardErrorPath</key><string>${esc(path.join(p.root,'supervisor-error.log'))}</string></dict></plist>`;
}
function supervisorPid(root) {
  try {
    const pid=Number(fs.readFileSync(path.join(root,'supervisor.lock/pid'),'utf8'));
    return Number.isInteger(pid)&&pid>0?pid:null;
  } catch { return null; }
}
function windowsTaskCommand(release,runtime) {
  return `"${runtime}" "${path.join(release,'bridge.js')}" supervise`;
}
export function windowsTaskState(exec=run) {
  const result=exec('schtasks',['/Query','/TN',platform.serviceName],{optional:true});
  return {registered:result.status===0,state:null,pid:null,supported:true};
}
async function startWindowsTask(p,release,exec=run) {
  const runtime=path.join(release,'bin',platform.current.runtimeName());
  exec('schtasks',['/Create','/SC','ONLOGON','/TN',platform.serviceName,'/TR',windowsTaskCommand(release,runtime),'/F']);
  exec('schtasks',['/Run','/TN',platform.serviceName],{optional:true});
  for(let attempt=0;attempt<40;attempt++) {
    const pid=supervisorPid(p.root);
    if(pid) { try{process.kill(pid,0);return;}catch { /* not yet live */ } }
    await new Promise(r=>setTimeout(r,250));
  }
  exec('schtasks',['/Delete','/TN',platform.serviceName,'/F'],{optional:true});
  throw new Error('Windows 未能启动后台桥接；请检查任务计划程序中的 local.magpie.cursor-bridge');
}
export async function stopJob(p,domain,exec=run) {
  if(!platform.serviceSupported) return;
  if(platform.IS_WIN) {
    exec('schtasks',['/End','/TN',platform.serviceName],{optional:true});
    const pid=supervisorPid(p.root);
    if(pid) { try{process.kill(pid);}catch { /* already gone */ } }
    for(let attempt=0;attempt<40;attempt++) {
      const current=supervisorPid(p.root);
      let alive=false;
      if(current) { try{process.kill(current,0);alive=true;}catch { /* gone */ } }
      if(!alive) return;
      await new Promise(r=>setTimeout(r,250));
    }
    throw new Error('旧桥接尚未停止，请稍后重试安装');
  }
  exec('/bin/launchctl',['bootout',`${domain}/${label}`],{optional:true});
  for(let attempt=0;attempt<40;attempt++) {
    const registered=exec('/bin/launchctl',['print',`${domain}/${label}`],{optional:true}).status===0;
    const pid=supervisorPid(p.root);
    let alive=false;
    if(pid) { try{process.kill(pid,0);alive=true;}catch { /* gone */ } }
    if(!registered&&!alive) return;
    await new Promise(r=>setTimeout(r,500));
  }
  throw new Error('旧桥接尚未停止，请稍后重试安装');
}
export async function bootstrap(p,domain,exec=run) {
  if(!platform.serviceSupported) throw new Error('当前平台暂不支持自动启动后台服务');
  if(platform.IS_WIN) throw new Error('Windows 使用计划任务启动，请走 activate');
  for(let attempt=0;attempt<5;attempt++) {
    if(exec('/bin/launchctl',['bootstrap',domain,p.plist],{optional:true}).status===0) return;
    if(attempt<4) await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('macOS 未能启动后台桥接');
}
// Stage a complete immutable copy before stopping the working service. Never overwrite a running executable.
export function stage(source,p,version,runtime) {
  fs.mkdirSync(path.join(p.target,'releases'),{recursive:true,mode:0o700});
  const release=fs.mkdtempSync(path.join(p.target,'releases',version+'-'));
  try {
    for(const name of [...payload,'integrity.json'].filter((name)=>name!=='bin')) fs.cpSync(path.join(source,name),path.join(release,name),{recursive:true,dereference:true});
    // Carry only this platform's engine; the other one would waste tens of
    // megabytes in every staged release.
    const engine=platform.enginePathFor(source);
    const staged=path.join(release,path.relative(source,engine));
    fs.mkdirSync(path.dirname(staged),{recursive:true});
    fs.copyFileSync(engine,staged);
    fs.chmodSync(staged,0o755);
    const runtimeName=platform.current.runtimeName();
    fs.copyFileSync(runtime,path.join(release,'bin',runtimeName));
    fs.chmodSync(path.join(release,'bin',runtimeName),0o755);
    return release;
  } catch(e) {fs.rmSync(release,{recursive:true,force:true});throw e;}
}
export async function activate(p,release,domain,exec=run) {
  if(!platform.serviceSupported) throw new Error('当前平台暂不支持自动安装后台服务');
  if(platform.IS_WIN) {
    await stopJob(p,domain,exec);
    restoreProxy(path.join(p.root,'settings-journal.json'));
    await startWindowsTask(p,release,exec);
    return;
  }
  const previous=fs.existsSync(p.plist)?fs.readFileSync(p.plist,'utf8'):null;
  await stopJob(p,domain,exec);
  restoreProxy(path.join(p.root,'settings-journal.json'));
  atomic(p.plist,plistText(p,path.join(release,'bin/runtime'),release));
  try {await bootstrap(p,domain,exec);} catch(error) {
    await stopJob(p,domain,exec);
    if(previous!==null) {atomic(p.plist,previous);await bootstrap(p,domain,exec);}
    else fs.unlinkSync(p.plist);
    throw error;
  }
}
