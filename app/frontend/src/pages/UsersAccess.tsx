import { useEffect, useMemo, useRef, useState } from 'react';
import {
  makeStyles,
  mergeClasses,
  tokens,
  Card,
  CardHeader,
  Text,
  Button,
  Input,
  Field,
  Textarea,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Tooltip,
  Toast,
  ToastTitle,
} from '@fluentui/react-components';
import type { AccessSearchResult, DesktopAssignment } from '@avdmgr/shared';
import { createDesktopAssignment, getDesktopAssignments, getWorkspaceFriendlyName, removeDesktopAssignment, searchAccess, updateWorkspaceFriendlyName } from '../api/avd';
import { ApiClientError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { useRegisterSearchShortcut } from '../hooks/useKeyboardShortcuts';
import AsyncState from '../components/AsyncState';
import RoleGate from '../components/RoleGate';
import ConfirmModal from '../components/ConfirmModal';
import PageHeader from '../components/PageHeader';
import DataTable, { type DataTableColumn } from '../components/DataTable';
import { useAuth } from '../auth/useAuth';
import { useCardStyles } from '../styles/shared';
import { useAppToast } from '../lib/toaster';

const POLL_INTERVAL_MS = 60_000;
/** Debounce delay between the last keystroke and firing the search request — short enough to feel responsive, long enough to avoid a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
/**
 * AM-14 peer review (fix 21): ARM role-assignment writes are not always
 * immediately visible on the very next read (documented read-after-write
 * lag on Azure Resource Manager's control plane, especially shortly after a
 * write) — refreshing the assignments list INSTANTLY after a create/remove
 * risks a poll that still shows the pre-mutation state, which would read to
 * an operator as "did that actually work?". A short delay gives ARM a
 * realistic window to converge before this app's own re-read. Not a
 * guarantee (a slower-than-usual propagation can still race this), just a
 * pragmatic default — an optimistic client-side patch was considered and
 * rejected for now: it would need to synthesize a full DesktopAssignment
 * (including assignedVia/scope) or Graph-resolved displayName without
 * another round trip, adding real complexity for a page that isn't on any
 * hot path.
 */
const POST_MUTATION_REFRESH_DELAY_MS = 2_000;

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  searchRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  resultsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalS,
  },
  resultRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  resultMeta: {
    color: tokens.colorNeutralForeground3,
  },
  actionsCell: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
  },
  friendlyNameRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
});

/**
 * displayName, falling back to userPrincipalName, falling back to the bare
 * principalId — the same fallback chain both the assignments table and the
 * typed-name confirm dialogs use, so "what the operator sees" and "what
 * they must type to confirm" always agree. Uses `??` (nullish coalescing,
 * not `||`) deliberately: these DTO fields are `string | undefined`, never
 * a meaningful empty string, so only null/undefined should fall through —
 * see resultLabel below for the ONE place that intentionally differs.
 */
function assignmentLabel(assignment: DesktopAssignment): string {
  return assignment.displayName ?? assignment.userPrincipalName ?? assignment.principalId;
}

/**
 * Same fallback chain as assignmentLabel, but `||` (not `??`) on purpose:
 * a Graph search result's displayName/userPrincipalName could come back as
 * an EMPTY string (not just undefined) for a sparsely-populated directory
 * object, and an empty label would render as a blank, unclickable-looking
 * row — `||` falls through on that too, `??` would not.
 */
function resultLabel(result: AccessSearchResult): string {
  return result.displayName || result.userPrincipalName || result.id;
}

/**
 * AM-31 item 38 — client-side filter for the assignments table: a
 * case-insensitive substring match against displayName, userPrincipalName,
 * OR the bare principalId (the only field guaranteed present — useful when
 * Graph names couldn't be resolved, see `data.graphResolved` below). An
 * empty/whitespace-only query matches every row.
 */
function matchesAssignmentSearch(assignment: DesktopAssignment, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return (
    (assignment.displayName ?? '').toLowerCase().includes(trimmed) ||
    (assignment.userPrincipalName ?? '').toLowerCase().includes(trimmed) ||
    assignment.principalId.toLowerCase().includes(trimmed)
  );
}

const ASSIGNMENT_COLUMNS = (styles: ReturnType<typeof useStyles>): DataTableColumn<DesktopAssignment>[] => [
  {
    id: 'principal',
    label: 'Principal',
    renderCell: (assignment) => (
      <>
        <Text block>{assignmentLabel(assignment)}</Text>
        {assignment.userPrincipalName && assignment.displayName && (
          <Text size={200} className={styles.resultMeta}>
            {assignment.userPrincipalName}
          </Text>
        )}
      </>
    ),
  },
  { id: 'type', label: 'Type', renderCell: (assignment) => assignment.principalType },
  { id: 'assignedVia', label: 'Assigned via', renderCell: (assignment) => assignment.assignedVia },
];

export default function UsersAccess() {
  const styles = useStyles();
  const cardStyles = useCardStyles();
  // Peer review (Opus, MINOR 5) — memoized on `styles`: ASSIGNMENT_COLUMNS is a function taking styles as a param (Griffel's useStyles output, only callable inside a component) specifically to avoid a module-level constant; calling it fresh inline on every render defeated that same purpose by rebuilding the array anyway.
  const assignmentColumns = useMemo(() => ASSIGNMENT_COLUMNS(styles), [styles]);
  const { dispatchToast } = useAppToast();
  const { role } = useAuth();
  /** Mirrors the API's requireMinimumRole('operator') gate on GET /v1/access/search — UI convenience only, the API independently re-checks (see app/README.md's Roles section). */
  const canSearch = role === 'operator' || role === 'admin';
  /** AM-14 peer review (fix 3): mirrors the API's requireMinimumRole('admin') gate on POST/DELETE /v1/access/assignments — an operator could previously complete search + typed-name confirm + reason only to get a 403 at the very last step. The search box itself stays visible to operator+ (still a useful read: "who would I even be granting access to"), but the Add/Remove actions themselves are admin-only, with an explanatory tooltip for a signed-in operator who can see but not use them. */
  const canAdminister = role === 'admin';

  const assignments = usePolling(getDesktopAssignments, POLL_INTERVAL_MS);
  const workspace = usePolling(getWorkspaceFriendlyName, POLL_INTERVAL_MS);

  // --- Search ---
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<AccessSearchResult[] | undefined>(undefined);
  const [searchGraphAvailable, setSearchGraphAvailable] = useState(true);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);

  const trimmedQuery = query.trim();
  /** Below MIN_QUERY_LENGTH, no search has run for the CURRENT query — any previously fetched searchResults are stale and must not render, but this is a plain render-time derivation, not state, so shortening the query never needs an effect to "clear" anything (see the effect below, which fires setState only from its debounce timer's callback — never synchronously in the effect body — per react-hooks/set-state-in-effect). */
  const resultsAreCurrent = trimmedQuery.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!canSearch || trimmedQuery.length < MIN_QUERY_LENGTH) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchLoading(true);
      setSearchError(undefined);
      searchAccess(trimmedQuery, controller.signal)
        .then((response) => {
          setSearchResults(response.results);
          setSearchGraphAvailable(response.graphAvailable);
          setSearchTruncated(response.truncated);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setSearchError(error instanceof ApiClientError ? error.message : 'Search failed.');
        })
        .finally(() => setSearchLoading(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery, canSearch]);

  // AM-14 peer review (fix 14): a query shortened back below
  // MIN_QUERY_LENGTH must not keep showing a stale error from a PRIOR
  // (longer) query. Rather than an effect that clears `searchError` state
  // (which would call setState synchronously in an effect body —
  // react-hooks/set-state-in-effect flags exactly that pattern, the same
  // way it already governs resultsAreCurrent/searchResults above), this is
  // a plain render-time derivation: `searchError` state itself is left
  // alone (still holds the last real error, if any) and simply isn't
  // DISPLAYED once the query it applied to is no longer current.
  const displaySearchError = resultsAreCurrent ? searchError : undefined;

  // --- Assign flow ---
  const [assignTarget, setAssignTarget] = useState<AccessSearchResult | undefined>(undefined);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | undefined>(undefined);

  async function confirmAssign(reason: string | undefined) {
    if (!assignTarget || !reason) return;
    setAssignBusy(true);
    setAssignError(undefined);
    try {
      await createDesktopAssignment({ principalId: assignTarget.id, principalType: assignTarget.principalType, reason });
      setAssignTarget(undefined);
      dispatchToast(
        <Toast>
          <ToastTitle>Granted desktop access to {resultLabel(assignTarget)}</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      setQuery('');
      setSearchResults(undefined);
      setTimeout(() => assignments.refresh(), POST_MUTATION_REFRESH_DELAY_MS);
    } catch (error) {
      setAssignError(error instanceof ApiClientError ? error.message : 'Failed to grant access.');
    } finally {
      setAssignBusy(false);
    }
  }

  // --- Remove flow ---
  const [removeTargetId, setRemoveTargetId] = useState<string | undefined>(undefined);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);

  const removeTarget = assignments.data?.assignments.find((a) => a.roleAssignmentId === removeTargetId);

  async function confirmRemove(reason: string | undefined) {
    if (!removeTarget || !reason) return;
    const label = assignmentLabel(removeTarget);
    setRemoveBusy(true);
    setRemoveError(undefined);
    try {
      await removeDesktopAssignment(removeTarget.roleAssignmentId, reason);
      setRemoveTargetId(undefined);
      dispatchToast(
        <Toast>
          <ToastTitle>Removed desktop access for {label}</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      setTimeout(() => assignments.refresh(), POST_MUTATION_REFRESH_DELAY_MS);
    } catch (error) {
      setRemoveError(error instanceof ApiClientError ? error.message : 'Failed to remove access.');
    } finally {
      setRemoveBusy(false);
    }
  }

  // --- AM-31 item 38: client-side search of the assignments table ---
  const [assignmentSearch, setAssignmentSearch] = useState('');
  const assignmentSearchRef = useRef<HTMLInputElement>(null);
  // AM-31 item 36 — this table's filter is this page's primary search field (always visible, unlike the operator+-gated Grant-access search above).
  useRegisterSearchShortcut(() => assignmentSearchRef.current?.focus());

  // --- Workspace friendly-name inline edit ---
  const [editingFriendlyName, setEditingFriendlyName] = useState(false);
  const [friendlyNameDraft, setFriendlyNameDraft] = useState('');
  const [friendlyNameReason, setFriendlyNameReason] = useState('');
  const [friendlyNameBusy, setFriendlyNameBusy] = useState(false);
  const [friendlyNameError, setFriendlyNameError] = useState<string | undefined>(undefined);

  function startEditingFriendlyName() {
    setFriendlyNameDraft(workspace.data?.friendlyName ?? '');
    setFriendlyNameReason('');
    setFriendlyNameError(undefined);
    setEditingFriendlyName(true);
  }

  async function saveFriendlyName() {
    setFriendlyNameBusy(true);
    setFriendlyNameError(undefined);
    try {
      // AM-14 peer review (fix 19): reason is OPTIONAL server-side (see
      // UpdateWorkspaceFriendlyNameRequest.reason in @avdmgr/shared) but
      // was never actually wired to an input here — every edit audited
      // reasonless. `|| undefined` collapses an empty/whitespace-only
      // draft to undefined rather than sending a blank string.
      await updateWorkspaceFriendlyName({ friendlyName: friendlyNameDraft, reason: friendlyNameReason.trim() || undefined });
      setEditingFriendlyName(false);
      dispatchToast(
        <Toast>
          <ToastTitle>Workspace friendly name saved</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      workspace.refresh();
    } catch (error) {
      setFriendlyNameError(error instanceof ApiClientError ? error.message : 'Failed to update the friendly name.');
    } finally {
      setFriendlyNameBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title="Users & Access" asOf={assignments.lastUpdated} refreshing={assignments.refreshing} onRefresh={() => assignments.refresh()} />

      <RoleGate allowed={['operator', 'admin']} fallback={<Text className={styles.resultMeta}>Granting desktop access requires the operator or admin role.</Text>}>
        <Card className={mergeClasses(cardStyles.card, styles.card)}>
          <CardHeader header={<Text as="h2" size={400} weight="semibold">Grant access</Text>} />
          {/* AM-31 item 25 — user e2e feedback: granting access here ONLY publishes the desktop (Desktop Virtualization User on the DAG); it does not by itself get a user signed in on this estate. */}
          <MessageBar intent="info">
            <MessageBarBody>
              Granting access here assigns Desktop Virtualization User on the desktop application group only, which publishes the desktop. On this estate, actually signing in also requires membership in the AVD-Users group (it carries Virtual Machine User Login and the FSLogix share role) — standard onboarding for a new user is adding them to AVD-Users, not just granting access here.
            </MessageBarBody>
          </MessageBar>
          <div className={styles.searchRow}>
            <Field label="Search users and groups" hint={`Type at least ${MIN_QUERY_LENGTH} characters of a name, email, or UPN.`} style={{ flex: '1 1 320px' }}>
              <Input
                value={query}
                onChange={(_event, data) => setQuery(data.value)}
                placeholder="e.g. Alice, or alice@contoso.example"
                aria-describedby="access-search-status"
              />
            </Field>
            {searchLoading && <Spinner size="tiny" label="Searching…" labelPosition="after" />}
          </div>

          <div id="access-search-status" aria-live="polite">
            {displaySearchError && (
              <MessageBar intent="error">
                <MessageBarBody>{displaySearchError}</MessageBarBody>
              </MessageBar>
            )}
            {!displaySearchError && resultsAreCurrent && searchResults && !searchGraphAvailable && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Graph permission not granted</MessageBarTitle>
                  Microsoft Graph search permissions have not been granted to this app yet — see docs/app-registration.md section 9. An admin can still grant access to a known principal ID directly with the Azure CLI in the meantime.
                </MessageBarBody>
              </MessageBar>
            )}
            {!displaySearchError && resultsAreCurrent && searchResults && searchGraphAvailable && searchResults.length === 0 && (
              <Text className={styles.resultMeta}>No users or groups matched "{trimmedQuery}".</Text>
            )}
            {!displaySearchError && resultsAreCurrent && searchResults && searchResults.length > 0 && (
              <>
                {searchTruncated && (
                  <MessageBar intent="info">
                    <MessageBarBody>More matches exist than are shown below — narrow your search to see the one you're looking for.</MessageBarBody>
                  </MessageBar>
                )}
                <div className={styles.resultsList} role="list" aria-label="Search results">
                  {searchResults.map((result) => (
                    <div key={result.id} className={styles.resultRow} role="listitem">
                      <div>
                        <Text block>{resultLabel(result)}</Text>
                        <Text size={200} className={styles.resultMeta}>
                          {result.principalType === 'user' ? 'User' : 'Group'}
                          {result.userPrincipalName ? ` · ${result.userPrincipalName}` : ''}
                        </Text>
                      </div>
                      {canAdminister ? (
                        <Button size="small" appearance="primary" onClick={() => setAssignTarget(result)} aria-label={`Grant desktop access to ${resultLabel(result)}`}>
                          Add
                        </Button>
                      ) : (
                        // AM-15 (M7) sweep: Tooltip cannot reliably hover/focus a
                        // genuinely DISABLED <Button> (disabled elements don't
                        // reliably receive pointer/focus events across browsers)
                        // — same fix already applied on Profiles.tsx's
                        // Restore/Delete buttons (see ROOT_FILE_EXPLANATION's doc
                        // comment there); the tooltip target is a wrapping <span>
                        // instead, not the disabled button itself.
                        <Tooltip content="Only admins can grant desktop access." relationship="label">
                          {/* Peer review MINOR fix: tabIndex={0} — a plain <span> isn't
                              natively focusable, so without this a keyboard-only user could
                              never reach (and thus never hear/see) this Tooltip's explanation,
                              even though a mouse user could hover it. */}
                          <span tabIndex={0}>
                            <Button size="small" appearance="primary" disabled aria-label={`Grant desktop access to ${resultLabel(result)} (admin role required)`}>
                              Add
                            </Button>
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Card>
      </RoleGate>

      <Card className={mergeClasses(cardStyles.card, styles.card)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Desktop access assignments</Text>} />
        <AsyncState
          loading={assignments.loading}
          error={assignments.error as Error | undefined}
          data={assignments.data}
          isEmpty={(data) => data.assignments.length === 0}
          emptyMessage="No one currently has desktop access assigned via this app."
        >
          {(data) => {
            // AM-31 item 38 — narrows the already-fetched list; does not
            // re-fetch or change `data.truncated`'s meaning (a truncated
            // server response can still be truncated even once a search
            // narrows what's SHOWN from it).
            const visibleAssignments = data.assignments.filter((assignment) => matchesAssignmentSearch(assignment, assignmentSearch));
            // Peer review (Opus, MINOR 3) — only a genuinely active search gets the narrower "No assignments match ..." description; an unfiltered empty table keeps `emptyMessage` instead.
            const hasActiveSearch = assignmentSearch.trim().length > 0;
            return (
            <>
              {!data.graphResolved && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Names unavailable</MessageBarTitle>
                    {data.graphDegradationReason === 'graph-permission-not-granted'
                      ? 'Microsoft Graph search permissions have not been granted to this app yet (see docs/app-registration.md section 9) — showing raw principal IDs below instead of names.'
                      : 'Microsoft Graph could not be reached — showing raw principal IDs below instead of names.'}
                  </MessageBarBody>
                </MessageBar>
              )}
              {data.truncated && (
                <MessageBar intent="info">
                  <MessageBarBody>This list was too large to show in full — some assignments may be missing below.</MessageBarBody>
                </MessageBar>
              )}
              <Field label="Search assignments" hint="Filters by name, UPN, or principal ID.">
                <Input ref={assignmentSearchRef} value={assignmentSearch} onChange={(_event, data2) => setAssignmentSearch(data2.value)} placeholder="Search…" />
              </Field>
              <DataTable
                ariaLabel="Desktop access assignments"
                columns={assignmentColumns}
                rows={visibleAssignments}
                getRowKey={(assignment) => assignment.roleAssignmentId}
                emptyMessage="No one currently has desktop access assigned via this app."
                activeFilterDescription={hasActiveSearch ? `No assignments match "${assignmentSearch}".` : undefined}
                rowActions={
                  canAdminister
                    ? (assignment) => {
                        const label = assignmentLabel(assignment);
                        return assignment.assignedDirectlyOnDag ? (
                          <Button size="small" appearance="secondary" onClick={() => setRemoveTargetId(assignment.roleAssignmentId)} aria-label={`Remove desktop access for ${label}`}>
                            Remove
                          </Button>
                        ) : (
                          // AM-14 peer review (fix 1, product choice b): an
                          // INHERITED assignment (atScope() surfaces
                          // parent-scope grants too — see DesktopAssignment's
                          // doc comment) cannot be removed from here at all —
                          // DELETE against it always 404s server-side (see
                          // accessAssignmentDelete.ts) — so the control is
                          // disabled with an explanation rather than left
                          // enabled to fail on click.
                          <Tooltip content={`${assignment.assignedVia} — remove at that scope instead.`} relationship="label">
                            <Button size="small" appearance="secondary" disabled aria-label={`Remove desktop access for ${label} (${assignment.assignedVia} — not removable here)`}>
                              Remove
                            </Button>
                          </Tooltip>
                        );
                      }
                    : undefined
                }
                rowActionsHeader="Actions"
              />
            </>
            );
          }}
        </AsyncState>
      </Card>

      <Card className={mergeClasses(cardStyles.card, styles.card)}>
        <CardHeader header={<Text as="h2" size={400} weight="semibold">Workspace friendly name</Text>} />
        <AsyncState loading={workspace.loading} error={workspace.error as Error | undefined} data={workspace.data} emptyMessage="Workspace not found.">
          {(data) =>
            editingFriendlyName ? (
              <div className={styles.friendlyNameRow}>
                <Field label="Friendly name" style={{ flex: '1 1 320px' }} validationState={friendlyNameError ? 'error' : undefined} validationMessage={friendlyNameError}>
                  <Input value={friendlyNameDraft} onChange={(_event, data2) => setFriendlyNameDraft(data2.value)} disabled={friendlyNameBusy} maxLength={64} />
                </Field>
                <Field label="Reason (optional)" style={{ flex: '1 1 320px' }}>
                  <Textarea value={friendlyNameReason} onChange={(_event, data2) => setFriendlyNameReason(data2.value)} disabled={friendlyNameBusy} placeholder="Why is this needed?" resize="vertical" maxLength={1000} />
                </Field>
                <Button appearance="primary" onClick={saveFriendlyName} disabled={friendlyNameBusy || friendlyNameDraft.trim().length === 0}>
                  {friendlyNameBusy ? 'Saving…' : 'Save'}
                </Button>
                <Button appearance="secondary" onClick={() => setEditingFriendlyName(false)} disabled={friendlyNameBusy}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className={styles.friendlyNameRow}>
                <Text>{data.friendlyName || 'Not set'}</Text>
                <RoleGate allowed={['operator', 'admin']}>
                  <Button size="small" appearance="secondary" onClick={startEditingFriendlyName}>
                    Edit
                  </Button>
                </RoleGate>
              </div>
            )
          }
        </AsyncState>
      </Card>

      {/* AM-29 item 30: access grant/remove is severity 'medium' — the typed display-name gate is dropped, a reason is still mandatory. */}
      {assignTarget && (
        <ConfirmModal
          title={`Grant desktop access to ${resultLabel(assignTarget)}?`}
          severity="medium"
          description="This grants the Desktop Virtualization User role on the desktop application group, letting this principal launch the published desktop."
          confirmLabel="Grant access"
          busy={assignBusy}
          error={assignError}
          onConfirm={confirmAssign}
          onCancel={() => {
            setAssignTarget(undefined);
            setAssignError(undefined);
          }}
        />
      )}

      {removeTargetId && removeTarget && (
        <ConfirmModal
          title={`Remove desktop access for ${assignmentLabel(removeTarget)}?`}
          severity="medium"
          description="This revokes the Desktop Virtualization User role on the desktop application group — this principal will no longer be able to launch the published desktop."
          confirmLabel="Remove access"
          busy={removeBusy}
          error={removeError}
          onConfirm={confirmRemove}
          onCancel={() => {
            setRemoveTargetId(undefined);
            setRemoveError(undefined);
          }}
        />
      )}
    </div>
  );
}
