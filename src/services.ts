import type { Container, Host } from './types';
import { containerStatus } from './preferences';

export interface Availability {
  state: 'unchecked' | 'up' | 'down' | 'unknown';
  method: 'http' | 'tcp' | null;
  checkedAt: string | null;
  detail: string | null;
}
export interface Service {
  id: string;
  host: Host;
  container: Container;
  state: string;
  dockerHealth: string | null;
  availability: Availability;
}
// An independent HTTP/TCP provider can supply availability by service ID later.
// Container state and Docker health must never synthesize application availability.
export function servicesFromHosts(hosts: Host[], checks: Record<string, Availability> = {}): Service[] {
  return hosts.flatMap(host => host.containers.map(container => {
    const id = `${host.id}:${container.name}`;
    return {
      id, host, container, state: containerStatus(container, host.status === 'online'),
      dockerHealth: host.status === 'online' ? container.health : null,
      availability: checks[id] || { state: 'unchecked', method: null, checkedAt: null, detail: null },
    };
  }));
}
