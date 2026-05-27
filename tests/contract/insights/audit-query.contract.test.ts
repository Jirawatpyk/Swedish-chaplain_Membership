/**
 * F9 US2 (T039) — `auditQuery` + `auditExport` use-case contract test.
 *
 * Pins the application contract with a fake `AuditEventSource` + spy
 * `InsightsAuditPort` (no DB): role gate (member forbidden), invalid range,
 * keyset cursor + `nextCursor` derivation, per-role payload redaction, the
 * `audit_log_queried` / `audit_log_exported` emit, and the sync export cap.
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

/** Fake directory: maps the seed actor id to a name; everything else absent. */
const fakeActorDirectory: ActorDirectory = {
  async labelsFor(ids) {
    const map = new Map<string, { displayName: string | null; email: string }>();
    if (ids.includes('actor-1')) {
      map.set('actor-1', { displayName: 'Jane Admin', email: 'jane@swecham.test' });
    }
    return map;
  },
};

function row(over: Partial<AuditSourceRow> = {}): AuditSourceRow {
  return {
    id: over.id ?? '00000000-0000-0000-0000-000000000001',
    eventType: over.eventType ?? 'role_changed',
    actorUserId: over.actorUserId ?? 'actor-1',
    targetUserId: over.targetUserId ?? null,
    summary: over.summary ?? 'role changed',
    occurredAt: over.occurredAt ?? new Date('2026-05-20T10:00:00.000Z'),
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
  const audit: InsightsAuditPort = {
    record,
    recordInTx: vi.fn().mockResolvedValue(undefined),
  };
  return { audit, record };
}

const meta = (role: 'admin' | 'manager' | 'member') => ({
  actorUserId: 'actor-1',
  actorRole: role,
  requestId: 'req-1',
});

describe('auditQuery', () => {
  it('forbids members (staff-only viewer)', async () => {
    const { source } = makeSource([]);
    const { audit } = makeAudit();
    const deps: AuditQueryDeps = { source, audit, actorDirectory: fakeActorDirectory };
    const res = await auditQuery({}, meta('member'), ctx, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
  });

  it('rejects an inverted date range as invalid_range', async () => {
    const { source } = makeSource([]);
    const { audit } = makeAudit();
    const res = await auditQuery(
      { from: '2026-05-20T00:00:00Z', to: '2026-05-10T00:00:00Z' },
      meta('admin'),
      ctx,
      { source, audit, actorDirectory: fakeActorDirectory },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid_range');
  });

  it('admin sees the full payload; manager has the sensitive field redacted', async () => {
    const { source } = makeSource([row()]);
    const adminRes = await auditQuery({}, meta('admin'), ctx, {
      source,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(adminRes.ok).toBe(true);
    if (adminRes.ok) {
      expect(adminRes.value.rows[0]!.payload).toHaveProperty('reason');
      // Actor id resolved to a human-readable display name (FR-011 / UX).
      expect(adminRes.value.rows[0]!.actorUserId).toBe('actor-1');
      expect(adminRes.value.rows[0]!.actorLabel).toBe('Jane Admin');
    }

    const { source: source2 } = makeSource([row()]);
    const mgrRes = await auditQuery({}, meta('manager'), ctx, {
      source: source2,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(mgrRes.ok).toBe(true);
    if (mgrRes.ok) {
      expect(mgrRes.value.rows[0]!.payload).not.toHaveProperty('reason');
      // Actor identity is NEVER redacted (visible to managers, FR-011).
      expect(mgrRes.value.rows[0]!.actorUserId).toBe('actor-1');
    }
  });

  it('renders a system:* sentinel actor verbatim (not resolved)', async () => {
    const { source } = makeSource([row({ actorUserId: 'system:cron' })]);
    const res = await auditQuery({}, meta('admin'), ctx, {
      source,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows[0]!.actorUserId).toBe('system:cron');
      expect(res.value.rows[0]!.actorLabel).toBe('system:cron');
    }
  });

  it('derives nextCursor when a full extra page-row exists, and clamps limit', async () => {
    // 3 rows available, limit 2 → source asked for limit+1 (=3); hasMore=true.
    const rows = [
      row({ id: 'a', occurredAt: new Date('2026-05-20T03:00:00Z') }),
      row({ id: 'b', occurredAt: new Date('2026-05-20T02:00:00Z') }),
      row({ id: 'c', occurredAt: new Date('2026-05-20T01:00:00Z') }),
    ];
    const { source, calls } = makeSource(rows);
    const res = await auditQuery({ limit: 2 }, meta('admin'), ctx, {
      source,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows).toHaveLength(2); // capped to limit, extra row dropped
      expect(res.value.nextCursor).not.toBeNull();
      // The reader was asked for limit + 1 to detect the next page.
      expect(calls[0]!.limit).toBe(3);
    }
  });

  it('returns null nextCursor when the page is the last one', async () => {
    const { source } = makeSource([row({ id: 'a' })]);
    const res = await auditQuery({ limit: 50 }, meta('admin'), ctx, {
      source,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.nextCursor).toBeNull();
  });

  it('round-trips a cursor: nextCursor decodes back into the reader filters', async () => {
    const rows = [
      row({ id: 'a', occurredAt: new Date('2026-05-20T03:00:00Z') }),
      row({ id: 'b', occurredAt: new Date('2026-05-20T02:00:00Z') }),
    ];
    const { source } = makeSource(rows);
    const first = await auditQuery({ limit: 1 }, meta('admin'), ctx, {
      source,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.nextCursor!;
    expect(cursor).not.toBeNull();

    const { source: source2, calls } = makeSource(rows);
    const second = await auditQuery({ limit: 1, cursor }, meta('admin'), ctx, {
      source: source2,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(second.ok).toBe(true);
    expect(calls[0]!.cursor).toEqual({
      ts: new Date('2026-05-20T03:00:00Z').getTime(),
      id: 'a',
    });
  });

  it('emits audit_log_queried with applied filter NAMES + result_count', async () => {
    const { source } = makeSource([row()]);
    const { audit, record } = makeAudit();
    await auditQuery(
      { eventType: ['role_changed'], actorUserId: 'x' },
      meta('admin'),
      ctx,
      { source, audit, actorDirectory: fakeActorDirectory },
    );
    expect(record).toHaveBeenCalledTimes(1);
    const event = record.mock.calls[0]![0];
    expect(event.eventType).toBe('audit_log_queried');
    expect(event.payload.applied_filters).toEqual(
      expect.arrayContaining(['eventType', 'actorUserId']),
    );
    expect(event.payload.result_count).toBe(1);
    expect(event.retentionYears).toBe(5);
  });
});

describe('auditExport', () => {
  it('forbids members', async () => {
    const { source } = makeSource([]);
    const res = await auditExport({}, meta('member'), ctx, {
      source,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
  });

  it('exports the filtered set (redacted per role) and emits audit_log_exported (sync)', async () => {
    const { source } = makeSource([row({ id: 'a' }), row({ id: 'b' })]);
    const { audit, record } = makeAudit();
    const res = await auditExport({}, meta('manager'), ctx, { source, audit, actorDirectory: fakeActorDirectory });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows).toHaveLength(2);
      expect(res.value.rows[0]!.payload).not.toHaveProperty('reason'); // manager redaction
    }
    const event = record.mock.calls[0]![0];
    expect(event.eventType).toBe('audit_log_exported');
    expect(event.payload.delivery).toBe('sync');
    expect(event.payload.row_count).toBe(2);
  });

  it('returns export_too_large when the filtered set exceeds the sync cap', async () => {
    // cap + 1 rows available → overflow signalled (async fallback is US6).
    const many = Array.from({ length: AUDIT_EXPORT_SYNC_CAP + 1 }, (_, i) =>
      row({ id: `id-${i}` }),
    );
    const { source } = makeSource(many);
    const res = await auditExport({}, meta('admin'), ctx, {
      source,
      audit: makeAudit().audit,
      actorDirectory: fakeActorDirectory,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('export_too_large');
  });
});
