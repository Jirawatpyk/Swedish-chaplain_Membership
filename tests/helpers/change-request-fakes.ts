/**
 * F114 T026 — the shared in-memory test doubles for the change-request ports.
 *
 * One factory per port, every port method implemented (memory
 * `reference_unstubbed_port_method_is_an_unexercised_branch`: a missing
 * double lets the use case call `undefined` at runtime and the branch behind
 * it is never exercised). Unit tests from T029 on build their deps from
 * these; the same paths run on live Neon in `tests/integration/members/
 * change-requests-*.test.ts`.
 *
 * The in-memory repo reproduces the DB rules the use cases lean on:
 *   - the partial unique index (one `pending` row per submitter → `repo.conflict`
 *     `change_request_pending_exists`);
 *   - FOR UPDATE reads return the CURRENT row (no snapshot);
 *   - `decideInTx` / `withdrawInTx` refuse a non-pending row with `repo.not_found`
 *     the way a `WHERE state = 'pending'` UPDATE would (0 rows).
 */
import { vi, type MockedFunction } from 'vitest';
import { err, ok } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  ChangeRequestDraft,
  ChangeRequestListFilter,
  ChangeRequestListRow,
  ChangeRequestPage,
  ChangeRequestRepo,
} from '@/modules/members/application/ports/change-request-repo';
import type {
  Reviewer,
  ReviewerDirectoryPort,
} from '@/modules/members/application/ports/reviewer-directory-port';
import type { ChangeRequestScrubPort } from '@/modules/members/application/ports/change-request-scrub-port';
import type { TenantMemberChangeSettingsPort } from '@/modules/members/application/ports/tenant-member-change-settings-port';
import type { EmailEnqueue, EmailPort } from '@/modules/members/application/ports/email-port';
import type { AuditPort, F3AuditEvent } from '@/modules/members/application/ports/audit-port';
import type { ClockPort } from '@/modules/members/application/ports/clock-port';
import type { MemberChangeFlagPort } from '@/modules/members/application/use-cases/change-requests/resolve-member-change-gate';
import type {
  ChangeRequest,
  ChangeRequestId,
  ProposedField,
} from '@/modules/members/domain/change-request/change-request';
import { ERASED_SENTINEL } from '@/modules/members/domain/erasure-sentinels';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { TenantTx } from '@/lib/db';

export const FAKE_TX = { __tx: true } as never;

// ---------------------------------------------------------------------------
// ChangeRequestRepo
// ---------------------------------------------------------------------------

export interface InMemoryChangeRequestRepo extends ChangeRequestRepo {
  /** Every row, by id — inspect after a use case ran. */
  readonly rows: Map<string, ChangeRequest>;
  /** Optional display facts per member / user for the list projections. */
  readonly display: {
    members: Map<string, ChangeRequestListRow['member']>;
    users: Map<string, { displayName: string; deactivated: boolean }>;
  };
  /** Make the next call of a method fail (fault injection). */
  failNext(method: keyof ChangeRequestRepo, error?: FakeRepoFault): void;
}

/** The faults the in-memory repo can inject — incl. the unique-index race the real repo maps to `repo.conflict`. */
export type FakeRepoFault =
  | { code: 'repo.unexpected' | 'repo.not_found' }
  | { code: 'repo.conflict'; reason: 'change_request_pending_exists' };

export function makeInMemoryChangeRequestRepo(seed: readonly ChangeRequest[] = []): InMemoryChangeRequestRepo {
  const rows = new Map<string, ChangeRequest>(seed.map((r) => [r.id, r]));
  const display = {
    members: new Map<string, ChangeRequestListRow['member']>(),
    users: new Map<string, { displayName: string; deactivated: boolean }>(),
  };
  const faults = new Map<string, FakeRepoFault>();
  const takeFault = (method: string) => {
    const f = faults.get(method);
    if (f) faults.delete(method);
    return f;
  };
  const toRow = (r: ChangeRequest): ChangeRequestListRow => ({
    request: r,
    member: display.members.get(r.memberId) ?? {
      companyName: 'Fake Co',
      memberNumber: 1,
      status: 'active',
      archived: false,
    },
    submitter: { displayName: display.users.get(r.submittedByUserId)?.displayName ?? 'Submitter' },
    decidedBy:
      r.decidedByUserId === null
        ? null
        : (display.users.get(r.decidedByUserId) ?? { displayName: 'Reviewer', deactivated: false }),
  });
  const page = (
    items: ChangeRequest[],
    p: ChangeRequestPage,
  ): { items: ChangeRequestListRow[]; nextCursor: { submittedAt: Date; id: ChangeRequestId } | null } => {
    let start = 0;
    if (p.cursor) {
      const idx = items.findIndex((r) => r.id === p.cursor!.id);
      start = idx < 0 ? 0 : idx + 1;
    }
    const slice = items.slice(start, start + p.limit);
    const last = slice[slice.length - 1];
    const hasMore = start + p.limit < items.length;
    return {
      items: slice.map(toRow),
      nextCursor: hasMore && last ? { submittedAt: last.submittedAt, id: last.id } : null,
    };
  };

  return {
    rows,
    display,
    failNext(method, error = { code: 'repo.unexpected' }) {
      faults.set(method, error);
    },

    async insertInTx(_tx, draft: ChangeRequestDraft) {
      const f = takeFault('insertInTx');
      if (f) return err(f);
      for (const r of rows.values()) {
        if (r.submittedByUserId === draft.submittedByUserId && r.state === 'pending') {
          return err({ code: 'repo.conflict', reason: 'change_request_pending_exists' });
        }
      }
      const row: ChangeRequest = {
        id: draft.id,
        tenantId: draft.tenantId,
        memberId: draft.memberId,
        submittedByUserId: draft.submittedByUserId,
        submittedByContactId: draft.submittedByContactId,
        submitterRoleAtSubmission: draft.submitterRoleAtSubmission,
        scope: draft.scope,
        state: 'pending',
        outcome: null,
        withdrawnReason: null,
        replacedByRequestId: null,
        submittedAt: draft.submittedAt,
        staffNotifiedAt: draft.staffNotifiedAt,
        decidedAt: null,
        decidedByUserId: null,
        decisionReason: null,
        decisionNote: null,
        withdrawnAt: null,
        outcomeAcknowledgedAt: null,
        fields: draft.fields.map((fld): ProposedField => ({ ...fld, outcome: null, appliedAt: null })),
      };
      rows.set(row.id, row);
      return ok(row);
    },

    async findByIdInTx(_tx, id) {
      const f = takeFault('findByIdInTx');
      if (f) return err(f);
      const row = rows.get(id);
      return row ? ok(row) : err({ code: 'repo.not_found' });
    },

    async findById(_ctx, id) {
      const f = takeFault('findById');
      if (f) return err(f);
      const row = rows.get(id);
      return row ? ok(row) : err({ code: 'repo.not_found' });
    },

    async findListRowById(_ctx, id) {
      const f = takeFault('findListRowById');
      if (f) return err(f);
      const row = rows.get(id);
      return row ? ok(toRow(row)) : err({ code: 'repo.not_found' });
    },

    async findPendingBySubmitterInTx(_tx, userId) {
      const f = takeFault('findPendingBySubmitterInTx');
      if (f) return err(f);
      for (const r of rows.values()) {
        if (r.submittedByUserId === userId && r.state === 'pending') return ok(r);
      }
      return ok(null);
    },

    async withdrawInTx(_tx, id, input) {
      const f = takeFault('withdrawInTx');
      if (f) return err(f);
      const row = rows.get(id);
      if (!row || row.state !== 'pending') return err({ code: 'repo.not_found' });
      const next: ChangeRequest = {
        ...row,
        state: 'withdrawn',
        withdrawnReason: input.reason,
        withdrawnAt: input.withdrawnAt,
        replacedByRequestId: input.replacedByRequestId ?? null,
      };
      rows.set(id, next);
      return ok(next);
    },

    async decideInTx(_tx, id, decision) {
      const f = takeFault('decideInTx');
      if (f) return err(f);
      const row = rows.get(id);
      if (!row || row.state !== 'pending') return err({ code: 'repo.not_found' });
      const byKey = new Map(decision.fields.map((d) => [d.key, d]));
      const next: ChangeRequest = {
        ...row,
        state: 'decided',
        outcome: decision.outcome,
        decidedAt: decision.decidedAt,
        decidedByUserId: decision.decidedByUserId,
        decisionReason: decision.reason,
        decisionNote: decision.note,
        fields: row.fields.map((fld) => {
          const d = byKey.get(fld.key);
          return d ? { ...fld, outcome: d.outcome, appliedAt: d.appliedAt } : fld;
        }),
      };
      rows.set(id, next);
      return ok(next);
    },

    async acknowledgeInTx(_tx, id, at) {
      const f = takeFault('acknowledgeInTx');
      if (f) return err(f);
      const row = rows.get(id);
      if (!row) return err({ code: 'repo.not_found' });
      const next: ChangeRequest = { ...row, outcomeAcknowledgedAt: row.outcomeAcknowledgedAt ?? at };
      rows.set(id, next);
      return ok(next);
    },

    async countSubmittedSince(_tx, userId, since) {
      const f = takeFault('countSubmittedSince');
      if (f) return err(f);
      const mine = [...rows.values()].filter(
        (r) => r.submittedByUserId === userId && r.submittedAt.getTime() > since.getTime(),
      );
      const oldest = mine.reduce<Date | null>(
        (acc, r) => (acc === null || r.submittedAt < acc ? r.submittedAt : acc),
        null,
      );
      return ok({ count: mine.length, oldestSubmittedAt: oldest });
    },

    async listQueue(_ctx, filter: ChangeRequestListFilter, p) {
      const f = takeFault('listQueue');
      if (f) return err(f);
      const state = filter.state ?? 'pending';
      const items = [...rows.values()]
        .filter((r) => r.state === state)
        .filter((r) => (filter.outcome ? r.outcome === filter.outcome : true))
        .filter((r) => (filter.memberId ? r.memberId === filter.memberId : true))
        .filter((r) => (filter.submitterUserId ? r.submittedByUserId === filter.submitterUserId : true))
        .filter((r) => (filter.from ? r.submittedAt >= filter.from : true))
        .filter((r) => (filter.to ? r.submittedAt <= filter.to : true))
        .sort((a, b) =>
          state === 'pending'
            ? a.submittedAt.getTime() - b.submittedAt.getTime() || a.id.localeCompare(b.id)
            : b.submittedAt.getTime() - a.submittedAt.getTime() || b.id.localeCompare(a.id),
        );
      return ok(page(items, p));
    },

    async listByMember(_ctx, memberId, p) {
      const f = takeFault('listByMember');
      if (f) return err(f);
      const items = [...rows.values()]
        .filter((r) => r.memberId === memberId)
        .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime() || b.id.localeCompare(a.id));
      return ok(page(items, p));
    },

    async listVisibleToUser(_ctx, userId, memberId, p) {
      const f = takeFault('listVisibleToUser');
      if (f) return err(f);
      const items = [...rows.values()]
        .filter((r) => r.memberId === memberId)
        .filter((r) => r.submittedByUserId === userId || r.scope === 'company' || r.scope === 'mixed')
        .filter((r) => (p.state ? r.state === p.state : true))
        .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime() || b.id.localeCompare(a.id));
      return ok(page(items, p));
    },

    async pendingStats(_ctx) {
      const f = takeFault('pendingStats');
      if (f) return err(f);
      const pending = [...rows.values()].filter((r) => r.state === 'pending');
      const oldest = pending.reduce<Date | null>(
        (acc, r) => (acc === null || r.submittedAt < acc ? r.submittedAt : acc),
        null,
      );
      return ok({ count: pending.length, oldestSubmittedAt: oldest });
    },
  };
}

// ---------------------------------------------------------------------------
// ReviewerDirectoryPort
// ---------------------------------------------------------------------------

export function makeReviewers(n: number, locale: Reviewer['locale'] = 'en'): Reviewer[] {
  return Array.from({ length: n }, (_, i) => ({
    userId: `00000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, '0')}` as UserId,
    email: `reviewer${i + 1}@staff.example`,
    locale,
  }));
}

export interface ReviewerDirectoryFake extends ReviewerDirectoryPort {
  listReviewers: MockedFunction<ReviewerDirectoryPort['listReviewers']>;
}

export function makeReviewerDirectoryFake(reviewers: readonly Reviewer[] = makeReviewers(2)): ReviewerDirectoryFake {
  return { listReviewers: vi.fn(async () => reviewers) };
}

// ---------------------------------------------------------------------------
// EmailPort — captures every enqueue
// ---------------------------------------------------------------------------

export interface EmailPortFake extends EmailPort {
  readonly enqueued: EmailEnqueue[];
  enqueue: MockedFunction<EmailPort['enqueue']>;
  enqueueInTx: MockedFunction<EmailPort['enqueueInTx']>;
  /** Make the next enqueueInTx fail (fault injection). */
  failNext(): void;
}

export function makeEmailPortFake(): EmailPortFake {
  const enqueued: EmailEnqueue[] = [];
  let fail = false;
  let seq = 0;
  const enqueueImpl = async (_tx: TenantTx, _ctx: TenantContext, request: EmailEnqueue) => {
    if (fail) {
      fail = false;
      return err({ code: 'repo.unexpected' as const, cause: new Error('outbox insert failed') });
    }
    enqueued.push(request);
    seq += 1;
    return ok({ outboxRowId: `outbox-${seq}` });
  };
  return {
    enqueued,
    enqueue: vi.fn(async (ctx, request) => enqueueImpl(FAKE_TX, ctx, request)),
    enqueueInTx: vi.fn(enqueueImpl),
    failNext() {
      fail = true;
    },
  };
}

// ---------------------------------------------------------------------------
// AuditPort — captures every event
// ---------------------------------------------------------------------------

export interface AuditPortFake extends AuditPort {
  readonly events: F3AuditEvent[];
  record: MockedFunction<AuditPort['record']>;
  recordInTx: MockedFunction<AuditPort['recordInTx']>;
  /** Make the next recordInTx fail (fault injection — the atomicity tests). */
  failNext(): void;
}

export function makeAuditPortFake(): AuditPortFake {
  const events: F3AuditEvent[] = [];
  let fail = false;
  const recordImpl = async (_ctx: TenantContext, event: F3AuditEvent) => {
    if (fail) {
      fail = false;
      return err({ code: 'repo.unexpected' as const, cause: new Error('audit insert failed') });
    }
    events.push(event);
    return ok(undefined);
  };
  return {
    events,
    record: vi.fn(recordImpl),
    recordInTx: vi.fn(async (_tx, ctx, event) => recordImpl(ctx, event)),
    failNext() {
      fail = true;
    },
  };
}

// ---------------------------------------------------------------------------
// ClockPort, FlagPort, TenantMemberChangeSettingsPort, ScrubPort
// ---------------------------------------------------------------------------

export function makeClockFake(at: Date = new Date('2026-09-11T08:00:00Z')): ClockPort & { set(next: Date): void } {
  let now = at;
  return {
    now: () => now,
    set(next) {
      now = next;
    },
  };
}

export function makeFlagFake(on: boolean): MemberChangeFlagPort & { set(next: boolean): void } {
  let value = on;
  return {
    memberChangeApproval: () => value,
    set(next) {
      value = next;
    },
  };
}

export interface TenantMemberChangeSettingsFake extends TenantMemberChangeSettingsPort {
  /** `null` = no row for the tenant. */
  state: { enabled: boolean } | null;
  readInTenant: MockedFunction<TenantMemberChangeSettingsPort['readInTenant']>;
  setApprovalEnabledInTx: MockedFunction<TenantMemberChangeSettingsPort['setApprovalEnabledInTx']>;
}

export function makeTenantMemberChangeSettingsFake(initial: boolean | null): TenantMemberChangeSettingsFake {
  const fake: TenantMemberChangeSettingsFake = {
    state: initial === null ? null : { enabled: initial },
    readInTenant: vi.fn(async (_ctx: TenantContext) =>
      ok(fake.state === null ? null : { memberChangeApprovalEnabled: fake.state.enabled }),
    ),
    setApprovalEnabledInTx: vi.fn(async (_tx, _tenantId, enabled) => {
      const previous = fake.state?.enabled ?? false;
      fake.state = { enabled };
      return ok({ previous });
    }),
  };
  return fake;
}

export interface ChangeRequestScrubFake extends ChangeRequestScrubPort {
  scrubForMemberInTx: MockedFunction<ChangeRequestScrubPort['scrubForMemberInTx']>;
}

/** Scrubs the in-memory repo the way the Drizzle adapter scrubs the tables (R10). */
export function makeChangeRequestScrubFake(repo: InMemoryChangeRequestRepo): ChangeRequestScrubFake {
  return {
    scrubForMemberInTx: vi.fn(async (_tx, memberId, at) => {
      const scrubbed: ChangeRequestId[] = [];
      const closed: ChangeRequestId[] = [];
      for (const [id, row] of repo.rows) {
        if (row.memberId !== memberId) continue;
        const wasPending = row.state === 'pending';
        repo.rows.set(id, {
          ...row,
          state: wasPending ? 'withdrawn' : row.state,
          withdrawnReason: wasPending ? 'erasure' : row.withdrawnReason,
          withdrawnAt: wasPending ? at : row.withdrawnAt,
          decisionReason: row.decisionReason === null ? null : ERASED_SENTINEL,
          decisionNote: row.decisionNote === null ? null : ERASED_SENTINEL,
          fields: row.fields.map((f) => ({ ...f, seen: ERASED_SENTINEL, proposed: ERASED_SENTINEL })),
        });
        scrubbed.push(row.id);
        if (wasPending) closed.push(row.id);
      }
      return ok({ scrubbedRequestIds: scrubbed, closedRequestIds: closed });
    }),
  };
}
