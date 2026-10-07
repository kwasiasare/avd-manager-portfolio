import { describe, expect, it } from 'vitest';
import type { ArmLock } from './deleteLocks';
import { evaluateStorageDeleteLocks } from './storageDeleteLocks';

const STORAGE_ACCOUNT_ID = '/subscriptions/sub-id/resourceGroups/RG-AVD-Storage/providers/Microsoft.Storage/storageAccounts/stcontoso001';
const EXPECTED_NAMES = ['LOCK-RG-AVD-Storage', 'Lock-stcontoso001', 'AzureBackupProtectionLock'];

function rgScopedLock(name: string): ArmLock {
  return { id: `/subscriptions/sub-id/resourceGroups/RG-AVD-Storage/providers/Microsoft.Authorization/locks/${name}`, name, properties: { level: 'CanNotDelete' } };
}

function resourceScopedLock(name: string): ArmLock {
  return { id: `${STORAGE_ACCOUNT_ID}/providers/Microsoft.Authorization/locks/${name}`, name, properties: { level: 'CanNotDelete' } };
}

describe('evaluateStorageDeleteLocks', () => {
  it('passes when all three documented locks are present at their expected scope', () => {
    const locks = [rgScopedLock('LOCK-RG-AVD-Storage'), resourceScopedLock('Lock-stcontoso001'), resourceScopedLock('AzureBackupProtectionLock')];
    const result = evaluateStorageDeleteLocks(EXPECTED_NAMES, locks, STORAGE_ACCOUNT_ID);
    expect(result.status).toBe('pass');
  });

  it('warns (never fails — operational hardening, not a security control) when one lock is missing entirely', () => {
    const locks = [rgScopedLock('LOCK-RG-AVD-Storage'), resourceScopedLock('Lock-stcontoso001')];
    const result = evaluateStorageDeleteLocks(EXPECTED_NAMES, locks, STORAGE_ACCOUNT_ID);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('AzureBackupProtectionLock');
    expect(result.summary).toContain('missing entirely');
  });

  it('warns when the RG-scope lock is instead applied at resource scope (wrong scope)', () => {
    const locks = [resourceScopedLock('LOCK-RG-AVD-Storage'), resourceScopedLock('Lock-stcontoso001'), resourceScopedLock('AzureBackupProtectionLock')];
    const result = evaluateStorageDeleteLocks(EXPECTED_NAMES, locks, STORAGE_ACCOUNT_ID);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('wrong scope');
    expect(result.summary).toContain('LOCK-RG-AVD-Storage');
  });

  it('warns when a resource-scoped lock is instead applied at RG scope (wrong scope)', () => {
    const locks = [rgScopedLock('LOCK-RG-AVD-Storage'), rgScopedLock('Lock-stcontoso001'), resourceScopedLock('AzureBackupProtectionLock')];
    const result = evaluateStorageDeleteLocks(EXPECTED_NAMES, locks, STORAGE_ACCOUNT_ID);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('Lock-stcontoso001');
  });

  it('matches lock names case-insensitively (the documented real-world casing variance)', () => {
    const locks = [rgScopedLock('lock-rg-avd-storage'), resourceScopedLock('LOCK-stcontoso001'), resourceScopedLock('azurebackupprotectionlock')];
    const result = evaluateStorageDeleteLocks(EXPECTED_NAMES, locks, STORAGE_ACCOUNT_ID);
    expect(result.status).toBe('pass');
  });

  it('warns on a 404-empty lock list (treated as empty, not thrown) — everything missing', () => {
    const result = evaluateStorageDeleteLocks(EXPECTED_NAMES, [], STORAGE_ACCOUNT_ID);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('missing entirely');
  });

  it('ignores a lock scoped to some OTHER resource in the same resource group', () => {
    const otherResourceLock: ArmLock = { id: '/subscriptions/sub-id/resourceGroups/RG-AVD-Storage/providers/Microsoft.Network/networkInterfaces/nic1/providers/Microsoft.Authorization/locks/AzureBackupProtectionLock', name: 'AzureBackupProtectionLock' };
    const locks = [rgScopedLock('LOCK-RG-AVD-Storage'), resourceScopedLock('Lock-stcontoso001'), otherResourceLock];
    const result = evaluateStorageDeleteLocks(EXPECTED_NAMES, locks, STORAGE_ACCOUNT_ID);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('AzureBackupProtectionLock');
  });
});
