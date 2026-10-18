import {test,expect} from '@playwright/test';
import { serviceGroup, activeIssueCount } from '../../src/issues';

test('six sections, real checks and groupings, expanded trends, settings and compact overview',async({page,request},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const response=await request.get('/api/monitor');expect(response.ok()).toBe(true);
  const monitor=await response.json();
  const fleet=await (await request.get('/api/fleet')).json();
  expect(monitor.checks.length).toBeGreaterThan(0);
  expect(JSON.stringify(monitor)).not.toMatch(/smtp\.gmail\.com|password|172\.(18|21)\./);
  expect((await request.post('/api/monitor',{data:{url:'http://127.0.0.1:22'}})).status()).toBe(404);
  expect((await request.get('/api/monitor?before=oops')).status()).toBe(400);
  await page.goto('/');
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  await expect(nav.getByRole('link')).toHaveCount(6);
  for(const name of ['Overview','Servers','Services','Logs','Issues','Settings']) await expect(nav.getByRole('link',{name,exact:true})).toBeInViewport();
  await expect(page.getByRole('region',{name:'Monitoring health summary'})).toContainText(`${monitor.checks.filter((c:any)=>c.state==='up').length}/${monitor.checks.length} services healthy`);
  await expect(page.getByRole('region',{name:'Monitoring health summary'})).toContainText(`${activeIssueCount(fleet.hosts,monitor)} active issue`);
  await expect(page.locator('.check-card')).toHaveCount(0);
  await page.screenshot({path:`.ai-local/v031-${info.project.name}-overview.png`,fullPage:true});
  await nav.getByRole('link',{name:'Servers',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Servers',exact:true}).first()).toBeVisible();
  await nav.getByRole('link',{name:'Services',exact:true}).click();
  await expect(page.locator('.check-card')).toHaveCount(monitor.checks.length);
  for(const group of ['Applications','Infrastructure']) {
    const region=page.getByRole('region',{name:group,exact:true});
    const checks=monitor.checks.filter((c:any)=>serviceGroup(c)===group);
    await expect(region.locator('.check-card')).toHaveCount(checks.length);
    for(const c of checks) await expect(region.getByText(c.name,{exact:true})).toBeVisible();
  }
  const card=page.locator('.check-card').first();
  await card.locator('summary').click();
  await expect(card.getByText('Last 24 hours',{exact:true})).toBeVisible();
  await expect(card.getByText('Last successful check',{exact:true})).toBeVisible();
  await expect(card.getByText(/Insufficient coverage|observed time reachable/)).toBeVisible();
  await expect(card.locator('.response-chart svg').first()).toBeVisible();
  await page.screenshot({path:`.ai-local/v031-${info.project.name}-services.png`,fullPage:true});
  await nav.getByRole('link',{name:'Settings',exact:true}).click();
  await page.getByRole('tab',{name:'Notifications',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Notification delivery',exact:true})).toBeVisible();
  await expect(page.getByText(/SMTP acceptance does not confirm inbox receipt/)).toBeVisible();
  await expect(page.getByText(monitor.notifications.configured?'SMTP configured':'Not configured',{exact:true})).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.locator('.check-card')).toHaveCount(0);
  await page.screenshot({path:`.ai-local/v031-${info.project.name}-settings.png`,fullPage:true});
  await nav.getByRole('link',{name:'Issues',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Active',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('heading',{name:'Active issues',exact:true})).toBeVisible();
  const count=activeIssueCount(fleet.hosts,monitor);
  if(count) await expect(nav.getByLabel(`${count} active issues`,{exact:true})).toBeVisible();
  else await expect(nav.locator('.alert-count')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`.ai-local/v031-${info.project.name}-issues.png`,fullPage:true});
  expect(errors).toEqual([]);
});

test('real issue filtering and legacy bookmarks retain destination and browser history',async({page,request})=>{
  const fleet=await (await request.get('/api/fleet')).json();
  const monitor=await (await request.get('/api/monitor')).json();
  await page.goto('/#alerts');
  await expect(page.getByRole('heading',{name:'Issues',exact:true})).toBeVisible();
  await expect(page.getByLabel('Issue type',{exact:true})).toHaveValue('metric');
  await expect(page).toHaveURL(/#issues\?type=metric$/);
  await page.getByLabel('Severity',{exact:true}).selectOption('critical');
  await page.getByLabel('Host',{exact:true}).selectOption(fleet.hosts[0].id);
  await page.getByLabel('Status',{exact:true}).selectOption('active');
  await expect(page.locator('.issue-record[data-issue-type=availability]')).toHaveCount(0);
  await page.getByRole('tab',{name:'History',exact:true}).click();
  await page.getByLabel('Status',{exact:true}).selectOption('resolved');
  await page.reload();
  await expect(page.getByRole('tab',{name:'History',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByLabel('Severity',{exact:true})).toHaveValue('critical');
  await expect(page.getByLabel('Status',{exact:true})).toHaveValue('resolved');
  await page.goto('/#incidents');
  await expect(page.getByRole('tab',{name:'History',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByLabel('Issue type',{exact:true})).toHaveValue('availability');
  await page.getByLabel('Service',{exact:true}).selectOption(monitor.checks[0].id);
  await expect(page.locator('.issue-record[data-issue-type=metric]')).toHaveCount(0);
  await page.goto('/#service='+monitor.checks[0].id);
  await expect(page.locator(`#service-${monitor.checks[0].id}`)).toHaveJSProperty('open',true);
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await page.goBack();
  await expect(page.locator(`#service-${monitor.checks[0].id}`)).toHaveJSProperty('open',true);
  for(const [url,type] of [['/alerts','metric'],['/incidents','availability']]) {
    await page.goto(url);
    await expect(page.getByRole('heading',{name:'Issues',exact:true})).toBeVisible();
    await expect(page.getByLabel('Issue type',{exact:true})).toHaveValue(type);
  }
});

test('monitor request failure marks cached availability unknown and recovers',async({page})=>{
  await page.goto('/#services');
  await expect(page.locator('.check-card').first()).toBeVisible();
  await page.route('**/api/monitor',route=>route.abort());
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Monitoring updates unavailable');
  await expect(page.locator('.check-card .check-state').first()).toHaveText('Monitoring unavailable');
  await page.unroute('**/api/monitor');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByText('Monitoring updates unavailable. Previously observed states are unknown.')).not.toBeVisible();
});
