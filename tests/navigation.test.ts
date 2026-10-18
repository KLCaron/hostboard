import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNavigation, pages } from '../src/navigation.js';
import { activeIssueCount, availabilityIssues, defaultFilters, filterIssues, serviceGroup, type Issue } from '../src/issues.js';
import type { Host } from '../src/types.js';
import type { IncidentView, MonitorView } from '../src/monitor-types.js';

test('all sections and bookmarked legacy routes resolve to the intended destination',()=>{
  for(const page of pages){assert.equal(resolveNavigation('#'+page).page,page);assert.equal(resolveNavigation('', '/'+page).page,page);}
  assert.deepEqual(resolveNavigation('#host=server-a'),{page:'servers',host:'server-a'});
  assert.deepEqual(resolveNavigation('#service=foundry-core'),{page:'services',service:'foundry-core'});
  assert.deepEqual(resolveNavigation('#incident=123'),{page:'issues',incident:123});
  assert.equal(resolveNavigation('', '/alerts').canonical,'#issues?type=metric');
  assert.equal(resolveNavigation('#incidents').canonical,'#issues?tab=history&type=availability');
  assert.equal(resolveNavigation('#alert=host:instance').page,'issues');
  assert.equal(resolveNavigation('#service=%broken').page,'services');
});
test('service grouping accommodates applications and infrastructure with explicit overrides',()=>{
  for(const name of ['Jellyfin','Filebrowser','Foundry core','New web app'])assert.equal(serviceGroup({id:'app',name,type:'http'}),'Applications');
  for(const name of ['Hostboard','Independent watchdog','server-b Netdata metrics','SSH listener'])assert.equal(serviceGroup({id:'infra',name,type:'http'}),'Infrastructure');
  assert.equal(serviceGroup({id:'tcp',name:'Connection',type:'tcp'}),'Infrastructure');
  assert.equal(serviceGroup({id:'app',name:'Custom',type:'http',group:'Infrastructure'}),'Infrastructure');
});
test('issue filters separate active/history, source, severity, host, service and retired records',()=>{
  const issues:Issue[]=[{id:'1',name:'Warning',type:'metric',severity:'warning',hostId:'one',status:'active',time:1},{id:'2',name:'Outage',type:'availability',severity:'critical',hostId:'one',serviceId:'web',status:'active',time:2},{id:'3',name:'Recovered',type:'availability',severity:'critical',hostId:'two',serviceId:'web',status:'resolved',time:3},{id:'4',name:'Retired',type:'availability',severity:'warning',hostId:'two',status:'retired',time:4}];
  const select=(patch={})=>filterIssues(issues,{...defaultFilters,...patch}).map(i=>i.id);
  assert.deepEqual(select(),['2','1']);assert.deepEqual(select({type:'metric'}),['1']);
  assert.deepEqual(select({severity:'critical',host:'one',service:'web'}),['2']);
  assert.deepEqual(select({tab:'history'}),['4','3']);assert.deepEqual(select({tab:'history',status:'resolved'}),['3']);
  assert.deepEqual(select({host:'two'}),[]);
});
test('active counts deduplicate known incident identities and retain uncorrelated metric warnings',()=>{
  const incident={id:1,checkId:'web',name:'Web',hostId:'one',severity:'critical',endedAt:null} as IncidentView;
  const data={incidents:[incident,incident,{...incident,id:2,endedAt:100}],activeIncidents:[incident,incident],notifications:{failed:2}} as MonitorView;
  const hosts=[{alerts:[{count:3}]}] as Host[];
  assert.equal(availabilityIssues(data.incidents).length,2);
  assert.equal(activeIssueCount(hosts,data),5); // Three metric instances, one outage, one delivery issue.
  assert.equal(activeIssueCount([],undefined),0);
});
