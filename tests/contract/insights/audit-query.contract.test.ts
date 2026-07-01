/**
 * F9 US2 (T039) — `auditQuery` + `auditExport` use-case contract test.
 *
 * Pins the application contract with a fake `AuditEventSource` + spy
 * `InsightsAuditPort` + fake `ActorDirectory` (no DB): role gate, invalid range,
 * tampered cursor, keyset cursor round-trip + `nextCursor`, BIDIRECTIONAL paging
 * (forward `prevCursor` derivation, the backward reverse-to-newest-first, the
 * hasMore-guarded `prevCursor`, dir=backward-without-cursor degrade, and the
 * empty-backward all-null edge), per-role payload redaction, actor/target label
 * resolution (incl. id fallback — never email), the emit, the sync export cap
 * (incl. exact boundary), and graceful degrade. The fake honours `limit` but not
 * the keyset SQL — backward gt+ASC ordering is pinned by the live integration test.
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

// `isResolvableActor` (9aad9ae0) only forwards UUID-SHAPED ids to the
// directory — sentinels / any non-UUID id render raw and never reach
// `inArray(users.id, …)`. Resolution fixtures must therefore be UUID-shaped.
const RESOLVABLE_ACTOR = '11111111-1111-4111-8111-111111111111';
const RESOLVABLE_ACTOR_NO_NAME = '22222222-2222-4222-8222-222222222222';
/** UUID-shaped but absent from the directory (e.g. a member id) → raw-id fallback. */
const UNRESOLVED_USER_ID = '33333333-3333-4333-8333-333333333333';

/** Fake directory: RESOLVABLE_ACTOR → display name; RESOLVABLE_ACTOR_NO_NAME → null name; rest absent. */
const fakeActorDirectory: ActorDirectory = {
  async labelsFor(ids) {
    const map = new Map<string, { displayName: string | null }>();
    if (ids.includes(RESOLVABLE_ACTOR)) map.set(RESOLVABLE_ACTOR, { displayName: 'Jane Admin' });
    if (ids.includes(RESOLVABLE_ACTOR_NO_NAME))
      map.set(RESOLVABLE_ACTOR_NO_NAME, { displayName: null });
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
    actorUserId: over.actorUserId ?? RESOLVABLE_ACTOR,
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

/**
 * A keyset-honouring fake reader (unlike `makeSource`, which trusts the caller
 * to pre-order): given ALL rows unordered, it applies the SAME cursor + direction
 * + ordering the Drizzle reader does, so a backward test pins that
 * `direction:'backward'` actually SELECTS newer-than-cursor rows in ASC order —
 * not just that the use-case reverses a pre-arranged fixture. `occurredAtIso` is
 * a same-format zero-padded timestamptz text, so a lexicographic compare is
 * chronological (µs-precision boundaries stay the integration test's job).
 */
function makeKeysetSource(allRows: readonly AuditSourceRow[]): {
  source: AuditEventSource;
  calls: AuditSourceFilters[];
} {
  const calls: AuditSourceFilters[] = [];
  const cmp = (a: { occurredAtIso: string; id: string }, b: { occurredAtIso: string; id: string }): number =>
    a.occurredAtIso !== b.occurredAtIso
      ? a.occurredAtIso < b.occurredAtIso
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;
  const source: AuditEventSource = {
    async query(_ctx, filters) {
      calls.push(filters);
      const backward = filters.direction === 'backward';
      const sorted = [...allRows].sort(cmp); // ASC by (ts, id)
      const ordered = backward ? sorted : [...sorted].reverse(); // forward → DESC
      const c = filters.cursor;
      const scoped = c
        ? ordered.filter((r) => {
            const t = cmp(r, { occurredAtIso: c.iso, id: c.id });
            return backward ? t > 0 : t < 0; // backward = newer (>), forward = older (<)
          })
        : ordered;
      return scoped.slice(0, filters.limit);
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

/** Like `deps`, but the source honours the keyset (cursor + direction + order). */
function keysetDeps(allRows: readonly AuditSourceRow[]): AuditQueryDeps & { _record: ReturnType<typeof vi.fn>; _calls: AuditSourceFilters[] } {
  const { source, calls } = makeKeysetSource(allRows);
  const { audit, record } = makeAudit();
  return { source, audit, actorDirectory: fakeActorDirectory, _record: record, _calls: calls };
}

const meta = (role: 'admin' | 'manager' | 'member') => ({
  actorUserId: RESOLVABLE_ACTOR,
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
      // N-01 (R3): VALID date prefix but invalid time SUFFIX — the prefix-only
      // guard let this reach the DB cast; the full-grammar guard must reject it.
      Buffer.from('2026-01-01 99:99:99+99|550e8400-e29b-41d4-a716-446655440000', 'utf8').toString(
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
      expect(adminRes.value.rows[0]!.actorUserId).toBe(RESOLVABLE_ACTOR);
      expect(adminRes.value.rows[0]!.actorLabel).toBe('Jane Admin');
    }

    const mgrRes = await auditQuery({}, meta('manager'), ctx, deps([row()]));
    expect(mgrRes.ok).toBe(true);
    if (mgrRes.ok) {
      expect(mgrRes.value.rows[0]!.payload).not.toHaveProperty('reason');
      expect(mgrRes.value.rows[0]!.actorUserId).toBe(RESOLVABLE_ACTOR); // identity NOT redacted
    }
  });

  it('falls back to the raw id (NEVER email) when the resolved user has no display name', async () => {
    const res = await auditQuery(
      {},
      meta('admin'),
      ctx,
      deps([row({ actorUserId: RESOLVABLE_ACTOR_NO_NAME })]),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.rows[0]!.actorLabel).toBe(RESOLVABLE_ACTOR_NO_NAME);
  });

  it('falls back to the raw id (NEVER email) on a directory MISS for a UUID-shaped actor', async () => {
    const res = await auditQuery(
      {},
      meta('admin'),
      ctx,
      deps([row({ actorUserId: UNRESOLVED_USER_ID })]),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.rows[0]!.actorLabel).toBe(UNRESOLVED_USER_ID);
  });

  it('renders sentinel / non-UUID actor ids verbatim — skipped, never sent to the directory (9aad9ae0)', async () => {
    // Incl. the bare 'system' that slipped the old startsWith('system:') check.
    for (const sentinel of ['system:cron', 'system:auto-retry', 'system', 'anonymous']) {
      const { source } = makeSource([row({ actorUserId: sentinel })]);
      const labelsFor = vi.fn(async () => new Map<string, { displayName: string | null }>());
      const res = await auditQuery({}, meta('admin'), ctx, {
        source,
        audit: makeAudit().audit,
        actorDirectory: { labelsFor },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.rows[0]!.actorUserId).toBe(sentinel);
        expect(res.value.rows[0]!.actorLabel).toBe(sentinel);
      }
      expect(labelsFor).not.toHaveBeenCalled(); // non-UUID never reaches inArray(users.id, …)
    }
  });

  it('resolves a target user id to a label; directory-miss UUID → raw id; non-UUID/absent → null', async () => {
    const res = await auditQuery(
      {},
      meta('admin'),
      ctx,
      deps([
        row({ id: 'a', targetUserId: RESOLVABLE_ACTOR }), // resolvable
        row({ id: 'b', targetUserId: UNRESOLVED_USER_ID }), // UUID-shaped miss (e.g. member id) → raw id
        row({ id: 'c', targetUserId: null }), // none
        row({ id: 'd', targetUserId: 'system:auto-retry' }), // non-UUID sentinel → null (9aad9ae0)
      ]),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows[0]!.targetLabel).toBe('Jane Admin');
      expect(res.value.rows[1]!.targetLabel).toBe(UNRESOLVED_USER_ID);
      expect(res.value.rows[2]!.targetLabel).toBeNull();
      expect(res.value.rows[3]!.targetLabel).toBeNull();
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
    // Actor MUST be UUID-shaped: a non-UUID id is filtered out before the
    // directory call, so the rejection would never fire (vacuous green).
    const { source } = makeSource([row({ actorUserId: RESOLVABLE_ACTOR })]);
    const labelsFor = vi.fn().mockRejectedValue(new Error('users table down'));
    const failingDeps: AuditQueryDeps = {
      source,
      audit: makeAudit().audit,
      actorDirectory: { labelsFor },
    };
    const res = await auditQuery({}, meta('admin'), ctx, failingDeps);
    expect(labelsFor).toHaveBeenCalledTimes(1); // the throw path was actually exercised
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.rows[0]!.actorLabel).toBe(RESOLVABLE_ACTOR); // raw id fallback
  });

  // --- bidirectional keyset (Previous page) --------------------------------

  /** Encode an `iso|id` keyset token the way the use-case does. */
  function tok(iso: string, id: string): string {
    return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
  }

  it('first page (no cursor) has no prevCursor', async () => {
    const res = await auditQuery({}, meta('admin'), ctx, deps([row()]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.prevCursor).toBeNull();
  });

  it('forward WITH a cursor derives a prevCursor (so a Previous link exists) + sends NO direction', async () => {
    const cursor = tok('2026-05-20 04:00:00.000000+00', 'z');
    const d = deps([row({ id: 'a' })]);
    const res = await auditQuery({ limit: 50, cursor }, meta('admin'), ctx, d);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.prevCursor).not.toBeNull();
    // Forward path passes NO direction to the source (older/DESC is the default).
    expect(d._calls[0]!.direction).toBeUndefined();
  });

  it('backward with NO more newer rows yields prevCursor null (no phantom "Newer" at the newest edge)', async () => {
    // Exactly `limit` newer rows exist → no extra row → hasMore false → the
    // backward prevCursor hasMore-guard must null it (else a dead "Newer" link).
    const ascNewer = [
      row({ id: 'p', occurredAt: new Date('2026-05-20T05:00:00Z'), occurredAtIso: '2026-05-20 05:00:00.000000+00' }),
      row({ id: 'q', occurredAt: new Date('2026-05-20T06:00:00Z'), occurredAtIso: '2026-05-20 06:00:00.000000+00' }),
    ];
    const cursor = tok('2026-05-20 04:00:00.000000+00', 'z');
    const res = await auditQuery({ limit: 2, cursor, direction: 'backward' }, meta('admin'), ctx, deps(ascNewer));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rows.map((r) => r.id)).toEqual(['q', 'p']); // reversed to newest-first
    expect(res.value.prevCursor).toBeNull(); // at the newest edge — no Previous
    expect(res.value.nextCursor).not.toBeNull(); // older rows still reachable
  });

  it('empty backward page (cursor at/past the newest row) → no rows, both cursors null', async () => {
    const cursor = tok('2026-05-20 09:00:00.000000+00', 'z');
    const res = await auditQuery({ limit: 50, cursor, direction: 'backward' }, meta('admin'), ctx, deps([]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rows).toHaveLength(0);
    expect(res.value.prevCursor).toBeNull();
    expect(res.value.nextCursor).toBeNull();
    // Recovery is the page's URL-derived "Latest" link (showFirst), not a cursor.
  });

  it('backward (Previous): passes direction, reverses the ASC page to newest-first, derives prevCursor', async () => {
    // The reader returns backward rows ASC (closest-newer first); 3 rows, limit 2.
    const ascNewer = [
      row({ id: 'p', occurredAt: new Date('2026-05-20T05:00:00Z'), occurredAtIso: '2026-05-20 05:00:00.000000+00' }),
      row({ id: 'q', occurredAt: new Date('2026-05-20T06:00:00Z'), occurredAtIso: '2026-05-20 06:00:00.000000+00' }),
      row({ id: 'r', occurredAt: new Date('2026-05-20T07:00:00Z'), occurredAtIso: '2026-05-20 07:00:00.000000+00' }), // extra → hasNewer
    ];
    const d = deps(ascNewer);
    const cursor = tok('2026-05-20 04:00:00.000000+00', 'z');
    const res = await auditQuery({ limit: 2, cursor, direction: 'backward' }, meta('admin'), ctx, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(d._calls[0]!.limit).toBe(3); // limit + 1
    expect(d._calls[0]!.direction).toBe('backward');
    // Reversed to newest-first display: q (06:00) before p (05:00); 'r' dropped.
    expect(res.value.rows.map((r) => r.id)).toEqual(['q', 'p']);
    // hasNewer (3 > 2) → Previous exists; older rows always exist → Next exists.
    expect(res.value.prevCursor).not.toBeNull();
    expect(res.value.nextCursor).not.toBeNull();
  });

  it('dir=backward WITHOUT a cursor degrades to the forward first page (no direction sent)', async () => {
    const d = deps([row()]);
    const res = await auditQuery({ direction: 'backward' }, meta('admin'), ctx, d);
    expect(res.ok).toBe(true);
    expect(d._calls[0]!.direction).toBeUndefined(); // forward — no backward scan without a cursor
    if (res.ok) expect(res.value.prevCursor).toBeNull();
  });

  it('backward keyset SELECTS newer-than-cursor rows (ASC) then reverses — keyset-honouring fake, multi-row', async () => {
    const all = [
      row({ id: 'o', occurredAtIso: '2026-05-20 01:00:00.000000+00', occurredAt: new Date('2026-05-20T01:00:00Z') }),
      row({ id: 'n1', occurredAtIso: '2026-05-20 05:00:00.000000+00', occurredAt: new Date('2026-05-20T05:00:00Z') }),
      row({ id: 'n2', occurredAtIso: '2026-05-20 06:00:00.000000+00', occurredAt: new Date('2026-05-20T06:00:00Z') }),
      row({ id: 'n3', occurredAtIso: '2026-05-20 07:00:00.000000+00', occurredAt: new Date('2026-05-20T07:00:00Z') }),
    ];
    const d = keysetDeps(all);
    const cursor = tok('2026-05-20 04:00:00.000000+00', 'z'); // between 'o' and 'n1'
    const res = await auditQuery({ limit: 2, cursor, direction: 'backward' }, meta('admin'), ctx, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // gt keyset picks n1,n2,n3 (ASC); closest 2 = n1,n2; reversed → n2,n1 (DESC).
    // The OLDER row 'o' is correctly EXCLUDED (proves direction drives selection).
    expect(res.value.rows.map((r) => r.id)).toEqual(['n2', 'n1']);
    expect(res.value.prevCursor).not.toBeNull(); // n3 remains → a Previous exists
    expect(res.value.nextCursor).not.toBeNull(); // 'o' remains → a Next exists
  });

  it('forward keyset selects OLDER-than-cursor rows (DESC) — keyset-honouring fake', async () => {
    const all = [
      row({ id: 'a', occurredAtIso: '2026-05-20 07:00:00.000000+00', occurredAt: new Date('2026-05-20T07:00:00Z') }),
      row({ id: 'b', occurredAtIso: '2026-05-20 06:00:00.000000+00', occurredAt: new Date('2026-05-20T06:00:00Z') }),
      row({ id: 'c', occurredAtIso: '2026-05-20 05:00:00.000000+00', occurredAt: new Date('2026-05-20T05:00:00Z') }),
    ];
    const cursor = tok('2026-05-20 06:30:00.000000+00', 'z'); // older than a; newer than b/c
    const res = await auditQuery({ limit: 50, cursor }, meta('admin'), ctx, keysetDeps(all));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.rows.map((r) => r.id)).toEqual(['b', 'c']); // 'a' excluded (newer)
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
