import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// AM-15 (M7) — version stamp: read once at build time from this workspace's
// own package.json (the single source of truth for the frontend's version —
// see app/README.md's version-bump note) rather than duplicating the string
// in a second place that could drift. Exposed to app code as the
// __APP_VERSION__ global (declared in src/vite-env.d.ts), NOT via
// import.meta.env — Vite's import.meta.env only surfaces VITE_-prefixed
// process env vars, not arbitrary build-time constants, so `define` is the
// correct mechanism here.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string };

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    // @avdmgr/shared is an npm-workspaces symlink (node_modules/@avdmgr/shared
    // -> ../../app/shared). With the default preserveSymlinks: false, Vite/
    // Rollup resolve that symlink to its real path (app/shared/dist/index.js),
    // which no longer contains "node_modules" in the path string — so
    // @rollup/plugin-commonjs's default include glob (matching /node_modules/)
    // stops matching it, and Rollup falls back to parsing the package's
    // CommonJS build output as if it were an ES module, failing with
    // "X is not exported by .../shared/dist/index.js" for any real (runtime,
    // not type-only) export. preserveSymlinks: true keeps the apparent
    // node_modules path, which restores correct CJS interop.
    preserveSymlinks: true,
  },
  server: {
    proxy: {
      // Local dev: proxy /api to the Azure Functions host (func start, default port 7071).
      '/api': {
        target: 'http://localhost:7071',
        changeOrigin: true,
      },
    },
  },
});
