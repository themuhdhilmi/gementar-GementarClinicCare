import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * End-to-end tests run against a real PostgreSQL database, as the testing
 * strategy in documents/planning/02-architecture.md requires: the things worth
 * testing here (transactions, constraints, row-level security) are exactly the
 * things mocks cannot check.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One database, shared fixtures: run the suites in series.
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
  },
});
