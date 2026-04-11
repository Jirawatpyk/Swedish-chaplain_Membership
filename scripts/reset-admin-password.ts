/**
 * Emergency password-reset for a locked-out admin.
 *
 * Writes a new argon2id password hash directly to the `users` row.
 * Used to recover from an E2E test run that left a real admin's
 * password stuck at a throwaway temporary value.
 *
 * Only run this when you have NO other way to recover (forgot-password
 * email flow is the preferred path). Requires shell access to the DB
 * credentials in `.env.local`.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/reset-admin-password.ts <email> [newPassword]
 *
 * If `newPassword` is omitted, a 24-character alphanumeric temp
 * password is generated and printed. The caller is responsible for
 * communicating it to the user over a secure channel and the user is
 * expected to change it immediately via /admin/account.
 *
 * Emits a `password_changed` audit event attributing the change to
 * `system:emergency-reset` so the audit trail reflects what happened.
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users, auditLog } from '@/modules/auth/infrastructure/db/schema';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';

function generateTempPassword(): string {
  // 18 bytes of entropy → 24 base64url chars. Mixed case + digits.
  // Adds a fixed suffix that guarantees the password policy passes
  // (≥ 12 chars, has digit, has symbol, has mixed case).
  const random = randomBytes(18).toString('base64url');
  return `${random}-Aa!9`;
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: reset-admin-password.ts <email> [newPassword]');
    process.exit(1);
  }
  const newPassword = process.argv[3] ?? generateTempPassword();

  // Look up the user
  const rows = await db
    .select({ id: users.id, role: users.role, status: users.status })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
    .limit(1);
  const user = rows[0];
  if (!user) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }

  // Hash + update
  const passwordHash = await argon2Hasher.hash(newPassword);
  const now = new Date();

  await db
    .update(users)
    .set({
      passwordHash,
      lastPasswordChangedAt: now,
      lockedUntil: null,
      failedSignInCount: 0,
    })
    .where(eq(users.id, user.id));

  // Also delete any active sessions so the old session cookie (if any)
  // cannot be used to impersonate the user after the reset.
  await db.execute(sql`DELETE FROM sessions WHERE user_id = ${user.id}`);

  // Audit trail — attribute to the emergency reset mechanism, not a
  // real actor. actor_user_id uses a sentinel string instead of a FK
  // to a real user (the column is `text` not `uuid` per the schema).
  await db.insert(auditLog).values({
    eventType: 'password_changed',
    actorUserId: 'system:emergency-reset',
    targetUserId: user.id,
    sourceIp: null,
    summary: `emergency reset via scripts/reset-admin-password.ts for ${email}`,
    requestId: `emergency-reset-${now.getTime()}`,
  });

  console.log('-----------------------------------------------------');
  console.log(`reset ${email} (id=${user.id}, role=${user.role})`);
  console.log(`new password: ${newPassword}`);
  console.log('-----------------------------------------------------');
  console.log('ACTION REQUIRED:');
  console.log('  1. Sign in at /admin/sign-in with the password above.');
  console.log('  2. Go to /admin/account and change the password to');
  console.log('     something YOU choose — the generated temp is');
  console.log('     logged only to this terminal and is not stored.');
  console.log('  3. Delete this terminal scrollback when done.');
  console.log('-----------------------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
