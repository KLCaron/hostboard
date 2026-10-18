import net from 'node:net';
import { performance } from 'node:perf_hooks';
import type { CheckConfig } from './check-config.js';
import { z } from 'zod';
const RemoteHistory = z.array(z.object({
  id: z.number().int().positive(), name: z.string().max(160), startedAt: z.number().finite().positive(),
  detectedAt: z.number().finite().positive(), endedAt: z.number().finite().positive().nullable(),
  reason: z.string().max(2048), lastReason: z.string().max(2048),
  notifications: z.array(z.object({ event: z.enum(['outage', 'recovery']), state: z.enum(['pending', 'failed', 'delivered', 'disabled']), attempts: z.number().int().nonnegative(), lastAttempt: z.number().finite().nullable(), deliveredAt: z.number().finite().nullable(), error: z.string().max(256).nullable() })).max(2),
})).max(100);
export type WatchdogHistory = z.infer<typeof RemoteHistory>;

export interface ProbeResult { ok: boolean | null; responseMs: number | null; reason: string; watchdogHistory?: WatchdogHistory }
const MAX_BODY = 1024 * 1024;
export async function probe(check: CheckConfig): Promise<ProbeResult> {
  const start = performance.now();
  if (check.type === 'tcp') return new Promise(resolve => {
    const socket = net.createConnection({ host: check.address, port: check.port });
    let done = false;
    const finish = (ok: boolean, reason: string) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve({ ok, responseMs: performance.now() - start, reason }); };
    const timer = setTimeout(() => finish(false, 'TCP connection timed out'), check.timeoutMs);
    socket.once('connect', () => finish(true, 'TCP connection accepted; application functionality not verified'));
    socket.once('error', () => finish(false, 'TCP connection failed'));
  });
  let headers: Record<string, string> = {};
  if (check.headersEnv) {
    try {
      const value = JSON.parse(process.env[check.headersEnv] || '');
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error();
      headers = value;
    } catch { return { ok: null, responseMs: null, reason: 'Monitor request headers are unavailable or invalid' }; }
  }
  const signal = AbortSignal.timeout(check.timeoutMs);
  try {
    let url = new URL(check.url);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(url, { headers, signal, redirect: 'manual' });
      if (!check.followRedirects || ![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return { ok: false, responseMs: performance.now() - start, reason: 'HTTP redirect has no destination' };
      const next = new URL(location, url);
      // Prevent credentials crossing origins and authenticated checks silently becoming login checks.
      if (next.origin !== new URL(check.url).origin || next.username || next.password) return { ok: false, responseMs: performance.now() - start, reason: 'Cross-origin redirect rejected' };
      if (redirects === 5) return { ok: false, responseMs: performance.now() - start, reason: 'Too many HTTP redirects' };
      url = next;
    }
    const status = response!.status;
    if (!check.expectedStatuses.includes(status)) { await response!.body?.cancel(); return { ok: false, responseMs: performance.now() - start, reason: `Unexpected HTTP status ${status}` }; }
    let watchdogHistory: WatchdogHistory | undefined;
    if (check.expectedContent || check.watchdogHistory) {
      const reader = response!.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      if (reader) try {
        while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > MAX_BODY) return { ok: false, responseMs: performance.now() - start, reason: 'HTTP content exceeds 1 MiB inspection limit' }; chunks.push(value); }
      } finally { await reader.cancel(); }
      const body = Buffer.concat(chunks).toString('utf8');
      if (check.expectedContent && !body.includes(check.expectedContent)) return { ok: false, responseMs: performance.now() - start, reason: 'Expected HTTP response content missing' };
      if (check.watchdogHistory) {
        try { watchdogHistory = RemoteHistory.parse(JSON.parse(body).incidents); }
        catch { return { ok: null, responseMs: performance.now() - start, reason: 'Independent watchdog history is invalid' }; }
      }
    } else await response!.body?.cancel();
    return { ok: true, responseMs: performance.now() - start, reason: `HTTP ${status}; configured response check passed`, watchdogHistory };
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code || '';
    return { ok: false, responseMs: performance.now() - start, reason: signal.aborted ? 'HTTP request timed out' : /CERT|TLS|SSL/.test(code) ? 'TLS certificate or handshake failed' : 'HTTP connection failed' };
  }
}
