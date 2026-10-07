import { describe, expect, it, vi } from 'vitest';

const restListMock = vi.fn();
const restGetMock = vi.fn();

vi.mock('./restClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./restClient')>();
  return { ...actual, restList: restListMock, restGet: restGetMock };
});

describe('graphListAll', () => {
  it('builds the graph.microsoft.com/v1.0 URL, the Graph token scope, and uses @odata.nextLink for pagination', async () => {
    restListMock.mockResolvedValue({ items: [{ id: 'p1' }], truncated: false });
    const { graphListAll } = await import('./graphRest');
    const result = await graphListAll('/identity/conditionalAccess/policies');
    expect(restListMock).toHaveBeenCalledWith('https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies', 'https://graph.microsoft.com/.default', '@odata.nextLink');
    expect(result).toEqual({ items: [{ id: 'p1' }], truncated: false });
  });

  it('surfaces truncated:true from the underlying restList call', async () => {
    restListMock.mockResolvedValue({ items: [], truncated: true });
    const { graphListAll } = await import('./graphRest');
    const result = await graphListAll('/identity/conditionalAccess/policies');
    expect(result.truncated).toBe(true);
  });
});

describe('graphGet', () => {
  it('builds the graph.microsoft.com/v1.0 URL and the Graph token scope', async () => {
    restGetMock.mockResolvedValue({ id: 'u1', displayName: 'Some User' });
    const { graphGet } = await import('./graphRest');
    const result = await graphGet('/users/u1?$select=id,displayName');
    expect(restGetMock).toHaveBeenCalledWith('https://graph.microsoft.com/v1.0/users/u1?$select=id,displayName', 'https://graph.microsoft.com/.default');
    expect(result).toEqual({ id: 'u1', displayName: 'Some User' });
  });

  it('returns undefined on a 404 (restGet contract), never throwing', async () => {
    restGetMock.mockResolvedValue(undefined);
    const { graphGet } = await import('./graphRest');
    await expect(graphGet('/users/missing')).resolves.toBeUndefined();
  });
});
