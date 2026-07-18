# Invoice Dialog UX Declutter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate and shorten the copy across the invoice dialog family, consolidate warning alerts onto the existing semantic `InlineAlert tone="warning"`, and unify cross-dialog patterns — without changing any tax/compliance meaning.

**Architecture:** Three phases matching the design tiers. Phase A is pure i18n copy edits. Phase B swaps hardcoded amber `Alert` blocks for `InlineAlert tone="warning"`. Phase C is cross-dialog consistency: a server tweak so the event-fee 409 carries the existing invoice id (enabling a real "View invoice" CTA), unified typed-confirm copy, one focused-error primitive, and dead-key/style cleanup.

**Tech Stack:** Next.js 16 App Router, React 19, next-intl, Tailwind v4, shadcn/ui + Radix, Vitest + Testing Library, Playwright.

**Design spec:** `docs/superpowers/specs/2026-07-18-invoice-dialogs-ux-declutter-design.md`

## Global Constraints

- **Copy source of truth is EN** (`src/i18n/messages/en.json`). Every changed value MUST be mirrored in `th.json` + `sv.json` in the same task. Preserve **verbatim** in all locales: `§` references (§86/4, §87, §80/1(5)), Thai doc terms `ใบแจ้งหนี้` / `ใบกำกับภาษี` / `ใบเสร็จรับเงิน` / `ใบลดหนี้`, `ภ.พ.30`, THB amounts, and every `{placeholder}` token. TH is mandatory; do not leave TH/SV as EN fallback.
- **Never remove tax meaning** — only shorten/dedupe. In doubt, keep the clause.
- **Package manager: `pnpm`** (never npm).
- **No Prettier on this repo** — hand-format; keep diffs minimal (`git diff -w` to sanity-check).
- **Run `pnpm typecheck` as the FINAL gate** after the last edit of a task, before committing.
- **Run `pnpm check:i18n`** after any locale-file edit (fails on missing EN keys; TH/SV parity).
- **E2E:** always `--workers=1`.
- **Preserve every `data-testid`** on migrated components so existing tests keep matching.
- **Do NOT** restructure the Void full-page route into a modal (out of scope).
- Branch: `invoice-dialogs-ux-declutter` (already created off `origin/main`; design doc committed).

---

## Phase A — Tier 1: Copy dedup + trim (pure i18n)

> Mechanics for every Phase-A task: (1) edit the EN value(s) in `src/i18n/messages/en.json`; (2) edit the matching TH value(s) in `th.json` and SV in `sv.json`, applying the SAME trim and preserving the verbatim terms above; (3) `pnpm check:i18n`; (4) run the affected component test(s) to confirm still-green; (5) `pnpm typecheck`; (6) commit.

### Task A1: Issue-dialog copy (dedup + trim)

**Files:**
- Modify: `src/i18n/messages/en.json` → `admin.invoices.issue.*`
- Modify: `src/i18n/messages/th.json`, `src/i18n/messages/sv.json` (same keys)
- Verify (no edit expected): `tests/unit/app/admin/invoices/issue-invoice-form.test.tsx`

**EN before → after** (keys under `admin.invoices.issue`):

| key | after (EN) |
|---|---|
| `review.heading` | `Review before issuing` |
| `review.immutableSnapshotAck` | `Issuing pins an IMMUTABLE tax snapshot — buyer identity, Head Office / Branch, VAT treatment and notes. It can only be changed by voiding this document.` |
| `review.billStreamNote` | `A non-tax ใบแจ้งหนี้ number ({prefix}-…) is allocated now — no §87 tax number is used yet. The §86/4 ใบกำกับภาษี/ใบเสร็จรับเงิน is issued when payment is recorded.` |
| `noTaxIdHint088` | `This buyer has no Tax ID. The ใบแจ้งหนี้ still issues (and its §86/4 tax invoice/receipt at payment stays valid), but a VAT-registered buyer can't claim input VAT without their Tax ID on the document — add it before issuing if they need to claim.` |
| `noTaxIdHint` | `This buyer has no Tax ID. The invoice still issues with name and address, but a VAT-registered buyer can't claim input VAT without their Tax ID on the document — add it before issuing if they need to claim.` |
| `review.warnings.noPaymentPath` | `No payment path configured — online payment is off and no bank-transfer details are set, so the member can't pay this bill. Add a payment method before issuing.` |
| `review.warnings.notVatRegistrant` | `No Head Office / Branch line will print — this buyer isn't recorded as a VAT registrant. If they are, tick "This member is registered for VAT" on the member record first.` |
| `form.vatTreatment.membershipCaption` | `Membership is always VAT 7% — §80/1(5) applies to event/service sales only.` |
| `form.vatTreatment.help` | `Embassy / international-organization sales only — attach the MFA §80/1(5) certificate. All other sales stay at standard VAT 7%.` |
| `form.lowAmountWarning` | `This zero-rated sale is below 5,000 THB — an MFA certificate is normally required at 5,000 THB or more. Confirm it applies before issuing.` |
| `form.certUpload.helpText` | `Optional. PDF, PNG or JPG up to 5 MB, virus-scanned before storage. The certificate NUMBER above validates the zero rate — the scan is supporting evidence only.` |
| `irreversibleWarning` | `Allocates a Thai RD §87 sequential number and cannot be reversed — to cancel, issue a credit note (ใบลดหนี้).` |

**Do NOT change** (test asserts exact string, already concise): `form.cert.revealed`, `form.cert.noRequired`.

- [ ] **Step 1:** Apply the EN after-values above in `en.json`.
- [ ] **Step 2:** Apply the same trims to `th.json` + `sv.json` (preserve verbatim terms/placeholders per Global Constraints).
- [ ] **Step 3:** `pnpm check:i18n` — Expected: PASS (no missing keys).
- [ ] **Step 4:** Run the component test, confirm still green (it must NOT depend on the changed strings; `lowAmountWarning` keeps "below 5,000 THB"):
  `pnpm test tests/unit/app/admin/invoices/issue-invoice-form.test.tsx`
  Expected: PASS.
- [ ] **Step 5:** Scan e2e for asserts on the renamed `review.heading` before trusting green:
  `pnpm exec grep -rn "immutable §86/4 snapshot\|Review — this pins" tests/` → Expected: no matches (all such text is gone; if found, update those e2e assertions).
- [ ] **Step 6:** `pnpm typecheck` → PASS.
- [ ] **Step 7:** Commit: `git add src/i18n/messages/{en,th,sv}.json && git commit -m "i18n(invoices): dedupe + trim issue-dialog copy"`

### Task A2: Record-payment + Void copy

**Files:** `src/i18n/messages/{en,th,sv}.json` → `admin.invoices.pay.description`, `admin.invoices.void.{description,terminalNotice}`

**EN before → after:**

| key | after (EN) |
|---|---|
| `pay.description` | `Record the payment received for this invoice. The §86/4 tax receipt is issued and, if an email is on file, sent to the member.` |
| `void.description` | `Void this issued-unpaid invoice: the sequential tax-document number is retired and cannot be reused, the PDF is re-stamped VOID, and a cancellation notice is emailed to the member.` |
| `void.terminalNotice` | `Void is terminal — no pay, credit, or edit afterwards. To reverse a PAID invoice, use the credit-note workflow instead.` |

Rationale: `pay.description` previously said "Mark this invoice paid … emailed to the member" — it understated the §86/4 receipt mint and promised email unconditionally despite the `skipped_no_email` path (`payment-form.tsx`). Void `description`/`terminalNotice` previously both stressed "final/terminal"; now each states its point once.

- [ ] **Step 1:** Apply EN after-values in `en.json`.
- [ ] **Step 2:** Mirror in `th.json` + `sv.json`.
- [ ] **Step 3:** `pnpm check:i18n` → PASS.
- [ ] **Step 4:** Run affected tests: `pnpm test tests/unit/app/admin/invoices` (payment/void components) → PASS. If any test asserts the old `pay.description`/`void` copy verbatim, update it to the new string.
- [ ] **Step 5:** `pnpm typecheck` → PASS.
- [ ] **Step 6:** Commit: `git commit -am "i18n(invoices): tighten payment + void dialog copy"`

### Task A3: Event-fee `mode.billFirstNeedsTin` copy

**Files:** `src/i18n/messages/{en,th,sv}.json` → `admin.invoices.eventFeeForm.mode.billFirstNeedsTin`

(The `duplicateDialog` copy is changed in Task C2 together with the "View invoice" CTA.)

**EN after:** `Not recorded as VAT-registered — record the fee as already paid; a bill can't be issued before payment. Tick VAT-registered on the member record first if applicable.`

- [ ] **Step 1:** Apply EN; mirror TH + SV.
- [ ] **Step 2:** `pnpm check:i18n` → PASS.
- [ ] **Step 3:** `pnpm test tests/unit/components/invoices/event-fee-form.test.tsx` → PASS (update the assertion if it pins this string verbatim).
- [ ] **Step 4:** `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit: `git commit -am "i18n(invoices): trim event-fee bill-first-needs-TIN hint"`

---

## Phase B — Tier 2: Warning-color consolidation

Replace hardcoded amber `Alert` blocks with the existing `InlineAlert tone="warning"` (semantic tokens, dark-mode-aware). Keep icons, `role`, and `data-testid`.

### Task B1: Issue-form warnings → InlineAlert

**Files:** Modify `src/app/(staff)/admin/invoices/_components/issue-invoice-form.tsx`
- Test: `tests/unit/app/admin/invoices/issue-invoice-form.test.tsx`

**Import change:** add `import { InlineAlert, InlineAlertDescription } from '@/components/ui/inline-alert';` (keep `Alert`/`AlertDescription` import — still used by the focused form-error until Task C4).

**Transform each amber block.** Pattern (applies to the low-amount advisory `~:481-492`, no-payment-path `~:569-579`, not-VAT-registrant `~:586-597`, and the no-Tax-ID hint `~:602-613`):

Before (low-amount advisory example):
```tsx
<Alert
  role="status"
  className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
  data-testid="zero-rate-low-amount-warning"
>
  <TriangleAlertIcon className="size-4" aria-hidden="true" />
  <AlertDescription className="text-amber-900 dark:text-amber-200">
    {tForm('lowAmountWarning')}
  </AlertDescription>
</Alert>
```
After:
```tsx
<InlineAlert
  role="status"
  tone="warning"
  data-testid="zero-rate-low-amount-warning"
>
  <TriangleAlertIcon className="size-4" aria-hidden="true" />
  <InlineAlertDescription>{tForm('lowAmountWarning')}</InlineAlertDescription>
</InlineAlert>
```

For the **no-Tax-ID hint** (`~:602-613`) the trigger is `showNoTaxIdHint`; it currently uses `InfoIcon` + amber `Alert`. Convert to `InlineAlert tone="warning"` with the same `InfoIcon` and the existing conditional text (`t(taxAtPayment ? 'noTaxIdHint088' : 'noTaxIdHint')`). Drop all `text-amber-*`/`bg-amber-*` classes.

- [ ] **Step 1:** Add the `InlineAlert` import.
- [ ] **Step 2:** Convert all four amber blocks as above (remove every `amber` class; `role="status"` preserved on the three advisories; the no-Tax-ID hint keeps `InfoIcon`).
- [ ] **Step 3:** Run: `pnpm test tests/unit/app/admin/invoices/issue-invoice-form.test.tsx` — Expected: PASS. The low-amount test queries `getByTestId('zero-rate-low-amount-warning')` + `role="status"` + `/below 5,000 THB/i` — all preserved.
- [ ] **Step 4:** `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit: `git commit -am "refactor(invoices): issue-form warnings use InlineAlert tone=warning"`

### Task B2: Event-fee VAT-period warning → InlineAlert

**Files:** Modify `src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx` (the `showVatPeriodWarning` block, `~:486-499`, currently a hand-rolled amber `<p>` with `AlertTriangleIcon` + `role="status"`).

Replace the amber `<p role="status" …className="…amber…">` with:
```tsx
<InlineAlert
  id="payment-date-vat-warning"
  role="status"
  tone="warning"
  data-testid="payment-date-vat-warning"
>
  <AlertTriangleIcon className="size-4" aria-hidden="true" />
  <InlineAlertDescription>{t('payment.vatPeriodWarning')}</InlineAlertDescription>
</InlineAlert>
```
Add the `InlineAlert`/`InlineAlertDescription` import. Keep the `id` (referenced by the date input's `aria-describedby`) and `data-testid`.

- [ ] **Step 1:** Add import + convert the block.
- [ ] **Step 2:** Run: `pnpm test tests/unit/components/invoices/event-fee-form.test.tsx` — Expected: PASS (queries `getByTestId('payment-date-vat-warning')` + `role="status"`; both preserved). Update the class-based assertion only if one exists.
- [ ] **Step 3:** `pnpm typecheck` → PASS.
- [ ] **Step 4:** Commit: `git commit -am "refactor(invoices): event-fee VAT-period warning uses InlineAlert"`

---

## Phase C — Tier 3: Cross-dialog consistency

### Task C1: `event-draft` 409 returns `existing_invoice_id` (server, TDD)

**Files:**
- Modify: `src/app/api/invoices/event-draft/route.ts` (the `duplicate → 409` arm, `~:107`)
- Modify (if the code lives there): the event-draft use case so the `duplicate` error carries the existing invoice id (inspect `src/modules/invoicing/application/use-cases/*event*draft*` — the route maps `result.error.code === 'duplicate'`).
- Test: `tests/contract/invoices/event-draft-duplicate-409.contract.test.ts` (new)

**Interfaces — Produces:** a 409 body shaped `{ error: { code: 'duplicate' }, existing_invoice_id: string }`. Task C2 consumes `existing_invoice_id`.

- [ ] **Step 1: Write the failing contract test** — POST a duplicate event-fee draft (same registration) and assert the 409 body includes `existing_invoice_id` equal to the first draft's id. (Model the arrange/act on the existing `tests/contract/invoicing/issue-invoice.contract.test.ts` harness.)
- [ ] **Step 2: Run it** → Expected: FAIL (`existing_invoice_id` undefined).
- [ ] **Step 3: Implement** — have the duplicate-detection path surface the existing invoice id (e.g. return it in the domain error payload), and include it in the route's 409 JSON: `return json({ error: { code: 'duplicate' }, existing_invoice_id }, { status: 409 })`.
- [ ] **Step 4: Run it** → PASS.
- [ ] **Step 5:** `pnpm typecheck` → PASS.
- [ ] **Step 6:** Commit: `git commit -am "feat(invoices): event-draft 409 returns existing_invoice_id"`

### Task C2: Duplicate dialog "View invoice" CTA (client)

**Files:**
- Modify: `src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx` (the 409 handler `~:957-960` sets `setDuplicateOpen(true)` — also capture the id; and the `AlertDialog` at `~:1229-1241`)
- Modify: `src/i18n/messages/{en,th,sv}.json` → `admin.invoices.eventFeeForm.duplicateDialog`

**Copy after (EN):**
- `duplicateDialog.description` → `An event-fee invoice already exists for this attendee. Open it instead of creating a duplicate.`
- add `duplicateDialog.viewInvoice` → `View invoice`

**Component:**
- Add state `const [duplicateInvoiceId, setDuplicateInvoiceId] = useState<string | null>(null);`
- In the `res.status === 409` arm, parse the body and store the id:
```tsx
if (res.status === 409) {
  const dupBody = await res.json().catch(() => ({}));
  setDuplicateInvoiceId(
    (dupBody as { existing_invoice_id?: string }).existing_invoice_id ?? null,
  );
  setDuplicateOpen(true);
  return;
}
```
- In the dialog footer, render a link (only when id present) BEFORE Close:
```tsx
<AlertDialogFooter>
  {duplicateInvoiceId && (
    <Link
      href={`/admin/invoices/${duplicateInvoiceId}`}
      className={buttonVariants({ variant: 'default' })}
    >
      {t('duplicateDialog.viewInvoice')}
    </Link>
  )}
  <AlertDialogCancel>{t('duplicateDialog.cancel')}</AlertDialogCancel>
</AlertDialogFooter>
```
Add imports: `import Link from 'next/link';` and `buttonVariants` from `@/components/ui/button`.

- [ ] **Step 1:** Add copy (EN + TH + SV) + `pnpm check:i18n` → PASS.
- [ ] **Step 2:** Wire the id state + footer link.
- [ ] **Step 3:** Add/extend a component test: on 409 with `existing_invoice_id`, the dialog shows a "View invoice" link pointing at `/admin/invoices/<id>`; without an id, only Close renders. Run `pnpm test tests/unit/components/invoices/event-fee-form.test.tsx` → PASS.
- [ ] **Step 4:** `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit: `git commit -am "feat(invoices): duplicate dialog links to the existing invoice"`

### Task C3: Unify typed-confirm copy + document refund case exception

**Files:**
- Modify: `src/i18n/messages/{en,th,sv}.json` → `admin.invoices.void.{confirmCopy,confirmMismatch}` to match the Issue phrasing shape.
- Modify: `src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/typed-phrase-confirm.tsx` (comment only).

**Copy after (EN):**
- `void.confirmCopy` → `Type the invoice number {phrase} to confirm` (matches `issue.confirmCopy` "Type \"{phrase}\" to confirm" shape; keep the "invoice number" hint since void types a document number).
- `void.confirmMismatch` → `Phrase must match {phrase} exactly to confirm.` (mirrors `issue.confirmMismatch`).

**Refund comment:** above `const matches = value === expected;` (`typed-phrase-confirm.tsx:37`) add:
```tsx
// NOTE: Refund is deliberately case-SENSITIVE (unlike Issue/Void, which are
// case-insensitive) — a completed Stripe refund cannot be undone, so the extra
// friction is intentional. See design 2026-07-18 §Decisions(4). Not drift.
```

- [ ] **Step 1:** Apply void copy (EN + TH + SV); `pnpm check:i18n` → PASS.
- [ ] **Step 2:** Add the refund comment.
- [ ] **Step 3:** Run `pnpm test tests/unit/app/admin/invoices` → PASS (update void component test if it pins `confirmCopy`/`confirmMismatch` verbatim).
- [ ] **Step 4:** `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit: `git commit -am "refactor(invoices): unify issue/void typed-confirm copy; document refund case policy"`

### Task C4: One focused-error primitive (InlineAlert forwardRef)

**Files:**
- Modify: `src/components/ui/inline-alert.tsx` — make `InlineAlert` accept a ref.
- Modify: `src/app/(staff)/admin/invoices/_components/issue-invoice-form.tsx` (`~:617-643`) and `src/app/(staff)/admin/invoices/[invoiceId]/void/_components/void-confirm-dialog.tsx` (`~:151-177`) — migrate the focused destructive form-error from `Alert variant="destructive"` to `InlineAlert tone="destructive"`, preserving `ref`, `tabIndex={-1}`, and `data-testid` (`issue-invoice-error` / `void-invoice-error`).
- Test: `tests/unit/app/admin/invoices/issue-invoice-form.test.tsx` (error-path assertions), any void component test.

**Primitive change** — wrap in `React.forwardRef`:
```tsx
const InlineAlert = React.forwardRef<HTMLDivElement, InlineAlertProps>(
  function InlineAlert({ className, tone, role = "alert", ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="inline-alert"
        data-tone={tone ?? "neutral"}
        role={role}
        className={cn(inlineAlertVariants({ tone }), className)}
        {...props}
      />
    );
  },
);
```

**Call-site migration** (issue-invoice-form error block): replace `<Alert ref={errorRef} tabIndex={-1} variant={formError.kind === 'failure' ? 'destructive' : 'default'} …>` with `<InlineAlert ref={errorRef} tabIndex={-1} tone={formError.kind === 'failure' ? 'destructive' : 'neutral'} …>` and swap the inner `AlertDescription` → `InlineAlertDescription`. Keep icon, the concurrent-refresh button, and `data-testid="issue-invoice-error"`. Do the same for void's error block (`data-testid="void-invoice-error"`). Once migrated, drop the now-unused `Alert`/`AlertDescription` imports from those two files if nothing else uses them.

- [ ] **Step 1:** Add a small render test asserting `InlineAlert` forwards its ref to the DOM node (render with a ref, assert `ref.current` is the `[data-slot="inline-alert"]` div). Run → FAIL.
- [ ] **Step 2:** Apply the `forwardRef` change. Run the ref test → PASS.
- [ ] **Step 3:** Migrate the issue + void error blocks.
- [ ] **Step 4:** Run `pnpm test tests/unit/app/admin/invoices/issue-invoice-form.test.tsx` and the void test → PASS (focus-on-error + `getByTestId` still resolve; the focus effect uses the same `errorRef`).
- [ ] **Step 5:** `pnpm typecheck` → PASS (confirm no dangling `Alert` imports).
- [ ] **Step 6:** Commit: `git commit -am "refactor(ui): InlineAlert forwardRef; unify invoice focused-error primitive"`

### Task C5: Dead keys + Cancel/ellipsis/error-size cleanup

**Files:**
- Modify: `src/i18n/messages/{en,th,sv}.json` — remove confirmed-dead keys; adjust trigger labels.
- Modify: `src/app/(staff)/admin/invoices/_components/csv-export-dialog.tsx` (Cancel variant + error text size).

- [ ] **Step 1: Verify dead keys before deleting.** Run:
  `pnpm exec grep -rn "issue\.typeToConfirm\|pay\.cancel\b\|void\.backToInvoice\|issue\.description\b" src/` and inspect each consumer. Delete from all 3 locales ONLY the keys with zero runtime consumers: confirmed-dead `admin.invoices.issue.typeToConfirm`; verify `admin.invoices.pay.cancel` (component uses `pay.cancelDialog`), `admin.invoices.void.backToInvoice` (component uses `void.cancel`), `admin.invoices.issue.description` (dialog uses `review.immutableSnapshotAck`/`irreversibleWarning`).
- [ ] **Step 2: Trigger ellipsis convention.** In `en.json` (+ TH/SV), give dialog-opening triggers a consistent ellipsis: `pay` trigger "Record payment…", `csvExport.trigger` "Export CSV…", `refund` button "Issue refund…", `deleteDraft.trigger` "Delete draft…" — matching the existing "Issue…"/"Void…". (Copy-only; the `…` is the Unicode ellipsis U+2026 already used by the existing keys — match them.)
- [ ] **Step 3: CSV dialog polish.** In `csv-export-dialog.tsx`: change the error `<p>` class `text-sm text-destructive` → `text-xs text-destructive` (`:139`); change Cancel `variant="ghost"` → `variant="outline"` (`:149`) to match the family default.
- [ ] **Step 4:** `pnpm check:i18n` → PASS; `pnpm typecheck` → PASS.
- [ ] **Step 5:** Run `pnpm test tests/unit/app/admin/invoices tests/unit/components/invoices` → PASS (update any assertion that pins an old trigger label).
- [ ] **Step 6:** Commit: `git commit -am "chore(invoices): remove dead i18n keys; unify trigger/cancel/error styling"`

---

## Phase D — Verification & review

### Task D1: Full gate + reviews

- [ ] **Step 1:** Reproduce the CI subset locally:
  `pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm test tests/unit/app/admin/invoices tests/unit/components/invoices` → all PASS.
- [ ] **Step 2:** E2E smoke on the issue flow: `pnpm test:e2e tests/e2e/invoice-draft-issue.spec.ts --workers=1` → PASS.
- [ ] **Step 3:** Manual/browser check: open the Issue dialog for a membership invoice with no Tax ID and confirm the copy reads cleanly (no "immutable snapshot" duplication), warnings render in the semantic warning tone in light + dark, and the event-fee duplicate dialog shows a working "View invoice" link.
- [ ] **Step 4:** Request project reviews (money/tax UI): **enterprise-ux-designer**, **i18n-translation-reviewer**, and **thai-tax-compliance-auditor** (confirm no §86/4 / §87 / MFA-cert meaning lost). Address findings.
- [ ] **Step 5:** Open PR from `invoice-dialogs-ux-declutter` → `main` summarizing the 3 tiers; link the design spec.

---

## Self-review notes (author)

- **Spec coverage:** Tier 1 → A1–A3; Tier 2 → B1–B2; Tier 3 → C1 (duplicate server), C2 (duplicate CTA), C3 (typed-confirm + refund exception), C4 (error primitive), C5 (dead keys + Cancel/ellipsis/CSV). Non-goals (Void→modal) intentionally omitted.
- **Placeholder scan:** EN after-values are literal; TH/SV are governed by the Global Constraints rule (mirror + verbatim terms) rather than pre-authored here — this is the project's standing EN-canonical convention, verified by `check:i18n` + the i18n reviewer gate, not an open TODO.
- **Type consistency:** `existing_invoice_id` (C1 produces) == field read in C2. `InlineAlert` forwardRef (C4) is the only signature change; `tone` values used (`warning`, `destructive`, `neutral`) all exist in `inlineAlertVariants`.
- **Open items forwarded to execution:** confirm `pay.cancel` / `void.backToInvoice` / `issue.description` are truly dead (C5 Step 1) before deletion.
