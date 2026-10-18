import { test, expect, type APIRequestContext } from "@playwright/test";
import express from "express";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { Configuration } from "../../server/settings";
import { Monitor } from "../../server/monitor";
import { ChecksSchema } from "../../server/check-config";
import { authorization, type AdminConfig } from "../../server/admin";
import { configAPI, synchronize } from "../../server/config-api";
async function fixture(request: APIRequestContext) {
  const fleet = await (await request.get("/api/fleet")).json(),
    app = express(),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "hostboard-browser-"));
  const store = new Configuration(
    path.join(dir, "monitor.sqlite"),
    ChecksSchema.parse({
      checks: [
        {
          id: "fixture",
          hostId: fleet.hosts[0].id,
          name: "Isolated existing check",
          type: "http",
          url: `${origin}/controlled`,
          notify: false,
        },
      ],
    }),
  );
  let sends = 0;
  const monitor = new Monitor(store.runtime(), store.db, {
    provider: "Isolated SMTP fixture",
    send: async () => {
      sends++;
    },
  });
  synchronize(store, monitor);
  const { privateKey, publicKey } = await generateKeyPair("RS256"),
    key = await exportJWK(publicKey);
  key.kid = "fixture";
  const admin: AdminConfig = {
    issuer: "https://fixture.cloudflareaccess.com",
    audience: "fixture",
    emails: ["admin@example.com"],
    origin,
    targets: [
      {
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        addresses: ["127.0.0.1"],
      },
    ],
  };
  const jwt = await new SignJWT({ email: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(admin.issuer)
    .setAudience(admin.audience)
    .setSubject("admin")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  app.use(
    "/api",
    configAPI(
      store,
      monitor,
      admin,
      fleet.hosts.map((h: any) => h.id),
      authorization(admin, createLocalJWKSet({ keys: [key] })),
    ),
  );
  app.get("/api/monitor", (_req, res) => res.json(monitor.view()));
  app.get("/controlled", (_req, res) => res.send("OK"));
  const upstream = process.env.HOSTBOARD_TEST_URL || "http://127.0.0.1:3001";
  app.use("/api", async (req, res) => {
    if (req.method !== "GET") {
      res.status(405).end();
      return;
    }
    try {
      const r = await fetch(upstream + req.originalUrl);
      res
        .status(r.status)
        .type("application/json")
        .send(await r.text());
    } catch {
      res.status(502).end();
    }
  });
  app.use(express.static(path.resolve("dist/client")));
  app.get(/.*/, (_req, res) =>
    res.sendFile(path.resolve("dist/client/index.html")),
  );
  monitor.start();
  return {
    origin,
    jwt,
    store,
    monitor,
    get sends() {
      return sends;
    },
    close: () => {
      monitor.stop();
      server.closeAllConnections();
      server.close();
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("personal preferences save, cancel, defaults and landing page persist on this browser", async ({
  page,
  request,
}) => {
  const defaults = await (await request.get("/api/preferences")).json();
  let releaseDefaults!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseDefaults = resolve;
  });
  let delayed = false;
  await page.route("**/api/preferences", async (route) => {
    if (delayed) {
      await route.continue();
      return;
    }
    delayed = true;
    await gate;
    await route.fulfill({
      json: { general: { ...defaults.general, refreshSeconds: 29 } },
    });
  });
  await page.goto("/#settings");
  await page.getByLabel("Temperature units", { exact: true }).selectOption("F");
  await page
    .getByLabel("Dashboard refresh (seconds)", { exact: true })
    .fill("30");
  await page
    .getByLabel("Default landing page", { exact: true })
    .selectOption("services");
  // Loading application defaults must not replace an in-progress personal draft.
  const loaded = page.waitForResponse("**/api/preferences");
  releaseDefaults();
  await loaded;
  await expect(page.locator("footer")).toContainText("Refreshes every 29s");
  await expect(page.getByLabel("Temperature units")).toHaveValue("F");
  await expect(page.getByLabel("Dashboard refresh (seconds)")).toHaveValue(
    "30",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Personal preferences saved",
  );
  await page.reload();
  await expect(page.getByLabel("Temperature units")).toHaveValue("F");
  await expect(page.getByLabel("Dashboard refresh (seconds)")).toHaveValue(
    "30",
  );
  await page.getByLabel("Temperature units").selectOption("C");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Temperature units")).toHaveValue("F");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Services", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Restore defaults", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Temperature units")).toHaveValue("C");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("signed admin uses real configuration forms: add, test, disable, archive, restore, notification test and global settings", async ({
  browser,
  request,
}, info) => {
  const f = await fixture(request),
    context = await browser.newContext({
      viewport: info.project.use.viewport,
      extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": f.jwt },
    }),
    page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(f.origin + "/#settings");
    await page.getByLabel("Settings scope").selectOption("global");
    await page.getByLabel("Dashboard refresh (seconds)").fill("25");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Application defaults saved",
    );
    expect(f.store.settings().general.refreshSeconds).toBe(25);
    await page.getByRole("tab", { name: "Services", exact: true }).click();
    await page.getByRole("button", { name: "Add service check" }).click();
    await page.getByLabel("Friendly name").fill("Controlled UI service");
    await page
      .getByLabel("URL", { exact: true })
      .fill(f.origin + "/controlled");
    await page.getByLabel("Hostboard notifications for this check").uncheck();
    await page.getByRole("button", { name: "Test configuration" }).click();
    await expect(page.getByRole("status")).toContainText("Test passed");
    await page.getByRole("button", { name: "Save service" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Service configuration saved",
    );
    let row = page
      .locator(".settings-service-list>div")
      .filter({ hasText: "Controlled UI service" });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Service group").selectOption("Infrastructure");
    await page.getByLabel("Check enabled", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Save service" }).click();
    await expect(row).toContainText("Check disabled");
    const added = f.store
      .checks()
      .find((c) => c.definition.name === "Controlled UI service")!;
    expect(added.enabled).toBe(false);
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Remove check" }).click();
    await expect(row).toContainText("Archived");
    await row.getByRole("button", { name: "Restore / edit" }).click();
    await page.getByLabel("Check enabled", { exact: true }).check();
    await page.getByRole("button", { name: "Save service" }).click();
    await expect(
      row.getByRole("button", { name: "Edit", exact: true }),
    ).toBeVisible();
    expect(
      f.store.checks().find((c) => c.definition.id === added.definition.id)
        ?.deleted,
    ).toBe(false);
    await page.getByRole("tab", { name: "Notifications", exact: true }).click();
    await page.getByLabel("Enable service-incident notifications").uncheck();
    await page.getByLabel("Recipient emails").fill("test@example.com");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Notification preferences saved",
    );
    await page.getByRole("button", { name: "Send test email" }).click();
    await expect(page.getByRole("status")).toContainText("SMTP accepted");
    expect(f.sends).toBe(1);
    await page.getByRole("button", { name: "Send test email" }).click();
    await expect(page.getByRole("alert")).toContainText("one minute");
    expect(f.sends).toBe(1);
    await page.getByRole("tab", { name: "Data & History" }).click();
    await page.getByLabel("Raw sample retention (days)").fill("45");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Retention preferences saved",
    );
    await page.reload();
    await page.getByRole("tab", { name: "Data & History" }).click();
    await expect(page.getByLabel("Raw sample retention (days)")).toHaveValue(
      "45",
    );
    expect(f.store.settings().retention.sampleDays).toBe(45);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.ai-local/v04-${info.project.name}-settings.png`,
      fullPage: true,
    });
  } finally {
    await context.close();
    f.close();
  }
});
test("Overview drag, constrained resizing, hiding, discovered metrics, save/reload and reset", async ({
  page,
  request,
}, info) => {
  const fleet = await (await request.get("/api/fleet")).json();
  const host = fleet.hosts[0];
  await page.goto("/");
  await expect(page.locator(`[data-widget="host-${host.id}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Customize Overview" }).click();
  await page
    .getByRole("button", { name: `Drag ${host.name}`, exact: true })
    .dragTo(page.locator("[data-widget=health]"));
  await expect(page.locator(".dashboard-widget").first()).toHaveAttribute(
    "data-widget",
    `host-${host.id}`,
  );
  await page
    .getByLabel(`Width of ${host.name}`, { exact: true })
    .selectOption("full");
  await page
    .getByLabel(`Height of ${host.name}`, { exact: true })
    .selectOption("tall");
  await page
    .getByRole("button", { name: "Hide Fleet summary", exact: true })
    .click();
  await page.getByLabel("Preferred metric 1", { exact: true }).check();
  await page
    .getByLabel("Preferred metric", { exact: true })
    .selectOption({ index: 1 });
  await expect(page.locator(".preferred-chart svg").first()).toBeVisible();
  await page.getByRole("button", { name: "Save layout", exact: true }).click();
  await page.reload();
  await expect(page.locator(".dashboard-widget").first()).toHaveAttribute(
    "data-widget",
    `host-${host.id}`,
  );
  await expect(page.locator(`[data-widget="host-${host.id}"]`)).toHaveAttribute(
    "data-width",
    "full",
  );
  await expect(page.locator("[data-widget=summary]")).toHaveCount(0);
  await expect(page.locator(".preferred-chart svg").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.ai-local/v04-${info.project.name}-customized.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Customize Overview" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Restore default layout" }).click();
  await page.getByRole("button", { name: "Save layout", exact: true }).click();
  await page.reload();
  await expect(page.locator(".dashboard-widget").first()).toHaveAttribute(
    "data-widget",
    "health",
  );
  await expect(page.locator("[data-widget=summary]")).toBeVisible();
  await expect(page.locator("[data-widget=metric-a]")).toHaveCount(0);
  await page.screenshot({
    path: `.ai-local/v04-${info.project.name}-default.png`,
    fullPage: true,
  });
});
