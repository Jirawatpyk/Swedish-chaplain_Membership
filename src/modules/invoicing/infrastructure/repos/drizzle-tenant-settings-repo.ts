/**
 * Drizzle tenant_invoice_settings repo (F4).
 *
 * Read path — `getForIssue` loads a snapshot for invoice issuance.
 * `getForUpdateInTx` reads with SELECT FOR UPDATE for the settings
 * mutation flow.
 *
 * Write path — `upsert` backs the US4 settings UI
 * (PATCH /api/tenant-invoice-settings). Branches on row existence:
 * first-time bootstrap → plain INSERT (requires complete required
 * fields); subsequent partial patch → plain UPDATE of only the
 * caller-provided columns so unrelated fields stay stable.
 */
import { eq, sql } from 'drizzle-orm';
import { asSatang } from '@/lib/money';
import type {
  TenantSettingsRepo,
  TenantInvoiceSettingsView,
  TenantInvoiceSettingsPatch,
  TenantDocumentSequenceRow,
} from '../../application/ports/tenant-settings-repo';
import { VatRate } from '../../domain/value-objects/vat-rate';
import { asProRatePolicyUnsafe } from '../../domain/value-objects/pro-rate-policy';
import { asTenantContext } from '@/modules/tenants';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { tenantInvoiceSettings } from '../db';
import { tenantDocumentSequences } from '../db/schema-tenant-document-sequences';

/**
 * Postgres lock-timeout-exceeded SQLSTATE. When `SET LOCAL
 * lock_timeout` is in effect and a row/lock acquisition exceeds the
 * window, PG raises this error code which propagates through Drizzle
 * as a thrown exception with `.code === '55P03'`.
 */
const POSTGRES_LOCK_NOT_AVAILABLE = '55P03';

/** Best-effort check for the Postgres lock-not-available SQLSTATE. */
function isLockNotAvailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const maybeCode = (err as { code?: unknown }).code;
  return maybeCode === POSTGRES_LOCK_NOT_AVAILABLE;
}

function rowToView(row: typeof tenantInvoiceSettings.$inferSelect): TenantInvoiceSettingsView {
  return {
    tenantId: row.tenantId,
    currencyCode: row.currencyCode,
    vatRate: VatRate.ofUnsafe(row.vatRate),
    // F5R3 H-5 (2026-05-16) — brand at DB→Domain boundary.
    registrationFeeSatang: asSatang(BigInt(row.registrationFeeSatang as unknown as string)),
    invoiceNumberPrefix: row.invoiceNumberPrefix,
    creditNoteNumberPrefix: row.creditNoteNumberPrefix,
    receiptNumberingMode: row.receiptNumberingMode === 'separate' ? 'separate' : 'combined',
    receiptNumberPrefix: row.receiptNumberPrefix ?? null,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    defaultNetDays: row.defaultNetDays,
    proRatePolicy: asProRatePolicyUnsafe(row.proRatePolicy),
    autoEmailEnabled: row.autoEmailEnabled,
    brandName: row.brandName ?? null,
    identity: Object.freeze({
      legal_name_th: row.legalNameTh,
      legal_name_en: row.legalNameEn,
      tax_id: row.taxId,
      address_th: row.registeredAddressTh,
      address_en: row.registeredAddressEn,
      logo_blob_key: row.logoBlobKey,
      // 088 US5 (T040) — seller branch + WHT note + bank block ride the pinned
      // TenantIdentitySnapshot. issue-invoice copies `settings.identity` verbatim
      // into `tenant_identity_snapshot`, so populating them here is what pins
      // them at issue (FR-011) — the template reads the snapshot, never live
      // settings.
      seller_is_head_office: row.sellerIsHeadOffice,
      seller_branch_code: row.sellerBranchCode,
      wht_note_th: row.whtNoteTh,
      wht_note_en: row.whtNoteEn,
      bank_payee_name: row.bankPayeeName,
      bank_account_no: row.bankAccountNo,
      bank_account_type: row.bankAccountType,
      bank_name: row.bankName,
      bank_branch: row.bankBranch,
      bank_address: row.bankAddress,
      bank_swift: row.bankSwift,
      payment_instructions_th: row.paymentInstructionsTh,
      payment_instructions_en: row.paymentInstructionsEn,
    }),
  };
}

/**
 * PR #173 round-2 review (2026-07-09) — narrow cross-context read of the
 * tenant's `fiscal_year_start_month` on the CALLER's already-open tenant tx.
 *
 * F8's `reanchorFirstPaymentCycleInTx` needs this ONE column mid-settlement to
 * decide whether a re-anchor crosses a fiscal-year boundary. Reading it via
 * `drizzleTenantSettingsRepo.getForIssue` would open a SECOND pooled connection
 * (its own `runInTenant`) while the money-path tx still holds the first — the
 * nested-connection pool-exhaustion class documented in `src/lib/db.ts`. This
 * runs the SELECT on the passed `tx` (no new connection, no `FOR UPDATE`) and
 * returns only the one column the caller needs. Returns `null` when the tenant
 * has no `tenant_invoice_settings` row yet (pre-F4-setup tenant); the F8
 * adapter maps that to its January default. Deliberately a standalone narrow
 * read rather than a new `TenantSettingsRepo` method — the full settings view
 * is far heavier than F8 needs, and widening the shared port would force the
 * new method onto ~12 unrelated F4 repo mocks.
 *
 * Caller MUST already be inside `runInTenant` (RLS context set) + pass that
 * same `tx`.
 */
export async function readFiscalYearStartMonthInTx(
  txUnknown: unknown,
  tenantId: string,
): Promise<number | null> {
  const tx = txUnknown as TenantTx;
  const rows = await tx
    .select({ fiscalYearStartMonth: tenantInvoiceSettings.fiscalYearStartMonth })
    .from(tenantInvoiceSettings)
    .where(eq(tenantInvoiceSettings.tenantId, tenantId))
    .limit(1);
  return rows[0]?.fiscalYearStartMonth ?? null;
}

export const drizzleTenantSettingsRepo: TenantSettingsRepo = {
  async getForIssue(tenantId: string): Promise<TenantInvoiceSettingsView | null> {
    const ctx = asTenantContext(tenantId);
    const rows = await runInTenant(ctx, (tx) =>
      tx.select().from(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, tenantId)).limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    return rowToView(row);
  },

  async getForUpdateInTx(
    txUnknown: unknown,
    tenantId: string,
  ): Promise<TenantInvoiceSettingsView | null> {
    // `SELECT … FOR UPDATE` on the tenant settings row serialises
    // concurrent admin saves against the subsequent upsert (two
    // admins flipping a prefix simultaneously would otherwise write
    // inconsistent §87 forensic audits — P1 reads INV, P2 reads INV,
    // P1 writes AAA, P2 writes BBB → P2's "old=INV → new=BBB" audit
    // misses the intermediate state). Caller MUST already be inside
    // `runInTenant` (RLS context set) + pass the same `tx` handle
    // they'll feed to `upsert(..., tx)`.
    //
    // `SET LOCAL lock_timeout = 5000` bounds the FOR UPDATE wait so
    // a stuck holder (slow PDF preview, paused tab) doesn't block
    // the second admin until Vercel function-timeout drops the
    // connection uncleanly. The `SET LOCAL` is intentionally an
    // override — this is a security-critical section + 5s is the
    // engineered budget; whatever value an upstream caller set, ours
    // wins so the timeout is predictable.
    const tx = txUnknown as TenantTx;
    await tx.execute(sql`SET LOCAL lock_timeout = '5000'`);
    try {
      const rows = await tx
        .select()
        .from(tenantInvoiceSettings)
        .where(eq(tenantInvoiceSettings.tenantId, tenantId))
        .for('update')
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return rowToView(row);
    } catch (err) {
      // Surface stuck-lock to operators — without this, LockNotAvailable
      // would propagate up as a generic 500 toast and we'd lose the
      // "concurrent save contention" diagnostic.
      if (isLockNotAvailable(err)) {
        logger.warn(
          { tenantId, op: 'getForUpdateInTx', timeoutMs: 5000 },
          '[tenant-invoice-settings] lock_timeout exceeded on FOR UPDATE — rolling back tx',
        );
      }
      throw err;
    }
  },

  async readSequencesInTx(
    txUnknown: unknown,
    tenantId: string,
  ): Promise<readonly TenantDocumentSequenceRow[]> {
    // Surface every `tenant_document_sequences` row for the §87
    // forensic-trail audit emit. Returns [] for a tenant that has
    // never issued any document.
    //
    // `.for('share')` coordinates with `SequentialNumberAllocator`
    // (FOR UPDATE on the same rows inside its own tx). Without
    // SHARE, a settings prefix-flip happening mid-issuance could
    // snapshot a stale `next_sequence_number` and write an audit row
    // whose `last_sequence_number` does not match the final on-disk
    // value once the allocator commits. SHARE+UPDATE block each
    // other but SHARE+SHARE do not — two prefix flips can still race
    // against each other (acceptable; the outer settings-row FOR
    // UPDATE (getForUpdateInTx) already serialises them).
    //
    // Explicit `ORDER BY (documentType, fiscalYear)` makes the audit
    // payload's `last_sequences` array deterministic across runs.
    // Heap order would cause RD forensic-diff tooling to see spurious
    // changes when comparing two logically-equivalent audit rows.
    const tx = txUnknown as TenantTx;
    // Bound the FOR SHARE wait to 5s so a stuck allocator (abnormally
    // slow PDF render holding FOR UPDATE) does not hang this
    // connection indefinitely on Vercel Serverless — function-timeout
    // would otherwise drop the connection without a clean rollback.
    // 5s comfortably exceeds normal allocator contention (≤2-3s
    // end-to-end) and raises a
    // `LockNotAvailable` exception that the surrounding `withTx`
    // rolls back atomically.
    await tx.execute(sql`SET LOCAL lock_timeout = '5000'`);
    try {
      const rows = await tx
        .select({
          documentType: tenantDocumentSequences.documentType,
          fiscalYear: tenantDocumentSequences.fiscalYear,
          nextSequenceNumber: tenantDocumentSequences.nextSequenceNumber,
        })
        .from(tenantDocumentSequences)
        .where(eq(tenantDocumentSequences.tenantId, tenantId))
        .orderBy(tenantDocumentSequences.documentType, tenantDocumentSequences.fiscalYear)
        .for('share');
      return rows.map((r) => ({
        documentType: r.documentType as 'invoice' | 'receipt' | 'credit_note',
        fiscalYear: r.fiscalYear,
        nextSequenceNumber: r.nextSequenceNumber,
      }));
    } catch (err) {
      // Surface "stuck allocator" so operators can diagnose §87
      // prefix-flip contention against concurrent issuance. Without
      // this log a LockNotAvailable propagates up as a generic 500
      // toast and the operational fingerprint is lost.
      if (isLockNotAvailable(err)) {
        logger.warn(
          { tenantId, op: 'readSequencesInTx', timeoutMs: 5000 },
          '[tenant-document-sequences] lock_timeout exceeded on FOR SHARE — allocator still holds FOR UPDATE; rolling back prefix-flip tx',
        );
      }
      throw err;
    }
  },

  async withTx<T>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
    // Open a tenant-scoped transaction and forward the handle to the
    // caller. Callers thread this `tx` into `upsert(..., tx)` and
    // `audit.emit(tx, ...)` so both writes land in one atomic unit.
    const ctx = asTenantContext(tenantId);
    return runInTenant(ctx, (tx) => fn(tx));
  },

  async upsert(
    tenantId: string,
    patch: TenantInvoiceSettingsPatch,
    tx?: unknown,
  ): Promise<void> {
    const ctx = asTenantContext(tenantId);
    // R10-BUG-1 fix — when a row already exists for this tenant, do a
    // plain UPDATE (not INSERT … ON CONFLICT DO UPDATE). Postgres
    // evaluates the proposed INSERT-side row BEFORE the ON CONFLICT
    // branch fires, so a partial-patch upsert (caller provides only a
    // few columns) generated SQL `INSERT (…, vat_rate, …) VALUES (…,
    // DEFAULT, …) ON CONFLICT DO UPDATE …` failed NOT NULL on
    // vat_rate (NOT NULL with no DEFAULT) before reaching the ON
    // CONFLICT clause. The pattern only succeeded on first-time
    // bootstrap where the caller supplies every required field;
    // subsequent partial updates (a prefix flip, an autoEmailEnabled
    // toggle) hit the bug. Fix: SELECT-then-branch — if the row
    // exists, UPDATE only the patched columns; if not, INSERT
    // (requires complete required fields, as before).
    const updateSet: Record<string, unknown> = { updatedAt: sql`now()` };
    const insertValues: Record<string, unknown> = { tenantId };
    const copyFields: Array<[keyof TenantInvoiceSettingsPatch, string]> = [
      ['currencyCode', 'currencyCode'],
      ['vatRate', 'vatRate'],
      ['registrationFeeSatang', 'registrationFeeSatang'],
      ['legalNameTh', 'legalNameTh'],
      ['legalNameEn', 'legalNameEn'],
      ['taxId', 'taxId'],
      ['registeredAddressTh', 'registeredAddressTh'],
      ['registeredAddressEn', 'registeredAddressEn'],
      ['invoiceNumberPrefix', 'invoiceNumberPrefix'],
      ['creditNoteNumberPrefix', 'creditNoteNumberPrefix'],
      ['receiptNumberingMode', 'receiptNumberingMode'],
      ['receiptNumberPrefix', 'receiptNumberPrefix'],
      ['fiscalYearStartMonth', 'fiscalYearStartMonth'],
      ['defaultNetDays', 'defaultNetDays'],
      ['proRatePolicy', 'proRatePolicy'],
      ['autoEmailEnabled', 'autoEmailEnabled'],
      ['logoBlobKey', 'logoBlobKey'],
      // 088 US5 (T040) — WHT note + seller branch + bank block.
      ['whtNoteTh', 'whtNoteTh'],
      ['whtNoteEn', 'whtNoteEn'],
      ['sellerIsHeadOffice', 'sellerIsHeadOffice'],
      ['sellerBranchCode', 'sellerBranchCode'],
      ['bankPayeeName', 'bankPayeeName'],
      ['bankAccountNo', 'bankAccountNo'],
      ['bankAccountType', 'bankAccountType'],
      ['bankName', 'bankName'],
      ['bankBranch', 'bankBranch'],
      ['bankAddress', 'bankAddress'],
      ['bankSwift', 'bankSwift'],
      ['paymentInstructionsTh', 'paymentInstructionsTh'],
      ['paymentInstructionsEn', 'paymentInstructionsEn'],
    ];
    for (const [src, dst] of copyFields) {
      if (patch[src] !== undefined) {
        insertValues[dst] = patch[src];
        updateSet[dst] = patch[src];
      }
    }

    const doWrite = async (txHandle: TenantTx) => {
      // Probe for existing row. Caller MAY have already done a
      // `getForUpdateInTx` upstream (within the same tx) — repeating
      // the read is idempotent + cheap, and keeps the repo API
      // independent of caller ordering.
      const existing = await txHandle
        .select({ tenantId: tenantInvoiceSettings.tenantId })
        .from(tenantInvoiceSettings)
        .where(eq(tenantInvoiceSettings.tenantId, tenantId))
        .limit(1);

      if (existing.length > 0) {
        // Row exists — plain UPDATE of patched columns only.
        await txHandle
          .update(tenantInvoiceSettings)
          .set(updateSet)
          .where(eq(tenantInvoiceSettings.tenantId, tenantId));
        return;
      }

      // First-time bootstrap — INSERT requires full required fields;
      // missing NOT NULL columns surface as a DB constraint violation
      // (caller validates upstream).
      await txHandle
        .insert(tenantInvoiceSettings)
        .values(insertValues as typeof tenantInvoiceSettings.$inferInsert);
    };

    if (tx !== undefined) {
      await doWrite(tx as TenantTx);
      return;
    }
    await runInTenant(ctx, doWrite);
  },
};
