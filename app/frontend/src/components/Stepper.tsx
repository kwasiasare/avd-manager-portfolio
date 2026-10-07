import { makeStyles, mergeClasses, tokens, Text, ProgressBar } from '@fluentui/react-components';
import { DismissCircle16Filled } from '@fluentui/react-icons';
import StatusBadge, { type StatusTone } from './StatusBadge';
import { formatDuration, formatElapsed } from '../lib/format';
import { useNowTick } from '../hooks/useNowTick';

export type StepperStepState = 'done' | 'current' | 'upcoming';

export interface StepperStep {
  /** Stable key — e.g. a RolloutState value or an ImageBuildStepId. */
  id: string;
  label: string;
  /** Position relative to the step currently being worked — drives the default tone/status label and aria-current. */
  state: StepperStepState;
  /** Overrides the state-derived tone — e.g. a FAILED step is positionally "current" (nothing after it has happened) but must read as an error, not the generic in-progress tone. */
  tone?: StatusTone;
  /** Overrides the state-derived badge text (e.g. "Failed", "Succeeded", a raw ImageBuildStepStatus string). */
  statusLabel?: string;
  /** ISO instant this step started — feeds the live "Xm elapsed" text while `state === 'current'` (ticks every 30s via useNowTick). Also feeds the STATIC startedAt→completedAt duration on a 'done' step, paired with `completedAt` below. */
  startedAt?: string;
  /** ISO instant this step finished — paired with `startedAt` to render a static "Xm" duration on a 'done' step, so post-mortem timing survives now that the old StepsTable (which used to show a plain started/completed pair for every step, live or not) is gone. Ignored for 'current'/'upcoming' steps. */
  completedAt?: string;
  /** Optional "typically ~X min" duration hint shown next to the label. */
  hint?: string;
  /** Shows an indeterminate ProgressBar under this step — for automatic (non-operator-gated) in-flight phases. */
  inFlight?: boolean;
  error?: string;
}

export interface StepperProps {
  steps: StepperStep[];
  orientation?: 'horizontal' | 'vertical';
  ariaLabel: string;
}

const DEFAULT_TONE: Record<StepperStepState, StatusTone> = {
  done: 'ok',
  current: 'info',
  upcoming: 'pending',
};

const DEFAULT_STATUS_LABEL: Record<StepperStepState, string> = {
  done: 'Done',
  current: 'In progress',
  upcoming: 'Pending',
};

const useStyles = makeStyles({
  horizontalList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },
  verticalList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  horizontalStep: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  verticalStep: {
    padding: tokens.spacingVerticalXS,
  },
  stepCurrent: {
    backgroundColor: tokens.colorNeutralBackground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  horizontalStepCurrent: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  stepDone: {
    color: tokens.colorNeutralForeground3,
  },
  meta: {
    color: tokens.colorNeutralForeground3,
  },
  errorText: {
    flexBasis: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorStatusDangerForeground1,
  },
  errorIcon: {
    flexShrink: 0,
  },
  progressWrap: {
    flexBasis: '100%',
    marginTop: tokens.spacingVerticalXXS,
  },
});

/**
 * AM-31 item 35 — the one Stepper component every ordered-progress display
 * in this app now uses: RolloutWizard's happy-path pills (horizontal) and
 * ImageBuildSection's build-step list (vertical, which also absorbed and
 * DELETED the duplicate StepsTable that used to render the exact same steps
 * a second time as a plain table beneath the live list).
 *
 * Renders a real `<ol>` with `aria-current="step"` on whichever step is
 * `state: 'current'` — screen readers get an ordered list with the active
 * step explicitly marked, not just a visual highlight. A `current` step with
 * `startedAt` shows a live "Xm elapsed" text (ticking every 30s via
 * useNowTick — gated to only actually run the interval while at least one
 * step needs it, see useNowTick's own `enabled` param — formatted by
 * lib/format.ts#formatElapsed); a `done` step with both `startedAt` and
 * `completedAt` shows a STATIC "Xm" duration instead (lib/format.ts#
 * formatDuration) — this is the one piece of the deleted StepsTable's
 * started/completed columns that Stepper's live-elapsed text alone did NOT
 * carry over (elapsed-in-step only ever applied to the CURRENT step, so a
 * step that finished already had nothing showing how long it took — the
 * comment that used to claim otherwise here was wrong); `hint` shows a
 * static "typically ~X min" duration estimate next to any step regardless of
 * its state; `inFlight` renders an indeterminate ProgressBar beneath the
 * step for phases that run automatically (no operator action pending).
 */
export default function Stepper({ steps, orientation = 'horizontal', ariaLabel }: StepperProps) {
  const styles = useStyles();
  const hasLiveStep = steps.some((step) => step.state === 'current' && step.startedAt);
  const now = useNowTick(30_000, hasLiveStep);
  const isHorizontal = orientation === 'horizontal';

  return (
    <ol className={isHorizontal ? styles.horizontalList : styles.verticalList} aria-label={ariaLabel}>
      {steps.map((step) => {
        const tone = step.tone ?? DEFAULT_TONE[step.state];
        const statusLabel = step.statusLabel ?? DEFAULT_STATUS_LABEL[step.state];
        const elapsed = step.state === 'current' ? formatElapsed(step.startedAt, now) : undefined;
        const duration = step.state === 'done' ? formatDuration(step.startedAt, step.completedAt) : undefined;
        return (
          <li
            key={step.id}
            className={mergeClasses(
              styles.step,
              isHorizontal ? styles.horizontalStep : styles.verticalStep,
              step.state === 'current' && (isHorizontal ? styles.horizontalStepCurrent : styles.stepCurrent),
              step.state === 'done' && styles.stepDone,
            )}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <StatusBadge label={statusLabel} tone={tone} size="small" />
            <Text>{step.label}</Text>
            {step.hint && (
              <Text size={200} className={styles.meta}>
                typically ~{step.hint}
              </Text>
            )}
            {elapsed && (
              <Text size={200} className={styles.meta}>
                {elapsed}
              </Text>
            )}
            {duration && (
              <Text size={200} className={styles.meta}>
                {duration}
              </Text>
            )}
            {step.error && (
              <Text size={200} block className={styles.errorText}>
                <DismissCircle16Filled className={styles.errorIcon} aria-hidden="true" />
                {step.error}
              </Text>
            )}
            {step.inFlight && (
              <div className={styles.progressWrap}>
                <ProgressBar thickness="medium" aria-label={`${step.label} in progress`} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
