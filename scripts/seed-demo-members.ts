/**
 * Demo seed: 20 sample members + their primary contacts for the SweCham
 * tenant, sourced from the gitignored Excel template via the upstream
 * Python extractor (`scripts/extract-demo-members.py`).
 *
 * Pre-requisites
 * --------------
 *   1. `pnpm tsx scripts/seed-bootstrap-admin.ts` (or equivalent) — at
 *      least one admin user must exist; we use it as `actor_user_id`.
 *   2. `pnpm tsx scripts/seed-swecham-2026-plans.ts` — the 9 SweCham 2026
 *      plans (platinum/gold/premium/large/regular/start-up/individual/...)
 *      must exist; the composite FK on members will reject otherwise.
 *   3. `python scripts/extract-demo-members.py` — produces the JSON
 *      payload at `scripts/_demo-data/demo-members.json` (gitignored).
 *
 * Idempotency
 * -----------
 *   Each row checks `companyName` (case-insensitive) inside the tenant
 *   before inserting. A re-run is a no-op for already-seeded members and
 *   inserts only the missing ones. Audit events are written ONLY for
 *   newly-inserted rows so we do not double-count in the timeline.
 *
 * Atomicity
 * ---------
 *   Each (member + primary contact + 2 audit events) tuple is wrapped in
 *   one `runInTenant()` transaction so partial failures roll back cleanly.
 *
 * Usage
 * -----
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/seed-demo-members.ts
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { and, eq, sql, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

import { db, runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans';

// --- JSON payload schema (matches extract-demo-members.py output) ------------
//
// Phase 6 review-round 2 TD-S1 — runtime validation. Earlier the demo
// JSON shape was only TypeScript-typed; an Excel template column rename
// in `extract-demo-members.py` would silently produce undefined fields
// here that crash mid-insert (or worse, write garbage rows). The
// `schemaVersion` field pins the contract so a Python-side bump fails
// loud at the TS boundary instead of corrupting production data.

const DEMO_SCHEMA_VERSION = 1 as const;

const demoContactSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().nullable(),
  roleTitle: z.string().nullable(),
  preferredLanguage: z.enum(['en', 'th', 'sv']),
});

const demoRowSchema = z.object({
  companyName: z.string().min(1),
  country: z.string().length(2),
  taxId: z.string().nullable(),
  planId: z.string().min(1),
  registrationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['active', 'inactive', 'archived']),
  notes: z.string().nullable(),
  billingEmail: z.string().email().nullable(),
  primaryContact: demoContactSchema,
});

const demoPayloadSchema = z.object({
  schemaVersion: z.literal(DEMO_SCHEMA_VERSION),
  tenantSlug: z.literal('swecham'),
  planYear: z.number().int().positive(),
  rows: z.array(demoRowSchema).min(1),
});

type DemoRow = z.infer<typeof demoRowSchema>;
type DemoPayload = z.infer<typeof demoPayloadSchema>;

// --- Guards ------------------------------------------------------------------

function requireSwechamTenant(): TenantContext {
  const slug = process.env.TENANT_SLUG ?? '';
  if (slug !== 'swecham') {
    throw new Error(
      `seed-demo-members: refusing to run against TENANT_SLUG="${slug}". ` +
        `Set TENANT_SLUG=swecham.`,
    );
  }
  return asTenantContext('swecham');
}

/**
 * Phase 6 review-round 2 C3 — tenant-scoped admin lookup.
 *
 * Previously this queried `users` with `eq(role, 'admin')` and NO tenant
 * filter, picking the first admin **across ALL tenants** as the seed's
 * audit_log `actor_user_id`. F1's `users` table is intentionally
 * tenant-agnostic per Constitution Principle I (cross-tenant identity
 * exception, see `docs/saas-architecture.md` § 4); membership lives in
 * `contacts.linked_user_id` (set on invitation acceptance). The correct
 * resolution path for "the swecham admin" is therefore:
 *
 *   1. If `BOOTSTRAP_ADMIN_EMAIL` is set, exact email lookup (operator
 *      explicitly pins the actor; tenant-agnostic but unambiguous).
 *   2. Otherwise JOIN `contacts.linked_user_id` for the swecham tenant
 *      and take the FIRST admin role match. RLS+FORCE on `contacts`
 *      enforces tenant scope at the DB layer; we still bind via
 *      `runInTenant` for the application-layer half of the 2-layer rule.
 *   3. If neither path resolves, throw with operator guidance.
 */
async function findActorUserId(ctx: TenantContext): Promise<string> {
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
  if (bootstrapEmail) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, bootstrapEmail))
      .limit(1);
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(
        `seed-demo-members: BOOTSTRAP_ADMIN_EMAIL=${bootstrapEmail} not found in users table.`,
      );
    }
    return id;
  }
  const rows = await runInTenant(ctx, async (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(contacts, eq(contacts.linkedUserId, users.id))
      .where(
        and(
          eq(users.role, 'admin'),
          eq(contacts.tenantId, ctx.slug),
          isNotNull(contacts.linkedUserId),
        ),
      )
      .limit(1),
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      'seed-demo-members: no admin user found in tenant. ' +
        'Set BOOTSTRAP_ADMIN_EMAIL=<email>, or ensure an admin contact exists ' +
        'with linked_user_id set (run `pnpm tsx scripts/seed-bootstrap-admin.ts`).',
    );
  }
  return id;
}

async function loadPayload(): Promise<DemoPayload> {
  const path = resolve('scripts/_demo-data/demo-members.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new Error(
      `seed-demo-members: ${path} not found. Run \`python scripts/extract-demo-members.py\` first.`,
    );
  }
  const parseResult = demoPayloadSchema.safeParse(JSON.parse(raw));
  if (!parseResult.success) {
    throw new Error(
      'seed-demo-members: JSON payload failed schema validation. ' +
        'Likely cause: extract-demo-members.py emitted a different shape than ' +
        `seed-demo-members.ts expects (schemaVersion=${DEMO_SCHEMA_VERSION}). ` +
        `First issue: ${parseResult.error.issues[0]?.message ?? 'unknown'} ` +
        `at path: ${parseResult.error.issues[0]?.path.join('.') ?? '(root)'}`,
    );
  }
  return parseResult.data;
}

async function assertPlansExist(
  ctx: TenantContext,
  planYear: number,
  planIds: ReadonlyArray<string>,
): Promise<void> {
  const found = await runInTenant(ctx, (tx) =>
    tx
      .select({ planId: membershipPlans.planId })
      .from(membershipPlans)
      .where(eq(membershipPlans.planYear, planYear)),
  );
  const have = new Set(found.map((r) => r.planId));
  const missing = planIds.filter((id) => !have.has(id));
  if (missing.length > 0) {
    throw new Error(
      `seed-demo-members: missing plans for (swecham, ${planYear}): ` +
        `${missing.join(', ')}. ` +
        `Run \`pnpm tsx scripts/seed-swecham-2026-plans.ts\` first.`,
    );
  }
}

// --- Insert path -------------------------------------------------------------

type InsertOutcome = 'inserted' | 'skipped' | 'repaired-tax-id';

export async function seedRow(
  ctx: TenantContext,
  actorUserId: string,
  planYear: number,
  row: DemoRow,
): Promise<InsertOutcome> {
  return await runInTenant(ctx, async (tx): Promise<InsertOutcome> => {
    // Idempotency guard — if this company already exists, only repair
    // tax_id (Excel is the source of truth) and leave every other field
    // alone in case an operator already edited the row.
    const existing = await tx
      .select({
        memberId: members.memberId,
        currentTaxId: members.taxId,
      })
      .from(members)
      .where(eq(sql`lower(${members.companyName})`, row.companyName.toLowerCase()))
      .limit(1);
    if (existing.length > 0) {
      const current = existing[0]!;
      if ((current.currentTaxId ?? null) === (row.taxId ?? null)) {
        return 'skipped';
      }
      await tx
        .update(members)
        .set({ taxId: row.taxId, updatedAt: new Date() })
        .where(eq(members.memberId, current.memberId));
      await tx.insert(auditLog).values({
        eventType: 'member_updated',
        actorUserId,
        summary: `Demo seed: repaired tax_id for ${row.companyName}`,
        requestId: `seed-demo-repair-${randomUUID()}`,
        tenantId: ctx.slug,
        payload: {
          member_id: current.memberId,
          field: 'tax_id',
          old_value: current.currentTaxId,
          new_value: row.taxId,
          source: 'seed-demo-members:repair',
        },
      });
      return 'repaired-tax-id';
    }

    const memberId = randomUUID();
    const contactId = randomUUID();
    const now = new Date();
    const requestId = `seed-demo-${randomUUID()}`;

    // 1. Insert member
    await tx.insert(members).values({
      tenantId: ctx.slug,
      memberId,
      companyName: row.companyName,
      country: row.country,
      taxId: row.taxId,
      planId: row.planId,
      planYear,
      registrationDate: row.registrationDate,
      registrationFeePaid: true, // demo members are paid-up
      notes: row.notes,
      status: row.status,
    });

    // 2. Insert primary contact (FR-003 — one primary per member)
    await tx.insert(contacts).values({
      tenantId: ctx.slug,
      contactId,
      memberId,
      firstName: row.primaryContact.firstName,
      lastName: row.primaryContact.lastName,
      email: row.primaryContact.email,
      phone: row.primaryContact.phone,
      roleTitle: row.primaryContact.roleTitle,
      preferredLanguage: row.primaryContact.preferredLanguage,
      isPrimary: true,
    });

    // 3. Audit — `member_created` (the AFTER INSERT trigger on audit_log
    //    will bump members.last_activity_at because we include member_id
    //    in the payload).
    await tx.insert(auditLog).values({
      eventType: 'member_created',
      actorUserId,
      summary: `Demo seed: created member ${row.companyName} (${row.planId})`,
      requestId,
      tenantId: ctx.slug,
      payload: {
        member_id: memberId,
        company_name: row.companyName,
        plan_id: row.planId,
        plan_year: planYear,
        country: row.country,
        source: 'seed-demo-members',
        timestamp: now.toISOString(),
      },
    });

    // 4. Audit — `contact_created`
    await tx.insert(auditLog).values({
      eventType: 'contact_created',
      actorUserId,
      summary: `Demo seed: primary contact for ${row.companyName}`,
      requestId,
      tenantId: ctx.slug,
      payload: {
        member_id: memberId,
        contact_id: contactId,
        is_primary: true,
        email: row.primaryContact.email,
        source: 'seed-demo-members',
      },
    });

    return 'inserted';
  });
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const ctx = requireSwechamTenant();
  console.log(`[seed-demo-members] tenant: ${ctx.slug}`);

  const actorUserId = await findActorUserId(ctx);
  console.log(`[seed-demo-members] actor user: ${actorUserId}`);

  const payload = await loadPayload();
  console.log(
    `[seed-demo-members] loaded payload: ${payload.rows.length} rows for plan_year=${payload.planYear}`,
  );

  const planIds = Array.from(new Set(payload.rows.map((r) => r.planId)));
  await assertPlansExist(ctx, payload.planYear, planIds);
  console.log(
    `[seed-demo-members] verified ${planIds.length} plan IDs exist: ${planIds.join(', ')}`,
  );

  let inserted = 0;
  let skipped = 0;
  let repaired = 0;
  const failures: Array<{ company: string; reason: string }> = [];

  for (const row of payload.rows) {
    try {
      const outcome = await seedRow(ctx, actorUserId, payload.planYear, row);
      switch (outcome) {
        case 'inserted':
          inserted += 1;
          console.log(`  ✓ inserted: ${row.companyName} (${row.planId})`);
          break;
        case 'repaired-tax-id':
          repaired += 1;
          console.log(`  ⟳ repaired tax_id: ${row.companyName}`);
          break;
        case 'skipped':
          skipped += 1;
          console.log(`  ↷ skipped (already canonical): ${row.companyName}`);
          break;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failures.push({ company: row.companyName, reason });
      console.error(`  ✗ failed: ${row.companyName} — ${reason}`);
    }
  }

  console.log('');
  console.log(`[seed-demo-members] DONE`);
  console.log(`  inserted: ${inserted}`);
  console.log(`  repaired: ${repaired}`);
  console.log(`  skipped:  ${skipped}`);
  console.log(`  failed:   ${failures.length}`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

// Phase 6 review-round 2 C1-test — only invoke `main()` when run as
// the entry point. Importing this module in tests no longer triggers
// the whole seed pipeline; tests call `seedRow()` directly with a
// throwaway tenant.
const isEntryPoint =
  process.argv[1] !== undefined &&
  /seed-demo-members\.[cm]?[jt]s$/.test(process.argv[1]);
if (isEntryPoint) {
  main()
    .catch((e) => {
      console.error(
        '[seed-demo-members] FAILED:',
        e instanceof Error ? e.message : e,
      );
      process.exitCode = 1;
    })
    // Phase 6 review-round 2 F5 — explicit `process.exit()` so the pg
    // client's idle pool doesn't keep Node alive for ~20s after the
    // script's work completes. Previously the `.finally(() => void sql)`
    // was a documented no-op that gave the appearance of cleanup
    // without actually closing the connection — making CI runs hang
    // for 20 seconds on every successful seed.
    .finally(() => {
      process.exit(process.exitCode ?? 0);
    });
}
