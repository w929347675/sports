import { buildApp, getConfig } from './app.js';

type ClosableApp = {
  close: () => Promise<unknown>;
  listen?: (options: { host: string; port: number }) => Promise<unknown>;
  log?: { error: (error: unknown) => void };
};

export function createShutdownHandler(app: Pick<ClosableApp, 'close'>) {
  let closing: Promise<unknown> | undefined;
  return () => {
    closing ??= app.close();
    return closing;
  };
}

const config = getConfig();
const app = await buildApp(config);
const shutdown = createShutdownHandler(app);
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
