import { useMemo, useRef, useState } from 'react';
import {
  makeStyles,
  mergeClasses,
  tokens,
  Text,
  Card,
  CardHeader,
  Button,
  Switch,
  ProgressBar,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Toast,
  ToastTitle,
  Tooltip,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  RadioGroup,
  Radio,
} from '@fluentui/react-components';
import { LockClosed16Filled, MoreHorizontal20Regular } from '@fluentui/react-icons';
import type { DuplicateContainerResolveMode, ProfileOrphanStatus, ProfileVhd, RetiredProfileVhd } from '@avdmgr/shared';
import { deleteRetiredProfile, getProfiles, resetProfile, resolveDuplicateContainer, restoreProfile } from '../api/avd';
import { usePolling } from '../hooks/usePolling';
import { useAuth } from '../auth/useAuth';
import AsyncState from '../components/AsyncState';
import StatusBadge, { type StatusTone } from '../components/StatusBadge';
import ConfirmModal from '../components/ConfirmModal';
import ImpactPreview from '../components/ImpactPreview';
import PageHeader from '../components/PageHeader';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { ApiClientError } from '../api/client';
import { formatDateTime } from '../lib/format';
import { duplicateDeletePreviewLines, profileDeletePreviewLines } from '../lib/impactPreview';
import { useCardStyles } from '../styles/shared';
import { useAppToast } from '../lib/toaster';

/** Standard 60s cadence, same as Dashboard.tsx/Monitoring.tsx — the Profiles list is a live-ish inventory (lock state especially can change within minutes), not a "check on demand" surface like Governance.tsx. The server itself additionally caches for ~45s (peer review item 6), so a poll landing inside that window is cheap. */
const POLL_INTERVAL_MS = 60_000;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  asOfText: {
    color: tokens.colorNeutralForeground3,
  },
  /** Layout only — padding now comes from the shared useCardStyles hook (see styles/shared.ts), merged in at each `<Card>` call site via mergeClasses(cardStyles.card, styles.card). */
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  cardHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
  },
  usageRow: {
    display: 'flex',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  identityCell: {
    display: 'flex',
    flexDirection: 'column',
  },
  folderName: {
    color: tokens.colorNeutralForeground3,
  },
  rowActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
  },
  badgeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  lockCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    alignItems: 'flex-start',
  },
  lockHolder: {
    color: tokens.colorNeutralForeground2,
    maxWidth: '180px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'block',
  },
  evidenceText: {
    color: tokens.colorNeutralForeground3,
    display: 'block',
    maxWidth: '360px',
  },
  advisoryList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  grantInstructions: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    marginTop: tokens.spacingVerticalXS,
  },
  duplicateFileList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  duplicateFileOption: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  duplicateFileMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  duplicateFileMetaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  duplicateModeSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    marginTop: tokens.spacingVerticalM,
  },
});

const ORPHAN_TONE: Record<ProfileOrphanStatus, StatusTone> = {
  orphan: 'warning',
  'not-orphan': 'ok',
  unknown: 'unknown',
};

const ORPHAN_LABEL: Record<ProfileOrphanStatus, string> = {
  orphan: 'Orphan',
  'not-orphan': 'Active user',
  unknown: 'Unknown',
};

/**
 * Orphan badge + evidence. The badge itself carries the evidence as a
 * Tooltip (now functional — StatusBadge.tsx's forwardRef fix, peer review
 * item 5), but for 'orphan'/'unknown' rows the evidence is ALSO rendered as
 * plain visible text underneath — an admin deciding whether to reset a
 * profile must not need to hover to see WHY it's flagged (peer review item
 * 5's explicit requirement). 'not-orphan' rows keep the tooltip-only
 * treatment — that evidence is reassuring detail, not something a decision
 * hinges on.
 */
function OrphanBadge({ status, evidence }: { status: ProfileOrphanStatus; evidence: string }) {
  const styles = useStyles();
  return (
    <div className={styles.identityCell}>
      <Tooltip content={evidence} relationship="description">
        <StatusBadge label={ORPHAN_LABEL[status]} tone={ORPHAN_TONE[status]} />
      </Tooltip>
      {status !== 'not-orphan' && (
        <Text className={styles.evidenceText} size={200}>
          {evidence}
        </Text>
      )}
    </div>
  );
}

function LockBadge({ locked, lockedBy }: { locked: boolean; lockedBy: string | undefined }) {
  const styles = useStyles();
  if (!locked) {
    return <StatusBadge label="Unlocked" tone="info" />;
  }
  // Live review (2026-08-16): the full holder identity used to be inlined
  // into the Badge label, wrapping a long UPN across two cramped lines
  // inside the pill. The badge now stays a short "In use" pill and the
  // holder renders as a truncated caption beneath it; the Tooltip keeps the
  // full, untruncated identity.
  return (
    <Tooltip content={lockedBy ? `Open handle held by "${lockedBy}" as of the last refresh.` : 'An open handle was detected, but its holder could not be identified.'} relationship="description">
      <div className={styles.lockCell} tabIndex={0}>
        <div className={styles.badgeRow}>
          <LockClosed16Filled aria-hidden="true" />
          <StatusBadge label="In use" tone="warning" />
        </div>
        {lockedBy && (
          <Text size={200} className={styles.lockHolder}>
            {lockedBy}
          </Text>
        )}
      </div>
    </Tooltip>
  );
}

/**
 * AM-51: flags a folder holding more than one active VHD(X) container — the
 * motivating incident class (a missing VolumeType setting forking
 * `Profile_dsmith.vhd` alongside `Profile_dsmith.VHDX`). Rendered next to
 * the Oversized badge, same Tooltip-over-StatusBadge idiom, but tone
 * 'error' (not 'warning') — FSLogix's behavior when it can't tell which
 * container to mount is undefined, and Reset already refuses outright for
 * this shape, so this is a stronger signal than "this profile is large."
 */
function DuplicateContainerBadge({ activeSiblingCount }: { activeSiblingCount: number }) {
  return (
    <Tooltip
      content={`This folder holds ${activeSiblingCount} active VHD(X) containers — FSLogix may load the wrong one. Resolve before the user's next sign-in.`}
      relationship="description"
    >
      <StatusBadge label="Duplicate container" tone="error" />
    </Tooltip>
  );
}

function nameParseHint(quality: ProfileVhd['nameParseQuality']): string | undefined {
  return quality === 'unrecognized' ? 'Folder name did not parse into a SID/username — showing the raw folder name.' : undefined;
}

/** User/folder identity cell shared by the active and retired tables. */
function IdentityCell({ userPrincipalName, folderName, nameParseQuality }: { userPrincipalName: string | undefined; folderName: string; nameParseQuality: ProfileVhd['nameParseQuality'] }) {
  const styles = useStyles();
  const hint = nameParseHint(nameParseQuality);
  const primary = userPrincipalName ?? folderName;
  return (
    <div className={styles.identityCell}>
      <Text>{primary}</Text>
      {userPrincipalName && (
        <Text className={styles.folderName} size={200}>
          {folderName}
        </Text>
      )}
      {hint && (
        <Tooltip content={hint} relationship="description">
          <Text className={styles.folderName} size={200}>
            (unrecognized name)
          </Text>
        </Tooltip>
      )}
    </div>
  );
}

/** Peer review item 4: explains why Reset/Restore/Delete is disabled for a loose root-level VHD file with no wrapping directory — see @avdmgr/shared's ProfileContainerKind doc comment. Wrapped in a plain <span> (peer review item 5 / minor 13): Tooltip cannot reliably hover/focus a genuinely DISABLED <Button> (disabled elements don't reliably receive pointer/focus events across browsers), so the tooltip target is the span wrapping the button instead. */
const ROOT_FILE_EXPLANATION = 'This profile is a loose VHD(X) file directly at the share root, with no wrapping folder — reset, restore, and delete are not supported for this shape through this app.';

type ResetTarget = { profile: ProfileVhd };
type RestoreTarget = { retired: RetiredProfileVhd };
type DeleteTarget = { retired: RetiredProfileVhd };
/** AM-51 step 1: the picker dialog, listing every active file in the folder (the row that triggered it, plus its duplicate siblings — already in the fetched profiles list, no extra read). */
type DuplicatePickerTarget = { folderName: string; siblings: ProfileVhd[] };
/** AM-51 step 2: the operator's picked file + mode, handed to ConfirmModal. */
type DuplicateConfirmTarget = { folderName: string; siblings: ProfileVhd[]; chosen: ProfileVhd; mode: DuplicateContainerResolveMode };

function sortBySizeDescending<T extends { sizeBytes: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function isOlderThan30Days(retiredAt: string | undefined, now: Date = new Date()): boolean {
  if (!retiredAt) return false;
  const retiredDate = new Date(retiredAt);
  if (Number.isNaN(retiredDate.getTime())) return false;
  return now.getTime() - retiredDate.getTime() > THIRTY_DAYS_MS;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** AM-13's own scope: static exclusion-path advisories, cited to the FSLogix operations runbook §6 — informational only, no per-profile scanning. */
function ExclusionAdvisoryCard() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  return (
    <Card className={mergeClasses(cardStyles.card, styles.card)}>
      <CardHeader header={<Text as="h2" size={400} weight="semibold">Cache exclusion recommendations</Text>} />
      <Text size={200} className={styles.folderName}>
        Cited from the FSLogix operations runbook §6 — Electron-based apps cache aggressively in AppData, and that cache rides inside the FSLogix container, inflating profile size and slowing
        mount/unmount. These are the estate's documented likely large-cache contributors; confirm against the actual installed application set before assuming they all apply.
      </Text>
      <ul className={styles.advisoryList}>
        <li>
          <Text weight="semibold">Slack</Text> (if installed as a per-machine app) — exclude <code>AppData\Roaming\Slack\Cache</code> and <code>AppData\Roaming\Slack\Service Worker\CacheStorage</code>. Cited
          directly as a several-hundred-MB-per-user cache.
        </li>
        <li>
          <Text weight="semibold">Microsoft Teams (new)</Text> — exclude <code>AppData\Local\Packages\MSTeams_*\LocalCache\Microsoft\MSTeams\...\Cache</code> (path varies by packaging version). Caches
          meeting/chat media locally; large on active users.
        </li>
        <li>
          <Text weight="semibold">WebView2-hosted apps</Text> — exclude <code>AppData\Local\Microsoft\EdgeWebView\...\EBWebView\...\Cache</code> (path varies by hosting app). Any app embedding WebView2
          inherits browser-style disk caching.
        </li>
      </ul>
      <Text size={200} className={styles.folderName}>
        These exclusions are configured in the Intune FSLogix Settings Catalog profile (Redirection XML / Exclusion list setting) — not in this app, and not baked into the golden image.
      </Text>
    </Card>
  );
}

/**
 * Profiles — AM-13 (M5): FSLogix profile VHD(X) inventory on the profile
 * storage account, via OAuth FileREST (see
 * app/api/src/services/fslogixProfilesService.ts). Degrades in TWO
 * independent, distinctly-worded ways rather than going blank:
 *   - FileREST unavailable (fileRest.status) — shows the management-plane
 *     share-usage fallback instead of a profile table.
 *   - Orphan detection degraded (orphanDetection.status) — the profile
 *     table still renders fully; only the orphan column reads "Unknown"
 *     with an explanatory tooltip AND visible text, plus a page-level
 *     notice.
 */
export default function Profiles() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const { role } = useAuth();
  const canReset = role === 'admin';
  const forceRefreshRef = useRef(false);

  const query = usePolling(
    (signal) => {
      const forceRefresh = forceRefreshRef.current;
      forceRefreshRef.current = false;
      return getProfiles({ forceRefresh, signal });
    },
    POLL_INTERVAL_MS,
  );

  function refreshBypassingCache() {
    forceRefreshRef.current = true;
    query.refresh();
  }

  const [showOversizedOnly, setShowOversizedOnly] = useState(false);
  const [showOrphanedOnly, setShowOrphanedOnly] = useState(false);
  const [showDuplicatesOnly, setShowDuplicatesOnly] = useState(false);

  const [resetTarget, setResetTarget] = useState<ResetTarget | undefined>();
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | undefined>();

  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | undefined>();
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | undefined>();

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | undefined>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  // AM-51 — duplicate-container guided fix: a two-step flow. Step 1
  // (duplicatePickerTarget) lists the folder's active siblings and lets the
  // operator choose exactly one + a mode; step 2 (duplicateConfirmTarget)
  // hands that choice to the shared ConfirmModal gate. Only one of the two
  // is ever set at a time.
  const [duplicatePickerTarget, setDuplicatePickerTarget] = useState<DuplicatePickerTarget | undefined>();
  const [duplicateConfirmTarget, setDuplicateConfirmTarget] = useState<DuplicateConfirmTarget | undefined>();
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | undefined>();

  const { dispatchToast } = useAppToast();

  function showSuccessToast(text: string) {
    dispatchToast(
      <Toast>
        <ToastTitle>{text}</ToastTitle>
      </Toast>,
      { intent: 'success' },
    );
  }

  async function confirmReset(reason: string | undefined) {
    if (!resetTarget) return;
    if (!reason) {
      // Defensive — ConfirmModal's reasonRequired already keeps Confirm
      // disabled without a non-empty reason, so this should be
      // unreachable in practice; surfaced as an error rather than a
      // silent no-op (peer review nit) in case that invariant is ever
      // violated by a future change to ConfirmModal.
      setResetError('A reason is required.');
      return;
    }
    setResetBusy(true);
    setResetError(undefined);
    try {
      await resetProfile(resetTarget.profile.folderName, { reason });
      setResetTarget(undefined);
      showSuccessToast(`Reset "${resetTarget.profile.userPrincipalName ?? resetTarget.profile.folderName}" — the profile will be recreated fresh on next sign-in.`);
      refreshBypassingCache();
    } catch (error) {
      setResetError(error instanceof ApiClientError ? error.message : 'Failed to reset the profile.');
    } finally {
      setResetBusy(false);
    }
  }

  async function confirmRestore(reason: string | undefined) {
    if (!restoreTarget) return;
    setRestoreBusy(true);
    setRestoreError(undefined);
    try {
      await restoreProfile(restoreTarget.retired.folderName, { retiredFileName: restoreTarget.retired.retiredFileName, reason });
      setRestoreTarget(undefined);
      showSuccessToast(`Restored "${restoreTarget.retired.userPrincipalName ?? restoreTarget.retired.folderName}".`);
      refreshBypassingCache();
    } catch (error) {
      setRestoreError(error instanceof ApiClientError ? error.message : 'Failed to restore the profile.');
    } finally {
      setRestoreBusy(false);
    }
  }

  async function confirmDelete(reason: string | undefined) {
    if (!deleteTarget) return;
    if (!reason) {
      setDeleteError('A reason is required.');
      return;
    }
    setDeleteBusy(true);
    setDeleteError(undefined);
    try {
      await deleteRetiredProfile(deleteTarget.retired.folderName, deleteTarget.retired.retiredFileName, { reason });
      setDeleteTarget(undefined);
      showSuccessToast(`Permanently deleted "${deleteTarget.retired.retiredFileName}". This cannot be undone.`);
      refreshBypassingCache();
    } catch (error) {
      setDeleteError(error instanceof ApiClientError ? error.message : 'Failed to delete the retired profile.');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function confirmDuplicateResolve(reason: string | undefined) {
    if (!duplicateConfirmTarget) return;
    if (!reason) {
      // Defensive — same rationale as confirmReset/confirmDelete's own
      // check above: ConfirmModal already keeps Confirm disabled without a
      // non-empty reason for both severities this dialog uses.
      setDuplicateError('A reason is required.');
      return;
    }
    const { folderName, chosen, mode } = duplicateConfirmTarget;
    setDuplicateBusy(true);
    setDuplicateError(undefined);
    try {
      await resolveDuplicateContainer(folderName, { fileName: chosen.fileName, mode, reason });
      setDuplicateConfirmTarget(undefined);
      const who = chosen.userPrincipalName ?? folderName;
      showSuccessToast(
        mode === 'retire'
          ? `Retired "${chosen.fileName}" from ${who}'s profile folder — it can be restored later from the Retired profiles list.`
          : `Permanently deleted "${chosen.fileName}" from ${who}'s profile folder. This cannot be undone.`,
      );
      refreshBypassingCache();
    } catch (error) {
      setDuplicateError(error instanceof ApiClientError ? error.message : 'Failed to resolve the duplicate container.');
    } finally {
      setDuplicateBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      {/* AM-29 items A/G: PageHeader carries asOf/refreshing, and a visible Refresh button (item 11) using the existing refreshBypassingCache. */}
      <PageHeader title="Profiles" asOf={query.data ? new Date(query.data.generatedAt) : query.lastUpdated} refreshing={query.refreshing} onRefresh={refreshBypassingCache} />

      <AsyncState loading={query.loading} error={query.error as Error | undefined} data={query.data} asOf={query.lastUpdated} variant="table">
        {(data) => {
          if (data.fileRest.status === 'unavailable') {
            const reasonText =
              data.fileRest.reason === 'forbidden'
                ? 'the Function App is not currently authorized (check the Storage File Data Privileged Contributor role assignment)'
                : data.fileRest.reason === 'network'
                  ? 'the private-endpoint network path could not be reached'
                  : 'an unexpected error occurred';
            return (
              <>
                <MessageBar intent="warning" role="alert">
                  <MessageBarBody>
                    <MessageBarTitle>FileREST is unavailable</MessageBarTitle>
                    Could not list individual profiles — {reasonText}. Showing share-level capacity only.
                  </MessageBarBody>
                </MessageBar>
                {data.fallbackShareUsage ? (
                  <Card className={mergeClasses(cardStyles.card, styles.card)}>
                    <CardHeader header={<Text as="h2" size={400} weight="semibold">FSLogix profile share (capacity only)</Text>} />
                    <div className={styles.usageRow}>
                      <Text>
                        {data.fallbackShareUsage.shareName} ({data.fallbackShareUsage.storageAccountName})
                      </Text>
                      <Text>
                        {data.fallbackShareUsage.provisionedGib > 0 ? (
                          <>
                            {data.fallbackShareUsage.usedGib} GiB used / {data.fallbackShareUsage.provisionedGib} GiB provisioned ({data.fallbackShareUsage.percentUsed.toFixed(1)}%)
                          </>
                        ) : (
                          <>{data.fallbackShareUsage.usedGib} GiB used — provisioned size not reported</>
                        )}
                      </Text>
                    </div>
                    <ProgressBar
                      value={data.fallbackShareUsage.provisionedGib > 0 ? data.fallbackShareUsage.percentUsed : 0}
                      max={100}
                      thickness="large"
                      color={data.fallbackShareUsage.percentUsed >= 90 ? 'error' : data.fallbackShareUsage.percentUsed >= 75 ? 'warning' : 'brand'}
                    />
                  </Card>
                ) : (
                  <MessageBar intent="error">
                    <MessageBarBody>The management-plane capacity fallback is also unavailable right now.</MessageBarBody>
                  </MessageBar>
                )}
                <ExclusionAdvisoryCard />
              </>
            );
          }

          return (
            <ProfilesContent
              data={data}
              styles={styles}
              canReset={canReset}
              showOversizedOnly={showOversizedOnly}
              setShowOversizedOnly={setShowOversizedOnly}
              showOrphanedOnly={showOrphanedOnly}
              setShowOrphanedOnly={setShowOrphanedOnly}
              showDuplicatesOnly={showDuplicatesOnly}
              setShowDuplicatesOnly={setShowDuplicatesOnly}
              onReset={(profile) => setResetTarget({ profile })}
              onRestore={(retired) => setRestoreTarget({ retired })}
              onDelete={(retired) => setDeleteTarget({ retired })}
              onResolveDuplicate={(profile) => setDuplicatePickerTarget({ folderName: profile.folderName, siblings: data.profiles.filter((p) => p.folderName === profile.folderName) })}
            />
          );
        }}
      </AsyncState>

      {/* AM-29 item 30: reset is severity 'medium' — recoverable by rename (restore undoes it), so no typed name, just a mandatory reason. */}
      {resetTarget && (
        <ConfirmModal
          title={`Reset ${resetTarget.profile.userPrincipalName ?? resetTarget.profile.folderName}?`}
          severity="medium"
          description="This renames the profile's VHD(X) to a retired name. The user gets a brand-new, empty profile on their next sign-in. The retired file is kept and can be restored later from the Retired profiles list — nothing is deleted."
          confirmLabel="Reset profile"
          busy={resetBusy}
          error={resetError}
          onConfirm={(reason) => confirmReset(reason)}
          onCancel={() => {
            if (!resetBusy) {
              setResetTarget(undefined);
              setResetError(undefined);
            }
          }}
        />
      )}

      {/* AM-29 item 30: restore is severity 'medium' — migrated off ReasonConfirmDialog onto the primitive. */}
      {restoreTarget && (
        <ConfirmModal
          title={`Restore ${restoreTarget.retired.userPrincipalName ?? restoreTarget.retired.folderName}?`}
          severity="medium"
          description={`Renames "${restoreTarget.retired.retiredFileName}" back to "${restoreTarget.retired.originalFileName}". Refuses (and makes no change) if a profile already exists at that name — e.g. the user signed in again and got a fresh profile since the reset; resolve that conflict manually before retrying.`}
          confirmLabel="Restore profile"
          busy={restoreBusy}
          error={restoreError}
          onConfirm={(reason) => confirmRestore(reason)}
          onCancel={() => {
            if (!restoreBusy) {
              setRestoreTarget(undefined);
              setRestoreError(undefined);
            }
          }}
        />
      )}

      {/* AM-29 item 30: permanent delete is severity 'high' — typed DELETE (a fixed literal word), NOT the VHD filename, per the coordinator's explicit rubric. */}
      {deleteTarget && (
        <ConfirmModal
          title={`Permanently delete ${deleteTarget.retired.retiredFileName}?`}
          severity="high"
          confirmText="DELETE"
          description="Unlike a reset, there is no restore afterward. Only do this once you're confident the retention window has passed and no recovery will be needed."
          impact={<ImpactPreview lines={profileDeletePreviewLines(deleteTarget.retired)} />}
          confirmLabel="Permanently delete"
          busy={deleteBusy}
          error={deleteError}
          onConfirm={(reason) => confirmDelete(reason)}
          onCancel={() => {
            if (!deleteBusy) {
              setDeleteTarget(undefined);
              setDeleteError(undefined);
            }
          }}
        />
      )}

      {/* AM-51 step 1: pick exactly one of the folder's active files + a mode, before handing off to the shared ConfirmModal gate below. */}
      {duplicatePickerTarget && (
        <DuplicateResolvePickerDialog
          target={duplicatePickerTarget}
          styles={styles}
          onCancel={() => setDuplicatePickerTarget(undefined)}
          onContinue={(chosen, mode) => {
            setDuplicatePickerTarget(undefined);
            setDuplicateConfirmTarget({ folderName: duplicatePickerTarget.folderName, siblings: duplicatePickerTarget.siblings, chosen, mode });
          }}
        />
      )}

      {/* AM-51 step 2: retire is severity 'medium' (reversible via the existing Restore flow); delete is severity 'high' with a typed DELETE gate and an ImpactPreview naming what stays behind — same rubric as Reset/Delete above. */}
      {duplicateConfirmTarget && duplicateConfirmTarget.mode === 'retire' && (
        <ConfirmModal
          title={`Retire "${duplicateConfirmTarget.chosen.fileName}"?`}
          severity="medium"
          description={`Renames "${duplicateConfirmTarget.chosen.fileName}" to a retired name, leaving exactly one active container in this folder. The retired file is kept and can be restored later from the Retired profiles list — nothing is deleted. Refuses if ${duplicateConfirmTarget.chosen.userPrincipalName ?? duplicateConfirmTarget.folderName} currently has an active session, or if the file is in use.`}
          confirmLabel="Retire this container"
          busy={duplicateBusy}
          error={duplicateError}
          onConfirm={(reason) => confirmDuplicateResolve(reason)}
          onCancel={() => {
            if (!duplicateBusy) {
              setDuplicateConfirmTarget(undefined);
              setDuplicateError(undefined);
            }
          }}
        />
      )}
      {duplicateConfirmTarget && duplicateConfirmTarget.mode === 'delete' && (
        <ConfirmModal
          title={`Permanently delete "${duplicateConfirmTarget.chosen.fileName}"?`}
          severity="high"
          confirmText="DELETE"
          description="Unlike retiring, there is no restore afterward. Refuses if the profile's user currently has an active session, or if the file is in use."
          impact={<ImpactPreview lines={duplicateDeletePreviewLines(duplicateConfirmTarget.chosen, duplicateConfirmTarget.siblings)} />}
          confirmLabel="Permanently delete"
          busy={duplicateBusy}
          error={duplicateError}
          onConfirm={(reason) => confirmDuplicateResolve(reason)}
          onCancel={() => {
            if (!duplicateBusy) {
              setDuplicateConfirmTarget(undefined);
              setDuplicateError(undefined);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * AM-51 step 1 of the duplicate-container resolve flow: lists every active
 * file in the folder (radio-select exactly one) and the mode (retire vs
 * delete), then hands both to the caller's onContinue — which opens the
 * actual ConfirmModal gate (Profiles.tsx renders it, not this component, so
 * severity/confirmText/impact stay driven by the single shared rubric every
 * other mutation on this page uses).
 */
function DuplicateResolvePickerDialog({
  target,
  styles,
  onCancel,
  onContinue,
}: {
  target: DuplicatePickerTarget;
  styles: ReturnType<typeof useStyles>;
  onCancel: () => void;
  onContinue: (chosen: ProfileVhd, mode: DuplicateContainerResolveMode) => void;
}) {
  const sortedSiblings = useMemo(() => sortBySizeDescending(target.siblings), [target.siblings]);
  const [selectedFileName, setSelectedFileName] = useState<string | undefined>(sortedSiblings[0]?.fileName);
  const [mode, setMode] = useState<DuplicateContainerResolveMode>('retire');
  const selected = sortedSiblings.find((s) => s.fileName === selectedFileName);

  return (
    <Dialog open onOpenChange={(_event, data) => !data.open && onCancel()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Resolve duplicate containers — {target.siblings[0]?.userPrincipalName ?? target.folderName}</DialogTitle>
          <DialogContent>
            <Text as="p" block>
              This folder holds {target.siblings.length} active VHD(X) containers. Choose the ONE file to retire or delete — the other(s) will remain as the folder's active profile.
            </Text>
            <div className={styles.duplicateFileList}>
              {sortedSiblings.map((file) => (
                <label key={file.fileName} className={styles.duplicateFileOption}>
                  <input
                    type="radio"
                    name="duplicate-file"
                    value={file.fileName}
                    checked={selectedFileName === file.fileName}
                    onChange={() => setSelectedFileName(file.fileName)}
                  />
                  <div className={styles.duplicateFileMeta}>
                    <Text weight="semibold">{file.fileName}</Text>
                    <div className={styles.duplicateFileMetaRow}>
                      <Text size={200}>{file.sizeGb} GiB</Text>
                      <Text size={200} className={styles.folderName}>
                        Modified {formatDateTime(file.lastModified)}
                      </Text>
                    </div>
                    <LockBadge locked={file.locked} lockedBy={file.lockedBy} />
                  </div>
                </label>
              ))}
            </div>
            <div className={styles.duplicateModeSection}>
              <Text weight="semibold">What should happen to the chosen file?</Text>
              <RadioGroup value={mode} onChange={(_event, data) => setMode(data.value as DuplicateContainerResolveMode)}>
                <Radio value="retire" label="Retire (recommended — renames it; can be restored later)" />
                <Radio value="delete" label="Permanently delete (irreversible)" />
              </RadioGroup>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={!selected} onClick={() => selected && onContinue(selected, mode)}>
              Continue
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface ProfilesContentProps {
  data: {
    shareName: string;
    oversizedThresholdGb: number;
    profiles: ProfileVhd[];
    retired: RetiredProfileVhd[];
    partial: boolean;
    orphanDetection: { status: string; grantInstructions?: readonly string[] };
  };
  styles: ReturnType<typeof useStyles>;
  canReset: boolean;
  showOversizedOnly: boolean;
  setShowOversizedOnly: (value: boolean) => void;
  showOrphanedOnly: boolean;
  setShowOrphanedOnly: (value: boolean) => void;
  showDuplicatesOnly: boolean;
  setShowDuplicatesOnly: (value: boolean) => void;
  onReset: (profile: ProfileVhd) => void;
  onRestore: (retired: RetiredProfileVhd) => void;
  onDelete: (retired: RetiredProfileVhd) => void;
  onResolveDuplicate: (profile: ProfileVhd) => void;
}

/** Split out from the render-prop body above purely so useMemo (sorting/filtering) has a stable component scope — the parent AsyncState render prop re-creates a new closure on every poll tick regardless, so this doesn't change re-render behavior, just keeps the memoization readable. */
function ProfilesContent({
  data,
  styles,
  canReset,
  showOversizedOnly,
  setShowOversizedOnly,
  showOrphanedOnly,
  setShowOrphanedOnly,
  showDuplicatesOnly,
  setShowDuplicatesOnly,
  onReset,
  onRestore,
  onDelete,
  onResolveDuplicate,
}: ProfilesContentProps) {
  const cardStyles = useCardStyles();
  // Peer review item 16: sort by size descending, then apply the
  // oversized/orphaned/duplicate filter toggles (AND'd together when more
  // than one is on).
  const sortedProfiles = useMemo(() => sortBySizeDescending(data.profiles), [data.profiles]);
  const visibleProfiles = useMemo(
    () =>
      sortedProfiles.filter(
        (profile) => (!showOversizedOnly || profile.oversized) && (!showOrphanedOnly || profile.orphanStatus === 'orphan') && (!showDuplicatesOnly || profile.duplicateContainer),
      ),
    [sortedProfiles, showOversizedOnly, showOrphanedOnly, showDuplicatesOnly],
  );
  const sortedRetired = useMemo(() => sortBySizeDescending(data.retired), [data.retired]);
  const totalRetiredGb = useMemo(() => round2(data.retired.reduce((sum, r) => sum + r.sizeGb, 0)), [data.retired]);

  // AM-35 (item 44) — neither table was user-sortable before this refactor
  // (both used a FIXED size-descending default order — see sortedProfiles/
  // sortedRetired above); no column here sets `sortable`, so DataTable
  // renders these rows in that same given order, unchanged.
  //
  // Peer review (Opus, MINOR 5) — memoized (not rebuilt every render): the
  // parent AsyncState render prop already recreates this component's own
  // closure on every poll tick regardless (see this component's own doc
  // comment above), so a stable columns reference here is the only lever
  // left to stop DataTable's sortedRows memo from being busted on ticks
  // where the underlying data/filters/styles haven't actually changed.
  const activeColumns = useMemo<DataTableColumn<ProfileVhd>[]>(
    () => [
      { id: 'user', label: 'User', renderCell: (profile) => <IdentityCell userPrincipalName={profile.userPrincipalName} folderName={profile.folderName} nameParseQuality={profile.nameParseQuality} /> },
      {
        id: 'size',
        label: 'Size',
        renderCell: (profile) => (
          <div className={styles.badgeRow}>
            <Text>{profile.sizeGb} GiB</Text>
            {profile.oversized && (
              <Tooltip content={`At or above the configured ${data.oversizedThresholdGb} GiB threshold.`} relationship="description">
                <StatusBadge label="Oversized" tone="warning" />
              </Tooltip>
            )}
            {profile.duplicateContainer && <DuplicateContainerBadge activeSiblingCount={profile.activeSiblingCount} />}
          </div>
        ),
      },
      { id: 'lastModified', label: 'Last modified', renderCell: (profile) => formatDateTime(profile.lastModified) },
      { id: 'orphanStatus', label: 'Orphan status', renderCell: (profile) => <OrphanBadge status={profile.orphanStatus} evidence={profile.orphanEvidence} /> },
      { id: 'lockState', label: 'Lock state', renderCell: (profile) => <LockBadge locked={profile.locked} lockedBy={profile.lockedBy} /> },
    ],
    [styles, data.oversizedThresholdGb],
  );

  const retiredColumns = useMemo<DataTableColumn<RetiredProfileVhd>[]>(
    () => [
      { id: 'user', label: 'User', renderCell: (retired) => <IdentityCell userPrincipalName={retired.userPrincipalName} folderName={retired.folderName} nameParseQuality={retired.nameParseQuality} /> },
      { id: 'retiredFile', label: 'Retired file', renderCell: (retired) => retired.retiredFileName },
      { id: 'size', label: 'Size', renderCell: (retired) => `${retired.sizeGb} GiB` },
      {
        id: 'retiredAt',
        label: 'Retired at',
        renderCell: (retired) => (
          <div className={styles.identityCell}>
            <Text>{retired.retiredAt ? formatDateTime(retired.retiredAt) : 'Unknown (unrecognized retired-suffix format)'}</Text>
            {isOlderThan30Days(retired.retiredAt) && (
              <Tooltip content="Retired more than 30 days ago — consider whether it's safe to permanently delete." relationship="description">
                <StatusBadge label="Older than 30 days" tone="warning" />
              </Tooltip>
            )}
          </div>
        ),
      },
    ],
    [styles],
  );

  return (
    <>
      {data.partial && (
        <MessageBar intent="warning">
          <MessageBarBody>One or more profile directories could not be listed this refresh — the tables below are a partial inventory, not a complete one. Try refreshing again shortly.</MessageBarBody>
        </MessageBar>
      )}
      {data.orphanDetection.status === 'not-configured' && (
        <MessageBar intent="info">
          <MessageBarBody>Orphan detection is not configured — set the AVD_USERS_GROUP_ID app setting to this estate's AVD-Users group object ID.</MessageBarBody>
        </MessageBar>
      )}
      {data.orphanDetection.status === 'unavailable' && (
        <MessageBar intent="info">
          <MessageBarBody>Orphan detection could not run this refresh — Microsoft Graph returned an error. This is usually transient; try refreshing again shortly.</MessageBarBody>
        </MessageBar>
      )}
      {data.orphanDetection.status === 'graph-permission-not-granted' && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Orphan detection unavailable</MessageBarTitle>
            Microsoft Graph GroupMember.Read.All has not been granted to this app's managed identity yet — see docs/app-registration.md section 10.
            {/* AM-29 item 24: tabIndex so a keyboard user can actually scroll this horizontally when a long command wraps the viewport, matching Governance.tsx's own scrollable <pre> pattern. */}
            <pre className={styles.grantInstructions} tabIndex={0}>
              {(data.orphanDetection.grantInstructions ?? []).join('\n')}
            </pre>
          </MessageBarBody>
        </MessageBar>
      )}

      <Card className={mergeClasses(cardStyles.card, styles.card)}>
        <div className={styles.cardHeaderRow}>
          <CardHeader header={<Text as="h2" size={400} weight="semibold">Active profiles ({visibleProfiles.length} of {data.profiles.length})</Text>} />
          <div className={styles.filterRow}>
            <Switch label="Oversized only" checked={showOversizedOnly} onChange={(_event, value) => setShowOversizedOnly(value.checked)} />
            <Switch label="Orphaned only" checked={showOrphanedOnly} onChange={(_event, value) => setShowOrphanedOnly(value.checked)} />
            <Switch label="Duplicates only" checked={showDuplicatesOnly} onChange={(_event, value) => setShowDuplicatesOnly(value.checked)} />
          </div>
        </div>
        <DataTable
          ariaLabel="Active FSLogix profiles"
          columns={activeColumns}
          rows={visibleProfiles}
          getRowKey={(profile) => profile.id}
          emptyMessage={data.profiles.length === 0 ? `No active profile VHD(X) files were found on ${data.shareName}.` : 'No profiles match the current filters.'}
          rowActions={
            canReset
              ? (profile) => {
                  const isRootFile = profile.kind === 'root-file';
                  const resetDisabled = profile.locked || isRootFile;
                  const resetTooltip = isRootFile ? ROOT_FILE_EXPLANATION : profile.locked ? 'This profile is currently in use and cannot be reset.' : 'Rename the VHD(X) to a retired name — recreated fresh on next sign-in.';
                  return (
                    <div className={styles.rowActions}>
                      {/* Peer review MINOR fix: same conditional tabIndex as the
                          Restore/Delete spans below — see their comment. */}
                      <Tooltip content={resetTooltip} relationship="label">
                        <span tabIndex={resetDisabled ? 0 : undefined}>
                          <Button size="small" appearance="secondary" onClick={() => onReset(profile)} disabled={resetDisabled}>
                            Reset
                          </Button>
                        </span>
                      </Tooltip>
                      {/* AM-51 — only shown for a row this app has flagged as sharing its folder with more than one active container; opens the guided retire/delete picker. */}
                      {profile.duplicateContainer && (
                        <Button size="small" appearance="secondary" onClick={() => onResolveDuplicate(profile)}>
                          Resolve duplicate…
                        </Button>
                      )}
                    </div>
                  );
                }
              : undefined
          }
        />
      </Card>

      <Card className={mergeClasses(cardStyles.card, styles.card)}>
        <div className={styles.cardHeaderRow}>
          <CardHeader header={<Text as="h2" size={400} weight="semibold">Retired profiles ({data.retired.length})</Text>} />
          {data.retired.length > 0 && (
            <Text size={200} className={styles.folderName}>
              {totalRetiredGb} GiB retained
            </Text>
          )}
        </div>
        <DataTable
          ariaLabel="Retired FSLogix profiles"
          columns={retiredColumns}
          rows={sortedRetired}
          getRowKey={(retired) => retired.id}
          emptyMessage="No retired profiles."
          rowActions={
            canReset
              ? (retired) => {
                  const isRootFile = retired.kind === 'root-file';
                  return (
                    // AM-31 item 40 — Restore/Delete collapse into a single overflow menu (neither is frequent enough on retired/historical rows to warrant its own inline button). Root-file rows (no supported actions at all) keep the SAME disabled-trigger-with-tooltip pattern the rest of this file uses — a plain <span tabIndex={0}> wrapper, since a genuinely disabled <button> doesn't reliably receive pointer/focus events.
                    <div className={styles.rowActions}>
                      <Tooltip content={isRootFile ? ROOT_FILE_EXPLANATION : `More actions for ${retired.userPrincipalName ?? retired.folderName}`} relationship="label">
                        <span tabIndex={isRootFile ? 0 : undefined}>
                          <Menu>
                            <MenuTrigger disableButtonEnhancement>
                              <Button
                                size="small"
                                appearance="secondary"
                                icon={<MoreHorizontal20Regular />}
                                disabled={isRootFile}
                                aria-label={`More actions for ${retired.userPrincipalName ?? retired.folderName}`}
                              />
                            </MenuTrigger>
                            <MenuPopover>
                              <MenuList>
                                <MenuItem onClick={() => onRestore(retired)}>Restore</MenuItem>
                                {/* Peer review MINOR 12 — restores the destructive warning the overflow-menu collapse (item 40) dropped: a plain "Delete" label used to carry no hint at all that this is permanent, unlike Reset/Restore's own ConfirmModal descriptions. */}
                                <MenuItem onClick={() => onDelete(retired)} secondaryContent="Permanently deletes this retired file — cannot be undone.">
                                  Delete
                                </MenuItem>
                              </MenuList>
                            </MenuPopover>
                          </Menu>
                        </span>
                      </Tooltip>
                    </div>
                  );
                }
              : undefined
          }
        />
      </Card>

      <ExclusionAdvisoryCard />
    </>
  );
}
