/**
 * T045 — PDF template version registry (F4).
 *
 * MUST remain forward-only — each version ever shipped stays here
 * indefinitely because resend / Blob-miss-recovery paths render using
 * the PINNED version from the invoice row (FR-016, R3-E4). Deleting
 * an old version breaks deterministic re-rendering.
 *
 * When a template changes, bump `CURRENT_TEMPLATE_VERSION` and add a
 * new mapping entry. The smoke test `pdf-template-version-smoke.test.ts`
 * (T017 future) asserts every version in the registry still renders.
 *
 * Version log:
 *   - **v1** (2026-04) — initial F4 template. Bilingual TH/EN header,
 *     §86/4 fields, amount-in-words, VOID + CREDITED overlays. No
 *     tenant logo.
 *   - **v2** (2026-05-15, commit 44c1af8b + review-fix Round 2) —
 *     tenant logo rendering added via `PdfRenderInput.tenantLogo`.
 *     For invoices issued under v1 with NULL `logo_blob_key`, re-render
 *     under v2 produces byte-identical output (no Image emitted) so
 *     SC-003 byte-identical guarantee holds. For invoices issued under
 *     v2 with a logo, re-render under v2 also stays byte-identical
 *     (logo bytes are immutable in Blob — same input → same output via
 *     deterministic-render seed).
 *   - **v3** (2026-06-11, 065-review-followups Task 31 / tax-auditor
 *     M-D) — kind-aware Revenue-Code §-citation in the footer
 *     (invoice §86/4 · receipt_combined §86/4+105ทวิ ·
 *     receipt_separate §105 · credit_note §86/10 · void per
 *     voidUnderlyingKind). The template branches INTERNALLY on
 *     `templateVersion >= KIND_AWARE_CITATION_MIN_VERSION` (see
 *     `templates/revenue-code-citation.ts`): v1/v2 renders keep the
 *     legacy unconditional §86/4 string byte-for-byte, so every
 *     pinned-version re-render path (void overlay, J2 credited
 *     annotation, async receipt worker) reproduces the original
 *     output (SC-003). Measured: docs/Bug/065-t31-footer-
 *     {pre,post}change.txt.
 */

export const CURRENT_TEMPLATE_VERSION = 3 as const;

export const TEMPLATE_VERSIONS = [1, 2, 3] as const;
export type PdfTemplateVersion = (typeof TEMPLATE_VERSIONS)[number];

export function isKnownTemplateVersion(v: number): v is PdfTemplateVersion {
  return (TEMPLATE_VERSIONS as readonly number[]).includes(v);
}
