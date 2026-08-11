/**
 * T042 — Migration C promotion rehearsal (016 PR 3, US1).
 *
 * Migration C is the operator-gated, one-way promotion that turns every human
 * `admin` into `super_admin` (and every OPEN admin invitation's `intended_role`
 * with it) the moment the RBAC v2 cutover completes. It is the single most
 * dangerous statement in the feature: a wrong predicate either strands the
 * tenant with zero super_admins (permanent lockout — nobody holds `users.manage`
 * on the ON leg) or silently promotes a system-actor row that a webhook/cron
 * writes through.
 *
 * This rehearsal reads the REAL migration file (never a hand-retyped copy — the
 * SQL that ships must be the SQL that was proven) and applies it inside a
 * transaction that is ALWAYS rolled back, so the shared dev branch keeps its
 * real rows. It pins the four predicate properties the design guarantees
 * (design §5, spec §FR-008):
 *
 *   1. every pre-C human admin (active OR disabled) → super_admin
 *   2. all THREE system actors (Stripe f5001 / Resend f5002 / cron f5003) are
 *      excluded by id — untouched (role='admin', status='disabled')
 *   3. the D18 pre-minted super_admin row is untouched (the predicate keys on
 *      role='admin', so a super_admin is never in scope)
 *   4. OPEN admin invitations promote coherently with their user rows
 *      (redeem-invite's tamper check needs user.role === invitation.intendedRole
 *      — T044 pins that consequence); EXPIRED invitations are skipped.
 *
 * WHY the migration lives in `drizzle/migrations/pending/`, not at the top level:
 * `scripts/run-migrations.ts`'s D7 gate greps the top level of
 * `drizzle/migrations/` for any `*rbac_v2_promotion*.sql` and exits 1 when it is
 * present-but-pending while `FEATURE_RBAC_V2 !== 'true'` — which is every
 * ordinary deploy of this feature branch, including its own Vercel preview
 * build. Staging it one directory down keeps `readdirSync(MIGRATIONS_DIR)`
 * (non-recursive, `.sql`-filtered) blind to it while this rehearsal reads it by
 * explicit path. The operator's migration-only PR (T052) `git mv`s it to the top
 * level + journals it AFTER the flag is flipped. See the file header + runbook §5.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

/** Marker so any row that somehow escapes the rollback is obvious. */
const TAG = 't042-migration-c';

const MIGRATION_C_PATH = join(
  process.cwd(),
  'drizzle',
  'migrations',
  'pending',
  '0287_rbac_v2_promotion.sql',
);

/** Canonical system-actor ids (mirror scripts/seed-system-actors.ts). */
const SYSTEM_ACTOR_IDS = [
  '00000000-0000-0000-0000-0000000f5001',
  '00000000-0000-0000-0000-0000000f5002',
  '00000000-0000-0000-0000-0000000f5003',
] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Read the real Migration C file and return its executable statements. The file
 * is pure `UPDATE`s (no dollar-quoted bodies), so stripping `--` line comments
 * and splitting on `;` is safe and lets each statement run — and, in the
 * reversed-order rehearsal (T043), fail — on its own.
 */
function migrationCStatements(): string[] {
  const raw = readFileSync(MIGRATION_C_PATH, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigrationC(tx: Tx): Promise<void> {
  for (const statement of migrationCStatements()) {
    await tx.execute(sql.raw(statement));
  }
}

async function roleOf(tx: Tx, email: string): Promise<{ role: string; status: string } | null> {
  const rows = await tx.execute(sql`
    SELECT role, status FROM users WHERE email = ${email}`);
  return (rows as unknown as Array<{ role: string; status: string }>)[0] ?? null;
}

async function roleOfId(tx: Tx, id: string): Promise<{ role: string; status: string } | null> {
  const rows = await tx.execute(sql`
    SELECT role, status FROM users WHERE id = ${id}::uuid`);
  return (rows as unknown as Array<{ role: string; status: string }>)[0] ?? null;
}

async function invitationRole(tx: Tx, id: string): Promise<string | null> {
  const rows = await tx.execute(sql`
    SELECT intended_role FROM invitations WHERE id = ${id}`);
  return (rows as unknown as Array<{ intended_role: string }>)[0]?.intended_role ?? null;
}

interface Fixtures {
  readonly humanAdminActive: string;
  readonly humanAdminActive2: string;
  readonly humanAdminDisabled: string;
  readonly preMintedSuperAdmin: string;
  readonly openInviteUserEmail: string;
  readonly openInvitationId: string;
  readonly expiredInviteUserEmail: string;
  readonly expiredInvitationId: string;
}

/**
 * Seed the controlled population inside a doomed transaction, apply-or-inspect
 * via `body`, then ALWAYS roll back. Pre-existing active administrators are
 * parked `disabled` so the promotion predicate operates on a known set; the
 * three system actors are upserted so the exclusion assertion never depends on
 * the shared branch's seed state.
 */
async function inRolledBackTx(body: (tx: Tx, f: Fixtures) => Promise<void>): Promise<void> {
  const ROLLBACK = new Error('intentional-rollback');
  try {
    await db.transaction(async (tx) => {
      // Ensure the three system actors exist so the "untouched" assertion is
      // self-contained (healthy dev seeds them role='admin'/status='disabled').
      for (const [i, id] of SYSTEM_ACTOR_IDS.entries()) {
        await tx.execute(sql`
          INSERT INTO users (id, email, role, status, password_hash, display_name)
          VALUES (${id}::uuid, ${`system-${i}@chamber-os.internal.${TAG}`}, 'admin', 'disabled', NULL, ${TAG})
          ON CONFLICT (id) DO NOTHING`);
      }

      const emails = {
        humanAdminActive: `${TAG}-admin1@example.test`,
        humanAdminActive2: `${TAG}-admin2@example.test`,
        humanAdminDisabled: `${TAG}-admin3-disabled@example.test`,
        preMintedSuperAdmin: `${TAG}-superadmin@example.test`,
        openInviteUserEmail: `${TAG}-invitee-open@example.test`,
        expiredInviteUserEmail: `${TAG}-invitee-expired@example.test`,
      };

      async function insertUser(email: string, role: string, status: string): Promise<string> {
        const rows = await tx.execute(sql`
          INSERT INTO users (email, password_hash, role, status, display_name)
          VALUES (${email}, ${'x'}, ${role}::role, ${status}::user_status, ${TAG})
          RETURNING id`);
        return String((rows as unknown as Array<{ id: string }>)[0]?.id);
      }

      await insertUser(emails.humanAdminActive, 'admin', 'active');
      await insertUser(emails.humanAdminActive2, 'admin', 'active');
      await insertUser(emails.humanAdminDisabled, 'admin', 'disabled');
      await insertUser(emails.preMintedSuperAdmin, 'super_admin', 'active');
      const openInviteUserId = await insertUser(emails.openInviteUserEmail, 'admin', 'pending');
      const expiredInviteUserId = await insertUser(
        emails.expiredInviteUserEmail,
        'admin',
        'pending',
      );

      // Park the shared branch's real active admins so the promotion predicate
      // works on our fixtures only. Our fixtures + the super_admin keep the
      // union non-zero at every step, so the 0286 trigger never blocks setup.
      // The system actors are already status='disabled', so this active-only
      // UPDATE never touches them — no id exclusion needed here.
      await tx.execute(sql`
        UPDATE users SET status = 'disabled'
        WHERE role IN ('admin', 'super_admin')
          AND status = 'active'
          AND display_name IS DISTINCT FROM ${TAG}`);

      const openInvitationId = `${TAG}-open-invite`;
      const expiredInvitationId = `${TAG}-expired-invite`;
      // Open admin invitation: unconsumed, expires in the future.
      await tx.execute(sql`
        INSERT INTO invitations (id, user_id, invited_by_user_id, intended_role, expires_at, consumed_at)
        VALUES (${openInvitationId}, ${openInviteUserId}::uuid, ${openInviteUserId}::uuid,
                'admin', now() + interval '3 days', NULL)`);
      // Expired admin invitation: unconsumed, already past expiry.
      await tx.execute(sql`
        INSERT INTO invitations (id, user_id, invited_by_user_id, intended_role, expires_at, consumed_at)
        VALUES (${expiredInvitationId}, ${expiredInviteUserId}::uuid, ${expiredInviteUserId}::uuid,
                'admin', now() - interval '1 day', NULL)`);

      await body(tx, {
        ...emails,
        openInvitationId,
        expiredInvitationId,
      });
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

describe('T042 Migration C promotion rehearsal (live Neon, reads the real SQL)', () => {
  it('promotes every human admin — active AND disabled — to super_admin', async () => {
    await inRolledBackTx(async (tx, f) => {
      await applyMigrationC(tx);
      expect((await roleOf(tx, f.humanAdminActive))?.role).toBe('super_admin');
      expect((await roleOf(tx, f.humanAdminActive2))?.role).toBe('super_admin');
      const disabled = await roleOf(tx, f.humanAdminDisabled);
      expect(disabled?.role).toBe('super_admin');
      // Promotion changes the role only — the disabled status is preserved.
      expect(disabled?.status).toBe('disabled');
    });
  });

  it('leaves all three system actors untouched (excluded by id)', async () => {
    await inRolledBackTx(async (tx) => {
      await applyMigrationC(tx);
      for (const id of SYSTEM_ACTOR_IDS) {
        const actor = await roleOfId(tx, id);
        expect(actor?.role, `system actor ${id} must not be promoted`).toBe('admin');
        expect(actor?.status).toBe('disabled');
      }
    });
  });

  it('leaves the D18 pre-minted super_admin untouched', async () => {
    await inRolledBackTx(async (tx, f) => {
      await applyMigrationC(tx);
      const sa = await roleOf(tx, f.preMintedSuperAdmin);
      expect(sa?.role).toBe('super_admin');
      expect(sa?.status).toBe('active');
    });
  });

  it('promotes an OPEN admin invitation coherently with its user row', async () => {
    await inRolledBackTx(async (tx, f) => {
      await applyMigrationC(tx);
      // Both sides move together → redeem-invite's tamper check (user.role ===
      // invitation.intendedRole) still passes (T044 pins that consequence).
      expect((await roleOf(tx, f.openInviteUserEmail))?.role).toBe('super_admin');
      expect(await invitationRole(tx, f.openInvitationId)).toBe('super_admin');
    });
  });

  it('skips EXPIRED invitations (intended_role stays admin)', async () => {
    await inRolledBackTx(async (tx, f) => {
      await applyMigrationC(tx);
      // The user row still promotes (role predicate), but the expired invitation
      // is left at 'admin'. Harmless: redeem-invite rejects on expiry BEFORE the
      // role comparison, so the divergence is unreachable; reissue re-derives
      // intended_role from the (now super_admin) user row.
      expect(await invitationRole(tx, f.expiredInvitationId)).toBe('admin');
    });
  });
});
