/**
 * 108 T094 — read-only outbox inventory, run BEFORE any deploy that lowers the
 * enforced audience ceiling and before the flag flip.
 *
 * Why it exists: `currentAudienceCeiling()` is compared at count, submit AND
 * dispatch. A broadcast already sitting in `submitted` or `approved` was
 * accepted under whatever ceiling was live when it was submitted; the next
 * dispatch tick compares it against the ceiling that is live THEN. Lowering
 * the ceiling (108's `DELIVERABLE_RECIPIENTS_PER_TICK = 800`) can therefore
 * strand a row that was legal at submit time. This prints the two numbers that
 * decide whether that can happen: how many rows are in flight, and the largest
 * `estimated_recipient_count` among them.
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
 * Exit 0 = nothing in flight exceeds the bound (safe to deploy the lower
 * ceiling); 1 = at least one in-flight row is above it — decide per row before
 * deploying: cancel it, let it send under the current ceiling first, or accept
 * that it will be refused.
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
      'These were accepted under a higher ceiling and will be REFUSED once the lower one deploys. Decide per row (cancel, let it send first, or accept the refusal):',
    );
    for (const r of over) {
      console.log(`  ${r.broadcast_id}  status=${r.status}  estimated=${r.estimated_recipient_count}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Nothing in flight exceeds the bound — safe to deploy the lower ceiling.');
}

main().catch((e: unknown) => {
  console.error('inventory failed:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
