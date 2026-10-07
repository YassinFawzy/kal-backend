import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Parallel e2e suites race `prisma migrate deploy` on the ALTER ROLE
    // migrations (P3018 'tuple concurrently updated', ephemeral-db.ts:174).
    // Pre-existing flake, verifier-reproduced on plain main (ledger §10,
    // eq-fix merge entry); serialized suites make the e2e gate deterministic.
    fileParallelism: false,
  },
});
