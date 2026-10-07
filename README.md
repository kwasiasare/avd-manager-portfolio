# AVD Manager (portfolio edition)

A web operations console for Azure Virtual Desktop. It gives an operator one place to manage:

- **Host pools and session hosts**: health, drain mode, power, guided provisioning, staged rollouts
- **Sessions**: search, message, log off, broadcast
- **Images**: Azure Compute Gallery versions and a guided golden-image build workflow
- **Scaling**: scaling plan schedules, history, emergency overrides
- **Cost**: spend by resource group, idle-host detection, savings estimates
- **FSLogix profiles**: size, orphan and duplicate detection, restore and retire
- **Monitoring**: curated Log Analytics (KQL) views, alerts with acknowledge/snooze
- **Governance**: read-only posture checks (locks, tags, private endpoints, Conditional Access break-glass)
- **Audit**: an append-only record of every mutating action, with operator-supplied reasons

This repository is a sanitized copy of a private codebase with a fresh history. It contains no client identifiers; all resource names in tests and examples are fictional (`Contoso`).

## Architecture

| Layer | Technology |
| --- | --- |
| Frontend | React 18 + Fluent UI v9 single-page app on Azure Static Web Apps |
| API | Azure Functions v4 (Node.js 22, TypeScript) on the Flex Consumption plan |
| Identity | Entra ID sign-in via Static Web Apps; API uses a managed identity with scoped, custom RBAC roles (no secrets) |
| Shared | `@avdmgr/shared`: request/response types and pure helpers used by both sides |
| Infrastructure | Bicep (`infra/main.bicep`, `infra/modules/`), including least-privilege custom role definitions |

Roles (viewer, operator, admin) are mapped from Entra group membership and enforced independently in the API. See [`app/README.md`](app/README.md) for the detailed design notes and [`app/docs/DESIGN-SYSTEM.md`](app/docs/DESIGN-SYSTEM.md) for UI conventions.

```
app/
  api/        Azure Functions (HTTP + timer triggers), services, tests
  frontend/   Vite + React SPA
  shared/     Types shared by api and frontend
infra/        Bicep templates and modules
scripts/      Repository tooling (denylist scanner)
```

## Local development

Prerequisites: Node.js 22, npm 10+, [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local), [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) for table storage.

```bash
npm ci
npm run build        # shared -> api -> frontend
npm run lint
npm test             # shared, api, frontend and script tests
npm run scan         # denylist / GUID scanner
```

Run the API: copy `app/api/local.settings.json.example` to `app/api/local.settings.json`, fill in your own estate values (the estate-specific names are required settings with no defaults), then `cd app/api && func start`. Run the frontend: `npm run dev --workspace=app/frontend` (proxies `/api` to `localhost:7071`). Set `VITE_HOSTPOOL_NAME` to point the UI at your host pool.

`npm run build` renders `staticwebapp.config.json` into `app/frontend/dist`, substituting `SWA_TENANT_ID` for the `__SWA_TENANT_ID__` placeholder (a warning is printed if it is unset).

### Sanitization scanner

`npm run scan` fails if the tree contains denylisted identifiers or any GUID not in `scripts/guid-allowlist.txt`. CI uses the committed generic patterns (`scripts/denylist.example.txt`). Maintainers can add a private list via `DENYLIST_FILE=<path>` or a gitignored `scripts/denylist.local.txt`.

## Demo

_Coming soon: a demo mode with synthetic data and screenshots._

## License

MIT. See [LICENSE](LICENSE).
