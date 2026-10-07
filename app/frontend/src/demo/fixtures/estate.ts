import type { HostPool, SettingsResponse, VmTemplateInfo } from '@avdmgr/shared';
import { DAY, ago, fakeGuid } from './time';

/**
 * AM-60 — the fictional "Contoso" estate every other fixture hangs off.
 * Everything here is invented: Contoso is Microsoft's reserved example
 * company, `.example` is an IANA-reserved TLD, and the GUIDs are
 * 00000000-0000-4000-8000-… placeholders.
 */
export const SUBSCRIPTION_ID = fakeGuid(1);
export const HOST_POOL_NAME = 'HP-CONTOSO-PROD';
export const WORKSPACE_NAME = 'WS-CONTOSO-PROD';
export const WORKSPACE_FRIENDLY_NAME = 'Contoso Desktop';
export const DAG_NAME = 'HP-CONTOSO-PROD-DAG';
export const GALLERY_NAME = 'ACG_AVD_CONTOSO';
export const IMAGE_DEFINITION = 'WIN11-ENT-M365';
export const STORAGE_ACCOUNT = 'stcontosoprofiles';
export const FSLOGIX_SHARE = 'fslogix-profiles';
export const TENANT_DOMAIN = 'contoso.example';

export const RG = {
  hostPools: 'RG-AVD-HostPools',
  images: 'RG-AVD-Images',
  storage: 'RG-AVD-Storage',
  network: 'RG-AVD-Network',
  management: 'RG-AVD-Management',
  security: 'RG-AVD-Security',
} as const;

export const armId = (resourceGroup: string, providerAndPath: string): string => `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${resourceGroup}/providers/${providerAndPath}`;

export const HOST_POOL_ARM_ID = armId(RG.hostPools, `Microsoft.DesktopVirtualization/hostPools/${HOST_POOL_NAME}`);

export const upn = (localPart: string): string => `${localPart}@${TENANT_DOMAIN}`;

export function buildHostPools(): HostPool[] {
  return [
    {
      id: HOST_POOL_ARM_ID,
      name: HOST_POOL_NAME,
      friendlyName: WORKSPACE_FRIENDLY_NAME,
      resourceGroup: RG.hostPools,
      hostPoolType: 'Pooled',
      loadBalancerType: 'BreadthFirst',
      preferredAppGroupType: 'Desktop',
      maxSessionLimit: 10,
      validationEnvironment: false,
      startVMOnConnect: true,
      ring: 1,
      customRdpProperty: 'targetisaadjoined:i:1;enablerdsaadauth:i:1;audiomode:i:0;redirectclipboard:i:1;',
      sessionHostCount: 6,
    },
  ] satisfies HostPool[];
}

export function buildSettings(now: number): SettingsResponse {
  return {
    apiVersion: '1.1.0',
    gitSha: 'demo-build',
    builtAt: ago(now, 3 * DAY),
    versionSource: 'app-setting',
    hostPoolName: HOST_POOL_NAME,
    workspaceName: WORKSPACE_NAME,
    dagName: DAG_NAME,
    storage: { accountName: STORAGE_ACCOUNT, fslogixShareName: FSLOGIX_SHARE },
    profilesOversizedGb: 20,
    groupIds: { viewer: 'configured', operator: 'configured', admin: 'configured' },
  } satisfies SettingsResponse;
}

export function buildVmTemplate(): VmTemplateInfo {
  return {
    parsed: true,
    imageType: 'Gallery',
    galleryImagePublisher: 'MicrosoftWindowsDesktop',
    galleryImageOffer: 'office-365',
    galleryImageSKU: 'win11-25h2-avd-m365',
    galleryImageVersion: 'latest',
    vmSizeId: 'Standard_D4ads_v7',
    osDiskType: 'Premium_LRS',
    namePrefix: 'avd-con',
    domain: '',
    ouPath: '',
    hibernate: false,
  } satisfies VmTemplateInfo;
}
