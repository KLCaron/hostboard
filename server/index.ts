import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, privateBind } from './config.js';
import { Agent, RANGES } from './netdata.js';
import type { Range } from '../src/types.js';
const agents = loadConfig().hosts.map((host) => new Agent(host));
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  });
  next();
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.get('/api/fleet', async (_req, res) =>
  res.json({
    hosts: await Promise.all(agents.map((agent) => agent.current())),
    generatedAt: new Date().toISOString(),
    refreshSeconds: 10,
  }),
);
app.get('/api/hosts/:id/history', async (req, res) => {
  const agent = agents.find((a) => a.config.id === req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Unknown host' });
    return;
  }
  const range = req.query.range ?? '1h';
  if (typeof range !== 'string' || !Object.hasOwn(RANGES, range)) {
    res.status(400).json({ error: 'Invalid time range' });
    return;
  }
  try {
    res.json(await agent.history(range as Range));
  } catch {
    res.status(502).json({ error: 'Agent history is unavailable' });
  }
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');
app.use(express.static(client, { maxAge: '1h', index: false }));
app.get('/', (_req, res) =>
  res.sendFile(path.join(client, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }),
);
const bind = process.env.HOSTBOARD_BIND || '127.0.0.1',
  port = Number(process.env.PORT || 3001);
if (!privateBind(bind))
  throw new Error('HOSTBOARD_BIND must be loopback, a private LAN address, or a VPN address');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be between 1024 and 65535');
// Same-host proxies can use localhost while browsers on the LAN use the
// configured private address. Never bind all interfaces to enable both.
const addresses = bind === '127.0.0.1' || bind === '::1' ? [bind] : [bind, '127.0.0.1'];
const servers = addresses.map((address) =>
  app.listen(port, address, () =>
    console.log(`Hostboard listening on ${address}:${port}; ${agents.length} hosts configured`),
  ),
);
process.on('SIGTERM', () => {
  let remaining = servers.length;
  for (const server of servers) {
    server.close(() => {
      if (--remaining === 0) process.exit(0);
    });
  }
});
