/**
 * A portal member that owns no invoices, minted fresh for one spec run
 * (portal-invoices US3 AS3, the empty state).
 *
 * Why not the shared `e2e-member-empty` persona ("E2E Echo Co"): about ten
 * specs sign in as it for good standing (`goodStandingMemberCredentials`), so
 * any of them, or a manual relay check, can leave it with invoices, and an
 * issued tax document cannot be deleted. On dev it gained two paid invoices
 * from 1 Nov 2026, which turned AS3 red on every branch. A member made for
 * this run, under a random suffix, is one nothing else can bill.
 *
 * Seeds, in the `swecham` tenant, a DUMMY (synthetic, not real-PII) member on
 * an existing active plan, with no renewal cycle (good standing, as Echo), its
 * primary contact linked to a fresh `member` user that has a password.
 * `cleanup()` removes them, and refuses if the member gained an invoice, so a
 * leak shows up instead of being deleted out of sight.
 *
 * No-op (returns null) when DATABASE_URL is missing or the tenant has no
 * active plan.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import { openSeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const LABEL = 'e2e seed no-invoice-member';

export interface NoInvoiceMemberSeed {
  readonly email: string;
  readonly password: string;
  /** Deletes the rows this seed made; throws if the member has an invoice. */
  readonly cleanup: () => Promise<void>;
}

export async function seedNoInvoiceMember(): Promise<NoInvoiceMemberSeed | null> {
  const client = openSeedClient(LABEL);
  if (!client) return null;
  const { sql } = client;

  const suffix = randomBytes(4).toString('hex');
  const email = `e2e-as3-${suffix}@swecham.test`;
  const password = `E2e-as3-${randomBytes(9).toString('base64url')}`;
  const userId = randomUUID();
  const memberId = randomUUID();
  const contactId = randomUUID();

  try {
    const sourceRows = await sql<{ plan_id: string; plan_year: number }[]>`
      SELECT plan_id, plan_year FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL AND is_active = true
      ORDER BY plan_year DESC, created_at ASC
      LIMIT 1
    `;
    const source = sourceRows[0];
    if (!source) {
      console.warn(`[${LABEL}] no active plan in tenant ${TENANT_ID}; skipping`);
      await client.end();
      return null;
    }

    // Sweep leftovers from runs killed before their cleanup (worker loss,
    // timeout): AS3 members over an hour old that never gained an invoice.
    await sql.begin(async (tx) => {
      const stale = await tx<{ member_id: string; user_id: string | null }[]>`
        SELECT m.member_id, c.linked_user_id AS user_id
        FROM members m
        JOIN contacts c ON c.tenant_id = m.tenant_id AND c.member_id = m.member_id
        JOIN users u ON u.id = c.linked_user_id
        WHERE m.tenant_id = ${TENANT_ID}
          AND m.company_name LIKE 'E2E AS3 Co %'
          AND u.email LIKE 'e2e-as3-%@swecham.test'
          AND u.created_at < now() - interval '1 hour'
          AND NOT EXISTS (
            SELECT 1 FROM invoices i WHERE i.tenant_id = m.tenant_id AND i.member_id = m.member_id
          )
      `;
      for (const row of stale) {
        await tx`DELETE FROM contacts WHERE tenant_id = ${TENANT_ID} AND member_id = ${row.member_id}::uuid`;
        await tx`DELETE FROM members WHERE tenant_id = ${TENANT_ID} AND member_id = ${row.member_id}::uuid`;
        if (row.user_id) await tx`DELETE FROM users WHERE id = ${row.user_id}::uuid`;
      }
    });

    const passwordHash = await argon2Hasher.hash(password);
    // `member_number` is per-tenant UNIQUE. A band of its own (8_000_000+),
    // clear of the allocator's 1..N and of the other dummy seeds' 990_000+,
    // wide enough that two runs at once (chromium + mobile-chrome) don't collide.
    const memberNumber = 8_000_000 + Math.floor(Math.random() * 1_000_000);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, email, role, status, password_hash, display_name, last_password_changed_at)
        VALUES (${userId}::uuid, ${email}, 'member', 'active', ${passwordHash}, 'E2E AS3 Member', now())
      `;
      await tx`
        INSERT INTO members (
          tenant_id, member_id, member_number, company_name, country,
          plan_id, plan_year, registration_fee_paid, registration_date, status
        )
        VALUES (
          ${TENANT_ID}, ${memberId}::uuid, ${memberNumber}, ${`E2E AS3 Co ${suffix}`}, 'TH',
          ${source.plan_id}, ${source.plan_year}, true, '2020-01-01', 'active'
        )
      `;
      await tx`
        INSERT INTO contacts (
          tenant_id, contact_id, member_id, first_name, last_name, email, is_primary, linked_user_id
        )
        VALUES (
          ${TENANT_ID}, ${contactId}::uuid, ${memberId}::uuid, 'E2E', ${`AS3 ${suffix}`},
          ${email}, true, ${userId}::uuid
        )
      `;
    });
  } catch (e) {
    await client.end();
    throw e;
  }
  await client.end();
  console.log(`[${LABEL}] OK member=${memberId} in tenant ${TENANT_ID}`);

  const cleanup = async (): Promise<void> => {
    const c = openSeedClient(LABEL);
    if (!c) return;
    try {
      const invoiceRows = await c.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM invoices
        WHERE tenant_id = ${TENANT_ID} AND member_id = ${memberId}::uuid
      `;
      if ((invoiceRows[0]?.n ?? 0) > 0) {
        throw new Error(
          `[${LABEL}] member ${memberId} gained an invoice during the run; rows left in place for inspection`,
        );
      }
      await c.sql.begin(async (tx) => {
        await tx`DELETE FROM contacts WHERE tenant_id = ${TENANT_ID} AND member_id = ${memberId}::uuid`;
        await tx`DELETE FROM members WHERE tenant_id = ${TENANT_ID} AND member_id = ${memberId}::uuid`;
        // Sessions cascade from users; audit_log keeps its rows (actor is text, no FK).
        await tx`DELETE FROM users WHERE id = ${userId}::uuid`;
      });
    } finally {
      await c.end();
    }
  };

  return { email, password, cleanup };
}
