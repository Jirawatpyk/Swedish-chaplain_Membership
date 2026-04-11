/**
 * Seed dedicated E2E test users with a known password.
 *
 * Creates (or re-activates + re-hashes) four accounts:
 *   - e2e-admin@swecham.test    (role: admin)
 *   - e2e-manager@swecham.test  (role: manager) — read-only across staff portal
 *   - e2e-member@swecham.test   (role: member)
 *   - e2e-lockout@swecham.test  (role: member) — DEDICATED destructible
 *     account for `tests/e2e/signin-lockout.spec.ts`. Locked on every
 *     run of that spec (by design) and reset to `active` +
 *     `failedSignInCount=0` + `lockedUntil=null` by re-running this
 *     seed script. MUST NOT be used by any other E2E spec to avoid
 *     shared-state pollution.
 *
 * All accounts share the same password (printed at the end of the script).
 * Idempotent: re-running the script resets the password and unlocks
 * any pre-existing row.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/seed-e2e-user.ts
 *
 * E2E specs read:
 *   E2E_ADMIN_EMAIL     = e2e-admin@swecham.test
 *   E2E_ADMIN_PASSWORD  = <printed below>
 *   E2E_MANAGER_EMAIL   = e2e-manager@swecham.test
 *   E2E_MANAGER_PASSWORD = <printed below>
 *   E2E_MEMBER_EMAIL    = e2e-member@swecham.test
 *   E2E_MEMBER_PASSWORD = <printed below>
 *   E2E_LOCKOUT_EMAIL   = e2e-lockout@swecham.test
 *   E2E_LOCKOUT_PASSWORD = <printed below>
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';

const E2E_ADMIN_EMAIL = 'e2e-admin@swecham.test';
const E2E_MANAGER_EMAIL = 'e2e-manager@swecham.test';
const E2E_MEMBER_EMAIL = 'e2e-member@swecham.test';
const E2E_LOCKOUT_EMAIL = 'e2e-lockout@swecham.test';
const E2E_PASSWORD = 'E2E-Testing-Password-2026!xZ';

type E2ERole = 'admin' | 'manager' | 'member';

const DISPLAY_NAME_FOR_ROLE: Record<E2ERole, string> = {
  admin: 'E2E Admin',
  manager: 'E2E Manager',
  member: 'E2E Member',
};

async function upsertUser(
  email: string,
  role: E2ERole,
  passwordHash: string,
): Promise<void> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(users)
      .set({
        passwordHash,
        status: 'active',
        role,
        lockedUntil: null,
        failedSignInCount: 0,
        lastPasswordChangedAt: new Date(),
      })
      .where(eq(users.id, existing[0]!.id));
    console.log(`  updated ${email} (${role}) → active, password reset`);
  } else {
    await db.insert(users).values({
      email,
      role,
      status: 'active',
      passwordHash,
      displayName: DISPLAY_NAME_FOR_ROLE[role],
      lastPasswordChangedAt: new Date(),
    });
    console.log(`  created ${email} (${role})`);
  }
}

async function main(): Promise<void> {
  console.log('seeding E2E test users…');
  const hash = await argon2Hasher.hash(E2E_PASSWORD);

  await upsertUser(E2E_ADMIN_EMAIL, 'admin', hash);
  await upsertUser(E2E_MANAGER_EMAIL, 'manager', hash);
  await upsertUser(E2E_MEMBER_EMAIL, 'member', hash);
  await upsertUser(E2E_LOCKOUT_EMAIL, 'member', hash);

  console.log('\n----------------------------------------');
  console.log('E2E credentials (use in your shell env):');
  console.log(`  export E2E_ADMIN_EMAIL='${E2E_ADMIN_EMAIL}'`);
  console.log(`  export E2E_ADMIN_PASSWORD='${E2E_PASSWORD}'`);
  console.log(`  export E2E_MANAGER_EMAIL='${E2E_MANAGER_EMAIL}'`);
  console.log(`  export E2E_MANAGER_PASSWORD='${E2E_PASSWORD}'`);
  console.log(`  export E2E_MEMBER_EMAIL='${E2E_MEMBER_EMAIL}'`);
  console.log(`  export E2E_MEMBER_PASSWORD='${E2E_PASSWORD}'`);
  console.log(`  export E2E_LOCKOUT_EMAIL='${E2E_LOCKOUT_EMAIL}'`);
  console.log(`  export E2E_LOCKOUT_PASSWORD='${E2E_PASSWORD}'`);
  console.log('----------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
