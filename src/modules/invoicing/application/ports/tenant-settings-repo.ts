/**
 * T032 — Tenant invoice settings repository port (F4).
 */
import type { TenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import type { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import type { ProRatePolicy } from '@/modules/invoicing/domain/value-objects/pro-rate-policy';

export interface TenantInvoiceSettingsView {
  readonly tenantId: string;
  /**
   * R7 consolidation — ISO-4217 currency code (3 uppercase letters).
   * Migrated from F2 `tenant_fee_config.currency_code` in migration
   * 0026. Single authoritative source for F2 plan-pricing display
   * + F4 invoice rendering.
   */
  readonly currencyCode: string;
  readonly vatRate: VatRate;
  readonly registrationFeeSatang: bigint;
  readonly invoiceNumberPrefix: string;
  readonly creditNoteNumberPrefix: string;
  /**
   * Receipt document-number prefix used only when
   * `receiptNumberingMode === 'separate'`. Nullable for backwards-compat
   * with tenants that have not configured a dedicated prefix yet — the
   * record-payment use case falls back to `'RE'` in that case.
   */
  readonly receiptNumberPrefix?: string | null;
  readonly receiptNumberingMode: 'combined' | 'separate';
  readonly fiscalYearStartMonth: number;
  readonly defaultNetDays: number;
  readonly proRatePolicy: ProRatePolicy;
  readonly autoEmailEnabled: boolean;
  readonly identity: TenantIdentitySnapshot;
}

/**
 * R7-B2 — Partial patch accepted by `upsert`. All fields optional; only
 * fields explicitly provided are written. `vatRate` is a 4-dp decimal
 * string (matches `numeric(5,4)` column) — callers build it via
 * `VatRate.ofUnsafe(x).raw`. Logo management goes through a separate
 * `uploadTenantLogo` use-case (FR-034); this patch only accepts the
 * already-validated `logoBlobKey` (output of the upload endpoint).
 */
export interface TenantInvoiceSettingsPatch {
  /**
   * R7 consolidation — ISO-4217. Validation: `/^[A-Z]{3}$/` at the
   * Application boundary mirrors the DB CHECK from migration 0026.
   * Note: currency mutation should remain rare in practice — F2
   * had a `currency_immutable_in_f2` guard when plans exist; the
   * plans-based guard becomes R8 work (for now the DB CHECK ensures
   * well-formed values, and admins are trusted not to flip currency
   * mid-billing-cycle).
   */
  readonly currencyCode?: string;
  readonly vatRate?: string;
  readonly registrationFeeSatang?: bigint;
  readonly legalNameTh?: string;
  readonly legalNameEn?: string;
  readonly taxId?: string;
  readonly registeredAddressTh?: string;
  readonly registeredAddressEn?: string;
  readonly invoiceNumberPrefix?: string;
  readonly creditNoteNumberPrefix?: string;
  readonly receiptNumberPrefix?: string | null;
  readonly receiptNumberingMode?: 'combined' | 'separate';
  readonly fiscalYearStartMonth?: number;
  readonly defaultNetDays?: number;
  readonly proRatePolicy?: 'none' | 'monthly' | 'daily';
  readonly autoEmailEnabled?: boolean;
  readonly logoBlobKey?: string | null;
}

/**
 * Sequence row shape — surfaced for §87 forensic-trail audit emit.
 * One row per `(tenant_id, document_type, fiscal_year)` triple.
 */
export interface TenantDocumentSequenceRow {
  readonly documentType: 'invoice' | 'receipt' | 'credit_note';
  readonly fiscalYear: number;
  readonly nextSequenceNumber: number;
}

export interface TenantSettingsRepo {
  /**
   * Load current settings for a tenant. Returns null if the settings
   * row does not yet exist — caller is expected to refuse issuance per
   * FR-010 ("no invoice without settings").
   */
  getForIssue(tenantId: string): Promise<TenantInvoiceSettingsView | null>;

  /**
   * Round-3 fix R3-H1 — same shape as `getForIssue` but locks the
   * row with `SELECT … FOR UPDATE` inside the caller's tx. Use this
   * inside `withTx` when the read MUST be consistent with a
   * subsequent upsert (e.g. comparing old vs new prefix to emit a
   * §87 forensic-trail audit row). Without the lock a concurrent
   * admin save can flip the prefix between the read + upsert,
   * causing the audit to record the wrong "old" value.
   */
  getForUpdateInTx(
    tx: unknown,
    tenantId: string,
  ): Promise<TenantInvoiceSettingsView | null>;

  /**
   * Round-3 fix R3-C1 — read every `tenant_document_sequences` row
   * for a tenant inside the caller's tx. Surfaced for the
   * `tenant_receipt_prefix_changed` audit emit so the forensic
   * payload captures "last sequence used under the old prefix" per
   * the migration 0145 contract. Returns [] if no sequences exist
   * yet (pre-issue tenant).
   */
  readSequencesInTx(
    tx: unknown,
    tenantId: string,
  ): Promise<readonly TenantDocumentSequenceRow[]>;

  /**
   * R7-B2 — Upsert (create-or-update) the settings row. First write
   * creates the row; subsequent writes patch only caller-provided
   * fields. Minimum required fields on INITIAL insert (enforced by
   * column NOT NULL on the DB): `vatRate`, `legalNameTh`, `legalNameEn`,
   * `taxId`, `registeredAddressTh`, `registeredAddressEn`,
   * `invoiceNumberPrefix`, `creditNoteNumberPrefix`. If any required
   * field is missing on the FIRST write, the repo surfaces the DB's
   * NOT-NULL violation — the caller should validate upstream.
   *
   * `tx` — optional transaction handle. When provided, the upsert runs
   * inside the caller's transaction so the mutation can be bundled with
   * its matching `audit.emit(tx, ...)` in a single atomic unit
   * (Constitution Principle I clause 4). When omitted, the repo opens
   * its own `runInTenant` transaction.
   */
  upsert(
    tenantId: string,
    patch: TenantInvoiceSettingsPatch,
    tx?: unknown,
  ): Promise<void>;

  /**
   * R7-N1 — expose a transactional scope bound to the tenant so callers
   * that mutate settings AND emit audit can wrap both writes in the
   * same transaction. The callback's `tx` handle is the same one that
   * should be threaded to `upsert(tenantId, patch, tx)` and
   * `audit.emit(tx, {...})`.
   */
  withTx<T>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T>;
}
