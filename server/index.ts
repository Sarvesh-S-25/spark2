import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from './env.js';
import { db } from './db/db.js';
import { registerApi } from './api.js';
import { providerReport } from './models/registry.js';

/**
 * The SparkX server.
 *
 * It runs as its own Node process rather than inside Electron's main process.
 * That is a deliberate change from the original plan: better-sqlite3 is a
 * native module, and compiling it against Electron's ABI on every machine is a
 * setup failure waiting to happen. As a sidecar it builds against plain Node,
 * which means `npm install` is the whole story on Windows, macOS and Linux —
 * and the app is equally usable in a browser tab, which makes development and
 * screen-sharing easier too.
 */
const app = Fastify({ logger: { level: 'warn' } });

await app.register(cors, { origin: true });
await registerApi(app);

// Serve the built UI when it exists, so `npm run app` needs one process.
const uiDist = resolve(process.cwd(), 'dist-ui');
if (existsSync(uiDist)) {
  await app.register(fastifyStatic, { root: uiDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ code: 'NO_SUCH_ROUTE', message: `${req.method} ${req.url} does not exist.` });
    }
    return reply.sendFile('index.html'); // client-side routing
  });
}

db(); // open and migrate before accepting a request

const report = await providerReport();
const active = report.providers.find((p) => p.id === report.defaultProvider);

await app.listen({ port: env.port, host: '127.0.0.1' });

console.log(`
  SparkX server   http://localhost:${env.port}
  database        ${resolve(process.cwd(), env.dbPath)}
  provider        ${report.defaultProvider} · ${active?.detail ?? 'unknown'}
  pass routing    A→${report.routing.A}  B→${report.routing.B}  C→${report.routing.C}
${existsSync(uiDist)
    ? `  ui              served from dist-ui — open the URL above`
    : `  ui              run "npm run dev:ui" (or "npm run dev" for both)`}
`);
