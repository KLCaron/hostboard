#!/usr/bin/env node
import assert from 'node:assert/strict';
const base=process.argv[2]||'http://127.0.0.1:8088';
const fetchApi=async path=>{const r=await fetch(new URL(path,base),{signal:AbortSignal.timeout(20_000)});assert.equal(r.status,200,`${path}: expected HTTP 200`);return r.json();};
assert.equal((await fetchApi('/api/health')).status,'ok');
const fleet=await fetchApi('/api/fleet');assert.ok(fleet.hosts.length>0);
for(const h of fleet.hosts){
 assert.equal(h.status,'online',`${h.name} is not online`);
 assert.ok(typeof h.cpu==='number'&&h.cpu>=0&&h.cpu<=100.1,`${h.name}: CPU`);
 assert.ok(h.memory.total>0&&h.memory.used>=0&&h.memory.used<=h.memory.total,`${h.name}: RAM`);
 assert.ok(h.disks.some(d=>d.total>0&&d.used>=0),`${h.name}: storage`);
 assert.ok(h.network.received>=0&&h.network.sent>=0,`${h.name}: network`);
 assert.ok(h.io.read>=0&&h.io.write>=0,`${h.name}: disk I/O`);
 assert.equal(h.warnings.length,0,`${h.name}: partial integration`);
 for(const range of ['15m','1h','6h','24h']){
  const history=await fetchApi(`/api/hosts/${encodeURIComponent(h.id)}/history?range=${range}`);
  assert.deepEqual(history.errors,[],`${h.name}/${range}: historical query errors`);
  assert.ok(history.points.length>0);
  for(const metric of ['cpu','memory','received','sent','read','write','load'])assert.ok(history.points.some(p=>p[metric]!==null),`${h.name}/${range}: no ${metric} samples`);
 }
 console.log(`${h.name}: online; live metrics and all four historical ranges verified; ${h.containers.length} containers, ${h.sensors.length} sensors, ${h.alerts?.length??'unknown'} active alert types`);
}
for(const [path,status] of [['/api/hosts/unknown/history',404],['/api/hosts/'+fleet.hosts[0].id+'/history?range=invalid',400],['/api/fetch?url=http://example.com',404]])assert.equal((await fetch(new URL(path,base))).status,status);
const root=await fetch(base);assert.equal(root.status,200);assert.ok(root.headers.get('content-security-policy')?.includes("connect-src 'self'"));
const html=await root.text();assert.ok(html.includes('Hostboard'));const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m=>m[1]);assert.ok(assets.length>0);
for(const asset of assets)assert.equal((await fetch(new URL(asset,base))).status,200);
console.log('HTTP page/assets, security headers, range validation and proxy isolation verified.');
