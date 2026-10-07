import { describe, expect, it } from 'vitest';
import type { UserSession } from '@avdmgr/shared';
import { matchesSearch, selectVisibleRows, toSessionRows } from './sessionRows';

function makeSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    id: 's1',
    sessionHostName: 'avd-con-0',
    sessionId: 1,
    userPrincipalName: 'alice@contoso.example',
    sessionState: 'Active',
    createTime: '2026-08-16T09:00:00.000Z',
    ...overrides,
  } as UserSession;
}

describe('matchesSearch (AM-31 item 38)', () => {
  it('matches on a case-insensitive substring of the UPN', () => {
    const row = { session: makeSession({ userPrincipalName: 'Alice@contoso.example' }), ageInfo: { ageMs: 0, tone: 'ok', reason: 'fresh' } } as const;
    expect(matchesSearch(row, 'alice')).toBe(true);
    expect(matchesSearch(row, 'ALICE@CONTOSO')).toBe(true);
    expect(matchesSearch(row, 'bob')).toBe(false);
  });

  it('matches on a case-insensitive substring of the host name', () => {
    const row = { session: makeSession({ sessionHostName: 'AVD-CON-3' }), ageInfo: { ageMs: 0, tone: 'ok', reason: 'fresh' } } as const;
    expect(matchesSearch(row, 'con-3')).toBe(true);
    expect(matchesSearch(row, 'con-9')).toBe(false);
  });

  it('an empty or whitespace-only query matches everything', () => {
    const row = { session: makeSession(), ageInfo: { ageMs: 0, tone: 'ok', reason: 'fresh' } } as const;
    expect(matchesSearch(row, '')).toBe(true);
    expect(matchesSearch(row, '   ')).toBe(true);
  });
});

describe('selectVisibleRows with search (AM-31 item 38)', () => {
  const rows = toSessionRows([
    makeSession({ id: 'a', userPrincipalName: 'alice@contoso.example', sessionHostName: 'avd-con-0', sessionState: 'Active' }),
    makeSession({ id: 'b', userPrincipalName: 'bob@contoso.example', sessionHostName: 'avd-con-1', sessionState: 'Disconnected' }),
    makeSession({ id: 'c', userPrincipalName: 'carol@contoso.example', sessionHostName: 'avd-con-0', sessionState: 'Active' }),
  ]);

  it('narrows by search alone', () => {
    const visible = selectVisibleRows(rows, 'All', undefined, 'ascending', 'alice');
    expect(visible.map((r) => r.session.id)).toEqual(['a']);
  });

  it('combines search AND the state filter', () => {
    // Both alice and carol are on avd-con-0, but only carol is Active AND matches "carol".
    const visible = selectVisibleRows(rows, 'Active', undefined, 'ascending', 'carol');
    expect(visible.map((r) => r.session.id)).toEqual(['c']);
  });

  it('a host-name search spans multiple users', () => {
    const visible = selectVisibleRows(rows, 'All', undefined, 'ascending', 'con-0');
    expect(visible.map((r) => r.session.id).sort()).toEqual(['a', 'c']);
  });

  it('defaults to no search narrowing when the argument is omitted (back-compat)', () => {
    const visible = selectVisibleRows(rows, 'All', undefined, 'ascending');
    expect(visible).toHaveLength(3);
  });
});
