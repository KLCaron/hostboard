import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const common = {
  id: identifier, name: z.string().min(1).max(80), hostId: identifier,
  container: z.string().min(1).max(128).optional(),
  intervalSeconds: z.number().int().min(10).max(3600).default(60),
  timeoutMs: z.number().int().min(100).max(30000).default(5000),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  severity: z.enum(['warning', 'critical']).default('critical'),
  notify: z.boolean().default(true),
  cooldownSeconds: z.number().int().min(0).max(86400).default(900),
  // A component monitored by an independent watchdog should have one notification owner.
};
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('http'),
    url: z.url().refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash; }),
    expectedStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(50).default([200]),
    expectedContent: z.string().min(1).max(4096).optional(),
    followRedirects: z.boolean().default(false),
    watchdogHistory: z.boolean().default(false),
    headersEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  }).strict(),
  z.object({ ...common, type: z.literal('tcp'), address: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/), port: z.number().int().min(1).max(65535) }).strict(),
]);
export const ChecksSchema = z.object({
  checks: z.array(CheckSchema).max(100).default([]),
  minimumSeverity: z.enum(['warning', 'critical']).default('warning'),
}).strict().refine(c => new Set(c.checks.map(x => x.id)).size === c.checks.length, 'Check IDs must be unique');
export type CheckConfig = z.infer<typeof CheckSchema>;
export type ChecksConfig = z.infer<typeof ChecksSchema>;
export function loadChecks(hostIds: string[]) {
  const file = process.env.HOSTBOARD_CHECKS || 'config/checks.json';
  const config = ChecksSchema.parse(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  if (config.checks.some(c => !hostIds.includes(c.hostId))) throw new Error('Check refers to an unknown host');
  return config;
}
