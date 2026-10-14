import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@fitness-coach/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@fitness-coach/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      '@fitness-coach/ai': fileURLToPath(new URL('./packages/ai/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/*/src/**/*.test.tsx'],
  },
});
