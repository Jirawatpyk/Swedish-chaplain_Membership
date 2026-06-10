# Event Invoice Paid-Flow (issueEventInvoiceAsPaid) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the §105 violation (receipt-before-payment + double receipt for no-TIN event buyers) by adding an atomic `draft → paid` as-paid issuance path that emits exactly ONE tax document per payment, dated at the real payment date.

**Architecture:** New Application use-case `issueEventInvoiceAsPaid` + repo port `applyIssueAsPaid` (single UPDATE draft→paid); subject-aware Domain `canTransition`; root-fix guard in `issueInvoice` rejecting no-TIN events; new `pdf_doc_kind` column so downstream (J2 credit-note annotation) knows what the main PDF actually is; no-TIN numbering gated on the accountant ruling (β = receipt stream in `receipt_document_number_raw` + CHECK relax migration; α = shared invoice stream, fewer tasks).

**Tech Stack:** TypeScript strict, Drizzle (Postgres RLS, live-Neon integration tests), `@react-pdf/renderer`, Next.js App Router, next-intl (EN/TH/SV), Vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-06-10-event-invoice-paid-flow-design.md` (v2, panel-reviewed).
**Branch:** `064-event-invoice-paid-flow` (already created; spec committed).

**Conventions for every task:** `pnpm typecheck && pnpm lint` before each commit (typecheck via a temp tsconfig excluding `.next` if the dev server runs); integration tests hit live Neon via `.env.local`; apply migrations (`pnpm db:migrate`) + run the touched integration suite BEFORE committing schema changes (F4-R8 discipline); Conventional Commits; F4 = tax/PII surface → final PR needs ≥2 reviewers (or solo-maintainer substitute) + thai-tax auditor re-review covering document FLOW.

**⚠️ GATE — RESOLVED 2026-06-10:** the operator chose **β (separate receipt stream)** without waiting for the accountant (accountant confirmation moved to ship-time verification, spec §6 item 2). Tasks 9–10 are UNBLOCKED — execute them in order. The α-box below Task 8 remains only as the fallback if the accountant later mandates stream-sharing.

---

## File Structure

**Create:**
- `src/modules/invoicing/application/lib/resolve-event-buyer.ts` — shared event buyer-resolution helper (pure refactor out of `issue-invoice.ts`).
- `src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts` — the new use-case.
- `src/app/api/invoices/[invoiceId]/issue-as-paid/route.ts` — admin route.
- Migrations: `NNNN_invoices_pdf_doc_kind.sql` (column + backfill) · [β, GATED] `NNNN_as_paid_no_tin_number_relax.sql`.
- Tests: `tests/unit/invoicing/issue-event-invoice-as-paid.test.ts` · `tests/integration/invoicing/issue-as-paid.test.ts` · `tests/contract/invoices/issue-as-paid.contract.test.ts` · `tests/contract/invoices/issue-route-guard.contract.test.ts`.

**Modify:**
- `src/modules/invoicing/domain/invoice.ts` — `canTransition(from, to, subject)`.
- `src/modules/invoicing/application/ports/invoice-repo.ts` — `applyIssueAsPaid` + `pdfDocKind` on `applyIssue`.
- `src/modules/invoicing/infrastructure/repos/drizzle-invoice-repo.ts` + `infrastructure/db/schema-invoices.ts` — impl + column.
- `src/modules/invoicing/application/use-cases/issue-invoice.ts` — no-TIN guard + use helper + persist `pdfDocKind`.
- `src/modules/invoicing/application/use-cases/record-payment.ts` — interim legacy guard.
- `src/modules/invoicing/application/use-cases/issue-credit-note.ts` — J2 annotation kind from `pdfDocKind`.
- `src/modules/invoicing/index.ts` (barrel) — export new use-case/schema/deps factory.
- `src/modules/invoicing/invoicing-deps.ts` (or wherever `makeIssueInvoiceDeps` lives — `grep -r "makeIssueInvoiceDeps" src/modules/invoicing` to locate) — add `makeIssueEventInvoiceAsPaidDeps`.
- `src/app/api/invoices/[invoiceId]/issue/route.ts` — map new 422 code.
- `src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx` — mode selector + paymentDate/method + as-paid submit.
- `src/i18n/messages/{en,th,sv}.json` — new keys.
- `vitest.config.ts` — file-level 100% entry for the new use-case.
- Existing tests (flips): `tests/unit/invoicing/issue-invoice.test.ts` · `tests/unit/invoicing/invoice-state-machine.test.ts` · `tests/unit/invoicing/domain/invoice.test.ts` · `tests/integration/invoicing/issue-event-invoice.test.ts` · `record-payment-event-invoice.test.ts` · `credit-note-receipt-separate-blocked.test.ts` · `seq-interleaved-membership-event.test.ts`.

---

## Phase 1 — Domain

### Task 1: subject-aware `canTransition(from, to, subject)`

**Files:**
- Modify: `src/modules/invoicing/domain/invoice.ts:370-385`
- Test: `tests/unit/invoicing/domain/invoice.test.ts` (flip :382) + `tests/unit/invoicing/invoice-state-machine.test.ts`

- [ ] **Step 1: Write the failing tests** — in `tests/unit/invoicing/domain/invoice.test.ts`, replace the existing `draft→paid is illegal` assertion (≈L382) with:

```ts
it('draft→paid is legal for event subject (as-paid issuance)', () => {
  expect(canTransition('draft', 'paid', 'event').ok).toBe(true);
});
it('draft→paid stays ILLEGAL for membership (must pass issued)', () => {
  const r = canTransition('draft', 'paid', 'membership');
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe('invalid_transition');
});
it('draft→issued stays legal for BOTH subjects (bill-first)', () => {
  expect(canTransition('draft', 'issued', 'event').ok).toBe(true);
  expect(canTransition('draft', 'issued', 'membership').ok).toBe(true);
});
```

Update every other `canTransition(a, b)` call in BOTH test files to pass a third arg (`'membership'` for all pre-existing cases — behaviour unchanged). `domain/invoice.ts` has a file-level 100%-branch threshold: every new branch needs both directions.

- [ ] **Step 2: Run — verify FAIL** (`pnpm vitest run tests/unit/invoicing/domain/invoice.test.ts tests/unit/invoicing/invoice-state-machine.test.ts`) — TS error: 2 args expected.

- [ ] **Step 3: Implement** — change ONLY the signature + the `draft` row of the legal map; keep every other row byte-identical:

```ts
export function canTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
  /**
   * 064 — `draft → paid` (as-paid issuance) is legal ONLY for the event
   * subject; membership must always pass `issued` (the §86/4 two-step).
   */
  subject: 'membership' | 'event',
): Result<void, InvoiceTransitionError> {
  // … keep the existing isTerminal guard verbatim …
  const legal: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
    draft: subject === 'event' ? ['issued', 'paid'] : ['issued'],
    // … keep the remaining rows (issued/paid/partially_credited/void/credited) verbatim …
  };
  // … keep the lookup + err construction verbatim …
}
```

- [ ] **Step 4: Run both test files + `pnpm typecheck`** — PASS, no other compile errors (zero production call-sites exist; barrel export unchanged).
- [ ] **Step 5: Commit** — `git add -A src/modules/invoicing/domain tests/unit/invoicing && git commit -m "feat(invoicing): subject-aware canTransition — event-only draft->paid"`

### Task 2: `pdf_doc_kind` column (what IS the main PDF) + persist at issue

Downstream (Task 14 J2) must know whether the main PDF is `invoice` / `receipt_combined` / `receipt_separate`. No reliable derivation exists from current columns (net_days=0 and combined-mode blob-key-null are both ambiguous) — store it. Backfill: 054 no-TIN event rows got a `receipt_separate` main PDF at issue; everything else is `invoice`.

**Files:**
- Create: `drizzle/migrations/NNNN_invoices_pdf_doc_kind.sql` (next free number; non-breaking, transactional)
- Modify: `schema-invoices.ts` (column) · `drizzle-invoice-repo.ts` (`rowsToInvoice` + `applyIssue`) · `ports/invoice-repo.ts` (`applyIssue` input) · `domain/invoice.ts` (`Invoice.pdfDocKind`) · `issue-invoice.ts` (pass `pdfKind`)
- Test: `tests/integration/invoicing/event-invoice-schema.test.ts` (extend)

- [ ] **Step 1: Write the failing integration test** — extend `event-invoice-schema.test.ts`: insert an issued membership row via the existing fixture path and assert `rowsToInvoice` maps `pdfDocKind === 'invoice'`; assert the column default backfills existing rows (`SELECT count(*) FROM invoices WHERE pdf_doc_kind IS NULL` → 0 after migrate).
- [ ] **Step 2: Migration**

```sql
-- 064 — persist the MAIN PDF document kind chosen at issue (§86/4 'invoice',
-- combined §86/4+§105ทวิ 'receipt_combined', §105 'receipt_separate').
-- Needed so the J2 credit-note annotation re-render cannot overwrite a
-- receipt-titled original with an invoice-titled document (10y evidence).
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "pdf_doc_kind" text;
UPDATE "invoices" SET "pdf_doc_kind" =
  CASE WHEN "invoice_subject" = 'event'
        AND COALESCE(TRIM("member_identity_snapshot"->>'tax_id'), '') = ''
        AND "status" <> 'draft'
       THEN 'receipt_separate' ELSE 'invoice' END
WHERE "pdf_doc_kind" IS NULL AND "status" <> 'draft';
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_doc_kind_valid"
  CHECK ("pdf_doc_kind" IS NULL OR "pdf_doc_kind" IN ('invoice','receipt_combined','receipt_separate'));
-- draft rows stay NULL (no PDF yet); non-draft must have it going forward:
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_non_draft_has_doc_kind";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_non_draft_has_doc_kind"
  CHECK ("status" = 'draft' OR "pdf_doc_kind" IS NOT NULL);
```

- [ ] **Step 3: Wire through** — `schema-invoices.ts`: `pdfDocKind: text('pdf_doc_kind')` (+ the two `check()` builders mirroring the SQL); `domain/invoice.ts`: `readonly pdfDocKind: 'invoice' | 'receipt_combined' | 'receipt_separate' | null;` (null on draft); `rowsToInvoice`: map with a validation throw on unknown value; `applyIssue` port + impl: add required `readonly pdfDocKind: 'invoice' | 'receipt_separate'`; `issue-invoice.ts` ~L410: pass `pdfDocKind: pdfKind === 'invoice' ? 'invoice' : 'receipt_separate'` (pdfKind here is the §86/4 gate result).
- [ ] **Step 4:** `pnpm db:migrate && pnpm vitest run tests/integration/invoicing/event-invoice-schema.test.ts` — PASS. Then `pnpm typecheck` (the new required field surfaces every `applyIssue` caller/mock — fix the mocks in `issue-invoice.test.ts` by adding the field).
- [ ] **Step 5: Commit** — `feat(invoicing): persist pdf_doc_kind at issue (backfilled; J2 prerequisite)`

## Phase 2 — Pure refactor (user-approved latitude)

### Task 3: extract `resolveEventBuyerForIssue` helper

**Files:**
- Create: `src/modules/invoicing/application/lib/resolve-event-buyer.ts`
- Modify: `issue-invoice.ts` (~L211-250, the event arms of buyer resolution)
- Test: existing `tests/unit/invoicing/issue-invoice.test.ts` (must stay green — 100% file coverage is the refactor net)

- [ ] **Step 1: Read** `issue-invoice.ts` buyer-resolution block (between the `lockedStatus` check and the §86/4 gate). Identify the two EVENT arms: (a) matched member (`draft.memberId !== null`): `memberIdentity.getForIssue(tx, tenantId, memberId, { forUpdate: true })` → null ⇒ `member_not_found`; archived ⇒ `member_archived`; build snapshot; (b) non-member: `draft.memberIdentitySnapshot` ?? ⇒ `no_buyer_snapshot`.
- [ ] **Step 2: Create the helper** — move those lines VERBATIM (behaviour byte-identical, comments included):

```ts
// src/modules/invoicing/application/lib/resolve-event-buyer.ts
import { err, ok, type Result } from '@/lib/result';
import type { MemberIdentityPort } from '../ports/member-identity-port';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';

export type ResolveEventBuyerError =
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  | { code: 'no_buyer_snapshot' };

/**
 * 064 — shared EVENT buyer resolution (issueInvoice bill-first +
 * issueEventInvoiceAsPaid). Matched member: live re-read with FOR UPDATE
 * (archive-race guard, FR-037) + snapshot pinned now. Non-member: the
 * draft-pinned snapshot (created by createEventInvoiceDraft) is the buyer.
 * Body moved verbatim from issue-invoice.ts (Task 3, plan 2026-06-10).
 */
export async function resolveEventBuyerForIssue(
  memberIdentity: MemberIdentityPort,
  tx: unknown,
  tenantId: string,
  draft: Invoice,
): Promise<Result<MemberIdentitySnapshot, ResolveEventBuyerError>> {
  /* moved lines here */
}
```

- [ ] **Step 3:** `issue-invoice.ts` event branch now calls the helper and maps its `err` codes 1:1 into `IssueInvoiceError` (same codes — no mapping logic). Membership arm stays inline untouched.
- [ ] **Step 4: Run the full F4 unit suite** — `pnpm vitest run tests/unit/invoicing/` — ALL GREEN, coverage thresholds intact (`pnpm test:coverage` if in doubt; per-file 100% on issue-invoice must hold — the helper file inherits Application 80/80 minimum, add it to the 100% list in Task 17).
- [ ] **Step 5: Commit** — `refactor(invoicing): extract resolveEventBuyerForIssue (pure move, green tests)`

## Phase 3 — Persistence

### Task 4: `applyIssueAsPaid` port + Drizzle impl

**Files:**
- Modify: `ports/invoice-repo.ts` (after `applyPayment`) · `drizzle-invoice-repo.ts`
- Test: `tests/integration/invoicing/issue-as-paid.test.ts` (new — repo-level section)

- [ ] **Step 1: Write the failing integration test** (live Neon; mirror the fixture helpers of `issue-event-invoice.test.ts` — tenant + F6 registration + `createEventInvoiceDraft`): call `applyIssueAsPaid` directly inside `withTx` with a full TIN-shaped input; assert the row lands `status='paid'`, `paid_at`/`payment_*` set, `issue_date = due_date = paymentDate`, `net_days_snapshot = 0`, `receipt_pdf_status='rendered'`, `receipt_pdf_blob_key IS NULL`, `pdf_doc_kind='receipt_combined'`, and NO 23514. Second call on the same row → throws `InvoiceApplyConflictError` (reuse the existing class — grep its definition in `drizzle-invoice-repo.ts`). Post-paid manual UPDATE of `member_identity_snapshot` → blocked by the immutability trigger.
- [ ] **Step 2: Port signature** (after `applyPayment`):

```ts
/**
 * 064 — single UPDATE draft→paid (as-paid issuance, event subject only).
 * Numbering: TIN path carries invoice-stream sequence/document numbers;
 * no-TIN β path carries NULLs + receiptDocumentNumberRaw (gated CHECK
 * relax, migration Task 9). WHERE status='draft' — 0 rows ⇒ throw
 * InvoiceApplyConflictError (concurrent issue/as-paid race loser).
 */
applyIssueAsPaid(
  tx: unknown,
  input: {
    readonly tenantId: string;
    readonly invoiceId: InvoiceId;
    readonly fiscalYear: number;
    readonly sequenceNumber: number | null;
    readonly documentNumber: string | null;
    readonly receiptDocumentNumberRaw: string | null;
    readonly issueDate: string;            // = paymentDate (YYYY-MM-DD)
    readonly subtotalSatang: Satang;
    readonly vatRate: string;
    readonly vatSatang: Satang;
    readonly totalSatang: Satang;
    readonly tenantIdentitySnapshot: unknown;
    readonly memberIdentitySnapshot: unknown;
    readonly pdf: { readonly blobKey: string; readonly sha256: Sha256Hex; readonly templateVersion: number };
    readonly pdfDocKind: 'receipt_combined' | 'receipt_separate';
    readonly paymentMethod: 'bank_transfer' | 'cheque' | 'cash' | 'other';
    readonly paymentReference: string | null;
    readonly paymentNotes: string | null;
    readonly paymentRecordedByUserId: string;
    readonly paymentDate: string;          // YYYY-MM-DD (== issueDate)
  },
): Promise<Invoice>;
```

- [ ] **Step 3: Drizzle impl** — one `UPDATE … WHERE tenant_id AND invoice_id AND status='draft'` setting: `status='paid'`, `dueDate: input.issueDate`, `netDaysSnapshot: 0`, `proRatePolicySnapshot: null`, `receiptPdfStatus: 'rendered'`, `receiptPdfBlobKey: null`, `paidAt: sql\`now()\``, all input fields, `pdfDocKind`. 0 rows → `throw new InvoiceApplyConflictError(...)` (same construction as `applyPayment`). Thread `tx` (NEVER the global `db`). Return via the same `rowsToInvoice` reload as `applyIssue`.
- [ ] **Step 4:** `pnpm vitest run tests/integration/invoicing/issue-as-paid.test.ts` — PASS (proves drizzle-panel C1–C9 live). `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(invoicing): applyIssueAsPaid repo port — single UPDATE draft->paid`

## Phase 4 — Use-case (TIN path)

### Task 5: `issueEventInvoiceAsPaid` — unit-tested core

**Files:**
- Create: `src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts`
- Modify: barrel `src/modules/invoicing/index.ts` + deps factory file (add `makeIssueEventInvoiceAsPaidDeps` mirroring `makeIssueInvoiceDeps` — same wiring, locate via grep)
- Test: `tests/unit/invoicing/issue-event-invoice-as-paid.test.ts`

- [ ] **Step 1: Write the failing unit tests** (mock deps in the `vi.importActual + spread + override` style of `issue-invoice.test.ts`). Cases:
  1. happy TIN: draft event + buyer TIN → ok; PDF rendered ONCE with `kind:'receipt_combined'`, `vatInclusive:true`, `issueDate===dueDate===paymentDate`; allocator called with `documentType:'invoice'`; `applyIssueAsPaid` got `pdfDocKind:'receipt_combined'`, `netDays` absent (impl pins 0), `paymentMethod` threaded; TWO audits emitted in order `invoice_issued` then `invoice_paid`, both via `emit(tx, …)` (assert the first arg is the tx, NOT null); ONE outbox enqueue.
  2. `receiptNumberingMode:'separate'` tenant settings → STILL `receipt_combined` (override pin).
  3. happy no-TIN: PDF `kind:'receipt_separate'`; **β**: allocator called with `documentType:'receipt'`, `sequenceNumber:null` + `receiptDocumentNumberRaw` set on the apply input. *(Until Task 9 lands, pin the CURRENT behaviour: returns `err({ code: 'no_tin_numbering_pending' })` — see Step 3 — and mark the β assertions `it.skip` with a `// GATED §6-2` comment so check:fixme stays clean on non-release branches; flip in Task 10.)*
  4. not event subject → `err not_event_subject`; not draft → `err invoice_already_issued` (reuse code+status shape).
  5. `paymentDate` in the future (vs Bangkok today) → `err payment_date_future`; malformed date → zod reject.
  6. cross-tenant/missing draft → `err invoice_not_found` + `invoice_cross_tenant_probe` emitted with `route:'issue-event-invoice-as-paid'`.
  7. blob upload failure AFTER allocate → use-case THROWS internally and resolves `err blob_upload_failed` via the TxAbort carrier; assert `applyIssueAsPaid` was never called.
  8. matched-member happy path → F8 `onPaidCallbacks` fired (parity with recordPayment); non-member → not fired; non-member audits route through `emitNonMemberInvoiceEvent`.
  9. archived matched member → `err member_archived` (via the Task-3 helper) BEFORE allocator is called.
  10. fiscal year: `paymentDate:'2026-12-28'` with `now()` mocked to 2027-01-05 → allocator receives the FY containing 2026-12-28 (Bangkok), and the blobKey embeds that FY.
- [ ] **Step 2: Run — FAIL** (module not found).
- [ ] **Step 3: Implement.** Skeleton (complete logic; mirrors issueInvoice discipline — read its pre/post-sequence comments before writing):

```ts
export const issueEventInvoiceAsPaidSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.enum(['bank_transfer', 'cheque', 'cash', 'other']),
  paymentReference: z.string().max(200).nullable().optional(),
  paymentNotes: z.string().max(2000).nullable().optional(),
});

export type IssueEventInvoiceAsPaidError =
  | { code: 'invoice_not_found' } | { code: 'not_event_subject' }
  | { code: 'invoice_already_issued'; status: InvoiceStatus }
  | { code: 'settings_missing' } | { code: 'member_not_found' }
  | { code: 'member_archived' } | { code: 'no_buyer_snapshot' }
  | { code: 'payment_date_future' }
  | { code: 'no_tin_numbering_pending' }   // removed by Task 10 (β) or the α-box
  | { code: 'invalid_lines'; reason: string }
  | { code: 'overflow'; fiscalYear: FiscalYear }
  | { code: 'pdf_render_failed'; reason: string }
  | { code: 'blob_upload_failed'; reason: string };

class IssueAsPaidInternalError extends TxAbort<IssueEventInvoiceAsPaidError> {
  override readonly name = 'IssueAsPaidInternalError';
}
```

Flow inside `deps.invoiceRepo.withTx(async (tx) => …)` — **lock order: invoice → member → advisory/seq (R7-S1); pre-sequence failures `return err`, post-sequence failures `throw IssueAsPaidInternalError`:**
  1. `paymentDate > bangkokLocalDate(deps.clock.nowIso())` → `err payment_date_future`.
  2. settings (`err settings_missing`); `lockForUpdate` → not found ⇒ probe (null-tx, `route:'issue-event-invoice-as-paid'`) + `err invoice_not_found`; status ≠ draft ⇒ `err invoice_already_issued`; load via `findByIdInTx`; `invoiceSubject !== 'event'` ⇒ `err not_event_subject`; `canTransition('draft','paid','event')` (the domain table's first load-bearing call) — failure is a programming error ⇒ throw.
  3. `enforceOneSubjectLine('event', draft.lines)` → `err invalid_lines` (pre-sequence, mirrors issueInvoice).
  4. buyer: `resolveEventBuyerForIssue(deps.memberIdentity, tx, tenantId, draft)` → map errs 1:1.
  5. doc kind: `const pdfKind = buyerHasTin(memberSnap.tax_id) ? 'receipt_combined' : 'receipt_separate'`.
  6. fiscal year FROM paymentDate: `const fy = fiscalYearFromUtcIso(\`${input.paymentDate}T05:00:00Z\`, settings.fiscalYearStartMonth)` — 05:00Z = 12:00 Bangkok same calendar day (Bangkok has no DST), so the FY is the payment-date FY.
  7. numbering — **POST-SEQUENCE ZONE from here**: TIN → `allocateNext(tx, { documentType:'invoice', fiscalYear: fy })` + `DocumentNumber.of(settings.invoiceNumberPrefix, fy, seq)` (overflow ⇒ throw, mirrors issueInvoice). no-TIN → until Task 9/α lands: `return err({ code:'no_tin_numbering_pending' })` placed BEFORE the TIN allocate (still pre-sequence — no gap).
  8. VAT: line-sum; `draft.vatInclusive` must be true for event (else throw — Domain invariant); `splitVatInclusive(total, settings.vatRate.numerator)`.
  9. render + upload ONE PDF via `renderAndUploadPdf` with `kind: pdfKind`, `documentNumber`, `issueDate: input.paymentDate`, `dueDate: input.paymentDate`, `vatInclusive: true`; blobKey \`invoicing/${tenantId}/${fy}/${invoiceId}_v${ver}.pdf\` (same shape as issueInvoice); failures throw the internal carrier (`pdf_render_failed`/`blob_upload_failed`) + best-effort `deps.blob.delete(blobKey)` in the outer catch (orphan-blob mitigation, reliability L-1).
  10. `applyIssueAsPaid(tx, …)` with the §3.6 column mapping (`pdfDocKind: pdfKind`).
  11. audits: `invoice_issued` then `invoice_paid`, both `emit(tx, …)`; payload parity with recordPayment (`payment_method`, `payment_date`, `receipt_document_number` (combined ⇒ the invoice docNum), `receipt_pdf_async: false`, `invoice_subject:'event'`, `event_registration_id`); branch member (timeline payload with `member_id`) vs non-member (`emitNonMemberInvoiceEvent`) — read the recordPayment emit block and mirror field-for-field.
  12. outbox: enqueue ONE `invoice_paid` receipt email mirroring recordPayment L619-677 (recipient resolution, `event_non_member` footer flag when `memberId === null`, empty-recipient ⇒ skip + `logger.warn` + `invoicingMetrics.autoEmailSkipped('event','no_recipient')`).
  13. F8: matched member ⇒ fire the same `onPaidCallbacks`/`F4InvoicePaidEvent` hook recordPayment fires (read record-payment.ts L738-766 and mirror; trigger value: reuse its admin-manual trigger constant).
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/invoicing/issue-event-invoice-as-paid.test.ts` — PASS. `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `feat(invoicing): issueEventInvoiceAsPaid use-case (TIN path; no-TIN gated)`

### Task 6: as-paid integration (live Neon)

**Files:** Test: `tests/integration/invoicing/issue-as-paid.test.ts` (extend Task 4's file)

- [ ] **Step 1: Write + run the new sections (RED where behaviour is new):**
  - TIN end-to-end: draft → `issueEventInvoiceAsPaid` → ONE row paid, ONE PDF blob, combined kind, audits issued+paid present (query audit_log), `issue_date=due_date=payment_date`, F3 timeline shows both events for a matched member.
  - **Concurrency:** `Promise.allSettled` two parallel calls on one draft → exactly one ok + one `invoice_already_issued`/conflict 409-shape; only ONE §87 number consumed (assert allocator table delta = 1). Cross-route race: parallel `issueInvoice` + `issueEventInvoiceAsPaid` on one TIN draft → one winner, loser typed-conflict, one number.
  - **FY boundary:** paymentDate `2026-12-28` keyed "today" → document number carries FY2026 + blobKey path contains `/2026/`.
  - **Rollback:** stub blob port to fail upload → returns `err blob_upload_failed`; row still `status='draft'`, allocator count unchanged, zero audit rows for the invoice.
  - **§87 interleave** (extend `seq-interleaved-membership-event.test.ts`): membership issue → bill-first event issue → as-paid TIN → numbers N, N+1, N+2 continuous.
  - **Cross-tenant:** as-paid against another tenant's draft id → `invoice_not_found` + probe audit row (Principle I clause 3 — Review-Gate blocker).
- [ ] **Step 2:** make GREEN (fix impl if needed). `pnpm vitest run tests/integration/invoicing/issue-as-paid.test.ts tests/integration/invoicing/seq-interleaved-membership-event.test.ts`.
- [ ] **Step 3: Commit** — `test(invoicing): as-paid live-Neon integration — concurrency, FY-from-paymentDate, rollback, interleave, cross-tenant`

## Phase 5 — Guards (root fix) + existing-test migration

### Task 7: `issueInvoice` rejects no-TIN events + flips

**Files:**
- Modify: `issue-invoice.ts` (§86/4 gate block ~L277) · `src/app/api/invoices/[invoiceId]/issue/route.ts:69-81` · `src/i18n/messages/{en,th,sv}.json`
- Test: `tests/unit/invoicing/issue-invoice.test.ts` (flip L734/L744/L785)

- [ ] **Step 1: Flip the three tests** — no-TIN event issue now expects `err({ code: 'event_no_tin_requires_paid_issue' })`; KEEP the whitespace-TIN case (`'   '` must fire the guard — `buyerHasTin` trims). Run — FAIL (guard absent).
- [ ] **Step 2: Implement** — in the §86/4 gate block (pre-sequence zone):

```ts
// 064 §105 ROOT FIX — a no-TIN event buyer can never be billed first:
// the only legal document for them is a §105 receipt, which may exist
// only at the moment payment is recorded (issueEventInvoiceAsPaid).
if (draft.invoiceSubject === 'event' && !buyerHasTin(memberSnap.tax_id)) {
  return err({ code: 'event_no_tin_requires_paid_issue' });
}
```

Add the code to `IssueInvoiceError`; route map: `: result.error.code === 'event_no_tin_requires_paid_issue' ? 422`; i18n keys `admin.invoices.errors.eventNoTinRequiresPaidIssue` ×3 locales (TH: "ผู้ซื้อไม่มีเลขประจำตัวผู้เสียภาษี ต้องบันทึกรับเงินทันที — ออกใบเรียกเก็บล่วงหน้าไม่ได้ตามกฎหมาย"; SV formal register; grep how existing F4 error codes resolve to i18n in the form/table components and wire identically).
- [ ] **Step 3: Run** the file + `pnpm check:i18n` — PASS. **Step 4: Commit** — `feat(invoicing): reject no-TIN event at issue (root \$105 fix)`

### Task 8: `recordPayment` interim legacy guard + integration fixture migration

**Files:**
- Modify: `record-payment.ts` (after the L292 null-member guard) · pay route error map · i18n ×3
- Test: `tests/unit/invoicing/record-payment.test.ts` + rewrite no-TIN legs of `tests/integration/invoicing/issue-event-invoice.test.ts` (L441 block) / `record-payment-event-invoice.test.ts` / `credit-note-receipt-separate-blocked.test.ts`

- [ ] **Step 1: Failing unit test** — issued no-TIN event row (legacy shape, built directly as fixtures do today) + recordPayment → `err({ code: 'legacy_no_tin_event_needs_remediation' })`; TIN event + membership rows unaffected.
- [ ] **Step 2: Implement**

```ts
// 064 INTERIM (remove after spec §6 item 1 remediation completes):
// a LEGACY issued no-TIN event row predates the as-paid redesign — paying
// it here would mint receipt #2 (the §105 double-receipt this redesign
// kills). Operators: see the remediation runbook.
if (
  loaded.invoiceSubject === 'event' &&
  loaded.status === 'issued' &&
  !buyerHasTin(loaded.memberIdentitySnapshot.tax_id)
) {
  return err({ code: 'legacy_no_tin_event_needs_remediation' });
}
```

(+ error union, pay-route 409 mapping, i18n ×3.)
- [ ] **Step 3: Migrate the three integration files** — every fixture that previously did no-TIN `issueInvoice`(+`recordPayment`) now goes through `issueEventInvoiceAsPaid`; `credit-note-receipt-separate-blocked.test.ts` re-asserts §86/10 still blocks a credit note against the as-paid `receipt_separate` row (the gate keys off `inferEventDocumentKind` — unchanged). Keep ONE unit test per file pinning the legacy-guard behaviour with a `// legacy-row defensive (remove with §6 item 1)` comment.
- [ ] **Step 4: Run** all touched unit+integration files — GREEN. **Step 5: Commit** — `feat(invoicing): interim legacy no-TIN pay guard + migrate fixtures to as-paid`

## Phase 6 — no-TIN numbering (⛔ GATED on accountant — spec §6 item 2)

> **If the accountant rules α (shared invoice stream):** skip Tasks 9–10. Instead, in the use-case Step-3.7 branch, route no-TIN through the SAME `documentType:'invoice'` allocation as TIN (delete `no_tin_numbering_pending`), un-skip the Task-5 case-3 tests asserting `documentType:'invoice'`, and re-run Task 6's interleave (no-TIN consumes invoice-stream numbers). One commit: `feat(invoicing): as-paid no-TIN on shared invoice stream (accountant ruling α)`.

### Task 9 [β]: CHECK-relax migration

- [ ] **Step 1: Failing integration test** — insert (via repo) an as-paid no-TIN-shaped row: `sequence_number NULL`, `document_number NULL`, `receipt_document_number_raw 'RC-2026-000001'` → currently 23514. 
- [ ] **Step 2: Migration `NNNN_as_paid_no_tin_number_relax.sql`** — DROP + re-ADD `invoices_non_draft_has_snapshots` replacing the two number legs with `((sequence_number IS NOT NULL AND document_number IS NOT NULL) OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL))`; same OR-leg added to `invoices_draft_has_no_number`. Sync both Drizzle `check()` builders. (Pattern: copy 0203's DO-block style.)
- [ ] **Step 3:** `pnpm db:migrate` + test GREEN + a negative probe (NULL numbers AND NULL receipt raw → still 23514). **Step 4: Commit.**

### Task 10 [β]: receipt-stream allocation in the use-case

- [ ] **Step 1:** un-skip Task-5 case-3 (β assertions): allocator `documentType:'receipt'`, receipt prefix from settings (read the recordPayment separate-mode allocation block L332-358 and reuse its prefix + `DocumentNumber` construction verbatim), apply input `sequenceNumber:null, documentNumber:null, receiptDocumentNumberRaw:<formatted>`; delete `no_tin_numbering_pending`.
- [ ] **Step 2:** implement; integration: no-TIN as-paid end-to-end (receipt-stream FIRST allocation lazy-bootstraps in-tx; invoice stream UNTOUCHED — assert its counter delta 0); §87 interleave with a no-TIN as-paid in the middle.
- [ ] **Step 3:** GREEN + commit — `feat(invoicing): as-paid no-TIN receipt-stream numbering (β)`

## Phase 7 — Route + contract

### Task 11: `POST /api/invoices/[invoiceId]/issue-as-paid`

**Files:** Create the route; Test: `tests/contract/invoices/issue-as-paid.contract.test.ts` + `issue-route-guard.contract.test.ts`

- [ ] **Step 1: Contract tests first** (template: `tests/contract/invoices/event-draft.contract.test.ts` — copy its harness): 401 unauthenticated · 403 manager · 404 unknown id · 400 malformed body/paymentDate · 422 future paymentDate · 422 `not_event_subject` · 409 already-issued (sequential double-POST) · 429 + Retry-After (rate limit) · 200 happy (mock use-case) · PII-free logs. Plus `issue-route-guard.contract.test.ts`: direct `POST /issue` with a no-TIN event draft → 422 `event_no_tin_requires_paid_issue` (the `/issue` route has NO contract tests today — this is its first).
- [ ] **Step 2: Implement the route** — copy `issue/route.ts` verbatim and adjust: rate-limit key `f4:issue-as-paid:${tenant}:${userId}` (same 20/300 — §87-burn rationale); parse body `const body = await request.json().catch(() => null)`; `issueEventInvoiceAsPaidSchema.safeParse({ …ids, paymentDate: body?.paymentDate, paymentMethod: body?.paymentMethod ?? 'other', paymentReference: body?.paymentReference ?? null, paymentNotes: body?.paymentNotes ?? null })`; error map: `invoice_not_found`→404 · `invoice_already_issued`→409 · `not_event_subject`/`payment_date_future`/`invalid_lines`/`overflow`/`no_tin_numbering_pending`→422 · `member_archived`/`settings_missing`→409 · `member_not_found`→404 · `no_buyer_snapshot`→422 · render/blob→500.
- [ ] **Step 3:** `pnpm vitest run tests/contract/invoices/` — GREEN. **Memory caveat: the pre-push contract gate is NON-blocking — run this manually before every push of this branch.** **Step 4: Commit.**

## Phase 8 — J2 annotation fix

### Task 12: credit-note re-render uses the stored `pdfDocKind`

**Files:** Modify `issue-credit-note.ts:629-635`; Test: extend `tests/integration/invoicing/credit-note-pdf-golden.test.ts` (or the J2 annotation test file — grep `allowOverwrite` to find it)

- [ ] **Step 1: Failing integration test** — as-paid TIN invoice → issue a credit note → re-download the ORIGINAL's annotated PDF → title still "ใบกำกับภาษี / ใบเสร็จรับเงิน" (combined), NOT "ใบกำกับภาษี".
- [ ] **Step 2: Implement** — replace the hardcoded `kind: 'invoice'` with `kind: loaded.pdfDocKind ?? 'invoice'` + update the stale "only kind='invoice' parents arrive here" comment (it is now false). Note: `receipt_separate` parents remain unreachable here (§86/10 gate) — assert that with a unit test, not a runtime branch.
- [ ] **Step 3:** GREEN + commit — `fix(invoicing): J2 annotation re-render preserves the original document kind`

## Phase 9 — UX

### Task 13: event-fee form — mode + paymentDate/method + as-paid submit

**Files:** Modify `src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx` (+ its zod schema + i18n ×3). Read the file fully first; follow its existing RHF + section pattern.

- [ ] **Step 1:** Add to the form schema: `mode: z.enum(['already_paid','bill_first'])`, `paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`, `paymentMethod: z.enum(['bank_transfer','cheque','cash','other'])` (visible only when `mode==='already_paid'`).
- [ ] **Step 2:** Mode defaulting per spec §2.3 from the selected registration's `payment_status`: `paid`→`already_paid`; `pending|waitlisted`→`bill_first` if buyer TIN else show the blocked-explainer (no submit); `free`→only reachable with amountOverride, no default; `refunded`→hard-block card (no override); `no_show`→no default, force explicit choice. RadioGroup (shadcn) with the detected default + override; `bill_first` option disabled-with-tooltip when the buyer has no TIN. `paymentDate` pre-filled from the registration where available else today (Bangkok); max = today.
- [ ] **Step 3:** Submit: `already_paid` → existing event-draft POST, then `POST /api/invoices/${invoiceId}/issue-as-paid` with `{ paymentDate, paymentMethod }`; on second-call failure toast the mapped error and link to the draft (it remains actionable). `bill_first` → unchanged existing flow. Button label key `admin.invoices.eventFeeForm.recordAndIssue` ("บันทึกรับเงิน + ออกใบเสร็จ" / "Record payment & issue receipt" / SV). All new keys ×3 locales; doc-type preview already exists — verify it matches the as-paid kinds.
- [ ] **Step 4:** `pnpm check:i18n && pnpm check:layout && pnpm lint && pnpm typecheck`; component test for the mode-mapping function (pure — extract `defaultModeFor(paymentStatus, hasTin)` into the form file and unit-test all 6 enum values).
- [ ] **Step 5: Commit** — `feat(invoicing): as-paid mode in event-fee form (F6-status mapping + paymentDate)`

### Task 14: E2E + PDF goldens

- [ ] **Step 1:** PDF golden (extend `event-invoice-pdf-golden.test.ts`): as-paid TIN combined (title + AS-VAT-01 amounts + date = paymentDate incl. BE display on the TH side) and as-paid no-TIN receipt (β/α per gate status).
- [ ] **Step 2:** Playwright (`--workers=1`): admin happy path already-paid TIN (pick paid registration → mode pre-selected → submit → invoice detail shows Paid, no due date confusion); no-TIN + bill-first blocked explainer visible; `@a11y` + `@i18n` on the new form states. Seeds: ensure the E2E seed has registrations covering `paid`, `pending`, `refunded` (extend the existing F6 seed script — SIMULATED members only, never real PII).
- [ ] **Step 3:** Run, GREEN, commit — `test(invoicing): as-paid E2E + PDF goldens`

## Phase 10 — Sweeps & ship-prep

### Task 15: coverage, pins, gates

- [ ] **Step 1:** `vitest.config.ts` — add `issue-event-invoice-as-paid.ts` + `resolve-event-buyer.ts` to the file-level 100% lines/branches/functions block (same class as issue-invoice/record-payment). Run `pnpm test:coverage` — meet it (note: standalone test:coverage has ~22 pre-existing integration-covered threshold failures — judge only the touched files).
- [ ] **Step 2:** Pin tests: redaction-cron predicate covers paid-never-issued (`status <> 'draft'` — add an assertion to the redaction integration test) · derive-overdue ignores as-paid rows (due=issue, paid) · CSV export includes as-paid rows.
- [ ] **Step 3:** Full local gate: `pnpm lint && pnpm typecheck && pnpm vitest run tests/unit/invoicing tests/contract/invoices && pnpm check:i18n && pnpm check:layout && pnpm check:fixme && pnpm check:audit-events && pnpm check:audit-counts && pnpm test:integration -- tests/integration/invoicing` — ALL GREEN.
- [ ] **Step 4:** Update `docs/superpowers/specs/2026-06-10-event-invoice-paid-flow-design.md` §6 statuses if any follow-up closed; final commit.

### Task 16: reviews before PR

- [ ] **Step 1:** thai-tax-compliance-auditor re-review (scope: §105 timing, numbering streams as built, FY-from-paymentDate, J2) — must PASS.
- [ ] **Step 2:** code review (security-sensitive: ≥2 reviewers or solo-maintainer substitute + security checklist) + spec-compliance walk of §3.8a US1–US5 against the code paths.
- [ ] **Step 3:** PR to `main` from `064-event-invoice-paid-flow`. **Ship gate reminders (spec §6):** item 1 remediation + item 6 runbook BEFORE flag-flip; the interim Task-8 guard stays until item 1 closes.

---

## Self-Review (author checklist — done at write time)

1. **Spec coverage:** §3.1→T1; pdf_doc_kind (§3.4 J2 "stored document kind")→T2; helper refactor (§3.2 compose-not-duplicate + user latitude)→T3; §3.2/§3.6 persistence→T4; use-case steps 1-13→T5; §3.8 P0 integration→T6; §3.4 guards→T7-T8; §3.3 β/α→T9-T10+α-box; §3.5 route→T11; J2→T12; §2.3+§3.5 UX→T13; goldens/E2E→T14; coverage+pins+gates→T15; governance→T16. Out-of-code §6 items are operator-owned (gates referenced in T9/T16).
2. **Placeholder scan:** "moved verbatim"/"mirror L619-677" instructions are exact-refactor directives with the source location given — acceptable; no TBDs.
3. **Type consistency:** `applyIssueAsPaid` input matches T5's call (pdfDocKind union, paymentMethod enum = applyPayment's); `IssueEventInvoiceAsPaidError` codes match T11's route map; `resolveEventBuyerForIssue` errors map 1:1 in both callers; `canTransition` third arg threaded in T1/T5.
