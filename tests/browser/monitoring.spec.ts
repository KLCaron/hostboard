import {test,expect} from '@playwright/test';

test('real configured service checks, trends, notification status and incident history',async({page,request},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const response=await request.get('/api/monitor');expect(response.ok()).toBe(true);
  const monitor=await response.json();
  expect(monitor.checks.length).toBeGreaterThan(0);
  expect(JSON.stringify(monitor)).not.toMatch(/smtp\.gmail\.com|password|172\.(18|21)\./);
  expect((await request.post('/api/monitor',{data:{url:'http://127.0.0.1:22'}})).status()).toBe(404);
  expect((await request.get('/api/monitor?before=oops')).status()).toBe(400);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Service availability',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Checks & incidents →'}).click();
  await expect(page.getByRole('heading',{name:'Application checks',exact:true})).toBeVisible();
  await expect(page.locator('.check-card')).toHaveCount(monitor.checks.length);
  await page.locator('.check-card>summary').first().click();
  await expect(page.locator('.check-card').first().getByText('Last 24 hours',{exact:true})).toBeVisible();
  await expect(page.locator('.check-card').first().getByText(/Insufficient coverage|observed time reachable/)).toBeVisible();
  await page.locator('.notification-settings>summary').click();
  await expect(page.getByText(/SMTP acceptance does not confirm inbox receipt/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Incident history',exact:true})).toBeVisible();
  if(monitor.incidents.length){
    await page.locator('.monitoring-view .incident-row>summary').first().click();
    await expect(page.locator('.monitoring-view .incident-row').first().getByText('Notifications',{exact:true})).toBeVisible();
  }else await expect(page.getByText('No confirmed incidents recorded.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`.ai-local/${info.project.name}-monitoring.png`,fullPage:true});
  expect(errors).toEqual([]);
});

test('monitor request failure marks cached availability unknown and recovers',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Incidents',exact:true}).click();
  await expect(page.locator('.check-card').first()).toBeVisible();
  await page.route('**/api/monitor',route=>route.abort());
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Monitoring updates unavailable');
  await expect(page.locator('.check-card .check-state').first()).toHaveText('Monitoring unavailable');
  await page.unroute('**/api/monitor');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByText('Monitoring updates unavailable. Previously observed states are unknown.')).not.toBeVisible();
});
