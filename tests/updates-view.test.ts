// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateSample } from "./update-fixture.js";
import {
  fleetUpdateCounts,
  updatePresentation,
  updatePreview,
} from "../src/updates-view.js";
import { updateCounts, type HostUpdates } from "../src/update-types.js";
const make = (): HostUpdates => ({
  hostId: "a",
  name: "A",
  groupId: null,
  enabled: true,
  archived: false,
  configured: true,
  paused: false,
  refreshing: false,
  error: null,
  lastAttemptAt: 1,
  receivedAt: 1,
  packageLastSuccessAt: 1,
  dockerLastSuccessAt: 1,
  snapshot: updateSample("a", 1),
});
test("successful collection retains pending urgency; stale/partial results never imply current", () => {
  const h = make();
  assert.equal(updatePresentation(h).status, "Security updates pending");
  h.snapshot!.packages.packages = [];
  h.snapshot!.packages.rebootRequired = false;
  h.snapshot!.docker.services = [];
  assert.equal(updatePresentation(h).status, "Up to date");
  h.snapshot!.packages.state = "stale";
  assert.equal(updatePresentation(h).status, "Stale observations");
  h.snapshot!.packages.state = "ok";
  h.snapshot!.docker.state = "unavailable";
  assert.equal(updatePresentation(h).status, "Status unavailable");
  h.configured = false;
  assert.equal(updatePresentation(h).status, "Unconfigured");
  h.paused = true;
  assert.equal(updatePresentation(h).status, "Polling paused");
});
test("bounded preview prioritizes security; fleet counts unique services and excludes paused hosts", () => {
  const h = make(),
    s = h.snapshot!;
  s.packages.packages = Array.from({ length: 20 }, (_, i) => ({
    ...s.packages.packages[0],
    name: `package-${i}`,
    security: i === 19,
  }));
  s.docker.services.push({ ...s.docker.services[0], container: "replica" });
  const preview = updatePreview(s);
  assert.equal(preview.packages.length, 5);
  assert.equal(preview.packages[0].name, "package-19");
  assert.equal(preview.services.length, 1);
  const paused = { ...h, paused: true };
  assert.deepEqual(fleetUpdateCounts([h, paused]), {
    packages: 20,
    security: 1,
    images: 1,
    reboots: 1,
    unknown: 0,
  });
  h.counts = updateCounts(s);
  h.snapshot!.packages.packages = [];
  assert.equal(updatePresentation(h).counts.total, 20);
  h.snapshot!.docker.state = "unavailable";
  assert.equal(fleetUpdateCounts([h]).unknown, 1);
});

test("untracked local or pinned services cannot make a host appear fully current", () => {
  const h = make();
  h.snapshot!.packages.packages = [];
  h.snapshot!.packages.rebootRequired = false;
  h.snapshot!.docker.services[0].state = "local";
  assert.equal(updatePresentation(h).status, "Status unavailable");
  assert.equal(fleetUpdateCounts([h]).unknown, 1);
  h.snapshot!.docker.services[0].state = "pinned";
  assert.equal(updatePresentation(h).unknown, true);
});
