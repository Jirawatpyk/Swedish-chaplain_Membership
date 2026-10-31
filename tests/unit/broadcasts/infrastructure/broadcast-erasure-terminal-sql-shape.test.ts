/**
 * Spec 140 s1 — the SQL the Drizzle adapter sends for the two repo changes of
 * the slice. A fake repo cannot see either contract; both are in the statement.
 *
 * `listTerminalWithResendIdOwnedByMember` (ED1–ED3) — the erasure cascade's
 * list of the member's rows that are no longer in progress and not `sent`,
 * but still point at a Resend broadcast:
 *   - fenced on `tenant_id` AND the member (Principle I; the cross-tenant
 *     case is the integration file `erasure-terminal-drafts.test.ts`);
 *   - every status but the in-progress set and `sent` (`not in (...)` over
 *     the Domain's `IN_PROGRESS_BROADCAST_STATUSES` plus `sent`);
 *   - `resend_broadcast_id` neither NULL nor `''` (an empty id is not an id —
 *     the plan's "empty id | not listed" row).
 *
 * `attachResendIds` (ED5) — the write gains `status = 'approved'`, so a stale
 * attach on a row that left `approved` writes nothing (0 rows → the typed
 * concurrent-mutation throw every other CAS in the repo makes).
 *
 * Rendered by a real Drizzle instance over `pg-proxy`. What Postgres admits is
 * proven on live Neon in `tests/integration/broadcasts/erasure-terminal-drafts.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../helpers/tenant-sql-shape';

const TENANT = 'tenant-terminal-drafts';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[] }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  const db = drizzle(async (sqlText, params) => {
    rec.statements.push({ sql: sqlText, params });
    if (sqlText.includes("current_setting('app.current_tenant'")) {
      return { rows: [{ current_tenant: 'tenant-terminal-drafts' }] };
    }
    return { rows: [] };
  });
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db),
  };
});

const { makeDrizzleBroadcastsRepo } = await import('@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo');
const { asBroadcastId } = await import('@/modules/broadcasts/domain/broadcast');
const { BroadcastConcurrentMutationError } = await import('@/modules/broadcasts/application/ports/broadcasts-repo');
const { IN_PROGRESS_BROADCAST_STATUSES } = await import('@/modules/broadcasts/domain/stage/in-progress-statuses');
const { db } = await import('@/lib/db');

const MEMBER_ID = '5d0c6f6e-0000-4000-8000-0000000000aa';
const BROADCAST_ID = asBroadcastId('7f3c1a52-0000-4000-8000-0000000000e1');

const whereOf = (s: RecordedStatement): string => s.sql.slice(s.sql.search(/\bwhere\b/i));

describe('listTerminalWithResendIdOwnedByMember — SQL shape', () => {
  it('fences tenant + member; excludes the in-progress set and every sending-started status; requires a non-empty Resend id', async () => {
    rec.statements.length = 0;
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.listTerminalWithResendIdOwnedByMember(TENANT as never, MEMBER_ID as never)).resolves.toEqual([]);

    const select = rec.statements.find((s) => /^select\b[\s\S]*\bfrom "broadcasts"/i.test(s.sql));
    expect(select, 'no SELECT on broadcasts was sent').toBeDefined();
    const where = whereOf(select!);
    expect(where).toMatch(/"broadcasts"\."tenant_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."requested_by_member_id"\s*=\s*\$\d+/);
    expect(select!.params).toEqual(expect.arrayContaining([TENANT, MEMBER_ID]));
    // The excluded statuses: every in-progress one, and `sent` — bound, not inlined.
    expect(where).toMatch(/"broadcasts"\."status"::text not in \(/i);
    // Review round 2 (pdpa N-1) — and every status only reachable after a
    // handed send: an old delivery is not erasure evidence, and its DELETE can
    // only answer 403.
    for (const status of [...IN_PROGRESS_BROADCAST_STATUSES, 'sent', 'sending', 'partially_sent', 'partial_delivery_accepted']) {
      expect(select!.params, `${status} is not excluded`).toContain(status);
    }
    // Nothing else is excluded: `failed_to_dispatch`, `cancelled`, `rejected`, `draft` … are listed.
    for (const status of ['failed_to_dispatch', 'cancelled', 'rejected', 'draft', 'expired_no_member_response']) {
      expect(select!.params, `${status} must not be excluded`).not.toContain(status);
    }
    expect(where).toMatch(/"broadcasts"\."resend_broadcast_id" is not null/i);
    expect(where).toMatch(/"broadcasts"\."resend_broadcast_id"\s*<>\s*\$\d+/);
    expect(select!.params).toContain('');
  });

  // Review round 1 (code-review #8) — the pass needs three columns, so it reads
  // three: never the erased member's (pre-scrub or redacted) content.
  it('projects only broadcast_id, status and resend_broadcast_id', async () => {
    rec.statements.length = 0;
    await makeDrizzleBroadcastsRepo(TENANT).listTerminalWithResendIdOwnedByMember(TENANT as never, MEMBER_ID as never);
    const select = rec.statements.find((s) => /^select\b[\s\S]*\bfrom "broadcasts"/i.test(s.sql))!;
    const columns = select.sql.slice(0, select.sql.search(/\bfrom\b/i));
    expect(columns).toMatch(/"broadcast_id"/);
    expect(columns).toMatch(/"status"/);
    expect(columns).toMatch(/"resend_broadcast_id"/);
    for (const col of ['subject', 'body_html', 'from_name', 'reply_to_email', 'tenant_id', 'requested_by_member_id']) {
      expect(columns, `${col} must not be read`).not.toMatch(new RegExp(`"${col}"`));
    }
  });
});

describe('attachResendIds — SQL shape (ED5)', () => {
  it("the UPDATE carries status = 'approved' beside the tenant and the id", async () => {
    rec.statements.length = 0;
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    // 0 rows matched (the recording db returns none) → the typed concurrent throw.
    await expect(
      repo.attachResendIds(db as never, TENANT as never, BROADCAST_ID, 'aud-1', 'rb-1'),
    ).rejects.toBeInstanceOf(Error);

    const update = rec.statements.find((s) => /^update "broadcasts"/i.test(s.sql));
    expect(update, 'no UPDATE on broadcasts was sent').toBeDefined();
    const where = whereOf(update!);
    expect(where).toMatch(/"broadcasts"\."tenant_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."broadcast_id"\s*=\s*\$\d+/);
    const slot = /"broadcasts"\."status"\s*=\s*\$(\d+)/.exec(where);
    expect(slot, 'the WHERE has no status CAS').not.toBeNull();
    expect(update!.params[Number(slot![1]) - 1]).toBe('approved');
  });

  it('a 0-row update throws the typed concurrent-mutation error (the row is still there, at another status)', async () => {
    rec.statements.length = 0;
    const { drizzle } = await import('drizzle-orm/pg-proxy');
    // The tenant probe, the UPDATE (no row), then throwConcurrentMutation's re-read: `cancelled`.
    const tx = drizzle(async (sqlText) => {
      if (sqlText.includes("current_setting('app.current_tenant'")) return { rows: [{ current_tenant: TENANT }] };
      if (/^select\b/i.test(sqlText)) return { rows: [['cancelled']] };
      return { rows: [] };
    });
    const repo = makeDrizzleBroadcastsRepo(TENANT);
    const thrown = await repo.attachResendIds(tx as never, TENANT as never, BROADCAST_ID, 'aud-1', 'rb-1').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(BroadcastConcurrentMutationError);
    expect((thrown as { observedStatus: string }).observedStatus).toBe('cancelled');
  });
});
