# AVD Manager — frontend design system

One page: the shared primitives under `app/frontend/src/components` (barrel:
`app/frontend/src/components/index.ts`), when to reach for each one, the
token rules every page follows, the confirmation-severity rubric, and the
status-tone vocabulary. Written after AM-35 (M8-W6) consolidated the app's
many hand-rolled tables onto one `DataTable` and extracted `StatTile` from
Dashboard's four summary tiles — if you're adding a new page or a new table,
start here before writing a bespoke `<Table>`, `<Card>`, or badge.

## The primitives

| Component | Use it for | Don't use it for |
| --- | --- | --- |
| `PageHeader` | Every page's `<h1>` + `asOf`/`refreshing`/`onRefresh` + optional `actions`. One per page. | Section headings inside a page — use `CardHeader`. |
| `StatTile` | A Card that shows one polled stat (loading/error/empty via `AsyncState`, optional "View X →" footer link). Dashboard's Sessions/Scaling phase/Image version/Cost tiles. | A card with a table or a list inside it — those stay a plain `Card` + `CardHeader`. |
| `DataTable` | Any tabular data: typed columns, optional per-column client-side sort, a column-driven empty state, an optional CSV export button, a trailing per-row action slot. This is the default for a new table. | A table whose column SET varies at runtime (dynamic query results — see `LogsResultsTable`, kept bespoke) or one that needs per-row multi-select (see `RolloutWizard`'s `OldHostsTable`, documented skip in that file). |
| `StatusBadge` | Any status/state pill — session state, host status, build/rollout state, audit outcome. Always go through this, never a bare Fluent `Badge` for a status value. | Free-standing informational badges with no status meaning (e.g. a plain "beta" tag) — a bare `Badge` is fine there. |
| `AppLink` | Any in-content react-router navigation (card footers, table cells) — themed so it's visible in both light and dark (bare `RouterLink`s render invisible-on-dark browser-default blue). | External links — use a plain `<a>` (or `Text` with `as="a"`). |
| `ImpactPreview` | The "what this will do" panel inside a `ConfirmModal`/dialog for a mutating action, when there's something concrete to preview (affected sessions, hosts, days left uncovered, etc.). | A dialog with nothing more to say than its `description` string — don't force an empty panel. |
| `ConfirmModal` | Every confirm-before-mutate flow. See the severity rubric below — pick `low`/`medium`/`high`, don't hand-roll a new confirm shape. | A multi-field form (create/edit dialogs use a plain Fluent `Dialog`, e.g. Scaling's schedule editor). |
| `EstateStrip` | Already mounted once, in `Layout.tsx`. Don't remount it per-page. | — |
| `TableScroll` | Wrapping any wide, horizontally-scrollable block — `DataTable` already does this for you; only reach for it directly if you're rendering a bespoke `<table>`-shaped thing outside `DataTable` (rare — see `LogsResultsTable`). | — |
| `ThemeToggle` | Already mounted once (EstateStrip's identity menu). | — |
| `useCardStyles` | The padding rule for every page-level `<Card>` — `mergeClasses(cardStyles.card, <your own layout styles>)`. | — |
| `useVisuallyHiddenStyles` | A screen-reader-only label outside of `DataTable` (which has its own `visuallyHiddenHeader`/default hidden "Actions" header built in) — e.g. an icon-only button's accessible name. | — |

Import from the barrel for anything touching more than one primitive:

```ts
import { DataTable, StatTile, StatusBadge, useCardStyles } from '../components';
```

Existing deep imports (`from '../components/DataTable'`) keep working —
the barrel is a convenience surface, not a required migration.

## DataTable — the default table shape

```tsx
<DataTable
  ariaLabel="User sessions"                 // required — names the scroll region (TableScroll), NOT also put on <Table> itself
  columns={COLUMNS}                          // typed column defs — see below
  rows={visibleRows}                         // already FILTERED by the page if it has its own filter/search; DataTable owns SORTING only
  getRowKey={(row) => row.id}
  emptyMessage="No active sessions."         // shown when rows is empty and there's no active filter
  activeFilterDescription={...}              // optional — shown instead of emptyMessage when rows is empty BECAUSE of a filter/search
  onClearFilters={() => {...}}               // optional — renders a "Clear filters" button next to activeFilterDescription
  rowActions={canMutate ? (row) => <Menu>...</Menu> : undefined}  // optional trailing column
  rowActionsHeader="Actions"                 // optional — defaults to a visually-hidden "Actions"; pass a visible node to show it (Monitoring's Alerts table)
  rowClassName={(row) => row.stale ? styles.staleRow : undefined}
  rowAppearance={(row) => row.isCurrent ? 'brand' : 'none'}       // Fluent TableRow `appearance`
  csvExport={{ fileName: 'export' }}         // optional — "Export CSV" button, reuses lib/csv.ts
  size="small"                               // default; matches this app's compact-table convention
/>
```

A column:

```ts
{
  id: 'user',
  label: 'User',                              // plain text — drives the default header, the sort announcement, and visuallyHiddenHeader's accessible name
  header: <CustomNode />,                      // optional — overrides the VISIBLE header only; label still wins the accessible name when visuallyHiddenHeader is set
  visuallyHiddenHeader: true,                  // optional — header renders label off-screen (e.g. a leading icon-only column)
  renderCell: (row) => row.userPrincipalName,
  sortable: true,                              // requires comparator
  comparator: (a, b, direction) => ...,        // direction-aware — keep "unknown sorts last regardless of direction" rules INSIDE the comparator, not by flipping a plain ascending fn
  csvValue: (row) => row.userPrincipalName,    // optional — only needed when renderCell doesn't return a plain string/number and csvExport is used
  className: 'my-fixed-width-cell',
}
```

Rules of thumb:
- **Sorting lives in `DataTable`, filtering doesn't.** If a page has its own
  filter/search (a dropdown, a search box), the page filters `rows` before
  handing them to `DataTable`; `DataTable` only ever sorts what it's given.
- **The empty state is column-driven, not table-shaped.** Don't reach back
  into `<TableRow><TableCell colSpan={...}>` — `emptyMessage`/
  `activeFilterDescription`/`onClearFilters` cover every case this app's
  tables have needed so far.
- **`size="small"` is the default** — every migrated table adopted it as
  part of AM-35 (several moving off Fluent's `medium` default in the
  process). Peer review (Opus, MINOR 11) ruled this compaction APPROVED —
  it matches the density of the already-approved mockups — so treat it as
  the deliberate baseline, not a regression to walk back.
- **Column def construction that touches `useStyles()`** (a page-specific
  CSS class in a cell) can't live at module scope — build the `columns`
  array inside the component (or a small function taking `styles` as a
  parameter — see `Images.tsx`'s `buildSnapshotColumns`).

### When NOT to use DataTable

- **Dynamic/runtime column sets** (the column list itself is data, not a
  fixed shape known at compile time) — `LogsResultsTable` stays bespoke:
  Log Analytics query results have a variable column count/order, per-cell
  truncation-tooltip heuristics, and export ties to already-sorted rows in a
  way `DataTable`'s generic CSV export doesn't need elsewhere.
- **Per-row multi-select** (a `Checkbox` column bound to a `Set` the caller
  owns) — `RolloutWizard`'s `OldHostsTable` stays on the bare Fluent `Table`
  rather than growing `DataTable`'s shared API for the one caller that
  needs row selection. If a second table ever needs this, that's the
  signal to generalize it into `DataTable` instead of copying the bespoke
  shape again. `NewHostsTable` (right next to it) has no selection need of
  its own — it stays alongside `OldHostsTable` purely for visual/structural
  symmetry (both render side by side in the same removal/cutover step),
  not because it independently needed to skip `DataTable`.

## Token rules

- **Never hardcode a color, spacing value, or font size.** Use
  `tokens.*` from `@fluentui/react-components` exclusively —
  `tokens.colorNeutralForeground3` for muted text,
  `tokens.spacingHorizontalM`/`spacingVerticalL` etc. for gaps/padding,
  `tokens.colorStatusWarningBorder1` for a semantic warning accent. This is
  what makes the app theme-correct in both light and dark (and the
  neutral palette) with zero per-component dark-mode overrides.
- **Every page-level `<Card>` uses `useCardStyles().card`** for its padding
  (two-axis: `spacingVerticalL`/`spacingHorizontalL`), merged with any
  layout-only styles via `mergeClasses`. Don't redeclare card padding
  per-page.
- **A screen-reader-only label uses `useVisuallyHiddenStyles().visuallyHidden`**
  (or `DataTable`'s built-in `visuallyHiddenHeader`) — the standard
  absolutely-positioned/1px-clipped recipe, not `display: none` (which
  removes it from the accessibility tree too) or a bare empty string.
- **Icons and badges never carry color as inline hex** — `StatusBadge`'s
  `tone` prop (see below) is the only sanctioned way to color a status
  value; anything else goes through `tokens.colorPalette*`/`tokens.colorStatus*`.

## Confirmation-severity rubric (`ConfirmModal`)

| Severity | Gate | Use for |
| --- | --- | --- |
| `low` | Title + body + Confirm. No reason, no typed name (unless `optionalReason` is set, for the handful of `low` actions the API still audits a reason for — ack, drain/resume, start VM, rollout cancel). | Reversible, low-blast-radius actions. |
| `medium` | A **mandatory reason**, no typed name. Can carry an `impact` (`ImpactPreview`) panel. | Actions that need a justification but not the extra typed-name friction — force logoff, restart/deallocate, schedule edit, emergency-override cancel. |
| `high` | A **typed confirmation string** (`confirmText`) **plus** a mandatory reason; `impact` is common here. | The smallest, highest-blast-radius set — permanent delete, remove rollout hosts, start an image build, activate an emergency override, create a rollout plan. |

`impact` (an `ImpactPreview` panel) is available at every severity, not just
`high` — use it whenever there's something concrete to preview, regardless
of severity.

**Legacy (no `severity`) shape:** omitting `severity` entirely is still a
valid, supported `ConfirmModal` shape, not a removed one — it always shows
the typed-name gate (same as `high`), with the reason field optional unless
the caller explicitly passes `reasonRequired`. It predates the low/medium/
high rubric and a handful of call sites (and `ConfirmModal.test.tsx`'s own
"legacy shape" suite) still exercise it; new call sites should pick an
explicit severity instead of relying on this default.

## Status-tone vocabulary (`StatusBadge`'s `StatusTone`)

| Tone | Fluent mapping | Means |
| --- | --- | --- |
| `ok` | `success`, tint | Healthy / succeeded / active. |
| `warning` | `warning`, tint | Needs attention but not broken — draining, disconnected, oversized, stale heartbeat. |
| `error` | `danger`, tint | Failed / broken. |
| `info` | `informative`, tint | Neutral state with no urgency — the default when nothing else fits. |
| `pending` | `subtle`, tint | Deliberately in-flight or paused — an off-peak scaling phase, a rollout host not yet started, an "accepted but not yet confirmed" audit outcome. Reads as quieter/receded, not alarming. |
| `unknown` | `informative`, **outline** (not tint) | The app genuinely could not determine a value — an incomplete orphan scan, a status string outside the known enum. Reads as "we don't know," distinct from every other tone's implied answer. |

Pick the tone from what the VALUE means, not from habit — `pending` and
`unknown` exist specifically so "paused/in-flight" and "we don't know"
don't get forced into `warning` or `info` where they'd read as something
they're not.
