import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from './auditLog';

// getClient() (auditLog.ts) constructs a real TableClient + DefaultAzureCredential
// when AUDIT_STORAGE_ACCOUNT_NAME is set — mocked here so "configured" tests
// don't need real Azure credentials/network, and so createEntity's
// success/failure can be controlled per test.
//
// listEntities/byPage/next simulates REAL Table Storage pagination (AM-32
// peer review MAJOR 4), not just a single next()-call-returns-everything
// stub: `listEntitiesImpl(filter)` is called ONCE per byPage() (i.e. once
// per PARTITION queried) and returns every row that partition/filter would
// ever match, however many `.next()` calls it takes to actually retrieve
// them — an internal cursor pages through that array, honoring the
// caller's requested `maxPageSize` AND (when a test sets it)
// `serviceInternalPageCap`, which simulates Table Storage's OWN internal
// per-request serving limit returning a SHORT page (with a continuation
// token, i.e. `done: false`) even though `maxPageSize` would have covered
// everything in one round trip — exactly the scenario the MAJOR 4 fix
// (loop `.next()` until `remaining`/`done`, not a single call) exists for.
// `odata` is the REAL implementation (vi.importActual) so filter-string
// assertions below exercise real escaping/quoting, not a stub.
const createEntity = vi.fn();
let listEntitiesImpl: (filter: string) => unknown[] = () => [];
let listEntitiesError: Error | null = null;
let serviceInternalPageCap: number | undefined;
const byPageCalls: Array<{ filter: string; maxPageSize: number | undefined }> = [];
vi.mock('@azure/data-tables', async () => {
  const actual = await vi.importActual<typeof import('@azure/data-tables')>('@azure/data-tables');
  return {
    odata: actual.odata,
    TableClient: class {
      createEntity(...args: unknown[]) {
        return createEntity(...args);
      }
      listEntities(options: { queryOptions?: { filter?: string } } = {}) {
        const filter = options.queryOptions?.filter ?? '';
        return {
          byPage: (settings: { maxPageSize?: number } = {}) => {
            byPageCalls.push({ filter, maxPageSize: settings.maxPageSize });
            const allItems = listEntitiesImpl(filter);
            let cursor = 0;
            return {
              next: async () => {
                if (listEntitiesError) throw listEntitiesError;
                const requested = settings.maxPageSize ?? allItems.length;
                const pageSize = serviceInternalPageCap !== undefined ? Math.min(requested, serviceInternalPageCap) : requested;
                const value = allItems.slice(cursor, cursor + Math.max(pageSize, 0));
                cursor += value.length;
                return { value, done: cursor >= allItems.length };
              },
            };
          },
        };
      }
    },
  };
});
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AUDIT_STORAGE_ACCOUNT_NAME;
  delete process.env.WEBSITE_SITE_NAME;
  process.env.AUDIT_TABLE_NAME = 'AuditLog';
  // Fields required by getConfig() unrelated to audit — same minimal set
  // used elsewhere so getConfig() doesn't throw on a missing required var.
  process.env.SUBSCRIPTION_ID = 'sub-id';
  process.env.RG_HOSTPOOLS = 'RG-AVD-HostPools';
  process.env.HOSTPOOL_NAME = 'HP-CONTOSO-PROD';
  createEntity.mockReset();
  listEntitiesImpl = () => [];
  listEntitiesError = null;
  serviceInternalPageCap = undefined;
  byPageCalls.length = 0;
  // auditLog.ts caches its TableClient at module scope (like avdService.ts's
  // getClient()) — reset the module between tests so each test's
  // AUDIT_STORAGE_ACCOUNT_NAME value is actually re-read, not stuck on
  // whatever the first test in the file resolved.
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

function makeLogger() {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    warn: (message: string) => warnings.push(message),
    error: (message: string) => errors.push(message),
    log: (message: string) => logs.push(message),
    warnings,
    errors,
    logs,
  };
}

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    actor: 'operator@example.com',
    actorId: 'entra-object-id-123',
    action: 'sessionhost.drain',
    target: 'HP-CONTOSO-PROD/avd-con-0',
    outcome: 'success',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('buildAuditEntity', () => {
  it('partitions by the UTC date (YYYY-MM-DD) of occurredAt', async () => {
    const { buildAuditEntity } = await import('./auditLog');
    const occurredAt = new Date('2026-08-15T14:30:00.000Z');
    expect(buildAuditEntity(event(), occurredAt).partitionKey).toBe('2026-08-15');
  });

  it('produces a RowKey that sorts newest-first under a plain ascending query', async () => {
    const { buildAuditEntity } = await import('./auditLog');
    const earlier = buildAuditEntity(event(), new Date('2026-08-15T10:00:00.000Z'));
    const later = buildAuditEntity(event(), new Date('2026-08-15T11:00:00.000Z'));
    expect(later.rowKey < earlier.rowKey).toBe(true);
  });

  it('carries actor/actorId/action/target/outcome/reason/detail/correlationId straight through', async () => {
    const { buildAuditEntity } = await import('./auditLog');
    const occurredAt = new Date('2026-08-15T14:30:00.000Z');
    const entity = buildAuditEntity(
      event({ reason: 'flaky FSLogix mount', detail: 'ARM 429', outcome: 'failure', correlationId: 'corr-abc' }),
      occurredAt,
    );

    expect(entity.actor).toBe('operator@example.com');
    expect(entity.actorId).toBe('entra-object-id-123');
    expect(entity.action).toBe('sessionhost.drain');
    expect(entity.target).toBe('HP-CONTOSO-PROD/avd-con-0');
    expect(entity.outcome).toBe('failure');
    expect(entity.reason).toBe('flaky FSLogix mount');
    expect(entity.detail).toBe('ARM 429');
    expect(entity.correlationId).toBe('corr-abc');
  });

  it('writes the occurrence time to occurredAt, NOT a property named timestamp (Azure Table Storage silently discards a `timestamp` property — it collides with the service-managed Timestamp system property)', async () => {
    const { buildAuditEntity } = await import('./auditLog');
    const occurredAt = new Date('2026-08-15T14:30:00.000Z');
    const entity = buildAuditEntity(event(), occurredAt);

    expect(entity.occurredAt).toBe(occurredAt.toISOString());
    expect(Object.prototype.hasOwnProperty.call(entity, 'timestamp')).toBe(false);
  });

  it('JSON-stringifies parameters into parametersJson (Table entities cannot hold nested objects)', async () => {
    const { buildAuditEntity } = await import('./auditLog');
    const entity = buildAuditEntity(event({ parameters: { allowNewSession: false } }));
    expect(entity.parametersJson).toBe(JSON.stringify({ allowNewSession: false }));
  });

  it('leaves parametersJson/reason/detail undefined when not supplied', async () => {
    const { buildAuditEntity } = await import('./auditLog');
    const entity = buildAuditEntity(event());
    expect(entity.parametersJson).toBeUndefined();
    expect(entity.reason).toBeUndefined();
    expect(entity.detail).toBeUndefined();
  });

  it('gives two entities built in the same millisecond distinct RowKeys', async () => {
    const { buildAuditEntity } = await import('./auditLog');
    const occurredAt = new Date('2026-08-15T14:30:00.000Z');
    expect(buildAuditEntity(event(), occurredAt).rowKey).not.toBe(buildAuditEntity(event(), occurredAt).rowKey);
  });
});

describe('isAuditRequiredButMissing — fail-closed posture', () => {
  it('is false when AUDIT_STORAGE_ACCOUNT_NAME is configured, regardless of WEBSITE_SITE_NAME', async () => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    const { isAuditRequiredButMissing } = await import('./auditLog');
    expect(isAuditRequiredButMissing()).toBe(false);
  });

  it('is false when unconfigured AND not running in Azure (local dev — no WEBSITE_SITE_NAME)', async () => {
    const { isAuditRequiredButMissing } = await import('./auditLog');
    expect(isAuditRequiredButMissing()).toBe(false);
  });

  it('is TRUE when unconfigured AND running in Azure (WEBSITE_SITE_NAME set) — the misconfigured-deployment case', async () => {
    process.env.WEBSITE_SITE_NAME = 'func-example-prod';
    const { isAuditRequiredButMissing } = await import('./auditLog');
    expect(isAuditRequiredButMissing()).toBe(true);
  });
});

describe('writeAuditEntry — AUDIT_STORAGE_ACCOUNT_NAME not configured (e.g. local dev)', () => {
  it('never throws, skips the Table write, logs why, but still emits the AUDIT_EVENT line', async () => {
    const { writeAuditEntry } = await import('./auditLog');
    const logger = makeLogger();

    await expect(writeAuditEntry(event(), logger)).resolves.toBeUndefined();
    expect(createEntity).not.toHaveBeenCalled();
    expect(logger.warnings.some((w) => w.includes('skipped') && w.includes('AUDIT_STORAGE_ACCOUNT_NAME'))).toBe(true);
    expect(logger.logs.some((l) => l.startsWith('AUDIT_EVENT ') && l.includes('"correlationId":"corr-1"'))).toBe(true);
  });
});

describe('writeAuditEntry — AUDIT_STORAGE_ACCOUNT_NAME configured', () => {
  beforeEach(() => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
  });

  it('writes the built entity via TableClient.createEntity on success, and emits the AUDIT_EVENT line', async () => {
    createEntity.mockResolvedValue(undefined);
    const { writeAuditEntry } = await import('./auditLog');
    const logger = makeLogger();

    await writeAuditEntry(event({ reason: 'scheduled maintenance', parameters: { allowNewSession: false } }), logger);

    expect(createEntity).toHaveBeenCalledTimes(1);
    const [entity] = createEntity.mock.calls[0];
    expect(entity).toMatchObject({
      actor: 'operator@example.com',
      actorId: 'entra-object-id-123',
      action: 'sessionhost.drain',
      target: 'HP-CONTOSO-PROD/avd-con-0',
      reason: 'scheduled maintenance',
      outcome: 'success',
      correlationId: 'corr-1',
      parametersJson: JSON.stringify({ allowNewSession: false }),
    });
    expect(entity.partitionKey).toBeDefined();
    expect(entity.rowKey).toBeDefined();
    expect(entity.occurredAt).toBeDefined();
    expect(entity).not.toHaveProperty('timestamp');
    expect(logger.warnings).toHaveLength(0);
    expect(logger.logs.some((l) => l.startsWith('AUDIT_EVENT '))).toBe(true);
  });

  it('the mutation-does-not-get-masked contract: a Table write failure is caught, logged via error() with the AUDIT_WRITE_FAILED marker, and NOT thrown', async () => {
    createEntity.mockRejectedValue(new Error('table unreachable'));
    const { writeAuditEntry } = await import('./auditLog');
    const logger = makeLogger();

    // This is the behavior mutating handlers depend on (see
    // app/api/src/functions/sessionHostDrain.ts): the drain call itself can
    // have already succeeded by the time this runs, so writeAuditEntry
    // rejecting here would incorrectly turn that success into a 5xx for the
    // caller. It must resolve, not reject.
    await expect(writeAuditEntry(event(), logger)).resolves.toBeUndefined();
    expect(logger.errors.some((e) => e.startsWith('AUDIT_WRITE_FAILED') && e.includes('corr-1') && e.includes('table unreachable'))).toBe(true);
    expect(logger.warnings).toHaveLength(0);
  });

  it('retries once on a 409 (EntityAlreadyExists / RowKey collision) with a fresh RowKey, and succeeds', async () => {
    const conflict = Object.assign(new Error('conflict'), { statusCode: 409 });
    createEntity.mockRejectedValueOnce(conflict).mockResolvedValueOnce(undefined);
    const { writeAuditEntry } = await import('./auditLog');
    const logger = makeLogger();

    await writeAuditEntry(event(), logger);

    expect(createEntity).toHaveBeenCalledTimes(2);
    const [firstEntity] = createEntity.mock.calls[0];
    const [secondEntity] = createEntity.mock.calls[1];
    expect(secondEntity.rowKey).not.toBe(firstEntity.rowKey);
    expect(logger.errors).toHaveLength(0);
  });

  it('logs AUDIT_WRITE_FAILED (not thrown) when the retry after a 409 ALSO fails', async () => {
    const conflict = Object.assign(new Error('conflict'), { statusCode: 409 });
    createEntity.mockRejectedValueOnce(conflict).mockRejectedValueOnce(new Error('still conflicting'));
    const { writeAuditEntry } = await import('./auditLog');
    const logger = makeLogger();

    await expect(writeAuditEntry(event(), logger)).resolves.toBeUndefined();
    expect(createEntity).toHaveBeenCalledTimes(2);
    expect(logger.errors.some((e) => e.startsWith('AUDIT_WRITE_FAILED'))).toBe(true);
  });
});

describe('queryRecentAuditEntries (AM-23) — AUDIT_STORAGE_ACCOUNT_NAME not configured', () => {
  it('returns [] without ever calling listEntities', async () => {
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    const result = await queryRecentAuditEntries('scalingplan.', 10, logger);
    expect(result).toEqual([]);
  });
});

describe('queryRecentAuditEntries (AM-23) — AUDIT_STORAGE_ACCOUNT_NAME configured', () => {
  beforeEach(() => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
  });

  function rowFor(occurredAt: string, action = 'scalingplan.schedule.update') {
    return { partitionKey: occurredAt.slice(0, 10), rowKey: 'x', action, target: 'SCALE-CONTOSO-PROD/AllDays', actor: 'op@example.com', actorId: 'id-1', outcome: 'success', occurredAt, correlationId: 'corr-1' };
  }

  it('returns rows from the current-day partition, filtered by the (odata-escaped) action prefix, when there are enough', async () => {
    const rows = [rowFor('2026-08-15T12:00:00.000Z'), rowFor('2026-08-15T11:00:00.000Z')];
    listEntitiesImpl = (filter: string) => {
      expect(filter).toContain("action ge 'scalingplan.'");
      expect(filter).toContain("action lt 'scalingplan.~'");
      return rows;
    };
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryRecentAuditEntries('scalingplan.', 10, logger, 1);
    expect(result).toEqual(rows);
  });

  it('quotes/escapes a value containing a single quote via odata (injection hygiene)', async () => {
    listEntitiesImpl = (filter: string) => {
      // A literal `'` in the interpolated value is doubled (OData's escape
      // convention), never left able to terminate the filter early.
      expect(filter).toContain("action ge 'weird''prefix.'");
      return [];
    };
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    await queryRecentAuditEntries("weird'prefix.", 10, logger, 1);
  });

  it('caps the page fetch at the still-needed count via byPage({maxPageSize}), not the SDK default (avoids a 1000-row page fetch to satisfy a 10-row ask)', async () => {
    listEntitiesImpl = () => [rowFor('2026-08-15T12:00:00.000Z')];
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    await queryRecentAuditEntries('scalingplan.', 7, logger, 1);

    expect(byPageCalls).toHaveLength(1);
    expect(byPageCalls[0].maxPageSize).toBe(7);
  });

  it('shrinks maxPageSize to only what is still needed once a previous day already contributed some rows', async () => {
    let callCount = 0;
    listEntitiesImpl = () => {
      callCount++;
      return callCount === 1 ? [rowFor('2026-08-15T12:00:00.000Z')] : [rowFor('2026-08-14T12:00:00.000Z'), rowFor('2026-08-14T09:00:00.000Z')];
    };
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    await queryRecentAuditEntries('scalingplan.', 10, logger, 5);

    expect(byPageCalls[0].maxPageSize).toBe(10);
    // Day 1 returned exactly 1 row, so day 2's page fetch only needs the
    // remaining 9 — not another full 10.
    expect(byPageCalls[1].maxPageSize).toBe(9);
  });

  it('stops paging once `limit` rows have been collected from a single day (page capped at the remaining count)', async () => {
    const allRows = Array.from({ length: 20 }, (_v, i) => rowFor(`2026-08-15T${String(10 + i).padStart(2, '0')}:00:00.000Z`));
    listEntitiesImpl = () => allRows;
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryRecentAuditEntries('scalingplan.', 3, logger, 1);
    // The mock's byPage caps the returned page at maxPageSize itself (see
    // the mock factory above), mirroring the real Table service's own
    // server-side $top behavior — so exactly 3 rows come back, not 20.
    expect(result).toHaveLength(3);
  });

  it('AM-32 peer review MAJOR 4 — follows a continuation token WITHIN one partition instead of treating a short first page as "this day is exhausted"', async () => {
    // The service hands back at most 2 rows per round trip regardless of
    // the requested maxPageSize (10) — simulating Table Storage's own
    // internal short-paging behavior — even though this ONE partition has
    // 5 matching rows, well within the still-needed 10. The OLD (buggy)
    // single-next()-call code would have taken only the first 2 and moved
    // on to the previous day, silently losing the other 3.
    serviceInternalPageCap = 2;
    const allRows = Array.from({ length: 5 }, (_v, i) => rowFor(`2026-08-15T${String(10 + i).padStart(2, '0')}:00:00.000Z`));
    listEntitiesImpl = () => allRows;
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryRecentAuditEntries('scalingplan.', 10, logger, 1);

    expect(result).toHaveLength(5);
    expect(result).toEqual(allRows);
    // Still only ONE partition (day) queried — the continuation pages are
    // additional `.next()` calls on the SAME byPage() iterator, not
    // additional byPage() calls (which would mean a second day was walked).
    expect(byPageCalls).toHaveLength(1);
  });

  it('falls back to a previous day when today has too few matching rows', async () => {
    let callCount = 0;
    listEntitiesImpl = () => {
      callCount++;
      if (callCount === 1) {
        return [rowFor('2026-08-15T12:00:00.000Z')]; // today: only 1 row
      }
      return [rowFor('2026-08-14T12:00:00.000Z'), rowFor('2026-08-14T09:00:00.000Z')];
    };
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryRecentAuditEntries('scalingplan.', 3, logger, 5);
    expect(result).toHaveLength(3);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('returns [] (not throw) and logs AUDIT_QUERY_FAILED when the query itself fails', async () => {
    listEntitiesError = new Error('table unreachable');
    const { queryRecentAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryRecentAuditEntries('scalingplan.', 10, logger, 1);
    expect(result).toEqual([]);
    expect(logger.errors.some((e) => e.startsWith('AUDIT_QUERY_FAILED'))).toBe(true);
  });
});

describe('queryAuditEntries (AM-32) — AUDIT_STORAGE_ACCOUNT_NAME not configured', () => {
  it('returns { entities: [], truncated: false, partial: false } without ever calling listEntities', async () => {
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    const result = await queryAuditEntries({ top: 25, sinceHours: 24 }, logger);
    expect(result).toEqual({ entities: [], truncated: false, partial: false });
  });
});

describe('queryAuditEntries (AM-32) — AUDIT_STORAGE_ACCOUNT_NAME configured', () => {
  beforeEach(() => {
    process.env.AUDIT_STORAGE_ACCOUNT_NAME = 'stavdmgrprodabc123';
  });

  function rowFor(occurredAt: string, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      partitionKey: occurredAt.slice(0, 10),
      rowKey: 'x',
      action: 'sessionhost.drain',
      target: 'HP-CONTOSO-PROD/avd-con-0',
      actor: 'op@example.com',
      actorId: 'id-1',
      outcome: 'success',
      occurredAt,
      correlationId: 'corr-1',
      ...overrides,
    };
  }

  it('always bounds the query with a RowKey le filter derived from the sinceHours cutoff, alongside PartitionKey', async () => {
    listEntitiesImpl = (filter: string) => {
      expect(filter).toContain('PartitionKey eq');
      expect(filter).toContain('RowKey le');
      return [];
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    await queryAuditEntries({ top: 25, sinceHours: 24 }, logger);
    expect(byPageCalls.length).toBeGreaterThan(0);
  });

  it('adds an action ge/lt prefix clause only when actionPrefix is supplied', async () => {
    listEntitiesImpl = (filter: string) => {
      expect(filter).toContain("action ge 'sessionhost.'");
      expect(filter).toContain("action lt 'sessionhost.~'");
      return [];
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    await queryAuditEntries({ top: 25, sinceHours: 24, actionPrefix: 'sessionhost.' }, logger);
  });

  it('omits any action clause when actionPrefix is not supplied', async () => {
    listEntitiesImpl = (filter: string) => {
      expect(filter).not.toContain('action ge');
      return [];
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    await queryAuditEntries({ top: 25, sinceHours: 24 }, logger);
  });

  it('adds an actor eq clause (odata-escaped) only when actor is supplied', async () => {
    listEntitiesImpl = (filter: string) => {
      expect(filter).toContain("actor eq 'op@example.com'");
      return [];
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    await queryAuditEntries({ top: 25, sinceHours: 24, actor: 'op@example.com' }, logger);
  });

  it('omits any actor clause when actor is not supplied', async () => {
    listEntitiesImpl = (filter: string) => {
      expect(filter).not.toContain('actor eq');
      return [];
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    await queryAuditEntries({ top: 25, sinceHours: 24 }, logger);
  });

  it('quotes/escapes a single quote in `actor` via odata (injection hygiene — peer review MINOR 8)', async () => {
    listEntitiesImpl = (filter: string) => {
      // A literal `'` in the interpolated value is doubled (OData's escape
      // convention), never left able to terminate the filter early — same
      // property queryRecentAuditEntries's own actionPrefix test already
      // covers, exercised here for `actor` specifically.
      expect(filter).toContain("actor eq 'o''brien'");
      return [];
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    await queryAuditEntries({ top: 25, sinceHours: 24, actor: "o'brien" }, logger);
  });

  it('caps the first page fetch at `top` via byPage({maxPageSize}), then shrinks to the still-needed remainder on later days', async () => {
    let callCount = 0;
    listEntitiesImpl = () => {
      callCount++;
      return callCount === 1 ? [rowFor('2026-08-15T12:00:00.000Z')] : [rowFor('2026-08-14T12:00:00.000Z'), rowFor('2026-08-14T09:00:00.000Z')];
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    await queryAuditEntries({ top: 10, sinceHours: 48 }, logger);

    // AM-32 peer review MINOR 20: the walk targets `top + 1` (11), not
    // `top` (10) — one extra row so `truncated` can be an EXACT signal
    // rather than a "happened to land exactly at the cap" guess. See
    // queryAuditEntries's own "PRECISE truncated" doc comment.
    expect(byPageCalls[0].maxPageSize).toBe(11);
    // Day 1 returned exactly 1 row, so day 2's page fetch only needs the
    // remaining 10 (11 - 1) — not another full 11.
    expect(byPageCalls[1].maxPageSize).toBe(10);
  });

  it('walks only as many days back as sinceHours can span (+1 for the partial-boundary day), not a fixed 30-day default', async () => {
    listEntitiesImpl = () => [];
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    // sinceHours=24 -> ceil(24/24)+1 = 2 days walked (today + yesterday).
    await queryAuditEntries({ top: 25, sinceHours: 24 }, logger);
    expect(byPageCalls).toHaveLength(2);
  });

  it('caps the day walk at 31 even for the maximum supported sinceHours (720 = 30 days)', async () => {
    listEntitiesImpl = () => [];
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    await queryAuditEntries({ top: 25, sinceHours: 720 }, logger);
    expect(byPageCalls).toHaveLength(31);
  });

  it('stops walking once `top` rows have been collected', async () => {
    const allRows = Array.from({ length: 20 }, (_v, i) => rowFor(`2026-08-15T${String(10 + i).padStart(2, '0')}:00:00.000Z`));
    listEntitiesImpl = () => allRows;
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryAuditEntries({ top: 3, sinceHours: 24 }, logger);
    expect(result.entities).toHaveLength(3);
    expect(byPageCalls).toHaveLength(1);
  });

  it('reports truncated:true when the `top` cap was hit before the sinceHours window was fully walked', async () => {
    listEntitiesImpl = () => [rowFor('2026-08-15T12:00:00.000Z'), rowFor('2026-08-15T11:00:00.000Z'), rowFor('2026-08-15T10:00:00.000Z')];
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryAuditEntries({ top: 3, sinceHours: 24 }, logger);
    expect(result.entities).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('reports truncated:false when fewer than `top` rows were found across the whole window', async () => {
    // sinceHours=24 walks 2 partitions (today + yesterday — see daysToWalk's
    // doc comment); only the FIRST (today's) call returns a row, so the
    // total across the whole window stays under `top`.
    let callCount = 0;
    listEntitiesImpl = () => {
      callCount++;
      return callCount === 1 ? [rowFor('2026-08-15T12:00:00.000Z')] : [];
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryAuditEntries({ top: 25, sinceHours: 24 }, logger);
    expect(result.entities).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it('AM-32 peer review MAJOR 3 — a query failure with NO rows collected yet still reports partial:true and truncated:true (not throw), and logs AUDIT_QUERY_FAILED', async () => {
    listEntitiesError = new Error('table unreachable');
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryAuditEntries({ top: 25, sinceHours: 24 }, logger);
    expect(result).toEqual({ entities: [], truncated: true, partial: true });
    expect(logger.errors.some((e) => e.startsWith('AUDIT_QUERY_FAILED'))).toBe(true);
  });

  it('AM-32 peer review MAJOR 3 — a MID-WALK failure (some rows already collected from an earlier day) still reports partial:true and truncated:true, and returns the partial rows rather than discarding them', async () => {
    let callCount = 0;
    listEntitiesImpl = () => {
      callCount++;
      if (callCount === 1) {
        return [rowFor('2026-08-15T12:00:00.000Z')]; // today: succeeds, 1 row
      }
      listEntitiesError = new Error('table unreachable on day 2'); // yesterday: fails
      throw listEntitiesError;
    };
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    const result = await queryAuditEntries({ top: 25, sinceHours: 48 }, logger);

    // The 1 row collected before the failure is still returned — a partial
    // read is not the same as a failed read (entities aren't discarded) —
    // but it must NOT read as a COMPLETE one: both flags say so.
    expect(result.entities).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.partial).toBe(true);
    expect(logger.errors.some((e) => e.startsWith('AUDIT_QUERY_FAILED'))).toBe(true);
  });

  it('sanitizes CR/LF out of actor/actionPrefix before they reach the AUDIT_QUERY_FAILED log line (log-forging hygiene — peer review MINOR 19)', async () => {
    listEntitiesError = new Error('table unreachable');
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    await queryAuditEntries({ top: 25, sinceHours: 24, actor: 'evil\r\nAUDIT_QUERY_FAILED | forged=true', actionPrefix: 'x\ninjected' }, logger);

    const failureLine = logger.errors.find((e) => e.startsWith('AUDIT_QUERY_FAILED'));
    expect(failureLine).toBeDefined();
    // Exactly one AUDIT_QUERY_FAILED-prefixed line was logged — a forged
    // second one embedded via \r\n would show up as an ADDITIONAL line/
    // entry the naive split-by-prefix check above would otherwise miss.
    expect(logger.errors.filter((e) => e.includes('AUDIT_QUERY_FAILED')).length).toBe(1);
    expect(failureLine).not.toContain('\n');
    expect(failureLine).not.toContain('\r');
  });

  it('AM-32 peer review MAJOR 7 — pins the EXACT RowKey le cutoff bound for a known instant, and proves a row older than the cutoff would be excluded by it', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-17T12:00:00.000Z');
    vi.setSystemTime(now);

    const sinceHours = 24;
    const cutoff = new Date(now.getTime() - sinceHours * 60 * 60 * 1000); // 2026-08-16T12:00:00.000Z
    const REVERSE_TICKS_CEILING = 9_999_999_999_999;
    const expectedReverseTicks = (REVERSE_TICKS_CEILING - cutoff.getTime()).toString().padStart(13, '0');
    const expectedBound = `${expectedReverseTicks}~`;

    function reverseTicksFor(occurredAtIso: string): string {
      return (REVERSE_TICKS_CEILING - new Date(occurredAtIso).getTime()).toString().padStart(13, '0');
    }

    const newerRow = rowFor(new Date(now.getTime() - 60 * 60 * 1000).toISOString()); // 1h ago — inside the window
    newerRow.rowKey = `${reverseTicksFor(newerRow.occurredAt)}-aaaaaaaa`;
    const olderRow = rowFor(new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString()); // 30h ago — outside the window
    olderRow.rowKey = `${reverseTicksFor(olderRow.occurredAt)}-bbbbbbbb`;

    listEntitiesImpl = (filter: string) => {
      // The EXACT filter clause a fixed "now" must produce — pinned, not
      // just "contains RowKey le something" (the earlier, looser test).
      expect(filter).toContain(`RowKey le '${expectedBound}'`);
      const rowKeyMatch = /RowKey le '([^']+)'/.exec(filter);
      const bound = rowKeyMatch?.[1] ?? '';
      const partitionKeyMatch = /PartitionKey eq '([^']+)'/.exec(filter);
      const partitionKey = partitionKeyMatch?.[1];
      // Production code has no CLIENT-side equivalent of either filter — it
      // relies entirely on the real Table service enforcing both
      // server-side (see queryAuditEntries's own doc comment). This mock
      // stands in for that server-side enforcement (PartitionKey exact
      // match + the RowKey bound) so the test can prove the bound VALUE
      // itself is correct: a real server given this exact filter would
      // return only rows whose RowKey sorts at-or-before it — the older
      // row is excluded regardless of which day's partition is queried,
      // since its own RowKey (derived from ITS occurredAt) sorts AFTER the
      // bound no matter what.
      return [newerRow, olderRow].filter((row) => row.partitionKey === partitionKey && row.rowKey <= bound);
    };

    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();
    const result = await queryAuditEntries({ top: 25, sinceHours }, logger);

    expect(result.entities.map((e) => e.rowKey)).toEqual([newerRow.rowKey]);
  });

  it('AM-32 peer review MINOR 9 — walks partitions newest-to-oldest (strictly DESCENDING calendar-date PartitionKey), never the other order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T12:00:00.000Z'));
    listEntitiesImpl = () => []; // never satisfies `top` — forces every day in the window to be walked
    const { queryAuditEntries } = await import('./auditLog');
    const logger = makeLogger();

    // sinceHours=72 spans multiple calendar dates -> daysToWalk = ceil(72/24)+1 = 4.
    await queryAuditEntries({ top: 25, sinceHours: 72 }, logger);

    const partitionKeys = byPageCalls.map((call) => /PartitionKey eq '([^']+)'/.exec(call.filter)?.[1]);
    expect(partitionKeys).toEqual(['2026-08-17', '2026-08-16', '2026-08-15', '2026-08-14']);
  });
});
