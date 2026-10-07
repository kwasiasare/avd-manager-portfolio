// Renders staticwebapp.config.json into the build output, substituting the
// __SWA_TENANT_ID__ placeholder with the SWA_TENANT_ID environment variable.
// If SWA_TENANT_ID is unset the placeholder is left in place and a warning is
// printed (the build still succeeds; the resulting config is not deployable).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../public/staticwebapp.config.json');
const outDir = resolve(here, '../dist');
const out = resolve(outDir, 'staticwebapp.config.json');
const PLACEHOLDER = '__SWA_TENANT_ID__';

export function render(template, tenantId) {
  return tenantId ? template.split(PLACEHOLDER).join(tenantId) : template;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tenantId = (process.env.SWA_TENANT_ID ?? '').trim();
  if (!tenantId) {
    console.warn(`[render-swa-config] WARNING: SWA_TENANT_ID is not set; leaving ${PLACEHOLDER} in place. Set it before deploying.`);
  } else if (!GUID.test(tenantId)) {
    console.error('[render-swa-config] SWA_TENANT_ID is not a valid GUID.');
    process.exit(1);
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(out, render(readFileSync(src, 'utf-8'), tenantId));
  console.log(`[render-swa-config] wrote ${out}`);
}
