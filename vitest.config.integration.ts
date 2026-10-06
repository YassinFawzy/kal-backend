import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Integration / A-B-C isolation suites (task s4). DB-backed: every suite
 * creates its own ephemeral PostgreSQL database (`kal_it_*`), applies the full
 * migration history, and drops it. Canonical command: `pnpm test:integration`.
 *
 * The `.itspec.ts` suffix deliberately does not match the unit config (glob "*.spec.ts" at any depth)
 * or the e2e config ("*.e2e-spec.ts") — the suites only run through this config, where PostgreSQL is
 * available.
 *
 * `fileParallelism: false`: roles are cluster-scoped, so suites share
 * cluster-level state (`ALTER ROLE` in the role-contract migration) — suites
 * run sequentially to keep that state uncontended.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.itspec.ts'],
    fileParallelism: false,
    // Scratch-DB creation + full history apply takes seconds, not milliseconds.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
