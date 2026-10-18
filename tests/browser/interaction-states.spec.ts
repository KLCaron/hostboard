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
    .getByRole("button", { name: "Servers", exact: true })
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
      .getByRole("button", { name: "Servers", exact: true }),
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
