import { test, expect } from '@playwright/test';
import { handlingFixture, sampleAlert } from '../issue-handling-fixture';

test('administrator can acknowledge, snooze, ignore and restore an issue without changing its source or history', async ({page, context}, info) => {
  const f = await handlingFixture();
  await context.setExtraHTTPHeaders({'Cf-Access-Jwt-Assertion': f.jwt});
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(f.origin+'/#issues');
    const manage = () => page.getByRole('button', {name: 'Manage issue: VPN subscription expired', exact: true});
    await expect(manage()).toBeVisible(); await manage().click();
    const dialog = page.getByRole('dialog', {name: 'Manage issue', exact: true});
    await expect(dialog).toBeVisible();
    const bounds = (await dialog.boundingBox())!, viewport = page.viewportSize()!;
    expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await expect(dialog.getByLabel('Handling reason')).toHaveCSS('border-style', 'solid');
    await page.screenshot({path: `.ai-local/${info.project.name}-issue-action-dialog.png`});
    await dialog.getByLabel('Handling reason').fill('Known current occurrence');
    await dialog.getByRole('button', {name: 'Save action', exact: true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('No active issues match these filters.')).toBeVisible();
    expect(f.history().active[0].state).toBe('WARNING');
    await page.getByRole('tab', {name: 'Handled', exact: true}).click();
    await expect(page.getByRole('region', {name: 'Handled issues'})).toContainText('Known current occurrence');
    await page.reload();
    await expect(page.getByRole('region', {name: 'Handled issues'})).toContainText('acknowledged');
    await page.getByRole('button', {name: 'Restore alert', exact: true}).click();
    await expect(page.getByText('No handled issues.')).toBeVisible();
    await page.getByRole('tab', {name: 'Active', exact: true}).click();
    await expect(manage()).toBeVisible();

    await manage().click(); await dialog.getByLabel('Issue action').selectOption('snoozed');
    await dialog.getByLabel('Snooze duration').selectOption('86400');
    await dialog.getByLabel('Handling reason').fill('VPN renewal planned tomorrow');
    await dialog.getByRole('button', {name: 'Save action', exact: true}).click();
    await expect(page.getByText('No active issues match these filters.')).toBeVisible();
    const rule = f.handling.view().rules[0]; expect(rule.until!).toBeGreaterThan(Date.now()/1000 + 86000);
    await page.getByRole('tab', {name: 'Handled', exact: true}).click();
    await expect(page.getByRole('region', {name: 'Handled issues'})).toContainText('snoozed until');
    await page.getByRole('button', {name: 'Restore alert', exact: true}).click();
    await page.getByRole('tab', {name: 'Active', exact: true}).click();

    await manage().click(); await dialog.getByLabel('Issue action').selectOption('ignored');
    await dialog.getByLabel('Handling reason').fill('VPN intentionally not renewed');
    await expect(dialog).toContainText('Netdata Cloud');
    await dialog.getByRole('button', {name: 'Save action', exact: true}).click();
    await expect(page.getByText('No active issues match these filters.')).toBeVisible();
    await page.goto(f.origin+'/#overview');
    await expect(page.getByRole('link', {name: '1 handled alert', exact: true})).toBeVisible();
    await page.getByRole('link', {name: '1 handled alert', exact: true}).click();
    await expect(page.getByRole('region', {name: 'Handled issues'})).toContainText('VPN intentionally not renewed');
    await page.screenshot({path: `.ai-local/${info.project.name}-handled-issues.png`, fullPage: true});
    f.setAlerts([sampleAlert({id: 'critical-occurrence', severity: 'critical', state: 'CRITICAL'})]);
    await page.goto(f.origin+'/#issues');
    await page.reload();
    await expect(manage()).toBeVisible();
    await expect(page.getByRole('region', {name: 'Issue results'})).toContainText('critical');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {await f.close();}
});
