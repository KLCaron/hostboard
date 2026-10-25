import { test, expect } from '@playwright/test';
import type { AlertDetail } from '../../src/investigation-types';

test('host alert counts open only that server’s active metric alerts from overview and servers', async ({ page, request }) => {
  const fleet = await (await request.get('/api/fleet')).json();
  const host = fleet.hosts[0], otherId = 'server-other';
  const history = await (await request.get(`/api/hosts/${host.id}/history?range=1h`)).json();
  const alert = (id: string, summary: string): AlertDetail => ({
    id, name: id, summary, info: 'Controlled alert for navigation verification',
    state: 'WARNING', severity: 'warning', resource: 'CPU', chart: 'system.cpu',
    context: 'system.cpu', startedAt: Date.now() / 1000 - 60,
    endedAt: null, duration: null, value: 90, units: '%', config: null,
    warning: '$this > 80', critical: '$this > 95', resolved: false,
  });
  const active = [alert('cpu-high', 'Selected server CPU warning'), alert('load-high', 'Selected server load warning')];
  const other = alert('other-warning', 'Other server warning');
  await page.route('**/api/fleet', route => route.fulfill({json: {
    ...fleet, hosts: [
      {...host, alerts: [{name: 'warnings', summary: 'Warnings', severity: 'warning', count: 2}]},
      {...host, id: otherId, name: 'Other server', alerts: [{name: 'warning', summary: 'Warning', severity: 'warning', count: 1}]},
    ],
  }}));
  await page.route('**/api/hosts/*/alerts', route => route.fulfill({json: {
    active: new URL(route.request().url()).pathname.includes(`/${host.id}/`) ? active : [other],
    resolved: [], errors: [], fetchedAt: new Date().toISOString(),
  }}));
  await page.route(`**/api/hosts/${otherId}/history?**`, route => route.fulfill({json: history}));
  for (const entry of ['overview', 'servers']) {
    await page.goto(`/#${entry}`);
    const card = page.locator(`#host-${host.id}`);
    const link = card.getByRole('link', {name: `View 2 alerts for ${host.name}`, exact: true});
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `#issues?type=metric&host=${encodeURIComponent(host.id)}`);
    await expect(card.getByRole('button', {name: host.name, exact: false}).first()).toHaveAttribute('aria-expanded', 'false');
    if (entry === 'overview') {
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
    } else await link.click();
    await expect(page).toHaveURL(new RegExp(`#issues\\?type=metric&host=${host.id}$`));
    await expect(page.getByLabel('Issue type', {exact: true})).toHaveValue('metric');
    await expect(page.getByLabel('Host', {exact: true})).toHaveValue(host.id);
    await expect(page.getByRole('tab', {name: 'Active', exact: true})).toHaveAttribute('aria-selected', 'true');
    const results = page.getByRole('region', {name: 'Issue results'});
    await expect(results.getByRole('button')).toHaveCount(2);
    await expect(results.getByText(other.summary, {exact: true})).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('Host', {exact: true})).toHaveValue(host.id);
    await expect(results.getByRole('button')).toHaveCount(2);
    await results.getByRole('button').filter({hasText: active[0].summary}).click();
    await expect(page.getByRole('dialog').getByRole('heading', {name: active[0].summary})).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Warning rule:', {exact: false})).toBeVisible();
    await page.getByRole('button', {name: 'Close investigation'}).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
