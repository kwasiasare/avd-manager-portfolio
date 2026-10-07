import { describe, expect, it } from 'vitest';
import type { RolloutNewHost, RolloutOldHost, UserSession } from '@avdmgr/shared';
import {
  MAX_IMPACT_LINES,
  broadcastPreviewLines,
  emergencyOverridePreviewLines,
  forceLogoffPreviewLines,
  formatNameList,
  hostPowerPreviewLines,
  logoffAllDisconnectedPreviewLines,
  profileDeletePreviewLines,
  rollbackPreviewLines,
  rolloutRemoveHostsPreviewLines,
  scheduleDeletePreviewLines,
} from './impactPreview';

const NOW = new Date('2026-08-17T12:00:00.000Z');

function session(overrides: Partial<UserSession> = {}): Pick<UserSession, 'userPrincipalName' | 'sessionState' | 'createTime'> {
  return {
    userPrincipalName: 'alice@contoso.example',
    sessionState: 'Disconnected',
    createTime: '2026-08-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('formatNameList', () => {
  it('joins every name when at or under the max', () => {
    expect(formatNameList(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('folds names past the max into a "+N more" suffix', () => {
    expect(formatNameList(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e, +2 more');
  });

  it('respects a custom max', () => {
    expect(formatNameList(['a', 'b', 'c'], 2)).toBe('a, b, +1 more');
  });
});

describe('logoffAllDisconnectedPreviewLines (a)', () => {
  it('reports zero disconnected sessions', () => {
    const lines = logoffAllDisconnectedPreviewLines([session({ sessionState: 'Active' })], NOW);
    expect(lines).toEqual([{ text: 'No disconnected sessions right now.', tone: 'info' }]);
  });

  it('lists disconnected session UPNs and their count, with no warning when none are recent', () => {
    const sessions = [
      session({ userPrincipalName: 'alice@contoso.example', createTime: '2026-08-17T08:00:00.000Z' }),
      session({ userPrincipalName: 'bob@contoso.example', createTime: '2026-08-17T07:00:00.000Z' }),
    ];
    const lines = logoffAllDisconnectedPreviewLines(sessions, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ text: 'Will end 2 disconnected sessions (alice@contoso.example, bob@contoso.example).', tone: 'info' });
  });

  it('uses singular phrasing for exactly one disconnected session', () => {
    const lines = logoffAllDisconnectedPreviewLines([session({ createTime: '2026-08-17T08:00:00.000Z' })], NOW);
    expect(lines[0].text).toBe('Will end 1 disconnected session (alice@contoso.example).');
  });

  it('truncates the named list past MAX_LISTED_NAMES', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => session({ userPrincipalName: `u${i}@x.com`, createTime: '2026-08-17T08:00:00.000Z' }));
    const lines = logoffAllDisconnectedPreviewLines(sessions, NOW);
    expect(lines[0].text).toContain('+2 more');
  });

  it('adds a warning line for sessions disconnected less than 10 minutes ago', () => {
    const sessions = [
      session({ userPrincipalName: 'alice@contoso.example', createTime: '2026-08-17T11:55:00.000Z' }), // 5 min old
      session({ userPrincipalName: 'bob@contoso.example', createTime: '2026-08-17T08:00:00.000Z' }), // 4h old
    ];
    const lines = logoffAllDisconnectedPreviewLines(sessions, NOW);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      text: '1 session disconnected less than 10 minutes ago — may be an active user switching networks.',
      tone: 'warning',
    });
  });

  it('omits the warning line when every disconnected session is 10+ minutes old', () => {
    const lines = logoffAllDisconnectedPreviewLines([session({ createTime: '2026-08-17T08:00:00.000Z' })], NOW);
    expect(lines).toHaveLength(1);
  });

  it('does not warn on a session with an unparseable createTime', () => {
    const lines = logoffAllDisconnectedPreviewLines([session({ createTime: 'not-a-date' })], NOW);
    expect(lines).toHaveLength(1);
  });
});

describe('forceLogoffPreviewLines (b)', () => {
  it('names the user, the session state, and the host', () => {
    const lines = forceLogoffPreviewLines({ userPrincipalName: 'alice@contoso.example', sessionHostName: 'avd-con-0', sessionState: 'Active' });
    expect(lines).toEqual([{ text: "Ends alice@contoso.example's Active session on avd-con-0. Unsaved work may be lost.", tone: 'info' }]);
  });
});

describe('hostPowerPreviewLines (c)', () => {
  it('returns no lines for the non-disruptive start action', () => {
    expect(hostPowerPreviewLines({ name: 'avd-con-0', activeSessions: 3, allowNewSession: true }, 'start')).toEqual([]);
  });

  it('reports the session count and adds a drain-state warning when not draining with sessions present', () => {
    const lines = hostPowerPreviewLines({ name: 'avd-con-0', activeSessions: 3, allowNewSession: true }, 'restart');
    expect(lines).toEqual([
      { text: 'avd-con-0 currently has 3 sessions. Restarting disconnects all of them.', tone: 'info' },
      { text: 'avd-con-0 is NOT draining — consider draining first.', tone: 'warning' },
    ]);
  });

  it('omits the warning when the host is already draining (allowNewSession false)', () => {
    const lines = hostPowerPreviewLines({ name: 'avd-con-0', activeSessions: 3, allowNewSession: false }, 'deallocate');
    expect(lines).toHaveLength(1);
  });

  it('omits the warning when there are no sessions to protect', () => {
    const lines = hostPowerPreviewLines({ name: 'avd-con-0', activeSessions: 0, allowNewSession: true }, 'restart');
    expect(lines).toHaveLength(1);
  });

  it('uses singular phrasing for exactly one session', () => {
    const lines = hostPowerPreviewLines({ name: 'avd-con-0', activeSessions: 1, allowNewSession: false }, 'deallocate');
    expect(lines[0].text).toBe('avd-con-0 currently has 1 session. Deallocating disconnects all of them.');
  });
});

describe('emergencyOverridePreviewLines (d) — AM-33 peer review MAJOR 1: Shortens/Extends/neutral, driven by comparing minutes to minutesRemaining', () => {
  it('neutral wording when no active override state is known (minutesRemaining undefined) — e.g. the fresh-activate dialog', () => {
    const lines = emergencyOverridePreviewLines({ minutes: 60, now: NOW, phaseLabel: 'Peak' });
    expect(lines[0]).toEqual({ text: 'Sets the override to expire in 60 minutes (at 1:00 PM).', tone: 'info' });
    expect(lines[1]).toEqual({ text: 'Current phase Peak continues. Hosts are NOT changed.', tone: 'info' });
  });

  it('"Shortens" wording when the requested minutes is LESS than minutesRemaining', () => {
    const lines = emergencyOverridePreviewLines({ minutes: 15, now: NOW, phaseLabel: 'Peak', minutesRemaining: 200 });
    expect(lines[0].text).toBe('Shortens the override to 15 minutes (expires 12:15 PM).');
  });

  it('"Extends" wording when the requested minutes is MORE than minutesRemaining', () => {
    const lines = emergencyOverridePreviewLines({ minutes: 200, now: NOW, phaseLabel: 'Peak', minutesRemaining: 15 });
    expect(lines[0].text).toBe('Extends the override to 200 minutes (expires 3:20 PM).');
  });

  it('falls back to the neutral "Sets the override" wording when minutes equals minutesRemaining', () => {
    const lines = emergencyOverridePreviewLines({ minutes: 60, now: NOW, phaseLabel: 'Peak', minutesRemaining: 60 });
    expect(lines[0].text).toBe('Sets the override to expire in 60 minutes (at 1:00 PM).');
  });

  it('falls back to a phase-free line when phaseLabel is undefined', () => {
    const lines = emergencyOverridePreviewLines({ minutes: 15, now: NOW });
    expect(lines[1]).toEqual({ text: 'Hosts are NOT changed.', tone: 'info' });
  });

  it('returns no lines for a non-finite or non-positive minutes value', () => {
    expect(emergencyOverridePreviewLines({ minutes: NaN, now: NOW })).toEqual([]);
    expect(emergencyOverridePreviewLines({ minutes: 0, now: NOW })).toEqual([]);
  });
});

describe('scheduleDeletePreviewLines (e)', () => {
  it('reports full coverage when no days are left uncovered', () => {
    const lines = scheduleDeletePreviewLines('Weekends', []);
    expect(lines).toEqual([{ text: 'Removes the Weekends schedule. Every day it covered is still covered by at least one other schedule.', tone: 'info' }]);
  });

  it('warns with the uncovered days, singular phrasing for one day', () => {
    const lines = scheduleDeletePreviewLines('AllDays', ['Sunday']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ text: 'Removes the AllDays schedule. Days left uncovered: Sunday.', tone: 'warning' });
    expect(lines[1].text).toContain('session hosts on that day may be deallocated');
    expect(lines[1].text).toContain('unless another schedule covers it first');
  });

  it('warns with plural phrasing for multiple uncovered days', () => {
    const lines = scheduleDeletePreviewLines('AllDays', ['Saturday', 'Sunday']);
    expect(lines[0].text).toBe('Removes the AllDays schedule. Days left uncovered: Saturday, Sunday.');
    expect(lines[1].text).toContain('session hosts on those days may be deallocated');
    expect(lines[1].text).toContain('unless another schedule covers them first');
  });
});

describe('rolloutRemoveHostsPreviewLines (f)', () => {
  it('returns no lines for an empty selection', () => {
    expect(rolloutRemoveHostsPreviewLines([])).toEqual([]);
  });

  it('lists one warning line per host when at or under the cap', () => {
    const lines = rolloutRemoveHostsPreviewLines(['avd-con-0', 'avd-con-1']);
    expect(lines).toEqual([
      { text: 'Permanently deletes VM avd-con-0 (deregistered from the host pool).', tone: 'warning' },
      { text: 'Permanently deletes VM avd-con-1 (deregistered from the host pool).', tone: 'warning' },
    ]);
  });

  it('caps at MAX_IMPACT_LINES total lines, folding the remainder into a "+N more" line', () => {
    const hosts = Array.from({ length: MAX_IMPACT_LINES + 2 }, (_, i) => `avd-con-${i}`);
    const lines = rolloutRemoveHostsPreviewLines(hosts);
    expect(lines).toHaveLength(MAX_IMPACT_LINES);
    expect(lines.at(-1)!.text).toBe('+3 more hosts — same effect.');
  });
});

describe('profileDeletePreviewLines (g)', () => {
  it('names the user, size, and retired date, and clarifies the active profile is unaffected', () => {
    const lines = profileDeletePreviewLines({ userPrincipalName: 'alice@contoso.example', folderName: 'alice', sizeGb: 4.2, retiredAt: '2026-08-15T09:00:00.000Z' });
    expect(lines[0].text).toContain("Permanently deletes alice@contoso.example's retired VHD (4.2 GiB, retired 15 Aug).");
    expect(lines[1]).toEqual({ text: 'The active profile is not affected.', tone: 'info' });
  });

  it('falls back to the folder name when userPrincipalName is unknown, and omits the retired-date clause when retiredAt is missing', () => {
    const lines = profileDeletePreviewLines({ userPrincipalName: undefined, folderName: 'unresolved-folder', sizeGb: 1, retiredAt: undefined });
    expect(lines[0].text).toBe("Permanently deletes unresolved-folder's retired VHD (1 GiB).");
  });
});

describe('rollbackPreviewLines (h)', () => {
  function oldHost(status: RolloutOldHost['status']): Pick<RolloutOldHost, 'status'> {
    return { status };
  }
  function newHost(status: RolloutNewHost['status']): Pick<RolloutNewHost, 'status'> {
    return { status };
  }

  it('counts old hosts to un-drain and new hosts to drain', () => {
    const lines = rollbackPreviewLines([oldHost('draining'), oldHost('drained')], [newHost('available'), newHost('registered')]);
    expect(lines).toEqual([{ text: 'Will un-drain 2 old hosts, drain 2 new hosts.', tone: 'info' }]);
  });

  it('excludes already-removed old hosts from the un-drain count and flags them separately', () => {
    const lines = rollbackPreviewLines([oldHost('draining'), oldHost('removed'), oldHost('removed')], [newHost('available')]);
    expect(lines).toEqual([
      { text: 'Will un-drain 1 old host, drain 1 new host.', tone: 'info' },
      { text: '2 hosts already removed cannot be restored automatically.', tone: 'warning' },
    ]);
  });

  it('excludes new hosts still awaiting registration from the drain count', () => {
    const lines = rollbackPreviewLines([oldHost('drained')], [newHost('awaiting_registration'), newHost('validated')]);
    expect(lines[0].text).toBe('Will un-drain 1 old host, drain 1 new host.');
  });
});

describe('broadcastPreviewLines', () => {
  it('warns when there are no active sessions to reach', () => {
    expect(broadcastPreviewLines(0)).toEqual([{ text: 'There are currently no active sessions — this message would not reach anyone.', tone: 'warning' }]);
  });

  it('reports the active session count otherwise', () => {
    expect(broadcastPreviewLines(5)).toEqual([{ text: 'This will message 5 active sessions right now.', tone: 'info' }]);
  });

  it('uses singular phrasing for exactly one active session', () => {
    expect(broadcastPreviewLines(1)).toEqual([{ text: 'This will message 1 active session right now.', tone: 'info' }]);
  });
});
