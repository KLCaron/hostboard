// SPDX-License-Identifier: AGPL-3.0-only
import {
  updateCounts,
  type HostUpdates,
  type UpdateSnapshot,
} from "./update-types.js";
export function updatePreview(s: UpdateSnapshot | null) {
  return {
    unverifiedServices: new Set(
      (s?.docker.services || [])
        .filter((x) => !["current", "update"].includes(x.state))
        .map((x) => JSON.stringify([x.project, x.service])),
    ).size,
    packages: [...(s?.packages.packages || [])]
      .sort(
        (a, b) =>
          Number(b.security === true) - Number(a.security === true) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 5)
      .map(({ name, security }) => ({ name, security })),
    services: [
      ...new Map(
        (s?.docker.services || [])
          .filter((x) => x.state === "update")
          .map((x) => [
            JSON.stringify([x.project, x.service]),
            { project: x.project, service: x.service },
          ]),
      ).values(),
    ].slice(0, 3),
  };
}
export function updatePresentation(h: HostUpdates) {
  const c = h.counts || updateCounts(h.snapshot),
    p = h.snapshot?.packages,
    d = h.snapshot?.docker;
  const stale = p?.state === "stale" || d?.state === "stale";
  const unknown =
    !h.configured ||
    !h.snapshot ||
    !!h.error ||
    stale ||
    p?.state !== "ok" ||
    d?.state !== "ok" ||
    c.unknownSecurity > 0 ||
    p?.rebootRequired == null ||
    (h.preview || updatePreview(h.snapshot)).unverifiedServices > 0;
  const pending =
    (c.total || 0) > 0 || (c.images || 0) > 0 || p?.rebootRequired === true;
  const status = h.paused
    ? "Polling paused"
    : !h.configured
      ? "Unconfigured"
      : (c.security || 0) > 0
        ? "Security updates pending"
        : (c.total || 0) > 0
          ? "Package updates pending"
          : (c.images || 0) > 0
            ? "Image digests changed"
            : p?.rebootRequired
              ? "Reboot required"
              : stale
                ? "Stale observations"
                : unknown
                  ? "Status unavailable"
                  : "Up to date";
  const tone = h.paused
    ? "muted"
    : (c.security || 0) > 0
      ? "security"
      : pending
        ? "pending"
        : unknown
          ? "unknown"
          : "current";
  const rank = h.paused
    ? 9
    : (c.security || 0) > 0
      ? 0
      : p?.rebootRequired
        ? 1
        : pending
          ? 2
          : unknown
            ? 3
            : 4;
  return { counts: c, status, tone, rank, unknown, stale, pending };
}
export function fleetUpdateCounts(hosts: HostUpdates[]) {
  const active = hosts.filter((h) => !h.paused);
  return active.reduce(
    (r, h) => {
      const { counts: c, unknown } = updatePresentation(h);
      r.packages += c.total || 0;
      r.security += c.security || 0;
      r.images += c.images || 0;
      r.reboots += Number(h.snapshot?.packages.rebootRequired === true);
      r.unknown += Number(unknown);
      return r;
    },
    { packages: 0, security: 0, images: 0, reboots: 0, unknown: 0 },
  );
}
