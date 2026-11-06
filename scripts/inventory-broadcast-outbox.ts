/**
 * 108 T094 — read-only outbox inventory: what is in flight, and how large.
 *
 * **RUN THIS BEFORE LOWERING THE CEILING. A row above the bound WILL be refused.**
 *
 * The bound is `currentAudienceCeiling()`, which since spec 140 s4 is
 * `BROADCAST_AUDIENCE_CEILING` (default 900) and nothing else: no flag moves it.
 * It is compared at count, submit AND dispatch. A broadcast sitting in
 * `submitted` or `approved` was accepted under whatever ceiling was live at
 * SUBMIT; its next dispatch tick compares it against the ceiling live THEN. So
 * lowering the value, or deploying a change that does, can strand a row that
 * was legal when submitted, and this script exists so the operator meets those
 * rows before the deploy rather than after.
 *
 * History, kept because this header was wrong twice before: 108 Phase 9 moved
 * the enforced bound from 5,000 to 500 with the import flag off, and spec 140
 * s4 moved it to 900 when the import leg became the only leg.
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
 * (`failTerminally` in `build-audience-tick.ts`). The member finds out.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
// Round 4 F12 — the ENFORCED ceiling, read from the same function the send path
// reads, not the raw constant. See the `bound` assignment below.
import { currentAudienceCeiling } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { IN_PROGRESS_BROADCAST_STATUSES } from '@/modules/broadcasts/domain/stage/in-progress-statuses';

/**
 * F119 T051 — "in flight" is the Domain's in-progress set (which now carries
 * the four approval-round stages) plus the two send stages. Derived rather
 * than hand-listed: a report that silently hides five stages is worse than no
 * report. Every in-progress row can still reach `approved` and a dispatch tick,
 * so every one of them is ACTIONABLE below; the send stages are not.
 */
const IN_FLIGHT_STATUSES: ReadonlyArray<string> = [
  ...IN_PROGRESS_BROADCAST_STATUSES,
  'sending',
  'partially_sent',
];
const inFlightSql = sql.join(
  IN_FLIGHT_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

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
  // `currentAudienceCeiling()` is what the send path itself compares against,
  // so the script cannot disagree with it. Deliberately the real function
  // rather than the env value re-read here: this header narrates two earlier
  // wrong versions of the bound, and both were copies drifting from source.
  const bound = currentAudienceCeiling();

  console.log('');
  console.log('=== 108 T094 — broadcast outbox inventory (read-only, counts only) ===');
  console.log(`tenant: ${tenantId}`);
  console.log(`bound:  currentAudienceCeiling() = ${bound} (BROADCAST_AUDIENCE_CEILING)`);
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
         AND b.status IN (${inFlightSql})
       GROUP BY b.status
       ORDER BY b.status
    `)) as unknown as StatusRow[];

    const overRows = (await tx.execute(sql`
      SELECT b.broadcast_id::text                       AS broadcast_id,
             b.status::text                             AS status,
             b.estimated_recipient_count::int           AS estimated_recipient_count
        FROM broadcasts b
       WHERE b.tenant_id = ${tenantId}
         AND b.status IN (${inFlightSql})
         AND b.estimated_recipient_count > ${bound}
       ORDER BY b.estimated_recipient_count DESC
       LIMIT 50
    `)) as unknown as OverRow[];

    return { rows: statusRows, over: overRows };
  });

  if (rows.length === 0) {
    console.log(`in flight (${IN_FLIGHT_STATUSES.join(' / ')}): NONE`);
  } else {
    for (const r of rows) {
      console.log(
        `${r.status.padEnd(24)} n=${String(r.n).padStart(4)}  max_estimated_recipients=${String(r.max_est).padStart(6)}  over_bound=${r.over_bound}`,
      );
    }
  }

  const totalOver = rows.reduce((acc, r) => acc + r.over_bound, 0);
  console.log('');
  console.log(`rows above the bound: ${totalOver}`);

  // Round 4 F12, second half — only rows the DISPATCH CRON can still claim are
  // actionable. It selects `status = 'approved'` (and `submitted` reaches
  // `approved` by an admin action), so a `sending` or `partially_sent` row has no
  // next dispatch tick to be refused at. Telling an operator to cancel one of
  // those would be a wrong instruction on a pre-merge checklist — and it is what
  // this script printed, because the ACTION REQUIRED text was written against a
  // query that inventories four statuses.
  const ACTIONABLE: ReadonlySet<string> = new Set(IN_PROGRESS_BROADCAST_STATUSES);
  const actionable = over.filter((r) => ACTIONABLE.has(r.status));
  const informational = over.filter((r) => !ACTIONABLE.has(r.status));

  if (actionable.length > 0) {
    console.log('');
    console.log(
      'ACTION REQUIRED. These sit above the enforced ceiling AND the dispatch cron can still claim them, so each is refused TERMINALLY at its next tick: status `failed_to_dispatch`, an append-only audit row, and an FR-021 failure email to the member who submitted it. The member finds out. Decide per row BEFORE deploying: cancel it, or let it send under the current ceiling first.',
    );
    console.log(
      `(The enforced ceiling is BROADCAST_AUDIENCE_CEILING = ${bound} in the env this ran under. Run it again with the value you are about to deploy.)`,
    );
    for (const r of actionable) {
      console.log(`  ${r.broadcast_id}  status=${r.status}  estimated=${r.estimated_recipient_count}`);
    }
  }

  if (informational.length > 0) {
    console.log('');
    console.log(
      'FOR INFORMATION ONLY — above the bound, but past the point the dispatch cron claims rows (`sending` / `partially_sent`). No ceiling check runs against these again, so there is nothing to decide before deploying. Listed because a count above the bound with nothing to act on is otherwise indistinguishable from a missed row.',
    );
    for (const r of informational) {
      console.log(`  ${r.broadcast_id}  status=${r.status}  estimated=${r.estimated_recipient_count}`);
    }
  }

  if (actionable.length > 0) {
    process.exitCode = 1;
    return;
  }
  if (informational.length > 0) {
    console.log('');
    console.log(
      'Nothing ACTIONABLE above the bound — exit 0. The ceiling question is answered; this is not a general go/no-go for the deploy.',
    );
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
