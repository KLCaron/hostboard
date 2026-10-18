import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import {firefox,expect} from '@playwright/test';
const dir=mkdtempSync(path.join(tmpdir(),'hostboard-published-ui-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await new Promise<void>(resolve=>socket.once('listening',resolve));
const port=(socket.address() as net.AddressInfo).port;
await new Promise<void>(resolve=>socket.close(()=>resolve()));
const project='hb-ui-'+randomBytes(4).toString('hex'),origin=`http://localhost:${port}`,password=randomBytes(24).toString('hex');
const image=process.env.HOSTBOARD_TEST_IMAGE || 'hostboard:ci';
const command=(process.env.DOCKER || 'docker').split(/\s+/);
const output='test-results/image-browser';mkdirSync(output,{recursive:true});
const docker=(args:string[])=>{const r=spawnSync(command[0],[...command.slice(1),...args],{cwd:dir,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout;};
const compose=(args:string[])=>docker(['compose','--project-name',project,'-f','compose.yaml','-f','fixture.yaml',...args]);
let browser:Awaited<ReturnType<typeof firefox.launch>>|undefined;
try {
 writeFileSync(path.join(dir,'compose.yaml'),readFileSync('compose.yaml'));
 writeFileSync(path.join(dir,'fixture.yaml'),`services:\n  hostboard:\n    image: ${JSON.stringify(image)}\n  fixture:\n    image: node:24-alpine\n    user: "1000:1000"\n    command: [node, /fixtures/fixture-agent.ts]\n    environment:\n      FIXTURE_BIND: 0.0.0.0\n    volumes:\n      - ${path.resolve('tests')}:/fixtures:ro\n    read_only: true\n`);
 writeFileSync(path.join(dir,'answers.json'),JSON.stringify({origin,port,username:'operator',password,hosts:[{id:'server-a',name:'Example server',node:'fixture-server',url:'http://fixture:19999'}]}),{mode:0o600});
 docker(['run','--rm','--user',`${process.getuid!()}:${process.getgid!()}`,'--volume',`${dir}:/setup`,'--entrypoint','node',image,'dist/server/server/setup.js','--directory','/setup','--answers','/setup/answers.json']);
 rmSync(path.join(dir,'answers.json'));
 compose(['up','-d','--wait','--wait-timeout','90']);
 browser=await firefox.launch({headless:true});
 for (const [name,viewport]of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]as const) {
  const context=await browser.newContext({viewport,hasTouch:name==='mobile'}),page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  await expect(page.getByRole('heading',{name:'Administrator sign in'})).toBeVisible();
  await page.getByLabel('Username',{exact:true}).fill('operator');
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Fleet overview'})).toBeVisible();
  await expect(page.locator('.host-card').first().getByText('Online',{exact:true})).toBeVisible({timeout:15000});
  await page.screenshot({path:`${output}/${name}.png`,fullPage:true});
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('link',{name:'Sign out',exact:true})).toBeVisible();
  expect((await page.request.get(origin+'/api/admin/config')).status()).toBe(200);
  expect(await page.evaluate(async()=>{
    const config=await (await fetch('/api/admin/config')).json();
    config.settings.general.temperature='F';
    return (await fetch('/api/admin/settings',{method:'PUT',headers:{'Content-Type':'application/json','X-Hostboard-Request':'1'},body:JSON.stringify({revision:config.revision,settings:config.settings})})).status;
  })).toBe(200);
  await page.getByRole('link',{name:'Sign out',exact:true}).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Administrator sign in'})).toBeVisible();
  expect((await page.request.get(origin+'/api/admin/config')).status()).toBe(401);
  expect(errors).toEqual([]);await context.close();
 }
 console.log('PASS: container image Firefox desktop/mobile sign-in, real dashboard/Agent, Settings administrator access/writes, sign-out, and unauthenticated denial.');
} finally {
 if(browser)await browser.close();
 try{compose(['down','--volumes','--remove-orphans']);}finally{rmSync(dir,{recursive:true,force:true});}
}
