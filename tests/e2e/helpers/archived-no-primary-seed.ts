/**
 * 108 T040 (US2 / FR-014) — E2E seed for the "restore designates a primary"
 * journey.
 *
 * Two ARCHIVED dummy members in the e2e tenant:
 *   - `withContacts`: two live contacts, NEITHER primary — the state FR-014
 *     exists for. Restore must refuse and offer both as the choice.
 *   - `withoutContacts`: no contact rows at all — the dialog's zero-contacts
 *     variant (no restore button, only the add-contact door).
 *
 * Both are unreachable through the application (archive never demotes, and
 * every add/promote/remove now holds the invariant), so they are written with
 * the owner-role seed client. Each member + its contacts go in ONE transaction:
 * migration 0293's deferred trigger runs at COMMIT and exempts an `archived`
 * member, so the seed commits; the same rows on an ACTIVE member would be
 * refused — which is the point of the feature.
 *
 * Idempotent: a prior run's dummies are deleted first (by the e2e company-name
 * marker) and again in `cleanup()`. `member_number` is a high random value clear
 * of the allocator's contiguous range and is removed with the row, so the 0209
 * contiguity invariant is never left broken. Never a real member (memory: seed
 * SIMULATED dummies only).
 *
 * No-op (returns null) when `DATABASE_URL` is missing or the tenant has no
 * member to anchor the (plan_id, plan_year) FK on.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { openSeedClient } from './open-seed-client';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const SEED_LABEL = 'e2e seed archived-no-primary';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Company-name marker every dummy carries — the cleanup key. */
const COMPANY_PREFIX = 'E2E Restore Dummy';

export interface ArchivedNoPrimarySeed {
  readonly withContacts: {
    readonly memberId: string;
    readonly companyName: string;
    readonly contacts: ReadonlyArray<{ firstName: string; lastName: string }>;
  };
  readonly withoutContacts: {
    readonly memberId: string;
    readonly companyName: string;
  };
  readonly cleanup: () => Promise<void>;
}

async function deleteDummies(sql: ReturnType<typeof postgres>): Promise<void> {
  // Contacts first (FK), then the member rows. Bottom-up in one statement
  // each; the contacts DELETE leaves zero rows per member, which 0293 exempts.
  await sql`
    DELETE FROM contacts
    WHERE tenant_id = ${TENANT_ID}
      AND member_id IN (
        SELECT member_id FROM members
        WHERE tenant_id = ${TENANT_ID} AND company_name LIKE ${`${COMPANY_PREFIX}%`}
      )
  `;
  await sql`
    DELETE FROM renewal_cycles
    WHERE tenant_id = ${TENANT_ID}
      AND member_id IN (
        SELECT member_id FROM members
        WHERE tenant_id = ${TENANT_ID} AND company_name LIKE ${`${COMPANY_PREFIX}%`}
      )
  `;
  await sql`
    DELETE FROM members
    WHERE tenant_id = ${TENANT_ID} AND company_name LIKE ${`${COMPANY_PREFIX}%`}
  `;
}

export async function seedArchivedNoPrimaryMembers(): Promise<ArchivedNoPrimarySeed | null> {
  const client = openSeedClient(SEED_LABEL);
  if (!client) return null;
  const { sql, end } = client;
  const dbUrl = process.env.DATABASE_URL!;
  try {
    const anchorRows = await sql<Array<{ plan_id: string; plan_year: number }>>`
      SELECT plan_id, plan_year FROM members
      WHERE tenant_id = ${TENANT_ID}
      ORDER BY plan_year DESC
      LIMIT 1
    `;
    const anchor = anchorRows[0];
    if (!anchor) {
      console.warn(`[${SEED_LABEL}] no member in tenant ${TENANT_ID} to anchor the plan FK; skipping`);
      return null;
    }

    await deleteDummies(sql);

    const run = randomUUID().slice(0, 8);
    const archivedAt = new Date(Date.now() - 10 * MS_PER_DAY).toISOString();
    const withContactsId = randomUUID();
    const withoutContactsId = randomUUID();
    const companyA = `${COMPANY_PREFIX} A ${run}`;
    const companyB = `${COMPANY_PREFIX} B ${run}`;
    const contactsA = [
      { firstName: 'Ann', lastName: `Alpha-${run}` },
      { firstName: 'Bo', lastName: `Beta-${run}` },
    ] as const;

    // ONE transaction per member: the deferred trigger evaluates at COMMIT.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO members (
          tenant_id, member_id, member_number, company_name, country,
          plan_id, plan_year, registration_fee_paid, registration_date,
          status, archived_at
        )
        VALUES (
          ${TENANT_ID}, ${withContactsId}::uuid, ${980_000 + Math.floor(Math.random() * 4_000)},
          ${companyA}, 'TH', ${anchor.plan_id}, ${anchor.plan_year}, true, '2020-01-01',
          'archived', ${archivedAt}::timestamptz
        )
      `;
      for (const c of contactsA) {
        await tx`
          INSERT INTO contacts (
            tenant_id, contact_id, member_id, first_name, last_name, email,
            preferred_language, is_primary
          )
          VALUES (
            ${TENANT_ID}, ${randomUUID()}::uuid, ${withContactsId}::uuid,
            ${c.firstName}, ${c.lastName},
            ${`e2e-restore-${c.firstName.toLowerCase()}-${run}@example.com`},
            'en', false
          )
        `;
      }
    });

    await sql`
      INSERT INTO members (
        tenant_id, member_id, member_number, company_name, country,
        plan_id, plan_year, registration_fee_paid, registration_date,
        status, archived_at
      )
      VALUES (
        ${TENANT_ID}, ${withoutContactsId}::uuid, ${985_000 + Math.floor(Math.random() * 4_000)},
        ${companyB}, 'TH', ${anchor.plan_id}, ${anchor.plan_year}, true, '2020-01-01',
        'archived', ${archivedAt}::timestamptz
      )
    `;

    return {
      withContacts: { memberId: withContactsId, companyName: companyA, contacts: contactsA },
      withoutContacts: { memberId: withoutContactsId, companyName: companyB },
      cleanup: async () => {
        const c = postgres(dbUrl, { ssl: 'require', max: 1 });
        try {
          await deleteDummies(c);
        } finally {
          await c.end({ timeout: 5 });
        }
      },
    };
  } finally {
    await end();
  }
}
