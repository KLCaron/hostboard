import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CheckSchema, ChecksSchema } from '../server/check-config.js';
import { probe } from '../server/probe.js';
import { Monitor } from '../server/monitor.js';
import type { Message } from '../server/notifications.js';
const check = CheckSchema.parse({ id:'web', name:'Web', hostId:'host', type:'http', url:'http://127.0.0.1/', intervalSeconds:10, failureThreshold:3 });
const bad = { ok:false, responseMs:12, reason:'Unexpected HTTP status 503' };
const good = { ok:true, responseMs:8, reason:'HTTP 200' };

test('administrator configuration validates protocols, identities, bounds and secrets', () => {
  for (const patch of [{url:'file:///etc/passwd'},{url:'http://user:pass@localhost/'},{intervalSeconds:1},{timeoutMs:0},{failureThreshold:0},{unexpected:'field'},{expectedStatuses:[]}]) assert.equal(CheckSchema.safeParse({...check,...patch}).success,false);
  assert.equal(ChecksSchema.safeParse({checks:[check,check]}).success,false);
  assert.equal(CheckSchema.safeParse({...check, url:'https://localhost/health', headersEnv:'CHECK_HEADERS'}).success,true);
});

test('HTTP probes check status/content, bound time and bodies, handle redirects and retain TLS verification', async t => {
  const server = http.createServer((req,res)=>{
    if(req.url==='/timeout')return;
    if(req.url==='/redirect'){res.writeHead(302,{location:'/ok'});res.end();return;}
    if(req.url==='/outside'){res.writeHead(302,{location:'http://example.com/'});res.end();return;}
    if(req.url==='/loop'){res.writeHead(302,{location:'/loop'});res.end();return;}
    if(req.url==='/large'){res.end('x'.repeat(1024*1024+1));return;}
    if(req.url==='/503')res.statusCode=503;
    res.end('Healthy service');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const run=(pathname:string,patch={})=>probe(CheckSchema.parse({...check,url:origin+pathname,timeoutMs:150,...patch}));
  assert.equal((await run('/ok',{expectedContent:'Healthy'})).ok,true);
  assert.equal((await run('/ok',{expectedContent:'missing'})).ok,false);
  assert.equal((await run('/503')).ok,false);
  assert.equal((await run('/503',{expectedStatuses:[503]})).ok,true);
  assert.match((await run('/timeout')).reason,/timed out/);
  assert.equal((await run('/redirect')).ok,false);
  assert.equal((await run('/redirect',{followRedirects:true})).ok,true);
  assert.match((await run('/outside',{followRedirects:true})).reason,/Cross-origin/);
  assert.match((await run('/loop',{followRedirects:true})).reason,/Too many/);
  assert.match((await run('/large',{expectedContent:'Healthy'})).reason,/limit/);
  assert.equal((await run('/ok',{headersEnv:'UNSET_HOSTBOARD_TEST_HEADERS'})).ok,null);
  const dir=mkdtempSync(path.join(tmpdir(),'hostboard-tls-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',dir+'/key','-out',dir+'/cert','-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
  const tls=https.createServer({key:readFileSync(dir+'/key'),cert:readFileSync(dir+'/cert')},(_req,res)=>res.end('ok'));
  await new Promise<void>(r=>tls.listen(0,'127.0.0.1',r));t.after(()=>tls.close());
  assert.match((await probe(CheckSchema.parse({...check,url:`https://127.0.0.1:${(tls.address() as net.AddressInfo).port}`}))).reason,/TLS/);
});

test('TCP probes verify accepted connections and refusal', async t=>{
  const server=net.createServer(socket=>socket.end());
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as net.AddressInfo).port;
  const tcp=CheckSchema.parse({id:'tcp',name:'TCP',hostId:'host',type:'tcp',address:'127.0.0.1',port});
  const result=await probe(tcp);assert.equal(result.ok,true);assert.match(result.reason,/functionality not verified/);
  await new Promise<void>(r=>server.close(()=>r()));
  assert.equal((await probe(tcp)).ok,false);
});

test('failure thresholds, transient failures, incident lifecycle and monitoring gaps remain distinct',()=>{
  const monitor=new Monitor(ChecksSchema.parse({checks:[check]}),':memory:',null,1000);
  monitor.record(check,good,1000);monitor.record(check,bad,1010);monitor.record(check,good,1020);
  assert.equal(monitor.view(1020).incidents.length,0);
  monitor.record(check,bad,1030);monitor.record(check,bad,1040);
  assert.equal(monitor.view(1040).checks[0].state,'pending');
  monitor.record(check,bad,1050);monitor.record(check,bad,1060);
  assert.equal(monitor.view(1060).incidents.length,1);
  assert.equal(monitor.view(1060).incidents[0].startedAt,1030);
  assert.equal(monitor.view(1100).checks[0].state,'unknown');
  monitor.record(check,{ok:null,responseMs:null,reason:'Monitor unavailable'},1100);
  assert.equal(monitor.view(1100).incidents[0].endedAt,null);
  monitor.record(check,good,1110);
  const view=monitor.view(1110);
  assert.equal(view.incidents[0].endedAt,1110);assert.equal(view.incidents[0].monitoringGap,true);
  assert.deepEqual(view.incidents[0].notifications.map(n=>n.state),['disabled','disabled']);
  assert.equal(view.checks[0].summary.availability,null);
  assert(view.checks[0].summary.unknownSeconds>86000);
  assert(!JSON.stringify(view).includes('127.0.0.1'));
  monitor.db.close();
});

test('gaps reset unconfirmed failure streaks, configuration changes retire incidents',()=>{
  const m=new Monitor(ChecksSchema.parse({checks:[check]}),':memory:',null,1000);
  m.record(check,bad,1000);m.record(check,bad,1010);m.record(check,bad,1100);
  assert.equal(m.view(1100).checks[0].failures,1);assert.equal(m.view(1100).incidents.length,0);
  m.db.close();
});

test('persistent incidents survive restarts, retired configurations do not claim recovery', t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'hostboard-db-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'monitor.sqlite'),config=ChecksSchema.parse({checks:[check]});
  let m=new Monitor(config,file,null,1000);
  m.record(check,bad,1000);m.record(check,bad,1010);m.record(check,bad,1020);m.db.close();
  m=new Monitor(config,file,null,1100);
  assert.equal(m.view(1100).incidents[0].endedAt,null);assert.equal(m.view(1100).incidents[0].monitoringGap,true);
  m.record(check,good,1100);assert.equal(m.view(1100).incidents[0].endedAt,1100);m.db.close();
  m=new Monitor(config,file,null,1200);m.record(check,bad,1200);m.record(check,bad,1210);m.record(check,bad,1220);m.db.close();
  m=new Monitor(ChecksSchema.parse({checks:[{...check,url:'http://127.0.0.1/new'}]}),file,null,1300);
  assert.match(m.view(1300).incidents[0].resolution!,/configuration changed/);assert.equal(m.view(1300).checks[0].state,'unknown');m.db.close();
});

test('SMTP outbox retries, orders recovery after outage, deduplicates, persists, and enforces cooldown',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'hostboard-mail-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'monitor.sqlite');let fail=true;const messages:Message[]=[];
  const delivery={provider:'test',send:async(message:Message)=>{if(fail)throw Error('secret SMTP response');messages.push(message);}};
  let m=new Monitor(ChecksSchema.parse({checks:[check]}),file,delivery,1000);
  m.record(check,bad,1000);m.record(check,bad,1010);m.record(check,bad,1020);m.record(check,bad,1030);
  await m.dispatch(1030);assert.equal(m.view(1030).notifications.failed,1);
  assert(!JSON.stringify(m.view(1030)).includes('secret'));
  m.record(check,good,1040);await m.dispatch(1040);assert.equal(messages.length,0);m.db.close();
  m=new Monitor(ChecksSchema.parse({checks:[check]}),file,delivery,1061);fail=false;
  await m.dispatch(1061);assert.equal(messages.length,2);assert.match(messages[1].body,/Elapsed outage: 40 seconds/);
  await m.dispatch(1070);assert.equal(messages.length,2);
  m.record(check,bad,1080);m.record(check,bad,1090);m.record(check,bad,1100);await m.dispatch(1100);assert.equal(messages.length,2);
  m.record(check,good,1110);await m.dispatch(1110);assert.equal(messages.length,2);
  await m.dispatch(2000);await m.dispatch(2001);assert.equal(messages.length,4);m.db.close();
});

test('severity and notification ownership suppress events without losing incidents',async()=>{
  const config=ChecksSchema.parse({minimumSeverity:'critical',checks:[{...check,severity:'warning'}]});
  const m=new Monitor(config,':memory:',{provider:'test',send:async()=>{throw Error('Must not send');}},1000);
  for(let i=0;i<3;i++)m.record(config.checks[0],bad,1000+i*10);
  assert.equal(m.view(1030).incidents.length,1);assert.equal(m.view(1030).incidents[0].notifications[0].state,'suppressed');await m.dispatch(1030);m.db.close();
});

test('watchdog incidents and delivery status import persistently without sending duplicates',async()=>{
  let sends=0;
  const m=new Monitor(ChecksSchema.parse({checks:[check]}),':memory:',{provider:'test',send:async()=>{sends++;}},1000);
  const remote={id:1,name:'host / Hostboard availability',startedAt:900,detectedAt:1020,endedAt:null,reason:'Hostboard unreachable',lastReason:'Hostboard unreachable',notifications:[{event:'outage' as const,state:'delivered' as const,attempts:1,lastAttempt:1021,deliveredAt:1021,error:null}]};
  m.record(check,{...good,watchdogHistory:[remote]},1030);
  m.record(check,{...good,watchdogHistory:[{...remote,endedAt:1050,lastReason:'Recovered'}]},1050);
  const view=m.view(1050);assert.equal(view.incidents.length,1);assert.equal(view.incidents[0].source,'watchdog');assert.equal(view.incidents[0].endedAt,1050);assert.equal(view.incidents[0].notifications[0].state,'delivered');
  await m.dispatch(1060);assert.equal(sends,0);m.db.close();
});

test('scheduler observes a real application outage and recovery while HTTP process stays running',async t=>{
  let healthy=false;
  const server=http.createServer((_req,res)=>{res.statusCode=healthy?200:503;res.end(healthy?'Healthy':'Unavailable');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const config=ChecksSchema.parse({checks:[{...check,url:`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,failureThreshold:1,notify:false}]});
  const m=new Monitor(config,':memory:',null);
  t.after(()=>{m.stop();server.closeAllConnections();server.close();m.db.close();});
  m.start();
  const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+14000;while(!predicate()){if(Date.now()>deadline)throw Error('Scheduler did not observe transition');await new Promise(r=>setTimeout(r,25));}};
  await until(()=>m.view().checks[0].state==='down');
  assert.equal(m.view().incidents.length,1);assert.equal(m.healthy(),true);
  healthy=true;
  await until(()=>m.view().checks[0].state==='up');
  assert.equal(m.view().incidents.length,1);assert.notEqual(m.view().incidents[0].endedAt,null);
});

test('delivery identities survive retry/restart and differ between independent databases',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'hostboard-identities-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const attempted:Message[]=[];let fail=true;
  const delivery={provider:'test',send:async(message:Message)=>{attempted.push(message);if(fail)throw Error('Controlled failure');}};
  const config=ChecksSchema.parse({checks:[{...check,failureThreshold:1}]});
  let m=new Monitor(config,path.join(dir,'one.sqlite'),delivery,1000);
  m.record(config.checks[0],bad,1000);await m.dispatch(1000);m.db.close();
  m=new Monitor(config,path.join(dir,'one.sqlite'),delivery,1040);fail=false;await m.dispatch(1040);m.db.close();
  m=new Monitor(config,path.join(dir,'two.sqlite'),delivery,1040);m.record(config.checks[0],bad,1040);await m.dispatch(1040);m.db.close();
  assert(attempted[0].messageKey);assert.equal(attempted[0].messageKey,attempted[1].messageKey);assert.notEqual(attempted[1].messageKey,attempted[2].messageKey);
});

test('navigation read models include old active incidents and last success without changing evaluation',()=>{
  const c=CheckSchema.parse({...check,failureThreshold:1});
  const m=new Monitor(ChecksSchema.parse({checks:[c]}),':memory:',null,1000);
  m.record(c,good,1000);m.record(c,bad,1010);
  for(let i=0;i<105;i++)m.db.prepare('INSERT INTO incidents(checkId,name,hostId,severity,startedAt,detectedAt,endedAt,reason,lastReason,resolution) VALUES(?,?,?,?,?,?,?,?,?,?)').run('old','Old','host','warning',1020+i,1020+i,1030+i,'Failure','Recovered','Reachability restored');
  const view=m.view(1200);
  assert.equal(view.incidents.length,100);assert.equal(view.incidents.some(i=>i.id===1),false);
  assert.equal(view.activeIncidents?.length,1);assert.equal(view.activeIncidents?.[0].id,1);
  assert.equal(view.checks[0].lastSuccessfulAt,1000);assert.equal(view.checks[0].state,'unknown');
  assert.equal(m.view(1200,2).incidents[0].id,1);m.db.close();
});

test('service grouping metadata preserves observations and active incident identities',t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'hostboard-group-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'monitor.sqlite');const c=CheckSchema.parse({...check,failureThreshold:1});
  let m=new Monitor(ChecksSchema.parse({checks:[c]}),file,null,1000);
  m.record(c,good,1000);m.record(c,bad,1010);m.db.close();
  m=new Monitor(ChecksSchema.parse({checks:[{...c,group:'Infrastructure'}]}),file,null,1020);
  assert.equal(m.view(1020).checks[0].group,'Infrastructure');
  assert.equal(m.view(1020).checks[0].lastSuccessfulAt,1000);
  assert.equal(m.view(1020).activeIncidents?.[0].id,1);m.db.close();
});
