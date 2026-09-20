import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * SWC rather than esbuild: Nest resolves constructor dependencies from
 * `design:paramtypes`, and esbuild does not emit decorator metadata.
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
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
