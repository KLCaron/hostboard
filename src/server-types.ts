export interface DiscoveredNode {
  guid: string;
  nodeId: string | null;
  hostname: string;
  state: string;
}
export interface ServerDiscovery {
  guid: string;
  nodeId: string | null;
  hostname: string;
  os: string | null;
  kernel: string | null;
  cpuModel: string | null;
  cores: number | null;
  memoryBytes: number | null;
  version: string | null;
  contexts: string[];
  categories: string[];
  collectors: string[];
  filesystems: { id: string; mount: string; filesystem: string }[];
  interfaces: string[];
  sensors: string[];
  chartCount: number;
  discoveredAt: string;
  warnings: string[];
}
export interface ManagedServer {
  id: string;
  name: string;
  url: string;
  node: string;
  guid: string | null;
  enabled: boolean;
  archived: boolean;
  groupId: string | null;
  discovery: ServerDiscovery | null;
  lastSeen: string | null;
}
export interface ServerGroup {
  id: string;
  name: string;
}
