/**
 * #66 — an admin credit note is issued ONCE per idempotency key (mig 0323).
 *
 * The admin form sends one uuid per issue attempt. A repeat with the same key
 * (a retry after a dropped response, a resubmit after a reload) returns the
 * note already issued: no second §86/10 note, no second §87 number. A race of
 * two attempts with one key yields one note (the partial UNIQUE
 * `credit_notes_tenant_idempotency_key_uniq` is the backstop; the loser
 * reconciles). Different keys are two real notes. The key is locked by the
 * immutability trigger, and keys are per tenant.
 *
 * Live Neon dev; PDF render, Blob and the outbox are module-mocked as in
 * `credit-note-from-refund-idempotent.test.ts`. Run in isolation:
 *   pnpm test:integration tests/integration/invoicing/credit-note-idempotency-key.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// --- Module-level mocks of external adapters --------------------------------
// The bridge wrapper calls makeIssueCreditNoteDeps() which wires these
// adapters. Mock the whole adapter surface so every call returns deterministic
// stubs. The DB side (invoice repo, credit-note repo, sequence allocator, audit
// adapter) stays real so the idempotency + no-gap guarantees are genuinely
// exercised against live Neon.
vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', async () => {
  const { Sha256Hex: S } = await import(
    '@/modules/invoicing/domain/value-objects/sha256-hex'
  );
  return {
    reactPdfRenderAdapter: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // '%PDF'
        sha256: S.ofUnsafe('b'.repeat(64)),
      })),
    },
  };
});
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    uploadLogo: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: {
    enqueue: vi.fn(async () => {}),
  },
}));

// Imports that depend on the mocked modules MUST come after the vi.mock calls.
import { issueCreditNote, issueCreditNoteSchema } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { makeIssueCreditNoteDeps } from '@/modules/invoicing/application/invoicing-deps';

const MATRIX: BenefitMatrix = {
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
};

const INVOICE_TOTAL = 107_000n;
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
const FISCAL_YEAR = 2026;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Idem Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/** A `paid` membership invoice paid by bank transfer (no online payment to guard). */
/** A distinct sequence per seeded invoice: `invoices_tenant_fiscal_seq_unique` (R123). */
let seedSequence = 0;

/** A Result carries bigint satang, which plain JSON.stringify cannot print (R123). */
function show(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * The whole message chain of a rejection: drizzle wraps a PG error as "Failed
 * query: …" and keeps the trigger's RAISE text on `cause` (R123).
 */
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const parts: string[] = [];
    let current: unknown = e;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused');
}

async function seedPaidInvoice(tenant: TestTenant, user: TestUser, planId: string): Promise<string> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Idem Key Co',
      country: 'TH',
      planId,
      planYear: FISCAL_YEAR,
    });
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: FISCAL_YEAR,
      planId,
      draftByUserId: user.userId,
      status: 'paid',
      pdfDocKind: 'invoice',
      receiptPdfStatus: 'rendered',
      fiscalYear: FISCAL_YEAR,
      sequenceNumber: ++seedSequence,
      documentNumber: `IDK-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
      issueDate: '2026-04-15',
      dueDate: '2026-05-14',
      subtotalSatang: INVOICE_SUBTOTAL,
      vatRateSnapshot: '0.0700',
      vatSatang: INVOICE_VAT,
      totalSatang: INVOICE_TOTAL,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: 'invoicing/x/2026/seed.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: 'bank_transfer',
      paymentReference: 'seed-ref',
      paymentNotes: null,
      paymentRecordedByUserId: user.userId,
      paymentDate: '2026-04-20',
      paidAt: new Date('2026-04-20T03:00:00Z'),
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: INVOICE_SUBTOTAL,
      totalSatang: INVOICE_SUBTOTAL,
      position: 1,
    });
  });
  return invoiceId;
}

async function setUpTenant(user: TestUser, planId: string): Promise<TestTenant> {
  const tenant = await createTestTenant('test-chamber');
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: FISCAL_YEAR,
      planName: { en: 'Idem Key Plan' },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: tenant.ctx.slug,
      currencyCode: 'THB',
      vatRate: '0.0700',
      registrationFeeSatang: asSatang(0n),
      legalNameTh: 'ทดสอบ',
      legalNameEn: 'Test',
      taxId: '0000000000000',
      registeredAddressTh: 'Bangkok',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'IDK',
      creditNoteNumberPrefix: 'CN',
    });
  });
  return tenant;
}

async function readCreditNoteSeq(tenant: TestTenant): Promise<number> {
  const rows = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ next: tenantDocumentSequences.nextSequenceNumber })
      .from(tenantDocumentSequences)
      .where(
        and(
          eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
          eq(tenantDocumentSequences.documentType, 'credit_note'),
          eq(tenantDocumentSequences.fiscalYear, FISCAL_YEAR),
        ),
      ),
  );
  return rows[0]?.next ?? 1;
}

async function countNotes(tenant: TestTenant, invoiceId: string): Promise<number> {
  const rows = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ id: creditNotes.creditNoteId })
      .from(creditNotes)
      .where(and(eq(creditNotes.tenantId, tenant.ctx.slug), eq(creditNotes.originalInvoiceId, invoiceId))),
  );
  return rows.length;
}

describe('#66 — an admin credit note is issued once per idempotency key', () => {
  let user: TestUser;
  let tenant: TestTenant;
  let other: TestTenant;
  const planId = 'idem-key-cn-plan';

  function issue(t: TestTenant, invoiceId: string, key: string | undefined, total = 53_500n) {
    return issueCreditNote(makeIssueCreditNoteDeps(t.ctx.slug), {
      tenantId: t.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: asSatang(total),
      reason: 'duplicate charge',
      ...(key !== undefined ? { idempotencyKey: key } : {}),
    });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await setUpTenant(user, planId);
    other = await setUpTenant(user, planId);
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await other.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    for (const t of [tenant, other]) {
      await runInTenant(t.ctx, async (tx) => {
        await tx.delete(creditNotes).where(eq(creditNotes.tenantId, t.ctx.slug));
        await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, t.ctx.slug));
        await tx.delete(invoices).where(eq(invoices.tenantId, t.ctx.slug));
        await tx.delete(members).where(eq(members.tenantId, t.ctx.slug));
      });
    }
  });

  it('the same key twice → ONE note and ONE §87 number; the repeat is a replay', async () => {
    const invoiceId = await seedPaidInvoice(tenant, user, planId);
    const key = randomUUID();
    const before = await readCreditNoteSeq(tenant);
    const r1 = await issue(tenant, invoiceId, key);
    const r2 = await issue(tenant, invoiceId, key);
    expect(r1.ok && r2.ok, show([r1, r2])).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.replayed).toBe(false);
    expect(r2.value.replayed).toBe(true);
    expect(r2.value.creditNote.creditNoteId).toBe(r1.value.creditNote.creditNoteId);
    expect(r2.value.creditNote.documentNumber.raw).toBe(r1.value.creditNote.documentNumber.raw);
    expect((await readCreditNoteSeq(tenant)) - before).toBe(1);
    expect(await countNotes(tenant, invoiceId)).toBe(1);
    // #67 — the replay left one audit row, kept for the tax-document 10 years.
    const replayRows = await db.execute<{ retention_years: number; payload: { credit_note_id: string } }>(
      sql`SELECT retention_years, payload FROM audit_log WHERE tenant_id = ${tenant.ctx.slug} AND event_type = 'credit_note_issue_replayed' AND payload->>'idempotency_key' = ${key}`,
    );
    expect(replayRows).toHaveLength(1);
    expect(replayRows[0]?.retention_years).toBe(10);
    expect(replayRows[0]?.payload.credit_note_id).toBe(r1.value.creditNote.creditNoteId);
  }, 60_000);

  it('a race of two attempts with one key → ONE note, both answer it', async () => {
    const invoiceId = await seedPaidInvoice(tenant, user, planId);
    const key = randomUUID();
    const before = await readCreditNoteSeq(tenant);
    const [a, b] = await Promise.all([issue(tenant, invoiceId, key), issue(tenant, invoiceId, key)]);
    expect(a.ok && b.ok, show([a, b])).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.creditNote.creditNoteId).toBe(b.value.creditNote.creditNoteId);
    expect([a.value.replayed, b.value.replayed].sort()).toEqual([false, true]);
    expect(await countNotes(tenant, invoiceId)).toBe(1);
    expect((await readCreditNoteSeq(tenant)) - before).toBe(1);
  }, 60_000);

  it('different keys are two real notes (partial credits), and no key behaves as before', async () => {
    const invoiceId = await seedPaidInvoice(tenant, user, planId);
    const r1 = await issue(tenant, invoiceId, randomUUID(), 20_000n);
    const r2 = await issue(tenant, invoiceId, randomUUID(), 20_000n);
    const r3 = await issue(tenant, invoiceId, undefined, 20_000n);
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, true]);
    expect(await countNotes(tenant, invoiceId)).toBe(3);
  }, 60_000);

  it('the same key for a different amount is refused, and issues nothing', async () => {
    const invoiceId = await seedPaidInvoice(tenant, user, planId);
    const key = randomUUID();
    expect((await issue(tenant, invoiceId, key, 20_000n)).ok).toBe(true);
    const r = await issue(tenant, invoiceId, key, 30_000n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('concurrent_state_change');
    expect(await countNotes(tenant, invoiceId)).toBe(1);
  }, 60_000);

  it('the immutability trigger refuses a change of idempotency_key', async () => {
    const invoiceId = await seedPaidInvoice(tenant, user, planId);
    const r = await issue(tenant, invoiceId, randomUUID());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      await rejectionText(
        runInTenant(tenant.ctx, (tx) =>
          tx.execute(
            sql`UPDATE credit_notes SET idempotency_key = ${randomUUID()} WHERE tenant_id = ${tenant.ctx.slug} AND credit_note_id = ${r.value.creditNote.creditNoteId}`,
          ),
        ),
      ),
    ).toMatch(/immutable/);
  }, 60_000);

  // #728 review (Thai-tax M-1, round 2) — deterministic: each attempt's
  // in-tx key lookup (its 2nd lookup, after the pre-read) waits until BOTH
  // have looked and missed, so both reach the insert. The §87 allocator's
  // advisory lock serialises them; the second insert takes the real 23505 on
  // `credit_notes_tenant_idempotency_key_uniq`, reconciles in a fresh tx (its
  // 3rd lookup), finds a winner for ANOTHER invoice and refuses. Its §87 number
  // rolls back with it.
  it('one key raced on two invoices past the lookup → the loser takes the real 23505 and issues nothing', async () => {
    const invoiceIds = [await seedPaidInvoice(tenant, user, planId), await seedPaidInvoice(tenant, user, planId)];
    const key = randomUUID();
    const before = await readCreditNoteSeq(tenant);
    let arrived = 0;
    let release: () => void = () => {};
    const bothLooked = new Promise<void>((r) => {
      release = r;
    });
    const lookups = [0, 0];
    const inserts = [0, 0];
    function gatedDeps(i: 0 | 1) {
      const deps = makeIssueCreditNoteDeps(tenant.ctx.slug);
      const repo = deps.creditNoteRepo;
      return {
        ...deps,
        creditNoteRepo: {
          ...repo,
          findByIdempotencyKey: async (...args: Parameters<typeof repo.findByIdempotencyKey>) => {
            lookups[i] = (lookups[i] ?? 0) + 1;
            const found = await repo.findByIdempotencyKey(...args);
            if (lookups[i] === 2) {
              arrived += 1;
              if (arrived === 2) release();
              // Fail loudly, not by the test timeout, if the other attempt
              // never reaches its locked lookup.
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  bothLooked,
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(
                      () => reject(new Error(`attempt ${1 - i} never reached its in-tx key lookup`)),
                      20_000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            }
            return found;
          },
          insertCreditNote: async (...args: Parameters<typeof repo.insertCreditNote>) => {
            inserts[i] = (inserts[i] ?? 0) + 1;
            return repo.insertCreditNote(...args);
          },
        },
      };
    }
    const results = await Promise.all(
      ([0, 1] as const).map((i) =>
        issueCreditNote(gatedDeps(i), {
          tenantId: tenant.ctx.slug,
          actorUserId: user.userId,
          invoiceId: invoiceIds[i]!,
          creditTotalSatang: asSatang(53_500n),
          reason: 'duplicate charge',
          idempotencyKey: key,
        }),
      ),
    );
    expect(results.filter((r) => r.ok).length, show(results)).toBe(1);
    const loserIdx = results.findIndex((r) => !r.ok);
    const loser = results[loserIdx];
    if (loser && !loser.ok) expect(loser.error.code).toBe('concurrent_state_change');
    // Both inserted; only the loser reconciled (pre-read, locked read, reconcile).
    expect(inserts).toEqual([1, 1]);
    expect(lookups[loserIdx]).toBe(3);
    expect(lookups[1 - loserIdx]).toBe(2);
    let notes = 0;
    for (const id of invoiceIds) notes += await countNotes(tenant, id);
    expect(notes).toBe(1);
    expect((await readCreditNoteSeq(tenant)) - before).toBe(1);
  }, 60_000);

  // #728 round 2 (financial tests) — a replay matches the stored row as the
  // form resends it: a reason with outer spaces (trimmed by the schema and on
  // insert), and a full membership credit with its membership effect (the
  // repo's `membership_effect` mapping, read back from a real row).
  it('a full membership credit with an effect and a padded reason replays under its key', async () => {
    const invoiceId = await seedPaidInvoice(tenant, user, planId);
    const key = randomUUID();
    const send = () =>
      issueCreditNote(makeIssueCreditNoteDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        invoiceId,
        creditTotalSatang: asSatang(107_000n),
        reason: issueCreditNoteSchema.parse({
          tenantId: tenant.ctx.slug,
          actorUserId: user.userId,
          invoiceId,
          creditTotalSatang: 107_000n,
          reason: '  duplicate charge ',
        }).reason,
        membershipEffect: 'keep',
        idempotencyKey: key,
      });
    const r1 = await send();
    const r2 = await send();
    expect(r1.ok && r2.ok, show([r1, r2])).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.value.replayed).toBe(true);
    expect(r2.value.creditNote.creditNoteId).toBe(r1.value.creditNote.creditNoteId);
    expect(r2.value.creditNote.membershipEffect).toBe('keep');
    expect(await countNotes(tenant, invoiceId)).toBe(1);
  }, 60_000);

  it('the trigger refuses a change of idempotency_key under the PII-redaction exemption too', async () => {
    const invoiceId = await seedPaidInvoice(tenant, user, planId);
    const r = await issue(tenant, invoiceId, randomUUID());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      await rejectionText(
        runInTenant(tenant.ctx, async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
          await tx.execute(
            sql`UPDATE credit_notes SET idempotency_key = ${randomUUID()} WHERE tenant_id = ${tenant.ctx.slug} AND credit_note_id = ${r.value.creditNote.creditNoteId}`,
          );
        }),
      ),
    ).toMatch(/only member_identity_snapshot may change/);
  }, 60_000);

  it('keys are per tenant: the same key in another tenant is its own note', async () => {
    const key = randomUUID();
    const a = await issue(tenant, await seedPaidInvoice(tenant, user, planId), key);
    const b = await issue(other, await seedPaidInvoice(other, user, planId), key);
    expect(a.ok && b.ok, show([a, b])).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.replayed).toBe(false);
    expect(b.value.creditNote.creditNoteId).not.toBe(a.value.creditNote.creditNoteId);
  }, 60_000);
});
