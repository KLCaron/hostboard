// SPDX-License-Identifier: AGPL-3.0-only
export type UpdateState = "ok" | "stale" | "unsupported" | "unavailable";
export interface PackageUpdate {
  name: string;
  installed: string;
  available: string;
  security: boolean | null;
  sources: string[];
}
export interface PackageStatus {
  state: UpdateState;
  message: string;
  checkedAt: number | null;
  metadataAt: number | null;
  rebootRequired: boolean | null;
  manager: string;
  packages: PackageUpdate[];
}
export interface ImageUpdate {
  project: string;
  service: string;
  container: string;
  image: string;
  deployedImageId?: string;
  deployedManifest?: string | null;
  deployedConfig: string | null;
  deployedDigests: string[];
  platform: string;
  state: "current" | "update" | "pinned" | "local" | "unavailable";
  message: string;
  upstreamDigest: string | null;
  upstreamConfig: string | null;
  checkedAt: number | null;
}
export interface DockerStatus {
  state: UpdateState;
  message: string;
  checkedAt: number | null;
  services: ImageUpdate[];
}
export interface UpdateSnapshot {
  version: 1;
  collector?: { approvedRegistries: string[]; packageStaleSeconds: number };
  hostId: string;
  nodeGuid: string;
  collectedAt: number;
  packages: PackageStatus;
  docker: DockerStatus;
}
export interface UpdateCounts {
  total: number | null;
  ordinary: number | null;
  security: number | null;
  unknownSecurity: number;
  images: number | null;
}
export function updateCounts(s: UpdateSnapshot | null): UpdateCounts {
  const p = s?.packages,
    d = s?.docker;
  const known = !!p && ["ok", "stale"].includes(p.state);
  return {
    total: known ? p.packages.length : null,
    ordinary: known
      ? p.packages.filter((x) => x.security === false).length
      : null,
    security: known
      ? p.packages.filter((x) => x.security === true).length
      : null,
    unknownSecurity: p?.packages.filter((x) => x.security === null).length || 0,
    images:
      d && (d.state === "ok" || d.services.length > 0)
        ? new Set(
            d.services
              .filter((x) => x.state === "update")
              .map((x) => JSON.stringify([x.project, x.service])),
          ).size
        : null,
  };
}
export interface HostUpdates {
  preview?: {
    packages: Pick<PackageUpdate, "name" | "security">[];
    services: { project: string; service: string }[];
    unverifiedServices: number;
  };
  detailsIncluded?: boolean;
  counts?: UpdateCounts;
  hostId: string;
  name: string;
  groupId: string | null;
  archived: boolean;
  enabled: boolean;
  configured: boolean;
  paused: boolean;
  refreshing: boolean;
  lastAttemptAt: number | null;
  receivedAt: number | null;
  error: string | null;
  packageLastSuccessAt: number | null;
  dockerLastSuccessAt: number | null;
  snapshot: UpdateSnapshot | null;
}
