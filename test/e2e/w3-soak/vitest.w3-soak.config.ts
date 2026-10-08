/**
 * Kal — dedicated vitest config for the w3 soak harness (test/e2e/w3-soak/**).
 *
 * The soak runs as a STANDALONE headless invocation with its own file
 * suffix (`.soak-spec.ts`) that matches none of the canonical suite globs
 * (unit `*.spec.ts`, e2e `*.e2e-spec.ts`, integration `*.itspec.ts`) — per
 * the task contract the runner's invocation is documented in the MR and
 * re-run at GR, serialized like the other suites (one file; DB-bound).
 *
 *   pnpm vitest run --config test/e2e/w3-soak/vitest.w3-soak.config.ts
 */
import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export default defineConfig({
  root: repoRoot,
  plugins: [tsconfigPaths()],
  test: {
    include: ['test/e2e/w3-soak/**/*.soak-spec.ts'],
    globals: true,
    // Serialized (the suite posture): the soak boots its own AppModule and
    // ephemeral database; parallel workers would race the role migration.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
