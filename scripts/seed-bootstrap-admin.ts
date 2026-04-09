/**
 * Bootstrap admin seed (T080, research.md § 12, spec §Assumptions
 * "Bootstrap admin").
 *
 * Creates the FIRST `admin` user as ACTIVE with a password set
 * directly. This is a deliberate deviation from the normal invitation
 * flow because:
 *
 *   - The invitation redemption page (`/invite/[token]/page.tsx`) is
 *     in Phase 6 (T136) and is NOT part of F1 MVP scope.
 *   - Bootstrap is single-use and operator-driven; the security
 *     benefits of an emailed token don't apply when the operator is
 *     running this from a shell with full DB access anyway.
 *   - The password is verified against the same policy
 *     (`checkPasswordPolicy`) that real users go through, so it can't
 *     be weaker.
 *
 * Refuses to run if any admin (active or pending) already exists.
 * This is the only privilege-escalation vector in the system, so it
 * must be impossible to invoke twice.
 *
 * Usage:
 *
 *     pnpm db:seed-admin admin@swecham.se 'StrongPassword!23'
 *
 * The email may also be supplied via the `BOOTSTRAP_ADMIN_EMAIL` env
 * var (in which case it becomes the first positional arg's default).
 *
 * The `db:seed-admin` pnpm script loads `.env.local` via Node's
 * `--env-file` flag BEFORE the static imports in this file evaluate,
 * so the env validation in `src/lib/env.ts` sees the secrets. Don't
 * invoke `tsx` directly — the static import of `src/lib/db.ts` will
 * trigger env validation before `process.loadEnvFile()` runs.
 *
 * Audits the action under actor `system:bootstrap` so the first admin
 * creation is visible in the audit trail.
 */
// .env.local is loaded via `node --env-file=.env.local` from the
// `db:seed-admin` pnpm script. The line below is a safety net for
// anyone invoking tsx directly — it runs too late for the static
// imports below, so we ALSO rely on --env-file in the package.json
// script to cover the normal path.
process.loadEnvFile?.('.env.local');

import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { users } from '../src/modules/auth/infrastructure/db/schema';
import { auditRepo } from '../src/modules/auth/infrastructure/db/audit-repo';
import { argon2Hasher } from '../src/modules/auth/infrastructure/password/argon2-hasher';
import { checkPasswordPolicy } from '../src/modules/auth/application/password-policy';
import { asEmailAddress } from '../src/modules/auth/domain/branded';

async function main(): Promise<void> {
  const argEmail = process.argv[2];
  const argPassword = process.argv[3];
  const envEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const rawEmail = argEmail ?? envEmail;

  if (!rawEmail || !argPassword) {
    console.error('seed-bootstrap-admin: usage:');
    console.error('');
    console.error("  pnpm exec tsx scripts/seed-bootstrap-admin.ts <email> '<password>'");
    console.error('');
    console.error('  email may be omitted if BOOTSTRAP_ADMIN_EMAIL is set.');
    console.error('  password is REQUIRED — quote it to protect shell special chars.');
    process.exit(1);
  }

  let email;
  try {
    email = asEmailAddress(rawEmail);
  } catch {
    console.error(`seed-bootstrap-admin: '${rawEmail}' is not a valid email`);
    process.exit(1);
  }

  // 1. Refuse if any admin exists
  const existing = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(sql`${users.role} = 'admin'`);

  if (existing.length > 0) {
    console.error(
      `seed-bootstrap-admin: ${existing.length} admin row(s) already exist. Bootstrap is single-use.`,
    );
    process.exit(2);
  }

  // 2. Validate password against the production policy
  const policy = await checkPasswordPolicy(argPassword);
  if (!policy.ok) {
    console.error('seed-bootstrap-admin: password rejected by policy:');
    for (const error of policy.errors) {
      console.error(`  - ${error.code}`);
    }
    process.exit(3);
  }

  // 3. Hash and insert
  const hash = await argon2Hasher.hash(argPassword);
  const now = new Date();

  const inserted = await db
    .insert(users)
    .values({
      email,
      role: 'admin',
      status: 'active',
      passwordHash: hash,
      lastPasswordChangedAt: now,
    })
    .returning();
  const user = inserted[0];
  if (!user) {
    console.error('seed-bootstrap-admin: insert returned no row');
    process.exit(4);
  }

  // 4. Audit under the special actor
  await auditRepo.append({
    eventType: 'account_created',
    actorUserId: 'system:bootstrap',
    targetUserId: user.id as never,
    sourceIp: null,
    summary: `bootstrap admin created for ${email}`,
    requestId: `bootstrap-${now.toISOString()}`,
  });

  // 5. Print sign-in URL
  const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  console.log('');
  console.log('  ✓ Bootstrap admin created');
  console.log('  ─────────────────────────');
  console.log(`  Email:    ${email}`);
  console.log(`  User ID:  ${user.id}`);
  console.log(`  Status:   active`);
  console.log(`  Strength: ${policy.strength}`);
  console.log('');
  console.log('  Sign in at:');
  console.log(`    ${baseUrl}/admin/sign-in`);
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('seed-bootstrap-admin: crashed:', error);
    process.exit(99);
  });
