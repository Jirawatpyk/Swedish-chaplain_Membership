/**
 * Seed dedicated E2E test users with a known password.
 *
 * Creates (or re-activates + re-hashes) five accounts:
 *   - e2e-super-admin@swecham.test (role: super_admin) — 016 PR 3 (T050): the
 *     ON-leg users/audit/erasure/settings persona. Upserted FIRST so it keeps
 *     the administrator union non-empty, letting the admin row below be RESET
 *     to plain `admin` even AFTER Migration C promoted every admin to
 *     super_admin (the trigger would otherwise refuse the last demotion).
 *   - e2e-admin@swecham.test    (role: admin) — **re-provisioned FRESH each run**
 *     (016 PR 3): Migration C promotes every human admin to super_admin, so
 *     without this reset the admin-persona suites would silently sign in as a
 *     super_admin and bypass the D4 narrowing they exist to prove.
 *   - e2e-manager@swecham.test  (role: manager) — read-only across staff portal
 *   - e2e-marketing@swecham.test (role: marketing) — 016 PR 4 (T059): broadcasts +
 *     events + member READ; denied every money/PII/compliance surface
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
import { seedTargetRefusal } from './lib/seed-target-guard';

const E2E_SUPER_ADMIN_EMAIL = 'e2e-super-admin@swecham.test';
const E2E_ADMIN_EMAIL = 'e2e-admin@swecham.test';
const E2E_MARKETING_EMAIL = 'e2e-marketing@swecham.test';
const E2E_MANAGER_EMAIL = 'e2e-manager@swecham.test';
const E2E_MEMBER_EMAIL = 'e2e-member@swecham.test';
const E2E_LOCKOUT_EMAIL = 'e2e-lockout@swecham.test';
const E2E_PASSWORD = 'E2E-Testing-Password-2026!xZ';

type E2ERole = 'super_admin' | 'admin' | 'manager' | 'marketing' | 'member';

const DISPLAY_NAME_FOR_ROLE: Record<E2ERole, string> = {
  super_admin: 'E2E Super Admin',
  admin: 'E2E Admin',
  manager: 'E2E Manager',
  marketing: 'E2E Marketing',
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

/** Every account `main()` writes — also the list the target guard vets. */
const SEEDED_EMAILS = [
  E2E_SUPER_ADMIN_EMAIL,
  E2E_ADMIN_EMAIL,
  E2E_MANAGER_EMAIL,
  E2E_MARKETING_EMAIL,
  E2E_MEMBER_EMAIL,
  E2E_LOCKOUT_EMAIL,
] as const;

async function main(): Promise<void> {
  // BEFORE any write, and before hashing: this script mints an active
  // super_admin with a password committed to the repository, and nothing else
  // stopped it running against production — `.env.production` is in the same
  // checkout, one flag away. See scripts/lib/seed-target-guard.ts.
  const refusal = seedTargetRefusal({
    databaseUrl: process.env.DATABASE_URL,
    blocklistRaw: process.env.TEST_DB_HOST_BLOCKLIST,
    nodeEnv: process.env.NODE_ENV,
    emails: SEEDED_EMAILS,
    confirmedTarget: process.argv.includes('--confirm-target'),
  });
  if (refusal) throw new Error(refusal);

  console.log('seeding E2E test users…');
  const hash = await argon2Hasher.hash(E2E_PASSWORD);

  // super_admin FIRST, so the administrator population is never empty when the
  // admin row below is reset from super_admin back to plain `admin`.
  //
  // DORMANT TODAY, deliberately kept: migration 0286's guard fires on
  // `NEW.role NOT IN ('admin','super_admin')`, so a super_admin → admin
  // demotion never enters the guarded arm and this order currently changes
  // nothing. It becomes load-bearing the moment PR 5 (T069) narrows that
  // population to `super_admin` alone. Documented as dormant rather than as
  // live because an invariant described as protecting something it does not
  // is the kind that gets deleted as dead code just before it matters.
  await upsertUser(E2E_SUPER_ADMIN_EMAIL, 'super_admin', hash);
  await upsertUser(E2E_ADMIN_EMAIL, 'admin', hash);
  await upsertUser(E2E_MANAGER_EMAIL, 'manager', hash);
  await upsertUser(E2E_MARKETING_EMAIL, 'marketing', hash);
  await upsertUser(E2E_MEMBER_EMAIL, 'member', hash);
  await upsertUser(E2E_LOCKOUT_EMAIL, 'member', hash);

  console.log('\n----------------------------------------');
  console.log('E2E credentials (use in your shell env):');
  console.log(`  export E2E_SUPER_ADMIN_EMAIL='${E2E_SUPER_ADMIN_EMAIL}'`);
  console.log(`  export E2E_SUPER_ADMIN_PASSWORD='${E2E_PASSWORD}'`);
  console.log(`  export E2E_ADMIN_EMAIL='${E2E_ADMIN_EMAIL}'`);
  console.log(`  export E2E_ADMIN_PASSWORD='${E2E_PASSWORD}'`);
  console.log(`  export E2E_MANAGER_EMAIL='${E2E_MANAGER_EMAIL}'`);
  console.log(`  export E2E_MANAGER_PASSWORD='${E2E_PASSWORD}'`);
  console.log(`  export E2E_MARKETING_EMAIL='${E2E_MARKETING_EMAIL}'`);
  console.log(`  export E2E_MARKETING_PASSWORD='${E2E_PASSWORD}'`);
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
