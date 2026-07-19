# Invoice dialog family — UX declutter + consistency pass

**Date:** 2026-07-18
**Author:** brainstorming session (Jirawat + Claude)
**Status:** design — pending user review
**Scope area:** `src/app/(staff)/admin/invoices/**` dialogs + `src/components/ui/{alert,inline-alert}.tsx` + `src/i18n/messages/{en,th,sv}.json`

## Problem

An admin reported that the **"Issue invoice" confirmation dialog** shows too much
explanatory text ("คำอธิบายเยอะมาก"). A UX audit of the whole invoice dialog
family (enterprise-ux-designer, 2026-07-18) found the same verbosity/redundancy
in sibling dialogs, plus several cross-dialog inconsistencies (warning-color
drift, mixed error primitives, inconsistent Cancel styling and trigger labels).

This is a **UX + i18n consistency pass**, not a structural rewrite. Copy source
of truth is **EN** (`en.json`); **TH + SV mirror** it (TH is mandatory for
tax-document surfaces). No tax/compliance meaning is removed — only wording is
tightened, duplication removed, and primitives unified.

## Non-goals (explicitly out of scope)

- **Void page → modal migration.** Void is a full-page route (`/void`) while the
  rest are modals. This is acknowledged tech-debt (CR-6, `void-confirm-dialog.tsx:13-16`)
  and a large structural change. Deferred to a separate task.
- Changing any tax semantics: §86/4 snapshot, §87 sequential numbering, no-Tax-ID
  input-VAT caveat, void/credit-note irreversibility, ภ.พ.30 closed-period,
  MFA §80/1(5) certificate. All such warnings stay — only shortened.
- `errors.*` copy that only renders on failure (kept clear; not part of the
  "normal-flow verbosity" complaint). Left as-is except where noted.

## Decisions (locked with user)

1. **Direction:** deduplicate + shorten copy, keep every block, no compliance
   change. Extend consistently across the whole Issue-dialog family (incl. Event
   fee), not just membership.
2. **Warning consolidation (Tier 2):** use the EXISTING `InlineAlert tone="warning"`
   (semantic tokens `bg-warning-surface text-warning`, dark-mode-aware) — do NOT
   add a hardcoded `variant="warning"` to `Alert`. This unifies on the primitive
   already used by Void/Refund.
3. **Duplicate dialog (event fee):** fix the dead-end. Server change — `event-draft`
   409 returns the existing invoice id; client adds a real **"View invoice"** CTA.
4. **Refund typed-confirm case-sensitivity:** KEEP Refund case-SENSITIVE (Stripe
   refund is not undoable — deliberate friction, `typed-phrase-confirm.tsx:9-16`).
   Do NOT force uniformity. Document it as an intentional exception so it reads as
   a decision, not drift.

---

## Tier 1 — Copy dedup + trim (pure i18n, low risk)

Edit VALUES only in `en.json` → mirror in `th.json` + `sv.json`. No key
additions/removals here except the dead-key cleanup (Tier 3 §3e). Update the
few tests that assert exact copy (listed under Test impact).

### Issue dialog (`admin.invoices.issue.*`)

| key | change |
|---|---|
| `review.heading` | "Review — this pins an immutable §86/4 snapshot" → **"Review before issuing"** (removes duplication with the ack shown directly above it) |
| `review.immutableSnapshotAck` | drop the trailing "Review the details below before you confirm." (the heading below already says "Review before issuing"). Keep the immutable-snapshot + only-by-void meaning. |
| `review.billStreamNote` | trim to: "A non-tax ใบแจ้งหนี้ number ({prefix}-…) is allocated now — no §87 tax number is used yet. The §86/4 ใบกำกับภาษี/ใบเสร็จรับเงิน is issued when payment is recorded." |
| `noTaxIdHint088` | trim preamble, keep input-VAT caveat: "This buyer has no Tax ID. The ใบแจ้งหนี้ still issues (and its §86/4 tax invoice/receipt at payment stays valid), but a VAT-registered buyer can't claim input VAT without their Tax ID on the document — add it before issuing if they need to claim." |
| `noTaxIdHint` (legacy flag-off) | mirror the same trim. |
| `review.warnings.noPaymentPath` | drop the repeated "the bill is currently unpayable" clause; keep "no payment path / configure a method first". |
| `review.warnings.notVatRegistrant` | minor tighten; keep the "tick VAT-registered on the member record" instruction. |
| `form.vatTreatment.membershipCaption` | "Membership is always VAT 7% — §80/1(5) applies to event/service sales only." |
| `form.vatTreatment.help` | "Embassy / international-organization sales only — attach the MFA §80/1(5) certificate. All other sales stay at standard VAT 7%." |
| `form.lowAmountWarning` | tighten but **keep substring "below 5,000 THB"** (asserted by test). |
| `form.certUpload.helpText` | tighten (keep "virus-scanned", "the certificate NUMBER … validates the zero rate", "supporting evidence only"). |
| `irreversibleWarning` (legacy flag-off) | "Allocates a Thai RD §87 sequential number and cannot be reversed — to cancel, issue a credit note (ใบลดหนี้)." |

**Keep unchanged (test asserts exact string, already concise):**
`form.cert.revealed`, `form.cert.noRequired`.

### Record payment (`admin.invoices.pay.*`)

| key | change |
|---|---|
| `description` | fix understatement + unconditional email promise → "Record the payment received for this invoice. The §86/4 tax receipt is issued and sent to the member if an email is on file." (align with the code's `skipped_no_email` path). |

### Void (`admin.invoices.void.*`)

| key | change |
|---|---|
| `description` + `terminalNotice` | remove the "final/terminal" overlap between the two. `description` = *what happens* (number retired, PDF re-stamped VOID, notice emailed); `terminalNotice` = *terminality + paid→credit-note path*. Each states its point once. |

### Event-fee duplicate (`admin.invoices.eventFeeForm.duplicateDialog.*` + `mode.*`)

| key | change |
|---|---|
| `duplicateDialog.description` | reword to match the new "View invoice" CTA (Tier 3 §3d). |
| `mode.billFirstNeedsTin` | trim the 2-sentence radio hint (keep the VAT-registered instruction). |

---

## Tier 2 — Warning-color consolidation (small component change)

Replace hardcoded amber `Alert` blocks with the existing `InlineAlert tone="warning"`
(theme-aware semantic tokens). Sites:

- `issue-invoice-form.tsx`: low-amount advisory (`~:482-491`), no-payment-path
  warning (`~:570-578`), not-VAT-registrant warning (`~:587-596`), and the
  no-Tax-ID hint (`~:602-613`, currently amber `Alert`).
- `event-fee-form.tsx`: payment-date ภ.พ.30 VAT-period warning (`~:486-499`,
  currently hand-rolled amber `<p>`).

Each keeps its icon (`TriangleAlertIcon`/`AlertTriangleIcon`), `role`
(`status` for non-blocking advisories), and `data-testid`. Net: one warning
recipe across the family; removes the `bg-amber-50 dark:bg-amber-950/30` vs
`bg-amber-50/50 dark:bg-amber-950/20` drift and the dark-mode text-color
divergence.

No change to `Alert` itself. (Audit suggested adding `variant="warning"` to
`Alert`; rejected — `InlineAlert` already carries the semantic tone and is the
in-form primitive.)

---

## Tier 3 — Cross-dialog consistency

### 3a. Unify typed-confirm copy

Introduce a shared key set for the confirm instruction + mismatch message so
Issue/Void read identically (Refund keeps its own copy — see 3b):

- instruction: today `issue.confirmCopy` "Type \"{phrase}\" to confirm" vs
  `void.confirmCopy` "Type the invoice number {phrase} to confirm this
  irreversible action." → unify to one phrasing (the void variant may keep the
  "invoice number" hint as an interpolation, but the sentence shape matches).
- mismatch: `issue.confirmMismatch` "Phrase must match \"{phrase}\" exactly to
  confirm." vs `void.confirmMismatch` "The phrase must be {phrase}." → unify.

Implementation: keep per-namespace keys (avoid a risky global i18n move) but make
the VALUES identical, OR extract a small shared namespace `admin.common.typedConfirm`.
**Decision for plan:** prefer identical values in existing keys (lower blast
radius, no consumer rewiring). Revisit a shared namespace only if the plan shows
≥4 duplicate sites.

### 3b. Case-sensitivity — documented exception

Add a one-line code comment cross-reference so the Issue/Void (case-insensitive)
vs Refund (case-sensitive) split is visibly intentional. No behavior change.

### 3c. Error-surface primitive

Standardize the focused destructive form-error on ONE primitive. Today: Issue +
Void use `Alert variant="destructive"` (with `ref`/`tabIndex={-1}`/focus); Refund
uses `InlineAlert`. Plan: make `InlineAlert` `forwardRef` (small primitive change)
and migrate the Issue/Void focused errors to `InlineAlert tone="destructive"`,
preserving the existing `data-testid` (`issue-invoice-error`, `void-invoice-error`)
so tests keep passing. Delete-draft (low-stakes) may keep its `toast` — but the
duplicate dialog stops being a toast/dead-end (3d).

### 3d. Duplicate dialog CTA (server + client)

- Server: `POST /api/invoices/event-draft` returns the existing invoice id in the
  409 body (e.g. `{ error: { code: 'duplicate' }, existing_invoice_id }`). Add a
  contract test for the 409 shape.
- Client (`event-fee-form.tsx` duplicate `AlertDialog`): read the id, render a
  "View invoice" link/CTA to `/admin/invoices/{id}` alongside Close. Consider
  switching `AlertDialog`→`Dialog` since it is now informational-with-one-action.

### 3e. Minor consistency + dead keys

- **Cancel styling:** csv-export + void use `variant="ghost"`; others use
  `AlertDialogCancel`/`outline`. Align on the family default (`AlertDialogCancel`
  where a modal; `outline` where a plain page). Small class changes.
- **Trigger ellipsis:** "Issue…"/"Void…" have an ellipsis; "Record payment",
  "Export CSV", "Issue refund", "Delete draft" don't. All open a dialog → add the
  ellipsis convention consistently (copy-only).
- **CSV error text size:** `text-sm` → `text-xs text-destructive` to match the
  family.
- **Dead keys:** remove `admin.invoices.issue.typeToConfirm` (confirmed unused;
  the members archive dialog uses a different namespace) and verify+remove
  `admin.invoices.pay.cancel` and `admin.invoices.issue.description` (dialog
  renders `review.immutableSnapshotAck`/`irreversibleWarning` instead). Remove
  from all 3 locales; run `pnpm check:i18n`.

---

## Test impact (must update in lockstep)

- `tests/unit/app/admin/invoices/issue-invoice-form.test.tsx`
  - asserts EXACT `form.cert.revealed` (`:103`) and `form.cert.noRequired` (`:128`)
    → **not changing those strings**, so no update needed there.
  - `/below 5,000 THB/i` (`:168`) → keep the substring in `lowAmountWarning`.
  - radio labels matched by `/Standard/i`, `/Zero-rated/i` → keep those words.
  - if warning `Alert`→`InlineAlert` swap changes queried roles: verify
    `role="status"` + `data-testid` preserved.
- `tests/e2e/invoice-draft-issue.spec.ts` — scan for any assert on issue-dialog
  copy substrings ("immutable"/"Review") before renaming `review.heading`.
- `tests/unit/components/invoices/event-fee-form.test.tsx` — duplicate-dialog +
  mode-hint copy; update if asserted.
- New: contract test for the `event-draft` 409 `existing_invoice_id` shape.
- Any `data-testid`-based queries on migrated error alerts must keep the same
  testids.

## Compliance / review gates

- Money/tax UI → **enterprise-ux + i18n reviewer** in addition to normal code
  review (project convention). Thai-tax-compliance reviewer confirms no §86/4 /
  §87 / MFA-cert meaning was lost in the trims.
- `pnpm check:i18n` (EN key parity + TH/SV) after every locale edit.
- TH/SV translations authored, not left as EN fallback (TH mandatory).

## Rollout / branch

- New feature branch off `main` (current working branch is
  `settings-ux-invoice-reminders` — this is a separate concern). Suggested:
  `invoice-dialogs-ux-declutter`.
- Phased implementation (Tier 1 → 2 → 3) so each phase is independently
  reviewable and shippable; Tier 1 alone already resolves the original complaint.

## Open items for the plan

- Confirm `pay.cancel` / `issue.description` are truly dead before deletion.
- Decide identical-values vs shared-namespace for typed-confirm copy (3a) based on
  the true duplicate-site count.
- `event-draft` 409 body shape naming to match existing API conventions.
