// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { logLink, parseLogRoute } from "../src/log-navigation";
test("log bookmarks preserve exact timestamps, context and range while invalid ranges and identities fail closed", () => {
  const window = {
      after: "2026-01-01T23:45:00.123456789Z",
      before: "2026-01-02T00:15:00.123456789Z",
    },
    context = { hostId: "server-a", serviceId: "web", generation: 7 };
  const route = parseLogRoute(logLink(context, window));
  assert.equal(route.invalid, false);
  assert.deepEqual(route.window, window);
  assert.deepEqual(route.context, context);
  assert.equal(route.range, "custom");
  for (const q of [
    "host=../other",
    "host=server-a&incident=-1",
    "host=server-a&generation=1.2",
    "host=server-a&service=web&container=web",
    "host=server-a&after=x&before=y",
    "host=server-a&after=2026-01-01T00:00:00Z&before=2026-01-03T00:00:00Z",
    "host=server-a&after=2999-01-01T00:00:00Z&before=2999-01-01T01:00:00Z",
  ])
    assert.equal(parseLogRoute("#logs?" + q).invalid, true, q);
  assert.equal(
    parseLogRoute("#logs?host=server-a&range=__proto__").range,
    undefined,
  );
  assert.equal(
    parseLogRoute(
      "#logs?host=server-a&range=1h&after=2026-01-01T00:00:00Z&before=2026-01-01T00:15:00Z",
    ).range,
    "custom",
  );
});
