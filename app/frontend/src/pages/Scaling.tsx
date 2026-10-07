import { useMemo, useState } from 'react';
import {
  makeStyles,
  mergeClasses,
  tokens,
  Card,
  CardHeader,
  Text,
  Badge,
  Button,
  Field,
  Input,
  Textarea,
  Dropdown,
  Option,
  Switch,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
} from '@fluentui/react-components';
import {
  computeScalingPhase,
  KNOWN_DAY_NAMES,
  type LoadBalancingAlgorithm,
  type ScalingHistoryEntry,
  type ScalingScheduleDetail,
  type StopHostsWhen,
} from '@avdmgr/shared';
import {
  activateEmergencyOverride,
  cancelEmergencyOverride,
  createScalingSchedule,
  deleteScalingSchedule,
  getCurrentScalingPlan,
  getEmergencyOverrideStatus,
  getScalingHistory,
  updateScalingSchedule,
} from '../api/avd';
import { ApiClientError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { useDialogFocusRestore } from '../hooks/useDialogFocusRestore';
import AsyncState from '../components/AsyncState';
import ConfirmModal from '../components/ConfirmModal';
import ImpactPreview from '../components/ImpactPreview';
import RoleGate from '../components/RoleGate';
import StatusBadge, { type StatusTone } from '../components/StatusBadge';
import PageHeader from '../components/PageHeader';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { formatDateTime } from '../lib/format';
import { emergencyOverridePreviewLines, scheduleDeletePreviewLines } from '../lib/impactPreview';
import { useCardStyles } from '../styles/shared';
import { PHASE_LABEL, PHASE_TIMELINE_COLOR, PHASE_TONE, PHASE_LEGEND_SWATCH_SIZE, PHASE_LEGEND_SWATCH_BORDER_WIDTH } from '../lib/phaseColor';

/**
 * AM-31 item 32b — split off CostScaling.tsx's scaling-plan half (schedule
 * editor, day timeline, emergency override, change history): the operator's
 * fast-moving 20s-polled surface. See Cost.tsx for the admin's slower,
 * 5-minute-polled cost-dashboard half — the two used to share one 1,666-line
 * file joining a 20s operator surface to a 5min admin surface under one nav
 * item, which this split (plus the /scaling + /cost routes and the two
 * nav entries under Plan — see App.tsx/Layout.tsx) separates cleanly. The
 * old /cost-scaling route now redirects here (App.tsx).
 */
const PLAN_POLL_INTERVAL_MS = 60_000;
const OVERRIDE_POLL_INTERVAL_MS = 20_000;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  scalingCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  propsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: tokens.spacingVerticalM,
  },
  propLabel: {
    color: tokens.colorNeutralForeground3,
  },
  label: {
    color: tokens.colorNeutralForeground3,
  },
  scheduleCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  scheduleHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  dayChips: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
  },
  timelineBar: {
    display: 'flex',
    width: '100%',
    height: '24px',
    borderRadius: tokens.borderRadiusSmall,
    overflow: 'hidden',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  timelineLegend: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  // AM-31 item 42: 12px + 1px border (previously a borderless 10px square) — see lib/phaseColor.ts's PHASE_LEGEND_SWATCH_SIZE/PHASE_LEGEND_SWATCH_BORDER_WIDTH doc comment.
  legendSwatch: {
    width: PHASE_LEGEND_SWATCH_SIZE,
    height: PHASE_LEGEND_SWATCH_SIZE,
    borderRadius: '2px',
    border: `${PHASE_LEGEND_SWATCH_BORDER_WIDTH} solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
  },
  fieldsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: tokens.spacingVerticalM,
    columnGap: tokens.spacingHorizontalM,
  },
  actionsRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
  },
  banner: {
    fontWeight: tokens.fontWeightSemibold,
  },
  dayToggle: {
    minWidth: '40px',
  },
});

const LOAD_BALANCING_OPTIONS: LoadBalancingAlgorithm[] = ['BreadthFirst', 'DepthFirst'];
const STOP_HOSTS_WHEN_OPTIONS: StopHostsWhen[] = ['ZeroActiveSessions', 'ZeroSessions'];

interface PhaseSegment {
  phase: 'RampUp' | 'Peak' | 'RampDown' | 'OffPeak';
  widthPct: number;
}

const MINUTES_PER_DAY = 24 * 60;

function minutesOf(period: { hour: number; minute: number }): number {
  return period.hour * 60 + period.minute;
}

/**
 * Builds the proportional segments (RampUp/Peak/RampDown/OffPeak) covering a
 * full 24h day for one schedule, wrapping around midnight — same
 * boundary-sort/wraparound logic @avdmgr/shared's computeScalingPhase uses
 * to determine which phase is CURRENTLY active, applied here to lay out the
 * whole day instead of just "now".
 *
 * Peer review (AM-23 MAJOR 5): two adjacent boundaries with the SAME start
 * time must produce a ZERO-length segment, not a full 1440-minute
 * (100%-width) one. Zero-width segments are filtered out entirely. If every
 * phase starts at the same time, this returns a single neutral full-width
 * placeholder instead of an empty bar.
 */
function scheduleSegments(schedule: ScalingScheduleDetail): PhaseSegment[] {
  const unsorted: Array<{ phase: PhaseSegment['phase']; start: number }> = [
    { phase: 'RampUp', start: minutesOf(schedule.rampUpStartTime) },
    { phase: 'Peak', start: minutesOf(schedule.peakStartTime) },
    { phase: 'RampDown', start: minutesOf(schedule.rampDownStartTime) },
    { phase: 'OffPeak', start: minutesOf(schedule.offPeakStartTime) },
  ];
  const boundaries = unsorted.sort((a, b) => a.start - b.start);

  const segments = boundaries
    .map((boundary, index) => {
      const next = boundaries[(index + 1) % boundaries.length];
      let duration: number;
      if (next.start === boundary.start) {
        duration = 0;
      } else if (next.start > boundary.start) {
        duration = next.start - boundary.start;
      } else {
        duration = MINUTES_PER_DAY - boundary.start + next.start;
      }
      return { phase: boundary.phase, widthPct: (duration / MINUTES_PER_DAY) * 100 };
    })
    .filter((segment) => segment.widthPct > 0);

  return segments.length > 0 ? segments : [{ phase: 'OffPeak', widthPct: 100 }];
}

/**
 * Client-side mirror of the API's day-coverage guard
 * (app/api/src/lib/scalingValidation.ts#computeUncoveredDays) — computes
 * which of the 7 days would be covered by ZERO schedules after a simulated
 * change, so the edit/create/delete dialogs can show a BLOCKING warning
 * before the operator even submits. The server remains the authoritative
 * check regardless — this is purely a faster, friendlier feedback loop.
 */
function computeUncoveredDaysClient(schedules: ScalingScheduleDetail[], simulate: { name?: string; daysOfWeek: string[] }): string[] {
  const covered = new Set<string>();
  for (const schedule of schedules) {
    const daysOfWeek = schedule.name === simulate.name ? simulate.daysOfWeek : schedule.daysOfWeek;
    for (const day of daysOfWeek) covered.add(day);
  }
  return KNOWN_DAY_NAMES.filter((day) => !covered.has(day));
}

function computeUncoveredDaysForDelete(schedules: ScalingScheduleDetail[], deletedName: string): string[] {
  const covered = new Set<string>();
  for (const schedule of schedules) {
    if (schedule.name === deletedName) continue;
    for (const day of schedule.daysOfWeek) covered.add(day);
  }
  return KNOWN_DAY_NAMES.filter((day) => !covered.has(day));
}

function computeUncoveredDaysForCreate(schedules: ScalingScheduleDetail[], newDaysOfWeek: string[]): string[] {
  const covered = new Set<string>(newDaysOfWeek);
  for (const schedule of schedules) {
    for (const day of schedule.daysOfWeek) covered.add(day);
  }
  return KNOWN_DAY_NAMES.filter((day) => !covered.has(day));
}

function timeToInputValue(period: { hour: number; minute: number }): string {
  return `${String(period.hour).padStart(2, '0')}:${String(period.minute).padStart(2, '0')}`;
}

function inputValueToTime(value: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return { hour, minute };
}

/** Form state shared by the edit and create dialogs. */
interface ScheduleFormValues {
  name: string;
  daysOfWeek: string[];
  rampUpStartTime: string;
  rampUpLoadBalancingAlgorithm: LoadBalancingAlgorithm | '';
  rampUpMinimumHostsPct: string;
  rampUpCapacityThresholdPct: string;
  peakStartTime: string;
  peakLoadBalancingAlgorithm: LoadBalancingAlgorithm | '';
  rampDownStartTime: string;
  rampDownLoadBalancingAlgorithm: LoadBalancingAlgorithm | '';
  rampDownMinimumHostsPct: string;
  rampDownCapacityThresholdPct: string;
  rampDownForceLogoffUsers: boolean;
  rampDownStopHostsWhen: StopHostsWhen | '';
  rampDownWaitTimeMinutes: string;
  rampDownNotificationMessage: string;
  offPeakStartTime: string;
  offPeakLoadBalancingAlgorithm: LoadBalancingAlgorithm | '';
  reason: string;
}

function formValuesFromSchedule(schedule?: ScalingScheduleDetail): ScheduleFormValues {
  return {
    name: schedule?.name ?? '',
    daysOfWeek: schedule?.daysOfWeek ?? [],
    rampUpStartTime: schedule ? timeToInputValue(schedule.rampUpStartTime) : '08:00',
    rampUpLoadBalancingAlgorithm: schedule?.rampUpLoadBalancingAlgorithm ?? '',
    rampUpMinimumHostsPct: schedule?.rampUpMinimumHostsPct !== undefined ? String(schedule.rampUpMinimumHostsPct) : '',
    rampUpCapacityThresholdPct: schedule?.rampUpCapacityThresholdPct !== undefined ? String(schedule.rampUpCapacityThresholdPct) : '',
    peakStartTime: schedule ? timeToInputValue(schedule.peakStartTime) : '09:00',
    peakLoadBalancingAlgorithm: schedule?.peakLoadBalancingAlgorithm ?? '',
    rampDownStartTime: schedule ? timeToInputValue(schedule.rampDownStartTime) : '18:00',
    rampDownLoadBalancingAlgorithm: schedule?.rampDownLoadBalancingAlgorithm ?? '',
    rampDownMinimumHostsPct: schedule?.rampDownMinimumHostsPct !== undefined ? String(schedule.rampDownMinimumHostsPct) : '',
    rampDownCapacityThresholdPct: schedule?.rampDownCapacityThresholdPct !== undefined ? String(schedule.rampDownCapacityThresholdPct) : '',
    rampDownForceLogoffUsers: schedule?.rampDownForceLogoffUsers ?? false,
    rampDownStopHostsWhen: schedule?.rampDownStopHostsWhen ?? '',
    rampDownWaitTimeMinutes: schedule?.rampDownWaitTimeMinutes !== undefined ? String(schedule.rampDownWaitTimeMinutes) : '',
    rampDownNotificationMessage: schedule?.rampDownNotificationMessage ?? '',
    offPeakStartTime: schedule ? timeToInputValue(schedule.offPeakStartTime) : '20:00',
    offPeakLoadBalancingAlgorithm: schedule?.offPeakLoadBalancingAlgorithm ?? '',
    reason: '',
  };
}

const API_FIELD_KEYS = [
  'daysOfWeek',
  'rampUpStartTime',
  'rampUpLoadBalancingAlgorithm',
  'rampUpMinimumHostsPct',
  'rampUpCapacityThresholdPct',
  'peakStartTime',
  'peakLoadBalancingAlgorithm',
  'rampDownStartTime',
  'rampDownLoadBalancingAlgorithm',
  'rampDownMinimumHostsPct',
  'rampDownCapacityThresholdPct',
  'rampDownForceLogoffUsers',
  'rampDownStopHostsWhen',
  'rampDownWaitTimeMinutes',
  'rampDownNotificationMessage',
  'offPeakStartTime',
  'offPeakLoadBalancingAlgorithm',
] as const;
type ApiFieldKey = (typeof API_FIELD_KEYS)[number];

function apiValueFor(values: ScheduleFormValues, key: ApiFieldKey): unknown {
  switch (key) {
    case 'daysOfWeek':
      return values.daysOfWeek.length > 0 ? values.daysOfWeek : undefined;
    case 'rampUpStartTime':
    case 'peakStartTime':
    case 'rampDownStartTime':
    case 'offPeakStartTime':
      return inputValueToTime(values[key]);
    case 'rampUpLoadBalancingAlgorithm':
    case 'peakLoadBalancingAlgorithm':
    case 'rampDownLoadBalancingAlgorithm':
    case 'offPeakLoadBalancingAlgorithm':
      return values[key] || undefined;
    case 'rampUpMinimumHostsPct':
    case 'rampUpCapacityThresholdPct':
    case 'rampDownMinimumHostsPct':
    case 'rampDownCapacityThresholdPct':
    case 'rampDownWaitTimeMinutes': {
      const raw = values[key].trim();
      if (raw === '') return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'rampDownForceLogoffUsers':
      return values.rampDownForceLogoffUsers;
    case 'rampDownStopHostsWhen':
      return values.rampDownStopHostsWhen || undefined;
    case 'rampDownNotificationMessage':
      return values.rampDownNotificationMessage || undefined;
  }
}

const FIELD_LABELS: Partial<Record<ApiFieldKey, string>> = {
  rampUpStartTime: 'Ramp-up start',
  peakStartTime: 'Peak start',
  rampDownStartTime: 'Ramp-down start',
  offPeakStartTime: 'Off-peak start',
  rampUpMinimumHostsPct: 'Ramp-up min hosts (%)',
  rampUpCapacityThresholdPct: 'Ramp-up capacity threshold (%)',
  rampDownMinimumHostsPct: 'Ramp-down min hosts (%)',
  rampDownCapacityThresholdPct: 'Ramp-down capacity threshold (%)',
  rampDownWaitTimeMinutes: 'Ramp-down wait time (minutes)',
};

const TIME_FIELD_KEYS = ['rampUpStartTime', 'peakStartTime', 'rampDownStartTime', 'offPeakStartTime'] as const;
const NUMERIC_FIELD_KEYS = ['rampUpMinimumHostsPct', 'rampUpCapacityThresholdPct', 'rampDownMinimumHostsPct', 'rampDownCapacityThresholdPct', 'rampDownWaitTimeMinutes'] as const;

/**
 * Peer review (AM-23 MAJOR 4): distinguishes "unchanged" from "cleared" from
 * "invalid" for every time/numeric field, and returns a human-readable
 * message per problem field — callers BLOCK submission when this returns
 * any issues.
 */
function validateScheduleFormFields(values: ScheduleFormValues, original: ScheduleFormValues | undefined): string[] {
  const issues: string[] = [];
  for (const field of TIME_FIELD_KEYS) {
    const raw = values[field];
    if (raw && inputValueToTime(raw) === undefined) {
      issues.push(`${FIELD_LABELS[field]}: enter a valid time (HH:MM).`);
    }
  }
  for (const field of NUMERIC_FIELD_KEYS) {
    const raw = values[field].trim();
    if (raw === '') {
      if (original && original[field].trim() !== '') {
        issues.push(`${FIELD_LABELS[field]}: this field can't be cleared once set — enter a value, or close this dialog without saving to leave it unchanged.`);
      }
      continue;
    }
    if (!Number.isFinite(Number(raw))) {
      issues.push(`${FIELD_LABELS[field]}: enter a whole number.`);
    }
  }
  return issues;
}

function buildPatchBody(values: ScheduleFormValues, original: ScheduleFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of API_FIELD_KEYS) {
    if (JSON.stringify(values[key]) !== JSON.stringify(original[key])) {
      const apiValue = apiValueFor(values, key);
      if (apiValue !== undefined) {
        body[key] = apiValue;
      }
    }
  }
  return body;
}

function buildCreateBody(values: ScheduleFormValues): Omit<Parameters<typeof createScalingSchedule>[0], 'reason'> & { reason?: string } {
  const required = {
    name: values.name,
    daysOfWeek: values.daysOfWeek,
    rampUpStartTime: inputValueToTime(values.rampUpStartTime)!,
    peakStartTime: inputValueToTime(values.peakStartTime)!,
    rampDownStartTime: inputValueToTime(values.rampDownStartTime)!,
    offPeakStartTime: inputValueToTime(values.offPeakStartTime)!,
  };
  const optional: Record<string, unknown> = {};
  for (const key of API_FIELD_KEYS) {
    if (key in required) continue;
    const apiValue = apiValueFor(values, key);
    if (apiValue !== undefined) {
      optional[key] = apiValue;
    }
  }
  return { ...required, ...optional };
}

function DayOfWeekPicker({ value, onChange, styles }: { value: string[]; onChange: (next: string[]) => void; styles: ReturnType<typeof useStyles> }) {
  return (
    <div className={styles.dayChips} role="group" aria-label="Days of week">
      {KNOWN_DAY_NAMES.map((day) => {
        const selected = value.includes(day);
        return (
          <Button
            key={day}
            className={styles.dayToggle}
            size="small"
            appearance={selected ? 'primary' : 'secondary'}
            aria-pressed={selected}
            onClick={() => onChange(selected ? value.filter((d) => d !== day) : [...value, day])}
          >
            {selected ? '✓ ' : ''}
            {day.slice(0, 3)}
          </Button>
        );
      })}
    </div>
  );
}

function ScheduleFieldsForm({
  values,
  onChange,
  showName,
  reasonRequired,
  timeZone,
  styles,
}: {
  values: ScheduleFormValues;
  onChange: (next: ScheduleFormValues) => void;
  showName: boolean;
  reasonRequired: boolean;
  timeZone: string | undefined;
  styles: ReturnType<typeof useStyles>;
}) {
  const set = <K extends keyof ScheduleFormValues>(key: K, value: ScheduleFormValues[K]) => onChange({ ...values, [key]: value });
  const tzHint = timeZone ? ` (${timeZone})` : '';

  return (
    <div className={styles.fieldsGrid}>
      {showName && (
        <Field label="Schedule name" required>
          <Input value={values.name} onChange={(_e, d) => set('name', d.value)} maxLength={64} />
        </Field>
      )}
      <Field label="Days of week" required>
        <DayOfWeekPicker value={values.daysOfWeek} onChange={(next) => set('daysOfWeek', next)} styles={styles} />
      </Field>

      <Field label="Ramp-up start" hint={`Plan time zone${tzHint}`}>
        <Input type="time" value={values.rampUpStartTime} onChange={(_e, d) => set('rampUpStartTime', d.value)} />
      </Field>
      <Field label="Ramp-up load balancing">
        <Dropdown
          value={values.rampUpLoadBalancingAlgorithm}
          selectedOptions={values.rampUpLoadBalancingAlgorithm ? [values.rampUpLoadBalancingAlgorithm] : []}
          onOptionSelect={(_e, d) => set('rampUpLoadBalancingAlgorithm', (d.optionValue as LoadBalancingAlgorithm) ?? '')}
        >
          {LOAD_BALANCING_OPTIONS.map((option) => (
            <Option key={option} value={option} text={option}>
              {option}
            </Option>
          ))}
        </Dropdown>
      </Field>
      <Field label="Ramp-up min hosts (%)" hint="0-100">
        <Input type="number" min={0} max={100} value={values.rampUpMinimumHostsPct} onChange={(_e, d) => set('rampUpMinimumHostsPct', d.value)} />
      </Field>
      <Field label="Ramp-up capacity threshold (%)" hint="1-100">
        <Input type="number" min={1} max={100} value={values.rampUpCapacityThresholdPct} onChange={(_e, d) => set('rampUpCapacityThresholdPct', d.value)} />
      </Field>

      <Field label="Peak start" hint={`Plan time zone${tzHint}`}>
        <Input type="time" value={values.peakStartTime} onChange={(_e, d) => set('peakStartTime', d.value)} />
      </Field>
      <Field label="Peak load balancing">
        <Dropdown
          value={values.peakLoadBalancingAlgorithm}
          selectedOptions={values.peakLoadBalancingAlgorithm ? [values.peakLoadBalancingAlgorithm] : []}
          onOptionSelect={(_e, d) => set('peakLoadBalancingAlgorithm', (d.optionValue as LoadBalancingAlgorithm) ?? '')}
        >
          {LOAD_BALANCING_OPTIONS.map((option) => (
            <Option key={option} value={option} text={option}>
              {option}
            </Option>
          ))}
        </Dropdown>
      </Field>

      <Field label="Ramp-down start" hint={`Plan time zone${tzHint}`}>
        <Input type="time" value={values.rampDownStartTime} onChange={(_e, d) => set('rampDownStartTime', d.value)} />
      </Field>
      <Field label="Ramp-down load balancing">
        <Dropdown
          value={values.rampDownLoadBalancingAlgorithm}
          selectedOptions={values.rampDownLoadBalancingAlgorithm ? [values.rampDownLoadBalancingAlgorithm] : []}
          onOptionSelect={(_e, d) => set('rampDownLoadBalancingAlgorithm', (d.optionValue as LoadBalancingAlgorithm) ?? '')}
        >
          {LOAD_BALANCING_OPTIONS.map((option) => (
            <Option key={option} value={option} text={option}>
              {option}
            </Option>
          ))}
        </Dropdown>
      </Field>
      <Field label="Ramp-down min hosts (%)" hint="0-100">
        <Input type="number" min={0} max={100} value={values.rampDownMinimumHostsPct} onChange={(_e, d) => set('rampDownMinimumHostsPct', d.value)} />
      </Field>
      <Field label="Ramp-down capacity threshold (%)" hint="1-100">
        <Input type="number" min={1} max={100} value={values.rampDownCapacityThresholdPct} onChange={(_e, d) => set('rampDownCapacityThresholdPct', d.value)} />
      </Field>
      <Field label="Force logoff users during ramp-down">
        <Switch checked={values.rampDownForceLogoffUsers} onChange={(_e, d) => set('rampDownForceLogoffUsers', d.checked)} />
      </Field>
      <Field label="Stop hosts when">
        <Dropdown
          value={values.rampDownStopHostsWhen}
          selectedOptions={values.rampDownStopHostsWhen ? [values.rampDownStopHostsWhen] : []}
          onOptionSelect={(_e, d) => set('rampDownStopHostsWhen', (d.optionValue as StopHostsWhen) ?? '')}
        >
          {STOP_HOSTS_WHEN_OPTIONS.map((option) => (
            <Option key={option} value={option} text={option}>
              {option}
            </Option>
          ))}
        </Dropdown>
      </Field>
      <Field label="Ramp-down wait time (minutes)">
        <Input type="number" min={0} value={values.rampDownWaitTimeMinutes} onChange={(_e, d) => set('rampDownWaitTimeMinutes', d.value)} />
      </Field>
      <Field label="Ramp-down notification message" style={{ gridColumn: '1 / -1' }}>
        <Textarea value={values.rampDownNotificationMessage} onChange={(_e, d) => set('rampDownNotificationMessage', d.value)} resize="vertical" maxLength={1000} />
      </Field>

      <Field label="Off-peak start" hint={`Plan time zone${tzHint}`}>
        <Input type="time" value={values.offPeakStartTime} onChange={(_e, d) => set('offPeakStartTime', d.value)} />
      </Field>
      <Field label="Off-peak load balancing">
        <Dropdown
          value={values.offPeakLoadBalancingAlgorithm}
          selectedOptions={values.offPeakLoadBalancingAlgorithm ? [values.offPeakLoadBalancingAlgorithm] : []}
          onOptionSelect={(_e, d) => set('offPeakLoadBalancingAlgorithm', (d.optionValue as LoadBalancingAlgorithm) ?? '')}
        >
          {LOAD_BALANCING_OPTIONS.map((option) => (
            <Option key={option} value={option} text={option}>
              {option}
            </Option>
          ))}
        </Dropdown>
      </Field>

      <Field label={`Reason${reasonRequired ? ' (required)' : ' (optional)'}`} style={{ gridColumn: '1 / -1' }}>
        <Textarea value={values.reason} onChange={(_e, d) => set('reason', d.value)} resize="vertical" maxLength={1000} placeholder="Why is this change needed?" />
      </Field>
    </div>
  );
}

/** AM-29 item 16: 'pending' tone for the disabled state (was a raw `Badge color="subtle"` escape). */
function StatusBadgeInline({ enabled }: { enabled: boolean }) {
  return <StatusBadge label={enabled ? 'Enabled' : 'Disabled'} tone={enabled ? 'ok' : 'pending'} />;
}

function LegendItem({ phase, label, styles }: { phase: PhaseSegment['phase']; label: string; styles: ReturnType<typeof useStyles> }) {
  return (
    <div className={styles.legendItem}>
      <span className={styles.legendSwatch} style={{ backgroundColor: PHASE_TIMELINE_COLOR[phase] }} />
      <Text size={200}>{label}</Text>
    </div>
  );
}

/**
 * Peer review (Opus, MINOR 7) — mirrors Audit.tsx's/RecentActionsDrawer.tsx's
 * own OUTCOME_TONE (AM-32's "'accepted' is deliberately NOT 'success'-toned"
 * convention: it means ARM merely ACKNOWLEDGED the request, not confirmed
 * complete — see AuditOutcome's own doc comment). This table's outcome pill
 * was still a bare Fluent `Badge` (success/danger only, no 'accepted' case)
 * left over from before AM-35 migrated it onto DataTable; it now goes
 * through StatusBadge like every other outcome pill in this app.
 */
const HISTORY_OUTCOME_TONE: Record<ScalingHistoryEntry['outcome'], StatusTone> = {
  success: 'ok',
  accepted: 'warning',
  failure: 'error',
};

/** No column here is sortable — this table always rendered in the API's own (newest-first) response order, unchanged by this refactor. */
const HISTORY_COLUMNS: DataTableColumn<ScalingHistoryEntry>[] = [
  { id: 'when', label: 'When', renderCell: (entry) => formatDateTime(entry.occurredAt) },
  { id: 'who', label: 'Who', renderCell: (entry) => entry.actor },
  { id: 'action', label: 'Action', renderCell: (entry) => entry.action },
  { id: 'target', label: 'Target', renderCell: (entry) => entry.target },
  { id: 'outcome', label: 'Outcome', renderCell: (entry) => <StatusBadge label={entry.outcome} tone={HISTORY_OUTCOME_TONE[entry.outcome]} /> },
  { id: 'reason', label: 'Reason', renderCell: (entry) => entry.reason ?? '—' },
];

/**
 * Scaling — schedule editor (day timeline, edit/create/delete schedules),
 * emergency override, and change history. See this file's own doc comment
 * for why this is now a separate page from Cost.tsx.
 */
export default function Scaling() {
  const styles = useStyles();
  const cardStyles = useCardStyles();

  const scalingPlan = usePolling(getCurrentScalingPlan, PLAN_POLL_INTERVAL_MS);
  const override = usePolling(getEmergencyOverrideStatus, OVERRIDE_POLL_INTERVAL_MS);
  const history = usePolling(getScalingHistory, PLAN_POLL_INTERVAL_MS);

  const phase = scalingPlan.data ? computeScalingPhase(scalingPlan.data) : undefined;
  const timeZone = scalingPlan.data?.timeZone;
  const overrideActive = Boolean(override.data?.active);

  const allQueries = [scalingPlan, override, history];

  const [editingScheduleName, setEditingScheduleName] = useState<string | undefined>(undefined);
  const [editValues, setEditValues] = useState<ScheduleFormValues | undefined>(undefined);
  const [editOriginal, setEditOriginal] = useState<ScheduleFormValues | undefined>(undefined);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | undefined>(undefined);

  function openEditDialog(schedule: ScalingScheduleDetail) {
    const values = formValuesFromSchedule(schedule);
    setEditingScheduleName(schedule.name);
    setEditValues(values);
    setEditOriginal(values);
    setEditError(undefined);
  }
  function closeEditDialog() {
    setEditingScheduleName(undefined);
    setEditValues(undefined);
    setEditOriginal(undefined);
    setEditError(undefined);
  }

  const editUncoveredDays = useMemo(() => {
    if (!scalingPlan.data || !editingScheduleName || !editValues) return [];
    return computeUncoveredDaysClient(scalingPlan.data.schedules, { name: editingScheduleName, daysOfWeek: editValues.daysOfWeek });
  }, [scalingPlan.data, editingScheduleName, editValues]);

  async function submitEdit() {
    if (!editingScheduleName || !editValues || !editOriginal) return;
    const fieldIssues = validateScheduleFormFields(editValues, editOriginal);
    if (fieldIssues.length > 0) {
      setEditError(fieldIssues.join(' '));
      return;
    }
    if (editUncoveredDays.length > 0) {
      setEditError(`This change would leave ${editUncoveredDays.join(', ')} with no scaling schedule. Adjust the days, or add/keep another schedule covering them, before saving.`);
      return;
    }
    const body = buildPatchBody(editValues, editOriginal);
    if (Object.keys(body).length === 0) {
      setEditError('No fields were changed.');
      return;
    }
    if (editValues.reason.trim()) {
      body.reason = editValues.reason.trim();
    }
    setEditBusy(true);
    setEditError(undefined);
    try {
      await updateScalingSchedule(editingScheduleName, body);
      closeEditDialog();
      scalingPlan.refresh();
      history.refresh();
    } catch (error) {
      setEditError(error instanceof ApiClientError ? error.message : 'Failed to update the schedule.');
    } finally {
      setEditBusy(false);
    }
  }

  const [deletingSchedule, setDeletingSchedule] = useState<ScalingScheduleDetail | undefined>(undefined);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const deleteUncoveredDays = useMemo(() => {
    if (!scalingPlan.data || !deletingSchedule) return [];
    return computeUncoveredDaysForDelete(scalingPlan.data.schedules, deletingSchedule.name);
  }, [scalingPlan.data, deletingSchedule]);

  async function confirmDelete(reason: string | undefined) {
    if (!deletingSchedule) return;
    setDeleteBusy(true);
    setDeleteError(undefined);
    try {
      await deleteScalingSchedule(deletingSchedule.name, reason);
      setDeletingSchedule(undefined);
      scalingPlan.refresh();
      history.refresh();
    } catch (error) {
      setDeleteError(error instanceof ApiClientError ? error.message : 'Failed to delete the schedule.');
    } finally {
      setDeleteBusy(false);
    }
  }

  const [createOpen, setCreateOpen] = useState(false);
  const [createValues, setCreateValues] = useState<ScheduleFormValues>(formValuesFromSchedule());
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  const createUncoveredDays = useMemo(() => {
    if (!scalingPlan.data || !createOpen) return [];
    return computeUncoveredDaysForCreate(scalingPlan.data.schedules, createValues.daysOfWeek);
  }, [scalingPlan.data, createOpen, createValues.daysOfWeek]);

  function openCreateDialog() {
    setCreateValues(formValuesFromSchedule());
    setCreateError(undefined);
    setCreateOpen(true);
  }
  async function submitCreate() {
    const fieldIssues = validateScheduleFormFields(createValues, undefined);
    if (fieldIssues.length > 0) {
      setCreateError(fieldIssues.join(' '));
      return;
    }
    if (createUncoveredDays.length > 0) {
      setCreateError(`${createUncoveredDays.join(', ')} would still have no scaling schedule after this create. Adjust the days, or fix the gap in an existing schedule first.`);
      return;
    }
    const body = buildCreateBody(createValues);
    if (createValues.reason.trim()) {
      body.reason = createValues.reason.trim();
    }
    setCreateBusy(true);
    setCreateError(undefined);
    try {
      await createScalingSchedule(body);
      setCreateOpen(false);
      scalingPlan.refresh();
      history.refresh();
    } catch (error) {
      setCreateError(error instanceof ApiClientError ? error.message : 'Failed to create the schedule.');
    } finally {
      setCreateBusy(false);
    }
  }

  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideExtend, setOverrideExtend] = useState(false);
  const [overrideMinutes, setOverrideMinutes] = useState('60');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | undefined>(undefined);
  const [overrideTyped, setOverrideTyped] = useState('');
  /** AM-33 peer review (Opus, MINOR 13): the instant the override dialog was opened, frozen once at open time rather than re-read on every render — the impact panel's "expires/re-enables at HH:MM" clock must not silently drift forward while the operator sits on the dialog deciding. */
  const [overrideOpenedAt, setOverrideOpenedAt] = useState<Date>(() => new Date());
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | undefined>(undefined);

  const planName = scalingPlan.data?.name;

  function openOverrideDialog(extend: boolean) {
    setOverrideExtend(extend);
    setOverrideMinutes('60');
    setOverrideReason('');
    setOverrideTyped('');
    setOverrideError(undefined);
    setOverrideOpenedAt(new Date());
    setOverrideDialogOpen(true);
  }

  async function submitOverrideActivate() {
    const minutes = Number(overrideMinutes);
    setOverrideBusy(true);
    setOverrideError(undefined);
    try {
      await activateEmergencyOverride({ minutes, reason: overrideReason.trim(), extend: overrideExtend });
      setOverrideDialogOpen(false);
      setOverrideReason('');
      setOverrideTyped('');
      override.refresh();
      history.refresh();
    } catch (error) {
      setOverrideError(error instanceof ApiClientError ? error.message : 'Failed to activate the emergency override.');
    } finally {
      setOverrideBusy(false);
    }
  }

  async function submitOverrideCancel(reason: string | undefined) {
    setCancelBusy(true);
    setCancelError(undefined);
    try {
      await cancelEmergencyOverride(reason);
      setCancelDialogOpen(false);
      override.refresh();
      history.refresh();
    } catch (error) {
      setCancelError(error instanceof ApiClientError ? error.message : 'Failed to cancel the emergency override.');
    } finally {
      setCancelBusy(false);
    }
  }

  const overrideMinutesNumber = Number(overrideMinutes);
  const overrideMinutesValid = Number.isInteger(overrideMinutesNumber) && overrideMinutesNumber >= 15 && overrideMinutesNumber <= 480;
  const overrideNameMatches = overrideExtend || overrideTyped === 'OVERRIDE';

  const scheduleForEdit = useMemo(() => scalingPlan.data?.schedules.find((s) => s.name === editingScheduleName), [scalingPlan.data, editingScheduleName]);

  return (
    <div className={styles.page}>
      {override.data?.active && (
        <MessageBar intent="warning" className={styles.banner}>
          <MessageBarBody>
            <MessageBarTitle>Emergency override active</MessageBarTitle>
            Autoscale is paused — hosts will not be started or stopped by the schedule.{' '}
            {override.data.minutesRemaining !== undefined ? `${override.data.minutesRemaining} minute${override.data.minutesRemaining === 1 ? '' : 's'} remaining` : ''}
            {override.data.expiresAt ? ` (until ${formatDateTime(override.data.expiresAt)}).` : '.'}
            {override.data.activatedBy ? ` Activated by ${override.data.activatedBy}.` : ''}
            {override.data.reason ? ` Reason: ${override.data.reason}` : ''}
            {cancelError && <Text as="p" block>{cancelError}</Text>}
          </MessageBarBody>
          <RoleGate allowed={['operator', 'admin']}>
            <MessageBarActions>
              <Button appearance="secondary" size="small" onClick={() => openOverrideDialog(true)}>
                Extend override
              </Button>
              <Button appearance="secondary" size="small" disabled={cancelBusy} onClick={() => setCancelDialogOpen(true)}>
                Cancel override
              </Button>
            </MessageBarActions>
          </RoleGate>
        </MessageBar>
      )}

      <PageHeader
        title="Scaling"
        asOf={allQueries.reduce<Date | undefined>((latest, query) => (!query.lastUpdated ? latest : !latest || query.lastUpdated > latest ? query.lastUpdated : latest), undefined)}
        refreshing={allQueries.some((query) => query.refreshing)}
        onRefresh={() => {
          for (const query of allQueries) query.refresh();
        }}
        actions={
          <RoleGate allowed={['operator', 'admin']}>
            <Button appearance="secondary" onClick={openCreateDialog}>
              Add schedule
            </Button>
            <Button appearance="primary" onClick={() => openOverrideDialog(false)} disabled={overrideActive}>
              Emergency override
            </Button>
          </RoleGate>
        }
      />

      <Card className={mergeClasses(cardStyles.card, styles.scalingCard)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Scaling plan</Text>} />
        <AsyncState loading={scalingPlan.loading} error={scalingPlan.error as Error | undefined} data={scalingPlan.data}>
          {(plan) => (
            <div className={styles.propsGrid}>
              <div>
                <Text block className={styles.propLabel}>
                  Name
                </Text>
                <Text>{plan.name}</Text>
              </div>
              <div>
                <Text block className={styles.propLabel}>
                  Time zone
                </Text>
                <Text>{plan.timeZone ?? 'Unknown'}</Text>
              </div>
              <div>
                <Text block className={styles.propLabel}>
                  Enabled
                </Text>
                <StatusBadgeInline enabled={plan.enabled} />
              </div>
              {phase && (
                <div>
                  <Text block className={styles.propLabel}>
                    Current phase
                  </Text>
                  <StatusBadge label={PHASE_LABEL[phase]} tone={PHASE_TONE[phase]} />
                </div>
              )}
            </div>
          )}
        </AsyncState>
      </Card>

      <Card className={mergeClasses(cardStyles.card, styles.scalingCard)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Schedules{timeZone ? ` — ${timeZone}` : ''}</Text>} />
        <AsyncState
          loading={scalingPlan.loading}
          error={scalingPlan.error as Error | undefined}
          data={scalingPlan.data?.schedules}
          isEmpty={(data) => data.length === 0}
          emptyMessage="No schedules configured."
        >
          {(schedules) => (
            <>
              {schedules.map((schedule) => {
                const segments = scheduleSegments(schedule);
                return (
                  <div key={schedule.name} className={styles.scheduleCard}>
                    <div className={styles.scheduleHeaderRow}>
                      <div>
                        <Text weight="semibold">{schedule.name}</Text>
                        <div className={styles.dayChips}>
                          {schedule.daysOfWeek.map((day) => (
                            <Badge key={day} appearance="outline" size="small">
                              {day.slice(0, 3)}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <RoleGate allowed={['operator', 'admin']}>
                        <div className={styles.actionsRow}>
                          <Button size="small" appearance="secondary" onClick={() => openEditDialog(schedule)}>
                            Edit
                          </Button>
                          <Button size="small" appearance="secondary" onClick={() => setDeletingSchedule(schedule)}>
                            Delete
                          </Button>
                        </div>
                      </RoleGate>
                    </div>

                    <div
                      className={styles.timelineBar}
                      role="img"
                      aria-label={`Day timeline for ${schedule.name} (${timeZone ?? 'plan time zone'}): ramp-up at ${timeToInputValue(schedule.rampUpStartTime)}, peak at ${timeToInputValue(schedule.peakStartTime)}, ramp-down at ${timeToInputValue(schedule.rampDownStartTime)}, off-peak at ${timeToInputValue(schedule.offPeakStartTime)}.`}
                    >
                      {segments.map((segment, index) => (
                        <div key={`${segment.phase}-${index}`} style={{ width: `${segment.widthPct}%`, backgroundColor: PHASE_TIMELINE_COLOR[segment.phase] }} />
                      ))}
                    </div>
                    <div className={styles.timelineLegend}>
                      <LegendItem phase="RampUp" label={`${PHASE_LABEL.RampUp} ${timeToInputValue(schedule.rampUpStartTime)}`} styles={styles} />
                      <LegendItem phase="Peak" label={`${PHASE_LABEL.Peak} ${timeToInputValue(schedule.peakStartTime)}`} styles={styles} />
                      <LegendItem phase="RampDown" label={`${PHASE_LABEL.RampDown} ${timeToInputValue(schedule.rampDownStartTime)}`} styles={styles} />
                      <LegendItem phase="OffPeak" label={`${PHASE_LABEL.OffPeak} ${timeToInputValue(schedule.offPeakStartTime)}`} styles={styles} />
                    </div>

                    <div className={styles.propsGrid}>
                      <div>
                        <Text block className={styles.propLabel}>
                          Ramp-up threshold / min hosts
                        </Text>
                        <Text>
                          {schedule.rampUpCapacityThresholdPct ?? '—'}% / {schedule.rampUpMinimumHostsPct ?? '—'}%
                        </Text>
                      </div>
                      <div>
                        <Text block className={styles.propLabel}>
                          Ramp-down threshold / min hosts
                        </Text>
                        <Text>
                          {schedule.rampDownCapacityThresholdPct ?? '—'}% / {schedule.rampDownMinimumHostsPct ?? '—'}%
                        </Text>
                      </div>
                      <div>
                        <Text block className={styles.propLabel}>
                          Stop hosts when
                        </Text>
                        <Text>{schedule.rampDownStopHostsWhen ?? 'Unknown'}</Text>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </AsyncState>
      </Card>

      <Card className={mergeClasses(cardStyles.card, styles.scalingCard)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Change history</Text>} />
        <AsyncState loading={history.loading} error={history.error as Error | undefined} data={history.data?.entries} isEmpty={(data) => data.length === 0} emptyMessage="No scaling-related changes recorded yet.">
          {(entries) => <DataTable ariaLabel="Scaling plan change history" columns={HISTORY_COLUMNS} rows={entries} getRowKey={(entry) => entry.id} emptyMessage="No scaling-related changes recorded yet." />}
        </AsyncState>
      </Card>

      {/* --- Edit schedule dialog --- */}
      {editingScheduleName && editValues && <EditScheduleDialog
        editingScheduleName={editingScheduleName}
        editValues={editValues}
        setEditValues={setEditValues}
        scheduleForEdit={scheduleForEdit}
        overrideActive={overrideActive}
        editUncoveredDays={editUncoveredDays}
        editError={editError}
        editBusy={editBusy}
        timeZone={timeZone}
        styles={styles}
        onClose={closeEditDialog}
        onSubmit={submitEdit}
      />}

      {/* AM-29 item 30: schedule delete is severity 'medium' — mandatory reason, no typed name. AM-33 (D5): the former bespoke `deleteDescription` string is migrated onto ImpactPreview — the underlying computeUncoveredDaysForDelete logic (deleteUncoveredDays, above) is unchanged, only its presentation moved. */}
      {deletingSchedule && (
        <ConfirmModal
          title={`Delete schedule "${deletingSchedule.name}"?`}
          severity="medium"
          description="Removes this schedule from the scaling plan. This cannot be undone."
          impact={<ImpactPreview lines={scheduleDeletePreviewLines(deletingSchedule.name, deleteUncoveredDays)} />}
          confirmLabel="Delete"
          busy={deleteBusy}
          error={deleteError}
          onConfirm={confirmDelete}
          onCancel={() => setDeletingSchedule(undefined)}
        />
      )}

      {/* --- Create schedule dialog --- */}
      {createOpen && <CreateScheduleDialog
        createValues={createValues}
        setCreateValues={setCreateValues}
        createUncoveredDays={createUncoveredDays}
        createError={createError}
        createBusy={createBusy}
        timeZone={timeZone}
        styles={styles}
        onClose={() => setCreateOpen(false)}
        onSubmit={submitCreate}
      />}

      {/* AM-29 item 30: severity 'medium' — mandatory reason, no typed name. */}
      {cancelDialogOpen && (
        <ConfirmModal
          title="Cancel the emergency override?"
          severity="medium"
          description="Autoscale resumes immediately for this host pool, following whatever schedule is currently configured."
          confirmLabel="Cancel override"
          busy={cancelBusy}
          error={cancelError}
          onConfirm={submitOverrideCancel}
          onCancel={() => setCancelDialogOpen(false)}
        />
      )}

      {/* --- Emergency override activate/extend dialog --- */}
      {overrideDialogOpen && <OverrideDialog
        overrideExtend={overrideExtend}
        overrideMinutes={overrideMinutes}
        setOverrideMinutes={setOverrideMinutes}
        overrideReason={overrideReason}
        setOverrideReason={setOverrideReason}
        overrideTyped={overrideTyped}
        setOverrideTyped={setOverrideTyped}
        overrideBusy={overrideBusy}
        overrideError={overrideError}
        overrideMinutesValid={overrideMinutesValid}
        overrideNameMatches={overrideNameMatches}
        planName={planName}
        phaseLabel={phase ? PHASE_LABEL[phase] : undefined}
        minutesRemaining={override.data?.minutesRemaining}
        now={overrideOpenedAt}
        styles={styles}
        onClose={() => { setOverrideDialogOpen(false); setOverrideTyped(''); }}
        onSubmit={submitOverrideActivate}
      />}
    </div>
  );
}

/** Extracted so useDialogFocusRestore (AM-31 item 37) applies to this ad hoc Dialog the same way it does to every ConfirmModal/MessageComposeDialog/SnoozeDialog use — the hook must run inside the dialog's own component so its mount/unmount lifecycle matches the dialog's open/close lifecycle exactly. */
function EditScheduleDialog({
  editingScheduleName,
  editValues,
  setEditValues,
  scheduleForEdit,
  overrideActive,
  editUncoveredDays,
  editError,
  editBusy,
  timeZone,
  styles,
  onClose,
  onSubmit,
}: {
  editingScheduleName: string;
  editValues: ScheduleFormValues;
  setEditValues: (v: ScheduleFormValues) => void;
  scheduleForEdit: ScalingScheduleDetail | undefined;
  overrideActive: boolean;
  editUncoveredDays: string[];
  editError: string | undefined;
  editBusy: boolean;
  timeZone: string | undefined;
  styles: ReturnType<typeof useStyles>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useDialogFocusRestore();
  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open && !editBusy) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Edit schedule — {editingScheduleName}</DialogTitle>
          <DialogContent>
            {!scheduleForEdit && <Text as="p">This schedule is no longer available. Close this dialog and refresh.</Text>}
            {overrideActive && (
              <MessageBar intent="warning">
                <MessageBarBody>An emergency override is currently active — autoscale is paused, so edits saved here will not take effect until the override ends or is cancelled.</MessageBarBody>
              </MessageBar>
            )}
            {editUncoveredDays.length > 0 && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>This would leave days uncovered</MessageBarTitle>
                  {editUncoveredDays.join(', ')} would have no scaling schedule at all — session hosts on {editUncoveredDays.length === 1 ? 'that day' : 'those days'} may be deallocated by default. Adjust the days, or add/keep another schedule covering{' '}
                  {editUncoveredDays.length === 1 ? 'it' : 'them'}.
                </MessageBarBody>
              </MessageBar>
            )}
            {editError && (
              <MessageBar intent="error">
                <MessageBarBody>{editError}</MessageBarBody>
              </MessageBar>
            )}
            <ScheduleFieldsForm values={editValues} onChange={setEditValues} showName={false} reasonRequired={false} timeZone={timeZone} styles={styles} />
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={editBusy}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={onSubmit} disabled={editBusy || editUncoveredDays.length > 0}>
              {editBusy ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function CreateScheduleDialog({
  createValues,
  setCreateValues,
  createUncoveredDays,
  createError,
  createBusy,
  timeZone,
  styles,
  onClose,
  onSubmit,
}: {
  createValues: ScheduleFormValues;
  setCreateValues: (v: ScheduleFormValues) => void;
  createUncoveredDays: string[];
  createError: string | undefined;
  createBusy: boolean;
  timeZone: string | undefined;
  styles: ReturnType<typeof useStyles>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useDialogFocusRestore();
  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open && !createBusy) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add schedule</DialogTitle>
          <DialogContent>
            <Text as="p" block>
              Creating a schedule for specific days lets you set different ramp-up/peak/ramp-down/off-peak behavior for those days — e.g. split weekends off from an "AllDays" schedule by editing that schedule's days first, then adding a new one here for the remaining days.
            </Text>
            {createUncoveredDays.length > 0 && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Existing gap not filled</MessageBarTitle>
                  {createUncoveredDays.join(', ')} would still have no scaling schedule after this create. Adjust the days, or fix the gap in an existing schedule first.
                </MessageBarBody>
              </MessageBar>
            )}
            {createError && (
              <MessageBar intent="error">
                <MessageBarBody>{createError}</MessageBarBody>
              </MessageBar>
            )}
            <ScheduleFieldsForm values={createValues} onChange={setCreateValues} showName reasonRequired={false} timeZone={timeZone} styles={styles} />
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={createBusy}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={onSubmit} disabled={createBusy || !createValues.name.trim() || createValues.daysOfWeek.length === 0 || createUncoveredDays.length > 0}>
              {createBusy ? 'Creating…' : 'Create schedule'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function OverrideDialog({
  overrideExtend,
  overrideMinutes,
  setOverrideMinutes,
  overrideReason,
  setOverrideReason,
  overrideTyped,
  setOverrideTyped,
  overrideBusy,
  overrideError,
  overrideMinutesValid,
  overrideNameMatches,
  planName,
  phaseLabel,
  minutesRemaining,
  now,
  styles,
  onClose,
  onSubmit,
}: {
  overrideExtend: boolean;
  overrideMinutes: string;
  setOverrideMinutes: (v: string) => void;
  overrideReason: string;
  setOverrideReason: (v: string) => void;
  overrideTyped: string;
  setOverrideTyped: (v: string) => void;
  overrideBusy: boolean;
  overrideError: string | undefined;
  overrideMinutesValid: boolean;
  overrideNameMatches: boolean;
  planName: string | undefined;
  /** Current scaling phase label (e.g. "Peak") — see lib/impactPreview.ts's emergencyOverridePreviewLines, which folds this into the impact panel's "Current phase … continues" line. Undefined while the plan hasn't loaded yet. */
  phaseLabel: string | undefined;
  /** The active override's live minutesRemaining (already-polled GET /v1/scaling/override — see Scaling.tsx's `override` query), undefined when no override is active. Drives emergencyOverridePreviewLines' Shortens/Extends/neutral wording — see that function's own doc comment (AM-33 peer review MAJOR 1). */
  minutesRemaining: number | undefined;
  /** The instant this dialog was opened, frozen by the opener (Scaling.tsx's openOverrideDialog) — NOT re-read on every render, so the panel's "expires/re-enables at HH:MM" clock doesn't drift while the dialog sits open (AM-33 peer review MINOR 13). */
  now: Date;
  styles: ReturnType<typeof useStyles>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  useDialogFocusRestore();
  // AM-33 (D5): recomputed on every render the Duration Dropdown changes
  // (Duration is a live value, not committed state) so the panel always
  // reflects the CURRENTLY selected minutes value — but `now` itself is the
  // frozen dialog-open instant above, not re-read here. Empty (panel
  // hidden) while the duration is out of its valid 15-480 range — nothing
  // sound to preview yet.
  const impactLines = overrideMinutesValid ? emergencyOverridePreviewLines({ minutes: Number(overrideMinutes), now, phaseLabel, minutesRemaining }) : [];
  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open && !overrideBusy) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{overrideExtend ? 'Extend emergency override' : 'Emergency override — keep all hosts up'}</DialogTitle>
          <DialogContent>
            <Text as="p" block>
              {overrideExtend
                ? `Replaces the active override's remaining duration and reason for ${planName ?? 'the current scaling plan'} — autoscale stays paused, nothing else changes.`
                : `Pauses autoscale for ${planName ?? 'the current scaling plan'} — hosts will not be started or stopped by the schedule until the override expires or is cancelled. Use this for an incident or urgent maintenance window, not routine operations.`}
            </Text>
            {overrideError && (
              <MessageBar intent="error">
                <MessageBarBody>{overrideError}</MessageBarBody>
              </MessageBar>
            )}
            <Field label="Duration (minutes)" hint="15-480 (up to 8 hours)" required>
              <Dropdown value={overrideMinutes} selectedOptions={[overrideMinutes]} onOptionSelect={(_e, d) => setOverrideMinutes(d.optionValue ?? '60')}>
                {['15', '30', '60', '120', '240', '480'].map((option) => (
                  <Option key={option} value={option} text={option}>
                    {option} minutes
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Reason" required>
              <Textarea value={overrideReason} onChange={(_e, d) => setOverrideReason(d.value)} resize="vertical" maxLength={1000} placeholder="Why is this needed?" />
            </Field>
            {/* AM-33 (D5): rendered above the typed-name confirm gate below, matching every other high/medium action's ImpactPreview placement. */}
            <ImpactPreview lines={impactLines} />
            {!overrideExtend && (
              <Field label={<>Type <strong>OVERRIDE</strong> to confirm.</>}>
                <Input value={overrideTyped} onChange={(_e, d) => setOverrideTyped(d.value)} placeholder="OVERRIDE" autoComplete="off" />
              </Field>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={overrideBusy}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={onSubmit}
              disabled={overrideBusy || !overrideMinutesValid || overrideReason.trim().length === 0 || !overrideNameMatches}
            >
              {overrideBusy ? (overrideExtend ? 'Extending…' : 'Activating…') : overrideExtend ? 'Extend override' : 'Activate override'}
            </Button>
          </DialogActions>
          {/* AM-29 item 25: names which unmet condition is disabling "Activate override"/"Extend override". */}
          {!overrideBusy && (!overrideMinutesValid || overrideReason.trim().length === 0 || !overrideNameMatches) && (
            <Text size={200} className={styles.label}>
              Still needed:{' '}
              {[
                !overrideMinutesValid && 'a valid duration (15-480 minutes)',
                overrideReason.trim().length === 0 && 'a reason',
                !overrideNameMatches && 'OVERRIDE typed exactly to confirm',
              ]
                .filter((part): part is string => Boolean(part))
                .join(', ')}
              .
            </Text>
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
