// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "@playwright/test";
import { defaults } from "../../server/settings";
import type { UpdateSettingsView } from "../../src/update-settings";

test("Updates settings distinguish saved proposals from collector policy, isolate hosts, persist timing and guide local operators", async ({
  page,
}, info) => {
  let value: UpdateSettingsView = {
    revision: 1,
    preferences: { intervalSeconds: 21600, staleSeconds: 86400, hosts: {} },
    hosts: ["host-a", "host-b"].map((hostId, i) => ({
      hostId,
      name: `Host ${i ? "B" : "A"}`,
      configured: true,
      paused: false,
      reader: {
        address: `192.168.1.${10 + i}`,
        port: 22,
        nodeGuid: `guid-${hostId}`,
      },
      collectedAt: Date.now() / 1000,
      receivedAt: Date.now() / 1000,
      error: null,
      packageState: "ok",
      dockerState: "unavailable",
      policy: i
        ? null
        : {
            approvedRegistries: ["registry-1.docker.io"],
            packageStaleSeconds: 86400,
          },
      policyStale: false,
      missing: i
        ? []
        : [
            {
              registry: "lscr.io",
              project: "vpn",
              service: "qbittorrent",
              image: "lscr.io/linuxserver/qbittorrent:latest",
            },
          ],
    })),
  };
  let writes = 0;
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { admin: true, configured: true } }),
  );
  await page.route("**/api/admin/config", (r) =>
    r.fulfill({
      json: {
        revision: 1,
        settings: defaults,
        effectiveRecipients: [],
        checks: [],
        targets: [],
        mailTests: [],
      },
    }),
  );
  await page.route("**/api/admin/updates/settings**", (r) => {
    const req = r.request();
    if (req.method() === "PUT") {
      expect(req.headers()["x-hostboard-request"]).toBe("1");
      const body = req.postDataJSON();
      expect(body.revision).toBe(value.revision);
      writes++;
      if (req.url().includes("/hosts/")) {
        expect(Object.keys(body).sort()).toEqual(["host", "revision"]);
        const id = req.url().split("/").pop()!;
        value.preferences.hosts[id] = body.host;
      } else {
        expect(Object.keys(body).sort()).toEqual([
          "intervalSeconds",
          "revision",
          "staleSeconds",
        ]);
        value.preferences.intervalSeconds = body.intervalSeconds;
        value.preferences.staleSeconds = body.staleSeconds;
      }
      value.revision++;
    } else expect(req.method()).toBe("GET");
    return r.fulfill({ json: value });
  });
  await page.goto("/#settings?tab=updates&host=host-a");
  await expect(
    page.getByRole("heading", { name: "Updates", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("vpn/qbittorrent:", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Snapshot-read interval (seconds)").fill("7200");
  await page.getByRole("button", { name: "Save snapshot timing" }).click();
  await expect(page.getByRole("status")).toContainText("timer is unchanged");
  await page.getByLabel("Additional registry hostname").fill("*.example.com");
  await page.getByRole("button", { name: "Add proposal" }).click();
  await expect(page.getByRole("alert")).toContainText("wildcards");
  await page.getByLabel("Additional registry hostname").fill("lscr.io");
  await page.getByRole("button", { name: "Add proposal" }).click();
  await expect(
    page.locator("li").filter({ hasText: "Requires operator application" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save host preferences" }).click();
  await expect(page.getByRole("status")).toContainText(
    "still require operator",
  );
  expect(value.hosts[0].policy!.approvedRegistries).toEqual([
    "registry-1.docker.io",
  ]);
  await page
    .getByText("Review operator instructions for Host A", { exact: true })
    .click();
  await expect(page.locator(".update-operator-guide")).toContainText(
    "guid-host-a",
  );
  await expect(page.locator(".update-operator-guide pre")).toContainText(
    '"lscr.io": {}',
  );
  await page.screenshot({
    path: `.ai-local/update-settings/settings-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByLabel("Monitored host").selectOption("host-b");
  await expect(
    page.getByText("Unknown. This snapshot has no registry policy report.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove proposal lscr.io" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Snapshot-read interval (seconds)")).toHaveValue(
    "7200",
  );
  await page.getByLabel("Monitored host").selectOption("host-a");
  await page.getByRole("button", { name: "Remove proposal lscr.io" }).click();
  await page.getByRole("button", { name: "Save host preferences" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Host preferences saved",
  );
  expect(value.preferences.hosts["host-a"].proposedRegistries).toEqual([]);
  expect(value.preferences.hosts["host-b"]).toBeUndefined();
  expect(writes).toBe(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Updates configuration requires administrator access in the UI", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { admin: false, configured: true } }),
  );
  await page.route("**/api/admin/updates/settings**", (r) => {
    requests++;
    return r.fulfill({ status: 403, json: { error: "denied" } });
  });
  await page.goto("/#settings?tab=updates");
  await expect(
    page.getByText(
      "An administrator session is required to view or change update monitoring configuration.",
    ),
  ).toBeVisible();
  expect(requests).toBe(0);
});
