import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { activeAlert, resolvedAlert, sensorGroup, validateWindow } from '../server/investigation.js';
import { Agent } from '../server/netdata.js';
import { containerStatus, sortContainers } from '../src/preferences.js';
import { servicesFromHosts } from '../src/services.js';
import type { Host } from '../src/types.js';
import type { Container } from '../src/types.js';

test('time windows reject unbounded, future, reversed, missing and malformed requests',()=>{
  assert.deepEqual(validateWindow('100','500',1000),{after:100,before:500});
  for (const [a,b] of [[0,500],[500,100],[100,101],[1,99999999],['x',500],[undefined,500],[100,1100],[100.1,500]]) assert.throws(()=>validateWindow(a,b,1000));
});
test('resolved alerts require a real raised-to-clear transition and retain incident duration',()=>{
  const t={transition_id:'one',alert:'disk',instance:'disk.a',when:500,new:{status:'CLEAR'},old:{status:'CRITICAL',value:99,duration:10,raised_duration:120}};
  const a=resolvedAlert(t,{});
  assert.equal(a?.startedAt,380);assert.equal(a?.duration,120);assert.equal(a?.value,99);assert.equal(a?.resolved,true);
  assert.equal(resolvedAlert({...t,old:{status:'UNINITIALIZED'}},{}),null);
  assert.equal(resolvedAlert({...t,new:{status:'REMOVED'}},{}),null);
  assert.equal(activeAlert({gi:1,nm:'a',st:'WARNING',ch:'disk.a',tr_t:0,v:null},{}).value,null);
});
test('temperature groups distinguish CPU, storage and unclassified sensors',()=>{
  assert.equal(sensorGroup({driver:'coretemp'}),'CPU temperatures');
  assert.equal(sensorGroup({driver:'nvme'}),'Storage temperatures');
  assert.equal(sensorGroup({driver:'acpitz'}),'Other temperatures');
});
test('container sorting puts missing values last, preserves input and distinguishes health and state',()=>{
  const base:Container={name:'web',state:'running',health:null,image:'',cpu:0,memory:50,network:{received:null,sent:null},io:{read:null,write:null}};
  const cs=[{...base,name:'z',cpu:null},{...base,name:'a',cpu:10},base];
  assert.deepEqual(sortContainers(cs,'cpu').map(c=>c.name),['a','web','z']);
  assert.deepEqual(sortContainers(cs,'name').map(c=>c.name),['a','web','z']);
  assert.equal(cs[0].name,'z');
  assert.equal(containerStatus({...base,health:'unhealthy'},true),'unhealthy');
  assert.equal(containerStatus({...base,state:'exited',health:'healthy'},true),'stopped');
  assert.equal(containerStatus(base,false),'unknown');
  assert.equal(containerStatus(base,true),'running');
});

test('metric queries use bounded per-dimension extrema, invert idle peaks, cache and preserve null gaps',async t=>{
  const now=Math.floor(Date.now()/1000);let calls=0;let fail=false;let wrong=false;
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url!,'http://localhost');res.setHeader('Content-Type','application/json');
    const send=(v:unknown)=>res.end(JSON.stringify(v));
    if(u.pathname.endsWith('/nodes'))return send({nodes:[{mg:'guid',nm:'host',state:'reachable'}]});
    if(u.pathname.endsWith('/charts'))return send({hostname:'host',charts:{'system.cpu':{id:'system.cpu',context:'system.cpu',units:'percentage',family:'cpu',chart_labels:{}},'temp':{id:'temp',context:'system.hw.sensor.temperature.input',units:'Celsius',family:'sensor',chart_labels:{}}}});
    if(u.pathname.endsWith('/contexts'))return send({contexts:{'system.cpu':{}}});
    if(u.pathname.endsWith('/alerts'))return send({nodes:[{mg:'guid',ni:0},{mg:'other',ni:1}],alert_instances:[{gi:1,ni:0,nm:'cpu',st:'WARNING',ch:'system.cpu',ctx:'system.cpu',tr_t:now-60,v:90,cfg:'cfg'},{gi:2,ni:1,nm:'bad',st:'CRITICAL'}]});
    if(u.pathname.endsWith('/alert_config'))return send({status:{warn:'$this > 80',crit:'$this > 95'}});
    if(u.pathname.endsWith('/alert_transitions'))return send({transitions:[{machine_guid:'guid',transition_id:'resolved',alert:'cpu',instance:'system.cpu',context:'system.cpu',when:now-200,new:{status:'CLEAR'},old:{status:'WARNING',raised_duration:100,value:85}},{machine_guid:'other',new:{status:'CLEAR'},old:{status:'WARNING'}}]});
    calls++;assert.equal(u.searchParams.get('points'),'240');assert.equal(u.searchParams.get('instances'),u.searchParams.get('contexts')==='system.cpu'?'system.cpu':'temp');
    assert.equal(u.searchParams.get('after'),String(now-3600));
    if(fail){res.statusCode=500;return send({});}
    const agg=u.searchParams.get('time_group');const isCpu=u.searchParams.get('contexts')==='system.cpu';
    const value=isCpu?(agg==='min'?10:agg==='max'?90:60):-5;
    const id=isCpu?'system.cpu':'temp',dim=isCpu?'idle':'input';
    return send({summary:{nodes:[{mg:wrong?'wrong':'guid'}]},result:{labels:['time',dim],data:[[now-30,value],[now-60,null]]},view:{dimensions:{ids:[`${dim},${id}@guid`]},update_every:30},db:{first_entry:now-86400,last_entry:now}});
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const agent=new Agent({id:'h',name:'Host',node:'host',url:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  const w={after:now-3600,before:now};const [a,b]=await Promise.all([agent.metricHistory('system.cpu',w),agent.metricHistory('system.cpu',w)]);
  assert.equal(a,b);assert.equal(calls,3);assert.equal(a.points[0]['busy:max'],null);assert.equal(a.points[1]['busy:max'],90);assert.equal(a.points[1]['busy:min'],10);assert.equal(a.points[1]['busy:average'],40);assert.equal(a.retention.first,now-86400);
  const temp=await agent.metricHistory('temp',w);assert.equal(temp.points[1]['input:average'],-5);
  const alerts=await agent.alertDetails();assert.equal(alerts.active.length,1);assert.equal(alerts.resolved.length,1);assert.equal(alerts.active[0].warning,'$this > 80');
  fail=true;const bad=await new Agent(agent.config).metricHistory('system.cpu',w);assert.equal(bad.points.length,0);assert.equal(bad.errors.length,3);
  fail=false;wrong=true;const isolated=await new Agent(agent.config).metricHistory('system.cpu',w);assert.equal(isolated.points.length,0);assert.equal(isolated.errors.length,3);
  await assert.rejects(()=>agent.metricHistory('not-a-chart',w),/Unknown metric/);
});

test('service availability remains independent of running and Docker health',()=>{
  const host = {id:'h',status:'online',containers:[{name:'web',state:'running',health:'healthy'}]} as Host;
  const service = servicesFromHosts([host])[0];
  assert.equal(service.state,'running');assert.equal(service.dockerHealth,'healthy');assert.equal(service.availability.state,'unchecked');
  const independentlyDown = servicesFromHosts([host],{'h:web':{state:'down',method:'http',checkedAt:'2026-01-01T00:00:00Z',detail:'HTTP 503'}})[0];
  assert.equal(independentlyDown.state,'running');assert.equal(independentlyDown.availability.state,'down');
  const disconnected = servicesFromHosts([{...host,status:'offline'}])[0];
  assert.equal(disconnected.state,'unknown');assert.equal(disconnected.dockerHealth,null);
});
