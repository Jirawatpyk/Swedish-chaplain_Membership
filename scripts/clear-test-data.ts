/**
 * Clear accumulated test data from the database.
 *
 * Three categories of test pollution accumulate across runs:
 *
 *   1. E2E members       — `company_name` LIKE 'E2E Co %'
 *                          (from tests/e2e/members-create.spec.ts)
 *   2. Test users        — `email` LIKE 'test-%@swecham.test'
 *                          (from tests/integration/helpers/test-users.ts)
 *   3. Test tenant data  — `tenant_id` LIKE 'test-%' / 'test-swecham-%' /
 *                          'test-chamber-%'
 *                          (from tests/integration/helpers/test-tenant.ts —
 *                          normally cleaned up per-test via `cleanup()`
 *                          but failed tests leave orphans)
 *
 * Skips `audit_log` — append-only per Principle VIII. Accepted
 * pollution; retained ≥ 5 years for compliance.
 *
 * Run via:
 *   node --env-file=.env.local --import tsx scripts/clear-test-data.ts
 *
 * Safe to run repeatedly. Only touches test-prefixed rows.
 *
 * DANGER: DO NOT set the prefix patterns to anything that could match
 * production data (like raw `'%'` or `'@swecham.com'`). The patterns
 * are intentionally narrow — `test-*@swecham.test` (not `.com`) and
 * `E2E Co ` (space suffix) and `test-*` tenant slugs.
 */
process.loadEnvFile?.('.env.local');

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

// Helper: normalize db.execute result across postgres-js drivers that
// may return either an array directly or `{ rows: [...] }`.
function unwrap<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export type ClearTestDataReport = {
  readonly e2eMembers: number;
  readonly e2eContacts: number;
  /** F-04 — F4 E2E admin-mutation fixtures purged (990000-series). */
  readonly f4MutationInvoices: number;
  readonly f4MutationLines: number;
  readonly testUsers: number;
  readonly testTenantRows: {
    readonly members: number;
    readonly contacts: number;
    readonly plans: number;
    readonly invoiceSettings: number;
    readonly emailChangeTokens: number;
    readonly notificationsOutbox: number;
  };
};

/**
 * Clear all test data. Returns a row-count report.
 * Isolated as a pure function so it can be covered by an integration
 * test (see `tests/integration/scripts/clear-test-data.test.ts`).
 */
export async function clearTestData(): Promise<ClearTestDataReport> {
  // 1. E2E members (+ their contacts).
  const e2eFound = await db.execute(
    sql`SELECT member_id FROM members WHERE company_name LIKE 'E2E Co %'`,
  );
  const e2eMemberIds = unwrap<{ member_id: string }>(e2eFound).map(
    (r) => r.member_id,
  );

  let e2eContacts = 0;
  let e2eMembers = 0;
  if (e2eMemberIds.length > 0) {
    const idListSql = sql.join(
      e2eMemberIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const contactsDeleted = await db.execute(
      sql`DELETE FROM contacts WHERE member_id IN (${idListSql}) RETURNING contact_id`,
    );
    e2eContacts = unwrap(contactsDeleted).length;
    const membersDeleted = await db.execute(
      sql`DELETE FROM members WHERE member_id IN (${idListSql}) RETURNING member_id`,
    );
    e2eMembers = unwrap(membersDeleted).length;
  }

  // F-04 — Purge stale F4 E2E admin-mutation fixtures.
  // Scoped tightly to (a) the dedicated member `E2E Mutation Co`
  // and (b) the reserved 990000–999999 sequence_number block. Safe
  // to run against production-shaped tenants; real invoices live
  // in 000001…<current>.
  //
  // Bugfix 2026-04-22 — credit_notes reference invoices via
  // `credit_notes_original_invoice_fk`. Must delete child rows
  // BEFORE the parent invoice to avoid FK-violation on repeat runs
  // where the CN mutating E2E (T125 AS2) seeded credit-note rows
  // against a 995xxx invoice.
  await db.execute(
    sql`DELETE FROM credit_notes
        WHERE original_invoice_id IN (
          SELECT i.invoice_id FROM invoices i
          JOIN members m ON i.tenant_id = m.tenant_id AND i.member_id = m.member_id
          WHERE m.company_name = 'E2E Mutation Co'
            AND i.sequence_number BETWEEN 990000 AND 999999
        )`,
  );
  const mutationCleanup = await db.execute(
    sql`DELETE FROM invoice_lines
        WHERE invoice_id IN (
          SELECT i.invoice_id FROM invoices i
          JOIN members m ON i.tenant_id = m.tenant_id AND i.member_id = m.member_id
          WHERE m.company_name = 'E2E Mutation Co'
            AND i.sequence_number BETWEEN 990000 AND 999999
        ) RETURNING line_id`,
  );
  const mutationLines = unwrap(mutationCleanup).length;
  const mutationInvoiceCleanup = await db.execute(
    sql`DELETE FROM invoices
        WHERE sequence_number BETWEEN 990000 AND 999999
          AND member_id IN (
            SELECT member_id FROM members WHERE company_name = 'E2E Mutation Co'
          ) RETURNING invoice_id`,
  );
  const mutationInvoices = unwrap(mutationInvoiceCleanup).length;

  // 2. Test-tenant data: members, contacts, plans, invoice_settings,
  //    tokens, outbox. Scoped by tenant_id LIKE 'test-%'. Order matters:
  //    child tables first, then parents.
  // F4 invoicing cascade — credit_notes → invoice_lines → invoices.
  // invoices.draft_by_user_id / paid_by_user_id / voided_by_user_id
  // reference users(id) with ON DELETE restrict to preserve tax audit
  // trails; test users cannot be deleted while any test-tenant invoice
  // row still references them. Must happen BEFORE the users DELETE.
  await db.execute(
    sql`DELETE FROM credit_notes WHERE tenant_id LIKE 'test-%'`,
  );
  await db.execute(
    sql`DELETE FROM invoice_lines WHERE tenant_id LIKE 'test-%'`,
  );
  await db.execute(
    sql`DELETE FROM invoices WHERE tenant_id LIKE 'test-%'`,
  );
  await db.execute(
    sql`DELETE FROM tenant_document_sequences WHERE tenant_id LIKE 'test-%'`,
  );

  const emailTokensDeleted = await db.execute(
    sql`DELETE FROM email_change_tokens WHERE tenant_id LIKE 'test-%' RETURNING id`,
  );
  const outboxDeleted = await db.execute(
    sql`DELETE FROM notifications_outbox WHERE tenant_id LIKE 'test-%' RETURNING id`,
  );
  const testContactsDeleted = await db.execute(
    sql`DELETE FROM contacts WHERE tenant_id LIKE 'test-%' RETURNING contact_id`,
  );
  const testMembersDeleted = await db.execute(
    sql`DELETE FROM members WHERE tenant_id LIKE 'test-%' RETURNING member_id`,
  );
  const testPlansDeleted = await db.execute(
    sql`DELETE FROM membership_plans WHERE tenant_id LIKE 'test-%' RETURNING plan_id`,
  );
  const testInvoiceSettingsDeleted = await db.execute(
    sql`DELETE FROM tenant_invoice_settings WHERE tenant_id LIKE 'test-%' RETURNING tenant_id`,
  );

  // 3. Integration test users (test-<timestamp>-<rand>@swecham.test).
  //    Sessions + password_reset_tokens cascade via FK (ON DELETE
  //    cascade). Invitations DO NOT — `invitations.invited_by_user_id`
  //    is `ON DELETE restrict` (drizzle/migrations/0000…sql) to preserve
  //    the audit trail of who issued each invite. So we must explicitly
  //    delete any invitation rows that reference (a) a test user as
  //    invitee OR (b) a test user as inviter, BEFORE deleting users.
  //    Narrow pattern: only `test-*@swecham.test` (not .com), so
  //    production accounts are safe.
  //
  // F-04 follow-up (2026-04-21) — F4 invoices also hold `ON DELETE
  // restrict` FKs on `draft_by_user_id`, `issued_by_user_id`,
  // `paid_by_user_id`, `voided_by_user_id`. Past integration-test
  // sessions have left orphan invoice rows where the invoice's
  // `tenant_id` does NOT match `test-%` (stale slug, partial cleanup)
  // while the `draft_by_user_id` STILL points at a `test-*@swecham.test`
  // user. The step (2) filter above misses them → user DELETE blocks.
  // Purge ANY invoice (and its dependent rows) referencing a test user
  // regardless of tenant_id. Scope is tightly bounded: only rows
  // referencing test-*@swecham.test users are touched.
  await db.execute(
    sql`DELETE FROM credit_notes
        WHERE original_invoice_id IN (
          SELECT invoice_id FROM invoices
          WHERE draft_by_user_id IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
          OR payment_recorded_by_user_id IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
          OR voided_by_user_id IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
        )`,
  );
  await db.execute(
    sql`DELETE FROM invoice_lines
        WHERE invoice_id IN (
          SELECT invoice_id FROM invoices
          WHERE draft_by_user_id IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
          OR payment_recorded_by_user_id IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
          OR voided_by_user_id IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
        )`,
  );
  await db.execute(
    sql`DELETE FROM invoices
        WHERE draft_by_user_id IN (
          SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
        )
        OR payment_recorded_by_user_id IN (
          SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
        )
        OR voided_by_user_id IN (
          SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
        )`,
  );

  // Same orphan-pattern cleanup for membership_plans — `created_by`
  // + `updated_by` are ON DELETE restrict and block user delete when
  // a stale plan row still references a test user (tenant_id may not
  // match 'test-%' after a partial prior cleanup).
  //
  // Dependency order: a member may reference a test-user-created plan
  // via `members_plan_tenant_year_fk`, so delete those members (and
  // their contacts) BEFORE the plans.
  await db.execute(
    sql`DELETE FROM contacts
        WHERE (tenant_id, member_id) IN (
          SELECT m.tenant_id, m.member_id FROM members m
          JOIN membership_plans p
            ON m.tenant_id = p.tenant_id
           AND m.plan_id = p.plan_id
           AND m.plan_year = p.plan_year
          WHERE p.created_by IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
          OR p.updated_by IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
        )`,
  );
  await db.execute(
    sql`DELETE FROM members
        WHERE (tenant_id, plan_id, plan_year) IN (
          SELECT tenant_id, plan_id, plan_year FROM membership_plans
          WHERE created_by IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
          OR updated_by IN (
            SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
          )
        )`,
  );
  await db.execute(
    sql`DELETE FROM membership_plans
        WHERE created_by IN (
          SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
        )
        OR updated_by IN (
          SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
        )`,
  );

  await db.execute(
    sql`DELETE FROM invitations
        WHERE user_id IN (
          SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
        )
        OR invited_by_user_id IN (
          SELECT id FROM users WHERE email LIKE 'test-%@swecham.test'
        )`,
  );
  const usersDeleted = await db.execute(
    sql`DELETE FROM users
        WHERE email LIKE 'test-%@swecham.test'
        RETURNING id`,
  );

  return {
    e2eMembers,
    e2eContacts,
    f4MutationInvoices: mutationInvoices,
    f4MutationLines: mutationLines,
    testUsers: unwrap(usersDeleted).length,
    testTenantRows: {
      members: unwrap(testMembersDeleted).length,
      contacts: unwrap(testContactsDeleted).length,
      plans: unwrap(testPlansDeleted).length,
      invoiceSettings: unwrap(testInvoiceSettingsDeleted).length,
      emailChangeTokens: unwrap(emailTokensDeleted).length,
      notificationsOutbox: unwrap(outboxDeleted).length,
    },
  };
}

async function main(): Promise<void> {
  console.log('clearing test data…');
  const report = await clearTestData();

  console.log('');
  console.log('  E2E members:    ', report.e2eMembers);
  console.log('  E2E contacts:   ', report.e2eContacts);
  console.log('  F4 mutation inv:', report.f4MutationInvoices);
  console.log('  F4 mutation lns:', report.f4MutationLines);
  console.log('  Test users:     ', report.testUsers);
  console.log('  Test-tenant rows:');
  console.log('    members:      ', report.testTenantRows.members);
  console.log('    contacts:     ', report.testTenantRows.contacts);
  console.log('    plans:        ', report.testTenantRows.plans);
  console.log('    inv settings: ', report.testTenantRows.invoiceSettings);
  console.log('    email tokens: ', report.testTenantRows.emailChangeTokens);
  console.log('    outbox:       ', report.testTenantRows.notificationsOutbox);
  console.log('');
  console.log('  audit_log: skipped (append-only per Principle VIII)');
  console.log('');
  console.log('clear-test-data: done');
}

// Only auto-run when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1]?.endsWith('clear-test-data.ts') === true ||
  process.argv[1]?.endsWith('clear-test-data.js') === true;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('clear-test-data failed:', err);
      process.exit(1);
    });
}
