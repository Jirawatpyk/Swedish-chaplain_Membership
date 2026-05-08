/**
 * F8 Phase 6 Wave I-2 — At-risk demo data seeder.
 *
 * Populates F3 `members.risk_score*` columns with sample at-risk data
 * so the /admin/members directory + /admin/renewals widget have visible
 * risk badges during local dev without waiting for the production
 * cron-job.org schedule (Sun 02:00 BKK).
 *
 * NOT for production use — this is a dev/demo affordance. Production
 * data is populated by `recomputeAtRiskScoresBatch` (T159b) triggered
 * weekly by cron-job.org.
 *
 * Usage:
 *   pnpm tsx scripts/seed-at-risk-demo.ts
 *
 * Idempotent: re-running overwrites the same 5 members with the same
 * sample bands. Other members are unaffected.
 *
 * Source data: top 5 active SweCham members by created_at — picks the
 * first 5 each run so the script remains deterministic across re-seeds.
 */
import postgres from 'postgres';

interface Sample {
  readonly band: 'warning' | 'at-risk' | 'critical';
  readonly score: number;
  readonly factors: Record<string, number>;
}

const SAMPLES: ReadonlyArray<Sample> = [
  {
    band: 'critical',
    score: 78,
    factors: {
      invoices_overdue_count_gt_zero: 25,
      days_since_last_payment_gt_180: 10,
      e_blast_quota_under_30pct: 15,
      tier_downgraded_last_12mo: 15,
      days_since_contact_update_gt_365: 5,
    },
  },
  {
    band: 'critical',
    score: 80,
    factors: {
      invoices_overdue_count_gt_zero: 25,
      days_since_last_payment_gt_180: 10,
      e_blast_quota_under_30pct: 15,
      tier_downgraded_last_12mo: 15,
      events_attended_last_12mo_zero: 25,
    },
  },
  {
    band: 'at-risk',
    score: 65,
    factors: {
      invoices_overdue_count_gt_zero: 25,
      days_since_last_payment_gt_180: 10,
      e_blast_quota_under_30pct: 15,
      days_since_contact_update_gt_365: 5,
    },
  },
  {
    band: 'at-risk',
    score: 60,
    factors: {
      events_attended_last_12mo_zero: 25,
      invoices_overdue_count_gt_zero: 25,
      days_since_last_payment_gt_180: 10,
    },
  },
  {
    band: 'warning',
    score: 35,
    factors: {
      invoices_overdue_count_gt_zero: 25,
      days_since_contact_update_gt_365: 5,
      e_blast_quota_under_30pct: 15,
    },
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      '[seed-at-risk-demo] DATABASE_URL missing — run with --env-file=.env.local',
    );
    process.exit(1);
  }
  const sql = postgres(url);
  try {
    const members = await sql<
      { member_id: string; company_name: string }[]
    >`
      SELECT member_id, company_name
      FROM members
      WHERE tenant_id = 'swecham' AND status = 'active'
      ORDER BY created_at ASC
      LIMIT ${SAMPLES.length}
    `;
    if (members.length === 0) {
      console.error(
        '[seed-at-risk-demo] No active SweCham members found — seed members first.',
      );
      process.exit(1);
    }
    const now = new Date();
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      const s = SAMPLES[i]!;
      await sql`
        UPDATE members
        SET
          risk_score = ${s.score},
          risk_score_band = ${s.band},
          risk_score_factors = ${JSON.stringify(s.factors)}::jsonb,
          risk_score_last_computed_at = ${now}
        WHERE tenant_id = 'swecham'
          AND member_id = ${m.member_id}
      `;
      console.log(
        `[seed-at-risk-demo] ${m.company_name.padEnd(30)} → ${s.band.padEnd(8)} score=${s.score}`,
      );
    }
    console.log(
      `[seed-at-risk-demo] OK — populated ${members.length} members with sample at-risk data`,
    );
  } finally {
    await sql.end();
  }
}

void main().catch((e: unknown) => {
  console.error('[seed-at-risk-demo]', e);
  process.exit(1);
});
