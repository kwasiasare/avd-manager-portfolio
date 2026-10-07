import { describe, expect, it } from 'vitest';
import type { SessionHostProvisionParams } from '@avdmgr/shared';
import { deriveProvisionResourceNames, describeCleanupGuidance, generateSessionHostProvisionPlan, getPlanStep, SESSION_HOST_COMPUTER_NAME_MAX_LENGTH, type SessionHostProvisionPlanContext } from './sessionHostProvisionPlan';

const CONTEXT: SessionHostProvisionPlanContext = {
  subscriptionId: 'sub-1',
  resourceGroup: 'RG-AVD-HostPools',
  location: 'eastus',
  subnetId: '/subscriptions/sub-1/resourceGroups/RG-AVD-Network/providers/Microsoft.Network/virtualNetworks/VNET-CONTOSO-PROD/subnets/SNET-SESSIONHOSTS',
  galleryImageVersionId: '/subscriptions/sub-1/resourceGroups/RG-AVD-Images/providers/Microsoft.Compute/galleries/ACG_AVD_CONTOSO/images/WIN11-ENT-MS-M365/versions/2.2.0',
  vmSize: 'Standard_D4ads_v7',
  zone: '2',
  adminUsername: 'first',
  hostPoolName: 'HP-CONTOSO-PROD',
  hostPoolResourceId: '/subscriptions/sub-1/resourceGroups/RG-AVD-HostPools/providers/Microsoft.DesktopVirtualization/hostPools/HP-CONTOSO-PROD',
  dscModulesUrl: 'https://wvdportalstorageblob.blob.core.windows.net/galleryartifacts/Configuration_1.0.03483.1387.zip',
};

const PARAMS: SessionHostProvisionParams = { sessionHostName: 'avd-con-4', zone: '2', vmSize: 'Standard_D4ads_v7', imageVersion: '2.2.0' };

describe('deriveProvisionResourceNames', () => {
  it('VM name is the session host name verbatim; NIC name is NIC-prefixed', () => {
    expect(deriveProvisionResourceNames('avd-con-4')).toEqual({ vmName: 'avd-con-4', nicName: 'NIC-avd-con-4' });
  });
});

describe('generateSessionHostProvisionPlan — steps, in order', () => {
  const plan = generateSessionHostProvisionPlan(PARAMS, CONTEXT);

  it('carries the session host name and 6 steps in the documented order', () => {
    expect(plan.sessionHostName).toBe('avd-con-4');
    expect(plan.steps.map((s) => s.stepId)).toEqual(['create_nic', 'create_vm', 'ext_entra_join', 'ext_guest_attestation', 'ext_dsc', 'await_registration']);
  });

  it('create_nic: subnet id, dynamic private IP, NO NSG, NO public IP', () => {
    const step = getPlanStep(plan, 'create_nic');
    expect(step.resourceName).toBe('NIC-avd-con-4');
    const params = step.parameters as { ipConfigurations: Array<{ subnet: { id: string }; privateIPAllocationMethod: string }>; networkSecurityGroup?: unknown };
    expect(params.ipConfigurations[0].subnet.id).toBe(CONTEXT.subnetId);
    expect(params.ipConfigurations[0].privateIPAllocationMethod).toBe('Dynamic');
    expect(params.networkSecurityGroup).toBeUndefined();
    expect(JSON.stringify(step.parameters)).not.toContain('publicIPAddress');
  });

  it('create_vm: zone, gallery image version id (not a marketplace tuple), TrustedLaunch, Windows_Client, SystemAssigned identity, cm-resource-parent tag', () => {
    const step = getPlanStep(plan, 'create_vm');
    expect(step.resourceName).toBe('avd-con-4');
    const params = step.parameters as Record<string, unknown>;
    expect(params.zones).toEqual(['2']);
    expect((params.storageProfile as { imageReference: { id: string } }).imageReference.id).toBe(CONTEXT.galleryImageVersionId);
    expect((params.storageProfile as { imageReference?: { publisher?: string } }).imageReference.publisher).toBeUndefined();
    expect((params.storageProfile as { osDisk: { createOption: string; deleteOption: string; name?: string } }).osDisk.createOption).toBe('FromImage');
    expect((params.storageProfile as { osDisk: { deleteOption: string } }).osDisk.deleteOption).toBe('Detach');
    expect((params.storageProfile as { osDisk: { name?: string } }).osDisk.name).toBeUndefined(); // let Azure name the disk
    expect((params.osProfile as { computerName: string; adminUsername: string; adminPassword?: string }).computerName).toBe('avd-con-4');
    expect((params.osProfile as { adminPassword?: string }).adminPassword).toBeUndefined(); // never in the plan/preview
    expect((params.securityProfile as { securityType: string; uefiSettings: { secureBootEnabled: boolean; vTpmEnabled: boolean } }).securityType).toBe('TrustedLaunch');
    expect(params.licenseType).toBe('Windows_Client');
    expect(params.identity).toEqual({ type: 'SystemAssigned' });
    expect((params.tags as Record<string, string>)['cm-resource-parent']).toBe(CONTEXT.hostPoolResourceId);
    expect((params.networkProfile as { networkInterfaces: Array<{ id: string }> }).networkInterfaces[0].id).toContain('NIC-avd-con-4');
  });

  it('ext_entra_join: AADLoginForWindows, publisher/type/version/settings exactly as captured on the live estate', () => {
    const step = getPlanStep(plan, 'ext_entra_join');
    expect(step.resourceName).toBe('AADLoginForWindows');
    const params = step.parameters as Record<string, unknown>;
    expect(params.publisher).toBe('Microsoft.Azure.ActiveDirectory');
    expect(params.typePropertiesType).toBe('AADLoginForWindows');
    expect(params.typeHandlerVersion).toBe('2.0');
    expect(params.autoUpgradeMinorVersion).toBe(true);
    expect(params.settings).toEqual({ mdmId: '0000000a-0000-0000-c000-000000000000' });
  });

  it('ext_guest_attestation: GuestAttestation, publisher/type/version/settings exactly as captured', () => {
    const step = getPlanStep(plan, 'ext_guest_attestation');
    expect(step.resourceName).toBe('GuestAttestation');
    const params = step.parameters as Record<string, unknown>;
    expect(params.publisher).toBe('Microsoft.Azure.Security.WindowsAttestation');
    expect(params.typePropertiesType).toBe('GuestAttestation');
    expect(params.typeHandlerVersion).toBe('1.0');
    expect(params.settings).toEqual({
      AttestationConfig: {
        AscSettings: { ascReportingEndpoint: '', ascReportingFrequency: '' },
        MaaSettings: { maaEndpoint: '', maaTenantName: 'GuestAttestation' },
        disableAlerts: 'false',
        useCustomToken: 'false',
      },
    });
  });

  it('ext_dsc: DSC, modulesUrl/configurationFunction/properties, and a NEVER-a-real-token placeholder in protectedSettings', () => {
    const step = getPlanStep(plan, 'ext_dsc');
    expect(step.resourceName).toBe('Microsoft.PowerShell.DSC');
    const params = step.parameters as Record<string, unknown>;
    expect(params.publisher).toBe('Microsoft.Powershell');
    expect(params.typePropertiesType).toBe('DSC');
    expect(params.typeHandlerVersion).toBe('2.73');
    const settings = params.settings as { modulesUrl: string; configurationFunction: string; properties: Record<string, unknown> };
    expect(settings.modulesUrl).toBe(CONTEXT.dscModulesUrl);
    expect(settings.configurationFunction).toBe('Configuration.ps1\\AddSessionHost');
    expect(settings.properties).toEqual({ hostPoolName: 'HP-CONTOSO-PROD', aadJoin: true, UseAgentDownloadEndpoint: true, mdmId: '0000000a-0000-0000-c000-000000000000' });
    const protectedSettings = params.protectedSettings as { properties: { registrationInfoToken: string } };
    expect(protectedSettings.properties.registrationInfoToken).not.toMatch(/^[A-Za-z0-9+/=]{20,}$/); // not a plausible real token shape
    expect(protectedSettings.properties.registrationInfoToken).toBe('<generated-at-submit-time-never-persisted>');
  });

  it('await_registration: read-only poll, no ARM mutation', () => {
    const step = getPlanStep(plan, 'await_registration');
    expect(step.armCall).toContain('read-only poll');
    expect(step.parameters).toEqual({});
  });

  it('the plan, serialized whole, never contains a real token or password value anywhere', () => {
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('adminPassword');
    // only the documented placeholder string may appear for the token field.
    const tokenOccurrences = [...serialized.matchAll(/registrationInfoToken":"([^"]*)"/g)];
    expect(tokenOccurrences.length).toBeGreaterThan(0);
    for (const match of tokenOccurrences) {
      expect(match[1]).toBe('<generated-at-submit-time-never-persisted>');
    }
  });

  it('getPlanStep throws on a step id that does not exist in the plan (drift guard)', () => {
    // @ts-expect-error deliberately invalid stepId for the drift-guard test
    expect(() => getPlanStep(plan, 'not_a_real_step')).toThrow(/drift/);
  });
});

describe('SESSION_HOST_COMPUTER_NAME_MAX_LENGTH', () => {
  it('is 15 (Windows NetBIOS computer-name limit)', () => {
    expect(SESSION_HOST_COMPUTER_NAME_MAX_LENGTH).toBe(15);
  });
});

describe('describeCleanupGuidance', () => {
  const names = { vmName: 'avd-con-4', nicName: 'NIC-avd-con-4' };

  it('is empty for a cancel while still planned (nothing created yet)', () => {
    expect(describeCleanupGuidance('planned', names, 'RG-AVD-HostPools')).toBe('');
  });

  it('mentions the NIC (and never says anything was actually deleted) for a cancel at nic_creating', () => {
    const guidance = describeCleanupGuidance('nic_creating', names, 'RG-AVD-HostPools');
    expect(guidance).toContain('NIC-avd-con-4');
    expect(guidance).toContain('did not delete anything');
  });

  it('mentions both the VM and NIC (and never says anything was actually deleted) for a cancel at vm_creating or later', () => {
    for (const state of ['vm_creating', 'ext_entra_join', 'ext_guest_attestation', 'ext_dsc', 'awaiting_registration'] as const) {
      const guidance = describeCleanupGuidance(state, names, 'RG-AVD-HostPools');
      expect(guidance).toContain('avd-con-4');
      expect(guidance).toContain('NIC-avd-con-4');
      expect(guidance).toContain('did not delete anything');
    }
  });
});
