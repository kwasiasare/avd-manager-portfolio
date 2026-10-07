/**
 * AM-35 (item 49) — the design-system barrel: the primitives every page
 * should reach for before hand-rolling something bespoke. See
 * docs/DESIGN-SYSTEM.md for when to use each one, the token rules, the
 * severity rubric, and the tone vocabulary.
 *
 * This is a convenience import surface, not a NEW abstraction — every
 * export here already existed as its own component/hook; nothing under
 * `components/` was moved or renamed to build this file. Existing deep
 * imports (`from '../components/DataTable'`, etc.) keep working unchanged —
 * pages are not required to switch to the barrel, though `import { X, Y }
 * from '../components'` is preferred for new code touching more than one
 * primitive at a time.
 */

export { default as PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';

export { default as StatTile } from './StatTile';
export type { StatTileProps, StatTileFooterLink } from './StatTile';

export { default as Stepper } from './Stepper';
export type { StepperProps, StepperStep, StepperStepState } from './Stepper';

export { default as DataTable } from './DataTable';
export type { DataTableProps, DataTableColumn, DataTableCsvExportConfig, DataTableSortDirection } from './DataTable';

export { default as StatusBadge } from './StatusBadge';
export type { StatusBadgeProps, StatusTone } from './StatusBadge';

export { default as AppLink } from './AppLink';

export { default as ImpactPreview } from './ImpactPreview';
export type { ImpactPreviewProps } from './ImpactPreview';

export { default as ConfirmModal } from './ConfirmModal';
export type { ConfirmModalProps, ConfirmSeverity } from './ConfirmModal';

export { default as EstateStrip } from './EstateStrip';

export { default as TableScroll } from './TableScroll';

export { default as ThemeToggle } from './ThemeToggle';

// Card convention (AM-29 item 14): every page-level <Card> uses this shared
// padding hook rather than redeclaring the same rule per page — see
// styles/shared.ts's own doc comment. Re-exported here (not moved — it
// stays defined in styles/shared.ts, which non-component call sites like
// hooks/tests can keep importing directly) so a page pulling primitives
// from this barrel doesn't ALSO need a separate `../styles/shared` import
// just for Card padding.
export { useCardStyles, useVisuallyHiddenStyles } from '../styles/shared';
