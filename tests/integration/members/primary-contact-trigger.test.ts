/**
 * 108 T031 (US2 / FR-010a) — migration 0293 rehearsal on live Neon.
 *
 * Two deferred CONSTRAINT TRIGGERs guarantee "exactly one live primary" below
 * the application, evaluated at COMMIT so that legitimate multi-statement
 * sequences (demote-then-promote; scrub + erased_at) pass while a sequence
 * that ends in the forbidden state fails as a typed DB error.
 *
 * Scope (spec AMENDMENT 2026-09-05): the rule is enforced for a non-archived,
 * non-erased member that has AT LEAST ONE contact row at commit time. That one
 * predicate is shared by the pre-check DO block, the contacts trigger and the
 * members trigger; this file pins each of them against it.
 *
 * Honest RED accounting: the "passes" cases below (demote-then-promote,
 * erasure, hard-delete chain, contact-less member) cannot fail before the
 * trigger exists — they prove the trigger does not OVER-fire. They are
 * mutation-proved after GREEN by dropping the archived/erased/contact-row
 * exemptions from the function and watching them fail.
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import type { ContactId, MemberId } from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'drizzle/migrations/0293_primary_contact_invariant_triggers.sql',
);
const JOURNAL_PATH = path.resolve(
  process.cwd(),
  'drizzle/migrations/meta/_journal.json',
);

/** The stable token the trigger's RAISE carries (same idea as `last-admin-protection`). */
const TRIGGER_TOKEN = 'primary-contact-invariant';

/**
 * Extract the pre-check DO block from the migration file ON DISK, so a later
 * edit to the pre-check cannot drift from what this test pins (memory: a gate
 * must read SOURCE, not a frozen copy).
 */
function preCheckDoBlock(): string {
  const raw = readFileSync(MIGRATION_PATH, 'utf-8');
  const m = raw.match(/DO \$\$[\s\S]*?END \$\$;/);
  if (!m) throw new Error('0293: no `DO $$ … END $$;` pre-check block found');
  return m[0];
}

async function expectCommitRefused(
  p: Promise<unknown>,
  token: string | RegExp = TRIGGER_TOKEN,
): Promise<string> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected the transaction to be refused at COMMIT').toBeDefined();
  const msg = errorChainMessage(caught);
  expect(msg).toMatch(token);
  return msg;
}

describe('108 — primary-contact invariant triggers (migration 0293)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'test-plan',
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        createdBy: admin.userId,
        updatedBy: admin.userId,
        benefitMatrix: {
          eblast_per_year: 1,
          website_page_type: 'member_news_update',
          homepage_logo_category: 'regular',
          directory_listing_size: 'half_page',
          event_discount_scope: 'all_employees',
          events_cobranded_access: false,
          cultural_tickets_per_year: 0,
          m2m_benefits_access: true,
          business_referrals: true,
          tailor_made_services: false,
          partnership: null,
        },
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  type ContactSpec = { readonly isPrimary: boolean };

  /**
   * Seed a member + N contacts in ONE committed tx (the shape
   * `createWithPrimaryContactInTx` produces). `status` defaults to active.
   */
  async function seedMember(
    specs: readonly ContactSpec[],
    status: 'active' | 'inactive' | 'archived' = 'active',
  ): Promise<{ memberId: MemberId; contactIds: ContactId[] }> {
    const memberId = randomUUID() as MemberId;
    const contactIds = specs.map(() => randomUUID() as ContactId);
    const rand = randomUUID().slice(0, 8);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Trigger Co ${rand}`,
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status,
        archivedAt: status === 'archived' ? new Date() : null,
      });
      if (specs.length > 0) {
        await tx.insert(contacts).values(
          specs.map((s, i) => ({
            tenantId: tenant.ctx.slug,
            contactId: contactIds[i]!,
            memberId,
            firstName: 'C',
            lastName: `${i}`,
            email: `c${i}-${rand}@example.com`,
            preferredLanguage: 'en' as const,
            isPrimary: s.isPrimary,
          })),
        );
      }
    });
    return { memberId, contactIds };
  }

  async function livePrimaryCount(memberId: MemberId): Promise<number> {
    const rows = await db
      .select({ id: contacts.contactId })
      .from(contacts)
      .where(
        and(
          eq(contacts.memberId, memberId),
          eq(contacts.isPrimary, true),
          sql`${contacts.removedAt} IS NULL`,
        ),
      );
    return rows.length;
  }

  // ── the migration exists and is installed ─────────────────────────────────

  it('migration 0293 exists on disk and is journaled', () => {
    expect(existsSync(MIGRATION_PATH), MIGRATION_PATH).toBe(true);
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as {
      entries: ReadonlyArray<{ tag: string }>;
    };
    expect(
      journal.entries.some((e) => e.tag === '0293_primary_contact_invariant_triggers'),
    ).toBe(true);
  });

  it('both constraint triggers are installed, DEFERRABLE INITIALLY DEFERRED', async () => {
    const rows = (await db.execute(sql`
      SELECT t.tgname, c.relname, t.tgdeferrable, t.tginitdeferred, p.prosecdef
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc  p ON p.oid = t.tgfoid
       WHERE t.tgname IN ('contacts_one_primary_ct', 'members_one_primary_ct')
       ORDER BY t.tgname
    `)) as unknown as ReadonlyArray<{
      tgname: string;
      relname: string;
      tgdeferrable: boolean;
      tginitdeferred: boolean;
      prosecdef: boolean;
    }>;
    expect(rows.map((r) => [r.tgname, r.relname])).toEqual([
      ['contacts_one_primary_ct', 'contacts'],
      ['members_one_primary_ct', 'members'],
    ]);
    for (const r of rows) {
      expect(r.tgdeferrable, `${r.tgname} deferrable`).toBe(true);
      expect(r.tginitdeferred, `${r.tgname} initially deferred`).toBe(true);
      // SECURITY DEFINER — the count must be complete whoever fires it.
      expect(r.prosecdef, `${r.tgname} function is SECURITY DEFINER`).toBe(true);
    }
  });

  // ── pre-check DO block (FR-010a), read from the file on disk ──────────────

  it('pre-check: passes on this branch (control — no member WITH contacts violates)', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(preCheckDoBlock()));
    });
  });

  it('pre-check: raises on a seeded violation (positive control, rolled back)', async () => {
    // Seeded as the BYPASSRLS owner inside a tx we never commit, so the DO
    // block sees it (same snapshot) and the branch is left untouched.
    const memberId = randomUUID();
    const rand = randomUUID().slice(0, 8);
    const attempt = db.transaction(async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: memberId as MemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Precheck Co ${rand}`,
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID() as ContactId,
        memberId: memberId as MemberId,
        firstName: 'No',
        lastName: 'Primary',
        email: `noprimary-${rand}@example.com`,
        preferredLanguage: 'en',
        isPrimary: false,
      });
      await tx.execute(sql.raw(preCheckDoBlock()));
    });
    await expectCommitRefused(attempt, /primary-contact invariant violated for 1 member/);
    // Nothing leaked.
    const leaked = await db
      .select({ id: members.memberId })
      .from(members)
      .where(eq(members.memberId, memberId as MemberId));
    expect(leaked).toHaveLength(0);
  });

  it('pre-check: a contact-less member is NOT a violation (AMENDMENT scope)', async () => {
    const memberId = randomUUID();
    const rand = randomUUID().slice(0, 8);
    await db.transaction(async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: memberId as MemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Contactless Co ${rand}`,
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status: 'active',
      });
      await tx.execute(sql.raw(preCheckDoBlock()));
      // Roll back explicitly — the branch stays as it was.
      throw new Error('rollback-sentinel');
    }).catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== 'rollback-sentinel') throw e;
    });
  });

  // ── contacts trigger: sequences that must PASS ────────────────────────────

  it('demote-then-promote in one tx passes (deferred to COMMIT)', async () => {
    const s = await seedMember([{ isPrimary: true }, { isPrimary: false }]);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(contacts)
        .set({ isPrimary: false })
        .where(eq(contacts.contactId, s.contactIds[0]!));
      // Between these two statements the member has ZERO primaries.
      await tx
        .update(contacts)
        .set({ isPrimary: true })
        .where(eq(contacts.contactId, s.contactIds[1]!));
    });
    expect(await livePrimaryCount(s.memberId)).toBe(1);
  });

  it('erasure (scrub every contact + erased_at, one tx) passes — FR-013', async () => {
    const s = await seedMember([{ isPrimary: true }, { isPrimary: false }]);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(contacts)
        .set({ isPrimary: false, removedAt: new Date() })
        .where(eq(contacts.memberId, s.memberId));
      await tx
        .update(members)
        .set({ erasedAt: new Date() })
        .where(eq(members.memberId, s.memberId));
    });
    expect(await livePrimaryCount(s.memberId)).toBe(0);
  });

  it('contact edits on an ARCHIVED member with no primary pass (rule suspended)', async () => {
    const s = await seedMember([{ isPrimary: false }], 'archived');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(contacts)
        .set({ firstName: 'Renamed' })
        .where(eq(contacts.contactId, s.contactIds[0]!));
    });
    expect(await livePrimaryCount(s.memberId)).toBe(0);
  });

  it('member hard-delete chain (contacts, then the member, one tx) passes', async () => {
    const s = await seedMember([{ isPrimary: true }]);
    await db.transaction(async (tx) => {
      await tx.delete(contacts).where(eq(contacts.memberId, s.memberId));
      await tx.delete(members).where(eq(members.memberId, s.memberId));
    });
    const gone = await db
      .select({ id: members.memberId })
      .from(members)
      .where(eq(members.memberId, s.memberId));
    expect(gone).toHaveLength(0);
  });

  it('hard-deleting EVERY contact of a live member passes (the cleanup shape)', async () => {
    // `tests/integration/helpers/test-tenant.ts` and 38 suites run
    // `DELETE FROM contacts WHERE tenant_id = …` as its own statement before
    // `members`. Zero rows remain → exempt (AMENDMENT).
    const s = await seedMember([{ isPrimary: true }, { isPrimary: false }]);
    await db.transaction(async (tx) => {
      await tx.delete(contacts).where(eq(contacts.memberId, s.memberId));
    });
    expect(await livePrimaryCount(s.memberId)).toBe(0);
  });

  // ── contacts trigger: sequences that must FAIL at COMMIT ──────────────────

  it('leaving zero primaries on an ACTIVE member fails at COMMIT', async () => {
    const s = await seedMember([{ isPrimary: true }, { isPrimary: false }]);
    await expectCommitRefused(
      runInTenant(tenant.ctx, async (tx) => {
        await tx
          .update(contacts)
          .set({ isPrimary: false })
          .where(eq(contacts.contactId, s.contactIds[0]!));
      }),
    );
    // Rolled back: the original primary is still primary.
    expect(await livePrimaryCount(s.memberId)).toBe(1);
  });

  it('soft-removing the only primary of an INACTIVE member fails at COMMIT', async () => {
    const s = await seedMember([{ isPrimary: true }], 'inactive');
    await expectCommitRefused(
      runInTenant(tenant.ctx, async (tx) => {
        await tx
          .update(contacts)
          .set({ isPrimary: false, removedAt: new Date() })
          .where(eq(contacts.contactId, s.contactIds[0]!));
      }),
    );
    expect(await livePrimaryCount(s.memberId)).toBe(1);
  });

  it('hard-deleting the primary while a secondary remains fails at COMMIT', async () => {
    const s = await seedMember([{ isPrimary: true }, { isPrimary: false }]);
    await expectCommitRefused(
      db.transaction(async (tx) => {
        await tx.delete(contacts).where(eq(contacts.contactId, s.contactIds[0]!));
      }),
    );
    expect(await livePrimaryCount(s.memberId)).toBe(1);
  });

  it('the raise names the count so the app can map 0 → no_primary_contact', async () => {
    const s = await seedMember([{ isPrimary: true }]);
    const msg = await expectCommitRefused(
      runInTenant(tenant.ctx, async (tx) => {
        await tx
          .update(contacts)
          .set({ isPrimary: false })
          .where(eq(contacts.contactId, s.contactIds[0]!));
      }),
    );
    expect(msg).toMatch(/has 0 live primary/);
    // bulk-action.ts parses the member uuid out of this exact shape to return
    // a per-member state_error — pin it here so a message edit fails loudly.
    expect(msg).toMatch(/member [0-9a-f-]{36} in tenant /);
    expect(msg).not.toMatch(/@/); // never an email address in the raise
  });

  // ── members trigger (UPDATE OF status, erased_at) ─────────────────────────

  it('a bad unarchive (archived + zero primaries → active) fails at COMMIT — FR-014 backstop', async () => {
    const s = await seedMember([{ isPrimary: false }], 'archived');
    await expectCommitRefused(
      runInTenant(tenant.ctx, async (tx) => {
        await tx
          .update(members)
          .set({ status: 'active', archivedAt: null })
          .where(eq(members.memberId, s.memberId));
      }),
    );
    const [row] = await db
      .select({ status: members.status })
      .from(members)
      .where(eq(members.memberId, s.memberId));
    expect(row?.status).toBe('archived');
  });

  it('unarchive with the designation in the same tx passes', async () => {
    const s = await seedMember([{ isPrimary: false }], 'archived');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(contacts)
        .set({ isPrimary: true })
        .where(eq(contacts.contactId, s.contactIds[0]!));
      await tx
        .update(members)
        .set({ status: 'active', archivedAt: null })
        .where(eq(members.memberId, s.memberId));
    });
    expect(await livePrimaryCount(s.memberId)).toBe(1);
  });

  it('a status change on a member with NO contact rows passes (AMENDMENT scope)', async () => {
    const s = await seedMember([]);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ status: 'inactive' })
        .where(eq(members.memberId, s.memberId));
    });
    const [row] = await db
      .select({ status: members.status })
      .from(members)
      .where(eq(members.memberId, s.memberId));
    expect(row?.status).toBe('inactive');
  });

  it('archiving a member that HAS a primary passes and keeps it (final snapshot)', async () => {
    const s = await seedMember([{ isPrimary: true }]);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ status: 'archived', archivedAt: new Date() })
        .where(eq(members.memberId, s.memberId));
    });
    expect(await livePrimaryCount(s.memberId)).toBe(1);
  });

  // ── T041 review round 1 (migration + security reviewers) ──────────────────

  it('re-parenting the primary to another member leaves the OLD member at zero → fails at COMMIT', async () => {
    // No app path moves a contact between members, but this migration
    // declares itself the backstop for bare SQL and scripts — and
    // scripts/seed-e2e-portal-invoices.ts does exactly this move. The trigger
    // must check the member the row LEFT, not only the one it joined.
    const a = await seedMember([{ isPrimary: true }, { isPrimary: false }]);
    const b = await seedMember([{ isPrimary: true }]);
    await expectCommitRefused(
      db.transaction(async (tx) => {
        await tx
          .update(contacts)
          .set({ memberId: b.memberId, isPrimary: false })
          .where(eq(contacts.contactId, a.contactIds[0]!));
      }),
    );
    expect(await livePrimaryCount(a.memberId)).toBe(1);
    expect(await livePrimaryCount(b.memberId)).toBe(1);
  });

  it('counts within the row\'s tenant only: the same member_id in another tenant does not mask a violation', async () => {
    // (tenant_id, member_id) is the composite key, so two tenants can hold the
    // same member uuid. If the function ever dropped its tenant_id filter, B's
    // count would read A's primary and pass silently.
    const other = await createTestTenant('test-swecham');
    try {
      const sharedMemberId = randomUUID() as MemberId;
      const rand = randomUUID().slice(0, 8);
      for (const t of [tenant, other]) {
        await runInTenant(t.ctx, async (tx) => {
          if (t === other) {
            await tx.insert(tenantInvoiceSettings).values({
              tenantId: t.ctx.slug,
              currencyCode: 'THB',
              vatRate: '0.0700',
              registrationFeeSatang: 100000n,
              legalNameTh: 'Other TH',
              legalNameEn: 'Other EN',
              taxId: '0000000000001',
              registeredAddressTh: 'Other Address TH',
              registeredAddressEn: 'Other Address EN',
              invoiceNumberPrefix: 'INV',
              creditNoteNumberPrefix: 'CN',
            });
            await tx.insert(membershipPlans).values({
              tenantId: t.ctx.slug,
              planId: 'test-plan',
              planYear: 2026,
              planName: { en: 'Test Plan' },
              description: { en: 'Test description' },
              sortOrder: 10,
              planCategory: 'corporate',
              memberTypeScope: 'company',
              annualFeeMinorUnits: 1_000_000,
              createdBy: admin.userId,
              updatedBy: admin.userId,
              benefitMatrix: {
                eblast_per_year: 1,
                website_page_type: 'member_news_update',
                homepage_logo_category: 'regular',
                directory_listing_size: 'half_page',
                event_discount_scope: 'all_employees',
                events_cobranded_access: false,
                cultural_tickets_per_year: 0,
                m2m_benefits_access: true,
                business_referrals: true,
                tailor_made_services: false,
                partnership: null,
              },
            });
          }
          await tx.insert(members).values({
            tenantId: t.ctx.slug,
            memberId: sharedMemberId,
            memberNumber: nextSeedMemberNumber(),
            companyName: `Shared Id Co ${rand}`,
            country: 'TH',
            planId: 'test-plan',
            planYear: 2026,
            status: 'active',
          });
          await tx.insert(contacts).values({
            tenantId: t.ctx.slug,
            contactId: randomUUID() as ContactId,
            memberId: sharedMemberId,
            firstName: 'P',
            lastName: t.ctx.slug,
            email: `shared-${t.ctx.slug}-${rand}@example.com`,
            preferredLanguage: 'en',
            isPrimary: true,
          });
        });
      }
      // Remove B's only primary. A's primary must NOT be counted for B.
      await expectCommitRefused(
        runInTenant(other.ctx, async (tx) => {
          await tx
            .update(contacts)
            .set({ isPrimary: false, removedAt: new Date() })
            .where(eq(contacts.memberId, sharedMemberId));
        }),
      );
    } finally {
      await other.cleanup();
    }
  });

  it('the helper fails CLOSED under RLS (row_security=off), is owned by a BYPASSRLS role, and 0293 hands lock_timeout back (round 4, F4-#3 / F4-#4)', async () => {
    const rows = (await db.execute(sql`
      SELECT p.proconfig, r.rolbypassrls
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname = 'contacts_check_member_primary'
    `)) as unknown as ReadonlyArray<{ proconfig: string[] | null; rolbypassrls: boolean }>;
    expect(rows).toHaveLength(1);
    // Under RLS FORCE the owner is subject to policies unless it has
    // BYPASSRLS. With row_security=off a query a policy WOULD filter errors
    // out instead of silently reading zero rows — so a helper that cannot see
    // the member's contacts refuses the commit rather than exempting the
    // member ("v_contact_rows = 0 → RETURN" must never mean "blind").
    expect(rows[0]!.proconfig).toContain('row_security=off');
    expect(rows[0]!.rolbypassrls).toBe(true);
    // SET LOCAL lives to the end of the migrator's single batch transaction;
    // 0293 must hand the default back after its DDL so a later migration in
    // the same deploy is not aborted by 0293's 5 s lock_timeout.
    const text = readFileSync(MIGRATION_PATH, 'utf-8');
    const reset = text.lastIndexOf('SET LOCAL lock_timeout = DEFAULT');
    const lastTrigger = text.lastIndexOf('CREATE CONSTRAINT TRIGGER');
    expect(reset).toBeGreaterThan(lastTrigger);
  });

  it('the function pins a safe search_path and is not executable by PUBLIC', async () => {
    const rows = (await db.execute(sql`
      SELECT p.proconfig,
             has_function_privilege('chamber_app', p.oid, 'EXECUTE') AS app_can_execute,
             p.proacl::text AS acl
        FROM pg_proc p
       WHERE p.proname = 'contacts_assert_one_primary'
    `)) as unknown as ReadonlyArray<{
      proconfig: string[] | null;
      app_can_execute: boolean;
      acl: string | null;
    }>;
    expect(rows).toHaveLength(1);
    // pg_catalog FIRST (CVE-2018-1058 class), pg_temp LAST and explicit (a
    // session's TEMP TABLE members must not shadow the real one).
    expect(rows[0]!.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    expect(rows[0]!.app_can_execute).toBe(true);
    // A NULL acl means the default (PUBLIC may EXECUTE). After REVOKE … FROM
    // PUBLIC the acl is explicit and carries no `=X` (PUBLIC) entry.
    expect(rows[0]!.acl).not.toBeNull();
    expect(rows[0]!.acl).not.toMatch(/(^|,)=X\//);
  });

  // ── T041 review round 2 (migration reviewer N1 + N2) ──────────────────────

  it('the app role cannot call the DEFINER helper directly (no cross-tenant count oracle)', async () => {
    // `contacts_check_member_primary(tenant, member)` runs as the BYPASSRLS
    // owner and takes a caller-supplied tenant. With EXECUTE, chamber_app could
    // probe another tenant's member for existence + live-primary count from
    // the raise text. The trigger body calls it as the owner, so the app role
    // needs no grant at all.
    let caught: unknown;
    try {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(
          sql`SELECT public.contacts_check_member_primary(${'other-tenant'}, ${randomUUID()}::uuid)`,
        );
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'expected permission denied').toBeDefined();
    expect(errorChainMessage(caught)).toMatch(/permission denied/i);
  });

  it('the migration recorded as applied is the file on disk (edit-after-apply tripwire)', async () => {
    // drizzle applies a file when its journal `when` is newer than the last
    // applied `created_at` and never compares hashes — so a file edited after
    // it was applied to this branch is silently skipped by `db:migrate`
    // (memory: silent no-op on a `when` collision). This pins the recorded
    // sha256 to the file's current content: red means bump `when`.
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(readFileSync(MIGRATION_PATH, 'utf-8')).digest('hex');
    const rows = (await db.execute(sql`
      SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}
    `)) as unknown as ReadonlyArray<{ hash: string }>;
    expect(rows.length, 'no applied-migration row matches the file on disk — bump `when` and db:migrate').toBeGreaterThan(0);
  });

  it('a plain (tenant_id, member_id) index backs the per-row count at commit', async () => {
    const rows = (await db.execute(sql`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'contacts' AND indexname = 'contacts_tenant_member_all_idx'
    `)) as unknown as ReadonlyArray<{ indexname: string }>;
    expect(rows).toHaveLength(1);
  });
});
