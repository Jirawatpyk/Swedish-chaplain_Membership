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
 *   - **v4** (2026-07-01, 088-invoice-tax-flow-redesign US2 / T025 /
 *     FR-004 / SC-004) — the `receipt_combined` (ใบกำกับภาษี/ใบเสร็จรับเงิน)
 *     §86/4 tax receipt now renders as ต้นฉบับ (Original) + สำเนา (Copy):
 *     two pages in ONE PDF sharing ONE RC number (§105ทวิ คู่ฉบับ +
 *     §87/3 retention), rendered ONCE (one <Document> → one stream →
 *     one sha → one blob). The template gates the second page on
 *     `templateVersion >= TWO_PAGE_RECEIPT_COPY_MIN_VERSION` (=4, see
 *     templates/invoice-template.tsx), so a pinned pre-v4
 *     `receipt_combined` (resend / Blob-miss recovery / void-overlay /
 *     any re-render at its stored `pdf_template_version`) still
 *     paginates to a single page — the SC-003 reproduce-the-original
 *     guarantee holds for already-issued documents, exactly like the v3
 *     citation gate. Every OTHER kind renders byte-for-length identical
 *     at v4 as at v3 (verified: same rendered length + extracted text
 *     for invoice / invoice_preview / receipt_separate / credit_note /
 *     void / receipt_combined@v3).
 *   - **v5** (2026-07-02, 088-invoice-tax-flow-redesign US3 / T032 /
 *     FR-008 / AS1-4) — the §86/4 **Head-Office / Branch** line now renders
 *     on BOTH parties of every tax document (ใบแจ้งหนี้ + tax receipt): the
 *     SELLER block always shows สำนักงานใหญ่ / Head Office (or the tenant's
 *     branch once US5 wires the seller-branch columns), and the BUYER block
 *     shows สำนักงานใหญ่ / Head Office (default) or สาขาที่ NNNNN / Branch —
 *     but ONLY for a VAT-registrant juristic buyer (gated on the snapshot's
 *     `buyer_is_vat_registrant`, NEVER `buyerHasTin`; an individual / NULL
 *     legal-entity-type buyer renders NO branch line, fail-closed). Both new
 *     lines gate on `templateVersion >= HEAD_OFFICE_BRANCH_MIN_VERSION` (=5,
 *     see templates/invoice-template.tsx), so a pinned pre-v5 document (resend
 *     / void-overlay / async worker / any re-render at its stored
 *     `pdf_template_version`) reproduces its original bytes — the SC-003
 *     guarantee holds, exactly like the v3 citation + v4 two-page gates. Every
 *     kind renders byte-for-length identical at v5 as at v4 when the buyer is
 *     not a VAT-registrant AND the seller line is absent — i.e. only a v5
 *     issuance with the new snapshot fields differs.
 *   - **v6** (2026-07-02, 088-invoice-tax-flow-redesign US4 / T035 / T035a /
 *     FR-009 / FR-010 / FR-034) — §86/4 presentation polish: (a) FR-009 —
 *     monetary amounts render with `,` thousands separators (deterministic +
 *     locale-independent) and the English amount-in-words first letter is
 *     capitalized; (b) FR-010 — the buyer identity block reorders to Name →
 *     Address → Tax ID → Head-Office/Branch (member number + contact follow);
 *     (c) FR-034 — the buyer legal name + address no longer CLIP at 3 / 5 lines
 *     with an ellipsis — they wrap / paginate (react-pdf `<Page wrap>` applies
 *     per page, so the US2 Original + Copy paginate consistently). ALL THREE
 *     gate on `templateVersion >= PRESENTATION_POLISH_MIN_VERSION` (=6, see
 *     templates/invoice-template.tsx), so a pinned pre-v6 document (resend /
 *     void-overlay / async worker / any re-render at its stored
 *     `pdf_template_version`) reproduces its ORIGINAL bytes — ungrouped
 *     amounts, lowercase words, legacy buyer order, and the 3/5-line clips —
 *     preserving the SC-003 reproduce-the-original guarantee, exactly like the
 *     v3 citation + v4 two-page + v5 branch-line gates. NOTE: the membership
 *     line description (plan name + coverage period, FR-011 / T036) is a
 *     FORWARD-ONLY ISSUE-TIME DATA change stored on the invoice line — the
 *     template renders the STORED text, so it needs NO template-version gate.
 *   - **v7** (2026-07-02, 088-invoice-tax-flow-redesign US5 / T041 / T042 /
 *     FR-012 / FR-022 / SC-007) — tenant-configurable footer: (a) FR-012 — the
 *     hardcoded "Rendered by Chamber-OS (§-citation)" footer is DROPPED on every
 *     kind; in its place the tenant WHT note (pinned in the snapshot) renders on
 *     `invoice_subject='membership'` documents ONLY (both the ใบแจ้งหนี้ bill AND
 *     the §86/4 tax receipt), NEVER on event documents; (b) FR-022 — the
 *     offline-payment bank block + "Issued by / Received by / Date" signature
 *     stamps render on the ใบแจ้งหนี้ (bill) ONLY (never the paid tax receipt),
 *     reading the PINNED snapshot bank fields. BOTH gate on `templateVersion >=
 *     WHT_AND_BANK_BLOCK_MIN_VERSION` (=7, see templates/invoice-template.tsx),
 *     so a pinned pre-v7 document (resend / void-overlay / async worker / any
 *     re-render at its stored `pdf_template_version`) reproduces its ORIGINAL
 *     bytes — NO WHT note, NO bank block, AND it KEEPS the legacy "Rendered by
 *     Chamber-OS (§-citation)" footer — preserving the SC-003
 *     reproduce-the-original guarantee, exactly like the v3 citation + v4
 *     two-page + v5 branch-line + v6 polish gates.
 *   - **v8** (2026-07-02, 088-invoice-tax-flow-redesign US8 / T058 / FR-025 /
 *     SC-008) — §80/1(5) embassy / int'l-org VAT-zero-rate note. When the pinned
 *     `vatTreatment='zero_rated_80_1_5'`, the §86/4 tax invoice / receipt renders
 *     a §80/1(5) note ("VAT 0% under Revenue Code §80/1(5)") + the MFA (Protocol
 *     Dept) certificate reference (number + date) — the cert SCAN is retained
 *     separately (Vercel Blob, 10y, admin-only) and NOT appended to the PDF (G6).
 *     The non-tax ใบแจ้งหนี้ bill just shows VAT 0% / 0.00 (no note); the note
 *     never draws on a membership document (membership is always 'standard') and
 *     the WHT note (US5, membership-only) never draws on a zero-rate document.
 *     Gated on `templateVersion >= ZERO_RATE_NOTE_MIN_VERSION` (=8, see
 *     templates/invoice-template.tsx), so a pinned pre-v8 document (resend /
 *     void-overlay / async worker / any re-render at its stored
 *     `pdf_template_version`) reproduces its ORIGINAL bytes with NO §80/1(5)
 *     note — the SC-003 guarantee holds, exactly like the v3 citation + v4
 *     two-page + v5 branch-line + v6 polish + v7 WHT/bank gates. Because the
 *     note + its `vatTreatment`/cert render inputs are threaded ONLY on a
 *     zero-rated document, every STANDARD render at v8 is byte-identical to v7.
 */

export const CURRENT_TEMPLATE_VERSION = 8 as const;

export const TEMPLATE_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type PdfTemplateVersion = (typeof TEMPLATE_VERSIONS)[number];

export function isKnownTemplateVersion(v: number): v is PdfTemplateVersion {
  return (TEMPLATE_VERSIONS as readonly number[]).includes(v);
}
