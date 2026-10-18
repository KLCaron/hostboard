// Controlled Netdata-compatible service for CI and disposable Docker installs.
// Synthetic readings are test fixtures, never included in production configuration.
import http from "node:http";
export function fixtureAgent() {
  const rows: [string,string,Record<string,string>,Record<string,number>][] = [
    ['system.cpu','system.cpu',{}, {user:12,system:6,iowait:1,idle:81}],
    ['system.ram','system.ram',{}, {used:2048,free:2048,cached:4096,buffers:0}],
    ['system.uptime','system.uptime',{}, {uptime:86400}],
    ['system.load','system.load',{}, {load1:0.3,load5:0.5,load15:0.4}],
    ['system.net','system.net',{}, {received:800,sent:-400}],
    ['system.io','system.io',{}, {reads:128,writes:-64}],
    ['disk.root','disk.space',{mount_point:'/',filesystem:'ext4'},{used:60,avail:35,'reserved for root':5}],
    ['cpu.temp','system.hw.sensor.temperature.input',{driver:'coretemp',label:'package'},{input:45}],
    ['storage.temp','system.hw.sensor.temperature.input',{driver:'nvme',label:'drive'},{input:35}],
    ['docker.web','docker.container_state',{container_name:'example-web',image:'example/web:1'}, {running:1,exited:0}],
    ['docker.health','docker.container_health_status',{container_name:'example-web'},{healthy:1}],
    ['cgroup.cpu','cgroup.cpu',{cgroup_name:'example-web'},{user:4,system:2}],
    ['cgroup.mem','cgroup.mem_usage',{cgroup_name:'example-web'},{ram:64,swap:0}],
    ['cgroup.io','cgroup.io',{cgroup_name:'example-web'},{read:12,write:8}],
    ['cgroup.net','cgroup.net_net',{cgroup_name:'example-web'},{received:10,sent:-5}],
  ];
  const charts = Object.fromEntries(rows.map(([id,context,labels,dimensions])=>[id,{id,context,units:context.includes('cpu')?'percentage':'units',family:id,chart_labels:labels,dimensions:Object.fromEntries(Object.keys(dimensions).map(k=>[k,{name:k}]))}]));
  return http.createServer((req,res)=>{
    const url = new URL(req.url!,"http://fixture");
    const now = Math.floor(Date.now()/1000);
    const send = (body:unknown) => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
    if(url.pathname === '/health') return send({ok:true});
    if(url.pathname.endsWith('/nodes')) return send({nodes:[{mg:'fixture-guid',nd:'fixture-id',nm:'fixture-server',state:'reachable',v:'2.10',hw:{cpus:'4'},os:{nm:'Linux',v:'test'}}]});
    if(url.pathname.endsWith('/charts')) return send({hostname:'fixture-server',charts});
    if(url.pathname.endsWith('/contexts')) return send({contexts:Object.fromEntries(rows.map(([,context])=>[context,{}]))});
    if(url.pathname.endsWith('/alerts')) return send({alerts:[],nodes:[{mg:'fixture-guid',ni:0}],alert_instances:[]});
    if(url.pathname.endsWith('/alert_transitions')) return send({transitions:[]});
    if(!url.pathname.endsWith('/data')) {res.statusCode=404;return send({});}
    const selected = rows.filter(([id,context])=>context===url.searchParams.get('contexts') && (!url.searchParams.get('instances') || id===url.searchParams.get('instances')));
    const dimensions = selected.flatMap(([id,,,values])=>Object.keys(values).map(k=>`${k},${id}@fixture-guid`));
    const values = selected.flatMap(([,context,,values])=>Object.entries(values).map(([k,v])=> context==='system.cpu' && url.searchParams.get('time_group')==='max' && k==='idle'?90:context==='system.cpu'&&url.searchParams.get('time_group')==='min'&&k==='idle'?70:v));
    const requestedAfter=Number(url.searchParams.get('after') || -3600), requestedBefore=Number(url.searchParams.get('before') || now);
    const before = requestedBefore > 0 ? requestedBefore : now;
    const after = requestedAfter > 0 ? requestedAfter : before+requestedAfter;
    const count=60,step=(before-after)/count;
    send({summary:{nodes:[{mg:'fixture-guid'}]},result:{labels:['time',...dimensions],data:Array.from({length:count},(_,i)=>[before-i*step-1,...values.map((v,j)=>j===0?v*(1+Math.sin(i/6)*0.04):v)])},view:{dimensions:{ids:dimensions},update_every:Math.max(1,Math.round(step))},db:{first_entry:now-7*86400,last_entry:now}});
  });
}
if (process.argv[1]?.endsWith('fixture-agent.ts')) {
  fixtureAgent().listen(Number(process.env.FIXTURE_PORT || 19999),process.env.FIXTURE_BIND || '127.0.0.1',()=>console.log('Fixture Agent ready'));
}
