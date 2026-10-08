import { buildApp } from './app.js';

function portFromEnvironment(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

const host = process.env.HOST ?? '127.0.0.1';
const port = portFromEnvironment(process.env.PORT);
const app = await buildApp({
  databasePath: process.env.DATABASE_PATH ?? './data/scheduler.sqlite',
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  app.log.info({ signal }, 'shutdown requested');
  try {
    await app.close();
  } catch (error: unknown) {
    app.log.error({ err: error }, 'graceful shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

try {
  await app.listen({ host, port });
} catch (error: unknown) {
  app.log.error({ err: error }, 'server failed to start');
  await app.close();
  process.exitCode = 1;
}
