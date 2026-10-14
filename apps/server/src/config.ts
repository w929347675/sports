import { resolve } from 'node:path';

export const JSON_BODY_LIMIT = 11 * 1024 * 1024;
export const MULTIPART_BODY_LIMIT = 11 * 1024 * 1024;

export type ServerConfig = {
  dataDir: string;
  port: number;
  host: string;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  return {
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    port,
    host: '127.0.0.1',
  };
}
