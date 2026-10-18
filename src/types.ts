export type Status = 'online' | 'offline' | 'stale';
export type Range = '15m' | '1h' | '6h' | '24h';
export interface Disk {
  id: string;
  mount: string;
  filesystem: string;
  used: number | null;
  total: number | null;
  available: number | null;
  percent: number | null;
}
export interface Container {
  name: string;
  image: string;
  state: string;
  health: string | null;
  cpu: number | null;
  memory: number | null;
  network: { received: number | null; sent: number | null };
  io: { read: number | null; write: number | null };
}
export interface Sensor {
  id: string;
  group: string;
  name: string;
  value: number | null;
}
export interface Alert {
  name: string;
  summary: string;
  severity: 'warning' | 'critical';
  count: number;
}
export interface Host {
  id: string;
  name: string;
  hostname: string;
  status: Status;
  lastSeen: string | null;
  checkedAt: string;
  error: string | null;
  os: string | null;
  version: string | null;
  cores: number | null;
  uptime: number | null;
  cpu: number | null;
  load: number[] | null;
  memory: { used: number | null; total: number | null; percent: number | null };
  network: { received: number | null; sent: number | null };
  io: { read: number | null; write: number | null };
  disks: Disk[];
  containers: Container[];
  dockerAvailable: boolean;
  sensors: Sensor[];
  alerts: Alert[] | null;
  warnings: string[];
}
export interface Fleet {
  hosts: Host[];
  generatedAt: string;
  refreshSeconds: number;
}
export interface Point {
  time: number;
  cpu: number | null;
  memory: number | null;
  received: number | null;
  sent: number | null;
  read: number | null;
  write: number | null;
  load: number | null;
}
export interface History {
  hostId: string;
  range: Range;
  points: Point[];
  fetchedAt: string;
  errors: string[];
  cpuPeaks?: { time: number; value: number | null }[];
}
