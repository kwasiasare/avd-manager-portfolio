# AVD Manager App

**v1.0.0** — feature-complete through M7 (hardening). Web application for
managing the Azure Virtual Desktop (AVD) environment: host pools, session
hosts, user sessions, golden images, cost & autoscaling, access, FSLogix
profiles, monitoring, governance, and audit.

## Milestones (M1–M7)

Each milestone shipped as a reviewed, user-tested slice merged onto the
previous one — see the individual `## ` sections below (and the AM-*
commit/Jira history) for the full detail behind each summary.

| Milestone | What it added | Key surfaces |
| --- | --- | --- |
| **M1** | Read-only Dashboard, host pool/session host health, first production deploy (SWA + linked Flex Consumption Function App, Entra ID auth via `/api/roles`) | `GET /v1/health/summary`, Dashboard |
| **M2** | The mutation foundation every later write reuses — role gating (`requireMinimumRole`), the `AuditLog` table, correlation IDs — plus session-host drain/power, force logoff/send-message/logoff-disconnected/broadcast | See "Mutations" below |
| **M3 / M3b** | Scaling plan editor (ramp schedule timeline, per-day-of-week overrides, emergency override), the Alert & Log center (see "Monitoring & logs" below), the Cost & Scaling dashboard (spend by resource group, idle-host detector, host runtime), and the Governance panel (10 independently-degrading posture checks: Key Vault purge protection, orphaned resources, diagnostic settings coverage, Conditional Access break-glass exclusion, and others — see `app/api/src/services/governance/registry.ts`) | Cost & Scaling page, Governance page |
| **M4** | Golden image lifecycle: full version-history timeline with host-to-version correlation, orphaned-snapshot report, an in-app image BUILD orchestrator (a resumable-by-construction Table-backed state machine — see `app/api/src/services/imageBuildOrchestrator.ts`), and a staged, operator-gated ROLLOUT plan (multi-state machine draining/cutting-over/removing old hosts — see `app/api/src/services/rolloutPlanService.ts`) | Images page (timeline + build wizard + rollout wizard + snapshots) |
| **M5** | FSLogix profile management — list active/retired profile VHD(X)s off the storage account's FileREST API (not just the management-plane share stats), orphan detection cross-checked against the AVD-Users Entra group, lock/open-handle detection, reset (rename-to-retired)/restore/delete-retired | Profiles page, `GET/POST /v1/profiles*` |
| **M6** | Users & Access — Graph-backed user/group search, grant/revoke "Desktop Virtualization User" on the desktop application group (role definition GUID pinned server-side and ABAC-enforced — never caller-supplied), workspace friendly-name edit | Users & Access page, `/v1/access/*` |
| **M7** | Hardening + v1.0 release (this milestone) — Settings page (resolved access, non-secret config surface, links), a three-way theme toggle (system/light/dark, persisted), the frontend's first real test harness (vitest + Testing Library), a 404 catch-all, a cold-start hint on first load, and a security/consistency sweep (NaN-guarded config reads, no raw upstream error text, `truncated` flags on capped list responses, tooltip/aria-label fixes) | Settings page, this README, `CHANGELOG.md` |

Current versions: `app/frontend`, `app/api`, and `app/shared` are all at
**1.0.0** (see each workspace's `package.json`); the running API's version is
also surfaced anonymously at `GET /v1/health` and to any signed-in viewer+ at
`GET /v1/settings`, and the frontend's own build version is shown on the
Settings page (`app/frontend/src/pages/Settings.tsx`, sourced from
`app/frontend/package.json` via a Vite build-time `define` — see
`vite.config.ts`).

### `GET /v1/health` and `GET /v1/settings` — API reference

`GET /v1/health` (anonymous) and `GET /v1/settings` (viewer+) both report
this app's own version, but from two different, explicitly-labeled sources
— see `app/api/src/lib/buildInfo.ts`:

- **`GET /v1/health`** — anonymous, no auth required.
  ```json
  {
    "status": "ok",
    "version": "1.2.0",
    "gitSha": "1a2b3c4d5e6f7890abcdef1234567890abcdef12",
    "builtAt": "2026-08-22T14:03:11.000Z",
    "versionSource": "artifact"
  }
  ```
  `gitSha`/`builtAt` are omitted entirely (not `null`) when unavailable —
  see `versionSource` below.
- **`GET /v1/settings`** — viewer+ (see "Roles" above). Same version fields
  under `apiVersion`/`gitSha`/`builtAt`/`versionSource`, alongside the
  non-secret config slice described below.
- **`versionSource`** — `'artifact'` when `version`/`apiVersion` came from
  the CI-stamped `version.json` shipped inside the deployed package
  (written by the API deploy pipeline's — not part of this repository — "Assemble self-contained
  API package" step, AM-54); `'app-setting'` when it
  instead fell back to the operator-maintained `API_VERSION` app setting —
  local dev (no CI-assembled package on disk) and any environment
  predating AM-54 both report `'app-setting'`. **Why this matters**:
  before AM-54, both endpoints reported ONLY the app setting, which had
  quietly drifted from the actually-running code (prod reported `1.0.0`
  all the way through the 1.1.x line) — `versionSource` makes it
  impossible to mistake a stale app setting for a build-verified version
  again.

## Architecture

- **Frontend** (`app/frontend`) — React 18 + TypeScript + Vite SPA, deployed to an
  **Azure Static Web App (SWA)**. Routing/auth/role gating are client-side; SWA
  EasyAuth with a **custom Entra ID provider** (registration in
  `staticwebapp.config.json` — custom, not the built-in provider, because
  `rolesSource: /api/roles` only fires with custom authentication) provides the
  signed-in identity via `/.auth/me`, and role assignment comes from Entra group
  membership resolved by `/api/roles` (see `docs/app-registration.md`).
- **API** (`app/api`) — Azure Functions v4 (TypeScript, Node), deployed as a
  **Function App linked to the SWA** (`skip_api_build`/linked-backend model — the SWA
  proxies `/api/*` to it). The Function App uses a **system-assigned managed identity**
  with least-privilege RBAC (Reader/Desktop Virtualization roles etc. — see
  `infra/modules/rbac.bicep`) to call ARM/Monitor/Storage APIs, so no secrets are
  stored for talking to Azure. The Function App is **VNet-integrated** into
  `SNET-MANAGEMENT` in `VNET-CONTOSO-PROD` (existing network, `RG-AVD-Network`) so it can
  reach private endpoints (storage, Log Analytics private link, etc.) where applicable.
- **Shared** (`app/shared`) — `@avdmgr/shared`, a types-only workspace exporting the
  DTO interfaces used on the wire between frontend and API, so both sides stay in
  sync on shape (host pools, session hosts, sessions, images, scaling, cost, profiles,
  alerts, audit entries, roles, errors).

```
Browser --(SWA EasyAuth, Entra ID)--> Static Web App (frontend, staticwebapp.config.json)
                                          |
                                          v  /api/* (linked backend)
                                     Function App (app/api)
                                       - system-assigned MI
                                       - VNet-integrated -> SNET-MANAGEMENT
                                          |
                                          v
                       ARM (AVD, Compute) / Monitor / Storage / Tables
```

## Roles

Three roles are used throughout the app (`viewer` < `operator` < `admin`), sourced
from SWA `clientPrincipal.userRoles`, which in turn come from Entra ID group
membership mapped to SWA roles (see `docs/app-registration.md`). The API
independently re-checks roles server-side (`app/api/src/lib/auth.ts`) — the
frontend's `RoleGate` component is a UI convenience only, not a security boundary.

Mutating routes (the first is the M2-S1 session-host drain toggle below) call
`requireMinimumRole(request, 'operator', context)` instead of `requireRole`
directly — a thin wrapper that expands "operator" to `['operator', 'admin']`
using the same hierarchy, so a viewer (or unauthenticated caller) gets a
403/401 before any Azure mutation is attempted.

A signed-in user can see their own resolved UPN + role set (and a short
explanation of how group membership maps to roles) on the **Settings** page
— `GET /v1/settings` (viewer+, `app/api/src/functions/settings.ts`) also
surfaces a deliberately narrow, non-secret slice of this app's own config
(host pool/workspace/DAG names, the FSLogix storage account + share, the
oversized-profile threshold, and CONFIGURED/NOT-CONFIGURED status — never the
value — of the three role-mapping group ids). See `@avdmgr/shared`'s
`SettingsResponse` doc comment for exactly what's excluded and why.

## Mutations (M2 — in progress)

M2-S1 (AM-18) laid the foundation every later mutation reuses:

- **Role gating**: `requireMinimumRole` (`app/api/src/lib/auth.ts`), described above.
- **Audit log**: every mutating handler writes one row — actor UPN, stable
  `actorId` (Entra object ID), action, target, `parameters` (what actually
  changed, e.g. `{ allowNewSession: false }`, JSON-stringified), optional
  reason (server-capped at 1000 chars), outcome, correlationId, and
  `occurredAt` — to an `AuditLog` Azure Table on the Function App's own
  storage account, via `app/api/src/lib/auditLog.ts` (`@azure/data-tables` +
  the Function App's managed identity — no secrets). The entity field is
  named `occurredAt`, never `timestamp` — the latter collides with Azure
  Table Storage's own server-managed `Timestamp` property and is silently
  discarded on insert. Every event is ALSO emitted as a structured
  `AUDIT_EVENT` line to Application Insights/Log Analytics (a tamper-
  resistant second copy the Function App's identity cannot delete); a Table
  write failure logs `AUDIT_WRITE_FAILED` via `context.error` but is never
  thrown to the caller — it must not turn a successful mutation into an
  error response. **Fail-closed**: if a deployed environment
  (`WEBSITE_SITE_NAME` set) has no `AUDIT_STORAGE_ACCOUNT_NAME` configured,
  mutating handlers return 500 *before* mutating anything, rather than
  silently running unaudited — local dev (no `WEBSITE_SITE_NAME`) keeps the
  skip-and-log behavior so mutation testing doesn't require a real storage
  account.
- **Correlation**: a `correlationId` is generated once at the top of each
  mutating request and threaded through the error response body, every
  `context.log`/`context.error` line, and both the success and failure
  audit rows — a support ticket referencing it can be joined straight back
  to the audit record.
- **RBAC**: the Function App's managed identity holds TWO custom roles, kept
  deliberately separate rather than merged into one broader grant:
  - `infra/modules/sessionHostWriterRole.bicep` ("AVD Manager Session Host
    Writer", AM-18), scoped to `RG-AVD-HostPools`, granting only
    `hostpools/read` + `hostpools/sessionhosts/{read,write}` — narrower than
    the built-in "Desktop Virtualization Session Host Operator" role, which
    also grants `sessionhosts/delete` and the whole `usersessions/*` subtree.
  - `infra/modules/hostPoolRegistrationRole.bicep` ("AVD Manager Host Pool
    Registration", AM-22), also scoped to `RG-AVD-HostPools`, granting
    `hostpools/read` + `hostpools/write` +
    `hostpools/retrieveRegistrationToken/action` — needed because generating
    a registration token is a host-pool-level PATCH
    (`registrationInfo.registrationTokenOperation: 'Update'`), not a
    session-host-level write. Kept as its own role instead of widening
    Session Host Writer above, since `hostpools/write` can change ANY
    patchable host pool property (`maxSessionLimit`, `vmTemplate`,
    `customRdpProperty`, etc.), not just `registrationInfo` — bundling it
    into the narrower drain-toggle role would have silently widened that
    role's own footprint.

  Both roles are granted to the same single managed identity (this app has
  only one Azure principal for all API routes); which app ROLE (viewer /
  operator / admin) can trigger which route is enforced at the application
  layer (`requireMinimumRole` / `requireRole`), independent of Azure RBAC.
- **First mutation**: `PATCH /api/v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/drain`
  toggles `allowNewSession` via `@azure/arm-desktopvirtualization`. Exposed on
  the Host Pool page as a per-host Drain/Resume button, rendered only for
  operator/admin (no empty column for viewers), behind a confirm dialog with
  an optional reason (capped at 1000 chars client- and server-side) that is
  passed through to the audit log. Errors surface inside the still-open
  dialog; success closes the dialog and shows a dismissible page-level
  success message.
- **Registration token generator + Add session host panel (AM-22/M2-S5)**:
  `POST /api/v1/hostpools/{hostPoolName}/registration-token` (admin-only —
  `requireMinimumRole('admin')`, stricter than the operator floor above,
  since the returned token is a standing bearer credential that can register
  a new session host into the pool until it expires) generates/rotates the
  token via ARM's `hostPools.update` with
  `registrationInfo.registrationTokenOperation: 'Update'`; the token value is
  audited NEVER (only `{ hoursValid, expirationTime }` is), never logged, and
  never persisted — it is returned to the caller exactly once, with
  `Cache-Control: no-store` on that response. `GET` on the same route
  (operator-minimum) returns status only (`{ exists, expirationTime }`) via
  ARM's `hostPools.retrieveRegistrationToken` action — never the token value
  — because a plain `hostPools.get` reads `registrationInfo` back as `null`
  even with an active token (see
  `the session-host runbook` §3). Both GET and POST share one
  `app.http` registration with an internal method dispatcher
  (`app/api/src/functions/hostPoolRegistrationToken.ts`), not two separate
  same-route registrations, to sidestep a same-route-registration override
  issue in the Node v4 programming model
  (Azure/azure-functions-nodejs-library#98). A companion read-only
  `GET /api/v1/hostpools/{hostPoolName}/vm-template` (operator-minimum)
  best-effort-parses the host pool's `vmTemplate` JSON string (ARM publishes
  no schema for it — see the `VmTemplateInfo` DTO in `@avdmgr/shared`). All
  three power the HostPool page's "Add session host" panel
  (`AddSessionHostPanel.tsx`): generate/copy the token with an expiry
  countdown and a "shown once" warning, view the prefilled VM parameters,
  and follow a guided checklist pointing at
  `the session-host runbook` — VM provisioning itself is
  explicitly out of scope for this app today. **Deferred follow-up**: a
  DELETE/revoke route (`registrationTokenOperation: 'Delete'`) to let an
  admin explicitly invalidate a live token from the panel, rather than only
  waiting for it to expire or generating a superseding one.

M2-S2 (AM-19) adds host power operations on top of the same foundation:

- **Endpoint**: `POST /api/v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/power`
  with body `{ action: 'start' | 'restart' | 'deallocate', reason?, activeSessions? }`,
  guarded by the same `requireMinimumRole('operator')`. Resolves the session
  host's underlying VM (`avdService.resolveSessionHostVm`, via ARM
  `sessionHosts.get` — also the source of the AUTHORITATIVE, server-observed
  session count) and calls the matching `@azure/arm-compute` `VirtualMachines`
  start/restart/deallocate.
- **202-accepted contract**: the handler awaits only the ARM long-running
  operation's initial submission (`poller.submitted()`, bounded by a 20s
  `AbortSignal.timeout`), never its completion (`poller.pollUntilDone()`) —
  a VM start/restart/deallocate can take minutes, far longer than is safe to
  hold open inside a Flex Consumption invocation. The response is always
  `202 { status: 'accepted', action, sessionHostName, correlationId }`; the
  audit row's outcome is `'accepted'`, a value distinct from `'success'`
  precisely because completion was never observed. Callers re-poll
  `GET .../sessionhosts` to see the actual power state land.
- **Audit integrity**: the audit row's `activeSessions` key always holds the
  SERVER-OBSERVED count (from `resolveSessionHostVm`); a client-supplied
  `activeSessions` in the request body is recorded separately under
  `clientReportedActiveSessions` (never merged into the same key) so a
  stale or understated client value can never masquerade as the
  authoritative count for a row a reviewer later audits. `resourceGroup` and
  `vmName` (the resolved VM location) are recorded too.
- **Two-phase error mapping**: resolving the VM and submitting the power
  action are separate ARM calls with separate error mapping — a 404 from
  resolving the *session host* (`session_host_not_found`) is a different
  fact than a 404 from submitting against its *VM* after resolution
  (`session_host_vm_not_found`, e.g. the VM was deleted out-of-band). A 403
  submitting the action maps to `vm_power_action_forbidden` (the managed
  identity's role assignment may not have propagated yet); a 409 maps to
  `vm_power_action_conflict` (VM in a conflicting/transitional state).
- **Drain-first prompt, not a server-side gate**: the frontend shows a
  warning step (recomputed live from the session-host list, not a click-time
  snapshot) before the typed-name confirm when a restart/deallocate targets
  a host with active sessions, requiring an explicit "Proceed anyway" — but
  the server never blocks on this; it's operator judgment (an admin
  restarting an unresponsive host with stuck sessions is a legitimate,
  common case).
- **RBAC**: a second CUSTOM role, `AVD Manager VM Power Operator`
  (`infra/modules/vmPowerOperatorRole.bicep`, assigned in `infra/main.bicep`),
  also scoped to `RG-AVD-HostPools` (where the session-host VMs live) but
  covering `Microsoft.Compute` actions instead of `Microsoft.DesktopVirtualization`
  ones — `virtualMachines/read` + `start/restart/deallocate` actions only,
  kept as a separate role definition from the M2-S1 session-host writer role
  so either grant can be revoked independently.
- **UI**: a per-host Power menu (Start/Restart/Deallocate) on the Host Pool
  page next to Drain/Resume, gated the same way. Start uses the lighter
  `ReasonConfirmDialog`; restart/deallocate use `ConfirmModal`'s typed-name
  confirm (extended in AM-19 with an optional reason field, busy state, and
  in-dialog error display). AM-33: restart/deallocate's confirm now also
  shows an `ImpactPreview` panel (current session count + a drain-state
  warning) above that gate — see "ImpactPreview (AM-33)" below.

M2-S3 (AM-20) adds session operations, all on the Sessions page, all
gated `requireMinimumRole('operator')` server-side (RoleGate hides the
controls from viewers client-side, same convention as the Host Pool page):

- **Force logoff** — `POST /api/v1/hostpools/{hostPoolName}/sessionhosts/{sessionHostName}/sessions/{sessionId}/logoff`.
  `reason` is MANDATORY (400 without a non-empty reason ≤1000 chars) —
  unlike the drain toggle's optional reason, forcing a session off is
  disruptive enough to always require justification. Calls ARM's
  `userSessions.delete` with `force: true`.
- **Send message** — `POST .../sessions/{sessionId}/message`. `body` is
  mandatory, `title` optional. Calls `userSessions.sendMessage`. The audit
  row stores `bodyLength` + a truncated preview, not the full message text.
- **Logoff all disconnected** — `POST /api/v1/hostpools/{hostPoolName}/sessions/logoff-disconnected`.
  Server-side enumerates every session and filters to
  `sessionState === 'Disconnected'` ONLY before touching anything — this
  invariant is unit-tested hard (mixed-state fixtures asserting no
  Active/Pending/LogOff/UserProfileDiskMounted session is ever targeted).
  `reason` mandatory. A single audit row covers the whole batch.
- **Broadcast** — `POST /api/v1/hostpools/{hostPoolName}/sessions/broadcast`.
  Same shape, filtered to `sessionState === 'Active'` ONLY.

Both batch endpoints share `app/api/src/lib/sessionBatch.ts`'s
`runSessionBatch`:

- **Bounded concurrency** — per-session ARM calls run through a small
  worker pool capped at 8 concurrent calls (not one unbounded
  `Promise.allSettled` over every target), to avoid 429 throttling and
  Function App outbound SNAT port exhaustion on a large batch.
- **MAX_BATCH_TARGETS (100)** — a batch whose filtered target count exceeds
  100 sessions is rejected with 400 (`too_many_sessions`, with the actual
  count and the cap in the message) rather than attempted. Beyond this cap,
  a synchronous request/response design stops being defensible — an
  async-job model (enqueue + poll/webhook) is the right architecture, and
  is intentionally NOT implemented here.
- **Partial-failure aggregation** — one session's failure never aborts the
  batch; the response body reports `{ attempted, succeeded, skipped,
  failed[] }`. A per-session ARM 404 (the session already vanished between
  enumeration and the action — the common case for a disconnected session a
  user simply closes) is classified as `skipped`, not `failed`, and does
  not flip the batch's audit `outcome` to `'failure'`.
  `failed[].message` is a SHORT, SANITIZED classification (e.g. `"Azure
  request failed (HTTP 429)"`), never the raw ARM/REST error text — a
  `RestError`'s message can embed the full outbound request including its
  body, which must never round-trip into a response the browser renders.
  The raw error is logged server-side (`context.error`, message only — see
  below) and joinable to the batch via its `correlationId`, which both
  batch response DTOs also return directly so the UI can surface it (e.g.
  "Reference: \<correlationId\>" under the result banner).
- **Host-qualified, capped audit session-id lists** — the batch audit row's
  `parameters.sessionIds` are `"{sessionHostName}/{sessionId}"` pairs (ARM's
  `userSessionId` is only unique WITHIN a session host — a bare id
  collides across hosts), capped to the first 50 with
  `sessionIdsTotal`/`sessionIdsTruncated` alongside, so a very large batch
  can't produce an oversized `parametersJson` that silently fails the audit
  Table insert (Table's 32K string-property cap).
- Error logging never passes the raw `Error`/`RestError` object to
  `context.error` — only `error.message` — since a RestError's own
  properties can carry the full outbound request (CWE-532: sensitive data
  must not land in Application Insights verbatim).

**RBAC**: session operations get their OWN custom role,
`infra/modules/sessionUserSessionOperatorRole.bicep` ("AVD Manager Session
Operator") — a SIBLING to the M2-S1 drain-toggle role above
(`sessionHostWriterRole.bicep`, "AVD Manager Session Host Writer"), not an
extension of it, so each role's grant stays legible from its own file and
independently revocable. It grants only
`hostpools/{read}` + `hostpools/sessionhosts/{read}` +
`hostpools/sessionhosts/usersessions/{read,delete,sendMessage/action}` —
narrower than the built-in "Desktop Virtualization User Session Operator"
role, which also grants `usersessions/disconnect/action` (unused by this
app). Unlike the M2-S1 role, this one's role ASSIGNMENT (not just its
`assignableScopes`) is scoped to the specific host pool RESOURCE, not the
whole `RG-AVD-HostPools` resource group — ARM itself, not just the API's
in-process `validateManagedHostPool` check, bounds the managed identity's
blast radius to the one host pool this app manages.

> **Deploy-ordering note**: the RBAC role assignment above must be deployed
> (`infra/` — a Bicep deployment) BEFORE the corresponding API code is
> deployed. If the code deploys first, every M2-S3 endpoint 502s with an
> ARM `AuthorizationFailed` error until the infra deployment catches up —
> the Function App's managed identity simply doesn't have the
> `usersessions/*` grant yet. Also note: creating/updating a custom
> `Microsoft.Authorization/roleAssignments` resource requires the deploying
> principal to hold **User Access Administrator** (or `Owner`) on
> `RG-AVD-HostPools` — a plain `Contributor` deployment principal will get
> `AuthorizationFailed` on the Bicep deployment itself, not just the app.

## ImpactPreview (AM-33)

Every high/medium-severity confirm dialog now shows a compact "What this will
do" panel (`src/components/ImpactPreview.tsx`) above `ConfirmModal`'s
typed-name/reason gate — a plain-language, 1-4 line statement of what the
action changes and to whom (e.g. "Will end 3 disconnected sessions (alice@…,
bob@…, +1 more)." / "avd-con-0 is NOT draining — consider draining first.").
Generalizes the image-build wizard's dry-run plan (the app's original
best-received interaction) onto every other mutating flow WITHOUT a server
round-trip: every line is computed client-side, purely from data the page
already fetched (`src/lib/impactPreview.ts`'s per-flow helpers — no new
mutating endpoints, no new server dry-run API). Wired into: Sessions'
logoff-all-disconnected and per-row force-logoff, HostPool/Dashboard's
restart/deallocate power menu (reusing the existing sessions-warning
interstitial's live drain-state recompute rather than duplicating it),
Scaling's emergency override and schedule delete, RolloutWizard's
remove-hosts and rollback, and Profiles' permanent delete. Test coverage:
`src/components/ImpactPreview.test.tsx` (render/tone behavior) and
`src/lib/impactPreview.test.ts` (the pluralization/truncation/warning-
threshold logic as pure, React-free unit tests).

## Audit read model (AM-32)

Every mutation this app performs writes an `AuditEvent` row to the `AuditLog`
Table (`app/api/src/lib/auditLog.ts`) — that write side has existed since M2.
Before AM-32, nothing read it back for a *user*: the only consumer was
`queryRecentAuditEntries`, scoped to one action family and used solely by
`GET /v1/scalingplans/current/history`. AM-32 adds the general "what
happened recently" read this app's UI never had — `GET /v1/audit/recent`
(`app/api/src/functions/auditRecent.ts`) — plus two UI surfaces on top of it.

**Endpoint**: `GET /v1/audit/recent` — **operator+** (not viewer+, unlike
most GET endpoints in this app): audit rows carry actor identities, which a
viewer has no operational need to see. Query params: `top` (default 25, max
100), `actor` (exact match, optional), `actionPrefix` (e.g. `sessionhost.`,
optional), `sinceHours` (default 24, max 720 = 30 days). Response is
`AuditRecentResponse` (`app/shared/src/index.ts`): `{ entries, truncated,
partial, sinceHours }`, never a bare array — same `truncated`-not-a-count-
guarantee contract every paged/capped list in this app follows (see
`restClient.ts`, `RolloutPlanListResponse`), sharpened here (see "Query
mechanics" below) to an EXACT signal rather than the usual "maybe" one.
An unconfigured audit store 503s (`audit_not_configured`) rather than 200ing
an empty list — see "Fail-closed reads" below. Every call also logs a
structured `AUDIT_READ` line (requesting actor + applied filters) — reading
the audit log is itself worth a trail, even though it isn't a mutation and
so doesn't go through `writeAuditEntry`.

**Row identity**: each `AuditEntryDto` carries an opaque `id` —
`{partitionKey}/{rowKey}` of the underlying Table entity — NOT
`correlationId`. A single request can write several audit rows sharing one
`correlationId` (e.g. `rolloutPlanTimer.ts` generates one id per timer tick,
then one row per plan it advances that tick), so `correlationId` alone isn't
a safe React list key; `id` is the Table's own composite primary key and is
unique by construction.

**Privacy**: `AuditEntryDto` deliberately does **not** include
`AuditEntity.parametersJson` — a mutation's parameters can carry payload
detail (message body previews, GB thresholds, before/after values) that
isn't this general-purpose feed's business to expose wholesale regardless of
which action/page it came from. A `hasParameters: boolean` says whether a
parameters payload existed, without shipping its contents. `detail` (raw
ARM/internal error text) is omitted too, same rationale the M3 scaling
history endpoint already established.

**Query mechanics** (`queryAuditEntries`, `app/api/src/lib/auditLog.ts`):
reuses the write path's reverse-chronological RowKey scheme
(`PartitionKey` = UTC calendar day, `RowKey` = a zero-padded
"ceiling-minus-epoch-ms" prefix, so a plain ascending scan is already
newest-first) rather than a full table scan. It walks backward one day
partition at a time for only as many days as `sinceHours` can span (not a
fixed 30-day default unrelated to the actual ask), and adds a server-side
`RowKey le {bound}` filter on every partition derived from the `sinceHours`
cutoff instant, so a partition holding more matching rows than still needed
can't silently include rows older than the requested window. Within one
partition, `.next()` is looped until either the target row count is reached
or the Table SDK's iterator itself reports exhausted — a single `.next()`
call is NOT sufficient (Table Storage can hand back a page shorter than
requested, with a continuation token still pending, even when the partition
has more matching rows within budget; stopping after one call used to treat
that as "this day is exhausted" and silently drop the rest).

`truncated` is an EXACT signal, not a guess: the walk actually asks for
`top + 1` rows and trims the extra one back off before returning — whether
that extra row was found is exactly what `truncated` reports, closing the
"happened to end exactly at `top`" ambiguity most other capped-list
endpoints in this app accept as good enough.

**Fail-closed reads**: if the underlying query fails PART-WAY through the
day-walk (a transient Table error after some days already succeeded), the
response sets `partial: true` (and `truncated: true` unconditionally — a
read that didn't finish can never positively confirm completeness) rather
than quietly presenting whatever rows were collected as the whole answer.
Separately, if the audit store itself isn't configured on a DEPLOYED
instance (`isAuditRequiredButMissing()` — the same check the write path
uses to fail closed before ever mutating anything), the endpoint 503s
instead of 200ing `entries: []` — this endpoint exists specifically so
"no entries" can be trusted to mean "nothing happened," not "we couldn't
check." (Local dev with no storage account configured is unaffected — that
is a normal local-dev state, not an error.)

**UI surfaces**:
- **"Recent actions" drawer** — a History icon-button in the estate strip
  (`app/frontend/src/components/EstateStrip.tsx`, RoleGate'd operator+) opens
  `RecentActionsDrawer.tsx`: the last 25 actions app-wide, over the last 24h,
  loaded on open (no polling while closed). Also reachable via the command
  palette's "Recent actions" action (`Ctrl/Cmd+K`, also operator+-gated —
  see `CommandPalette.tsx`'s doc comment).
- **Audit page** (`app/frontend/src/pages/Audit.tsx`) — the full
  filter/browse surface: actor text filter (debounced), action-family
  dropdown, a 24h/7d/30d time window select, and a client-side "Show
  failures only" toggle, backing a `When/Who/Action/Target/Outcome/Reason/
  Correlation ID` table (correlation IDs are click-to-copy). Reachable at
  the clean route `/audit` (nav item, restored under Administer, before
  Settings — `g t` for the keyboard-shortcut chord) and the legacy
  `/audit-settings` deep link. Manual refresh only — no polling interval;
  filter changes DO re-fetch (same pattern as Monitoring.tsx's alert-feed
  hours picker).

Both surfaces render distinct caveats for `truncated` ("more entries may
exist…") vs. `partial` ("audit query failed partway…") — never silently
treat a `partial` read as complete — and give an `'accepted'` outcome its
own (non-"ok") badge tone, since `AuditOutcome`'s own doc comment
(`auditLog.ts`) is explicit that `accepted` only means ARM acknowledged the
request, not that it actually completed.

## Monitoring & logs (AM-24)

The Monitoring page (`app/frontend/src/pages/Monitoring.tsx`) is the alert &
log center: a 24h (configurable, 1–168h) alert feed with ack/snooze, four
curated Kusto (KQL) views against `LAW-CONTOSO-PROD`, and a raw-KQL escape hatch.

**Alert feed** (`GET /v1/alerts?hours=`, viewer+) extends
`app/api/src/services/alertsService.ts` (`@azure/arm-alertsmanagement`,
`AlertsGetAllOptionalParams.customTimeRange`) rather than switching to a LAW
query — see that file's top-of-file comment for why. The response is
wrapped (`AlertsFeedResponse: { alerts, degraded }`), not a bare array — a
Table Storage hiccup degrades to `degraded: true` (alerts returned without
their ack/snooze overlay, actions disabled client-side) rather than failing
the feed. Each alert is merged with app-level ack/snooze state read from an
`AlertState` Azure Table (`app/api/src/lib/alertState.ts`) — a concept
Azure Monitor itself has no equivalent for (Alerts Management's own
`alertState` is New/Acknowledged/Closed, not a snooze). The Dashboard's
"last 3 fired alerts" ticker (`GET /v1/alerts/recent`) gets the same
overlay merged in and additionally EXCLUDES actively-snoozed alerts
entirely — a snooze is an explicit "stop showing me this" and the ticker
has room for exactly 3 entries.

Ack/snooze/un-ack/un-snooze are operator+ mutations
(`POST`/`DELETE /v1/alerts/{alertGuid}/ack`,
`POST`/`DELETE /v1/alerts/{alertGuid}/snooze`) that follow the exact same
mutating-handler shape described under "Mutations" above
(`requireMinimumRole`, fail-closed `isAuditRequiredButMissing` check,
`writeAuditEntry` on both the success and failure path, mirroring
`sessionHostPower.ts`) — no separate/parallel audit mechanism was built for
AM-24; it reuses the M2 `AuditLog` table and `app/api/src/lib/auditLog.ts`
directly. Routes carry only the alert's bare GUID, never the full ARM
resource id — Azure App Service normalizes/rejects encoded slashes (`%2F`)
in URL path segments before a request reaches the Function App, so an
earlier version of this route (the full, percent-encoded ARM id as one path
segment) would have 404'd in a real deployment despite working against the
local Functions host; the full id is reconstructed server-side from
`SUBSCRIPTION_ID` + the GUID where needed (the audit `target` field). Both
ack and snooze are reversible — un-ack/un-snooze clear just that half of
the state (Table Storage's Merge Entity operation cannot remove a property,
only a Replace can — see `alertState.ts#unackAlert`/`unsnoozeAlert`) — so
neither button is a one-way door in the UI.

**Curated views** (`GET /v1/logs/views`, `POST /v1/logs/views/{viewId}/run`,
viewer+) run four fixed KQL queries — "Connection failures", "FSLogix
errors", "Session disconnects", "Host health history" — against the AVD
diagnostics tables `WVDConnections`, `WVDErrors`, and `WVDAgentHealthStatus`
(see `app/api/src/services/logsService.ts` for the KQL and the Microsoft
Learn sources each query's table/column names were checked against;
`WVDCheckpoints` is NOT currently used by any of the four views, despite an
earlier draft of this doc listing it — corrected here rather than left
inaccurate).

**Raw KQL** (`POST /v1/logs/query`, **operator+ only, not viewer**) is the
escape hatch. Every run is audited (`action: 'logs.query'`; `target` is a
SHA-256 hash prefix of the query text, not the text itself; `parameters`
carries `{ timespanHours, kqlLength }`; the full KQL — truncated to 1,000
chars, the same bound every operator-supplied free-text field in this app
gets — lives in `detail`) — this was previously the one significant
operator action in the app that left no record at all. Security posture, in
full, corrected after peer review to state the real boundary rather than
an isolation that doesn't exist:

- The Function App's managed identity has **Log Analytics Reader** scoped
  to the **`LAW-CONTOSO-PROD` workspace resource itself** (`infra/main.bicep`'s
  `rbacLogAnalyticsReaderOnWorkspace` resource) — narrowed from an earlier
  resource-group-scope grant specifically because RG scope would have let a
  query reach every workspace ever deployed into `RG-AVD-Monitoring`, not
  just this one (verified on Microsoft Learn: a resource-scoped assignment
  gives "access to only the specified workspace", vs. a resource-group
  scope giving "access to all workspaces in the resource group").
- That narrowing is real but **partial** — it does NOT mean only the AVD
  diagnostics tables are reachable:
  - This app's own Application Insights is **workspace-based**
    (`functionapp.bicep`'s `appInsights` resource points
    `WorkspaceResourceId` at this same LAW), so its telemetry —
    `AppRequests`, `AppTraces`, `AppExceptions`, including **other users'**
    request data — lives in `LAW-CONTOSO-PROD` too and is queryable by anyone
    who can run raw KQL here, workspace-scoped or not (Microsoft Learn: a
    workspace-based Application Insights resource's "telemetry is stored in
    a Log Analytics workspace with all other log data"). There is no
    per-table RBAC configured on this workspace to carve those tables out;
    that's a real, separate option, out of scope for AM-24.
  - The identity's SEPARATE plain-**Reader** grants on `RG-AVD-HostPools`
    and `RG-AVD-Images` leave a narrower residual cross-reach: KQL's
    `resource()` function permits resource-context queries against
    anything the caller can Read, so a query could in principle pull
    Monitor Logs for resources in those two resource groups too — a
    property of those OTHER grants, unaffected by the LAW-scope narrowing.
- None of the above is a privilege-escalation or data-**modification**
  risk — KQL has no write surface, and every avenue above requires an RBAC
  grant this identity already legitimately holds for other reasons — but it
  is real read-side blast radius beyond "just the AVD tables," stated here
  rather than claimed away.
- Defense in depth on top of that RBAC reality (see
  `app/api/src/lib/logsGuard.ts`): KQL text capped at 8,000 characters,
  time range capped at 168h (7d, well under Azure's own 30-day
  `customTimeRange`/query-window ceilings), a 60s server-side query timeout
  (`serverTimeoutInSeconds`, well under the SDK's 600s max), and every
  result row-capped at 1,000 in the HTTP response
  (`LogsTableResult.truncated` tells the caller when a cap was hit — this
  caps what's sent back to the browser, not what Log Analytics itself
  computes; Azure's own query-API ceiling is 500,000 rows / ~104 MB).
- `kql` is passed to `LogsQueryClient.queryWorkspace` as an isolated,
  structured argument (never string-concatenated with the time range or
  anything else this app constructs) — the same call shape used for the
  curated views, so there's no special-cased "safe" vs "raw" query path to
  keep in sync.
- No rate limiting is implemented (see `app/api/src/functions/logsQuery.ts`
  for the reasoning: no shared state across Flex Consumption instances to
  cheaply rate-limit against, Azure Monitor already throttles the query API
  server-side, and the route is already gated to a small, trusted
  operator+ population).

**Storage**: `AlertState` and `AuditLog` are sibling Azure Tables under the
same `tableService`, in the same FUNCTIONS storage account
(`infra/modules/functionapp.bicep`'s `storageAccount` resource —
`AzureWebJobsStorage`). AM-24 needed **zero new RBAC**: the Storage Table
Data Contributor grant on that account (account-scoped, not per-table) was
already added for `AuditLog` back in M2-S1 (AM-18) — `AlertState` rides the
same grant. `app/api/src/lib/tableStorage.ts` (a small generic TableClient
factory `alertState.ts` uses) deliberately mirrors `auditLog.ts`'s
config/credential pattern — same `AUDIT_STORAGE_ACCOUNT_NAME` app setting,
same `DefaultAzureCredential` — rather than introducing a parallel one; only
the table name (`ALERT_STATE_TABLE_NAME`, default `AlertState`) differs.

## Deployment

Infrastructure is described in `infra/main.bicep` (plus `infra/modules/`); every
estate-specific name (host pool, workspace, gallery, storage account, Key Vault,
VNet, ...) is a required parameter with no default. Supply them through a
`.bicepparam` file of your own.

- **Infra**: `infra/main.bicep` with your own parameter file. Run a `what-if`
  before every deployment.
- **API**: zip deploy of a self-contained package with `@avdmgr/shared` vendored
  in (remote build cannot resolve the private workspace dependency).
- **Frontend**: `npm run build`, then deploy `app/frontend/dist` with the SWA CLI.
  Set `SWA_TENANT_ID` at build time so `scripts/render-swa-config.mjs` can
  substitute the tenant placeholder in `staticwebapp.config.json`.
- **Auth setup** (one-time): see `docs/app-registration.md`.
- **Dev previews**: a dev frontend can be deployed as a named preview
  environment on the same Static Web App rather than as separate resources. A
  preview that points at a live estate performs real mutations, so treat it as
  production-grade.

CI in this repository (`.github/workflows/ci.yml`) builds, lints, tests and
scans the tree; it intentionally contains no deploy jobs.

### Cost Management verification (AM-25, post-deploy — do this once per environment)

The Cost & Scaling page's data depends on the Cost Management Reader role
assignments (`infra/main.bicep`'s `rbacHostPools`/`rbacImages`/`rbacMonitoring`/
`rbacManagement`/`rbacNetwork`/`rbacStorage` modules — see
`app/api/src/services/costService.ts`'s top comment for the full list of
resource groups). RBAC propagation delay and EA-level billing settings (see
below) are exactly the kind of failure that's invisible until a real user
loads the page, so verify it explicitly right after a deploy that touches
these role assignments, rather than waiting to find out from the UI:

```powershell
# Run once per tracked resource group (RG-AVD-HostPools, RG-AVD-Images,
# RG-AVD-Monitoring, RG-AVD-Management, RG-AVD-Network, RG-AVD-Storage) —
# a minimal smoke query matching what costService.ts issues.
az rest --method POST `
  --url "https://management.azure.com/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/RG-AVD-HostPools/providers/Microsoft.CostManagement/query?api-version=2026-06-01" `
  --body '{"type":"ActualCost","timeframe":"MonthToDate","dataset":{"granularity":"Daily","aggregation":{"totalCost":{"name":"PreTaxCost","function":"Sum"}}}}'
```

Run this **as the Function App's managed identity** (not your own signed-in
account) to actually validate the grant — e.g. from Azure Cloud Shell after
`az login --identity` scoped to that principal, or via a short-lived
`az rest` call using a token obtained for the managed identity — a run under
your own (likely Owner/Contributor) account will succeed even if the managed
identity's grant is broken, giving a false pass.

Expected outcomes and what each one means (see `costService.ts`'s
`describeCostManagementError` for the same triage logic the app itself
applies):

- **200 with a `properties.rows` array** (possibly empty, for a
  zero-activity RG that month) — the grant works.
- **403 mentioning "view charges" / AO permissions** — the EA enrollment's
  "AO view charges" setting is disabled for this subscription. This is a
  **billing-level** setting an EA Administrator must change; the RBAC grant
  itself may be entirely correct.
- **403 without that hint** — the Cost Management Reader role assignment
  hasn't propagated yet (can take several minutes after a fresh deploy) or
  is missing/was reverted. Re-check with
  `az role assignment list --resource-group <rg> --query "[?roleDefinitionName=='Cost Management Reader']"`.
- **429** — rate-limited; wait and retry. Not expected from a single
  one-off smoke call.

## Local development

Prerequisites: Node.js 22+ (matches the Function App's Flex Consumption runtime
— see `infra/modules/functionapp.bicep`'s `nodeVersion` param; bumped from 20 to
22 in AM-25, since `@azure/arm-costmanagement`/`@azure/arm-storage` declare
`engines: node>=22` and Flex Consumption itself only supports Node 22/24), npm
9+ (npm workspaces), and optionally the
[Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
(`func`) if you want to run the API locally.

```bash
# From the repo root
npm install

# Build everything (shared -> api -> frontend)
npm run build

# Typecheck everything without emitting
npm run typecheck

# Run every workspace's tests (shared -> api -> frontend)
npm test
```

### Frontend tests (AM-15/M7)

`app/frontend` has its own vitest + Testing Library (`@testing-library/react`)
suite (`app/frontend/vitest.config.ts`, jsdom environment) — run it directly
with `npm run test --workspace=app/frontend` or as part of the root `npm test`
above. It covers:

- A renders-without-crashing smoke test for every page component (API layer
  mocked at `apiClient.get/post/patch/delete`, auth context left at its
  default un-resolved state) — `src/pages/pages.smoke.test.tsx`.
- `StatusBadge`'s Tooltip-ref-forwarding behavior (a regression test for an
  AM-13 peer review find) — `src/components/StatusBadge.test.tsx`.
- `RoleGate`'s allow/deny/loading states, including the default vs. a
  caller-supplied `loadingFallback` — `src/components/RoleGate.test.tsx`.
- `ConfirmModal`'s typed-name-to-confirm + `reasonRequired` gating —
  `src/components/ConfirmModal.test.tsx`.
- `ImpactPreview`'s render/tone behavior (empty-lines no-render, custom
  heading, info vs. warning-toned lines, the MAX_IMPACT_LINES defensive cap)
  — `src/components/ImpactPreview.test.tsx` — plus the per-flow preview-line
  helpers themselves (pluralization, name-list truncation, the 10-minute
  recently-disconnected warning threshold, etc.) as pure unit tests —
  `src/lib/impactPreview.test.ts` (AM-33).
- `AppThemeProvider`/`useThemeMode`'s mode resolution, localStorage
  persistence (including an invalid stored value falling back to
  `'system'`), and live OS-preference updates —
  `src/theme/AppThemeProvider.test.tsx`.
- The Layout's theme-toggle Menu itself (open/close, `menuitemradio`
  checked state, keyboard Escape-to-close, and that a selection persists) —
  `src/components/Layout.test.tsx`.
- The Settings page with a RESOLVED `GET /v1/settings` fixture (the smoke
  suite above only ever exercises its loading state) asserting the
  app-configuration card actually renders the fetched values —
  `src/pages/Settings.test.tsx`.

CI (`.github/workflows/ci.yml`) runs the whole suite together with
`npm run lint` for the whole repo.

### Running the frontend against a local API

```bash
# Terminal 1: API (requires local.settings.json copied from local.settings.json.example)
cd app/api
cp local.settings.json.example local.settings.json   # never commit local.settings.json
npm run build
func start

# Terminal 2: frontend (vite dev server proxies /api -> http://localhost:7071)
cd app/frontend
npm run dev
```

### API auth in local development

`app/api/src/lib/auth.ts` requires two things on every non-health request:
a valid `x-ms-client-principal` header (normally set by SWA) AND an
`x-swa-backend-secret` header matching the `SWA_BACKEND_SECRET` app setting
(defense-in-depth — see `infra/modules/functionapp.bicep`'s
`ipSecurityRestrictions`). Locally that means either:

- Send both headers yourself (e.g. via a REST client) using the
  `SWA_BACKEND_SECRET` value from your `local.settings.json`, or
- Set `NODE_ENV=development` and `ALLOW_INSECURE_LOCAL_AUTH=true` (and leave
  `SWA_BACKEND_SECRET` unset) to bypass the shared-secret check locally only —
  never set `ALLOW_INSECURE_LOCAL_AUTH` in a deployed environment.

### Running the frontend without the API / without SWA auth

Set `VITE_DEV_ROLE` (e.g. in `app/frontend/.env.local`) to `viewer`, `operator`, or
`admin` to make `useAuth()` fall back to a synthetic dev identity when `/.auth/me`
is unavailable (i.e. outside of a real SWA-hosted environment):

```
VITE_DEV_ROLE=admin
```

### Calling Azure APIs locally

`app/api/src/services/avdService.ts` uses `DefaultAzureCredential`, so running the
API locally against real Azure resources requires `az login` (or another credential
`DefaultAzureCredential` can discover) with at least Reader access on the host pools
resource group. Once deployed, the Function App's managed identity is used instead —
no credentials are stored in app settings.
