import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Two projects share one Vitest invocation:
//
//   1. workers  — the existing backend pool. Runs every `tests/**/*.test.ts`
//      file inside the Cloudflare Workers pool with miniflare bindings.
//   2. frontend — happy-dom + React Testing Library. Runs every
//      `src/**/*.test.{ts,tsx}` file in a normal Node env so we can render
//      hooks/components without spinning up the workerd pool.
//
// `npm test` (vitest run) walks both. Adding a third project later (e.g.
// integration, e2e shim) is a matter of dropping another entry in here.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.toml' },
            miniflare: {
              bindings: {
                JWT_SECRET: 'test-jwt-secret-for-testing-only',
                RESEND_API_KEY: 'test-resend-key',
              },
              // Auxiliary workers hosted alongside the test runner.
              //
              // Production wrangler.toml binds SHEET_SESSION via
              // `script_name = "dox-sheet-session"` (cross-script DO —
              // Cloudflare Pages cannot host DO classes itself). Miniflare
              // cannot resolve cross-script bindings on its own in the test
              // pool, so we register a sibling worker here that hosts a stub
              // SheetSession class. Without this every test errors with:
              //   `binding "SHEET_SESSION" refers to a service "core:user:dox-sheet-session", but no such service is defined.`
              //
              // The stub lives in tests/helpers/sheet-session-stub.mjs (plain
              // JS so miniflare can load it without a TS transform). Tests
              // that need real DO behavior should compile the production
              // class to JS first.
              workers: [
                {
                  name: 'dox-sheet-session',
                  modules: true,
                  scriptPath: path.join(
                    __dirname,
                    'tests/helpers/sheet-session-stub.mjs',
                  ),
                  compatibilityDate: '2024-12-01',
                  durableObjects: {
                    SHEET_SESSION: {
                      className: 'SheetSession',
                    },
                  },
                },
              ],
            },
          }),
        ],
        test: {
          name: 'workers',
          globals: true,
          include: ['tests/**/*.test.ts'],
          setupFiles: ['tests/setup.ts'],
          testTimeout: 30_000,
          // Run test files sequentially — the Workers pool crashes under
          // parallel load.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'frontend',
          globals: true,
          environment: 'happy-dom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/setup.ts'],
          testTimeout: 10_000,
          // Sub-commit 0 ships the infra without any frontend tests yet.
          // Sub-commits A-C populate src/**/*.test.ts(x). Until then —
          // and any time we run --project frontend in isolation — don't
          // fail just because the include pattern matches nothing.
          passWithNoTests: true,
        },
      },
    ],
  },
});
