/**
 * scripts/reset-broadcast-quota.ts
 *
 * DEV/TEST UTILITY — frees a member's annual E-Blast (F7 broadcast) quota by
 * deleting that member's RESERVED/PRE-SEND broadcast rows, so the compose →
 * submit → approve → dispatch flow can be re-tested without hitting
 * `broadcast_quota_blocked`.
 *
 * Why this exists: `countForMemberQuota` counts `submitted` + `approved` as
 * "reserved" (in-flight broadcasts that still hold a quota slot). Fix D1
 * (f7-broadcast-send-hardening) removed `failed_to_dispatch` from the reserved
 * count — that status is now correctly treated as consumed-but-released so it
 * no longer causes a permanent quota lockout. This script clears a test
 * member's in-flight (`submitted`/`approved`) broadcasts so the compose →
 * submit → approve → dispatch flow can be re-tested without hitting
 * `broadcast_quota_blocked`.
 *
 * WHAT IT DELETES (and what it deliberately does NOT):
 *   It removes ONLY broadcasts in an ALLOW-LISTED pre-send status
 *   (`draft`/`submitted`/`approved` — DELETABLE_STATUSES) that carry NO F119
 *   approval-round history (no `broadcast_versions` row, hence no
 *   `broadcast_member_decisions` row) AND do NOT still hold a live Resend
 *   audience. Every other status is kept: the send stages (append-only
 *   deliveries), the terminal ones (`rejected`/`cancelled`/`failed_to_dispatch`
 *   /`expired_no_member_response` — they reserve nothing, so deleting them
 *   never freed quota), the four approval-round stages, and any status a later
 *   migration adds (an allow-list fails closed; the old deny-list did not).
 *   WHY the history rule (T166 security LOW): deleting a broadcast CASCADEs to
 *   its versions and decisions, and 0308's append-only trigger lets that
 *   cascade through (`pg_trigger_depth() > 1`), so the old `status NOT IN
 *   send-stages` filter silently destroyed the SC-002 proof — which version the
 *   member was shown and who approved it. A round-stage row still holds quota:
 *   cancel it from /admin/broadcasts/<id> (cancel releases the allowance and
 *   keeps the history). A kept row is reported, never silently skipped.
 *   Live audience (Finding E): a row whose `resend_audience_id IS NOT NULL AND
 *   audience_deleted_at IS NULL` is LEFT INTACT so the `cleanup-audiences` cron
 *   can still GC its Resend audience — deleting the broadcast row first would
 *   orphan that audience permanently (the cron lists eligible audiences by
 *   broadcast row).
 *   Deliveries: `broadcast_deliveries` is append-only (trigger `broadcast_deliveries_no_delete`
 *   + no DELETE grant for chamber_app, migrations 0065/0225), but since 0310 it
 *   has a REAL FK on (tenant_id, broadcast_id) → broadcasts ON DELETE CASCADE,
 *   and the trigger admits a DELETE that arrives through that cascade
 *   (`pg_trigger_depth() > 1`). Deleting a broadcast therefore DELETES its
 *   deliveries. What keeps them safe here is the `DELETABLE_STATUSES`
 *   allow-list: only pre-send rows are deleted, and a delivery row exists only
 *   once Resend reports an event for a SENT E-Blast.
 *   `broadcast_batch_manifests` cascades ON DELETE with the broadcast
 *   (migration 0218), so manifests are handled automatically.
 *
 * Safety:
 *   - Refuses to touch a member that does NOT look like a test fixture
 *     (BOTH: company_name starts "E2E"/"ZZZ" AND email is e2e*@swecham.test)
 *     unless `--force` is passed. Never run --force against a real member.
 *   - `--dry-run` prints what it WOULD delete and changes nothing.
 *   - Audit-log rows are append-only and are intentionally NOT touched
 *     (Constitution Principle I); only reserved/pre-send broadcasts (and their
 *     cascading batch manifests) are removed. The compliance trail of past
 *     sends — broadcasts that reached a send stage and their deliveries —
 *     survives untouched, and so does every F119 version / member decision.
 *   - PRODUCTION GUARD (fail-closed): refuses when the resolved DATABASE_URL
 *     host matches `TEST_DB_HOST_BLOCKLIST`, AND when that blocklist is unset
 *     or still the `.env.example` placeholder (prod cannot be ruled out), unless
 *     `--confirm-prod` is passed. Same rule as
 *     scripts/backfill-membership-coverage.ts; the placeholders come from the
 *     shared tests/helpers/db-host-guard.ts so the two cannot drift.
 *
 * Usage:
 *   pnpm tsx scripts/reset-broadcast-quota.ts [memberEmail] [--dry-run] [--force] [--confirm-prod]
 *   # defaults memberEmail to $E2E_MEMBER_EMAIL or e2e-member@swecham.test
 *
 * Reads DATABASE_URL and TEST_DB_HOST_BLOCKLIST from .env.local (the process
 * env wins when already set). Imports nothing from `src/`.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { DB_HOST_BLOCKLIST_PLACEHOLDERS } from '../tests/helpers/db-host-guard';

// Load `.env.local` into process.env so the prod guard sees
// TEST_DB_HOST_BLOCKLIST (the old loader regex-read DATABASE_URL only, so the
// blocklist was always unset here). Missing file is not an error — the ambient
// env is used. Same idiom as scripts/run-migrations.ts.
try {
  process.loadEnvFile?.('.env.local');
} catch {
  // .env.local absent — use the ambient process.env.
}

const TENANT = process.env.RESET_TENANT ?? 'swecham';

/**
 * The ONLY statuses this script may delete — an allow-list, so a status added
 * by a later migration is kept by default. Send stages carry append-only
 * `broadcast_deliveries` (trigger `broadcast_deliveries_no_delete`, no DELETE
 * grant for chamber_app — migrations 0065/0225), which since 0310 would leave
 * WITH the broadcast by ON DELETE CASCADE; terminal statuses reserve
 * nothing and may carry F119 decisions; the approval-round stages always carry
 * versions. A row in one of these three statuses is still kept when it carries
 * approval-round history (see the DELETE).
 */
const DELETABLE_STATUSES = ['draft', 'submitted', 'approved'] as const;

/**
 * F119 T051 — the statuses that RESERVE a quota slot: data-model § 9's
 * `IN_PROGRESS_BROADCAST_STATUSES` (hand-mirrored — this script imports nothing
 * from `src/` and runs on bare `postgres`). The four approval-round stages hold
 * the allowance exactly like `submitted` / `approved`, so a report that left
 * them out would print "reserved=0" for a member who cannot submit. They are
 * NOT deleted here (T166 security LOW — their versions and decisions are the
 * SC-002 proof, and the CASCADE would take them); the report counts them as
 * still reserved and says how to release them.
 */
const RESERVING_STATUSES: ReadonlyArray<string> = [
  'submitted',
  'approved',
  'in_design',
  'awaiting_member_approval',
  'changes_requested',
  'member_approved',
];

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync('.env.local', 'utf8');
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fall through */
  }
  throw new Error('DATABASE_URL not found (env or .env.local)');
}

/**
 * True unless the target is positively known NOT to be production: a blocklist
 * fragment in the URL means prod, and an unset or placeholder blocklist means
 * prod cannot be ruled out — both fail closed.
 */
function targetMayBeProd(dbUrl: string): boolean {
  const usable = (process.env.TEST_DB_HOST_BLOCKLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v) => !DB_HOST_BLOCKLIST_PLACEHOLDERS.includes(v));
  return usable.length === 0 || usable.some((needle) => dbUrl.includes(needle));
}

function isTestMember(companyName: string | null, email: string): boolean {
  const c = (companyName ?? '').toUpperCase();
  // Require BOTH a test-fixture company name AND a test email address so a real
  // member who happens to be literally named "E2E …" (real email) can never
  // slip through. The `--force` escape stays for deliberate overrides.
  return (
    (c.startsWith('E2E') || c.startsWith('ZZZ')) &&
    /^e2e.*@swecham\.test$/i.test(email)
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const email =
    args.find((a) => !a.startsWith('--')) ??
    process.env.E2E_MEMBER_EMAIL ??
    'e2e-member@swecham.test';

  const dbUrl = loadDatabaseUrl();
  // Fail closed BEFORE connecting — dry-run included (it reads member PII).
  if (targetMayBeProd(dbUrl) && !args.includes('--confirm-prod')) {
    console.error(
      'REFUSING: the target may be PRODUCTION (DATABASE_URL host matched ' +
        'TEST_DB_HOST_BLOCKLIST, or the blocklist is unset / still the ' +
        '.env.example placeholder, so prod cannot be ruled out). This is a ' +
        'dev/test utility — re-run with --confirm-prod only once you have ' +
        'verified the target.',
    );
    process.exit(3);
  }

  const sql = postgres(dbUrl, { max: 1 });
  try {
    // Resolve every member this user is linked to (a user can be a contact of
    // more than one member; broadcasts are scoped by requested_by_member_id).
    const members = await sql<
      Array<{ member_id: string; company_name: string | null }>
    >`
      SELECT DISTINCT m.member_id, m.company_name
      FROM users u
      JOIN contacts c ON c.linked_user_id = u.id AND c.tenant_id = ${TENANT}
      JOIN members m ON m.member_id = c.member_id AND m.tenant_id = ${TENANT}
      WHERE lower(u.email) = ${email.toLowerCase()}
    `;
    if (members.length === 0) {
      console.error(`No member found for ${email} in tenant ${TENANT}.`);
      process.exit(1);
    }

    for (const m of members) {
      if (!isTestMember(m.company_name, email) && !force) {
        console.error(
          `REFUSING: ${m.company_name} (${m.member_id}) does not look like a ` +
            `test member. Re-run with --force only if you are certain.`,
        );
        process.exit(2);
      }
    }

    const memberIds = members.map((m) => m.member_id);

    const before = await sql<Array<{ status: string; n: number }>>`
      SELECT status::text AS status, COUNT(*)::int AS n
      FROM broadcasts
      WHERE tenant_id = ${TENANT} AND requested_by_member_id IN ${sql(memberIds)}
      GROUP BY status ORDER BY n DESC
    `;
    const reserved = before
      .filter((r) => RESERVING_STATUSES.includes(r.status))
      .reduce((s, r) => s + r.n, 0);
    const used = before
      .filter((r) => ['sent', 'partial_delivery_accepted'].includes(r.status))
      .reduce((s, r) => s + r.n, 0);

    console.log(
      `Member(s): ${members.map((m) => `${m.company_name} (${m.member_id})`).join(', ')}`,
    );
    console.log('Current broadcasts:', before.length ? '' : '(none)');
    for (const r of before) console.log(`  ${r.n}\t${r.status}`);
    console.log(`Quota now → reserved=${reserved} used=${used}`);

    // One query evaluates the EXACT predicate the DELETE uses, so the dry-run
    // prediction and the DELETE can never disagree (Finding E's rule):
    //   - status in DELETABLE_STATUSES (allow-list);
    //   - no approval-round history — a broadcast with a `broadcast_versions`
    //     row is kept, because the CASCADE would take its versions AND its
    //     `broadcast_member_decisions` (0308's append-only trigger lets the
    //     cascade through at pg_trigger_depth() > 1), i.e. the SC-002 proof;
    //     a decision always references a version, so "no version" implies "no
    //     decision" (T166 security LOW);
    //   - Finding E (PR-2 #5 fix-wave): no LIVE Resend audience
    //     (resend_audience_id set, audience_deleted_at NULL) — deleting that row
    //     would orphan the audience at Resend, because the cleanup-audiences
    //     cron lists eligible audiences by broadcast row.
    const [plan] = await sql<
      Array<{
        deletable: number;
        kept_history: number;
        kept_audience: number;
        reserved_after: number;
      }>
    >`
      WITH scoped AS (
        SELECT
          b.status::text AS status,
          EXISTS (
            SELECT 1 FROM broadcast_versions v
            WHERE v.tenant_id = b.tenant_id AND v.broadcast_id = b.broadcast_id
          ) AS has_history,
          (b.resend_audience_id IS NULL OR b.audience_deleted_at IS NOT NULL) AS audience_free
        FROM broadcasts b
        WHERE b.tenant_id = ${TENANT} AND b.requested_by_member_id IN ${sql(memberIds)}
      ), judged AS (
        SELECT
          status,
          has_history,
          audience_free,
          (status IN ${sql(DELETABLE_STATUSES)} AND NOT has_history AND audience_free) AS goes
        FROM scoped
      )
      SELECT
        COUNT(*) FILTER (WHERE goes)::int AS deletable,
        COUNT(*) FILTER (WHERE has_history)::int AS kept_history,
        COUNT(*) FILTER (
          WHERE status IN ${sql(DELETABLE_STATUSES)} AND NOT has_history AND NOT audience_free
        )::int AS kept_audience,
        COUNT(*) FILTER (WHERE status IN ${sql(RESERVING_STATUSES)} AND NOT goes)::int
          AS reserved_after
      FROM judged
    `;
    const deletable = plan?.deletable ?? 0;
    const keptHistory = plan?.kept_history ?? 0;
    const keptAudience = plan?.kept_audience ?? 0;
    const reservedAfter = plan?.reserved_after ?? reserved;

    if (keptHistory > 0) {
      console.log(
        `Note: ${keptHistory} broadcast(s) carry F119 approval-round history ` +
          `(versions / member decisions — the SC-002 proof) and are kept. A kept ` +
          `row that still reserves the allowance is released by cancelling it ` +
          `from /admin/broadcasts/<id>; the history stays.`,
      );
    }
    if (keptAudience > 0) {
      console.log(
        `Note: ${keptAudience} broadcast(s) hold a live Resend audience ` +
          `and are left for the cleanup-audiences cron (not deleted here).`,
      );
    }
    if (deletable === 0) {
      console.log(
        `Nothing to delete. Quota stays → reserved=${reservedAfter} used=${used}`,
      );
      return;
    }
    if (dryRun) {
      console.log(
        `[dry-run] would delete ${deletable} draft/submitted/approved broadcast(s) ` +
          `(send-stage, terminal and approval-round rows left intact).`,
      );
      // `used` counts send-stage broadcasts, which are NOT deleted, so it is
      // unchanged; `reserved_after` counts the reserving rows the DELETE keeps.
      console.log(`[dry-run] quota after → reserved=${reservedAfter} used=${used}`);
      return;
    }

    // `broadcast_batch_manifests` cascades ON DELETE with the broadcast row
    // (migration 0218), so manifests are handled too. The WHERE is the `goes`
    // predicate above, verbatim.
    const deleted = await sql.begin(async (tx) => {
      const del = await tx`
        DELETE FROM broadcasts b
        WHERE b.tenant_id = ${TENANT}
          AND b.requested_by_member_id IN ${tx(memberIds)}
          AND b.status IN ${tx(DELETABLE_STATUSES)}
          -- T166 security LOW: never cascade away approval-round history.
          AND NOT EXISTS (
            SELECT 1 FROM broadcast_versions v
            WHERE v.tenant_id = b.tenant_id AND v.broadcast_id = b.broadcast_id
          )
          -- Finding E: never delete a row that still holds a live Resend
          -- audience — leave it for the cleanup-audiences cron to GC first.
          AND (b.resend_audience_id IS NULL OR b.audience_deleted_at IS NOT NULL)
      `;
      return del.count;
    });

    console.log(
      `Deleted ${deleted} draft/submitted/approved broadcast(s). ` +
        `Quota after → reserved=${reservedAfter} used=${used} ` +
        `(send-stage broadcasts + deliveries, terminal rows and approval-round ` +
        `history retained).`,
    );
    console.log(
      '(Audit-log entries, send-stage deliveries and F119 versions / decisions retained.)',
    );
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error('reset-broadcast-quota failed:', e);
  process.exit(1);
});
