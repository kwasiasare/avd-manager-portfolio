import { forwardRef } from 'react';
import { Badge, type BadgeProps } from '@fluentui/react-components';

/**
 * AM-29 item 16: extended from the original ok|warning|error|neutral set.
 * 'neutral' was renamed to 'info' (same meaning, clearer name now that
 * 'unknown' exists as a DISTINCT tone) and two tones were added:
 *   - 'pending': something in-flight / deliberately paused (an off-peak
 *     scaling phase, a rollout host not yet started, a build step not yet
 *     reached) — rendered with Fluent's 'subtle' badge COLOR (still 'tint'
 *     appearance, same as ok/warning/error/info), so it visually recedes
 *     relative to those tones instead of competing with them.
 *   - 'unknown': the app genuinely could not determine a value (an orphan
 *     scan that didn't reach this resource, a status string outside the
 *     known enum) — rendered 'informative' with an 'outline' appearance, so
 *     it reads as "we don't know" rather than as any other tone's implied
 *     answer.
 */
export type StatusTone = 'ok' | 'warning' | 'error' | 'info' | 'pending' | 'unknown';

export interface StatusBadgeProps extends Omit<BadgeProps, 'color' | 'appearance' | 'shape' | 'children'> {
  label: string;
  tone?: StatusTone;
}

const TONE_TO_COLOR: Record<StatusTone, BadgeProps['color']> = {
  ok: 'success',
  warning: 'warning',
  error: 'danger',
  info: 'informative',
  pending: 'subtle',
  unknown: 'informative',
};

/**
 * Only 'unknown' deviates from this component's original 'tint' appearance
 * — see StatusTone's doc comment. 'pending' keeps 'tint' (Fluent's Badge
 * `appearance` prop has no 'subtle' value; 'subtle' is one of its `color`
 * options instead — see TONE_TO_COLOR above, which is what actually gives
 * 'pending' its muted look).
 */
const TONE_TO_APPEARANCE: Record<StatusTone, BadgeProps['appearance']> = {
  ok: 'tint',
  warning: 'tint',
  error: 'tint',
  info: 'tint',
  pending: 'tint',
  unknown: 'outline',
};

/**
 * Small pill used to render host/session/image status values consistently,
 * backed by Fluent's Badge.
 *
 * AM-13 peer review item 5: wrapped in `forwardRef` and now spreads any
 * extra props onto the underlying `<Badge>`. Fluent v9's `Tooltip` clones
 * its child element to inject a `ref` (used to measure/position the
 * tooltip against the trigger) and `aria-describedby` — a PLAIN function
 * component (this component's shape before this fix) cannot accept a ref
 * at all (React silently drops it, with a dev-mode console warning), so
 * every `<Tooltip><StatusBadge .../></Tooltip>` in this app — including
 * pre-existing ones in Monitoring.tsx — never actually positioned or
 * described correctly. Every other existing call site (a bare
 * `<StatusBadge label=... tone=.../>` with no wrapping Tooltip) is
 * unaffected: forwardRef components render identically to plain function
 * components when no ref is passed.
 */
const StatusBadge = forwardRef<HTMLDivElement, StatusBadgeProps>(function StatusBadge({ label, tone = 'info', ...rest }, ref) {
  return (
    <Badge ref={ref} appearance={TONE_TO_APPEARANCE[tone]} color={TONE_TO_COLOR[tone]} shape="rounded" {...rest}>
      {label}
    </Badge>
  );
});

export default StatusBadge;
