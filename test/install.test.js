import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {paths,verifyPackage,initializeCertificate,stage,activate,plistText,windowsLauncherScript} from '../lib/install.js';
import platformModule from '../lib/platform.js';
const source=fileURLToPath(new URL('..',import.meta.url));
const engine=platformModule.enginePathFor(source);
const stagedEngine=path.relative(source,engine);
const runtimeName=platformModule.runtimeNameFor();
const IS_WIN=platformModule.IS_WIN;
const temp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-install-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
// pathsFor() resolves the Windows layout from %APPDATA%/%LOCALAPPDATA%, not
// from the home argument, so tests must point those at the temporary home or
// they write into the real installation.
const fakePaths=t=>{
 const home=temp(t);
 const env={};
 for(const key of ['APPDATA','LOCALAPPDATA']) env[key]=process.env[key];
 if(IS_WIN) {
  process.env.APPDATA=path.join(home,'AppData','Roaming');
  process.env.LOCALAPPDATA=path.join(home,'AppData','Local');
 }
 t.after(()=>{for(const key of Object.keys(env)) {if(env[key]===undefined) delete process.env[key];else process.env[key]=env[key];}});
 return paths(home);
};
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const init=root=>spawnSync(engine,['--init-ca'],{encoding:'utf8',env:{...process.env,CURSOR_BYOK_DATA_DIR:root}});
test('fresh machines generate distinct CAs without a BYOK install, database or trust changes',t=>{
 const root=temp(t),one=path.join(root,'one'),two=path.join(root,'two');
 assert.equal(init(one).status,0);assert.equal(init(two).status,0);
 assert.equal(JSON.parse(init(one).stdout).ca,'untrusted');
 assert.notEqual(hash(path.join(one,'ca/ca.key')),hash(path.join(two,'ca/ca.key')));
 if(!IS_WIN) {
  assert.equal(fs.statSync(path.join(one,'ca/ca.key')).mode&0o777,0o600);
  assert.equal(fs.statSync(path.join(one,'ca')).mode&0o777,0o700);
 }
 const before=hash(path.join(one,'ca/ca.key'));assert.equal(init(one).status,0);assert.equal(hash(path.join(one,'ca/ca.key')),before);
 assert.deepEqual(fs.readdirSync(one),['ca']);
 fs.unlinkSync(path.join(one,'ca/ca.crt'));assert.notEqual(init(one).status,0);assert.equal(hash(path.join(one,'ca/ca.key')),before);
});
test('package and native engine have the same pinned version and digest',()=>{assert.equal(verifyPackage(source).version,'0.2.16');});
test('certificate trust uses SSL policy and argument arrays, and refuses failed authorization',{skip:IS_WIN},t=>{
 const p=fakePaths(t),calls=[];let trusted=false;
 const exec=(cmd,args,options)=>{calls.push({cmd,args,options});if(args[0]==='--init-ca')return {status:0,stdout:'{"ca":"untrusted"}'};if(args[0]==='add-trusted-cert'){trusted=true;return {status:0};}return {status:trusted?0:1};};
 initializeCertificate(engine,p,exec);
 assert.equal(calls.filter(c=>c.args[0]==='add-trusted-cert').length,1);
 assert.deepEqual(calls.at(-1).args.slice(-2),['-p','ssl']);
 calls.length=0;initializeCertificate(engine,p,exec);assert.equal(calls.some(c=>c.args[0]==='add-trusted-cert'),false);
 trusted=false;assert.throws(()=>initializeCertificate(engine,p,exec,{trust:false}),/尚未受信任/);
 assert.throws(()=>initializeCertificate(engine,p,(cmd,args)=>args[0]==='--init-ca'?{stdout:'{}'}:{status:1}),/信任未完成/);
});
test('windows certificate trust elevates once and verifies the machine Root store',{skip:!IS_WIN},t=>{
 const p=fakePaths(t);
 fs.mkdirSync(path.join(p.root,'data/ca'),{recursive:true});
 fs.writeFileSync(path.join(p.root,'data/ca/ca.crt'),`-----BEGIN CERTIFICATE-----\n${Buffer.from('test-certificate-body').toString('base64')}\n-----END CERTIFICATE-----\n`);
 const calls=[];let elevated=false,elevations=0;
 const exec=(cmd,args)=>{
  calls.push({cmd,args});
  if(args[0]==='--init-ca')return {status:0,stdout:'{"ca":"untrusted"}'};
  const script=String(args.at(-1)||'');
  if(script.includes('Start-Process')){elevated=true;elevations+=1;return {status:0,stdout:''};}
  const thumb=(script.match(/eq '([0-9A-F]+)'/)||[])[1]||'';
  return {status:0,stdout:elevated?thumb:''};
 };
 initializeCertificate(engine,p,exec);
 assert.equal(elevations,1,'one UAC elevation');
 const add=calls.find(c=>String(c.args.at(-1)||'').includes("'-addstore'"));
 assert.ok(add,'certutil -addstore runs elevated');
 assert.match(String(add.args.at(-1)),/'-addstore','Root'/);
 initializeCertificate(engine,p,exec);
 assert.equal(elevations,1,'an already trusted CA skips the prompt');
 assert.throws(()=>initializeCertificate(engine,p,exec,{trust:false}),/尚未受信任/);
});
test('windows trust fails clearly when the administrator prompt is declined',{skip:!IS_WIN},t=>{
 const p=fakePaths(t);
 fs.mkdirSync(path.join(p.root,'data/ca'),{recursive:true});
 fs.writeFileSync(path.join(p.root,'data/ca/ca.crt'),`-----BEGIN CERTIFICATE-----\n${Buffer.from('declined-certificate').toString('base64')}\n-----END CERTIFICATE-----\n`);
 const exec=(cmd,args)=>args[0]==='--init-ca'?{status:0,stdout:'{"ca":"untrusted"}'}:{status:1,stdout:'',stderr:'canceled'};
 assert.throws(()=>initializeCertificate(engine,p,exec),/管理员确认/);
});
test('service plist escapes paths and uses an installed runtime, independent of nvm and Magpie cache',t=>{
 const p=fakePaths(t);const xml=plistText(p,'/tmp/A & B/runtime','/tmp/A < B/release');
 assert.match(xml,/A &amp; B/);assert.match(xml,/A &lt; B/);assert.doesNotMatch(xml,/nvm|\.cache/);
});
test('complete staging never overwrites an existing running release',t=>{
 const p=fakePaths(t);const fakeRuntime=path.join(p.home,'runtime');fs.writeFileSync(fakeRuntime,'test');
 const one=stage(source,p,'0.2.16',fakeRuntime),two=stage(source,p,'0.2.16',fakeRuntime);
 assert.notEqual(one,two);assert.equal(hash(path.join(one,stagedEngine)),hash(engine));
 assert.ok(fs.existsSync(path.join(two,'vendor/jsonc-parser/package.json')));
 if(!IS_WIN) assert.equal(fs.statSync(path.join(two,'bin',runtimeName)).mode&0o777,0o755);
});
test('windows activation writes a Startup launcher and starts the supervisor once',{skip:!IS_WIN},async t=>{
 const p=fakePaths(t);
 fs.mkdirSync(path.join(p.root,'supervisor.lock'),{recursive:true});
 fs.writeFileSync(path.join(p.root,'supervisor.lock/pid'),'999999');
 const release=path.join(p.target,'releases','test');
 fs.mkdirSync(path.join(release,'bin'),{recursive:true});
 fs.writeFileSync(path.join(release,'bridge.js'),'// bridge');
 fs.writeFileSync(path.join(release,'bin',runtimeName),'fake');
 let launched=0;
 const exec=()=>({status:0});
 const launch=(releaseDir)=>{launched++;fs.mkdirSync(path.join(p.root,'supervisor.lock'),{recursive:true});fs.writeFileSync(path.join(p.root,'supervisor.lock/pid'),String(process.pid));};
 await activate(p,release,'',exec,launch);
 assert.equal(launched,1);
 const text=fs.readFileSync(p.autostart,'utf8');
 assert.match(text,/bridge\.js/);
 assert.match(text,/, 0, False/);
 assert.equal(fs.readFileSync(path.join(p.root,'supervisor.lock/pid'),'utf8'),String(process.pid));
});
test('windows launcher hides the console window and doubles embedded quotes',()=>{
 const script=windowsLauncherScript('C:\\Users\\u\\releases\\v','C:\\Program Files\\magpie\\runtime.exe');
 assert.match(script,/CreateObject\("WScript\.Shell"\)\.Run/);
 assert.match(script,/""C:\\Program Files\\magpie\\runtime\.exe""/);
 assert.match(script,/supervise", 0, False/);
});
test('failed activation restores previous launch configuration and restarts previous release',{skip:IS_WIN,timeout:15000},async t=>{
 const p=fakePaths(t);fs.mkdirSync(path.dirname(p.plist),{recursive:true});fs.writeFileSync(p.plist,'previous');
 let bootstraps=0;const exec=(cmd,args)=>{if(args[0]==='bootstrap'){bootstraps++;return {status:bootstraps<=5?1:0};}return {status:1};};
 await assert.rejects(activate(p,'/new/release','gui/999',exec),/未能启动/);
 assert.equal(fs.readFileSync(p.plist,'utf8'),'previous');assert.equal(bootstraps,6);
});

test('GitHub installation stages the vendored JSONC parser without npm install',t=>{
 const p=fakePaths(t);const home=p.home,parent=path.join(home,'node_modules'),plugin=path.join(parent,'magpie-agent-cursor-bridge');
 fs.mkdirSync(plugin,{recursive:true});
 for(const name of fs.readdirSync(source)) {
   if(['node_modules','.git'].includes(name)) continue;
   fs.cpSync(path.join(source,name),path.join(plugin,name),{recursive:true});
 }
 assert.equal(verifyPackage(plugin).version,'0.2.16');
 const runtime=path.join(home,'runtime');fs.writeFileSync(runtime,'test');
 const release=stage(plugin,p,'0.2.16',runtime);
 assert.ok(fs.existsSync(path.join(release,'vendor/jsonc-parser/lib/umd/main.js')));
});
