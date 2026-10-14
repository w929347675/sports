import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3001',
    browserName: 'chromium',
    headless: true,
  },
  webServer: [
    {
      command: 'npm run build && DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fitness-coach-e2e.XXXXXX") PORT=3001 npm run dev:server',
      url: 'http://127.0.0.1:3001/api/health',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'MOCK_AI_PORT=4321 npx tsx tests/e2e/mock-ai-server.ts',
      url: 'http://127.0.0.1:4321/test/state',
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});
