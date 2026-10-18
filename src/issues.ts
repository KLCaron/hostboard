import type { CheckView, IncidentView, MonitorView } from './monitor-types';
import type { AlertDetail } from './investigation-types';
import type { Host } from './types';
export type IssueType = 'metric' | 'availability' | 'notification';
export interface Issue {
  id: string; type: IssueType; name: string; severity: string; hostId: string; serviceId?: string;
  status: 'active' | 'resolved' | 'retired'; time: number | null;
  incident?: IncidentView; alert?: AlertDetail; host?: Host;
}
export interface IssueFilters { tab: string; type: string; severity: string; host: string; service: string; status: string }
export const defaultFilters: IssueFilters = { tab: 'active', type: 'all', severity: 'all', host: 'all', service: 'all', status: 'all' };
export function filterIssues(issues: Issue[], f: IssueFilters) {
  return issues.filter(i => (f.tab === 'active' ? i.status === 'active' : i.status !== 'active') &&
    (f.type === 'all' || i.type === f.type) && (f.severity === 'all' || i.severity === f.severity) &&
    (f.host === 'all' || i.hostId === f.host) && (f.service === 'all' || i.serviceId === f.service) &&
    (f.status === 'all' || i.status === f.status)).sort((a,b)=>(b.time ?? 0)-(a.time ?? 0));
}
export function availabilityIssues(incidents: IncidentView[]): Issue[] {
  // The same persistent incident may be present in the active, paginated and linked responses.
  return [...new Map(incidents.map(i=>[i.id,i])).values()].map(i=>({id:`incident-${i.id}`,type:'availability',name:i.name,severity:i.severity,hostId:i.hostId,serviceId:i.checkId,status:i.endedAt === null ? 'active' : i.resolution === 'Reachability restored' ? 'resolved' : 'retired',time:i.endedAt ?? i.startedAt,incident:i}));
}
export function notificationIssues(data?: MonitorView): Issue[] {
  return data?.notifications.failed ? [{id:'notification-delivery',type:'notification',name:'SMTP delivery needs attention',severity:'warning',hostId:'',status:'active',time:null}] : [];
}
export function activeIssueCount(hosts: Host[], data?: MonitorView) {
  return hosts.reduce((n,h)=>n+(h.alerts?.reduce((sum,a)=>sum+a.count,0) ?? 0),0) +
    availabilityIssues(data?.activeIncidents ?? data?.incidents ?? []).filter(i=>i.status==='active').length + notificationIssues(data).length;
}
export function serviceGroup(c: Pick<CheckView, 'id' | 'name' | 'type' | 'group'>): 'Applications' | 'Infrastructure' {
  if(c.group) return c.group;
  return c.type === 'tcp' || /\b(netdata|hostboard|watchdog|ssh)\b/i.test(`${c.id} ${c.name}`) ? 'Infrastructure' : 'Applications';
}
