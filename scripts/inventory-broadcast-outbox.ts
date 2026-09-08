/**
 * 108 T094 — read-only outbox inventory: what is in flight, and how large.
 *
 * **CORRECTED 2026-09-08 (whole-branch review).** This header used to say "run
 * before any deploy that LOWERS the enforced audience ceiling", and the exit-1
 * message told the operator those rows "will be REFUSED once the lower one
 * deploys". Both were written against an interim clamp
 * (`currentAudienceCeiling() = min(configured, 500)`) that **never merged**.
 * Phase 9b replaced it with batching, so the Phase-9 merge does **not** lower
 * the accepted ceiling — it lowers the SPLIT THRESHOLD, and a row above it is
 * split and delivered across ticks rather than refused. Telling an operator to
 * cancel those rows would have destroyed broadcasts the system handles fine.
 *
 * What it is still for. `currentAudienceCeiling()` is compared at count, submit
 * AND dispatch. A broadcast sitting in `submitted` or `approved` was accepted
 * under whatever ceiling was live at submit; its next dispatch tick compares it
 * against the ceiling live THEN. Any change that LOWERS that number — turning
 * `FEATURE_F71A_US1_PAGINATION` off (which restores the single-tick clamp), or
 * turning `FEATURE_CONTACT_MARKETING_RECIPIENTS` off (50,000 → 5,000) — can
 * strand a row that was legal when it was submitted. This prints the two
 * numbers that decide whether that can happen: how many rows are in flight, and
 * the largest `estimated_recipient_count` among them. A quiet outbox is also
 * simply worth confirming before any behaviour change to the dispatch path.
 *
 * PRIVACY: COUNTS and one broadcast id per offending row — never a subject, a
 * body, a recipient address or a member id (Constitution Principle I; the
 * operator runs this against production).
 *
 * Usage (prod, read-only):
 *   EXPORT_DOWNLOAD_TOKEN_SECRET='<any 32+ char dummy>' TENANT_SLUG=swecham \
 *   TSX_TSCONFIG_PATH=tsconfig.scripts.json \
 *   node --env-file=.env.production --import tsx scripts/inventory-broadcast-outbox.ts
 * Dev branch: swap `--env-file=.env.local`.
 *
 * `TENANT_SLUG` above is only there to satisfy env boot. **The tenant this
 * script actually inspects comes from `INVENTORY_TENANT_ID` (default
 * `swecham`)** — the same knob `inventory-primary-contact-invariant.ts` uses.
 * On a second tenant, set it: `INVENTORY_TENANT_ID=<slug>`. Setting only
 * `TENANT_SLUG` would inventory swecham and exit 0 without saying so.
 *
 * Exit 0 = nothing in flight exceeds the bound (safe to deploy the lower
 * ceiling); 1 = at least one in-flight row is above it. Decide per row BEFORE
 * deploying — cancel it, or let it send under the current ceiling first.
 * "Accept the refusal" is not a quiet option: dispatch will transition the row
 * to a terminal `failed_to_dispatch`, write an audit row, and send the FR-021
 * failure notification to the member who submitted it
 * (`dispatch-scheduled-broadcast.ts`). The member finds out.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { DELIVERABLE_RECIPIENTS_PER_TICK } from '@/modules/broadcasts/domain/audience-ceiling';

/** One row per in-flight status; counts only. */
interface StatusRow {
  readonly status: string;
  readonly n: number;
  readonly max_est: number;
  readonly over_bound: number;
}

/** Ids only — never the subject, which is member-authored content. */
interface OverRow {
  readonly broadcast_id: string;
  readonly status: string;
  readonly estimated_recipient_count: number;
}

async function main(): Promise<void> {
  const tenantId = process.env.INVENTORY_TENANT_ID ?? 'swecham';
  const bound = DELIVERABLE_RECIPIENTS_PER_TICK;

  console.log('');
  console.log('=== 108 T094 — broadcast outbox inventory (read-only, counts only) ===');
  console.log(`tenant: ${tenantId}`);
  console.log(`bound:  DELIVERABLE_RECIPIENTS_PER_TICK = ${bound}`);
  console.log('');

  const { rows, over } = await runInTenant(asTenantContext(tenantId), async (tx) => {
    const statusRows = (await tx.execute(sql`
      SELECT b.status::text                                        AS status,
             COUNT(*)::int                                         AS n,
             COALESCE(MAX(b.estimated_recipient_count), 0)::int    AS max_est,
             COUNT(*) FILTER (
               WHERE b.estimated_recipient_count > ${bound}
             )::int                                                AS over_bound
        FROM broadcasts b
       WHERE b.tenant_id = ${tenantId}
         AND b.status IN ('submitted', 'approved', 'sending', 'partially_sent')
       GROUP BY b.status
       ORDER BY b.status
    `)) as unknown as StatusRow[];

    const overRows = (await tx.execute(sql`
      SELECT b.broadcast_id::text                       AS broadcast_id,
             b.status::text                             AS status,
             b.estimated_recipient_count::int           AS estimated_recipient_count
        FROM broadcasts b
       WHERE b.tenant_id = ${tenantId}
         AND b.status IN ('submitted', 'approved', 'sending', 'partially_sent')
         AND b.estimated_recipient_count > ${bound}
       ORDER BY b.estimated_recipient_count DESC
       LIMIT 50
    `)) as unknown as OverRow[];

    return { rows: statusRows, over: overRows };
  });

  if (rows.length === 0) {
    console.log('in flight (submitted / approved / sending / partially_sent): NONE');
  } else {
    for (const r of rows) {
      console.log(
        `${r.status.padEnd(10)} n=${String(r.n).padStart(4)}  max_estimated_recipients=${String(r.max_est).padStart(6)}  over_bound=${r.over_bound}`,
      );
    }
  }

  const totalOver = rows.reduce((acc, r) => acc + r.over_bound, 0);
  console.log('');
  console.log(`rows above the bound: ${totalOver}`);

  if (totalOver > 0) {
    console.log('');
    console.log(
      'These sit above the per-tick bound. With batching ON (prod today) they are SPLIT and delivered across ticks — no action needed. They are only at risk if you are about to LOWER what dispatch compares against: turning off FEATURE_F71A_US1_PAGINATION restores the single-tick clamp, and turning off FEATURE_CONTACT_MARKETING_RECIPIENTS narrows 50,000 to 5,000. In either of those cases each row below is refused terminally at its next tick, with an audit row and a failure email to the member who submitted it — so decide per row first (cancel it, or let it send before the flip):',
    );
    for (const r of over) {
      console.log(`  ${r.broadcast_id}  status=${r.status}  estimated=${r.estimated_recipient_count}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    'Nothing in flight exceeds the bound — no row can be stranded by a change to what dispatch compares against.',
  );
}

main().catch((e: unknown) => {
  console.error('inventory failed:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
