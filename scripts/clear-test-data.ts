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
  readonly testUsers: number;
  readonly testTenantRows: {
    readonly members: number;
    readonly contacts: number;
    readonly plans: number;
    readonly feeConfig: number;
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

  // 2. Test-tenant data: members, contacts, plans, fee_config, tokens,
  //    outbox. Scoped by tenant_id LIKE 'test-%'. Order matters: child
  //    tables first, then parents.
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
  const testFeeConfigDeleted = await db.execute(
    sql`DELETE FROM tenant_fee_config WHERE tenant_id LIKE 'test-%' RETURNING tenant_id`,
  );

  // 3. Integration test users (test-<timestamp>-<rand>@swecham.test).
  //    Sessions / password_reset_tokens / invitations cascade via FK.
  //    Narrow pattern: only `test-*@swecham.test` (not .com), so
  //    production accounts are safe.
  const usersDeleted = await db.execute(
    sql`DELETE FROM users
        WHERE email LIKE 'test-%@swecham.test'
        RETURNING id`,
  );

  return {
    e2eMembers,
    e2eContacts,
    testUsers: unwrap(usersDeleted).length,
    testTenantRows: {
      members: unwrap(testMembersDeleted).length,
      contacts: unwrap(testContactsDeleted).length,
      plans: unwrap(testPlansDeleted).length,
      feeConfig: unwrap(testFeeConfigDeleted).length,
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
  console.log('  Test users:     ', report.testUsers);
  console.log('  Test-tenant rows:');
  console.log('    members:      ', report.testTenantRows.members);
  console.log('    contacts:     ', report.testTenantRows.contacts);
  console.log('    plans:        ', report.testTenantRows.plans);
  console.log('    fee config:   ', report.testTenantRows.feeConfig);
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
