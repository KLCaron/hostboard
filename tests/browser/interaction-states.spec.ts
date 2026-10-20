// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "@playwright/test";
test("interactive resource rows expose hover, focus and expansion; diagnostics retain selection", async ({
  page,
}, info) => {
  await page.goto("/#services");
  const summary = page.locator(".services-panel>summary");
  await summary.click();
  const row = page.locator(".service-list>details").first(),
    target = row.locator("summary");
  await expect(target).toHaveCSS("cursor", "pointer");
  const initial = await target.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  if (!info.project.name.includes("mobile")) {
    await target.hover();
    await expect
      .poll(() => target.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(initial);
  }
  await page.getByLabel("Filter services", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  expect(
    await target.evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe("none");
  const closed = await target.evaluate(
    (el) => getComputedStyle(el, "::before").content,
  );
  await page.keyboard.press("Enter");
  await expect(row).toHaveJSProperty("open", true);
  expect(
    await target.evaluate((el) => getComputedStyle(el, "::before").content),
  ).not.toBe(closed);
  await expect
    .poll(() => target.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(initial);
  await expect(
    row.getByRole("link", { name: "View logs →", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `.ai-local/v061/${info.project.name}-resource-states.png`,
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Servers", exact: true })
    .click();
  const host = page.locator(".host-card").first();
  await host.getByRole("button", { name: "Explore host" }).click();
  await host.getByRole("tab", { name: "Diagnostics", exact: true }).click();
  const diagnostic = host.locator(".diagnostic-grid button").first();
  await diagnostic.click();
  await expect(diagnostic).toHaveAttribute("aria-pressed", "true");
  await expect(diagnostic).toHaveCSS("background-color", "rgb(45, 57, 42)");
  const selected = await diagnostic.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  const other = host.locator(".diagnostic-grid button").nth(1);
  await other.click();
  await expect(diagnostic).toHaveAttribute("aria-pressed", "false");
  await expect(other).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      diagnostic.evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .not.toBe(selected);
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Servers", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("chart and overview presets use visible controlled states, pending custom inputs survive background refresh", async ({
  page,
}) => {
  await page.goto("/");
  const overview = page.getByRole("group", { name: "Historical time range" }),
    six = overview.getByRole("button", { name: "6h", exact: true });
  const inactive = await six.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await six.click();
  await expect(six).toHaveAttribute("aria-pressed", "true");
  expect(
    await six.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe(inactive);
  await page.reload();
  await expect(six).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".host-card")
    .first()
    .getByRole("button", { name: "Explore host" })
    .click();
  const explorer = page
    .getByRole("region", { name: "Metric investigation" })
    .first();
  const preset = explorer.getByRole("button", { name: "1h", exact: true });
  await preset.click();
  await expect(preset).toHaveAttribute("aria-pressed", "true");
  await explorer.getByText("Custom time window", { exact: true }).click();
  await explorer.getByLabel("From", { exact: true }).fill("2026-10-17T12:00");
  await expect(
    explorer.getByRole("button", { name: "Custom", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(preset).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(explorer.getByLabel("From", { exact: true })).toHaveValue(
    "2026-10-17T12:00",
  );
  await explorer.getByLabel("To", { exact: true }).fill("2026-10-17T13:00");
  const requested = page.waitForRequest(
    (r) =>
      r.url().includes("/metric-history?") &&
      Number(new URL(r.url()).searchParams.get("before")) -
        Number(new URL(r.url()).searchParams.get("after")) ===
        3600,
  );
  await explorer
    .getByRole("button", { name: "Apply window", exact: true })
    .click();
  await requested;
  await expect(
    explorer.getByRole("button", { name: "Custom", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test('all seven sections share semantic navigation, discoverable resting actions and keyboard tabs', async ({page, context}, info) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  const nav = page.getByRole('navigation', {name:'Main navigation'});
  const services = page.getByRole('region', {name:'Monitoring health summary'}).getByRole('link', {name:'View services →',exact:true});
  await expect(services).toHaveAttribute('href','#services');
  await expect(services).toHaveCSS('border-top-style','solid');
  expect(await services.evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('.stat-card button, .stat-card a')).toHaveCount(0);
  const resting = await services.evaluate(e => getComputedStyle(e).backgroundColor);
  await page.screenshot({animations:"disabled",path:`.ai-local/v062/${info.project.name}-overview-rest.png`,fullPage:true});
  if (!info.project.name.includes('mobile')) {
    await services.hover();
    await expect.poll(() => services.evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe(resting);
    await page.screenshot({animations:"disabled",path:`.ai-local/v062/${info.project.name}-overview-hover.png`});
  }
  // Native anchors retain middle click/new tab behavior without changing this page.
  const popup = context.waitForEvent('page');
  await nav.getByRole('link',{name:'Services',exact:true}).click({button:'middle'});
  const tab = await popup;
  await expect(tab).toHaveURL(/#services$/);
  await expect(page).not.toHaveURL(/#services$/);
  await tab.close();
  await services.click();
  const card = page.locator('.check-card').first();
  const summary = card.locator('summary');
  await expect(summary).toHaveCSS('border-top-style','solid');
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(card).toHaveJSProperty('open',true);
  const link = card.getByRole('link',{name:'Incident history →',exact:true});
  await expect(link).toHaveCSS('text-decoration-line','underline');
  const linkRest = await link.evaluate(e => getComputedStyle(e).backgroundColor);
  if (!info.project.name.includes('mobile')) {
    await link.hover();
    await expect.poll(() => link.evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe(linkRest);
  }
  await link.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(link).toBeFocused();
  await expect(link).toHaveCSS('outline-style','solid');
  await page.screenshot({animations:"disabled",path:`.ai-local/v062/${info.project.name}-services-focus.png`,fullPage:true});
  await link.click();
  await expect(page).toHaveURL(/#issues\?tab=history&type=availability&service=/);
  await expect(page.getByRole('tab',{name:'History',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('tab',{name:'History',exact:true}).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab',{name:'Active',exact:true})).toBeFocused();
  await expect(page.getByRole('tab',{name:'Active',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(nav.getByRole('link',{name:'Issues',exact:true})).toHaveAttribute('aria-current','page');
  await page.screenshot({animations:"disabled",path:`.ai-local/v062/${info.project.name}-issues-selected.png`,fullPage:true});
  for (const name of ['Overview','Servers','Services','Updates','Logs','Issues','Settings']) {
    const target = nav.getByRole('link',{name,exact:true});
    await target.click();
    await expect(target).toHaveAttribute('aria-current','page');
    await expect(target).toHaveCSS('border-left-color','rgb(196, 233, 167)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({animations:"disabled",path:`.ai-local/v062/${info.project.name}-${name.toLowerCase()}-default.png`,fullPage:true});
  }
  const display = page.getByRole('tab',{name:'General',exact:true});
  await display.focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab',{name:'System Status',exact:true})).toBeFocused();
  await expect(page.getByRole('tab',{name:'System Status',exact:true})).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Home');
  await expect(display).toBeFocused();
  expect(errors).toEqual([]);
});

test('disclosures retain selection on hover and nested actions do not collapse parent rows', async ({page}, info) => {
  await page.goto('/#services');
  await page.locator('.services-panel>summary').click();
  const row = page.locator('.service-list>details').first();
  await row.locator('summary').click();
  await page.mouse.move(0,0);
  await expect(row.locator('summary')).toHaveCSS('background-color','rgb(45, 57, 42)');
  if (!info.project.name.includes('mobile')) {
    await row.locator('summary').hover();
    await expect(row.locator('summary')).toHaveCSS('background-color','rgb(45, 57, 42)');
  }
  await row.getByRole('button',{name:'Investigate resources →',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(row).toHaveJSProperty('open',true);
  const zoom = dialog.getByRole('button',{name:'Zoom to brushed selection',exact:true});
  await expect(zoom).toBeDisabled();
  await expect(zoom).toHaveCSS('cursor','not-allowed');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(row.getByRole('button',{name:'Investigate resources →',exact:true})).toBeFocused();
  await expect(row).toHaveJSProperty('open',true);
  await page.screenshot({animations:"disabled",path:`.ai-local/v062/${info.project.name}-container-expanded.png`,fullPage:true});
});

test('busy refresh is disabled and native info dialog contains focus and returns it', async ({page}, info) => {
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  let requests = 0;
  await page.route('**/api/fleet', async route => { requests++; await gate; await route.continue(); });
  const refresh = page.getByRole('button',{name:'Refresh',exact:true});
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute('aria-busy','true');
  await expect(refresh).toHaveCSS('cursor','progress');
  await refresh.evaluate((e: HTMLButtonElement) => e.click());
  expect(requests).toBe(1);
  release();
  await expect(refresh).toBeEnabled();
  // The compact bottom navigation intentionally omits Dashboard info on mobile.
  if (!info.project.name.includes('mobile')) {
    const trigger = page.getByRole('button',{name:'Dashboard info',exact:true});
    await trigger.click();
    const dialog = page.getByRole('dialog',{name:'Dashboard info',exact:true});
    await expect(dialog).toBeVisible();
    for(let n=0;n<4;n++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(e => e.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
});
