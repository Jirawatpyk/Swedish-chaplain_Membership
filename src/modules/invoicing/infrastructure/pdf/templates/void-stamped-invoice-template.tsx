/**
 * T101 — VOID-stamped invoice PDF template (F4 / US5 Phase 9).
 *
 * Thin wrapper around `InvoiceTemplate` that forces the `kind` field
 * to `'void_stamped_invoice'`, causing the shared template to render
 * the bilingual "VOID / ยกเลิก" overlay per FR-008:
 *   - Diagonal 45° rotation
 *   - 50% opacity (within the 40-60% band the spec allows)
 *   - Repeats on every page via `fixed` prop on the Text element
 *   - Bilingual label (EN + TH)
 *
 * Why a separate file:
 *   - Spec explicitly lists this as its own template artefact (T101).
 *   - Keeps the dispatch contract explicit — the `@react-pdf` adapter
 *     calls `InvoiceTemplate` uniformly; void rendering is encoded in
 *     the input `kind` rather than a runtime branch at the adapter.
 *   - Downstream use-cases (void-invoice) can import this symbol to
 *     signal "render the voided variant" without having to construct
 *     `{ kind: 'void_stamped_invoice', ... }` by hand.
 *
 * Determinism: inherited from `InvoiceTemplate` + `withSeededRandom`
 * (deterministic-render.ts). Same input → byte-identical bytes → same
 * sha256 (SC-003).
 */
export { InvoiceTemplate as VoidStampedInvoiceTemplate } from './invoice-template';
