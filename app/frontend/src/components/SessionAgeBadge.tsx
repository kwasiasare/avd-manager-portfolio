import { Tooltip } from '@fluentui/react-components';
import StatusBadge from './StatusBadge';
import { describeAgeReason, formatSessionAge, type SessionAgeInfo } from '../lib/sessionAge';

export interface SessionAgeBadgeProps {
  info: SessionAgeInfo;
}

/**
 * Renders a session's age as a colored badge (green/yellow/red/neutral per
 * lib/sessionAge's thresholds) plus the age text itself — color is never the
 * only signal. When the tone isn't the default "ok", a tooltip adds *why*
 * as a description (relationship="description"), not the accessible name:
 * relationship="label" would set aria-label to the reason text and REPLACE
 * the badge's own age text as what a screen reader announces, silently
 * dropping the age value. No tabIndex here deliberately — the age text is
 * always visible/announced without needing focus, and every age cell stays
 * consistent (none of them are keyboard tab stops) rather than only the
 * flagged ones being reachable.
 */
export default function SessionAgeBadge({ info }: SessionAgeBadgeProps) {
  const label = formatSessionAge(info.ageMs);
  const badge = <StatusBadge label={label} tone={info.tone} />;
  const reasonText = describeAgeReason(info);

  if (!reasonText) {
    return badge;
  }

  return (
    <Tooltip content={reasonText} relationship="description">
      <span>{badge}</span>
    </Tooltip>
  );
}
