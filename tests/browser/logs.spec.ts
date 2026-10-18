// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "@playwright/test";
async function fixture(page: any) {
  const state = {
    mapped: [] as string[],
    queries: [] as any[],
    n: 0,
    unavailable: false,
    truncated: false,
    multiple: false,
    failure: false,
    paged: false,
  };
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
              available: !state.unavailable,
              error: state.unavailable ? "Container not found" : undefined,
              containerId: "a".repeat(64),
              containerName: "example-web-1",
              driver: "json-file",
              created: "2020-01-01T00:00:00.000Z",
            },
            ...(state.multiple
              ? [
                  {
                    id: "worker",
                    hostId: "server-a",
                    name: "Approved worker",
                    available: true,
                    containerName: "worker-1",
                    containerId: "b".repeat(64),
                    driver: "local",
                  },
                ]
              : []),
          ],
        },
      });
    if (url.pathname.endsWith("/context")) {
      if (req.method() === "PUT") state.mapped = body.sources;
      return route.fulfill({ json: { context: body, sources: state.mapped } });
    }
    if (state.failure)
      return route.fulfill({
        status: 502,
        json: { error: "Adapter unavailable" },
      });
    state.queries.push(body);
    state.n++;
    const messages = [
      "INFO hello",
      "ERROR controlled failure",
      '{"level":"warn","message":"Structured fixture"}',
      "<script>globalThis.LOG_XSS=true</script>",
      "INFO Hello",
      "Multiline first line\nSecond line\nThird line",
      "x".repeat(16000),
      "Long sentence with readable words ".repeat(100),
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
        entries: state.paged
          ? body.cursor
            ? entries.slice(4)
            : entries.slice(0, 4)
          : entries,
        truncated: state.truncated,
        nextCursor:
          state.paged && !body.cursor
            ? { containerId: "a".repeat(64), time: entries[3].time, skip: 1 }
            : null,
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
test("centralized service logs and Settings associations, filters, selection, bounded downloads and live pause", async ({
  page,
}, info) => {
  const s = await fixture(page);
  await page.goto("/#service=application");
  await page
    .locator("#service-application")
    .getByRole("link", { name: "View logs →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Logs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/No confirmed log source association/),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Configure source associations →" })
    .click();
  await expect(
    page.getByRole("tab", { name: "Log Sources", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("checkbox", { name: /Approved web/ }).check();
  await page
    .getByRole("button", { name: "Save associations", exact: true })
    .click();
  await expect(page.getByText("Source associations saved.")).toBeVisible();
  await page.getByRole("link", { name: "View logs →", exact: true }).click();
  await expect(page.getByLabel("Log source", { exact: true })).toHaveValue(
    "web",
  );
  await expect(page.getByLabel("Log entries")).toContainText(
    "<script>globalThis.LOG_XSS=true</script>",
  );
  expect(
    await page.evaluate(() => (globalThis as any).LOG_XSS),
  ).toBeUndefined();
  await expect(page.locator(".log-entry.error")).toContainText(
    "controlled failure",
  );
  await expect(page.locator(".log-entry.warning")).toContainText(
    "Structured fixture",
  );
  await page.getByText("JSON fields", { exact: true }).click();
  await expect(page.locator(".log-json pre")).toContainText(
    "Structured fixture",
  );
  const checkbox = page.getByRole("checkbox", {
    name: "Select log entry 2",
    exact: true,
  });
  await checkbox.check();
  await expect(page.locator(".log-entry").nth(1)).toHaveClass(/selected/);
  await page.getByText(/Selection & export/).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download selected", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("hostboard-logs.txt");
  await page.getByLabel("Search logs").fill("hello");
  await page.getByRole("button", { name: "Show logs", exact: true }).click();
  await expect(page.locator(".log-entry")).toHaveCount(2);
  await expect(page.locator("mark")).toHaveCount(2);
  await page
    .getByRole("checkbox", { name: "Case sensitive", exact: true })
    .check();
  await page.getByRole("button", { name: "Show logs", exact: true }).click();
  await expect(page.locator(".log-entry")).toHaveCount(1);
  await page.getByLabel("Log stream", { exact: true }).selectOption("stderr");
  await page.getByRole("button", { name: "Show logs", exact: true }).click();
  await expect(page.getByText(/No retained entries match/)).toBeVisible();
  await page.getByLabel("Search logs").fill("");
  await page.getByRole("button", { name: "Show logs", exact: true }).click();
  await expect(page.locator(".log-entry")).toHaveCount(1);
  await expect(page.getByLabel("Log stream")).toHaveValue("stderr");
  await page
    .getByRole("button", { name: "Resume live tail", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause live tail", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select log entry 1", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Pause live tail", exact: true })
    .click();
  const n = s.queries.length;
  await page.waitForTimeout(3500);
  expect(s.queries.length).toBe(n);
  await page.getByLabel("Log stream").selectOption("all");
  await page.getByRole("button", { name: "Show logs", exact: true }).click();
  await expect(page.locator(".log-entry")).toHaveCount(8);
  await page.getByText(/Selection & export/).click();
  await page.screenshot({
    path: `.ai-local/v061/${info.project.name}-logs-wrap.png`,
    fullPage: true,
  });
});
test("long, multiline and unbroken output stays readable in wrap and no-wrap with local/UTC timestamps", async ({
  page,
}, info) => {
  await fixture(page);
  await page.goto("/#logs?host=server-a&source=web");
  await expect(page.locator(".log-entry")).toHaveCount(8);
  const dimensions = () =>
    page
      .locator(".log-message")
      .nth(6)
      .evaluate((el) => ({
        width: el.clientWidth,
        height: el.clientHeight,
        scroll: el.scrollWidth,
      }));
  expect((await dimensions()).width).toBeGreaterThan(
    info.project.name.includes("mobile") ? 200 : 500,
  );
  await expect(page.locator(".log-message").nth(5)).toContainText(
    "Second line\nThird line",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("checkbox", { name: "Wrap lines", exact: true })
    .uncheck();
  await expect(page.locator(".log-message pre").first()).toHaveCSS(
    "white-space",
    "pre",
  );
  expect(
    await page
      .getByLabel("Log entries")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (info.project.name.includes("mobile")) {
    const bounds = await page.getByLabel("Log entries").boundingBox();
    const stream = await page
      .locator(".log-entry")
      .nth(6)
      .locator(".log-stream")
      .boundingBox();
    expect(stream!.x + stream!.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width + 1,
    );
  }
  await page.getByLabel("Log entries").evaluate((el) => (el.scrollLeft = 100));
  expect(
    await page.getByLabel("Log entries").evaluate((el) => el.scrollLeft),
  ).toBeGreaterThan(0);
  await page.screenshot({
    path: `.ai-local/v061/${info.project.name}-logs-nowrap.png`,
    fullPage: true,
  });
  await page.getByRole("checkbox", { name: "Wrap lines", exact: true }).check();
  await page.getByLabel("Timestamp display").selectOption("utc");
  const time = page.locator(".log-entry time").first();
  expect(await time.textContent()).toContain(
    (await time.getAttribute("datetime"))!
      .replace("T", " ")
      .replace("Z", " UTC"),
  );
  await page.reload();
  await expect(page.getByLabel("Timestamp display")).toHaveValue("utc");
  await expect(
    page.getByRole("checkbox", { name: "Wrap lines", exact: true }),
  ).toBeChecked();
});
test("source and exact range bookmarks restore, presets change data and appearance, custom edits survive refresh", async ({
  page,
}, info) => {
  const s = await fixture(page);
  await page.goto("/#logs?host=server-a&source=web");
  await expect(page.locator(".log-entry")).toHaveCount(8);
  const group = page.getByRole("group", { name: "Log time presets" }),
    hour = group.getByRole("button", { name: "1 hour", exact: true });
  const old = await hour.evaluate((el) => getComputedStyle(el).backgroundColor);
  await hour.click();
  await expect(hour).toHaveAttribute("aria-pressed", "true");
  expect(
    await hour.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe(old);
  await expect
    .poll(
      () =>
        Date.parse(s.queries.at(-1).before) -
        Date.parse(s.queries.at(-1).after),
    )
    .toBe(3600000);
  const after = s.queries.at(-1).after,
    before = s.queries.at(-1).before;
  await page.reload();
  await expect(hour).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => s.queries.at(-1).after).toBe(after);
  expect(s.queries.at(-1).before).toBe(before);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Services", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Logs", exact: true })
    .click();
  await expect(page.getByLabel("Log source", { exact: true })).toHaveValue(
    "web",
  );
  const custom = group.getByRole("button", { name: "Custom", exact: true });
  await custom.click();
  await page.getByLabel("Log start", { exact: true }).fill("2026-01-01T12:00");
  await expect(custom).toHaveAttribute("aria-pressed", "true");
  await expect(hour).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Log start", { exact: true })).toHaveValue(
    "2026-01-01T12:00",
  );
  await page.getByLabel("Log end", { exact: true }).fill("2026-01-01T13:00");
  await page.getByRole("button", { name: "Show logs", exact: true }).click();
  await expect
    .poll(
      () =>
        Date.parse(s.queries.at(-1).before) -
        Date.parse(s.queries.at(-1).after),
    )
    .toBe(3600000);
  await expect(custom).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: `.ai-local/v061/${info.project.name}-logs-custom.png`,
    fullPage: true,
  });
});
test("incident links preserve verified context and exact timestamps with return to incident and metrics", async ({
  page,
  request,
}) => {
  const monitor = await (await request.get("/api/monitor")).json(),
    start = Math.floor(Date.now() / 1000) - 3600,
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
  await page.route("**/api/monitor", (r) =>
    r.fulfill({
      json: { ...monitor, incidents: [incident], activeIncidents: [] },
    }),
  );
  const s = await fixture(page);
  s.mapped = ["web"];
  await page.goto("/#incident=987");
  await page
    .locator("#incident-987")
    .getByRole("link", { name: "View related logs →", exact: true })
    .click();
  await expect(page.getByLabel("Log host")).toHaveValue("server-a");
  await expect(page.getByLabel("Log entries")).toContainText("hello");
  expect(Date.parse(s.queries[0].after) / 1000).toBe(start - 900);
  expect(Date.parse(s.queries[0].before) / 1000).toBe(end + 900);
  await expect(
    page.getByRole("link", { name: "Return to incident →" }),
  ).toHaveAttribute("href", "#incident=987");
  await page.getByRole("link", { name: "Host metrics →", exact: true }).click();
  await expect(
    page.getByText(/Historical log investigation window/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Return to incident →" }),
  ).toHaveAttribute("href", "#incident=987");
});
test("multiple associations require explicit source choice; unavailable, unapproved, truncated and errors are distinct", async ({
  page,
}) => {
  const s = await fixture(page);
  s.multiple = true;
  s.mapped = ["web", "worker"];
  await page.goto("/#logs?host=server-a&service=application");
  await expect(page.getByLabel("Log source", { exact: true })).toHaveValue("");
  expect(s.queries).toHaveLength(0);
  await page.getByLabel("Log source", { exact: true }).selectOption("web");
  await expect(page.locator(".log-entry")).toHaveCount(8);
  s.truncated = true;
  await page.getByRole("button", { name: "Reload range", exact: true }).click();
  await expect(page.getByText(/Partial results:/)).toBeVisible();
  s.failure = true;
  await page.getByRole("button", { name: "Reload range", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Adapter unavailable");
  s.failure = false;
  s.unavailable = true;
  await page.reload();
  await expect(
    page.getByText(/Logs are unavailable for this source/),
  ).toBeVisible();
  await page.goto("/#logs?host=server-a&source=not-approved");
  await expect(page.getByRole("alert")).toContainText("not approved");
  await page.goto("/#logs?host=server-a&after=bad&before=bad");
  await expect(page.getByRole("alert")).toContainText("Invalid log link");
});
test("administrator privacy, optional adapter and container log actions", async ({
  page,
}) => {
  let logRequests = 0;
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { admin: false, configured: true } }),
  );
  await page.route("**/api/admin/logs/**", (r) => {
    logRequests++;
    return r.fulfill({
      status: 403,
      json: { error: "Administrator required" },
    });
  });
  await page.goto("/#logs?host=server-a&source=web");
  await expect(
    page.getByText(/Log contents require an authorized administrator/),
  ).toBeVisible();
  expect(logRequests).toBe(0);
  await page.unroute("**/api/session");
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { admin: true, configured: true } }),
  );
  await page.unroute("**/api/admin/logs/**");
  await page.route("**/api/admin/logs/**", (r) =>
    r.fulfill({ json: { sources: [] } }),
  );
  await page.goto("/#logs?host=server-a");
  await expect(
    page.getByText(/No approved log sources are available/),
  ).toBeVisible();
  await page.goto("/#services");
  await page.locator(".services-panel>summary").click();
  const row = page.locator(".service-list>details").first();
  await row.locator("summary").click();
  await row.getByRole("link", { name: "View logs →", exact: true }).click();
  await expect(page).toHaveURL(/#logs\?host=server-a&container=/);
});
test("local timestamps cross midnight and daylight-saving boundaries while queries retain nanosecond UTC values", async ({
  browser,
}) => {
  const context = await browser.newContext({ timezoneId: "America/Denver" }),
    page = await context.newPage();
  try {
    const s = await fixture(page);
    const after = "2026-03-08T08:59:59.123456789Z",
      before = "2026-03-08T09:14:59.123456789Z";
    await page.goto(
      "/#logs?host=server-a&source=web&after=" + after + "&before=" + before,
    );
    await expect(page.locator(".log-entry")).toHaveCount(8);
    await expect(page.locator(".log-entry time").nth(0)).toContainText(
      "01:59:59",
    );
    await expect(page.locator(".log-entry time").nth(1)).toContainText(
      "03:00:00",
    );
    await page.getByLabel("Search logs").fill("hello");
    await page.getByRole("button", { name: "Show logs", exact: true }).click();
    await expect.poll(() => s.queries.at(-1).search).toBe("hello");
    expect(s.queries.at(-1).after).toBe(after);
    expect(s.queries.at(-1).before).toBe(before);
    await page.goto(
      "/#logs?host=server-a&source=web&after=2026-01-02T00:00:00Z&before=2026-01-02T00:15:00Z",
    );
    await expect(page.locator(".log-entry time").first()).toContainText(
      "01/01/2026",
    );
  } finally {
    await context.close();
  }
});
test("association administration distinguishes unavailable sources and saves replacement or removal explicitly", async ({
  page,
}, info) => {
  const s = await fixture(page);
  s.multiple = true;
  s.mapped = ["web"];
  await page.goto("/#settings?tab=logs&host=server-a&service=application");
  await expect(
    page.getByRole("checkbox", { name: /Approved web/ }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: /Approved web/ }).uncheck();
  await page.getByRole("checkbox", { name: /Approved worker/ }).check();
  await page
    .getByRole("button", { name: "Save associations", exact: true })
    .click();
  await expect(page.getByText("Source associations saved.")).toBeVisible();
  expect(s.mapped).toEqual(["worker"]);
  await page.screenshot({
    path: `.ai-local/v061/${info.project.name}-log-associations.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Clear associations", exact: true })
    .click();
  expect(s.mapped).toEqual(["worker"]);
  await page
    .getByRole("button", { name: "Save associations", exact: true })
    .click();
  await expect(
    page.getByText(/Unconfigured · no source association/),
  ).toBeVisible();
  expect(s.mapped).toEqual([]);
});
test("incremental loading and source changes preserve the investigation window; copy uses exact selected text", async ({
  page,
}) => {
  const s = await fixture(page);
  s.multiple = true;
  s.paged = true;
  await page.goto(
    "/#logs?host=server-a&source=web&after=2026-01-01T12:00:00.123456789Z&before=2026-01-01T13:00:00.123456789Z",
  );
  await expect(page.locator(".log-entry")).toHaveCount(4);
  await page
    .getByRole("button", { name: "Load next page", exact: true })
    .click();
  await expect(page.locator(".log-entry")).toHaveCount(8);
  expect(s.queries.at(-1).cursor).toBeTruthy();
  await page
    .getByRole("checkbox", { name: "Select log entry 2", exact: true })
    .check();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (globalThis as any).COPIED = text;
        },
      },
    }),
  );
  await page.getByText(/Selection & export/).click();
  await page
    .getByRole("button", { name: "Copy selected", exact: true })
    .click();
  await expect(page.getByText("Selected entries copied.")).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).COPIED)).toContain(
    "[stderr] ERROR controlled failure",
  );
  const start = s.queries.at(-1).after,
    end = s.queries.at(-1).before;
  await page.getByLabel("Log source", { exact: true }).selectOption("worker");
  await expect.poll(() => s.queries.at(-1).source).toBe("worker");
  expect(s.queries.at(-1).after).toBe(start);
  expect(s.queries.at(-1).before).toBe(end);
});
