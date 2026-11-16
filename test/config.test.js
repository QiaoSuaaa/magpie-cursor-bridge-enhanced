import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validate,gatewayModels} from '../lib/config.js';
import {connect,agent} from '../agent.js';
import {version} from '../version.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const c={enabled:true,gateway:'http://127.0.0.1:3425/v1',key:'test-only',model:'provider/model',models:[{id:'provider/model'}]};
test('plugin is a Magpie agent and maps supplied credentials and models',()=>{assert.equal(agent.id,'cursor-bridge');const out=connect({gateway:{v1:c.gateway,key:c.key},models:c.models});assert.equal(out.key,c.key);assert.deepEqual(validate({...out,model:c.model}).models,[{id:c.model,name:c.model,context:null}]);});
test('disconnected configuration is inactive',()=>{assert.equal(validate({}),null);assert.equal(validate({...c,enabled:false}),null);});
test('refuses remote gateway and credential-bearing URL',()=>{for(const gateway of ['https://evil.example/v1','http://127.0.0.1.evil.example','http://key@127.0.0.1','file:///tmp/test'])assert.throws(()=>validate({...c,gateway}));});
test('selected model must exist and IDs must be unique',()=>{assert.throws(()=>validate({...c,model:'missing'}));assert.throws(()=>validate({...c,models:[...c.models,...c.models]}));});
test('live gateway names win over the recorded connection copy',async t=>{
  let authorization='',userAgent='';
  const server=http.createServer((req,res)=>{
    authorization=req.headers.authorization||'';
    userAgent=req.headers['user-agent']||'';
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({data:[
      {id:'provider/model',name:'Fresh name',context_window:200000},
      {id:'provider/other'}
    ]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={...c,gateway:`http://127.0.0.1:${server.address().port}/v1`,models:[
    {id:'provider/model',name:'Old name',context:1000},
    {id:'provider/other',name:'Other old'}
  ]};
  const out=await gatewayModels(config);
  assert.equal(authorization,`Bearer ${c.key}`);
  assert.equal(userAgent,`cursor-magpie-bridge/${version}`);
  assert.deepEqual(out.models,[
    {id:'provider/model',name:'Fresh name',context:200000},
    {id:'provider/other',name:'Other old',context:null}
  ]);
});
test('manifest exposes the control host and the agent-row console page',()=>{
  assert.equal(manifest.main,'./control/host.js');
  assert.equal(manifest.magpie.page.file,'ui/console.html');
  assert.deepEqual(manifest.magpie.actions.map(action=>[action.id,action.menu]),[['console','agent']]);
  assert.equal(manifest.magpie.panels,undefined);
  for(const file of ['control/host.js','control/server.js','control/ui.html','ui/console.html','ui/console-page.js']) assert.ok(fs.existsSync(path.join(root,file)),file);
});
