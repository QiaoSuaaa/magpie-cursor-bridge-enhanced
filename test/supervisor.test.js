import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createSupervisor} from '../lib/supervisor.js';

const CONNECTION=JSON.stringify({enabled:true,gateway:'http://127.0.0.1:3425/v1',key:'test-only',model:'m',models:[{id:'m'}]});
const BASE_SETTINGS={runMode:'default',subagentMode:'async',refreshSeconds:15,gatewayGraceSeconds:60,modelNames:{},modelOrder:[]};

// A ChildProcess-shaped fake: the supervisor only needs stdout/stderr, once(),
// kill(), pid and the exitCode/signalCode contract. Ready is emitted on the
// next tick so the readline interface is attached first.
function fakeEngine({ready=true,exitEarly=false,onKill}={}) {
  const child=new EventEmitter();
  child.stdout=new PassThrough();
  child.stderr=new PassThrough();
  child.exitCode=null;
  child.signalCode=null;
  child.pid=4242;
  child.kills=[];
  const end=()=>{child.stdout.end();child.stderr.end();};
  child.kill=(signal)=>{
    child.kills.push(signal);
    onKill?.(signal);
    if(child.exitCode!==null||child.signalCode!==null) return false;
    child.exitCode=0;
    end();
    child.emit('exit',0,null);
    return true;
  };
  process.nextTick(()=>{
    if(exitEarly) {child.exitCode=1;end();child.emit('exit',1,null);return;}
    if(ready) child.stdout.write(JSON.stringify({event:'ready',proxy:'http://127.0.0.1:58160',backend:'http://127.0.0.1:53902'})+'\n');
  });
  return child;
}

function harness(options={}) {
  const events=[];
  const state={spawns:[],effective:[],publishes:[],proxies:[],restores:0,children:[],kills:[]};
  let loopTicks=0;
  let clock=options.clock??1000;
  let settingsCalls=0;
  const supervisor=createSupervisor({
    spawnEngine:(spawn)=>{
      events.push(['spawn',spawn.mode]);
      const child=fakeEngine({
        ready:options.ready??true,
        exitEarly:options.exitEarly??false,
        onKill:(signal)=>{events.push(['kill',signal]);state.kills.push(signal);}
      });
      child.bridgeIdentity = {engineVersion: '0.2.16', sha256: 'test-hash', pluginVersion: '0.2.32'};
      state.children.push(child);
      state.spawns.push(spawn);
      return child;
    },
    publish:(name,extra)=>{state.publishes.push({state:name,...extra});events.push(['publish',name]);},
    readSettings:()=>options.configure?options.configure(state,settingsCalls++):{...BASE_SETTINGS},
    readConnection:()=>options.connection?options.connection(state):CONNECTION,
    fetchCatalogue:async(connection,config)=>{
      events.push(['catalogue']);
      return options.catalogue?options.catalogue(connection,config,state):{models:[{id:'m'}]};
    },
    writeEffective:(text)=>{state.effective.push(JSON.parse(text));events.push(['effective']);},
    applyProxy:(proxy)=>{
      events.push(['apply',proxy]);
      state.proxies.push(proxy);
      if(options.applyProxy) options.applyProxy(proxy,state);
    },
    restoreProxy:()=>{events.push(['restore']);state.restores+=1;if(options.restoreProxy) options.restoreProxy(state);},
    pruneDatabase:options.pruneDatabase,
    onPrune:options.onPrune,
    onEngineStderr:()=>{},
    onLifecycle:options.onLifecycle,
    wait:async(ms)=>{
      if(ms===1) loopTicks+=1;
      if(options.wait) await options.wait(ms,state,{advance:(delta)=>{clock+=delta;}});
      else if(ms===1) clock+=20000;
    },
    now:()=>clock,
    isEnding:()=>options.isEnding?options.isEnding(state,loopTicks):loopTicks>=(options.maxTicks??1),
    initialProxyPort:options.initialProxyPort??'',
    engineReadyTimeoutMs:50,
    engineStopTimeoutMs:10,
    loopIntervalMs:1,
    retentionIntervalMs:options.retentionIntervalMs??6*60*60*1000,
    retentionInitialDelayMs:options.retentionInitialDelayMs??60*1000
  });
  return {supervisor,state,events,clock:()=>clock};
}

test('a valid connection starts the engine and publishes the proxy',async()=>{
  const h=harness({maxTicks:1});
  await h.supervisor.run();
  assert.deepEqual(h.state.spawns,[{mode:'default',subagentMode:'async',preferredProxyPort:''}]);
  const connected=h.state.publishes.find(entry=>entry.state==='connected');
  assert.ok(connected);
  assert.equal(connected.mode,'default');
  assert.equal(connected.engineMode,'default');
  assert.equal(connected.proxy,'http://127.0.0.1:58160');
  assert.equal(connected.backend,'http://127.0.0.1:53902');
  assert.equal(connected.pid,4242);
  assert.equal(connected.runtime.engineVersion, '0.2.16');
  assert.equal(connected.runtime.reason, 'initial_start');
  assert.deepEqual(connected.lifecycle.map(entry => entry.event), ['starting', 'ready']);
  assert.ok(!JSON.stringify(connected.lifecycle).includes('test-only'));
  // start() writes the proxy and the loop re-applies it every pass; the real
  // applyProxy() makes the second call a no-op, so only the value matters.
  assert.deepEqual([...new Set(h.state.proxies)],['http://127.0.0.1:58160']);
  assert.deepEqual(h.state.effective,[{models:[{id:'m'}]}]);
});

test('lifecycle log callback receives shutdown events without credentials',async()=>{
  const entries=[];
  const h=harness({maxTicks:1,onLifecycle:entry=>entries.push(entry)});
  await h.supervisor.run();
  assert.deepEqual(entries.map(entry=>entry.event),['starting','ready','stopping','exited']);
  assert.equal(entries[2].reason,'shutdown');
  assert.equal(entries[3].reason,'requested_stop');
  assert.ok(!JSON.stringify(entries).includes('test-only'));
});

test('settings read errors are reported and recovered without losing the supervisor',async()=>{
 let calls=0;
 const h=harness({
   configure:()=>{if(calls++===0) throw new Error('settings temporarily unavailable');return {...BASE_SETTINGS};},
   isEnding:state=>state.publishes.some(entry=>entry.state==='connected')
 });
 await h.supervisor.run();
 assert.match(h.state.publishes.find(entry=>entry.state==='error').reason,/settings temporarily unavailable/);
 assert.equal(h.state.spawns.length,1);
 assert.ok(h.state.publishes.some(entry=>entry.state==='connected'));
});

test('an inactive connection never starts the engine',async()=>{
  const h=harness({connection:()=>'{}',maxTicks:1});
  await h.supervisor.run();
  assert.equal(h.state.spawns.length,0);
  const disconnected=h.state.publishes.find(entry=>entry.state==='disconnected');
  assert.ok(disconnected);
  assert.equal(disconnected.engineMode,null);
});

test('a transient gateway failure keeps the engine and recovers on the next refresh',async()=>{
  let calls=0;
  const h=harness({
    isEnding:(state)=>state.publishes.filter(entry=>entry.state==='connected'&&!entry.warning).length>=2,
    wait:async(ms,state,{advance})=>{advance(20000);},
    catalogue:async()=>{
      calls+=1;
      if(calls===2) throw new Error('gateway down');
      return {models:[{id:'m'}]};
    }
  });
  await h.supervisor.run();
  assert.equal(h.state.spawns.length,1,'the running engine is kept during the outage');
  const warning=h.state.publishes.find(entry=>entry.warning);
  assert.ok(warning);
  assert.match(warning.warning,/gateway down/);
  assert.equal(warning.models,1);
  assert.equal(h.state.publishes.filter(entry=>entry.state==='connected'&&!entry.warning).length,2,'it recovers after the gateway returns');
  assert.equal(h.state.children[0].kills.length,1,'only the final shutdown terminated the engine');
});

test('a run-mode change restarts the engine once and carries the proxy port',async()=>{
  let calls=0;
  const h=harness({
    initialProxyPort:'5555',
    isEnding:(state)=>state.spawns.length>=2,
    configure:()=>({...BASE_SETTINGS,runMode:calls++===0?'default':'lite'})
  });
  await h.supervisor.run();
  assert.deepEqual(h.state.spawns.map(entry=>[entry.mode,entry.preferredProxyPort]),[['default','5555'],['lite','58160']]);
  assert.equal(h.state.children[0].kills.length,1,'the old engine stops before the new one starts');
  assert.equal(h.state.effective.length,2);
  const second = h.state.publishes.filter(entry => entry.state === 'connected').at(-1);
  assert.equal(second.runtime.reason, 'run_mode_changed');
  assert.ok(second.lifecycle.some(entry => entry.event === 'exited' && entry.reason === 'requested_stop'));
});

test('a display-name change hot-swaps the catalogue without restarting',async()=>{
  let calls=0;
  const h=harness({
    isEnding:(state)=>state.effective.length>=2,
    configure:()=>{calls+=1;return {...BASE_SETTINGS,modelNames:calls===1?{}:{m:'Opus'}};},
    catalogue:async(connection,config)=>({models:[{id:'m',name:config.modelNames.m||'m'}]})
  });
  await h.supervisor.run();
  assert.equal(h.state.spawns.length,1,'no engine restart');
  assert.equal(h.state.effective.length,2);
  assert.equal(h.state.effective[1].models[0].name,'Opus');
});

test('Tab changes hot-swap configuration within one loop without restarting',async()=>{
  let calls=0;
  const h=harness({
    maxTicks:2,
    configure:()=>({...BASE_SETTINGS,tabMode:++calls===1?'direct':'official',tabToken:'test-token'}),
    wait:async()=>{},
    catalogue:async(connection,config)=>({models:[{id:'m'}],tab:{mode:config.tabMode,token:config.tabToken}})
  });
  await h.supervisor.run();
  assert.equal(h.state.spawns.length,1);
  assert.deepEqual(h.state.effective.map(entry=>entry.tab.mode),['direct','official']);
});

test('an external proxy change pauses and restores Cursor settings',async()=>{
  const h=harness({
    isEnding:(state)=>state.publishes.some(entry=>entry.state==='paused'),
    wait:async()=>{},
    applyProxy:(proxy,state)=>{
      // The first pass applies twice (start + loop); the third call is the
      // first one of the next pass, where the external change surfaces.
      if(state.proxies.length>=3) throw new Error('Cursor proxy settings changed externally');
    }
  });
  await h.supervisor.run();
  assert.equal(h.state.spawns.length,1);
  assert.equal(h.state.publishes.some(entry=>entry.state==='error'),true);
  const paused=h.state.publishes.find(entry=>entry.state==='paused');
  assert.ok(paused);
  assert.match(paused.reason,/其他程序/);
  assert.ok(h.state.restores>=2);
});

test('an engine crash is restarted on the next tick',async()=>{
  const h=harness({
    isEnding:(state)=>state.spawns.length>=2,
    wait:async(ms,state)=>{
      const child=state.children[0];
      if(ms===1&&child&&child.exitCode===null) {
        child.exitCode=1;
        child.stdout.end();
        child.stderr.end();
        child.emit('exit',1,null);
      }
    }
  });
  await h.supervisor.run();
  assert.equal(h.state.spawns.length,2);
  assert.equal(h.state.children[0].kills.length,0,'an already exited engine is not killed again');
});

test('stop restores Cursor settings before terminating the engine',async()=>{
  const h=harness({maxTicks:1});
  await h.supervisor.run();
  const kinds=h.events.map(entry=>entry[0]);
  const restoreIndex=kinds.lastIndexOf('restore');
  const killIndex=kinds.indexOf('kill');
  assert.ok(restoreIndex>=0&&killIndex>restoreIndex,'restore precedes kill');
  assert.deepEqual(h.state.kills,['SIGTERM']);
});

test('retention runs in the background without blocking the engine',async()=>{
  let ran=0;
  const pruned=[];
  const h=harness({
    isEnding:(state)=>ran>0&&state.publishes.some(entry=>entry.state==='connected'),
    retentionInitialDelayMs:0,
    configure:()=>({...BASE_SETTINGS,tracesRetentionDays:7,sessionsRetentionDays:0}),
    pruneDatabase:async(options)=>{ran+=1;return {at:'2026-01-01T00:00:00.000Z',calls:3,traces:2,sessions:0,tracesDays:options.tracesDays,sessionsDays:options.sessionsDays};},
    onPrune:(result)=>{pruned.push(result);}
  });
  await h.supervisor.run();
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(ran,1);
  assert.equal(h.state.spawns.length,1,'the engine still starts while retention runs');
  assert.equal(pruned[0].calls,3);
  assert.equal(pruned[0].tracesDays,7);
});

test('shutdown waits for an in-flight retention writer before releasing the engine',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const h=harness({
    maxTicks:1,
    retentionInitialDelayMs:0,
    configure:()=>({...BASE_SETTINGS,tracesRetentionDays:7}),
    pruneDatabase:()=>pending
  });
  let finished=false;
  const run=h.supervisor.run().then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finished,false);
  assert.equal(h.state.publishes.some(entry=>entry.state==='stopped'),false);
  release({calls:0});
  await run;
  assert.equal(finished,true);
  assert.equal(h.state.publishes.at(-1).state,'stopped');
});

test('retention is skipped in lite mode',async()=>{
  let ran=0;
  const h=harness({
    isEnding:(state)=>state.publishes.some(entry=>entry.state==='connected'),
    retentionInitialDelayMs:0,
    configure:()=>({...BASE_SETTINGS,runMode:'lite',tracesRetentionDays:7,sessionsRetentionDays:0}),
    pruneDatabase:async()=>{ran+=1;return {};}
  });
  await h.supervisor.run();
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(ran,0);
});

test('an engine that exits before ready reports an error',async()=>{
  const h=harness({
    exitEarly:true,
    isEnding:(state)=>state.publishes.some(entry=>entry.state==='error')
  });
  await h.supervisor.run();
  const error=h.state.publishes.find(entry=>entry.state==='error');
  assert.ok(error);
  assert.match(error.reason,/bridge engine stopped/);
  assert.equal(h.state.spawns.length,1);
  assert.equal(h.state.children[0].kills.length,0);
});
