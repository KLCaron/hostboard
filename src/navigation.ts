export const pages = ['overview', 'servers', 'services', 'issues', 'settings'] as const;
export type Page = typeof pages[number];
export function resolveNavigation(hash: string, pathname = '/') {
  const value = hash.slice(1) || pathname.replace(/^\/+|\/+$/g, '');
  const [key, search = ''] = value.split('?');
  if (key.startsWith('host=')) return { page: 'servers' as Page, host: key.slice(5) };
  if (key.startsWith('service=')) return { page: 'services' as Page, service: key.slice(8) };
  if (key.startsWith('incident=')) return { page: 'issues' as Page, incident: Number(key.slice(9)) };
  if (key.startsWith('alert=')) return { page: 'issues' as Page, alert: key.slice(6) };
  if (key === 'alerts') return { page: 'issues' as Page, canonical: '#issues?type=metric' };
  if (key === 'incidents') return { page: 'issues' as Page, canonical: '#issues?tab=history&type=availability' };
  return { page: pages.includes(key as Page) ? key as Page : 'overview' as Page, search };
}
