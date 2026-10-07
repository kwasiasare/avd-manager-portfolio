import { describe, expect, it } from 'vitest';
import { evaluateDeleteLocks, type LockCheckTarget } from './deleteLocks';

const WORKSPACE: LockCheckTarget = { label: 'Workspace: Contoso-Desktop', resourceId: '/ws', expectLock: true };
const APP_GROUP: LockCheckTarget = { label: 'Application group: HP-CONTOSO-PROD-DAG', resourceId: '/ag', expectLock: true };
const HOST_POOL: LockCheckTarget = { label: 'Host pool: HP-CONTOSO-PROD', resourceId: '/hp', expectLock: false };

describe('evaluateDeleteLocks', () => {
  it('passes when workspace + DAG are locked and the host pool is intentionally unlocked (2026-08-16 correction — see gap register item 20)', () => {
    const result = evaluateDeleteLocks([
      { target: WORKSPACE, locks: [{ name: 'LOCK-CONTOSO-DESKTOP', properties: { level: 'CanNotDelete' } }] },
      { target: APP_GROUP, locks: [{ name: 'LOCK-HP-CONTOSO-PROD-DAG', properties: { level: 'CanNotDelete' } }] },
      { target: HOST_POOL, locks: [] },
    ]);
    expect(result.status).toBe('pass');
  });

  it('warns (not fails) when the host pool DOES carry a direct lock — the deliberately-removed LOCK-HP-CONTOSO-PROD case', () => {
    const result = evaluateDeleteLocks([
      { target: WORKSPACE, locks: [{ name: 'LOCK-CONTOSO-DESKTOP' }] },
      { target: APP_GROUP, locks: [{ name: 'LOCK-HP-CONTOSO-PROD-DAG' }] },
      { target: HOST_POOL, locks: [{ name: 'LOCK-HP-CONTOSO-PROD' }] },
    ]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('gap register item 20');
  });

  it('warns when the workspace or DAG is missing its expected lock', () => {
    const result = evaluateDeleteLocks([
      { target: WORKSPACE, locks: [] },
      { target: APP_GROUP, locks: [{ name: 'LOCK-HP-CONTOSO-PROD-DAG' }] },
      { target: HOST_POOL, locks: [] },
    ]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('missing its expected delete lock');
  });

  describe('RG-scope lock inheritance (peer review item 17)', () => {
    it('treats an RG-AVD-HostPools-scope lock as satisfying the workspace/DAG expectations even with no resource-level lock', () => {
      const result = evaluateDeleteLocks(
        [
          { target: WORKSPACE, locks: [] },
          { target: APP_GROUP, locks: [] },
          { target: HOST_POOL, locks: [] },
        ],
        [{ name: 'LOCK-RG-HOSTPOOLS', properties: { level: 'CanNotDelete' } }],
      );
      // Workspace/DAG are satisfied via inheritance, but the host pool is
      // ALSO now effectively locked via that same RG-scope lock — which is
      // exactly the unwanted state (a lock covering the host pool), so this
      // must warn, not pass.
      expect(result.status).toBe('warn');
      expect(result.summary).toContain('inherited from an RG-AVD-HostPools-scope lock');
    });

    it('does NOT warn about the host pool when only resource-level locks exist (no RG-scope lock)', () => {
      const result = evaluateDeleteLocks(
        [
          { target: WORKSPACE, locks: [{ name: 'LOCK-CONTOSO-DESKTOP' }] },
          { target: APP_GROUP, locks: [{ name: 'LOCK-HP-CONTOSO-PROD-DAG' }] },
          { target: HOST_POOL, locks: [] },
        ],
        [],
      );
      expect(result.status).toBe('pass');
    });
  });
});
