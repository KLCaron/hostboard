// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "@playwright/test";
import { updateSample } from "../update-fixture";
import { updateCounts, type HostUpdates } from "../../src/update-types";

test("update overview, host details, stale/partial results and refresh are read-only and responsive", async ({
  page,
}) => {
  const now = Date.now() / 1000;
  const host: HostUpdates = {
    hostId: "server-a",
    name: "Example server",
    groupId: null,
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
    configured: false,
    snapshot: null,
  };
  let refresh = 0;
  await page.route("**/api/admin/updates", (route) =>
    route.fulfill({
      json: {
        hosts: [host, missing].map((h) => ({
          ...h,
          detailsIncluded: false,
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
  await page.route("**/api/admin/updates/*", (route) =>
    route.fulfill({
      json: {
        host: route.request().url().endsWith("/missing") ? missing : host,
      },
    }),
  );
  await page.route("**/api/admin/updates/*/refresh", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({});
    expect(route.request().headers()["x-hostboard-request"]).toBe("1");
    refresh++;
    await route.fulfill({ json: { refreshed: true, host } });
  });
  await page.goto("/#updates?host=server-a");
  await expect(
    page.getByRole("heading", { name: "Updates", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Read-only monitoring.", { exact: false }),
  ).toBeVisible();
  const row = page
    .locator(".update-host")
    .filter({
      has: page.locator("summary strong", { hasText: "Example server" }),
    })
    .first();
  await expect(row.getByText("1 security", { exact: true })).toBeVisible();
  await expect(row.getByText("1 ordinary", { exact: true })).toBeVisible();
  await expect(row.getByText("libexample", { exact: true })).toBeVisible();
  await expect(
    row.getByText("Ubuntu/noble-security/main/security.ubuntu.com", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(row.getByText("Reboot required", { exact: true })).toBeVisible();
  await row.locator(".update-service > summary").click();
  await expect(
    row.getByText("example:latest · linux/amd64", { exact: true }),
  ).toBeVisible();
  await expect(
    row.getByText("Upstream digest changed", { exact: true }),
  ).toBeVisible();
  await row.getByRole("button", { name: "Refresh Status" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Monitoring snapshot refreshed.",
  );
  expect(refresh).toBe(1);
  await page.getByText("Not configured host", { exact: true }).click();
  await expect(
    page
      .locator(".update-host")
      .filter({ hasText: "Not configured host" })
      .getByRole("button", { name: "Refresh Status" }),
  ).toBeDisabled();
  host.snapshot!.packages.state = "stale";
  host.snapshot!.packages.message = "APT metadata is stale";
  host.snapshot!.docker.state = "unavailable";
  host.snapshot!.docker.services[0].state = "unavailable";
  host.snapshot!.docker.services[0].message = "Registry authentication failed";
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
    path: `.ai-local/update-monitor-${test.info().project.name}.png`,
    fullPage: true,
  });
});
