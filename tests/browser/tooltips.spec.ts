import { test, expect, type Locator, type Page } from '@playwright/test';
import { serviceGroup } from '../../src/issues';
import type { CheckView } from '../../src/monitor-types';

// Measure the rendered colors, including inherited label/value styles. Merely
// checking a class would miss Recharts' inline white and series-color defaults.
async function readableTooltip(tooltip: Locator, custom = false) {
  await expect(tooltip).toBeVisible();
  const colors = await tooltip.evaluate((el, custom) => {
    const style = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    const label = el.querySelector(custom ? 'b' : '.recharts-tooltip-label')!;
    const values = [...el.querySelectorAll(custom ? ':scope > span' : '.recharts-tooltip-item, .recharts-tooltip-item span')];
    return {
      background: style.backgroundColor, border: style.borderTopColor,
      borderWidth: style.borderTopWidth,
      label: getComputedStyle(label).color,
      values: values.map(value => getComputedStyle(value).color),
      tokens: ['background', 'border', 'label', 'foreground'].map(name => root.getPropertyValue(`--chart-tooltip-${name}`).trim()),
    };
  }, custom);
  const rgb = (color: string) => color.startsWith('#')
    ? color.slice(1).match(/../g)!.map(v => parseInt(v, 16))
    : color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const luminance = (color: string) => rgb(color).map(v => {
    const s = v / 255;
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a: string, b: string) => {
    const [lo, hi] = [luminance(a), luminance(b)].sort((a, b) => a - b);
    return (hi + .05) / (lo + .05);
  };
  expect(luminance(colors.background), 'tooltip background must be dark').toBeLessThan(.05);
  expect(rgb(colors.background)).toEqual(rgb(colors.tokens[0]));
  expect(rgb(colors.border)).toEqual(rgb(colors.tokens[1]));
  expect(colors.borderWidth).toBe('1px');
  expect(rgb(colors.label)).toEqual(rgb(colors.tokens[2]));
  expect(contrast(colors.label, colors.background)).toBeGreaterThanOrEqual(4.5);
  expect(colors.values.length).toBeGreaterThan(0);
  for (const color of colors.values) {
    expect(rgb(color)).toEqual(rgb(colors.tokens[3]));
    expect(contrast(color, colors.background)).toBeGreaterThanOrEqual(4.5);
  }
  const bounds = (await tooltip.boundingBox())!;
  const viewport = tooltip.page().viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
}

async function hoverPlot(page: Page, plot: Locator) {
  await plot.scrollIntoViewIfNeeded();
  const bounds = (await plot.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .4);
}

test('chart tooltips retain readable dark labels, values and borders with real history', async ({ page, request }, info) => {
  const monitor = await (await request.get('/api/monitor')).json();
  const check = monitor.checks.find((c: CheckView) => serviceGroup(c) === 'Infrastructure' && c.trend.some(p => p.responseMs !== null));
  expect(check, 'Infrastructure response history must contain real samples').toBeTruthy();
  await page.goto(`/#service=${check.id}`);
  const chart = page.locator(`#service-${check.id} .response-chart`);
  const point = chart.locator('.recharts-line-dots .recharts-dot').last();
  await expect(point).toBeVisible();
  // Exercise native hover on desktop and tap on the touch-enabled project.
  if (info.project.use.hasTouch) await point.tap();
  else await point.hover();
  const responseTip = chart.locator('.recharts-default-tooltip');
  await expect(responseTip).toContainText('Response time');
  await expect(responseTip.locator('.recharts-tooltip-item-value')).toHaveText(/^\d+ ms$/);
  await expect(responseTip.locator('.recharts-tooltip-label')).not.toBeEmpty();
  await readableTooltip(responseTip);
  await page.screenshot({ path: `.ai-local/v041-${info.project.name}-response-tooltip.png` });

  await page.goto('/#overview');
  const spark = page.locator('.spark').first();
  await expect(spark.locator('.recharts-area')).toBeVisible();
  await hoverPlot(page, spark);
  await readableTooltip(spark.locator('.chart-tip'), true);

  await page.getByRole('button', { name: 'Customize Overview' }).click();
  await page.getByLabel('Preferred metric 1', { exact: true }).check();
  await page.getByLabel('Preferred metric', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Save layout', exact: true }).click();
  const preferred = page.locator('.preferred-chart').first();
  await expect(preferred.locator('.recharts-line-curve')).toBeVisible();
  await hoverPlot(page, preferred);
  await readableTooltip(preferred.locator('.recharts-default-tooltip'));

  await page.locator('.host-card').first().getByRole('button', { name: 'Explore host' }).click();
  const explorer = page.locator('.host-card.expanded').getByRole('region', { name: 'Metric investigation' });
  await expect(explorer.getByText('Available retention:', { exact: false })).toBeVisible();
  await hoverPlot(page, explorer.locator('.selectable-chart'));
  const historyTip = explorer.locator('.recharts-default-tooltip');
  await expect(historyTip).toContainText('Average');
  await expect(historyTip).toContainText('Minimum');
  await expect(historyTip).toContainText('Peak');
  await readableTooltip(historyTip);
  await page.screenshot({ path: `.ai-local/v041-${info.project.name}-history-tooltip.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
