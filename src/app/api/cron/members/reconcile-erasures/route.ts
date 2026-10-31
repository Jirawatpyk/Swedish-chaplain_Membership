/**
 * COMP-1 US2d reconciliation cron — POST `/api/cron/members/reconcile-erasures`.
 *
 * GDPR Art.17 / PDPA §33 member erasure is a two-phase op: a durable atomic
 * scrub tx (which sets `members.erased_at`) followed by best-effort post-commit
 * cascades (F1 login erasure, F7 broadcast cancel/content-scrub, F8 renewal
 * cancel, F6 event-registration erasure). `member_erased` is the completion
 * proof — emitted ONLY when every cascade reports clean. If a cascade fails
 * after the scrub committed, the member is "stuck": erased_at is set but
 * `member_erased` never landed.
 *
 * This sweep finds those stuck members (`MemberRepo.findStuckErasuresInTx`,
 * `FOR UPDATE SKIP LOCKED`) and re-drives the idempotent `eraseMember` for
 * each. `eraseMember` re-attempts only the incomplete cascades and emits
 * `member_erased` when they finally clear.
 *
 * Outcome bucketing per re-driven member:
 *   - res.ok && cascadesComplete === true → `reconciled` (member_erased emitted
 *     this tick — the erasure is now complete).
 *   - res.ok && !cascadesComplete, OR a typed Result.err → `still_pending`
 *     (a cascade is STILL failing — TRANSIENT, retried next tick; this includes
 *     the benign F6 fan-out failedCount from US2c and the non-auto-recoverable
 *     'erase-user-last-admin' F1-cascade case). `still_pending` is NOT an error.
 *   - an uncaught throw from `eraseMember` → `error` (only here). Caught
 *     per-member; the loop continues.
 *
 * Response is 200 normally, **500 when summary.error > 0** so cron-job.org
 * retries the tick. A tick with only `still_pending` returns 200 — that is the
 * expected steady state until the operator fixes the failing cascade.
 *
 * NOTE on 'erase-user-last-admin': that F1-cascade case is NOT auto-recoverable
 * (the reconciler will re-drive it every tick → still_pending forever). It
 * surfaces as a DISTINCT operator alert via the `authMetrics.eraseCascadeOutcome
 * ('last_admin')` metric emitted INSIDE the F1 cascade during the re-drive — no
 * special route logic is needed here (it correctly maps to still_pending); we
 * just do not swallow or mis-label it. The runbook documents the distinct alert.
 *
 * Auth: Bearer token via `CRON_SECRET` (shared with the F4/F5/F7/F8 crons).
 * Single-tenant SweCham MVP — runs against the deployed tenant slug.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { eraseMember, drizzleMemberRepo } from '@/modules/members';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { erasureMetrics } from '@/lib/metrics';
import { erasureCascadeDeadline, erasureMemberStartCutoff } from '@/lib/erasure-cascade-deadline';
import { errKind } from '@/lib/log-id';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
import { cronReadOnlyGuard } from '@/lib/cron-read-only-guard';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_PER_TICK = 50;

// The time budget (spec 139; spec 140 s1 review rounds 1–4). The tick's
// cascade deadline is `erasureCascadeDeadline` = maxDuration − 60 s = 240 s.
// No new member is started after `erasureMemberStartCutoff` = the deadline −
// one row's floor (30 s) = 210 s, so a member started last still has a row's
// worth of time (round 3 put the cutoff AT the deadline, leaving ~0 s). A re-drive's broadcasts cascade holds each dispatch-begun row's
// lock across up to two bounded Resend calls and the 3 s re-probe pause after a
// 404 (≈ 23 s, review round 2), so 50 members can outrun the 300 s function;
// the members left are deferred, and the next tick (they are still stuck)
// continues with them. The same deadline bounds every re-drive's terminal-draft
// pass, computed once per tick: a member started late gets only the remainder.
// Acceptable because a row not reached withholds `member_erased` and the next
// tick (30 min) continues — every re-drive is idempotent, already-cleared
// drafts cost one 404 round trip (~0.5 s, research § Limits) — and the stuck
// gauge shows a member that never completes (plan.md, review rounds 2–3). The
// budget is checked BETWEEN members only: one member with several
// dispatch-begun rows (≈ 23 s each, × the cascade's CAS retries) can still
// overrun `maxDuration` — fail closed (the row's lock tx rolls back), and the
// next tick resumes. An accepted bound (plan.md, cron-jobs.md).

// System-actor sentinels for the re-driven erasure (COMP-1 US2a convention —
// the F1 cascade uses `requestId = 'system:erase-cascade'`; this reconciler
// uses its own distinct requestId so the DPO log can attribute a re-drive to
// the sweep, not the original admin request). `EraseMemberMeta.actorUserId` is
// a plain string (NOT a branded UserId), so `'system:cron'` type-checks — the
// established cron system-actor literal across the F4/F5/F9 cron routes.
const SYSTEM_ACTOR = 'system:cron';
const SYSTEM_REQUEST_ID = 'system:erase-reconcile';

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  // Constant-time Bearer check via the shared helper (parity with the F4/F5/F7
  // cron routes) — closes the timing side-channel on a CRON_SECRET brute-force.
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  // #408 — READ_ONLY_MODE: Vercel Cron calls with GET, which the proxy
  // write-freeze does not cover, so the route skips by itself.
  const frozen = cronReadOnlyGuard('/api/cron/members/reconcile-erasures');
  if (frozen) return frozen;

  const tenant = asTenantContext(resolveTenantFromRequest(request).slug);

  // Spec 140 s1 review rounds 2–4 — `members_erasure_stuck_count` has ONE
  // meaning wherever it is observed (paused, before the loop, after it): the
  // non-locking, uncapped count of members whose erasure has no
  // `member_erased`. A failed read observes nothing new.
  const observeStuckCount = async (): Promise<void> => {
    try {
      const count = await runInTenant(tenant, (tx) => drizzleMemberRepo.countStuckErasuresInTx(tx, tenant.slug));
      erasureMetrics.stuckCount(count, tenant.slug);
    } catch (e) {
      logger.warn({ err: errKind(e), tenantId: tenant.slug }, 'cron.members.reconcile_erasures.stuck_count_failed');
    }
  };

  // Kill-switch returns 200 + {skipped:true} (parity with the F7 reconcile
  // route) so cron-job.org does NOT retry-storm a pause window.
  if (!env.features.memberErasureReconcile) {
    // Spec 140 s1 review round 2 (code-review #7) — while paused nothing is
    // re-driven, so the backlog only grows: observe the real count. Review
    // round 3 (code-review #8): a NON-locking, uncapped count — the paused tick
    // locks no member row, and a member being erased right now is counted, not
    // skipped. A failed read observes nothing new; the pause still answers 200.
    await observeStuckCount();
    logger.info(
      { tenantId: tenant.slug },
      'cron.members.reconcile_erasures.feature_disabled',
    );
    return NextResponse.json(
      { skipped: true, reason: 'feature_disabled' },
      { status: 200 },
    );
  }

  // Candidate select — its OWN runInTenant tx. The `FOR UPDATE SKIP LOCKED`
  // member-row lock taken inside `findStuckErasuresInTx` drops when THIS tx
  // commits, BEFORE the re-drive loop, so a slow per-member re-drive does not
  // hold member-row locks across the whole tick (and concurrent reconciler
  // ticks skip rows this tick already claimed).
  //
  // Pass `tenant.slug` (the chamber slug STRING), NOT a tenant UUID:
  // `audit_log.tenant_id` is a text column storing the slug, and the two audit
  // subqueries in `findStuckErasuresInTx` filter `al.tenant_id = <slug>`. A
  // UUID would 0-match both subqueries → every stuck member would look
  // "no member_erased" with reason always defaulting to gdpr → re-drive forever
  // and never distinguish anything. (Task 2 security/spec-review carry-forward.)
  let stuck: Awaited<
    ReturnType<typeof drizzleMemberRepo.findStuckErasuresInTx>
  >;
  let baseline = 0;
  try {
    // Review round 5 — the gauge's BASELINE rides the candidate tx (one round
    // trip fewer). A count failure there fails the tx: `query_failed`, 500.
    stuck = await runInTenant(tenant, async (tx) => {
      const candidates = await drizzleMemberRepo.findStuckErasuresInTx(tx, tenant.slug, MAX_PER_TICK);
      baseline = await drizzleMemberRepo.countStuckErasuresInTx(tx, tenant.slug);
      return candidates;
    });
  } catch (e) {
    logger.error(
      {
        // Forbidden-log hygiene (COMP-1 PR-review FIX D): never log the raw
        // error message — a Postgres error can embed SQL param VALUES (the
        // erased member's PII). Log only the error CLASS name.
        err: errKind(e),
        tenantId: tenant.slug,
      },
      'cron.members.reconcile_erasures.query_failed',
    );
    return NextResponse.json({ error: { code: 'internal_error' } }, { status: 500 });
  }

  // Spec 140 s1 review rounds 1, 4, 5 — the BASELINE, in the gauge's one
  // meaning (the uncapped, non-locking count), read in the candidate tx: a tick
  // killed mid-loop (maxDuration) still leaves this tick's number. A
  // candidate-tx failure (above) observes nothing new: the gauge keeps the
  // previous tick's value and the 500 + the `query_failed` log are the signal.
  erasureMetrics.stuckCount(baseline, tenant.slug);

  // `processed` is derivable (reconciled + still_pending + error invariantly), so
  // it is NOT tracked here — it is computed at response time below.
  const summary = { reconciled: 0, still_pending: 0, error: 0 };
  const cascadeDeadline = erasureCascadeDeadline(startedAt, maxDuration);
  const memberStartCutoff = erasureMemberStartCutoff(cascadeDeadline);
  const deps = buildEraseMemberDeps(tenant);

  // Sequential per-member re-drive. Each `eraseMember` re-opens its own txs
  // (the durable scrub + each post-commit cascade adapter), so there is no
  // shared cross-member state; sequential keeps the failure isolation simple
  // and the count at ≤50/tick (MAX_PER_TICK); the cascade deadline keeps the loop
  // inside maxDuration (spec 139).
  let deferred = 0;
  for (const [index, { memberId, reason }] of stuck.entries()) {
    if (Date.now() >= memberStartCutoff.getTime()) {
      deferred = stuck.length - index;
      break;
    }
    try {
      const res = await eraseMember(
        memberId,
        { reason },
        { actorUserId: SYSTEM_ACTOR, requestId: SYSTEM_REQUEST_ID, deadlineAt: cascadeDeadline },
        deps,
      );
      if (res.ok && res.value.cascadesComplete) {
        // member_erased was emitted this tick — the erasure is complete.
        summary.reconciled++;
        erasureMetrics.outcome('reconciled', tenant.slug);
      } else {
        // res.ok && !cascadesComplete  → a cascade is still failing.
        // typed Result.err (not_found / server_error / invalid_body) → ditto.
        // Both are TRANSIENT — the next tick retries. NOT an error; NOT a 500.
        summary.still_pending++;
        erasureMetrics.outcome('still_pending', tenant.slug);
        logger.warn(
          {
            tenantId: tenant.slug,
            memberId,
            // forensics: distinguish the "scrub ok but cascade pending" path
            // from the typed-err path without leaking PII.
            errType: res.ok ? null : res.error.type,
          },
          'cron.members.reconcile_erasures.still_pending',
        );
      }
    } catch (e) {
      // Only an UNCAUGHT throw from eraseMember reaches here → genuine error;
      // 500 below makes cron-job.org retry. Catch per-member + continue.
      summary.error++;
      erasureMetrics.outcome('error', tenant.slug);
      logger.error(
        {
          // Forbidden-log hygiene (COMP-1 PR-review FIX D): never log the raw
          // message or stack — both can embed SQL param VALUES (erased PII). The
          // error CLASS name + the (opaque) memberId are enough to triage.
          err: errKind(e),
          tenantId: tenant.slug,
          memberId,
        },
        'cron.members.reconcile_erasures.uncaught',
      );
    }
  }

  // `processed` is derived (it equals reconciled + still_pending + error every
  // iteration) rather than tracked by a mutable counter.
  const body = {
    processed: summary.reconciled + summary.still_pending + summary.error,
    reconciled: summary.reconciled,
    still_pending: summary.still_pending,
    error: summary.error,
    // Members still stuck that this tick did not start (the time budget); the
    // next tick picks them up.
    deferred,
  };
  // Spec 140 s1 — what is still stuck after this tick, as the same uncapped
  // count (review round 4: one meaning). A value that stays above 0 tick after
  // tick is an erasure being re-driven for ever (a permanent Resend answer on
  // a terminal draft, a cascade that never clears).
  await observeStuckCount();

  if (deferred > 0) {
    logger.warn(
      { tenantId: tenant.slug, deferred, budgetMs: memberStartCutoff.getTime() - startedAt },
      'cron.members.reconcile_erasures.budget_deferred',
    );
  }

  logger.info(
    { tenantId: tenant.slug, ...body },
    'cron.members.reconcile_erasures.tick_complete',
  );

  // 500 ONLY when an uncaught throw occurred this tick (so cron-job.org retries
  // the genuinely-broken tick). A tick of pure `still_pending` is the expected
  // steady state until the operator fixes the failing cascade → 200.
  return NextResponse.json(body, { status: summary.error > 0 ? 500 : 200 });
}
