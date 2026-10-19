import { test, expect } from "@playwright/test";
import { serverFixture } from "../server-fixture";

test("administrator adds a discovered child, groups, renames, disables, restores and archives without losing layout or identity", async ({
  browser,
}, info) => {
  const f = await serverFixture();
  const context = await browser.newContext({
    viewport: info.project.use.viewport,
    hasTouch: info.project.name.includes("mobile"),
    extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": f.jwt },
  });
  const page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(f.origin + "/#settings?tab=servers");
    await expect(
      page.getByRole("heading", { name: "Servers", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add server", exact: true }).click();
    await page
      .getByLabel("Server name", { exact: true })
      .fill("Discovered machine");
    await page.getByLabel("Netdata Agent address", { exact: true }).fill(f.url);
    await expect(
      page.getByRole("button", { name: "Save server", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("several nodes");
    await page
      .getByLabel("Netdata node", { exact: true })
      .selectOption("child-machine-guid");
    f.resetLimit();
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "fixture-child", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".server-discovery")).toContainText(
      "Example child CPU",
    );
    await expect(page.locator(".server-discovery")).toContainText("22.8 GiB");
    await page
      .getByRole("button", { name: "Save server", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Server saved");
    const id = f.registry.ids()[0];
    await page.getByText("Manage server groups", { exact: true }).click();
    await page.getByLabel("Group name", { exact: true }).fill("Production");
    await page
      .getByRole("button", { name: "Create group", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Server group saved");
    const row = page
      .locator(".settings-service-list > div")
      .filter({ hasText: "Discovered machine" });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await page
      .getByLabel("Server name", { exact: true })
      .fill("Renamed machine");
    await page
      .getByLabel("Server group", { exact: true })
      .selectOption({ label: "Production" });
    await page
      .getByRole("button", { name: "Save server", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Server saved");
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await page
      .getByLabel("Filter by server group", { exact: true })
      .selectOption({ label: "Production" });
    await expect(
      page.getByText(
        "Production: 1 of 1 servers. Summaries cover this group only.",
      ),
    ).toBeVisible();
    await expect(page.locator(`[data-widget="host-${id}"]`)).toBeVisible();
    await page
      .getByRole("button", { name: "Customize Overview", exact: true })
      .click();
    await page
      .getByLabel("Width of Renamed machine", { exact: true })
      .selectOption("full");
    await page
      .getByRole("button", { name: "Save layout", exact: true })
      .click();
    await page
      .getByLabel("Filter by server group", { exact: true })
      .selectOption("ungrouped");
    await expect(page.locator(`[data-widget="host-${id}"]`)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Show entire fleet", exact: true })
      .click();
    await expect(page.locator(`[data-widget="host-${id}"]`)).toHaveAttribute(
      "data-width",
      "full",
    );
    await page.reload();
    await expect(page.locator(`[data-widget="host-${id}"]`)).toHaveAttribute(
      "data-width",
      "full",
    );
    await page.getByRole("link", { name: "Servers", exact: true }).click();
    await page
      .getByRole("button", { name: "Explore host", exact: true })
      .click();
    await page
      .getByRole("tab", { name: "Host information", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Host information", exact: true }),
    ).toContainText(
      "Unconfigured; Agent registration does not grant log access",
    );
    await page.screenshot({
      path: `.ai-local/v070/${info.project.name}-host-details.png`,
      fullPage: true,
    });
    await page
      .getByRole("link", {
        name: "Manage server / Test connection",
        exact: true,
      })
      .click();
    let renamedRow = page
      .locator(".settings-service-list > div")
      .filter({ hasText: "Renamed machine" });
    await renamedRow.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Monitoring enabled", { exact: true }).uncheck();
    await page
      .getByRole("button", { name: "Save server", exact: true })
      .click();
    await expect(renamedRow).toContainText("Monitoring disabled");
    await renamedRow.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Monitoring enabled", { exact: true }).check();
    await page
      .getByRole("button", { name: "Save server", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Server saved");
    await renamedRow.getByRole("button", { name: "Edit", exact: true }).click();
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: "Archive server", exact: true })
      .click();
    await expect(renamedRow).toContainText("Archived");
    await page.reload();
    await expect(renamedRow).toContainText("Archived");
    await renamedRow
      .getByRole("button", { name: "Restore / edit", exact: true })
      .click();
    await page.getByLabel("Monitoring enabled", { exact: true }).check();
    await page
      .getByRole("button", { name: "Restore server", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Server saved");
    expect(f.registry.records()[0].id).toBe(id);
    expect(f.registry.records()[0].guid).toBe("child-machine-guid");
    await page.screenshot({
      path: `.ai-local/v070/${info.project.name}-server-settings.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    f.close();
  }
});

test("server onboarding shows destination errors, protects unsaved forms and supports keyboard tabs", async ({
  browser,
}, info) => {
  const f = await serverFixture();
  const context = await browser.newContext({
    viewport: info.project.use.viewport,
    extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": f.jwt },
  });
  const page = await context.newPage();
  try {
    await page.goto(f.origin + "/#settings");
    const general = page.getByRole("tab", { name: "General", exact: true });
    await general.focus();
    await general.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "Servers", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Add server", exact: true }).click();
    await page
      .getByLabel("Server name", { exact: true })
      .fill("Blocked machine");
    await page
      .getByLabel("Netdata Agent address", { exact: true })
      .fill("http://169.254.169.254:19999");
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Destination blocked");
    await expect(
      page.getByRole("button", { name: "Save server", exact: true }),
    ).toBeDisabled();
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("link", { name: "Servers", exact: true }).click();
    await expect(page.getByLabel("Server name", { exact: true })).toHaveValue(
      "Blocked machine",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Add server", exact: true }),
    ).toBeVisible();
    expect(f.registry.ids()).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close();
    f.close();
  }
});
