/**
 * Spec 139 slice 2 (DA1–DA3) — the audience audit rows on live Postgres (Neon
 * `dev`).
 *
 * What the delete sites depend on:
 *
 *   - `f7AuditAdapter.emitOnce` — the one writer of `broadcast_audience_deleted`
 *     (spec 142): `INSERT … ON CONFLICT DO NOTHING` against migration 0328's
 *     partial unique index on (tenant, segment), so a segment gets one row;
 *   - `hasAudienceDeletedAuditInTx` — the reclaim's lockless read of that row;
 *   - `findAudienceDisclosureInTx` — the `broadcast_audience_disclosed` row
 *     `reclaim-orphaned-audiences` copies its broadcast and requester from.
 *
 * Tenant scoping is two-layer (Principle I): `runInTenant` (FORCE RLS) AND an
 * explicit `tenant_id` predicate. The explicit one is load-bearing: the
 * `audit_log` policy also admits `tenant_id IS NULL` rows, so the NULL-tenant
 * cases fail without it; another tenant's row is hidden by RLS as well, and a
 * tx bound to another tenant is refused (`assertTenantBoundTx`).
 *
 * Fixture rows are inserted with the bare owner connection (it bypasses RLS,
 * so it can write any tenant's row and a NULL-tenant one); `audit_log` is
 * append-only, so each run leaves its rows on the dev branch (the same litter
 * class as `already-sent-evidence.test.ts`, summary `spec 139 s2 fixture`).
 * Every fixture uses a fresh segment id, so no cell seeds two deleted rows for
 * one (tenant, segment) key: the index refuses that (spec 142).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, runInTenant } from '@/lib/db';
import { errLogFields } from '@/lib/log-id';
import { ok } from '@/lib/result';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asBroadcastId } from '@/modules/broadcasts';
import {
  AuditPortInvariantError,
  type AudienceDeleteReason,
  type F7AuditPayloadShapes,
} from '@/modules/broadcasts/application/ports/audit-port';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { isAdapterInvariantError } from '@/modules/broadcasts/application/use-cases/_safe-audit-emit';
import { makeBuildAudienceTickDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import {
  AUDIENCE_DELETED_INDEX_CANARY_SQL,
  AUDIENCE_DELETED_INDEX_DEF,
  AUDIENCE_DELETED_KEY_SQL,
  AUDIENCE_DELETED_PREDICATE_SQL,
  normaliseIndexDefSql,
  sqlStringLiteral,
} from '@/modules/broadcasts/infrastructure/db/audience-audit-index';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { asTenantContext } from '@/modules/tenants';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedLiveRequester } from '../helpers/seed-live-requester';

type AudienceEvent = 'broadcast_audience_disclosed' | 'broadcast_audience_deleted';

/** One fixture row, written with the bare owner connection (any tenant, or none). */
async function insertRow(tenantSlug: string | null, eventType: AudienceEvent, payload: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_log (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
    VALUES (${eventType}::audit_event_type, 'system:cron', 'spec 139 s2 fixture', 'no-request-id',
            ${JSON.stringify(payload)}::jsonb, ${tenantSlug}, 5)
  `);
}

const disclosedPayload = (audienceId: string, broadcastId: string, memberId: string) => ({
  broadcast_id: broadcastId,
  related_member_id: memberId,
  resend_audience_id: audienceId,
  recipient_count: 2,
  leg: 'import',
  actor_role: 'system',
});

const deletedPayload = (audienceId: string, broadcastId: string, memberId: string) => ({
  broadcast_id: broadcastId,
  related_member_id: memberId,
  resend_audience_id: audienceId,
  reason: 'terminal_cleanup',
  leg: 'import',
  actor_role: 'system',
});

/** Synthetic and unroutable (RFC 2606). */
const RECIPIENTS = ['audience-audit-a@example.com', 'audience-audit-b@example.com'];
const NO_BRAND = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };

describe('spec 139 s2 — the audience audit rows (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let requester: { readonly memberId: string; readonly planId: string };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
    requester = await seedLiveRequester(tenantA.ctx, user.userId);
  }, 120_000);

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
    if (user) await deleteTestUser(user).catch(() => {});
  }, 120_000);

  const deletedSeen = (tenant: TestTenant, audienceId: string) => {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    return repo.withTx((tx) => repo.hasAudienceDeletedAuditInTx(tx, audienceId));
  };
  const disclosureOf = (tenant: TestTenant, audienceId: string) => {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    return repo.withTx((tx) => repo.findAudienceDisclosureInTx(tx, audienceId));
  };

  describe('hasAudienceDeletedAuditInTx', () => {
    it("the tenant's own deleted row for the segment → seen; none yet → not seen", async () => {
      const audienceId = randomUUID();
      expect(await deletedSeen(tenantA, audienceId)).toBe(false);
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_deleted', deletedPayload(audienceId, randomUUID(), randomUUID()));
      expect(await deletedSeen(tenantA, audienceId)).toBe(true);
    });

    it("another tenant's row, or a NULL-tenant row, with the same payload is not seen", async () => {
      const audienceId = randomUUID();
      await insertRow(tenantB.ctx.slug, 'broadcast_audience_deleted', deletedPayload(audienceId, randomUUID(), randomUUID()));
      await insertRow(null, 'broadcast_audience_deleted', deletedPayload(audienceId, randomUUID(), randomUUID()));
      expect(await deletedSeen(tenantA, audienceId)).toBe(false);
      expect(await deletedSeen(tenantB, audienceId)).toBe(true);
    });

    it("a disclosed row, or a deleted row for another segment, is not a deleted row for this one", async () => {
      const audienceId = randomUUID();
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_disclosed', disclosedPayload(audienceId, randomUUID(), randomUUID()));
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_deleted', deletedPayload(randomUUID(), randomUUID(), randomUUID()));
      expect(await deletedSeen(tenantA, audienceId)).toBe(false);
    });
  });

  // Spec 142 (AO2) — the adapter's one-row write. Each cell uses a fresh
  // segment id; every wait is short, because the dev branch has
  // statement_timeout = 0, so a wrong wait HANGS.
  describe('spec 142 AO2 — f7AuditAdapter.emitOnce', () => {
    const deletedInput = (tenantId: string | null, audienceId: string, reason: AudienceDeleteReason = 'terminal_cleanup') => ({
      eventType: 'broadcast_audience_deleted' as const,
      tenantId: tenantId as string,
      actorUserId: 'system:cron',
      summary: 'spec 142 fixture',
      requestId: null,
      payload: { ...deletedPayload(audienceId, randomUUID(), randomUUID()), reason } as F7AuditPayloadShapes['broadcast_audience_deleted'],
    });
    const emitIn = (tenant: TestTenant, input: ReturnType<typeof deletedInput>) =>
      runInTenant(tenant.ctx, (tx) => f7AuditAdapter.emitOnce(tx, input));
    const rowsFor = async (tenantSlug: string, audienceId: string) =>
      (await db.execute(sql`
        SELECT payload->>'reason' AS reason FROM audit_log
         WHERE tenant_id = ${tenantSlug}
           AND event_type = 'broadcast_audience_deleted'::audit_event_type
           AND payload->>'resend_audience_id' = ${audienceId}
      `)) as unknown as Array<{ reason: string }>;

    it('answers true, then false, and leaves one row', async () => {
      const audienceId = randomUUID();
      expect(await emitIn(tenantA, deletedInput(tenantA.ctx.slug, audienceId, 'hold'))).toBe(true);
      expect(await emitIn(tenantA, deletedInput(tenantA.ctx.slug, audienceId, 'terminal_cleanup'))).toBe(false);
      expect(await rowsFor(tenantA.ctx.slug, audienceId)).toEqual([{ reason: 'hold' }]);
      expect(await deletedSeen(tenantA, audienceId)).toBe(true);
    });

    it("tenant B's row for the same segment id does not block tenant A's (the key includes the tenant)", async () => {
      const audienceId = randomUUID();
      expect(await emitIn(tenantB, deletedInput(tenantB.ctx.slug, audienceId))).toBe(true);
      expect(await emitIn(tenantA, deletedInput(tenantA.ctx.slug, audienceId))).toBe(true);
      expect(await rowsFor(tenantA.ctx.slug, audienceId)).toHaveLength(1);
      expect(await rowsFor(tenantB.ctx.slug, audienceId)).toHaveLength(1);
    });

    /** Two txs on one key: the first holds its uncommitted insert until `finish` says how it ends. */
    async function overlapping(audienceId: string, firstEnds: 'commit' | 'rollback') {
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      let inserted!: () => void;
      const firstInserted = new Promise<void>((r) => (inserted = r));
      const ROLLBACK = new Error('rollback');
      const first = runInTenant(tenantA.ctx, async (tx) => {
        const wrote = await f7AuditAdapter.emitOnce(tx, deletedInput(tenantA.ctx.slug, audienceId, 'hold'));
        inserted();
        await finished;
        if (firstEnds === 'rollback') throw ROLLBACK;
        return wrote;
      }).catch((e: unknown) => {
        if (e === ROLLBACK) return 'rolled_back' as const;
        throw e;
      });
      // A first tx that fails before its insert must not hang the cell.
      await Promise.race([firstInserted, first.then(() => undefined, () => undefined)]);
      let secondDone = false;
      const second = emitIn(tenantA, deletedInput(tenantA.ctx.slug, audienceId, 'terminal_cleanup')).then((wrote) => {
        secondDone = true;
        return wrote;
      });
      await new Promise((r) => setTimeout(r, 750));
      const secondFinishedWhileFirstHeld = secondDone;
      finish();
      const [firstWrote, secondWrote] = await Promise.all([first, second]);
      return { secondFinishedWhileFirstHeld, firstWrote, secondWrote };
    }

    it('two concurrent emitOnce for one segment leave one row: the second waits, then answers false', async () => {
      const audienceId = randomUUID();
      const r = await overlapping(audienceId, 'commit');
      expect(r).toEqual({ secondFinishedWhileFirstHeld: false, firstWrote: true, secondWrote: false });
      expect(await rowsFor(tenantA.ctx.slug, audienceId)).toEqual([{ reason: 'hold' }]);
    });

    it('when the first rolls back, the waiting second writes the row and answers true', async () => {
      const audienceId = randomUUID();
      const r = await overlapping(audienceId, 'rollback');
      expect(r).toEqual({ secondFinishedWhileFirstHeld: false, firstWrote: 'rolled_back', secondWrote: true });
      expect(await rowsFor(tenantA.ctx.slug, audienceId)).toEqual([{ reason: 'terminal_cleanup' }]);
    });

    // AO3 as amended at plan review — the INSERT still waits on another tx's
    // uncommitted insert of the key, so emitOnce bounds it with
    // `AUDIENCE_AUDIT_LOCK_TIMEOUT_MS` (5 s). A 55P03 is a plain driver error,
    // not an adapter invariant one: the row helper logs the WARN
    // `audience_audit_lock_timeout` and the call goes ahead. Raced against 20 s.
    it('an INSERT behind a held insert of the key fails with a lock timeout (55P03, not an invariant error)', async () => {
      const audienceId = randomUUID();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let inserted!: () => void;
      const holding = new Promise<void>((r) => (inserted = r));
      const holder = runInTenant(tenantA.ctx, async (tx) => {
        await f7AuditAdapter.emitOnce(tx, deletedInput(tenantA.ctx.slug, audienceId));
        inserted();
        await released;
      });
      await Promise.race([holding, holder.then(() => undefined, () => undefined)]);
      let guard: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          emitIn(tenantA, deletedInput(tenantA.ctx.slug, audienceId)).then(
            (v) => ({ kind: 'resolved' as const, v }),
            (e: unknown) => ({ kind: 'rejected' as const, e }),
          ),
          new Promise<{ kind: 'hung' }>((r) => {
            guard = setTimeout(() => r({ kind: 'hung' }), 20_000);
          }),
        ]);
        expect(outcome.kind).toBe('rejected');
        const e = (outcome as { e?: unknown }).e;
        expect(errLogFields(e).code).toBe('55P03');
        expect(isAdapterInvariantError(e)).toBe(false);
      } finally {
        clearTimeout(guard);
        release();
        await holder;
      }
    });

    it('refuses a null tx and a null tenantId as invariant errors (a NULL never conflicts)', async () => {
      const audienceId = randomUUID();
      const nullTx = await f7AuditAdapter.emitOnce(null, deletedInput(tenantA.ctx.slug, audienceId)).then(() => null, (e: unknown) => e);
      expect(nullTx).toBeInstanceOf(AuditPortInvariantError);
      const nullTenant = await emitIn(tenantA, deletedInput(null, audienceId)).then(() => null, (e: unknown) => e);
      expect(nullTenant).toBeInstanceOf(AuditPortInvariantError);
      expect(await rowsFor(tenantA.ctx.slug, audienceId)).toEqual([]);
    });

    // Review round 1 (reliability L2) — the other two refusals, pinned: an empty
    // segment id (a NULL-like key never conflicts) and another event type (a
    // cast past the input type). Characterization: the adapter already refuses.
    it('refuses an empty resend_audience_id and another event type as invariant errors (no row written)', async () => {
      const audienceId = randomUUID();
      const base = deletedInput(tenantA.ctx.slug, audienceId);
      const emptyKey = await emitIn(tenantA, { ...base, payload: { ...base.payload, resend_audience_id: '' } }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(emptyKey).toBeInstanceOf(AuditPortInvariantError);
      const otherEvent = await emitIn(tenantA, {
        ...base,
        eventType: 'broadcast_audience_disclosed' as 'broadcast_audience_deleted',
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(otherEvent).toBeInstanceOf(AuditPortInvariantError);
      expect(await rowsFor(tenantA.ctx.slug, '')).toEqual([]);
      expect(await rowsFor(tenantA.ctx.slug, audienceId)).toEqual([]);
      expect(await disclosureOf(tenantA, audienceId)).toBeNull();
    });

    // Review round 1 (code-review #3) — emitOnce is the deleted row's only
    // writer: the adapter's other methods refuse the event before any write, so
    // a plain emit can never bypass the index's arbiter. emitMany gets a mixed
    // batch, whose good row must not land either. Review round 2: the port's
    // types exclude the event, so each input is cast past them (`as never`),
    // which is what this runtime refusal stands behind.
    it('emit, emitTyped and emitMany refuse broadcast_audience_deleted before any write', async () => {
      const ids = { emit: randomUUID(), emitTyped: randomUUID(), emitMany: randomUUID(), emitManyTyped: randomUUID() };
      const disclosedId = randomUUID();
      const plain = (audienceId: string) => {
        const input = deletedInput(tenantA.ctx.slug, audienceId);
        return { ...input, payload: { ...input.payload } } as never;
      };
      const goodRow = {
        eventType: 'broadcast_audience_disclosed' as const,
        tenantId: tenantA.ctx.slug,
        actorUserId: 'system:cron',
        summary: 'spec 142 fixture',
        requestId: null,
        payload: disclosedPayload(disclosedId, randomUUID(), randomUUID()) as F7AuditPayloadShapes['broadcast_audience_disclosed'],
      };
      const refused = (write: (tx: unknown) => Promise<void> | undefined) =>
        runInTenant(tenantA.ctx, async (tx) => {
          await write(tx);
        }).then(
          () => null,
          (e: unknown) => e,
        );
      const errors = [
        await refused((tx) => f7AuditAdapter.emit(tx, plain(ids.emit))),
        await refused((tx) => f7AuditAdapter.emitTyped(tx, deletedInput(tenantA.ctx.slug, ids.emitTyped) as never)),
        await refused((tx) => f7AuditAdapter.emitMany?.(tx, [{ ...goodRow, payload: { ...goodRow.payload } }, plain(ids.emitMany)])),
        await refused((tx) =>
          f7AuditAdapter.emitManyTyped?.(tx, [deletedInput(tenantA.ctx.slug, ids.emitManyTyped) as never]),
        ),
      ];
      expect(errors.map((e) => e instanceof AuditPortInvariantError)).toEqual([true, true, true, true]);
      for (const id of Object.values(ids)) expect(await rowsFor(tenantA.ctx.slug, id)).toEqual([]);
      expect(await disclosureOf(tenantA, disclosedId)).toBeNull();
    });

    it("cross-tenant: a tx bound to tenant B refuses tenant A's row as an invariant error", async () => {
      const audienceId = randomUUID();
      const e = await runInTenant(asTenantContext(tenantB.ctx.slug), (tx) =>
        f7AuditAdapter.emitOnce(tx, deletedInput(tenantA.ctx.slug, audienceId)),
      ).then(() => null, (err: unknown) => err);
      expect((e as Error).message).toMatch(/tx tenant mismatch/);
      expect(isAdapterInvariantError(e)).toBe(true);
      expect(await rowsFor(tenantA.ctx.slug, audienceId)).toEqual([]);
      expect(await rowsFor(tenantB.ctx.slug, audienceId)).toEqual([]);
    });
  });

  // Spec 142 (AO1) — migration 0328's partial unique index and its pre-check.
  // Every duplicate attempt runs in a tx that is rolled back, so no run (a RED
  // one included) leaves a second row for one key on the dev branch.
  describe('spec 142 AO1 — migration 0328 (audit_log_audience_deleted_once)', () => {
    const MIGRATION = join(process.cwd(), 'drizzle', 'migrations', '0328_audit_log_audience_deleted_once.sql');
    const ROLLBACK = new Error('rollback');

    /** Run `fn` on the owner connection and roll it back; answers what `fn` answered. */
    async function rolledBack<T>(fn: (tx: { execute: typeof db.execute }) => Promise<T>): Promise<T> {
      let out!: T;
      await db
        .transaction(async (tx) => {
          out = await fn(tx as unknown as { execute: typeof db.execute });
          throw ROLLBACK;
        })
        .catch((e: unknown) => {
          if (e !== ROLLBACK) throw e;
        });
      return out;
    }

    /** The migration's `DO $$` pre-check, verbatim from the file. */
    function preCheckSql(): string {
      const block = readFileSync(MIGRATION, 'utf8')
        .split('--> statement-breakpoint')
        .find((s) => s.includes('DO $$') && s.includes('duplicate keys'));
      expect(block).toBeDefined();
      return block!;
    }

    /** The migration's index-definition check (the `DO $$` block after the CREATE), verbatim from the file. */
    function indexCheckSql(): string {
      const block = readFileSync(MIGRATION, 'utf8')
        .split('--> statement-breakpoint')
        .find((s) => s.includes('DO $$') && s.includes('has another definition'));
      expect(block).toBeDefined();
      return block!;
    }

    /**
     * Past the cap, closing change (the maintainer chose "compare the full
     * definition") — the check compares the live `pg_get_indexdef` text with
     * ONE expected literal, both normalised by `normaliseIndexDefSql` (the `public.`
     * schema qualifier dropped, whitespace collapsed), and requires
     * `indisvalid`. `pg_get_indexdef` prints the access method, UNIQUE, the
     * table, every key with any non-default operator class or COLLATE, INCLUDE,
     * NULLS NOT DISTINCT and the predicate, so a difference in any of them is
     * a difference in the text. The expected text is
     * `AUDIENCE_DELETED_INDEX_DEF` (spec 143 TT1, the one TS source), dev's
     * text as read with `pnpm db:query` on 7 Nov 2026; the positive control
     * re-reads it, so it pins that constant to the live index. The migration
     * spells `normaliseIndexDefSql` around its arguments.
     */
    const normalised = (def: string) => def.replaceAll('public.', '').replace(/\s+/g, ' ').trim();
    /** A SQL string literal's body (quotes doubled) back to its value. */
    const unquote = (body: string) => body.replaceAll("''", "'");

    /** The migration's expected literal, as written between its quotes. */
    function migrationLiteral(): string {
      const m = /v_expected constant text := '((?:[^']|'')*)';/.exec(indexCheckSql());
      expect(m).not.toBeNull();
      return m![1]!;
    }

    /** The migration's CREATE statement, with its identifier quotes dropped. */
    function createSql(): string {
      const block = readFileSync(MIGRATION, 'utf8')
        .split('--> statement-breakpoint')
        .find((s) => s.includes('CREATE UNIQUE INDEX IF NOT EXISTS'));
      expect(block).toBeDefined();
      return block!.replaceAll('"', '').replace(/\s+/g, ' ');
    }

    /** The check with its catalog read replaced by literal assignments, so it reads no catalog. */
    function checkAgainst(check: string, def: string | null, valid: boolean | null): string {
      const read = /SELECT\s+pg_get_indexdef\(i\.indexrelid\),\s*i\.indisvalid\s+INTO\s+v_def,\s*v_valid[^;]*;/;
      expect(read.test(check)).toBe(true);
      const defSql = def === null ? 'NULL' : sqlStringLiteral(def);
      return check.replace(read, `v_def := ${defSql}; v_valid := ${valid === null ? 'NULL' : String(valid)};`);
    }

    /** Runs `block` in a rolled-back tx; answers the RAISE message, or null when it passed. */
    async function raised(block: string): Promise<string | null> {
      const e = await rolledBack((tx) =>
        tx.execute(sql.raw(block)).then(
          () => null,
          (err: unknown) => err,
        ),
      );
      if (e === null) return null;
      const cause = (e as { cause?: { message?: string } }).cause;
      return String(cause?.message ?? (e as Error).message);
    }

    /** `rows` into a temp `audit_log` that shadows the real one (pg_temp is searched first), then the pre-check. */
    async function preCheckOver(rows: ReadonlyArray<{ tenant: string | null; payload: Record<string, unknown> }>) {
      return rolledBack(async (tx) => {
        await tx.execute(sql`CREATE TEMP TABLE audit_log (LIKE public.audit_log INCLUDING DEFAULTS) ON COMMIT DROP`);
        for (const r of rows) {
          await tx.execute(sql`
            INSERT INTO audit_log (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
            VALUES ('broadcast_audience_deleted'::audit_event_type, 'system:cron', 'spec 142 fixture', 'no-request-id',
                    ${JSON.stringify(r.payload)}::jsonb, ${r.tenant}, 5)
          `);
        }
        return tx.execute(sql.raw(preCheckSql())).then(
          () => null,
          (e: unknown) => e,
        );
      });
    }

    it('a second deleted row for the same tenant and segment is refused by the index (23505)', async () => {
      const audienceId = randomUUID();
      const second = await rolledBack(async (tx) => {
        const insert = () =>
          tx.execute(sql`
            INSERT INTO audit_log (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
            VALUES ('broadcast_audience_deleted'::audit_event_type, 'system:cron', 'spec 142 fixture', 'no-request-id',
                    ${JSON.stringify(deletedPayload(audienceId, randomUUID(), randomUUID()))}::jsonb, ${tenantA.ctx.slug}, 5)
          `);
        await insert();
        return insert().then(
          () => null,
          (e: unknown) => e,
        );
      });
      expect(second).not.toBeNull();
      expect(errLogFields(second).code).toBe('23505');
    });

    // Review round 2 (code-review #1, #3) — the CREATE is IF NOT EXISTS, so a
    // re-run is a no-op, and the check after it fails the migration when the
    // index under this name has another definition. Every cell is read-only:
    // the check reads the catalog only (or literal values in its place), and
    // no index is created on the shared audit_log.
    const PREFIX = '0328: index audit_log_audience_deleted_once has another definition';

    // Spec 143 (TT1) — the migration is the one copy of audience-audit-index.ts's
    // text; these pin it to the constants.
    it("the migration's v_expected and normalisation are AUDIENCE_DELETED_INDEX_DEF and normaliseIndexDefSql (CR4 #5, TT1)", () => {
      expect(unquote(migrationLiteral())).toBe(AUDIENCE_DELETED_INDEX_DEF);
      const check = indexCheckSql();
      expect(check).toContain(normaliseIndexDefSql('v_def'));
      expect(check).toContain(normaliseIndexDefSql('v_expected'));
    });

    it("the migration's CREATE has the key and the predicate of audience-audit-index.ts (TT1)", () => {
      const create = createSql();
      expect(create).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS audit_log_audience_deleted_once ON audit_log ${AUDIENCE_DELETED_KEY_SQL} WHERE ${AUDIENCE_DELETED_PREDICATE_SQL};`);
    });

    // Review round 1 (code-review #5): the script runs the module's canary
    // query as it is, so the live cell below executes the script's own text
    // and a typo in it (the to_regclass name included) fails that cell.
    it('the verify-schema canary is AUDIENCE_DELETED_INDEX_CANARY_SQL from audience-audit-index.ts (TT1)', () => {
      const source = readFileSync(join(process.cwd(), 'scripts', 'verify-schema.ts'), 'utf8');
      expect(source).toMatch(/from '\.\.\/src\/modules\/broadcasts\/infrastructure\/db\/audience-audit-index'/);
      expect(source).toContain('query: AUDIENCE_DELETED_INDEX_CANARY_SQL,');
      // The query has no second copy in the script (its name line may name the index).
      expect(source).not.toContain('CREATE UNIQUE INDEX audit_log_audience_deleted_once');
      expect(source).not.toMatch(/to_regclass\('public\.audit_log_audience_deleted_once'\)/);
    });

    it('the index check and the canary pass on the live index, and the check on its text in place of the catalog read', async () => {
      // Positive control: dev's live text and validity are what AUDIENCE_DELETED_INDEX_DEF says.
      const live = (await db.execute(sql`
        SELECT pg_get_indexdef(indexrelid) AS d, indisvalid
          FROM pg_index WHERE indexrelid = to_regclass('public.audit_log_audience_deleted_once')
      `)) as unknown as Array<Record<string, unknown>>;
      expect(live).toEqual([{ d: AUDIENCE_DELETED_INDEX_DEF, indisvalid: true }]);
      const check = indexCheckSql();
      expect(await raised(check)).toBeNull();
      expect(await raised(checkAgainst(check, AUDIENCE_DELETED_INDEX_DEF, true))).toBeNull();
      // The canary, the query db:verify runs, finds the index.
      const hit = (await db.execute(sql.raw(AUDIENCE_DELETED_INDEX_CANARY_SQL))) as unknown as unknown[];
      expect(hit).toHaveLength(1);
      // A schema qualifier on the enum type and other whitespace are not differences.
      const reworded = AUDIENCE_DELETED_INDEX_DEF.replace('::audit_event_type', '::public.audit_event_type').replace(' USING ', '\n   USING  ');
      expect(await raised(checkAgainst(check, reworded, true))).toBeNull();
    });

    it('the index check raises on every other definition, quoting both normalised texts', async () => {
      const check = indexCheckSql();
      const keys = "(tenant_id, ((payload ->> 'resend_audience_id'::text)))";
      const variant = (to: string, from = keys) => {
        expect(AUDIENCE_DELETED_INDEX_DEF).toContain(from);
        return AUDIENCE_DELETED_INDEX_DEF.replace(from, to);
      };
      const cases: ReadonlyArray<readonly [string, string]> = [
        [variant(`${keys} NULLS NOT DISTINCT`), 'NULLS NOT DISTINCT'],
        // bpchar_ops is the DEFAULT class of another type: a "default class" test passes it.
        [variant("(tenant_id, ((payload ->> 'resend_audience_id'::text)) bpchar_ops)"), 'bpchar_ops'],
        [variant("(tenant_id, ((payload ->> 'resend_audience_id'::text)) text_pattern_ops)"), 'text_pattern_ops'],
        [variant(`(tenant_id, ((payload ->> 'resend_audience_id'::text)) COLLATE "C")`), 'COLLATE "C"'],
        [variant(`${keys} INCLUDE (id)`), 'INCLUDE (id)'],
        [variant("'broadcast_audience_disclosed'::audit_event_type", "'broadcast_audience_deleted'::audit_event_type"), 'broadcast_audience_disclosed'],
        [variant(keys.replace('resend_audience_id', 'broadcast_id')), "'broadcast_id'"],
        [variant('USING hash', 'USING btree'), 'USING hash'],
        [variant('CREATE INDEX', 'CREATE UNIQUE INDEX'), 'CREATE INDEX'],
        [variant('ON public.other_table', 'ON public.audit_log'), 'ON other_table'],
      ];
      for (const [def, marker] of cases) {
        const message = await raised(checkAgainst(check, def, true));
        expect(message).toContain(PREFIX);
        // The message quotes the normalised live text (so the fixture really
        // carries its difference) and the normalised expected one.
        expect(message).toContain(`live [${normalised(def)}]`);
        expect(normalised(def)).toContain(marker);
        expect(message).toContain(`expected [${normalised(AUDIENCE_DELETED_INDEX_DEF)}]`);
      }
    });

    it('the index check raises on an invalid index (indisvalid false) and on a missing one (the all-NULL row, CR #9)', async () => {
      const check = indexCheckSql();
      expect(await raised(checkAgainst(check, AUDIENCE_DELETED_INDEX_DEF, false))).toBe(`${PREFIX}: indisvalid false`);
      // No pg_index row for the name: SELECT INTO leaves both variables NULL.
      expect(await raised(checkAgainst(check, null, null))).toBe(`${PREFIX}: no such index`);
    });

    it('the pre-check raises on a duplicate key and names it as tenant/segment', async () => {
      expect(existsSync(MIGRATION)).toBe(true);
      const audienceId = randomUUID();
      const payload = deletedPayload(audienceId, randomUUID(), randomUUID());
      const e = await preCheckOver([
        { tenant: tenantA.ctx.slug, payload },
        { tenant: tenantA.ctx.slug, payload },
      ]);
      expect(e).not.toBeNull();
      const cause = (e as { cause?: { message?: string } }).cause;
      expect(String(cause?.message ?? (e as Error).message)).toContain(`0328: duplicate keys: ${tenantA.ctx.slug}/${audienceId}`);
    });

    it('the pre-check does not raise on rows whose key is NULL (no tenant, no segment key, a JSON null)', async () => {
      expect(existsSync(MIGRATION)).toBe(true);
      const audienceId = randomUUID();
      const payload = deletedPayload(audienceId, randomUUID(), randomUUID());
      const { resend_audience_id: _drop, ...noKey } = payload;
      const jsonNull = { ...payload, resend_audience_id: null };
      const e = await preCheckOver([
        { tenant: null, payload },
        { tenant: null, payload },
        { tenant: tenantA.ctx.slug, payload: noKey },
        { tenant: tenantA.ctx.slug, payload: noKey },
        { tenant: tenantA.ctx.slug, payload: jsonNull },
        { tenant: tenantA.ctx.slug, payload: jsonNull },
      ]);
      expect(e).toBeNull();
    });
  });

  describe('findAudienceDisclosureInTx', () => {
    it("the tenant's own disclosed row → its broadcast and requester", async () => {
      const audienceId = randomUUID();
      const broadcastId = randomUUID();
      const memberId = randomUUID();
      expect(await disclosureOf(tenantA, audienceId)).toBeNull();
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_disclosed', disclosedPayload(audienceId, broadcastId, memberId));
      expect(await disclosureOf(tenantA, audienceId)).toEqual({ broadcastId, relatedMemberId: memberId });
    });

    it("another tenant's, a NULL-tenant or a deleted row naming the segment is not a disclosure", async () => {
      const audienceId = randomUUID();
      await insertRow(tenantB.ctx.slug, 'broadcast_audience_disclosed', disclosedPayload(audienceId, randomUUID(), randomUUID()));
      await insertRow(null, 'broadcast_audience_disclosed', disclosedPayload(audienceId, randomUUID(), randomUUID()));
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_deleted', deletedPayload(audienceId, randomUUID(), randomUUID()));
      expect(await disclosureOf(tenantA, audienceId)).toBeNull();
      expect(await disclosureOf(tenantB, audienceId)).not.toBeNull();
    });
  });

  it.each([
    ['hasAudienceDeletedAuditInTx', (repo: ReturnType<typeof makeDrizzleBroadcastsRepo>, tx: unknown) =>
      repo.hasAudienceDeletedAuditInTx(tx, randomUUID())],
    ['findAudienceDisclosureInTx', (repo: ReturnType<typeof makeDrizzleBroadcastsRepo>, tx: unknown) =>
      repo.findAudienceDisclosureInTx(tx, randomUUID())],
  ] as const)("cross-tenant: %s with a tx bound to tenant B refuses tenant A's read as an invariant error", async (_label, call) => {
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const e = await runInTenant(asTenantContext(tenantB.ctx.slug), (tx): Promise<unknown> => call(repo, tx)).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/tx tenant mismatch/);
    // Review round 3 (code-review #1): a wiring bug, so the row helper fails
    // closed (ERROR `*.audit_invariant`, rethrown, no Resend call), never a lost row.
    expect(isAdapterInvariantError(e)).toBe(true);
  });

  describe('DA1 / DA2 through the real composition root', () => {
    async function seedApprovedRow(): Promise<string> {
      const broadcastId = randomUUID();
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(broadcasts).values({
          tenantId: tenantA.ctx.slug,
          broadcastId,
          requestedByMemberId: requester.memberId,
          requestedByMemberPlanIdSnapshot: requester.planId,
          submittedByUserId: randomUUID(),
          actorRole: 'member_self_service',
          subject: 'Audience audit',
          bodyHtml: '<p>Body</p>',
          bodySource: 'plain',
          fromName: 'Audience Audit Co via Test Chamber',
          replyToEmail: 'reply@example.com',
          segmentType: 'all_members',
          estimatedRecipientCount: RECIPIENTS.length,
          status: 'approved',
          submittedAt: new Date(Date.now() - 86_400_000),
          approvedAt: new Date(Date.now() - 3_600_000),
          scheduledFor: new Date(Date.now() - 60_000),
        }),
      );
      return broadcastId;
    }

    it('tick 1 writes one disclosed row (ids and the count, no address) under the tenant, before the import', async () => {
      const id = await seedApprovedRow();
      const audienceId = `aud-audit-${randomUUID()}`;
      const calls: string[] = [];
      const port = new Proxy(
        {
          async createAudience() {
            calls.push('createAudience');
            return { audienceId };
          },
          async createContactImport() {
            // The row must already be committed when the POST is made.
            const seen = await db
              .select({ n: sql<number>`count(*)::int` })
              .from(auditLog)
              .where(and(eq(auditLog.tenantId, tenantA.ctx.slug), sql`${auditLog.payload}->>'resend_audience_id' = ${audienceId}`));
            calls.push(`createContactImport:rows=${seen[0]?.n ?? 0}`);
            return { importId: `imp-audit-${randomUUID()}` };
          },
        },
        {
          get: (target, prop) =>
            prop in target || prop === 'then'
              ? (target as Record<string | symbol, unknown>)[prop]
              : async () => {
                  calls.push(String(prop));
                  throw new Error(`gateway.${String(prop)} must not be called here`);
                },
        },
      ) as unknown as BroadcastsGatewayPort;

      const r = await buildAudienceTick(
        {
          ...(await makeBuildAudienceTickDeps(tenantA.ctx.slug, { tickStartedAt: Date.now() })),
          broadcastsGateway: port,
          brandChrome: NO_BRAND,
          resolveRecipients: async () =>
            ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
        },
        { broadcastId: asBroadcastId(id) },
      );

      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(calls).toEqual(['createAudience', 'createContactImport:rows=1']);
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.eventType, 'broadcast_audience_disclosed'), sql`${auditLog.payload}->>'resend_audience_id' = ${audienceId}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: tenantA.ctx.slug, actorUserId: 'system:cron' });
      expect(rows[0]!.payload).toEqual({
        broadcast_id: id,
        related_member_id: requester.memberId,
        resend_audience_id: audienceId,
        recipient_count: RECIPIENTS.length,
        leg: 'import',
        actor_role: 'system',
      });
      expect(JSON.stringify(rows[0])).not.toContain('@');
      expect(await disclosureOf(tenantA, audienceId)).toEqual({ broadcastId: id, relatedMemberId: requester.memberId });
    });

    it('a restart whose delete failed, then a second restart on the same segment: ONE deleted row (stale_audience)', async () => {
      const id = await seedApprovedRow();
      const audienceId = `aud-stale-${randomUUID()}`;
      await runInTenant(tenantA.ctx, (tx) =>
        tx.update(broadcasts).set({ resendAudienceId: audienceId }).where(and(eq(broadcasts.tenantId, tenantA.ctx.slug), eq(broadcasts.broadcastId, id))),
      );
      const deletes: string[] = [];
      const gateway = (failDelete: boolean) =>
        new Proxy(
          {
            async deleteAudience(audience: string) {
              deletes.push(audience);
              if (failDelete) throw Object.assign(new Error('timeout'), { kind: 'retryable', subKind: 'timeout', reason: 'aborted' });
            },
          },
          {
            get: (target, prop) =>
              prop in target || prop === 'then'
                ? (target as Record<string | symbol, unknown>)[prop]
                : async () => {
                    throw new Error(`gateway.${String(prop)} must not be called here`);
                  },
          },
        ) as unknown as BroadcastsGatewayPort;
      const tick = async (port: BroadcastsGatewayPort) =>
        buildAudienceTick(
          {
            ...(await makeBuildAudienceTickDeps(tenantA.ctx.slug, { tickStartedAt: Date.now() })),
            broadcastsGateway: port,
            brandChrome: NO_BRAND,
            resolveRecipients: async () =>
              ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
          },
          { broadcastId: asBroadcastId(id) },
        );

      const first = await tick(gateway(true));
      expect(first.ok).toBe(false);
      const second = await tick(gateway(false));
      expect(second, JSON.stringify(second)).toEqual({ ok: true, value: { kind: 'audience_restarted' } });
      expect(deletes).toEqual([audienceId, audienceId]);

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.eventType, 'broadcast_audience_deleted'), sql`${auditLog.payload}->>'resend_audience_id' = ${audienceId}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: tenantA.ctx.slug, actorUserId: 'system:cron' });
      expect(rows[0]!.payload).toEqual({
        broadcast_id: id,
        related_member_id: requester.memberId,
        resend_audience_id: audienceId,
        reason: 'stale_audience',
        leg: 'import',
        actor_role: 'system',
      });
      expect(JSON.stringify(rows[0])).not.toContain('@');
    });
  });
});
