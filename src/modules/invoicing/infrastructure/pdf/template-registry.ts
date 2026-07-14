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
 *   - **v9** (2026-07-06, 093-wht-note-pdf-wrap) — the tenant WHT note (US5,
 *     membership-only, added at v7) is shaped with a WIDER Thai wrap budget
 *     (`WHT_NOTE_WRAP_THRESHOLD_CHARS` = 72) so the ~68-char TSCC accountant note
 *     renders on ONE line in the full-width `whtNoteBlock` (523.28pt content
 *     width) instead of being force-wrapped onto two by the global `shapeThai`
 *     default (55, calibrated for the narrow seller header). The wider budget
 *     gates on `templateVersion >= WHT_NOTE_WRAP_FIX_MIN_VERSION` (=9, see
 *     templates/invoice-template.tsx), so a pinned pre-v9 document (resend /
 *     void-overlay / async worker / any re-render at its stored
 *     `pdf_template_version`) reproduces its ORIGINAL bytes — the note wraps at
 *     the legacy 55 budget — preserving the SC-003 reproduce-the-original
 *     guarantee, exactly like the v3–v8 gates. The wrap budget is the ONLY
 *     change: a membership document without a WHT note (or with a ≤55 / >72-char
 *     note) renders byte-identical at v9 as at v8, and every non-membership kind
 *     is untouched. Measured: fontkit 2.0.4 / Sarabun-Regular note width 224.79pt
 *     ≪ 523.28pt (worst-case single-line capacity 78 chars).
 *   - **v10** (2026-07-06, 094-status-watermark-opacity) — the diagonal VOID /
 *     CREDITED status stamp now renders as a LARGE FAINT (~10% opacity)
 *     behind-content watermark (`rgba(200,0,0,0.10)` VOID · `rgba(180,80,0,0.10)`
 *     CREDITED / PARTIALLY CREDITED) instead of the pre-v10 prominent 50% / 32%
 *     opacity that over-printed the opaque grey table-header row + line-item text
 *     on a voided / credited tax document (prod UAT defect — a credited/voided
 *     document must stay clearly readable with only a faint status stamp behind
 *     it). ONLY the stamp COLOUR/opacity changes: the large fontSize (80 / 64),
 *     diagonal angle (-45° / -20°) and position are preserved (a large faint
 *     diagonal is the correct look). The DRAFT preview watermark (#eee, already
 *     faint) is untouched. Gated on `templateVersion >=
 *     STATUS_STAMP_FAINT_MIN_VERSION` (=10, see templates/invoice-template.tsx),
 *     so a pinned pre-v10 document (resend / void-overlay / credited-annotation
 *     re-render at its stored `pdf_template_version`) reproduces its ORIGINAL
 *     prominent stamp — the SC-003 reproduce-the-original guarantee, exactly like
 *     the v3–v9 gates. Both re-render paths (void-invoice.ts /
 *     issue-credit-note.ts) thread the blob's PINNED version, so already-issued
 *     ≤v9 voided/credited documents keep the prominent stamp; only v10+ issuances
 *     get the faint stamp. Because the two stamp styles apply ONLY to a rendered
 *     VOID / CREDITED overlay, every document WITHOUT a status stamp (plain
 *     invoice / bill / receipt / credit-note document) renders byte-identical at
 *     v10 as at v9 (proven: standard receipt v9↔v10 byte-length equal —
 *     zero-rate-pdf-golden §C + status-stamp-opacity.integration.test.ts).
 *   - **v11** (2026-07-14, 059-member-tax-correctness / PR-A Task 6a) — the BUYER
 *     Tax ID line now prints ONLY for a VAT REGISTRANT. A buyer TIN is a §86/4
 *     particular required only of a ผู้ประกอบการจดทะเบียน (ประกาศอธิบดีฯ ฉบับที่
 *     196); pre-v11 the template printed ANY non-blank `tax_id` with no registrant
 *     check. That became unsafe when `members.tax_id` began accepting a foreign
 *     natural person's PASSPORT / work-permit number (they have no Thai TIN):
 *     their identifier would have been printed on a legal tax document as a
 *     taxpayer number — a FALSE PARTICULAR. From v11 the line requires
 *     `buyer_is_vat_registrant === true` on the pinned snapshot (the RECORDED
 *     `members.is_vat_registered`, migration 0246 — never `buyerHasTin`, the same
 *     rule the v5 branch line already follows).
 *
 *     Gated on `templateVersion >= TAX_ID_REGISTRANT_GATE_MIN_VERSION` (=11, see
 *     templates/invoice-template.tsx). THE GATE IS LOAD-BEARING: an issued PDF is
 *     NOT write-once — void-invoice.ts and issue-credit-note.ts (credited
 *     annotation) both re-render with the CURRENTLY DEPLOYED template against the
 *     frozen snapshot at the document's PINNED version and overwrite the same
 *     blobKey. Because `buyer_is_vat_registrant` is `.optional().default(false)`,
 *     every snapshot written before that field existed reads back FALSE — so an
 *     UN-gated change would have silently DROPPED the Tax ID line from an
 *     already-issued document the moment it was voided or credit-noted. A pinned
 *     pre-v11 document keeps the legacy unconditional print and reproduces its
 *     ORIGINAL bytes — the SC-003 guarantee, exactly like the v3–v10 gates. Only
 *     v11+ issuances apply the registrant rule. A registrant buyer's document
 *     renders byte-identical at v11 as at v10 (the line prints either way); only a
 *     NON-registrant with a stored identifier differs — which is the entire point.
 *
 *     NOTE: the sibling country-NAME fix in `composeBuyerAddress` (raw `SV` →
 *     "El Salvador") needs NO gate and has none — it runs at ISSUE time and its
 *     output is frozen into the snapshot's `address` STRING. An already-issued
 *     document re-renders from its own frozen string and is untouched. That is
 *     DATA; this is TEMPLATE LOGIC. The distinction is the whole reason this
 *     registry exists.
 */

export const CURRENT_TEMPLATE_VERSION = 11 as const;

export const TEMPLATE_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
export type PdfTemplateVersion = (typeof TEMPLATE_VERSIONS)[number];

export function isKnownTemplateVersion(v: number): v is PdfTemplateVersion {
  return (TEMPLATE_VERSIONS as readonly number[]).includes(v);
}
