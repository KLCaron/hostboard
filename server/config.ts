import { readFileSync } from 'node:fs';
import { z } from 'zod';
const HostSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().min(1).max(80),
  url: z.url().refine((value) => {
    const u = new URL(value);
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === '/'
    );
  }, 'Use an HTTP(S) Agent origin without credentials or a path'),
  node: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
  tokenEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
});
export const ConfigSchema = z
  .object({ hosts: z.array(HostSchema).min(1).max(20) })
  .refine(
    (c) => new Set(c.hosts.map((h) => h.id)).size === c.hosts.length,
    'Host ids must be unique',
  );
export type HostConfig = z.infer<typeof HostSchema>;
export function loadConfig() {
  return ConfigSchema.parse(
    JSON.parse(readFileSync(process.env.HOSTBOARD_CONFIG || 'config/hosts.json', 'utf8')),
  );
}
export function privateBind(address: string) {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    /^10\.(\d{1,3}\.){2}\d{1,3}$/.test(address) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(address) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(address)
  );
}
