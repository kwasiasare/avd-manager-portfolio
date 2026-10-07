// Basic monorepo-wide ESLint config (flat config). Run via `npm run lint`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    // .claude/ holds Claude Code session data incl. agent worktrees (full
    // repo copies with in-progress edits) — linting them is pure noise.
    // app/frontend/vite.config.js (+ .d.ts, already covered by '**/*.d.ts')
    // is tsc -b's own emitted-JS artifact for vite.config.ts (see that
    // project's tsconfig.node.json doc comment for why this one file isn't
    // noEmit) — gitignored build output, not a tracked source file, so it
    // must not be linted either (AM-15/M7: surfaced once vite.config.ts
    // itself started referencing a global — see that file's `new URL(...)`
    // — which the emitted .js has no environment globals configured for).
    ignores: ['**/dist/**', '**/dist-demo/**', '**/node_modules/**', '**/*.d.ts', '.claude/**', 'app/frontend/vite.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['app/frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    files: ['app/api/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['scripts/**/*.mjs', 'app/frontend/scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
