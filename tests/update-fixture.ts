// SPDX-License-Identifier: AGPL-3.0-only
import type { UpdateSnapshot } from "../src/update-types.js";
export const updateSample = (
  id = "host",
  now = Date.now() / 1000,
): UpdateSnapshot => ({
  version: 1,
  hostId: id,
  nodeGuid: "guid-" + id,
  collectedAt: now,
  packages: {
    state: "ok",
    message: "Existing cache",
    checkedAt: now,
    metadataAt: now,
    rebootRequired: true,
    manager: "apt",
    packages: [
      {
        name: "libexample",
        installed: "1.0",
        available: "1.1",
        security: true,
        sources: ["Ubuntu/noble-security/main/security.ubuntu.com"],
      },
      {
        name: "ordinary",
        installed: "2",
        available: "3",
        security: false,
        sources: [],
      },
    ],
  },
  docker: {
    state: "ok",
    message: "Read only",
    checkedAt: now,
    services: [
      {
        project: "web",
        service: "app",
        container: "a".repeat(64),
        image: "example:latest",
        deployedConfig: "sha256:" + "a".repeat(64),
        deployedDigests: ["example@sha256:" + "c".repeat(64)],
        platform: "linux/amd64",
        state: "update",
        message: "Digest comparison",
        upstreamDigest: "sha256:" + "b".repeat(64),
        upstreamConfig: "sha256:" + "b".repeat(64),
        checkedAt: now,
      },
    ],
  },
});
