import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/**
 * AM-15 (M7) — frontend test harness. Merges the app's OWN vite.config.ts
 * (react() plugin for JSX/TSX transform, preserveSymlinks for the
 * @avdmgr/shared npm-workspace symlink — see that file's comments — and the
 * __APP_VERSION__ build-time define Settings.tsx reads) rather than
 * duplicating it, so tests run against the same module resolution/transform
 * pipeline the real app build uses instead of a second, potentially
 * drifting config.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      restoreMocks: true,
      // AM-33 peer review (Opus, MINOR 7) — pins the test process's
      // timezone to UTC. Several lib/impactPreview.test.ts and
      // lib/format.ts assertions build a Date from a fixed ISO instant and
      // check the LOCAL day/time formatting (`formatShortDate`'s "15 Aug",
      // `formatTime`'s "1:00 PM") — without this, those assertions pass or
      // fail depending on the machine/CI runner's OS timezone (e.g. a
      // developer west of UTC-10 could see "14 Aug" for the exact same
      // instant a UTC runner reports as "15 Aug"). formatShortDate itself
      // is UNCHANGED (still genuinely local-time, matching every other
      // formatter in lib/format.ts) — this pins the OBSERVER's clock for
      // test determinism, not the app's own formatting behavior.
      env: {
        TZ: 'UTC',
      },
      // Peer review MINOR 16 — the default 5s per-test timeout was tight
      // enough that a slower CI runner (or a test doing several userEvent
      // interactions against Fluent's heavier components) could flake on
      // timing alone rather than an actual failure. 15s gives real headroom
      // without masking a genuinely hung test.
      testTimeout: 15000,
      include: ['src/**/*.test.{ts,tsx}'],
      // Fluent UI's focus-management dependency (tabster, pulled in via
      // @fluentui/react-tabster) ships a CJS build that Vitest's default
      // "externalize third-party deps and load via Node's ESM loader"
      // behavior interops with incorrectly ("does not provide an export
      // named 'createTabster'") — the same class of CJS/ESM interop gap
      // vite.config.ts's `preserveSymlinks` comment documents for
      // @avdmgr/shared, just hitting a different package under Vitest's
      // (not the production build's) module pipeline. Forcing these through
      // Vite's own transform (which the app's real build already relies on)
      // resolves it, same as it does for @rollup/plugin-commonjs in prod.
      server: {
        deps: {
          inline: [/tabster/, /@fluentui\//, /keyborg/],
        },
      },
    },
  }),
);
