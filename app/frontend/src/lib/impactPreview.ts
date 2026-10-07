import type { ProfileVhd, RetiredProfileVhd, RolloutNewHost, RolloutOldHost, SessionHost, SessionHostPowerAction, UserSession } from '@avdmgr/shared';
import { computeSessionAgeMs } from './sessionAge';
import { formatShortDate, formatTime } from './format';
import { powerActionGerund } from './sessionHostPowerActions';

/**
 * AM-33 (D5 — "dry-run-first on every high-severity action"): pure,
 * React-free helpers that compute the bullet lines the shared
 * ImpactPreview.tsx component renders above ConfirmModal's confirm gate.
 * Generalizes the image-build wizard's dry-run plan (ImageBuildSection.tsx)
 * — this app's best interaction for turning "what am I about to do" from
 * typing ceremony into comprehension — onto every other high/medium-severity
 * action, WITHOUT a server round-trip: every function here is computed
 * entirely from data its page already fetched for its own live display (the
 * session list, the session-host list, the scaling plan/schedules, the
 * rollout plan, the retired-profiles list). No new mutating endpoints, no
 * new server dry-run API — see this file's own per-function doc comments for
 * exactly which already-fetched field each one reads.
 *
 * Kept dependency-free (no React/Fluent imports) so every function here is
 * unit-testable in isolation — see impactPreview.test.ts. Components stay
 * thin: they call one of these, then hand the resulting ImpactLine[] straight
 * to <ImpactPreview lines={...} />.
 */

export type ImpactTone = 'info' | 'warning';

export interface ImpactLine {
  text: string;
  tone?: ImpactTone;
}

/**
 * Cap on how many named items (session UPNs, host names) are listed inline
 * in a single bullet before folding the remainder into a "+N more"
 * continuation — keeps one line readable regardless of blast radius.
 */
export const MAX_LISTED_NAMES = 5;

/** Cap on how many bullet lines ImpactPreview renders — see that component's own doc comment. Helpers below that could otherwise produce more (e.g. one line per rollout host) fold the remainder into a "+N more" line so they never exceed this. */
export const MAX_IMPACT_LINES = 4;

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Joins up to `max` names with ", ", folding anything past that into "+N more" — e.g. formatNameList(['a','b','c','d','e','f']) -> "a, b, c, d, e, +1 more". */
export function formatNameList(names: string[], max: number = MAX_LISTED_NAMES): string {
  if (names.length <= max) return names.join(', ');
  const shown = names.slice(0, max);
  return `${shown.join(', ')}, +${names.length - max} more`;
}

// --- (a) Sessions — logoff all disconnected ---

/** A session disconnected for less than this is flagged as possibly still-active — see this function's own doc comment for why createTime is a sound (if conservative) proxy for "time disconnected". */
const RECENTLY_DISCONNECTED_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * (a) Sessions page — "Log off all disconnected" toolbar action. Computed
 * entirely from the already-polled session list (Sessions.tsx's `sessions.data`)
 * — no new read.
 *
 * ARM reports no actual "time disconnected" for a session (see
 * lib/sessionAge.ts's own doc comment on this same limitation) — only
 * `createTime`. A session can never have been disconnected LONGER than it
 * has existed, so age-since-createTime is a sound (if conservative) LOWER
 * bound on how long ago it disconnected: if that age is itself under 10
 * minutes, the disconnect must be too. That inequality is what the warning
 * line below relies on — it can only under-flag (miss a genuinely-recent
 * disconnect whose session is actually older), never over-flag.
 */
export function logoffAllDisconnectedPreviewLines(
  sessions: Array<Pick<UserSession, 'userPrincipalName' | 'sessionState' | 'createTime'>>,
  now: Date = new Date(),
): ImpactLine[] {
  const disconnected = sessions.filter((s) => s.sessionState === 'Disconnected');
  if (disconnected.length === 0) {
    return [{ text: 'No disconnected sessions right now.', tone: 'info' }];
  }

  const names = disconnected.map((s) => s.userPrincipalName);
  const lines: ImpactLine[] = [{ text: `Will end ${pluralize(disconnected.length, 'disconnected session')} (${formatNameList(names)}).`, tone: 'info' }];

  const recentlyDisconnected = disconnected.filter((s) => {
    const ageMs = computeSessionAgeMs(s.createTime, now);
    return ageMs !== undefined && ageMs < RECENTLY_DISCONNECTED_THRESHOLD_MS;
  });
  if (recentlyDisconnected.length > 0) {
    lines.push({
      text: `${pluralize(recentlyDisconnected.length, 'session')} disconnected less than 10 minutes ago — may be an active user switching networks.`,
      tone: 'warning',
    });
  }
  return lines;
}

// --- (b) Sessions — force logoff (single session) ---

/** (b) Sessions page — per-row "Force logoff". Computed from the row's own session data, already in the filtered/sorted table. */
export function forceLogoffPreviewLines(session: Pick<UserSession, 'userPrincipalName' | 'sessionHostName' | 'sessionState'>): ImpactLine[] {
  // AM-33 peer review (Opus, MINOR 8): "may be lost", not "is lost" — the
  // session might have nothing unsaved at all; this states the RISK, not a
  // guaranteed outcome.
  return [{ text: `Ends ${session.userPrincipalName}'s ${session.sessionState} session on ${session.sessionHostName}. Unsaved work may be lost.`, tone: 'info' }];
}

// --- (c) HostPool/Dashboard — restart/deallocate a session host ---

/**
 * (c) HostPool.tsx / Dashboard.tsx — restart/deallocate a session host's
 * power menu. Computed from the SessionHost the page already polled
 * (`activeSessions`/`allowNewSession`) — no new read. Also the SINGLE
 * source of this wording for SessionsWarningDialog.tsx's own drain-first
 * interstitial (AM-33 peer review, Opus MAJOR 2) — that dialog calls this
 * same function so its session-count sentence and drain-state warning are
 * never a word different from what this preview panel says one step later.
 *
 * Deviation from the literal "N active / M disconnected" split the ticket
 * describes: `SessionHost.activeSessions` is documented (see
 * @avdmgr/shared's own field comment) to actually be the ARM TOTAL session
 * count (active + disconnected + pending + ...), not active-only — neither
 * this page nor Dashboard.tsx fetches per-session state (that's the Sessions
 * page's `getSessions` call, which this page does not make), so there is no
 * already-fetched data to compute a true active/disconnected split from
 * without adding a new read this page doesn't otherwise need. This reports
 * the honest total instead of fabricating a split.
 *
 * Returns [] for 'start' (not disruptive — nothing to warn about); callers
 * only wire this into the restart/deallocate confirm, matching the existing
 * severity split.
 */
export function hostPowerPreviewLines(host: Pick<SessionHost, 'name' | 'activeSessions' | 'allowNewSession'>, action: SessionHostPowerAction): ImpactLine[] {
  if (action === 'start') return [];
  const lines: ImpactLine[] = [
    { text: `${host.name} currently has ${pluralize(host.activeSessions, 'session')}. ${powerActionGerund(action)} disconnects all of them.`, tone: 'info' },
  ];
  // AM-33 peer review (Opus, MAJOR 3): this is NOT the same predicate as
  // HostPool.tsx/Dashboard.tsx's own needsSessionsWarning — that gate is
  // `sessions present`, full stop (it decides whether the SessionsWarningDialog
  // interstitial appears AT ALL, regardless of drain state). This ADDS an
  // `allowNewSession` (not-draining) term on top, deciding only whether the
  // warning LINE within that interstitial/panel appears. Do not describe
  // this as "mirroring" or "the same recompute as" needsSessionsWarning —
  // it is a stricter, related-but-different condition.
  if (host.activeSessions > 0 && host.allowNewSession) {
    lines.push({ text: `${host.name} is NOT draining — consider draining first.`, tone: 'warning' });
  }
  return lines;
}

// --- (d) Scaling — emergency override activate/extend ---

/**
 * (d) Scaling page — emergency override activate/extend dialog. Computed
 * from the dialog's own `minutes` field plus the already-polled scaling
 * plan's current phase (`computeScalingPhase`) and the already-polled
 * emergency-override status (`minutesRemaining`) — no new read.
 *
 * AM-33 peer review (Opus, MAJOR 1): the server REPLACES the override's
 * `expiresAt` with `now + minutes` — it never ADDS `minutes` on top of
 * whatever time is currently remaining. A naive "Extends the override for N
 * minutes" wording on the Extend dialog was therefore actively misleading
 * whenever the operator picked a duration SHORTER than the time already
 * remaining (that submission would actually shorten the override, the
 * opposite of what "Extends" claims). Wording is now driven purely by
 * comparing the requested `minutes` against `minutesRemaining` (when known):
 * shorter -> "Shortens…", longer -> "Extends…", equal or unknown (e.g. the
 * fresh-activate dialog, which by construction never has an active override
 * to compare against — its Activate button is disabled while one is active)
 * -> the neutral "Sets the override to expire in…" phrasing, which never
 * claims a direction.
 */
export function emergencyOverridePreviewLines(opts: { minutes: number; now?: Date; phaseLabel?: string; minutesRemaining?: number }): ImpactLine[] {
  const { minutes, now = new Date(), phaseLabel, minutesRemaining } = opts;
  if (!Number.isFinite(minutes) || minutes <= 0) return [];
  const reEnableAt = new Date(now.getTime() + minutes * 60_000);
  const roundedMinutes = Math.round(minutes);
  const expiresClause = `(expires ${formatTime(reEnableAt)})`;

  let actionText: string;
  if (minutesRemaining === undefined || roundedMinutes === Math.round(minutesRemaining)) {
    actionText = `Sets the override to expire in ${pluralize(roundedMinutes, 'minute')} (at ${formatTime(reEnableAt)}).`;
  } else if (roundedMinutes < minutesRemaining) {
    actionText = `Shortens the override to ${pluralize(roundedMinutes, 'minute')} ${expiresClause}.`;
  } else {
    actionText = `Extends the override to ${pluralize(roundedMinutes, 'minute')} ${expiresClause}.`;
  }

  return [
    { text: actionText, tone: 'info' },
    { text: phaseLabel ? `Current phase ${phaseLabel} continues. Hosts are NOT changed.` : 'Hosts are NOT changed.', tone: 'info' },
  ];
}

// --- (e) Scaling — schedule delete ---

/**
 * (e) Scaling page — delete-schedule confirm. Reuses Scaling.tsx's own
 * client-side mirror of the API's day-coverage guard (computeUncoveredDaysForDelete)
 * — this does not recompute that logic, it only reshapes the already-computed
 * uncovered-days list into ImpactPreview lines, migrating the schedule
 * delete dialog's bespoke `deleteDescription` string onto the shared panel.
 */
export function scheduleDeletePreviewLines(scheduleName: string, uncoveredDays: string[]): ImpactLine[] {
  if (uncoveredDays.length === 0) {
    return [{ text: `Removes the ${scheduleName} schedule. Every day it covered is still covered by at least one other schedule.`, tone: 'info' }];
  }
  const dayPhrase = uncoveredDays.length === 1 ? 'that day' : 'those days';
  const pronoun = uncoveredDays.length === 1 ? 'it' : 'them';
  return [
    { text: `Removes the ${scheduleName} schedule. Days left uncovered: ${uncoveredDays.join(', ')}.`, tone: 'warning' },
    {
      text: `Azure Virtual Desktop treats an uncovered day as a default ramp-down state — session hosts on ${dayPhrase} may be deallocated. The server will reject this delete unless another schedule covers ${pronoun} first.`,
      tone: 'warning',
    },
  ];
}

// --- (f) RolloutWizard — remove hosts ---

/**
 * (f) RolloutWizard.tsx — "Remove selected hosts" confirm. Computed from the
 * operator's own selection (`selectedForRemoval`) — no new read. Caps at
 * MAX_IMPACT_LINES total bullet lines regardless of how many hosts are
 * selected, folding any remainder into a final "+N more" line.
 */
export function rolloutRemoveHostsPreviewLines(hostNames: string[]): ImpactLine[] {
  if (hostNames.length === 0) return [];
  if (hostNames.length <= MAX_IMPACT_LINES) {
    return hostNames.map((name) => ({ text: `Permanently deletes VM ${name} (deregistered from the host pool).`, tone: 'warning' }));
  }
  const shown = hostNames.slice(0, MAX_IMPACT_LINES - 1);
  const lines: ImpactLine[] = shown.map((name) => ({ text: `Permanently deletes VM ${name} (deregistered from the host pool).`, tone: 'warning' }));
  lines.push({ text: `+${pluralize(hostNames.length - shown.length, 'more host')} — same effect.`, tone: 'warning' });
  return lines;
}

// --- (g) Profiles — permanent delete (retired VHD) ---

/** (g) Profiles page — "Permanently delete" confirm for a retired profile VHD. Computed from the row's own already-fetched RetiredProfileVhd data. */
export function profileDeletePreviewLines(retired: Pick<RetiredProfileVhd, 'userPrincipalName' | 'folderName' | 'sizeGb' | 'retiredAt'>): ImpactLine[] {
  const who = retired.userPrincipalName ?? retired.folderName;
  const retiredDate = formatShortDate(retired.retiredAt);
  return [
    { text: `Permanently deletes ${who}'s retired VHD (${retired.sizeGb} GiB${retiredDate ? `, retired ${retiredDate}` : ''}).`, tone: 'warning' },
    { text: 'The active profile is not affected.', tone: 'info' },
  ];
}

// --- (i) Profiles — duplicate-container guided delete ---

/**
 * (i) Profiles page — "Permanently delete" confirm within the duplicate-
 * container resolve dialog (AM-51). Computed from the OPERATOR'S OWN pick
 * (the sibling ProfileVhd row they selected in the dialog) plus the
 * folder's other active siblings (already in the already-fetched profiles
 * list, filtered client-side by folderName) — no new read. Names the
 * remaining sibling(s) explicitly so the operator can see, right before
 * confirming, exactly which container will be LEFT BEHIND as the folder's
 * sole active file.
 */
export function duplicateDeletePreviewLines(chosen: Pick<ProfileVhd, 'userPrincipalName' | 'folderName' | 'fileName' | 'sizeGb'>, siblings: Array<Pick<ProfileVhd, 'fileName'>>): ImpactLine[] {
  const who = chosen.userPrincipalName ?? chosen.folderName;
  const remainingNames = siblings.filter((s) => s.fileName !== chosen.fileName).map((s) => s.fileName);
  const lines: ImpactLine[] = [{ text: `Permanently deletes "${chosen.fileName}" (${chosen.sizeGb} GiB) from ${who}'s profile folder.`, tone: 'warning' }];
  lines.push({
    text: remainingNames.length > 0 ? `"${formatNameList(remainingNames)}" remains as the folder's sole active container.` : "This folder's other active container remains untouched.",
    tone: 'info',
  });
  return lines;
}

// --- (h) RolloutWizard — rollback ---

/**
 * (h) RolloutWizard.tsx — "Roll back this plan" confirm. Computed from the
 * plan's own already-fetched oldHosts/newHosts arrays, mirroring exactly
 * what app/api/src/functions/rolloutPlans.ts's handleRollback does host by
 * host: every old host NOT already 'removed' gets un-drained; every new host
 * that has actually been observed in AVD (i.e. not still
 * 'awaiting_registration') gets drained; any old host already 'removed'
 * cannot be restored by rollback at all (server lists it for a guided
 * re-add instead — see RollbackGuidance).
 */
export function rollbackPreviewLines(oldHosts: Array<Pick<RolloutOldHost, 'status'>>, newHosts: Array<Pick<RolloutNewHost, 'status'>>): ImpactLine[] {
  const alreadyRemoved = oldHosts.filter((h) => h.status === 'removed').length;
  const toUndrain = oldHosts.length - alreadyRemoved;
  const toDrainNew = newHosts.filter((h) => h.status !== 'awaiting_registration').length;

  const lines: ImpactLine[] = [{ text: `Will un-drain ${pluralize(toUndrain, 'old host')}, drain ${pluralize(toDrainNew, 'new host')}.`, tone: 'info' }];
  if (alreadyRemoved > 0) {
    lines.push({ text: `${pluralize(alreadyRemoved, 'host')} already removed cannot be restored automatically.`, tone: 'warning' });
  }
  return lines;
}

// --- Sessions — broadcast message (migrated off MessageComposeDialog's bespoke `impactSummary` string) ---

/** Sessions page — page-level "Broadcast message" compose dialog. Migrates the dialog's former plain-text `impactSummary` prop onto ImpactPreview for visual consistency with every other action's preview. Computed from the already-polled session list's active count. */
export function broadcastPreviewLines(activeCount: number): ImpactLine[] {
  if (activeCount === 0) {
    return [{ text: 'There are currently no active sessions — this message would not reach anyone.', tone: 'warning' }];
  }
  return [{ text: `This will message ${pluralize(activeCount, 'active session')} right now.`, tone: 'info' }];
}
