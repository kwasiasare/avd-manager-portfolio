// `npm run dev:demo` — vite dev server with the in-memory demo transport; makes no /api or /.auth requests.
import { runVite } from './run-vite-demo.mjs';

process.exit(runVite(process.argv.slice(2)));
