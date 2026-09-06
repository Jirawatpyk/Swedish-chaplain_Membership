/**
 * 108 PR-D T062 — make sure the e2e MEMBER persona is linked to a live member
 * with a primary contact, so /portal/profile renders the contact block (and
 * the marketing toggle) instead of "Your account is not linked to a member".
 *
 * On a dev branch where the persona is already linked (the usual case after
 * `scripts/seed-e2e-user.ts` + the portal seeds) this is a no-op and returns
 * `{ seeded: false }`. Otherwise it inserts ONE member + ONE primary contact
 * with `linked_user_id = <persona user id>` under fixed ids (the `…108d0e…`
 * range) and the caller removes them in `afterAll`. Same BYPASSRLS seed
 * client and clone-a-plan technique as the other e2e seeds; simulated data
 * only.
 */
import { openSeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const SEED_LABEL = 'e2e seed portal-marketing';

const FIX = {
  memberId: '00000000-0000-4000-8000-00000108d0e1',
  contactId: '00000000-0000-4000-8000-00000108d0e2',
  planId: 'e2e-portal-marketing-plan',
  companyName: 'Portal Marketing Fixture Co (E2E)',
} as const;

export interface PortalMarketingSeed {
  /** True when this helper created the member + contact (caller cleans up). */
  readonly seeded: boolean;
  /** The persona's own contact email (for the suppression-row walk). */
  readonly contactEmail: string;
}

export async function ensurePortalMemberForUser(userEmail: string): Promise<PortalMarketingSeed | null> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return null;
  const { sql, end } = client;
  try {
    const users = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE lower(email) = ${userEmail.toLowerCase()} LIMIT 1
    `;
    const user = users[0];
    if (!user) {
      console.warn(`[${SEED_LABEL}] no user ${userEmail}; run scripts/seed-e2e-user.ts`);
      return null;
    }

    // Already linked to a live, non-erased member → nothing to do.
    const linked = await sql<Array<{ email: string }>>`
      SELECT c.email
      FROM contacts c
      JOIN members m ON m.tenant_id = c.tenant_id AND m.member_id = c.member_id
      WHERE c.tenant_id = ${TENANT_ID}
        AND c.linked_user_id = ${user.id}::uuid
        AND c.removed_at IS NULL
        AND m.erased_at IS NULL
      LIMIT 1
    `;
    if (linked[0]) return { seeded: false, contactEmail: linked[0].email };

    const planYear = new Date().getUTCFullYear();
    const sourceRows = await sql<Array<{ plan_id: string; plan_year: number }>>`
      SELECT plan_id, plan_year FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL AND is_active = true
      ORDER BY plan_year DESC, created_at ASC
      LIMIT 1
    `;
    const source = sourceRows[0];
    if (!source) {
      console.warn(`[${SEED_LABEL}] no active plan to clone in tenant ${TENANT_ID}; skipping`);
      return null;
    }

    await cleanupPortalMemberFixture();

    await sql`
      INSERT INTO membership_plans (
        tenant_id, plan_id, plan_year, plan_name, description,
        sort_order, plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, is_active, created_by, updated_by
      )
      SELECT
        tenant_id, ${FIX.planId}, ${planYear},
        jsonb_build_object('en', 'E2E Portal Marketing Plan'::text),
        description, sort_order, plan_category, member_type_scope, annual_fee_minor_units,
        includes_corporate_plan_id, max_duration_years, max_member_age,
        benefit_matrix, renewal_tier_bucket, true, created_by, created_by
      FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND plan_id = ${source.plan_id}
        AND plan_year = ${source.plan_year}
    `;
    const memberNumber = 950_000 + Math.floor(Math.random() * 9_000);
    await sql`
      INSERT INTO members (
        tenant_id, member_id, member_number, company_name, country, plan_id, plan_year, status
      )
      VALUES (
        ${TENANT_ID}, ${FIX.memberId}::uuid, ${memberNumber}, ${FIX.companyName}, 'TH',
        ${FIX.planId}, ${planYear}, 'active'
      )
    `;
    // The persona's login email as the contact email — that is how a real
    // invited primary looks, and what the suppression walk keys on.
    await sql`
      INSERT INTO contacts (
        tenant_id, contact_id, member_id, first_name, last_name, email, is_primary, linked_user_id
      )
      VALUES (
        ${TENANT_ID}, ${FIX.contactId}::uuid, ${FIX.memberId}::uuid,
        'Portal', 'Persona', ${userEmail.toLowerCase()}, true, ${user.id}::uuid
      )
    `;
    return { seeded: true, contactEmail: userEmail.toLowerCase() };
  } finally {
    await end();
  }
}

export async function cleanupPortalMemberFixture(): Promise<void> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return;
  const { sql, end } = client;
  try {
    await sql`DELETE FROM contacts WHERE tenant_id = ${TENANT_ID} AND member_id = ${FIX.memberId}::uuid`;
    await sql`DELETE FROM members WHERE tenant_id = ${TENANT_ID} AND member_id = ${FIX.memberId}::uuid`;
    await sql`DELETE FROM membership_plans WHERE tenant_id = ${TENANT_ID} AND plan_id = ${FIX.planId}`;
  } finally {
    await end();
  }
}
