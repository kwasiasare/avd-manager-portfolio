import { describe, expect, it } from 'vitest';
import { evaluateKeyVaultPurgeProtection } from './keyVaultPurgeProtection';

describe('evaluateKeyVaultPurgeProtection', () => {
  it('passes when purge protection is enabled — mirrors KV-AVD-CONTOSO\'s captured live state (the estate inventory §6)', () => {
    const result = evaluateKeyVaultPurgeProtection('KV-AVD-CONTOSO', { properties: { enablePurgeProtection: true, enableSoftDelete: true, softDeleteRetentionInDays: 90 } });
    expect(result.status).toBe('pass');
    expect(result.evidence).toMatchObject({ vaultName: 'KV-AVD-CONTOSO', enablePurgeProtection: true });
  });

  it('fails when purge protection is disabled but soft delete is enabled', () => {
    const result = evaluateKeyVaultPurgeProtection('KV-TEST', { properties: { enablePurgeProtection: false, enableSoftDelete: true } });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('NOT enabled');
  });

  it('fails harder-worded when both purge protection and soft delete are disabled', () => {
    const result = evaluateKeyVaultPurgeProtection('KV-TEST', { properties: { enablePurgeProtection: false, enableSoftDelete: false } });
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('immediate and unrecoverable');
  });

  it('fails when the vault is not found', () => {
    const result = evaluateKeyVaultPurgeProtection('KV-MISSING', undefined);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('not found');
  });
});
