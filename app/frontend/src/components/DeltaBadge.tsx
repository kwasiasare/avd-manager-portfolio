import { Badge } from '@fluentui/react-components';

export interface DeltaBadgeProps {
  current: number;
  comparison: number | undefined;
}

/**
 * A small "+12% vs prior period" / "-8% vs prior period" pill. Shared by
 * CostScaling's cost cards and Dashboard's cost tile (AM-29 item 21) — was
 * previously a CostScaling-local function; extracted here so both pages
 * compute/render the delta identically rather than maintaining two copies.
 * Renders nothing when there's no comparison value to derive a delta from
 * (undefined), the comparison is exactly 0 (a percentage change against
 * zero is undefined/infinite, not a real number worth displaying), or the
 * comparison is NEGATIVE (peer review NIT, Opus) — both of this badge's
 * real inputs (cost, host/session counts) should never sensibly be
 * negative, so a negative prior-period value only happens from a data
 * anomaly upstream; dividing by a negative number flips which SIGN counts
 * as "up" vs "down" (e.g. current=5, comparison=-10 computes a NEGATIVE
 * 150% — read as a big decrease — despite the value actually having
 * increased), which would render an actively misleading badge rather than
 * just an unhelpful one.
 */
export default function DeltaBadge({ current, comparison }: DeltaBadgeProps) {
  if (comparison === undefined || comparison <= 0) {
    return null;
  }
  const deltaPct = ((current - comparison) / comparison) * 100;
  const isUp = deltaPct > 0;
  const magnitude = Math.abs(deltaPct).toFixed(0);
  return (
    <Badge appearance="tint" color={isUp ? 'warning' : 'success'} size="small" aria-label={`${magnitude}% ${isUp ? 'higher' : 'lower'} than prior period`}>
      {isUp ? '+' : ''}
      {deltaPct.toFixed(0)}% vs prior period
    </Badge>
  );
}
