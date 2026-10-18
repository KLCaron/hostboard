import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CheckSchema, ChecksSchema } from '../../server/check-config';
import { Monitor } from '../../server/monitor';
import { probe } from '../../server/probe';

// Isolated HTTP outage/recovery fixture. Real production metric APIs remain untouched.
// Its notification provider deliberately fails; it never connects to Gmail or sends mail.
test('observed availability failure, failed delivery, recovery and bookmarked incident details',async({page,request})=>{
  let healthy=false;
  const server=http.createServer((_req,res)=>{res.statusCode=healthy?200:503;res.end(healthy?'Healthy':'Unavailable');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const fleet=await (await request.get('/api/fleet')).json();
  const check=CheckSchema.parse({id:'controlled-web',name:'Controlled HTTP test',hostId:fleet.hosts[0].id,type:'http',url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,failureThreshold:1});
  const monitor=new Monitor(ChecksSchema.parse({checks:[check]}),':memory:',{provider:'Controlled test',send:async()=>{throw Error('Controlled transport failure');}});
  try {
    monitor.record(check,await probe(check));await monitor.dispatch();
    const incident=monitor.view().incidents[0];expect(incident.endedAt).toBeNull();
    await page.route('**/api/monitor',route=>route.fulfill({json:monitor.view()}));
    await page.route('**/api/incidents/*',route=>route.fulfill({json:monitor.view().incidents.find(i=>i.id===incident.id)}));
    await page.goto('/#services');
    await page.locator('.check-card>summary').click();
    await expect(page.getByText('Unreachable',{exact:true})).toBeVisible();
    await page.getByRole('link',{name:' · Open incident →',exact:true}).click();
    await expect(page.getByRole('tab',{name:'Active',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(page.locator(`#incident-${incident.id}`)).toHaveJSProperty('open',true);
    await expect(page.locator('.issue-record[data-issue-type=availability]')).toHaveCount(1);
    await expect(page.locator('.issue-record[data-issue-type=notification]')).toHaveCount(0); // Direct link selects availability.
    await expect(page.locator('.incident-detail')).toContainText('SMTP delivery failed; retry scheduled');
    await page.getByRole('button',{name:'Reset filters',exact:true}).click();
    await expect(page.locator('.issue-record[data-issue-type=notification]')).toHaveCount(1);
    await page.getByLabel('Issue type',{exact:true}).selectOption('notification');
    await expect(page.locator('.issue-record[data-issue-type=availability]')).toHaveCount(0);
    await page.getByRole('link',{name:'Notification status →'}).click();
    await expect(page.getByText('Delivery needs attention',{exact:true})).toBeVisible();
    healthy=true;monitor.record(check,await probe(check));
    await page.goto(`/#incident=${incident.id}`);
    await expect(page.getByRole('tab',{name:'History',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(page.locator(`#incident-${incident.id}`)).toHaveJSProperty('open',true);
    await expect(page.getByText('Recovered',{exact:true})).toBeVisible();
    await expect(page.locator('.incident-detail')).toContainText('HTTP 200');
    await page.reload();
    await expect(page.locator(`#incident-${incident.id}`)).toHaveJSProperty('open',true);
    await page.getByRole('link',{name:'Service checks →'}).click();
    await expect(page.locator('#service-controlled-web')).toHaveJSProperty('open',true);
    await page.getByRole('link',{name:'Incident history →'}).click();
    await expect(page.getByLabel('Service',{exact:true})).toHaveValue(check.id);
    await expect(page.locator('.issue-record[data-issue-type=availability]')).toHaveCount(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  } finally {monitor.stop();monitor.db.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
