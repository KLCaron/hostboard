// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "@playwright/test";
async function fixture(page: any) {
  const state = { mapped: [] as string[], queries: [] as any[], n: 0 };
  await page.route("**/api/session", async (route: any) =>
    route.fulfill({ json: { admin: true, configured: true, mode: "local" } }),
  );
  await page.route("**/api/admin/logs/**", async (route: any) => {
    const req = route.request(),
      url = new URL(req.url()),
      body = req.method() === "GET" ? undefined : req.postDataJSON();
    if (url.pathname.includes("/sources/"))
      return route.fulfill({
        json: {
          sources: [
            {
              id: "web",
              hostId: "server-a",
              name: "Approved web",
              available: true,
              containerId: "a".repeat(64),
              containerName: "example-web-1",
              driver: "json-file",
              created: "2020-01-01T00:00:00.000Z",
            },
          ],
        },
      });
    if (url.pathname.endsWith("/context")) {
      if (req.method() === "PUT") state.mapped = body.sources;
      return route.fulfill({ json: { context: body, sources: state.mapped } });
    }
    state.queries.push(body);
    state.n++;
    const messages = [
      "INFO hello",
      "ERROR controlled failure",
      '{"level":"warn","message":"Structured fixture"}',
      "<script>globalThis.LOG_XSS=true</script>",
      "INFO Hello",
    ];
    const entries = messages
      .map((text, i) => ({
        time: new Date(Date.parse(body.after) + i * 1000).toISOString(),
        stream: i === 1 ? "stderr" : "stdout",
        text,
        truncated: false,
      }))
      .filter(
        (e) =>
          (body.stream === "all" || body.stream === e.stream) &&
          (body.caseSensitive
            ? e.text.includes(body.search)
            : e.text.toLowerCase().includes(body.search.toLowerCase())),
      );
    return route.fulfill({
      json: {
        containerId: "a".repeat(64),
        containerName: "example-web-1",
        created: "2020-01-01T00:00:00.000Z",
        driver: "json-file",
        tty: false,
        entries,
        truncated: false,
        nextCursor: null,
        resumeCursor: {
          containerId: "a".repeat(64),
          time: body.before,
          skip: 0,
        },
        scannedBytes: 100,
        notice: "Only retained controlled fixtures.",
        incomplete: false,
      },
    });
  });
  return state;
}
test("service log associations, safe rendering, filtering, selection/download and live pause work on desktop and touch", async ({
  page,
}, info) => {
  const s = await fixture(page);
  await page.goto("/#service=application");
  const card = page.locator("#service-application");
  await expect(card).toHaveAttribute("open", "");
  await card.getByRole("button", { name: "Logs +", exact: true }).click();
  await expect(
    card.getByText(/No confirmed log source association/),
  ).toBeVisible();
  await card.getByRole("button", { name: "Associate log sources" }).click();
  await card.getByRole("checkbox", { name: /Approved web/ }).check();
  await card.getByRole("button", { name: "Confirm associations" }).click();
  await expect(card.getByLabel("Log source")).toHaveValue("web");
  await expect(card.getByLabel("Log entries")).toContainText(
    "<script>globalThis.LOG_XSS=true</script>",
  );
  expect(
    await page.evaluate(() => (globalThis as any).LOG_XSS),
  ).toBeUndefined();
  await page.screenshot({
    path: `.ai-local/v060/${info.project.name}-logs.png`,
    fullPage: true,
  });
  await expect(card.locator(".log-entry.error")).toContainText(
    "controlled failure",
  );
  await expect(card.locator(".log-entry.warning")).toContainText(
    "Structured fixture",
  );
  await card.getByText("JSON fields", { exact: true }).click();
  await expect(card.locator(".log-json pre")).toContainText(
    "Structured fixture",
  );
  await card
    .getByRole("checkbox", { name: "Select log entry 2", exact: true })
    .check();
  const download = page.waitForEvent("download");
  await card
    .getByRole("button", { name: "Download selected", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("hostboard-logs.txt");
  await card.getByLabel("Search logs").fill("hello");
  await card.getByRole("button", { name: "Show logs", exact: true }).click();
  await expect(card.locator(".log-entry")).toHaveCount(2);
  await expect(card.locator("mark")).toHaveCount(2);
  await card
    .getByRole("checkbox", { name: "Case sensitive", exact: true })
    .check();
  await card.getByRole("button", { name: "Show logs", exact: true }).click();
  await expect(card.locator(".log-entry")).toHaveCount(1);
  await card
    .getByRole("button", { name: "Resume live tail", exact: true })
    .click();
  await expect(
    card.getByRole("button", { name: "Pause live tail", exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Pause live tail", exact: true })
    .click();
  const n = s.queries.length;
  await page.waitForTimeout(3500);
  expect(s.queries.length).toBe(n);
  await card.getByRole("button", { name: "24 hours", exact: true }).click();
  await expect
    .poll(() => s.queries.at(-1).before !== s.queries.at(-2)?.before)
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("incident related logs preserve the verified host and onset time window; missing sources are explained", async ({
  page,
  request,
}) => {
  const monitor = await (await request.get("/api/monitor")).json(),
    now = Math.floor(Date.now() / 1000),
    start = now - 3600,
    end = start + 300;
  const incident = {
    id: 987,
    checkId: "application",
    name: "Example web",
    hostId: "server-a",
    severity: "warning",
    startedAt: start,
    detectedAt: start + 30,
    endedAt: end,
    reason: "Controlled fixture",
    lastReason: "HTTP 200",
    responseMs: 20,
    resolution: "Reachability restored",
    monitoringGap: false,
    notifications: [],
  };
  await page.route("**/api/monitor", (route) =>
    route.fulfill({
      json: { ...monitor, incidents: [incident], activeIncidents: [] },
    }),
  );
  const s = await fixture(page);
  s.mapped = ["web"];
  await page.goto("/#incident=987");
  const detail = page.locator("#incident-987");
  await expect(detail).toHaveAttribute("open", "");
  await detail
    .getByRole("button", { name: "View related logs +", exact: true })
    .click();
  await expect(detail.getByLabel("Log entries")).toContainText("hello");
  expect(Date.parse(s.queries[0].after) / 1000).toBe(start - 900);
  expect(Date.parse(s.queries[0].before) / 1000).toBe(end + 900);
  await expect(
    detail.getByRole("link", { name: "Incident #987 ↗", exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("link", { name: "Host metrics →", exact: true }),
  ).toHaveAttribute(
    "href",
    `#host=server-a?after=${start - 900}&before=${end + 900}&incident=987`,
  );
  await detail
    .getByRole("link", { name: "Host metrics →", exact: true })
    .click();
  await expect(
    page.getByText(/Historical log investigation window/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Return to incident →", exact: true }),
  ).toHaveAttribute("href", "#incident=987");
});
test("log privacy and optional adapter empty state are explicit", async ({
  page,
}) => {
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { admin: false, configured: true } }),
  );
  await page.goto("/#service=application");
  const card = page.locator("#service-application");
  await card.getByRole("button", { name: "Logs +", exact: true }).click();
  await expect(
    card.getByText(/Log contents require an authorized administrator/),
  ).toBeVisible();
  await page.unroute("**/api/session");
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { admin: true, configured: true } }),
  );
  await page.route("**/api/admin/logs/**", (r) =>
    r.fulfill({ json: { sources: [] } }),
  );
  await card.getByRole("button", { name: "Logs −", exact: true }).click();
  await card.getByRole("button", { name: "Logs +", exact: true }).click();
  await expect(
    card.getByText(/No approved log sources are available/),
  ).toBeVisible();
});
