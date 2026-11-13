#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomic,restoreProxy} from './lib/settings.js';
import {paths,run,verifyPackage,initializeCertificate,stage,activate,stopJob,pruneReleases} from './lib/install.js';
import platform from './lib/platform.js';
const source=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
const command=process.argv[2]||'setup';
const p=paths(os.homedir());
try {
  if(command==='--help'||command==='-h') console.log(`Usage: bash setup.command [setup|status|uninstall|--version]\nsetup: install/update the paired plugin and service.\nmacOS uses a LaunchAgent; Windows uses a Startup-folder launcher (no administrator rights needed); ${platform.platform === 'linux' ? 'Linux can run the control console only' : platform.platform + ' is supported'}.`);
  else if(command==='--version') console.log(manifest.version);
  else if(command==='status') {
    console.log(fs.existsSync(path.join(p.root,'status.json'))?fs.readFileSync(path.join(p.root,'status.json'),'utf8'):'未安装或尚未运行');
  } else {
    if(!['setup','uninstall'].includes(command)) throw new Error('未知命令；使用 --help 查看用法');
    if(!platform.IS_DARWIN&&!platform.IS_WIN) throw new Error(`当前平台（${platform.platform}）暂不支持自动安装后台服务；控制台可在源码目录直接使用，原生引擎需要对应平台的构建产物`);
    if(platform.IS_DARWIN&&process.arch!=='arm64') throw new Error('Apple Silicon 发布物仅包含 arm64 原生引擎；Intel Mac 需另行构建 x64 版本后再安装');
    if(platform.IS_WIN&&!['x64','arm64'].includes(process.arch)) throw new Error(`当前发布物仅包含 Windows x64 原生引擎，无法在 ${process.arch} 上运行`);
    const domain=platform.IS_DARWIN?`gui/${process.getuid()}`:'';
    const magpie=platform.current.magpieExecutable();
    const magpieReady=!!magpie&&fs.existsSync(magpie);
    if(platform.IS_DARWIN&&!magpieReady) throw new Error('请先将 Magpie 安装到 /Applications');
    fs.mkdirSync(p.root,{recursive:true,mode:0o700});fs.chmodSync(p.root,0o700);
    // One installer owns both certificate initialization and service activation.
    const lock=path.join(p.root,'installer.lock');
    try {fs.mkdirSync(lock);} catch {throw new Error('另一个安装程序正在运行；若上次被强制终止，请检查后移除 installer.lock 再重试');}
    try {
      if(command==='uninstall') {
        if(magpieReady) run(magpie,['cursor-bridge','default'],{optional:true});
        await stopJob(p,domain);restoreProxy(path.join(p.root,'settings-journal.json'));
        if(platform.IS_WIN) {
          const autostart=p.autostart||platform.current.autostartEntry(p.home);
          if(autostart&&fs.existsSync(autostart)) fs.unlinkSync(autostart);
        }
        if(magpieReady) run(magpie,['plugin','rm',p.target],{optional:true});
        if(p.plist&&fs.existsSync(p.plist)) fs.unlinkSync(p.plist);
        console.log('后台已卸载，Cursor 代理已还原。若从 Magpie 插件页安装，请同时移除该插件。证书、数据及恢复记录保留。');
      } else {
        verifyPackage(source);
        initializeCertificate(platform.enginePathFor(source),p);
        // Copy the runtime locally so Magpie cache cleanup cannot break the LaunchAgent.
        const release=stage(source,p,manifest.version,process.execPath);
        // A package installed by Magpie is already registered; ZIP installs register a stable local descriptor.
        // magpieConfigDir() already ends in /magpie; the plugin registry lives
        // beside it as <config-home>/magpie/plugins.json.
        const configHome=path.dirname(platform.current.magpieConfigDir(p.home));
        const packagePath=path.join(configHome,'magpie/plugins/node_modules',manifest.name);
        // Magpie also registers a plugin by its local path (this repository), so
        // a missing npm-style copy does not mean the descriptor is unregistered.
        let registered=fs.existsSync(packagePath)&&fs.realpathSync(packagePath)===fs.realpathSync(source);
        let duplicates=[];
        try {
          const list=JSON.parse(fs.readFileSync(path.join(configHome,'magpie/plugins.json'),'utf8')).plugins||[];
          const ours=list.filter(entry=>{
            const spec=String(entry?.spec||'');
            try {return !!spec && [source,p.target].some(target=>path.resolve(spec)===path.resolve(target));} catch {return false;}
          });
          duplicates=ours;
          registered=registered||ours.some(entry=>path.resolve(String(entry.spec))===path.resolve(source));
        } catch { /* no plugins.json yet */ }
        // A leftover registration of the stable copy beside a live source
        // registration loads the plugin twice: both control hosts fight over
        // the same port and Magpie logs an agent-id conflict every reload.
        if(duplicates.length>1) console.log(`注意：Magpie 中登记了 ${duplicates.length} 份本插件（${duplicates.map(entry=>entry.spec).join('、')}）。请保留一份并移除其余条目，否则两个控制服务会争用同一端口。`);
        if(registered) {
          // Already registered (normally the source directory itself). Leave
          // it alone: `magpie plugin rm` matches by plugin name, so removing
          // the stable copy would also drop this very registration.
        } else {
          // The registered descriptor needs the agent, the Agents-page panel,
          // the control host and the shared modules those files import.
          for(const name of ['control','ui','lib','vendor']) fs.cpSync(path.join(source,name),path.join(p.target,name),{recursive:true,force:true});
          atomic(path.join(p.target,'agent.js'),fs.readFileSync(path.join(source,'agent.js'),'utf8'));
          atomic(path.join(p.target,'agent-platform.js'),fs.readFileSync(path.join(source,'agent-platform.js'),'utf8'));
          atomic(path.join(p.target,'package.json'),JSON.stringify({name:manifest.name,version:manifest.version,type:'module',main:manifest.main,magpie:manifest.magpie},null,2));
          atomic(path.join(p.target,'control-location.json'),JSON.stringify({source},null,2));
          if(magpieReady) run(magpie,['plugin','add',p.target]);
          else console.log(`未找到 Magpie 可执行文件，请从 Magpie 插件页手动添加：${p.target}`);
        }
        await activate(p,release,domain);
        // Windows stages the host runtime (~100 MB) on every start; keeping
        // only the active release stops a handful of clicks from filling the
        // disk. Other platforms keep their historical layout.
        if(platform.IS_WIN) pruneReleases(p,release);
        atomic(path.join(p.root,'installation.json'),JSON.stringify({version:manifest.version,release,source,installed:new Date().toISOString()},null,2));
        console.log(`已安装 v${manifest.version}。在 Magpie → Agents 选择 Cursor · Magpie Bridge 和模型；首次连接后重启 Cursor。`);
      }
    } finally {fs.rmdirSync(lock);}
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
