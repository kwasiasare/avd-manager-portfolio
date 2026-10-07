import { describe, expect, it, vi } from 'vitest';

const restGetMock = vi.fn();
const restListMock = vi.fn();
const restPutMock = vi.fn();
const restDeleteMock = vi.fn();

vi.mock('./restClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./restClient')>();
  return { ...actual, restGet: restGetMock, restList: restListMock, restPut: restPutMock, restDelete: restDeleteMock };
});

describe('armGet', () => {
  it('builds the management.azure.com URL with the api-version query param and the ARM token scope', async () => {
    restGetMock.mockResolvedValue({ hello: 'world' });
    const { armGet } = await import('./armRest');
    const result = await armGet('/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.KeyVault/vaults/kv1', '2023-07-01');
    expect(restGetMock).toHaveBeenCalledWith(
      'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.KeyVault/vaults/kv1?api-version=2023-07-01',
      'https://management.azure.com/.default',
    );
    expect(result).toEqual({ hello: 'world' });
  });
});

describe('armList', () => {
  it('builds the URL and forwards options, using nextLink as the pagination field', async () => {
    restListMock.mockResolvedValue({ items: [{ id: 1 }], truncated: false });
    const { armList } = await import('./armRest');
    const result = await armList('/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/privateEndpoints', '2023-09-01', { treat404AsEmpty: true });
    expect(restListMock).toHaveBeenCalledWith(
      'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/privateEndpoints?api-version=2023-09-01',
      'https://management.azure.com/.default',
      'nextLink',
      { treat404AsEmpty: true },
    );
    expect(result).toEqual({ items: [{ id: 1 }], truncated: false });
  });

  it('defaults options to {} (404 throws) when the caller passes none', async () => {
    restListMock.mockResolvedValue({ items: [], truncated: false });
    const { armList } = await import('./armRest');
    await armList('/x', '2023-09-01');
    expect(restListMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'nextLink', {});
  });
});

describe('armListAtScope', () => {
  it('appends the $filter query parameter alongside api-version', async () => {
    restListMock.mockResolvedValue({ items: [], truncated: false });
    const { armListAtScope } = await import('./armRest');
    await armListAtScope('/subscriptions/sub1/.../applicationGroups/dag1/providers/Microsoft.Authorization/roleAssignments', '2022-04-01', 'atScope()');
    expect(restListMock).toHaveBeenCalledWith(
      'https://management.azure.com/subscriptions/sub1/.../applicationGroups/dag1/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()',
      'https://management.azure.com/.default',
      'nextLink',
    );
  });
});

describe('armPut', () => {
  it('builds the URL with api-version and forwards the body', async () => {
    restPutMock.mockResolvedValue({ name: 'assignment-guid' });
    const { armPut } = await import('./armRest');
    const result = await armPut('/subscriptions/sub1/.../roleAssignments/guid1', '2022-04-01', { properties: { principalId: 'p1' } });
    expect(restPutMock).toHaveBeenCalledWith(
      'https://management.azure.com/subscriptions/sub1/.../roleAssignments/guid1?api-version=2022-04-01',
      'https://management.azure.com/.default',
      { properties: { principalId: 'p1' } },
    );
    expect(result).toEqual({ name: 'assignment-guid' });
  });
});

describe('armDelete', () => {
  it('builds the URL with api-version', async () => {
    restDeleteMock.mockResolvedValue(undefined);
    const { armDelete } = await import('./armRest');
    await armDelete('/subscriptions/sub1/.../roleAssignments/guid1', '2022-04-01');
    expect(restDeleteMock).toHaveBeenCalledWith('https://management.azure.com/subscriptions/sub1/.../roleAssignments/guid1?api-version=2022-04-01', 'https://management.azure.com/.default');
  });
});
