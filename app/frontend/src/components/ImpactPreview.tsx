import { useId } from 'react';
import { makeStyles, tokens, Text } from '@fluentui/react-components';
import { Info16Regular, Warning16Filled } from '@fluentui/react-icons';
import { MAX_IMPACT_LINES, type ImpactLine } from '../lib/impactPreview';
import { useVisuallyHiddenStyles } from '../styles/shared';

const useStyles = makeStyles({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  headingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  headingIcon: {
    color: tokens.colorNeutralForeground2,
    flexShrink: 0,
  },
  list: {
    margin: 0,
    // AM-29 item 24-style scroll consideration doesn't apply here (this is
    // prose, not a wide table), but the left indent still needs its own
    // token rather than a bare padding-left magic number.
    paddingLeft: tokens.spacingHorizontalXXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  // AM-33 peer review (Opus, MINOR 11): each line is its own flex row
  // (icon + text) rather than relying on a literal JSX space character
  // between them — a `gap` token positions the icon correctly regardless
  // of whether it's present, so an info line (no icon) never inherits a
  // stray leading space the way `{cond && <Icon/>} {text}` would.
  lineRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalXXS,
  },
  lineInfo: {
    color: tokens.colorNeutralForeground1,
  },
  // AM-33 peer review (Opus, MINOR 6): fontWeightSemibold now lives on the
  // <Text weight="semibold"> prop below, not as a raw CSS rule here — this
  // class carries color only. The old fontWeight rule here was dead CSS:
  // Fluent's <Text> component sets its own font-weight token via its own
  // `weight` prop machinery, which wins the cascade over an ancestor `<li>`
  // rule targeting a completely different element.
  lineWarning: {
    color: tokens.colorStatusWarningForeground1,
  },
  warningIcon: {
    color: tokens.colorStatusWarningForeground1,
    flexShrink: 0,
    // Nudges the icon down to align with the first line of text rather than
    // the line-box's own top edge.
    marginTop: '2px',
  },
});

export interface ImpactPreviewProps {
  /** 1-4 bullet lines — see MAX_IMPACT_LINES in lib/impactPreview.ts. A plain string is shorthand for an 'info'-toned line. */
  lines: Array<ImpactLine | string>;
  /** Defaults to "What this will do" — override only when a call site needs different wording (none currently do). */
  heading?: string;
}

/**
 * AM-33 (D5) — the shared "what this will do" panel, designed to slot into
 * ConfirmModal's existing `impact` node prop (rendered above the
 * typed-name/reason gate). Generalizes the image-build wizard's dry-run
 * (ImageBuildSection.tsx's "Preview plan" — this app's best interaction) so
 * every other high/medium-severity mutating action gets the same
 * comprehension-first treatment WITHOUT a server round-trip: every line
 * shown here is computed client-side from data the page already fetched —
 * see lib/impactPreview.ts's per-flow helpers, which this component stays
 * deliberately thin around (no data-shaping logic lives in this file).
 *
 * Renders nothing (not even the panel chrome) when `lines` is empty — a
 * caller with nothing useful to say should omit the panel entirely rather
 * than show an empty box.
 *
 * AM-33 peer review (Opus, MINOR 10): every lib/impactPreview.ts helper
 * already keeps its OWN output within MAX_IMPACT_LINES (folding any
 * remainder into a final "+N more" line specific to that flow's wording).
 * This component's own defensive cap is therefore a backstop for a future
 * helper that doesn't — and a silent `.slice()` there would drop lines
 * without any indication anything was cut, so the backstop itself now
 * appends a generic "+N more" line rather than truncating invisibly.
 */
export default function ImpactPreview({ lines, heading = 'What this will do' }: ImpactPreviewProps) {
  const styles = useStyles();
  const visuallyHiddenStyles = useVisuallyHiddenStyles();
  const headingId = useId();
  if (lines.length === 0) return null;

  const asLines: ImpactLine[] = lines.map((line) => (typeof line === 'string' ? { text: line, tone: 'info' } : line));
  const normalized: ImpactLine[] =
    asLines.length <= MAX_IMPACT_LINES
      ? asLines
      : [...asLines.slice(0, MAX_IMPACT_LINES - 1), { text: `+${asLines.length - (MAX_IMPACT_LINES - 1)} more`, tone: 'info' }];

  return (
    <div className={styles.panel}>
      <div className={styles.headingRow}>
        <Info16Regular className={styles.headingIcon} aria-hidden="true" />
        <Text id={headingId} weight="semibold" size={200}>
          {heading}
        </Text>
      </div>
      {/* AM-33 peer review (Opus, MINOR 11/12): explicit list/listitem roles
          (a flex `display` on <ul>/<li> strips their implicit list semantics
          in Safari/VoiceOver) and aria-labelledby linking the list back to
          the heading above it. */}
      <ul className={styles.list} role="list" aria-labelledby={headingId}>
        {normalized.map((line, index) => {
          const isWarning = line.tone === 'warning';
          return (
            <li key={index} role="listitem">
              <span className={styles.lineRow}>
                {isWarning && <Warning16Filled aria-hidden="true" className={styles.warningIcon} />}
                <Text size={200} weight={isWarning ? 'semibold' : undefined} className={isWarning ? styles.lineWarning : styles.lineInfo}>
                  {isWarning && <span className={visuallyHiddenStyles.visuallyHidden}>Warning: </span>}
                  {line.text}
                </Text>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
