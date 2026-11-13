import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {atomic,restoreProxy} from './settings.js';
import platform from './platform.js';

export const label='local.magpie.cursor-bridge';
export const payload=['agent.js','agent-platform.js','bridge.js','install.js','setup.command','package.json','lib','vendor','control','ui','bin','README.md','LICENSE','THIRD_PARTY_NOTICES.md'];
export function run(command,args,options={}) {
  // windowsHide matters for the PowerShell/cmd probes: without it a console
  // window can flash each time the panel polls a pid.
  const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,...options});
  if(result.status!==0&&!options.optional) throw new Error(`${path.basename(command)} failed: ${(result.stderr||result.stdout||result.error?.message||'').slice(0,1000)}`);
  return result;
}
export function paths(home) {
  const layout=platform.pathsFor(home);
  return {home,root:layout.config,target:layout.share,plist:layout.plist,autostart:layout.autostart||null};
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
  // The native engine is rebuilt only when its sources change, so the plugin
  // and engine versions can legitimately differ. `engineVersion` pins what the
  // binary must report; packages without it keep the original exact pairing.
  const engineVersion=checksums.engineVersion||checksums.version;
  if(exec(engine,['--version']).stdout.trim()!==engineVersion) throw new Error('插件与后台程序版本不一致');
  return manifest;
}
// The bundled engine (upstream cursor-byok) tests Windows trust against
// CERT_SYSTEM_STORE_LOCAL_MACHINE, not the per-user store. A CA added with
// `certutil -addstore -user Root` therefore looks untrusted and the engine
// exits with "bridge requires an already trusted CA". The machine store needs
// one administrator consent, so the installer asks for it through UAC once and
// verifies the result; later starts only read the store.
export function certificateThumbprint(file) {
  const pem=fs.readFileSync(file,'utf8');
  const der=Buffer.from(pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,''),'base64');
  return createHash('sha1').update(der).digest('hex').toUpperCase();
}
function powershellExecutable() {
  return platform.findExecutable(['powershell','pwsh'])||'powershell';
}
function machineRootScript(thumbprint) {
  return `(Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Thumbprint -eq '${thumbprint}' } | Select-Object -First 1).Thumbprint`;
}
export function machineRootTrusted(cert,exec=run) {
  const thumbprint=certificateThumbprint(cert);
  const result=exec(powershellExecutable(),['-NoProfile','-NonInteractive','-Command',machineRootScript(thumbprint)],{optional:true,timeout:30000});
  return {thumbprint,trusted:String(result?.stdout||'').trim().toUpperCase()===thumbprint};
}
export function trustWindowsCertificate(cert,exec=run) {
  const first=machineRootTrusted(cert,exec);
  if(first.trusted) return true;
  const certutil=platform.findExecutable([
    path.join(process.env.SystemRoot||'C:\\Windows','System32','certutil.exe'),
    'certutil'
  ])||'certutil';
  const quote=(value)=>`'${String(value).replaceAll("'","''")}'`;
  const script=`$p=Start-Process -FilePath ${quote(certutil)} -ArgumentList @('-addstore','Root',${quote(cert)}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  console.log('正在将桥接证书加入本机「受信任的根证书颁发机构」；Windows 会弹出一次管理员确认窗口。私钥只保存在本机。');
  exec(powershellExecutable(),['-NoProfile','-NonInteractive','-Command',script],{optional:true,timeout:150000});
  return machineRootTrusted(cert,exec).trusted;
}
export function initializeCertificate(engine,p,exec=run,{trust=true}={}) {
  if(!platform.serviceSupported) throw new Error('当前平台暂不支持自动信任桥接证书');
  const output=exec(engine,['--init-ca'],{env:{...process.env,CURSOR_BYOK_DATA_DIR:path.join(p.root,'data')}});
  const state=JSON.parse(output.stdout);
  const cert=path.join(p.root,'data/ca/ca.crt');
  if(platform.IS_WIN) {
    if(!trust) throw new Error('本机证书尚未受信任，请运行初始化并完成证书安装');
    if(!trustWindowsCertificate(cert,exec)) throw new Error('证书未加入本机受信任的根证书；请在管理员确认窗口选择「是」后重试');
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
function processAlive(pid) {
  if(!Number.isInteger(pid)||pid<=0) return false;
  try {process.kill(pid,0);return true;} catch {return false;}
}
// A pid read from disk may have been recycled by an unrelated program. Only
// terminate it when its command line still looks like ours; if the probe is
// unavailable, keep the historical behaviour and trust the recorded pid.
function terminateIfOurs(pid,marker) {
  if(!processAlive(pid)) return false;
  const probe=platform.current.processCommand(pid);
  if(probe) {
    try {
      const line=String(spawnSync(probe.command,probe.args,{encoding:'utf8',timeout:5000,windowsHide:true}).stdout||'');
      if(line&&!line.includes(marker)) return false;
    } catch { /* fall through and terminate */ }
  }
  try {process.kill(pid);return true;} catch {return false;}
}
// The engine's pid lives in status.json. Windows kills the supervisor with
// TerminateProcess (no SIGTERM handler runs), so its finally-block cannot stop
// the engine; the installer has to terminate both.
function enginePid(root) {
  try {
    const pid=Number(JSON.parse(fs.readFileSync(path.join(root,'status.json'),'utf8')).pid);
    return Number.isInteger(pid)&&pid>0?pid:null;
  } catch { return null; }
}
// VBS is fed to WScript at logon; Run's second argument 0 hides the console
// window bun.exe would otherwise open, and the third (False) does not wait.
export function windowsLauncherScript(release,runtime) {
  const command=`"${runtime}" "${path.join(release,'bridge.js')}" supervise`;
  return `' Starts the Cursor bridge supervisor hidden at logon.\r\nCreateObject("WScript.Shell").Run "${command.replaceAll('"','""')}", 0, False\r\n`;
}
function launchWindowsSupervisor(release,runtime) {
  const child=spawn(runtime,[path.join(release,'bridge.js'),'supervise'],{
    cwd:release,detached:true,stdio:'ignore',windowsHide:true,env:process.env
  });
  child.on('error',()=>{ /* the wait loop below reports the failure */ });
  child.unref();
}
async function startWindowsSupervisor(p,release,exec=run,launch=launchWindowsSupervisor) {
  const runtime=path.join(release,'bin',platform.current.runtimeName());
  const entry=p.autostart||platform.current.autostartEntry(p.home);
  if(entry) {
    fs.mkdirSync(path.dirname(entry),{recursive:true});
    atomic(entry,windowsLauncherScript(release,runtime));
  }
  // A force-killed supervisor cannot remove its own lock; drop it so this
  // wait loop cannot mistake a stale pid for a fresh supervisor.
  try {fs.rmSync(path.join(p.root,'supervisor.lock'),{recursive:true,force:true});} catch {}
  launch(release,runtime);
  for(let attempt=0;attempt<60;attempt++) {
    const pid=supervisorPid(p.root);
    if(processAlive(pid)) return;
    await new Promise(r=>setTimeout(r,250));
  }
  try {if(entry) fs.rmSync(entry,{force:true});} catch {}
  throw new Error('Windows 未能启动后台桥接；请检查 bin 目录下的运行时与原生引擎是否完整');
}
export async function stopJob(p,domain,exec=run) {
  if(!platform.serviceSupported) return;
  if(platform.IS_WIN) {
    // Remove a task left by the 0.2.15 preview; it required elevation and kept
    // starting an older release at logon.
    exec('schtasks',['/End','/TN',platform.serviceName],{optional:true});
    exec('schtasks',['/Delete','/TN',platform.serviceName,'/F'],{optional:true});
    const targets=[[supervisorPid(p.root),'bridge.js'],[enginePid(p.root),'cursor-magpie-bridge']]
      .filter(([pid])=>Number.isInteger(pid)&&pid>0);
    const killed=targets.filter(([pid,marker])=>terminateIfOurs(pid,marker)).map(([pid])=>pid);
    for(let attempt=0;attempt<80;attempt++) {
      if(!killed.some(processAlive)) {
        try {fs.rmSync(path.join(p.root,'supervisor.lock'),{recursive:true,force:true});} catch {}
        return;
      }
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
  if(platform.IS_WIN) throw new Error('Windows 使用启动文件夹启动，请走 activate');
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
// Each setup stages a fresh copy of the ~115 MB runtime. Without pruning a few
// clicks leave gigabytes of dead releases; only the release that was just
// activated is kept. A directory still held open is skipped, never forced.
export function pruneReleases(p,keep) {
  const dir=path.join(p.target,'releases');
  let names=[];
  try {names=fs.readdirSync(dir);} catch {return 0;}
  let removed=0;
  for(const name of names) {
    const full=path.join(dir,name);
    if(path.resolve(full)===path.resolve(keep)) continue;
    try {fs.rmSync(full,{recursive:true,force:true});removed+=1;} catch { /* in use */ }
  }
  return removed;
}
export async function activate(p,release,domain,exec=run,launch) {
  if(!platform.serviceSupported) throw new Error('当前平台暂不支持自动安装后台服务');
  if(platform.IS_WIN) {
    await stopJob(p,domain,exec);
    restoreProxy(path.join(p.root,'settings-journal.json'));
    await startWindowsSupervisor(p,release,exec,launch);
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
