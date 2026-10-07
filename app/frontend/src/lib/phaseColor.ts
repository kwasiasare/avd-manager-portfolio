import { tokens } from '@fluentui/react-components';
import type { ScalingPhase } from '@avdmgr/shared';
import type { StatusTone } from '../components/StatusBadge';

/**
 * AM-31 item 42 — the ONE phase→tone mapping every scaling-phase surface in
 * this app now shares: the scaling schedule day-timeline's colored segments
 * (Scaling.tsx), its legend swatches, and every StatusBadge/Badge rendering
 * a ScalingPhase value (Dashboard's "Scaling phase" tile, Scaling.tsx's own
 * "Current phase" tile, and Cost.tsx's idle-hosts findings table Phase
 * column — IdleHostFinding['phase'] is the same underlying union, see
 * app/shared/src/index.ts).
 *
 * Previously CostScaling.tsx alone carried TWO separately-declared phase
 * palettes (a PHASE_TONE for badges, a SEGMENT_COLOR for the timeline) that
 * happened to agree by luck, plus Dashboard.tsx's own third copy — a future
 * change to one could silently drift from the others without anyone
 * noticing. This module is the single source of truth all of them now
 * import from.
 */
export const PHASE_TONE: Record<ScalingPhase, StatusTone> = {
  RampUp: 'info',
  Peak: 'ok',
  RampDown: 'warning',
  OffPeak: 'pending',
  Unscheduled: 'info',
};

export const PHASE_LABEL: Record<ScalingPhase, string> = {
  RampUp: 'Ramp-up',
  Peak: 'Peak',
  RampDown: 'Ramp-down',
  OffPeak: 'Off-peak',
  Unscheduled: 'Unscheduled',
};

/**
 * Timeline-segment background colors — one per phase that can actually
 * appear as a scheduled day-timeline segment. `Unscheduled` is deliberately
 * excluded: it's computeScalingPhase's "no schedule currently covers this
 * instant" fallback, which only ever appears on a StatusBadge (via
 * PHASE_TONE above) — a single schedule's own day-timeline
 * (scheduleSegments in Scaling.tsx) never produces an Unscheduled segment,
 * since by construction its four boundaries always cover the full 24h.
 *
 * Colors are Fluent's raw palette background tokens (the timeline is a bar
 * of flat color blocks, not Badges) chosen to read as the same tone family
 * as PHASE_TONE above: blue/info, green/ok, yellow/warning, neutral/pending.
 */
export const PHASE_TIMELINE_COLOR: Record<Exclude<ScalingPhase, 'Unscheduled'>, string> = {
  RampUp: tokens.colorPaletteBlueBackground2,
  Peak: tokens.colorPaletteGreenBackground2,
  RampDown: tokens.colorPaletteYellowBackground2,
  OffPeak: tokens.colorNeutralBackground4,
};

/** AM-31 item 42 — legend swatch spec every PHASE_TIMELINE_COLOR legend uses: a 12px square with a 1px border (previously a borderless 10px square), so a swatch stays legibly a swatch (not just a color smear) against a similarly-toned page background in either theme. */
export const PHASE_LEGEND_SWATCH_SIZE = '12px';
export const PHASE_LEGEND_SWATCH_BORDER_WIDTH = '1px';
