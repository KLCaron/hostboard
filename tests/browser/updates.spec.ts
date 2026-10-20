// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "@playwright/test";
import { updateSample } from "../update-fixture";
import { updateCounts, type HostUpdates } from "../../src/update-types";
import { updatePreview } from "../../src/updates-view";

test("update cards prioritize security, expose names, filter fleet totals and retain read-only details on desktop/mobile", async ({
  page,
}) => {
  const now = Date.now() / 1000;
  const host: HostUpdates = {
    hostId: "server-a",
    name: "Example server",
    groupId: "production",
    archived: false,
    enabled: true,
    configured: true,
    paused: false,
    refreshing: false,
    lastAttemptAt: now,
    receivedAt: now,
    error: null,
    packageLastSuccessAt: now,
    dockerLastSuccessAt: now,
    snapshot: updateSample("server-a", now),
  };
  const missing: HostUpdates = {
    ...host,
    hostId: "missing",
    name: "Not configured host",
    groupId: null,
    configured: false,
    snapshot: null,
  };
  const current: HostUpdates = {
    ...host,
    hostId: "current",
    name: "Current host",
    snapshot: structuredClone(host.snapshot),
  };
  current.snapshot!.packages.packages = [];
  current.snapshot!.packages.rebootRequired = false;
  current.snapshot!.docker.services = [];
  let refresh = 0,
    details = 0;
  await page.route("**/api/admin/servers", (route) =>
    route.fulfill({
      json: { servers: [], groups: [{ id: "production", name: "Production" }] },
    }),
  );
  await page.route("**/api/admin/updates", (route) =>
    route.fulfill({
      json: {
        hosts: [current, missing, host].map((h) => ({
          ...h,
          detailsIncluded: false,
          preview: updatePreview(h.snapshot),
          counts: updateCounts(h.snapshot),
          snapshot: h.snapshot
            ? {
                ...h.snapshot,
                packages: { ...h.snapshot.packages, packages: [] },
                docker: { ...h.snapshot.docker, services: [] },
              }
            : null,
        })),
        generatedAt: now,
      },
    }),
  );
  await page.route("**/api/admin/updates/*", (route) => {
    details++;
    return route.fulfill({
      json: {
        host: route.request().url().endsWith("/missing") ? missing : host,
      },
    });
  });
  await page.route("**/api/admin/updates/*/refresh", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({});
    expect(route.request().headers()["x-hostboard-request"]).toBe("1");
    refresh++;
    await route.fulfill({ json: { refreshed: true, host } });
  });
  await page.goto("/#updates");
  const card = page.getByRole("article", {
    name: "Example server",
    exact: true,
  });
  await expect(
    card.getByText("Security updates pending", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("libexample", { exact: true })).toBeVisible();
  await expect(
    card.getByText("Reboot required", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("Collector: snapshot received")).toBeVisible();
  await expect(page.locator(".update-card").first()).toHaveAttribute(
    "aria-label",
    "Example server",
  );
  await expect(
    page
      .getByRole("article", { name: "Current host", exact: true })
      .getByText("Up to date", { exact: true }),
  ).toBeVisible();
  expect(details).toBe(0); // Cards use bounded previews, not fleet-wide inventory requests.
  await expect(page.locator(".updates-fleet")).toContainText(
    "Security updates",
  );
  await page.screenshot({
    path: `.ai-local/update-overview-${test.info().project.name}.png`,
    fullPage: true,
  });
  await card
    .getByRole("button", { name: "Details for Example server" })
    .click();
  const body = page.locator(".update-body").filter({ visible: true });
  await expect(
    body.getByText("Ubuntu/noble-security/main/security.ubuntu.com", {
      exact: true,
    }),
  ).toBeVisible();
  await body.locator(".update-service > summary").click();
  await expect(
    body.getByText("example:latest · linux/amd64", { exact: true }),
  ).toBeVisible();
  await expect(
    body.getByText("Upstream digest changed", { exact: true }),
  ).toBeVisible();
  await body.getByRole("button", { name: "Refresh Status" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Monitoring snapshot refreshed.",
  );
  expect(refresh).toBe(1);
  if (test.info().project.name.includes("desktop")) {
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card.getByRole("button")).toBeFocused();
  } else
    await card
      .getByRole("button", { name: "Details for Example server" })
      .click();
  await page
    .getByRole("article", { name: "Not configured host", exact: true })
    .getByRole("button")
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh Status" }),
  ).toBeDisabled();
  if (test.info().project.name.includes("desktop"))
    await page.keyboard.press("Escape");
  else
    await page
      .getByRole("article", { name: "Not configured host", exact: true })
      .getByRole("button", { name: "Details for Not configured host" })
      .click();
  await page.getByLabel("Server group").selectOption("ungrouped");
  await expect(page.locator(".update-card")).toHaveCount(1);
  await expect(
    page.locator(".updates-fleet > div").first().locator("strong"),
  ).toHaveText("0");
  await page.getByLabel("Server group").selectOption("");
  host.snapshot!.packages.state = "stale";
  host.snapshot!.packages.message = "APT metadata is stale";
  host.snapshot!.docker.state = "unavailable";
  host.snapshot!.docker.services[0].state = "unavailable";
  host.snapshot!.docker.services[0].message = "Registry authentication failed";
  await page.goto("/#updates?host=server-a");
  await page.reload();
  await expect(
    page.getByText("APT metadata is stale", { exact: true }),
  ).toBeVisible();
  await page.locator(".update-service > summary").click();
  await expect(
    page.getByText("Registry authentication failed", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Digest unchanged", { exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.ai-local/update-details-${test.info().project.name}.png`,
    fullPage: true,
  });
  host.snapshot!.docker.services[0].image =
    "lscr.io/linuxserver/qbittorrent:latest";
  host.snapshot!.docker.services[0].message =
    "Registry is not approved in collector configuration";
  await page.reload();
  await page.locator(".update-service > summary").click();
  await expect(
    page.getByRole("link", { name: "Configure registry approval for lscr.io" }),
  ).toHaveAttribute("href", "#settings?tab=updates&host=server-a");
});
