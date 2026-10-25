export type HandlingMode = 'acknowledged' | 'snoozed' | 'ignored';
export interface IssueHandling {
  id: string;
  kind: 'metric' | 'availability';
  hostId: string;
  name: string;
  mode: HandlingMode;
  reason: string;
  actor: string;
  createdAt: number;
  until: number | null;
  revokedAt: number | null;
}
export interface HandlingView { revision: number; rules: IssueHandling[] }
