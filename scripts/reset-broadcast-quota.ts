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
 *   It removes ONLY broadcasts whose status carries NO `broadcast_deliveries`
 *   — i.e. the reserved-holding + harmless pre-send rows
 *   (`draft`/`submitted`/`approved`/`rejected`/`cancelled`/`failed_to_dispatch`)
 *   — AND that do NOT still hold a live Resend audience. A row whose
 *   `resend_audience_id IS NOT NULL AND audience_deleted_at IS NULL` (e.g. a
 *   `failed_to_dispatch` broadcast that created its audience before failing) is
 *   LEFT INTACT so the `cleanup-audiences` cron can still GC its Resend
 *   audience — deleting the broadcast row first would orphan that audience
 *   permanently (the cron lists eligible audiences by broadcast row).
 *   Send-stage / consumed broadcasts
 *   (`sending`/`sent`/`partially_sent`/`partial_delivery_accepted`) and their
 *   append-only `broadcast_deliveries` rows are INTENTIONALLY LEFT INTACT.
 *   `broadcast_deliveries` is append-only (trigger `broadcast_deliveries_no_delete`
 *   + no DELETE grant for chamber_app, migrations 0065/0225) AND a logical FK only
 *   (no real FK on `broadcast_id`, 0065:32) — so this script NEVER deletes
 *   deliveries; it just never touches a broadcast that has any.
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
 *     survives untouched.
 *
 * Usage:
 *   pnpm tsx scripts/reset-broadcast-quota.ts [memberEmail] [--dry-run] [--force]
 *   # defaults memberEmail to $E2E_MEMBER_EMAIL or e2e-member@swecham.test
 *
 * Reads DATABASE_URL from .env.local (falls back to process.env.DATABASE_URL).
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const TENANT = process.env.RESET_TENANT ?? 'swecham';

/**
 * Statuses whose broadcasts have reached a send stage and therefore CARRY
 * append-only `broadcast_deliveries` rows. These broadcasts (and their
 * deliveries) are NEVER deleted by this script — deleting their deliveries
 * would trip the `broadcast_deliveries_no_delete` append-only trigger (and
 * is blocked by the absent DELETE grant for chamber_app, migrations
 * 0065/0225). The DELETE below removes only broadcasts NOT in this set.
 */
const SEND_STAGE_STATUSES = [
  'sending',
  'sent',
  'partially_sent',
  'partial_delivery_accepted',
] as const;

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

  const sql = postgres(loadDatabaseUrl(), { max: 1 });
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
      .filter((r) => ['submitted', 'approved'].includes(r.status))
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

    // Only reserved/pre-send broadcasts are deletable — send-stage rows carry
    // append-only deliveries and are left intact. Count just the deletable rows
    // so the dry-run prediction matches what the DELETE actually removes.
    const deletable = before
      .filter((r) => !SEND_STAGE_STATUSES.includes(r.status as never))
      .reduce((s, r) => s + r.n, 0);

    // Finding E (PR-2 #5 fix-wave): a deletable-by-status row can still hold a
    // LIVE Resend audience (resend_audience_id set, audience_deleted_at NULL) —
    // e.g. a failed_to_dispatch broadcast that created its audience before
    // failing. Deleting that row would orphan the audience at Resend because the
    // cleanup-audiences cron lists eligible audiences by broadcast row. Leave
    // such rows for the cron; count them so the prediction matches the DELETE.
    const liveAudienceSkipped =
      (
        await sql<Array<{ n: number }>>`
          SELECT COUNT(*)::int AS n
          FROM broadcasts
          WHERE tenant_id = ${TENANT}
            AND requested_by_member_id IN ${sql(memberIds)}
            AND status NOT IN ${sql(SEND_STAGE_STATUSES)}
            AND resend_audience_id IS NOT NULL
            AND audience_deleted_at IS NULL
        `
      )[0]?.n ?? 0;
    const actuallyDeletable = deletable - liveAudienceSkipped;
    if (liveAudienceSkipped > 0) {
      console.log(
        `Note: ${liveAudienceSkipped} broadcast(s) hold a live Resend audience ` +
          `and are left for the cleanup-audiences cron (not deleted here).`,
      );
    }
    if (actuallyDeletable === 0) {
      console.log('Nothing to reset (no reserved/pre-send broadcasts).');
      return;
    }
    if (dryRun) {
      console.log(
        `[dry-run] would delete ${actuallyDeletable} reserved/pre-send broadcast(s) ` +
          `(send-stage broadcasts + their append-only deliveries left intact).`,
      );
      // `used` counts send-stage broadcasts, which are NOT deleted, so it is
      // unchanged; reserved goes to 0 because every in-flight reserved row
      // (submitted/approved) is a pre-send status deleted by this script.
      console.log(`[dry-run] quota after → reserved=0 used=${used}`);
      return;
    }

    // Delete only reserved/pre-send broadcasts (zero deliveries). The
    // `broadcast_deliveries` rows of send-stage broadcasts are append-only and
    // are never touched; `broadcast_batch_manifests` cascades ON DELETE with
    // the broadcast row (migration 0218), so manifests are handled too.
    const deleted = await sql.begin(async (tx) => {
      const del = await tx`
        DELETE FROM broadcasts
        WHERE tenant_id = ${TENANT}
          AND requested_by_member_id IN ${tx(memberIds)}
          AND status NOT IN ${tx(SEND_STAGE_STATUSES)}
          -- Finding E: never delete a row that still holds a live Resend
          -- audience — leave it for the cleanup-audiences cron to GC first,
          -- else the audience is orphaned (the cron lists by broadcast row).
          AND (resend_audience_id IS NULL OR audience_deleted_at IS NOT NULL)
      `;
      return del.count;
    });

    console.log(
      `Deleted ${deleted} reserved/pre-send broadcast(s). ` +
        `Quota reset → reserved=0 used=${used} ` +
        `(send-stage broadcasts + deliveries retained).`,
    );
    console.log('(Audit-log entries + send-stage deliveries retained — append-only.)');
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error('reset-broadcast-quota failed:', e);
  process.exit(1);
});
