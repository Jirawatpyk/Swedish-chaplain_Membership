/**
 * F9 US2 (T039) — `auditQuery` + `auditExport` use-case contract test.
 *
 * Pins the application contract with a fake `AuditEventSource` + spy
 * `InsightsAuditPort` + fake `ActorDirectory` (no DB): role gate, invalid range,
 * tampered cursor, keyset cursor round-trip + `nextCursor`, per-role payload
 * redaction, actor/target label resolution (incl. id fallback — never email),
 * the emit, the sync export cap (incl. exact boundary), and graceful degrade.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  auditQuery,
  auditExport,
  AUDIT_EXPORT_SYNC_CAP,
  type AuditQueryDeps,
} from '@/modules/insights/application/use-cases/audit-query';
import type {
  AuditEventSource,
  AuditSourceFilters,
  AuditSourceRow,
} from '@/modules/insights/application/ports/audit-source';
import type { InsightsAuditPort } from '@/modules/insights/application/ports/audit-port';
import type { ActorDirectory } from '@/modules/insights/application/ports/actor-directory';
import type { TenantContext } from '@/modules/tenants';

const ctx = { slug: 'swecham' } as unknown as TenantContext;

/** Fake directory: 'actor-1' → display name; 'actor-noname' → null name; rest absent. */
const fakeActorDirectory: ActorDirectory = {
  async labelsFor(ids) {
    const map = new Map<string, { displayName: string | null }>();
    if (ids.includes('actor-1')) map.set('actor-1', { displayName: 'Jane Admin' });
    if (ids.includes('actor-noname')) map.set('actor-noname', { displayName: null });
    return map;
  },
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function row(over: Partial<AuditSourceRow> = {}): AuditSourceRow {
  const occurredAt = over.occurredAt ?? new Date('2026-05-20T10:00:00.000Z');
  return {
    id: over.id ?? '00000000-0000-0000-0000-000000000001',
    eventType: over.eventType ?? 'role_changed',
    actorUserId: over.actorUserId ?? 'actor-1',
    targetUserId: over.targetUserId ?? null,
    summary: over.summary ?? 'role changed',
    occurredAt,
    occurredAtIso: over.occurredAtIso ?? occurredAt.toISOString(),
    requestId: over.requestId ?? 'req-1',
    payload: over.payload ?? { from: 'member', to: 'manager', reason: 'promoted' },
  };
}

function makeSource(rows: readonly AuditSourceRow[]): {
  source: AuditEventSource;
  calls: AuditSourceFilters[];
} {
  const calls: AuditSourceFilters[] = [];
  const source: AuditEventSource = {
    async query(_ctx, filters) {
      calls.push(filters);
      return rows.slice(0, filters.limit);
    },
  };
  return { source, calls };
}

function makeAudit(): { audit: InsightsAuditPort; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn().mockResolvedValue(undefined);
  const audit: InsightsAuditPort = { record, recordInTx: vi.fn().mockResolvedValue(undefined) };
  return { audit, record };
}

function deps(rows: readonly AuditSourceRow[]): AuditQueryDeps & { _record: ReturnType<typeof vi.fn>; _calls: AuditSourceFilters[] } {
  const { source, calls } = makeSource(rows);
  const { audit, record } = makeAudit();
  return { source, audit, actorDirectory: fakeActorDirectory, _record: record, _calls: calls };
}

const meta = (role: 'admin' | 'manager' | 'member') => ({
  actorUserId: 'actor-1',
  actorRole: role,
  requestId: 'req-1',
});

describe('auditQuery', () => {
  it('forbids members (staff-only viewer)', async () => {
    const res = await auditQuery({}, meta('member'), ctx, deps([]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
  });

  it('rejects an inverted date range as invalid_range', async () => {
    const res = await auditQuery(
      { from: '2026-05-20T00:00:00Z', to: '2026-05-10T00:00:00Z' },
      meta('admin'),
      ctx,
      deps([]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid_range');
  });

  it('rejects a malformed/tampered cursor as invalid_range (all decode-failure branches)', async () => {
    for (const bad of [
      'not-base64!!',
      Buffer.from('no-separator', 'utf8').toString('base64url'),
      Buffer.from('|missing-iso', 'utf8').toString('base64url'),
      Buffer.from('2026-05-20 10:00:00+00|', 'utf8').toString('base64url'), // empty id
      // N-01: decodable + non-empty halves but iso isn't timestamptz-shaped —
      // must be rejected BEFORE the DB `::timestamptz` cast (else 500, not 400).
      Buffer.from('not-a-timestamptz|550e8400-e29b-41d4-a716-446655440000', 'utf8').toString(
        'base64url',
      ),
    ]) {
      const res = await auditQuery({ cursor: bad }, meta('admin'), ctx, deps([row()]));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('invalid_range');
    }
  });

  it('admin sees the full payload; manager has the sensitive field redacted', async () => {
    const adminRes = await auditQuery({}, meta('admin'), ctx, deps([row()]));
    expect(adminRes.ok).toBe(true);
    if (adminRes.ok) {
      expect(adminRes.value.rows[0]!.payload).toHaveProperty('reason');
      expect(adminRes.value.rows[0]!.actorUserId).toBe('actor-1');
      expect(adminRes.value.rows[0]!.actorLabel).toBe('Jane Admin');
    }

    const mgrRes = await auditQuery({}, meta('manager'), ctx, deps([row()]));
    expect(mgrRes.ok).toBe(true);
    if (mgrRes.ok) {
      expect(mgrRes.value.rows[0]!.payload).not.toHaveProperty('reason');
      expect(mgrRes.value.rows[0]!.actorUserId).toBe('actor-1'); // identity NOT redacted
    }
  });

  it('falls back to the raw id (NEVER email) when no display name resolves', async () => {
    const res = await auditQuery({}, meta('admin'), ctx, deps([row({ actorUserId: 'actor-noname' })]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.rows[0]!.actorLabel).toBe('actor-noname');
  });

  it('renders a system:* sentinel actor verbatim (not resolved)', async () => {
    const res = await auditQuery({}, meta('admin'), ctx, deps([row({ actorUserId: 'system:cron' })]));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows[0]!.actorUserId).toBe('system:cron');
      expect(res.value.rows[0]!.actorLabel).toBe('system:cron');
    }
  });

  it('resolves a target user id to a label; leaves an unresolved/sentinel target as id/null', async () => {
    const res = await auditQuery(
      {},
      meta('admin'),
      ctx,
      deps([
        row({ id: 'a', targetUserId: 'actor-1' }), // resolvable
        row({ id: 'b', targetUserId: 'unknown-id' }), // unresolved → raw id
        row({ id: 'c', targetUserId: null }), // none
      ]),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows[0]!.targetLabel).toBe('Jane Admin');
      expect(res.value.rows[1]!.targetLabel).toBe('unknown-id');
      expect(res.value.rows[2]!.targetLabel).toBeNull();
    }
  });

  it('derives nextCursor when a full extra page-row exists, and clamps limit', async () => {
    const rows = [
      row({ id: 'a', occurredAt: new Date('2026-05-20T03:00:00Z') }),
      row({ id: 'b', occurredAt: new Date('2026-05-20T02:00:00Z') }),
      row({ id: 'c', occurredAt: new Date('2026-05-20T01:00:00Z') }),
    ];
    const d = deps(rows);
    const res = await auditQuery({ limit: 2 }, meta('admin'), ctx, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows).toHaveLength(2);
      expect(res.value.nextCursor).not.toBeNull();
      expect(d._calls[0]!.limit).toBe(3); // limit + 1
    }
  });

  it('clamps limit to [1,100] (0→1, huge→100, default 50)', async () => {
    const d0 = deps([row()]);
    await auditQuery({ limit: 0 }, meta('admin'), ctx, d0);
    expect(d0._calls[0]!.limit).toBe(2); // clamp to 1, + 1

    const dHuge = deps([row()]);
    await auditQuery({ limit: 100000 }, meta('admin'), ctx, dHuge);
    expect(dHuge._calls[0]!.limit).toBe(101); // clamp to 100, + 1

    const dDef = deps([row()]);
    await auditQuery({}, meta('admin'), ctx, dDef);
    expect(dDef._calls[0]!.limit).toBe(51); // default 50, + 1
  });

  it('returns an empty page (no rows, null cursor) + still emits with result_count 0', async () => {
    const d = deps([]);
    const res = await auditQuery({}, meta('admin'), ctx, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows).toHaveLength(0);
      expect(res.value.nextCursor).toBeNull();
    }
    expect(d._record.mock.calls[0]![0].payload.result_count).toBe(0);
  });

  it('returns null nextCursor when the page is the last one', async () => {
    const res = await auditQuery({ limit: 50 }, meta('admin'), ctx, deps([row({ id: 'a' })]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.nextCursor).toBeNull();
  });

  it('round-trips a cursor: nextCursor decodes back into the reader filters (full-precision iso)', async () => {
    const rows = [
      row({ id: 'a', occurredAtIso: '2026-05-20 03:00:00.123456+00' }),
      row({ id: 'b', occurredAtIso: '2026-05-20 02:00:00.000000+00' }),
    ];
    const first = await auditQuery({ limit: 1 }, meta('admin'), ctx, deps(rows));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.nextCursor!;
    expect(cursor).not.toBeNull();

    const d2 = deps(rows);
    await auditQuery({ limit: 1, cursor }, meta('admin'), ctx, d2);
    expect(d2._calls[0]!.cursor).toEqual({ iso: '2026-05-20 03:00:00.123456+00', id: 'a' });
  });

  it('emits audit_log_queried with applied filter NAMES + result_count', async () => {
    const d = deps([row()]);
    await auditQuery({ eventType: ['role_changed'], actorUserId: 'x', from: '2026-01-01', to: '2026-12-31' }, meta('admin'), ctx, d);
    expect(d._record).toHaveBeenCalledTimes(1);
    const event = d._record.mock.calls[0]![0];
    expect(event.eventType).toBe('audit_log_queried');
    expect(event.payload.applied_filters).toEqual(
      expect.arrayContaining(['eventType', 'actorUserId', 'from', 'to']),
    );
    expect(event.payload.result_count).toBe(1);
    expect(event.retentionYears).toBe(5);
  });

  it('never lets a best-effort audit-emit failure fail the read (FR-036)', async () => {
    const d = deps([row()]);
    d._record.mockRejectedValueOnce(new Error('audit down'));
    const res = await auditQuery({}, meta('admin'), ctx, d);
    expect(res.ok).toBe(true);
  });

  it('degrades to raw ids (does not fail) when identity resolution throws', async () => {
    const { source } = makeSource([row({ actorUserId: 'actor-1' })]);
    const failingDeps: AuditQueryDeps = {
      source,
      audit: makeAudit().audit,
      actorDirectory: { labelsFor: vi.fn().mockRejectedValue(new Error('users table down')) },
    };
    const res = await auditQuery({}, meta('admin'), ctx, failingDeps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.rows[0]!.actorLabel).toBe('actor-1'); // raw id fallback
  });

  void pad;
});

describe('auditExport', () => {
  it('forbids members', async () => {
    const res = await auditExport({}, meta('member'), ctx, deps([]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
  });

  it('rejects an inverted date range as invalid_range', async () => {
    const res = await auditExport(
      { from: '2026-05-20T00:00:00Z', to: '2026-05-10T00:00:00Z' },
      meta('admin'),
      ctx,
      deps([]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid_range');
  });

  it('exports the filtered set (redacted per role) and emits audit_log_exported (sync)', async () => {
    const d = deps([row({ id: 'a' }), row({ id: 'b' })]);
    const res = await auditExport({}, meta('manager'), ctx, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows).toHaveLength(2);
      expect(res.value.rows[0]!.payload).not.toHaveProperty('reason');
    }
    const event = d._record.mock.calls[0]![0];
    expect(event.eventType).toBe('audit_log_exported');
    expect(event.payload.delivery).toBe('sync');
    expect(event.payload.row_count).toBe(2);
  });

  it('succeeds at EXACTLY the sync cap (boundary — must NOT be too_large)', async () => {
    const exact = Array.from({ length: AUDIT_EXPORT_SYNC_CAP }, (_, i) => row({ id: `id-${i}` }));
    const res = await auditExport({}, meta('admin'), ctx, deps(exact));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.rows).toHaveLength(AUDIT_EXPORT_SYNC_CAP);
  });

  it('returns export_too_large when the filtered set exceeds the sync cap', async () => {
    const many = Array.from({ length: AUDIT_EXPORT_SYNC_CAP + 1 }, (_, i) => row({ id: `id-${i}` }));
    const res = await auditExport({}, meta('admin'), ctx, deps(many));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('export_too_large');
  });
});
