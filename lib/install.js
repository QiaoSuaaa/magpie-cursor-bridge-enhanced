import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {atomic,restoreProxy} from './settings.js';
import platform from './platform.js';
import {version as sourceVersion} from '../version.js';
import {resolveDataDir} from './storage.js';

// Cursor's argv.json is JSONC (it ships comments), so editing it with
// JSON.parse/stringify would silently delete them. Reuse the vendored parser
// the settings module already relies on.
const require=createRequire(import.meta.url);
const {parse:parseJsonc,modify,applyEdits}=require('../vendor/jsonc-parser/lib/umd/main.js');

export const label='local.magpie.cursor-bridge';
export const payload=['agent.js','agent-platform.js','bridge.js','install.js','version.js','setup.command','package.json','lib','vendor','control','ui','bin','README.md','LICENSE','THIRD_PARTY_NOTICES.md'];
export function run(command,args,options={}) {
  // windowsHide matters for the PowerShell/cmd probes: without it a console
  // window can flash each time the panel polls a pid.
  const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,...options});
  if(result.status!==0&&!options.optional) throw new Error(`${path.basename(command)} failed: ${(result.stderr||result.stdout||result.error?.message||'').slice(0,1000)}`);
  return result;
}
export function paths(home) {
  const layout=platform.pathsFor(home);
  return {home,root:layout.config,target:layout.share,plist:layout.plist,systemdUnit:layout.systemdUnit||null,autostart:layout.autostart||null};
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
  // version.js is what the agent, supervisor and User-Agent read at runtime;
  // package.json is what npm and the installer see. Drift between them must
  // fail before a release is staged, not after the user reports a wrong version.
  if(sourceVersion!==manifest.version) throw new Error('插件版本文件与 package.json 不一致，请重新下载完整安装包');
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
  const engineVersion=checksums.engineVersions?.[key]||checksums.engineVersion||checksums.version;
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
// Linux has no certificate UI: Cursor is an Electron app that reads extra
// runtime arguments from <config-home>/Cursor/argv.json, and Chromium also
// consults the per-user NSS database. Both live in the user's home, so trust
// needs neither root nor a system-wide CA refresh.
export const authorityKey='certificate-authority';
export const nssNickname='Cursor BYOK Local CA';
export function cursorAuthority(file) {
  if(!file) return null;
  try {
    const text=fs.readFileSync(file,'utf8');
    const errors=[];
    const data=parseJsonc(text,errors,{allowTrailingComma:true});
    if(errors.length||!data||typeof data!=='object'||Array.isArray(data)) return null;
    return typeof data[authorityKey]==='string'?data[authorityKey]:null;
  } catch { return null; }
}
export function writeCursorAuthority(file,cert) {
  const text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'{\n}\n';
  const errors=[];
  const data=parseJsonc(text,errors,{allowTrailingComma:true});
  if(errors.length||!data||typeof data!=='object'||Array.isArray(data)) throw new Error(`Cursor 的 argv.json 格式无法解析：${file}`);
  if(data[authorityKey]===cert) return false;
  const pending=modify(text,[authorityKey],cert,{formattingOptions:{insertSpaces:true,tabSize:2,eol:text.includes('\r\n')?'\r\n':'\n'}});
  atomic(file,applyEdits(text,pending));
  return true;
}
// `certutil` here is NSS's tool, not Windows' certificate utility: it edits
// ~/.pki/nssdb, the store Chromium/Electron falls back to. A missing
// nss-tools package is not fatal because argv.json already carries the CA.
export function trustLinuxNss(cert,home,exec=run,{database=platform.nssDatabaseFor(home),certutil=platform.findExecutable(['certutil'])}={}) {
  if(!database||!certutil) return {imported:false,reason:'no-certutil'};
  // certutil -N writes into an existing directory; creating only the parent
  // makes it answer SEC_ERROR_BAD_DATABASE instead of initializing the store.
  fs.mkdirSync(database,{recursive:true,mode:0o700});
  if(!fs.existsSync(path.join(database,'cert9.db'))&&!fs.existsSync(path.join(database,'cert8.db'))) {
    exec(certutil,['-d',`sql:${database}`,'-N','--empty-password'],{optional:true,timeout:15000});
    if(!fs.existsSync(path.join(database,'cert9.db'))&&!fs.existsSync(path.join(database,'cert8.db'))) {
      return {imported:false,reason:'no-database'};
    }
  }
  // Re-importing the same nickname fails unless the previous entry is gone.
  exec(certutil,['-d',`sql:${database}`,'-D','-n',nssNickname],{optional:true,timeout:15000});
  const added=exec(certutil,['-d',`sql:${database}`,'-A','-t','C,,','-n',nssNickname,'-i',cert],{optional:true,timeout:15000});
  if(added.status!==0) return {imported:false,reason:'add-failed'};
  const listed=exec(certutil,['-d',`sql:${database}`,'-L','-n',nssNickname],{optional:true,timeout:15000});
  return listed.status===0?{imported:true,reason:''}:{imported:false,reason:'list-failed'};
}
// The engine refuses to start unless it considers the CA trusted. On Linux it
// reads this marker in addition to the system anchor and Cursor's argv.json,
// so an NSS-only install still counts as trusted (see source-linux.patch).
export function writeLinuxTrustMarker(cert,root,method='nss') {
  const digest=createHash('sha256').update(fs.readFileSync(cert,'utf8').trim()).digest('hex');
  const file=path.join(resolveDataDir(root),'ca/trusted.json');
  atomic(file,JSON.stringify({sha256:digest,method,file:cert,imported:new Date().toISOString()},null,2)+'\n');
  return file;
}
function linuxAnchorFile() {
  for(const directory of ['/etc/pki/ca-trust/source/anchors','/etc/ca-certificates/trust-source/anchors','/usr/local/share/ca-certificates']) {
    try { if(fs.statSync(directory).isDirectory()) return {directory,file:path.join(directory,'cursor-byok-local-ca.crt')}; } catch { /* next candidate */ }
  }
  return {directory:'/usr/local/share/ca-certificates',file:'/usr/local/share/ca-certificates/cursor-byok-local-ca.crt'};
}
function systemAnchorTrusted(cert) {
  try { return fs.readFileSync(linuxAnchorFile().file,'utf8').trim()===fs.readFileSync(cert,'utf8').trim(); } catch { return false; }
}
function printSystemCaHint(cert) {
  if(systemAnchorTrusted(cert)) return;
  // The engine picks its own system anchor directory per distribution, so a
  // single command would be wrong somewhere. Print the two common recipes and
  // let the user pick the one matching the system.
  console.log(`如需系统级信任（可选，终端会要求管理员密码）：
  Debian/Ubuntu: sudo cp '${cert}' /usr/local/share/ca-certificates/cursor-byok-local-ca.crt && sudo update-ca-certificates
  Fedora/RHEL:   sudo cp '${cert}' /etc/pki/ca-trust/source/anchors/cursor-byok-local-ca.crt && sudo update-ca-trust extract`);
}
export function initializeCertificate(engine,p,exec=run,{trust=true}={}) {
  if(!platform.serviceSupported) throw new Error('当前平台暂不支持自动信任桥接证书');
  const data=resolveDataDir(p.root);
  const output=exec(engine,['--init-ca'],{env:{...process.env,CURSOR_BYOK_DATA_DIR:data}});
  const state=JSON.parse(output.stdout);
  const cert=path.join(data,'ca/ca.crt');
  if(platform.IS_LINUX) {
    const argvFile=platform.cursorArgvFor(p.home);
    if(cursorAuthority(argvFile)!==cert) {
      if(!trust) throw new Error('本机证书尚未受信任，请运行初始化并完成证书配置');
      writeCursorAuthority(argvFile,cert);
      // The engine may run under systemd without XDG_CONFIG_HOME, where it
      // would look in ~/.config and miss an XDG argv.json; the marker records
      // the path the installer actually used.
      writeLinuxTrustMarker(cert,p.root,'argv');
      console.log(`已将桥接证书写入 Cursor 的 argv.json（${authorityKey}）：${argvFile}`);
    }
    if(trust) {
      const nss=trustLinuxNss(cert,p.home,exec);
      if(nss.imported) {
        writeLinuxTrustMarker(cert,p.root);
        console.log('已将桥接证书导入用户 NSS 证书库（~/.pki/nssdb）。');
      } else if(nss.reason==='no-certutil') {
        console.log('未找到 certutil（nss-tools），跳过 NSS 导入；Cursor 通过 argv.json 读取桥接证书。');
      } else if(nss.reason==='no-database') {
        console.log('用户 NSS 证书库不可用，跳过 NSS 导入；Cursor 通过 argv.json 读取桥接证书。');
      } else {
        console.log('NSS 导入未完成；Cursor 通过 argv.json 读取桥接证书。');
      }
    }
    printSystemCaHint(cert);
    return state;
  }
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
// systemd does not run a shell, so every path is quoted. Restart=on-failure
// revives a crashed supervisor but leaves a clean stop (user disconnected)
// down, matching the LaunchAgent's KeepAlive-plus-explicit-bootout behaviour.
export function systemdUnitText(p,runtime,release) {
  const quote=value=>`"${String(value).replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;
  return [
    '[Unit]',
    'Description=Cursor Magpie Bridge',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quote(runtime)} ${quote(path.join(release,'bridge.js'))} supervise`,
    'Restart=on-failure',
    'RestartSec=5',
    'UMask=0077',
    `StandardOutput=append:${path.join(p.root,'supervisor.log')}`,
    `StandardError=append:${path.join(p.root,'supervisor-error.log')}`,
    `Environment="CURSOR_BRIDGE_ROOT=${p.root}"`,
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}
function systemdUserManager(exec=run) {
  const systemctl=platform.systemctlFor();
  if(!systemctl) return null;
  // `show-environment` is the cheapest probe that needs a live user manager:
  // the binary can exist in a container without dbus or XDG_RUNTIME_DIR.
  const result=exec(systemctl,['--user','show-environment'],{optional:true,timeout:8000});
  return result.status===0?systemctl:null;
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
// The engine's pid lives in status.json. A hard kill (Windows
// TerminateProcess, or a Linux SIGKILL after the grace period) never runs the
// supervisor's finally block, so the installer has to terminate both.
function enginePid(root) {
  try {
    const pid=Number(JSON.parse(fs.readFileSync(path.join(root,'status.json'),'utf8')).pid);
    return Number.isInteger(pid)&&pid>0?pid:null;
  } catch { return null; }
}
// VBS is fed to WScript at logon; Run's second argument 0 hides the console
// window bun.exe would otherwise open, and the third (False) does not wait.
function windowsSupervisorCommand(release,runtime) {
  return `"${runtime}" "${path.join(release,'bridge.js')}" supervise`;
}
export function windowsLauncherScript(release,runtime) {
  const command=windowsSupervisorCommand(release,runtime);
  return `' Starts the Cursor bridge supervisor hidden at logon.\r\nCreateObject("WScript.Shell").Run "${command.replaceAll('"','""')}", 0, False\r\n`;
}
function windowsFallbackLauncher(p) {
  return path.join(p.root,'supervisor-launch.vbs');
}
export function windowsRunCommand(launcher) {
  return `wscript.exe //B //Nologo "${launcher}"`;
}
function windowsRegExecutable() {
  return platform.regExecutableFor()||'reg';
}
function deleteWindowsRunValue(exec) {
  try { return exec(windowsRegExecutable(),['delete',platform.windowsRunKey,'/v',label,'/f'],{optional:true,timeout:15000}); }
  catch { return null; }
}
// Security software sometimes blocks a .vbs written into the Startup folder.
// Autostart is a convenience, not a requirement: setup must still be able to
// start the service now. The fallback keeps the same hidden launcher beside the
// bridge state and registers it through HKCU Run (no elevation). If every
// mechanism is blocked, setup reports it and continues without autostart
// instead of failing the whole installation.
export function installWindowsAutostart(p,release,runtime,{exec=run,write=null,log=console.log}={}) {
  const entry=p.autostart||platform.current.autostartEntry(p.home);
  const launcher=windowsFallbackLauncher(p);
  const text=windowsLauncherScript(release,runtime);
  const put=write||((file,body)=>{fs.mkdirSync(path.dirname(file),{recursive:true});atomic(file,body);});
  const writeChecked=(file)=>{put(file,text);if(!fs.existsSync(file)) throw new Error('启动脚本写入后不存在');};
  if(entry) {
    try {
      writeChecked(entry);
      try {if(fs.existsSync(launcher)) fs.rmSync(launcher,{force:true});} catch { /* stale fallback */ }
      deleteWindowsRunValue(exec);
      return {kind:'startup',path:entry};
    } catch(error) {
      log(`启动文件夹自启动不可用（${error.message}），改试注册表自启动。`);
    }
  }
  try {
    writeChecked(launcher);
    const command=windowsRunCommand(launcher);
    const added=exec(windowsRegExecutable(),['add',platform.windowsRunKey,'/v',label,'/t','REG_SZ','/d',command,'/f'],{optional:true,timeout:15000});
    if(added?.status!==0) throw new Error(`注册表写入失败（退出码 ${added?.status??'未知'}）`);
    if(entry) {try {if(fs.existsSync(entry)) fs.rmSync(entry,{force:true});} catch { /* stale launcher only */ }}
    log(`已将登录自启动改为注册表项 ${platform.windowsRunKey}\\${label}：${launcher}`);
    return {kind:'run',path:launcher,key:platform.windowsRunKey};
  } catch(error) {
    removeWindowsAutostart(p,{exec});
    log(`未能注册登录自启动（${error.message}）。后台本次已启动；重启电脑后请在控制台点「启动」。`);
    return {kind:'none',error:error.message};
  }
}
export function removeWindowsAutostart(p,{exec=run}={}) {
  const removed=[];
  const entry=p.autostart||platform.current.autostartEntry(p.home);
  for(const file of [entry,windowsFallbackLauncher(p)]) {
    if(!file) continue;
    try {if(fs.existsSync(file)) {fs.rmSync(file,{force:true});removed.push(file);}} catch { /* locked by security software */ }
  }
  deleteWindowsRunValue(exec);
  return removed;
}
export function windowsAutostartRegistered(p,{exec=run}={}) {
  const entry=p.autostart||platform.current.autostartEntry(p.home);
  if(entry&&fs.existsSync(entry)) return true;
  // The Run key only helps while its launcher is still on disk.
  if(fs.existsSync(windowsFallbackLauncher(p))) {
    const queried=exec(windowsRegExecutable(),['query',platform.windowsRunKey,'/v',label],{optional:true,timeout:15000});
    if(queried?.status===0) return true;
  }
  return false;
}
export function launchWindowsSupervisor(release,runtime,_root,exec=run) {
  // detached:true does not escape a Windows Job Object owned by the plugin
  // host. Let WMI own the process so ending the installer/host cannot kill it.
  const command=windowsSupervisorCommand(release,runtime);
  const quote=value=>`'${value.replaceAll("'","''")}'`;
  const powershell=platform.findExecutable(['powershell','pwsh']);
  if(!powershell) throw new Error('无法启动 Windows 后台：未找到 PowerShell');
  exec(powershell,['-NoProfile','-NonInteractive','-Command',
    `$ErrorActionPreference='Stop'; $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${quote(command)};CurrentDirectory=${quote(release)};ProcessStartupInformation=$startup}; if($result.ReturnValue -ne 0){throw "后台启动失败，WMI 返回码 $($result.ReturnValue)"}`
  ],{timeout:15000});
}
async function startWindowsSupervisor(p,release,exec=run,launch=launchWindowsSupervisor) {
  const runtime=path.join(release,'bin',platform.current.runtimeName());
  // Autostart is best-effort; a blocked launcher must not stop this start.
  const autostart=installWindowsAutostart(p,release,runtime,{exec});
  // A force-killed supervisor cannot remove its own lock; drop it so this
  // wait loop cannot mistake a stale pid for a fresh supervisor.
  try {fs.rmSync(path.join(p.root,'supervisor.lock'),{recursive:true,force:true});} catch {}
  launch(release,runtime,p.root);
  for(let attempt=0;attempt<60;attempt++) {
    const pid=supervisorPid(p.root);
    if(processAlive(pid)) return {autostart};
    await new Promise(r=>setTimeout(r,250));
  }
  removeWindowsAutostart(p,{exec});
  throw new Error('Windows 未能启动后台桥接；请检查 bin 目录下的运行时与原生引擎是否完整');
}
// Containers, WSL images without systemd and trimmed distributions all reach
// this path: the unit is still written so a later login can take over, but the
// supervisor starts now as a detached process so the bridge is usable at once.
function launchLinuxSupervisor(release,runtime) {
  const child=spawn(runtime,[path.join(release,'bridge.js'),'supervise'],{
    cwd:release,detached:true,stdio:'ignore',env:process.env
  });
  child.on('error',()=>{ /* the wait loop below reports the failure */ });
  child.unref();
}
async function startLinuxSupervisor(p,release,exec=run,launch=launchLinuxSupervisor) {
  const runtime=path.join(release,'bin',platform.current.runtimeName());
  // A force-killed supervisor cannot remove its own lock; drop it so the wait
  // loop cannot mistake a stale pid for a fresh supervisor.
  try {fs.rmSync(path.join(p.root,'supervisor.lock'),{recursive:true,force:true});} catch {}
  const systemctl=systemdUserManager(exec);
  if(systemctl) {
    exec(systemctl,['--user','daemon-reload'],{optional:true,timeout:30000});
    const enabled=exec(systemctl,['--user','enable','--now',platform.serviceName],{optional:true,timeout:60000});
    if(enabled.status===0) {
      for(let attempt=0;attempt<60;attempt++) {
        const pid=supervisorPid(p.root);
        if(processAlive(pid)) return {mode:'systemd'};
        await new Promise(r=>setTimeout(r,250));
      }
    }
    // The user manager answered but refused the unit: keep it out of the next
    // login instead of leaving a service that fails on every boot.
    exec(systemctl,['--user','disable',platform.serviceName],{optional:true,timeout:30000});
    console.log(`systemd 用户实例未能启动单元（${String(enabled.stderr||enabled.stdout||'').trim().slice(0,200)||`退出码 ${enabled.status}`}），改用分离进程启动。`);
  } else {
    console.log('未检测到可用的 systemd 用户实例，已改用分离进程启动；单元文件已保留，下次登录若 systemd 可用将自动接管。');
  }
  launch(release,runtime);
  for(let attempt=0;attempt<60;attempt++) {
    const pid=supervisorPid(p.root);
    if(processAlive(pid)) return {mode:'detached'};
    await new Promise(r=>setTimeout(r,250));
  }
  throw new Error('Linux 未能启动后台桥接；请检查 bin 目录下的运行时与原生引擎是否完整');
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
  if(platform.IS_LINUX) {
    // Both start paths converge here: a systemd unit and the detached fallback
    // write the same supervisor.lock, so the pid is the source of truth. Only
    // ask systemd to stop when a user manager actually answers; otherwise the
    // call just waits for a D-Bus timeout before the pid wait below.
    const systemctl=systemdUserManager(exec);
    if(systemctl) exec(systemctl,['--user','stop',platform.serviceName],{optional:true,timeout:30000});
    const targets=[[supervisorPid(p.root),'bridge.js'],[enginePid(p.root),'cursor-magpie-bridge']]
      .filter(([pid])=>Number.isInteger(pid)&&pid>0);
    // The supervisor waits up to 12s for its engine to exit before SIGKILL,
    // so allow the same window before treating it as a straggler.
    const alive=()=>targets.filter(([pid])=>processAlive(pid));
    for(let attempt=0;attempt<80&&alive().length;attempt++) await new Promise(r=>setTimeout(r,250));
    const stragglers=alive();
    if(stragglers.length) {
      // A force-killed supervisor leaves the engine behind; the pid may also
      // have been recycled, so only terminate a matching command line.
      const killed=stragglers.filter(([pid,marker])=>terminateIfOurs(pid,marker)).map(([pid])=>pid);
      for(let attempt=0;attempt<40&&killed.some(processAlive);attempt++) await new Promise(r=>setTimeout(r,250));
      if(killed.some(processAlive)) throw new Error('旧桥接尚未停止，请稍后重试安装');
    }
    try {fs.rmSync(path.join(p.root,'supervisor.lock'),{recursive:true,force:true});} catch {}
    return;
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
const RELEASE_META='release.json';
function filesUnder(source,name) {
  const full=path.join(source,name);
  if(!fs.statSync(full).isDirectory()) return [name];
  const out=[];
  const walk=(relative)=>{
    for(const entry of fs.readdirSync(path.join(source,relative),{withFileTypes:true})) {
      const next=path.join(relative,entry.name);
      if(entry.isDirectory()) walk(next);
      else if(entry.isFile()) out.push(next);
    }
  };
  walk(name);
  return out;
}
// A staged release is reused only when the exact same payload, engine and
// runtime produced it. The text payload (a few hundred KB) is hashed every
// setup; the engine is hashed once, and the ~100 MB Bun runtime is identified
// by size and mtime instead of re-reading it.
function releaseFingerprint(source,engine,runtime) {
  const digest=createHash('sha256');
  const files=[];
  for(const name of [...payload,'integrity.json']) {
    if(name==='bin') continue;
    files.push(...filesUnder(source,name));
  }
  files.sort();
  for(const relative of files) {
    digest.update(relative.split(path.sep).join('/')).update('\0');
    digest.update(fs.readFileSync(path.join(source,relative))).update('\0');
  }
  const engineHash=createHash('sha256').update(fs.readFileSync(engine)).digest('hex');
  const engineInfo=fs.statSync(engine);
  const runtimeInfo=fs.statSync(runtime);
  digest.update('engine\0').update(engineHash);
  digest.update(`\0runtime\0${runtimeInfo.size}\0${runtimeInfo.mtimeMs}`);
  return {fingerprint:digest.digest('hex'),engineHash,engineSize:engineInfo.size,runtimeSize:runtimeInfo.size};
}
// release.json is written last, so finding it proves every payload file landed.
// The engine path and sizes are re-checked because a partially deleted release
// must never be handed to the service definition.
function reusableRelease(p,version,meta,engineRelative,runtimeName) {
  const dir=path.join(p.target,'releases');
  let names=[];
  try {names=fs.readdirSync(dir);} catch {return null;}
  for(const name of names) {
    if(!name.startsWith(`${version}-`)) continue;
    const candidate=path.join(dir,name);
    let saved=null;
    try {saved=JSON.parse(fs.readFileSync(path.join(candidate,RELEASE_META),'utf8'));} catch {continue;}
    if(saved?.version!==version||saved?.fingerprint!==meta.fingerprint) continue;
    if(saved?.engine!==engineRelative) continue;
    try {
      if(fs.statSync(path.join(candidate,saved.engine)).size!==meta.engineSize) continue;
      if(fs.statSync(path.join(candidate,'bin',runtimeName)).size!==meta.runtimeSize) continue;
      fs.accessSync(path.join(candidate,'bridge.js'),fs.constants.R_OK);
      fs.accessSync(path.join(candidate,'version.js'),fs.constants.R_OK);
    } catch {continue;}
    return candidate;
  }
  return null;
}
// Stage a complete immutable copy before stopping the working service. Never
// overwrite a running executable; an identical release is reused so repeated
// "start" clicks do not copy another 100 MB runtime.
export function stage(source,p,version,runtime) {
  const engine=platform.enginePathFor(source);
  const engineRelative=path.relative(source,engine).split(path.sep).join('/');
  const runtimeName=platform.current.runtimeName();
  const meta=releaseFingerprint(source,engine,runtime);
  const reused=reusableRelease(p,version,meta,engineRelative,runtimeName);
  if(reused) return reused;
  fs.mkdirSync(path.join(p.target,'releases'),{recursive:true,mode:0o700});
  const release=fs.mkdtempSync(path.join(p.target,'releases',version+'-'));
  try {
    for(const name of [...payload,'integrity.json'].filter((name)=>name!=='bin')) fs.cpSync(path.join(source,name),path.join(release,name),{recursive:true,dereference:true});
    // Carry only this platform's engine; the other one would waste tens of
    // megabytes in every staged release.
    const staged=path.join(release,engineRelative);
    fs.mkdirSync(path.dirname(staged),{recursive:true});
    fs.copyFileSync(engine,staged);
    fs.chmodSync(staged,0o755);
    fs.copyFileSync(runtime,path.join(release,'bin',runtimeName));
    fs.chmodSync(path.join(release,'bin',runtimeName),0o755);
    atomic(path.join(release,RELEASE_META),JSON.stringify({
      version,
      fingerprint:meta.fingerprint,
      engine:engineRelative,
      engineSha256:meta.engineHash,
      engineSize:meta.engineSize,
      runtimeSize:meta.runtimeSize,
      created:new Date().toISOString()
    },null,2)+'\n');
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
    return startWindowsSupervisor(p,release,exec,launch);
  }
  if(platform.IS_LINUX) {
    const unit=p.systemdUnit||platform.systemdUnitFor(p.home);
    if(!unit) throw new Error('无法确定 systemd 用户单元路径');
    const previous=fs.existsSync(unit)?fs.readFileSync(unit,'utf8'):null;
    await stopJob(p,domain,exec);
    restoreProxy(path.join(p.root,'settings-journal.json'));
    fs.mkdirSync(path.dirname(unit),{recursive:true,mode:0o700});
    atomic(unit,systemdUnitText(p,path.join(release,'bin',platform.current.runtimeName()),release));
    try {await startLinuxSupervisor(p,release,exec,launch);} catch(error) {
      await stopJob(p,domain,exec);
      const systemctl=platform.systemctlFor();
      if(previous!==null) {
        atomic(unit,previous);
        if(systemctl) exec(systemctl,['--user','daemon-reload'],{optional:true,timeout:30000});
      } else {
        try {fs.unlinkSync(unit);} catch {}
        if(systemctl) exec(systemctl,['--user','daemon-reload'],{optional:true,timeout:30000});
      }
      throw error;
    }
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
