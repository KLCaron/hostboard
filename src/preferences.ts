import type { Container } from './types';
export function readPreference<T>(key: string, fallback: T, valid: (value: unknown) => boolean = () => true): T {
  try { const value = JSON.parse(localStorage.getItem(`hostboard:${key}`) || 'null'); return value !== null && valid(value) ? value : fallback; }
  catch { return fallback; }
}
export function savePreference(key: string, value: unknown) {
  try { localStorage.setItem(`hostboard:${key}`, JSON.stringify(value)); } catch { /* Private browsing may disable storage. */ }
}
export type Sort = 'name' | 'cpu' | 'memory';
export function sortContainers(containers: Container[], sort: Sort) {
  return [...containers].sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name) :
    (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity) || a.name.localeCompare(b.name));
}
export function containerStatus(c: Container, online: boolean) {
  if (!online) return 'unknown';
  if (c.state === 'running' && c.health === 'unhealthy') return 'unhealthy';
  if (['exited','stopped','dead'].includes(c.state)) return 'stopped';
  return c.state === 'running' ? 'running' : c.state || 'unknown';
}
