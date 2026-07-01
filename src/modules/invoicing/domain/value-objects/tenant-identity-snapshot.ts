/**
 * T027 — Tenant identity snapshot (F4).
 *
 * Copied onto the invoice at issue time and rendered into the PDF
 * bilingual header. Immutable once the invoice leaves draft state
 * (enforced by the `invoices_enforce_immutability_trg` DB trigger).
 *
 * Fields come from `tenant_invoice_settings` at the moment of issue —
 * subsequent settings changes do NOT retroactively alter historical
 * invoices (FR-011).
 */
export interface TenantIdentitySnapshot {
  readonly legal_name_th: string;
  readonly legal_name_en: string;
  readonly tax_id: string;
  readonly address_th: string;
  readonly address_en: string;
  readonly logo_blob_key: string | null;
  /**
   * 088-invoice-tax-flow-redesign (§ C.2) — seller §86/4 Head-Office/Branch,
   * pinned at issue (immutable, FR-011). `seller_is_head_office=true` =
   * สำนักงานใหญ่ (TSCC default); `false` = a branch with `seller_branch_code`.
   *
   * OPTIONAL (wired per-story later, T040/US5): this VO has NO read-boundary zod
   * guard, so a historical snapshot omitting the keys reads back `undefined` —
   * the template MUST guard `seller_is_head_office ?? true` /
   * `seller_branch_code ?? null`. `makeTenantIdentitySnapshot` copies them from
   * `tenant_invoice_settings` at issue once US5 wires them.
   */
  readonly seller_is_head_office?: boolean;
  readonly seller_branch_code?: string | null;
  /**
   * 088-invoice-tax-flow-redesign (§ C.2) — tenant-configurable WHT footer note
   * (NULL ⇒ render nothing). Rendered on `invoice_subject='membership'`
   * documents ONLY (FR-012). The text RIDES this snapshot (pinned at issue) —
   * it is NEVER a template literal or env value. OPTIONAL / undefined-guarded
   * for historical snapshots (template: `wht_note_th ?? null`).
   */
  readonly wht_note_th?: string | null;
  readonly wht_note_en?: string | null;
}

export function makeTenantIdentitySnapshot(parts: TenantIdentitySnapshot): TenantIdentitySnapshot {
  // Return a frozen shallow copy — callers should not mutate.
  return Object.freeze({ ...parts });
}
