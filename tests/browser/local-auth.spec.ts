import {test,expect} from '@playwright/test';
import express from 'express';
import {hash} from 'argon2';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {localAuthentication} from '../../server/local-auth';
import {LocalSchema,authorization} from '../../server/admin';
test('local administrator signs in and out using native forms; unauthenticated and cross-origin writes fail',async({page,request})=>{
  const app=express(),server=app.listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const config=LocalSchema.parse({mode:'local',origin,username:'operator',passwordHash:await hash('correct test password',{memoryCost:65536,timeCost:3,parallelism:1}),sessionSecret:randomBytes(32).toString('hex'),targets:[]});
  const stop=localAuthentication(app,config);
  app.use('/api/admin',authorization(config).guard,express.json());
  app.post('/api/admin/save',(_req,res)=>res.json({saved:true}));
  app.get('/',(_req,res)=>res.type('html').send('<h1>Authenticated dashboard</h1><a href="/auth/logout">Sign out</a>'));
  try {
    expect((await request.post(origin+'/api/admin/save',{data:{}})).status()).toBe(401);
    await page.goto(origin);
    await expect(page.getByRole('heading',{name:'Administrator sign in'})).toBeVisible();
    await page.getByLabel('Username',{exact:true}).fill('operator');
    await page.getByLabel('Password',{exact:true}).fill('wrong password');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByText('Invalid username or password.')).toBeVisible();
    await page.getByRole('link',{name:'Try again'}).click();
    await page.getByLabel('Username',{exact:true}).fill('operator');
    await page.getByLabel('Password',{exact:true}).fill('correct test password');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Authenticated dashboard'})).toBeVisible();
    expect(await page.evaluate(async()=> (await fetch('/api/admin/save',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status)).toBe(403);
    expect(await page.evaluate(async()=> (await fetch('/api/admin/save',{method:'POST',headers:{'Content-Type':'application/json','X-Hostboard-Request':'1'},body:'{}'})).status)).toBe(200);
    await page.getByRole('link',{name:'Sign out'}).click();
    await page.getByRole('button',{name:'Sign out'}).click();
    await expect(page.getByRole('heading',{name:'Administrator sign in'})).toBeVisible();
    expect((await page.request.post(origin+'/api/admin/save',{data:{}})).status()).toBe(401);
  } finally {stop();server.closeAllConnections();server.close();}
});
