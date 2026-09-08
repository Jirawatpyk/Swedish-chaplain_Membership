/**
 * 108 T094 — seed SECONDARY contacts on the DEV branch so the 1:N audience can
 * be exercised end-to-end before the flag is flipped in production.
 *
 * Why this exists: prod has **150 members / 150 primaries / 0 secondary
 * contacts** (measured 2026-09-08), so flipping
 * `FEATURE_CONTACT_MARKETING_RECIPIENTS` there changes nothing observable —
 * `all_contacts` and `primary_only` resolve to the same 150 addresses. The
 * widening can only be seen where secondaries exist, and that is dev.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE YOU DISPATCH ANYTHING ON DEV
 *
 * The Neon branch is separate; **the Resend account is NOT**. `.env.local` and
 * `.env.production` carry the SAME `RESEND_BROADCASTS_API_KEY` and the SAME
 * `BROADCASTS_FROM_EMAIL` (`SweCham <noreply@dxtspace.com>`). A dispatch on dev
 * therefore sends real mail from the production sender identity, consumes the
 * same Free-plan 1,000-contact quota and 3 audience slots, and any bounce
 * lands in the production suppression list and on the production domain's
 * reputation.
 *
 * So this script **refuses to invent addresses**. You pass the ones you own:
 *
 *   SEED_SECONDARY_EMAILS="you+sec1@gmail.com,you+sec2@gmail.com"
 *
 * Use `+` sub-addresses of an inbox you control. Never seed `@example.com` and
 * then dispatch — that is the one combination that damages production.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Usage (DEV branch — the guard refuses prod):
 *   SEED_SECONDARY_EMAILS="you+sec1@gmail.com,you+sec2@gmail.com" \
 *   EXPORT_DOWNLOAD_TOKEN_SECRET='<any 32+ char dummy>' TENANT_SLUG=swecham \
 *   TSX_TSCONFIG_PATH=tsconfig.scripts.json \
 *   node --env-file=.env.local --import tsx scripts/seed-dev-secondary-contacts.ts
 *
 * Clean up afterwards (hard-deletes only the rows this script added):
 *   SEED_SECONDARY_MODE=remove … same env …
 *
 * Optional: `SEED_MEMBER_ID=<uuid>` to choose the member; otherwise the first
 * active member with a live primary contact is used.
 *
 * The primary-contact invariant (migration 0293) is untouched: this only ever
 * inserts rows with `is_primary = false`.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { assertDbHostNotBlocklisted } from '../tests/helpers/db-host-guard';

const MARKER = 'seed-dev-secondary';

interface MemberRow {
  readonly member_id: string;
  readonly company_name: string;
}

function parseEmails(raw: string | undefined): readonly string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = list.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad.length > 0) {
    throw new Error(`not an email address: ${bad.join(', ')}`);
  }
  // The one combination that hurts production: a fake address that will bounce
  // from the shared Resend account and land in the shared suppression list.
  const fake = list.filter((e) =>
    /@(example\.(com|org|net)|test|localhost|invalid)$/.test(e),
  );
  if (fake.length > 0) {
    throw new Error(
      `refusing to seed unroutable addresses (${fake.join(', ')}): dev shares ` +
        `production's Resend key and sender domain, so a bounce from these ` +
        `damages the production reputation and suppression list. Pass ` +
        `sub-addresses of an inbox you own instead.`,
    );
  }
  return list;
}

async function main(): Promise<void> {
  const tenantId = process.env.INVENTORY_TENANT_ID ?? 'swecham';
  const mode = process.env.SEED_SECONDARY_MODE === 'remove' ? 'remove' : 'add';

  // Fails CLOSED on an unset/placeholder blocklist as well as on a match.
  assertDbHostNotBlocklisted(
    process.env.DATABASE_URL ?? '',
    process.env.TEST_DB_HOST_BLOCKLIST,
    'seed-dev-secondary-contacts',
  );

  const emails = parseEmails(process.env.SEED_SECONDARY_EMAILS);
  if (mode === 'add' && emails.length === 0) {
    throw new Error(
      'SEED_SECONDARY_EMAILS is required: pass a comma-separated list of ' +
        'addresses you own (see the header — this script will not invent any).',
    );
  }

  console.log('');
  console.log(`=== 108 T094 — dev secondary-contact seed (${mode}) ===`);
  console.log(`tenant: ${tenantId}`);
  console.log('');

  await runInTenant(asTenantContext(tenantId), async (tx) => {
    if (mode === 'remove') {
      const gone = (await tx.execute(sql`
        DELETE FROM contacts
         WHERE tenant_id = ${tenantId}
           AND is_primary = false
           AND role_title = ${MARKER}
        RETURNING contact_id
      `)) as unknown as unknown[];
      console.log(`removed ${gone.length} seeded secondary contact(s).`);
      return;
    }

    const chosen = process.env.SEED_MEMBER_ID;
    // Mirror the resolver's OWN eligibility predicate, not a shorter version
    // of it (`drizzle-member-repo.ts` findMembersBySegmentForBroadcast:
    // status = 'active' AND erased_at IS NULL AND NOT halted). The first draft
    // of this query omitted the halt flag and picked a halted member, so the
    // seeded secondaries were invisible to every segment and the rehearsal
    // reported "the widening does not work" — a false alarm about the feature
    // caused by the seed. A fixture that can't appear in the audience is worse
    // than no fixture: it fails in the direction of a spurious bug report.
    const memberRows = (await tx.execute(sql`
      SELECT m.member_id::text AS member_id, m.company_name
        FROM members m
       WHERE m.tenant_id = ${tenantId}
         AND m.status = 'active'
         AND m.erased_at IS NULL
         AND m.broadcasts_halted_until_admin_review = false
         AND EXISTS (SELECT 1 FROM contacts c
                      WHERE c.tenant_id = m.tenant_id
                        AND c.member_id = m.member_id
                        AND c.is_primary
                        AND c.removed_at IS NULL)
         ${chosen ? sql`AND m.member_id = ${chosen}::uuid` : sql``}
       ORDER BY m.company_name
       LIMIT 1
    `)) as unknown as MemberRow[];

    const member = memberRows[0];
    if (member === undefined) {
      throw new Error(
        'no BROADCAST-ELIGIBLE member found (active, not erased, not halted, with a ' +
          'live primary contact). Seeding onto anything else produces contacts no ' +
          'segment can see.',
      );
    }
    console.log(`member: ${member.company_name} (${member.member_id})`);

    for (const [i, email] of emails.entries()) {
      await tx.execute(sql`
        INSERT INTO contacts (
          tenant_id, contact_id, member_id, first_name, last_name, email,
          role_title, is_primary
        ) VALUES (
          ${tenantId}, gen_random_uuid(), ${member.member_id}::uuid,
          'Seeded', ${'Secondary ' + String(i + 1)}, ${email},
          ${MARKER}, false
        )
        ON CONFLICT DO NOTHING
      `);
      console.log(`  + secondary: ${email}`);
    }

    const after = (await tx.execute(sql`
      SELECT COUNT(*) FILTER (WHERE is_primary)::int      AS primaries,
             COUNT(*) FILTER (WHERE NOT is_primary)::int  AS secondaries
        FROM contacts
       WHERE tenant_id = ${tenantId}
         AND member_id = ${member.member_id}::uuid
         AND removed_at IS NULL
    `)) as unknown as Array<{ primaries: number; secondaries: number }>;
    const counts = after[0];
    console.log('');
    console.log(
      `member now has ${counts?.primaries ?? '?'} primary + ${counts?.secondaries ?? '?'} secondary live contact(s).`,
    );
  });

  console.log('');
  console.log('Next: quickstart.md § "Dev rehearsal before the flip".');
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('seed failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
