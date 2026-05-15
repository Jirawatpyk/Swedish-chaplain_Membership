/**
 * T051 — Drizzle tenant_invoice_settings repo (F4).
 *
 * Read path — `getForIssue` loads a snapshot for invoice issuance.
 *
 * Write path — R7-B2 adds `upsert` backing the US4 settings UI
 * (PATCH /api/tenant-invoice-settings). A single INSERT … ON CONFLICT
 * DO UPDATE patches only the columns explicitly present in the patch,
 * so partial edits don't overwrite unrelated fields with stale values.
 */
import { eq, sql } from 'drizzle-orm';
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
    registrationFeeSatang: BigInt(row.registrationFeeSatang as unknown as string),
    invoiceNumberPrefix: row.invoiceNumberPrefix,
    creditNoteNumberPrefix: row.creditNoteNumberPrefix,
    receiptNumberingMode: row.receiptNumberingMode === 'separate' ? 'separate' : 'combined',
    receiptNumberPrefix: row.receiptNumberPrefix ?? null,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    defaultNetDays: row.defaultNetDays,
    proRatePolicy: asProRatePolicyUnsafe(row.proRatePolicy),
    autoEmailEnabled: row.autoEmailEnabled,
    identity: Object.freeze({
      legal_name_th: row.legalNameTh,
      legal_name_en: row.legalNameEn,
      tax_id: row.taxId,
      address_th: row.registeredAddressTh,
      address_en: row.registeredAddressEn,
      logo_blob_key: row.logoBlobKey,
    }),
  };
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
    // Round-3 fix R3-H1 — `SELECT … FOR UPDATE` on the tenant's
    // settings row so a concurrent admin save can't slip in between
    // the read + the subsequent upsert. Caller MUST already be inside
    // `runInTenant` (RLS context set), passing the same `tx` handle
    // here that they'll feed to `upsert(..., tx)`.
    //
    // R7-M7 — added `SET LOCAL lock_timeout` parity with
    // `readSequencesInTx`. Two admins editing settings concurrently
    // serialise on this FOR UPDATE; without the timeout, a stuck
    // first admin (slow PDF preview or browser tab paused) would
    // block the second admin's save until Vercel's function-timeout
    // window. 5s matches the sequences read; an exceeded budget
    // raises `LockNotAvailable` so `withTx` rolls back atomically.
    const tx = txUnknown as TenantTx;
    // R8-M-rel-2 — `SET LOCAL` overrides any prior `lock_timeout`
    // setting in the same tx. The override is intentional here: this
    // is a security-critical section (settings prefix flip + §87
    // forensic audit emit) and 5s is the engineered budget. If a
    // caller has already SET a different value upstream, our budget
    // wins so the timeout behaviour is predictable.
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
      // R7-M2 — surface the stuck-lock signal to operators. Without
      // this log, a LockNotAvailable would propagate up as a generic
      // Result.err / 500 toast and we'd lose the "concurrent save
      // contention" diagnostic.
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
    // Round-3 fix R3-C1 — surface every `tenant_document_sequences`
    // row for the §87 forensic-trail audit emit. Returns [] if the
    // tenant hasn't issued any documents yet.
    //
    // Round-4 fix R4-rel-H1 — add `.for('share')` so this read
    // coordinates with the concurrent `SequentialNumberAllocator`
    // path (which takes `FOR UPDATE` on the same rows inside its own
    // tx). Without the SHARE lock, a settings prefix-flip happening
    // mid-issuance could snapshot a stale `next_sequence_number` and
    // write an audit row whose `last_sequence_number` does not match
    // the final on-disk value once the allocator commits. SHARE +
    // UPDATE block each other but do not block SHARE + SHARE — so
    // two prefix flips can still race against each other (and that
    // is fine; the outer settings-row `FOR UPDATE` (getForUpdateInTx)
    // already serialises them).
    //
    // Round-4 fix R4-drizzle-M2 — explicit `ORDER BY (documentType,
    // fiscalYear)` so the audit payload `last_sequences` array is
    // deterministic across runs. Without it, Postgres can hand back
    // rows in heap order — which causes RD forensic-diff tooling to
    // see spurious changes when comparing two audit rows that
    // logically carry the same sequence snapshot.
    const tx = txUnknown as TenantTx;
    // R5-REL-M1 — bound the FOR SHARE wait to 5 seconds so a stuck
    // allocator (e.g. abnormally slow PDF render holding the FOR
    // UPDATE) does not hang this connection indefinitely on Vercel
    // Serverless (function-timeout would otherwise drop the
    // connection without a clean rollback). 5s comfortably exceeds
    // normal allocator contention (≤2-3s end-to-end) and raises a
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
      // R7-M2 — surface the "stuck allocator" signal so operators can
      // diagnose §87 prefix-flip contention against concurrent
      // issuance. Without this log a `LockNotAvailable` would
      // propagate up as a generic Result.err / 500 toast and we'd
      // lose the operational fingerprint.
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
    // Build the patch row — only caller-provided fields are included in
    // the UPDATE SET. Required fields for INSERT are supplied only if
    // the caller provided them; on first-time insert, missing required
    // fields surface as a DB NOT NULL violation (caller validates
    // upstream).
    const insertValues: Record<string, unknown> = { tenantId };
    const updateValues: Record<string, unknown> = { updatedAt: sql`now()` };
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
    ];
    for (const [src, dst] of copyFields) {
      if (patch[src] !== undefined) {
        insertValues[dst] = patch[src];
        updateValues[dst] = patch[src];
      }
    }

    // If caller passed a `tx`, reuse it (opened via `withTx` which
    // already set `app.current_tenant` via `runInTenant`). Only open a
    // fresh scope when no tx was provided.
    const doInsert = (txHandle: TenantTx) =>
      txHandle
        .insert(tenantInvoiceSettings)
        .values(insertValues as typeof tenantInvoiceSettings.$inferInsert)
        .onConflictDoUpdate({
          target: tenantInvoiceSettings.tenantId,
          set: updateValues,
        });

    if (tx !== undefined) {
      await doInsert(tx as TenantTx);
      return;
    }
    await runInTenant(ctx, doInsert);
  },
};
