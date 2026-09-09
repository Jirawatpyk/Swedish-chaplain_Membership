/**
 * 108 T094 — read-only outbox inventory: what is in flight, and how large.
 *
 * **RUN THIS BEFORE MERGING PHASE 9. A row above the bound WILL be refused.**
 *
 * Round 3 finding 3-11 — this header has now been wrong twice, in opposite
 * directions, and the second time it was marked "CORRECTED". Both versions
 * described a model that was not in the code:
 *
 *   - the FIRST described an interim clamp that never merged;
 *   - the "CORRECTED" one described Phase 9b's split/batch model, which
 *     `ca51f59a1` DELETED on this same branch — 42 files, both crons, the
 *     manifests repo. It told the operator that rows above the bound are
 *     "SPLIT and delivered across ticks — no action needed", and named
 *     `FEATURE_F71A_US1_PAGINATION` as the ceiling knob after the gate had
 *     moved to `FEATURE_F7_IMPORT_AUDIENCE`.
 *
 * There is no split path. `currentAudienceCeiling()` is
 * `isF7ImportAudienceEnabled() ? configured : min(configured, 500)`, and
 * `FEATURE_F7_IMPORT_AUDIENCE` defaults FALSE — which is its state at merge.
 * So merging Phase 9 moves the ENFORCED ceiling from 5,000 to 500, unflagged,
 * and every in-flight row above 500 is refused terminally at its next tick.
 *
 * That refusal is deliberate (`reviews/cutover.md` § 5): 501–5,000 is accepted
 * today and ALREADY fails silently, because 300 s of the serial push drains
 * ~623. The refusal replaces a silent non-delivery with a legible error. But it
 * is still a refusal, and this script exists so the operator meets those rows
 * before the deploy rather than after.
 *
 * What it is for, stated once. `currentAudienceCeiling()` is compared at count,
 * submit AND dispatch. A broadcast sitting in `submitted` or `approved` was
 * accepted under whatever ceiling was live at SUBMIT; its next dispatch tick
 * compares it against the ceiling live THEN. Anything that lowers that number
 * can strand a row that was legal when submitted — this merge, or later turning
 * `FEATURE_CONTACT_MARKETING_RECIPIENTS` off (50,000 → 5,000).
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
 * Exit 0 = nothing in flight exceeds the bound (safe to deploy); 1 = at least
 * one in-flight row is above it. Decide per row BEFORE deploying — cancel it, or
 * let it send under the current ceiling first.
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
      'ACTION REQUIRED. These sit above the enforced ceiling. There is no split path — `ca51f59a1` deleted it — so each row below is refused TERMINALLY at its next dispatch tick: status `failed_to_dispatch`, an append-only audit row, and an FR-021 failure email to the member who submitted it. The member finds out. Decide per row BEFORE deploying: cancel it, or let it send under the current ceiling first.',
    );
    console.log(
      `(Merging Phase 9 with FEATURE_F7_IMPORT_AUDIENCE unset — its default, and its state at merge — moves the enforced ceiling to ${bound}. Turning FEATURE_CONTACT_MARKETING_RECIPIENTS off later narrows 50,000 to 5,000 the same way.)`,
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
  console.log(
    'Note: this answers ONLY the ceiling question. It is not a general go/no-go for the deploy.',
  );
}

main().catch((e: unknown) => {
  console.error('inventory failed:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
