import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest harness for acp-stable renderer.
 *
 * Spec ref: `acp-dynamic-team-loading-v1-spec.md` §6 / §10 — first test
 * infra in this repo. Vite-native, mirrors the alias setup in `vite.config.ts`
 * so production imports (`@shared/types`) resolve in tests too.
 *
 * Run:  `npm test` (one-shot) or `npm run test:watch`
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    globals: false,
  },
});
