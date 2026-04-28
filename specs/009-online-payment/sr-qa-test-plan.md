# F5 Online Payment — Manual Screen-Reader QA Test Plan

**Generated**: 2026-04-26 (R5 staff-review S005 closeout)
**Branch**: `009-online-payment` @ `d234bda`
**Purpose**: Step-by-step walkthrough script + automated a11y audit results so the maintainer's manual SR pass on PaySheet flow is reproducible, scoped, and ≤30 minutes wall-clock per platform.

This plan satisfies `security.md § 6` checklist item #14 and the
> "Manual SR pass on pay-sheet completed (post-critique E12+X5)"
requirement. Once executed, save results as
`specs/009-online-payment/sr-qa-{date}.md`.

---

## Part 1 — Automated a11y audit results (AI-verified, code-side)

| Surface                            | role / aria coverage                                                                         | Test reference                                                            |
|------------------------------------|---------------------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| `<PaySheet>` drawer container       | `role="dialog"` + `aria-labelledby="pay-sheet-title"` (Radix Sheet primitive)               | `pay-sheet/index.tsx:397` (data-testid `pay-sheet-content`)              |
| Drawer close button                 | `aria-label={t('close')}` localized EN/TH/SV; min-44px tap target                          | `pay-sheet/index.tsx:410` + i18n key `portal.payment.drawer.close`      |
| `<MethodTabs>` Card / PromptPay     | `role="tablist"` + each tab has localized `aria-label` "Card — switch payment method" / "PromptPay — switch payment method" (R4 WCAG 2.5.3 Label-in-Name fix) | `method-tabs.tsx:101` + i18n keys `cardAriaLabel` / `promptpayAriaLabel`  |
| `<CardForm>` submit button          | `data-testid="pay-sheet-card-submit"` + visible label "Pay {amount}" (localized)            | `card-form.tsx:242`                                                       |
| CardForm load-error alert            | `role="alert"` + retry button                                                               | `card-form.tsx:419, 432`                                                  |
| `<ConfirmationPanel>` success state  | `tabIndex={-1}` focus on mount + `aria-labelledby="pay-sheet-confirmation-title"`           | `confirmation-panel.tsx:68, 145`                                          |
| Auto-close countdown (visual)        | `aria-hidden="true"` (visual only)                                                          | `confirmation-panel.tsx:220`                                              |
| Auto-close countdown (SR)           | `aria-live="polite"` + multi-threshold cadence at remaining ∈ [3, 1] (R3 polish)           | `confirmation-panel.tsx:247` + `srMessage` const                           |
| Pause↔Resume button (WCAG 2.2.1)    | localized "Pause" / "Resume" + min-24px target + focus-ring                                | `confirmation-panel.tsx` + i18n `pauseAutoClose` / `resumeAutoClose`      |
| `<HardCapPrompt>` 30-min idle prompt | `role="alert"` + `aria-labelledby="pay-sheet-hard-cap-title"` (R4 I-10 alertdialog→alert)    | `hard-cap-prompt.tsx:65, 68`                                              |
| Reduced-motion fallback             | `motion-safe:animate-in motion-safe:zoom-in-50 motion-reduce:duration-0`                    | All animated elements (CheckCircle, drawer slide, skeleton shimmer)       |
| Stripe Elements iframe              | iframe `title` attribute set by Stripe SDK; we cannot control internals (PCI scope boundary — manual SR validates this) | js.stripe.com — outside Chamber-OS DOM                                    |

**Automated coverage gap**: `axe-core` cannot traverse the Stripe Elements iframe. **Manual SR is the only authoritative check** for the card-input experience inside the iframe. This is the load-bearing reason for this test plan.

---

## Part 2 — Manual SR walkthrough script

### Pre-requisites

- ✅ Local dev server running on `http://localhost:3100` (`pnpm dev`)
- ✅ Stripe CLI listening: `stripe listen --forward-to localhost:3100/api/webhooks/stripe`
- ✅ E2E member fixture seeded: `E2E_ISSUED_INVOICE_ID` set in `.env.local`
- ✅ Invoice reset to `issued` if previously paid: `pnpm tsx scripts/dev-purge-invoice-payments.ts $E2E_ISSUED_INVOICE_ID`

### Platforms to cover

Repeat the walkthrough on **at least 2 of 3**:

1. **NVDA on Windows** (Firefox or Chrome) — Thai/English desktop SR coverage.
2. **VoiceOver on macOS** (Safari) — Swedish/English desktop SR coverage.
3. **VoiceOver on iOS** (Safari) — mobile WCAG 2.2.1 (Pause) + 2.5.8 (Target Size) coverage.

### Walkthrough script (≈10 min per platform)

#### 1. Navigate + open drawer (US1 entry)

1. Sign in as the E2E member at `/portal/sign-in`.
2. Navigate to `/portal/invoices/${E2E_ISSUED_INVOICE_ID}`.
3. **Tab** through the page until focus reaches the **"Pay now"** button.
   - ✅ Expect: SR announces *"Pay now, button"* (or localized).
4. Press **Enter** to open the drawer.
   - ✅ Expect: SR announces *"Pay invoice, dialog"* (or localized "ชำระเงิน, กล่องโต้ตอบ" / "Betala faktura, dialogruta").
   - ✅ Focus should move into the drawer; Escape should close.

#### 2. Method tabs (FR-027 + R4 WCAG 2.5.3)

1. **Tab** to the Card / PromptPay tabs.
2. ✅ Expect: SR announces *"Card — switch payment method, tab, selected"* (NOT just "Card" — the aria-label includes intent so the tab purpose is clear without context).
3. **Right-arrow** to PromptPay.
4. ✅ Expect: SR announces *"PromptPay — switch payment method, tab"*.
5. **Right-arrow** back to Card.

#### 3. Card form interaction (PCI surface — manual is authoritative)

1. **Tab** into the Stripe Elements iframe.
2. ✅ Expect: focus enters the iframe; SR announces the field labels Stripe provides (typically *"Card number, edit"* etc.).
3. Type test card `4242 4242 4242 4242`, expiry `12/27`, CVC `424`, postal `10110`.
4. ✅ Expect: SR announces invalid-card states if you intentionally mistype (e.g. `1234`).
5. **Tab** out of the iframe to the **"Pay {amount}"** submit button.
6. ✅ Expect: SR announces *"Pay 5,350.00 THB, button"*.
7. Press **Enter**.

#### 4. Processing → Success transition (FR-028e + Pause/Resume)

1. ✅ Expect: SR announces *"Processing payment..."* during the brief processing state (`role="status"` aria-live).
2. After Stripe resolves, ✅ Expect: SR announces *"Payment received, heading"* (the ConfirmationPanel mounts focus on `<section tabIndex=-1 aria-labelledby="pay-sheet-confirmation-title">`).
3. **Tab** to the **"Download receipt"** button.
4. ✅ Expect: SR announces *"Download receipt, button"* (or localized).
5. **Tab** to the **"Close"** link below.
6. ✅ Expect: SR announces *"Close, link"* (it's a text-link styled button).
7. **Tab** to the **"Pause"** button.
8. ✅ Expect: SR announces *"Pause, button"*. Focus visible (focus ring).
9. Press **Enter**.
10. ✅ Expect: SR announces *"Auto-close paused"* (live region) AND the button's testid + label flips to *"Resume"* (R5 S008). Press Tab again — button should still be reachable + announce as *"Resume"*.
11. Press **Enter** on Resume.
12. ✅ Expect: countdown resumes; at remaining ∈ {3, 1} the SR live region fires *"Closing in 3 seconds"* / *"Closing in 1 second"* (multi-threshold cadence).

#### 5. Reduced-motion fallback (FR-028g)

1. Enable system **Reduce Motion** (Windows: Settings → Ease of Access → Display → "Show animations"; macOS: System Settings → Accessibility → Display → Reduce motion; iOS: Settings → Accessibility → Motion).
2. Re-open the drawer.
3. ✅ Expect: drawer slide-in collapses to instant fade (per `motion-reduce:duration-0`); CheckCircle scale-in is instant; skeleton shimmer is a static pulse.

#### 6. 30-minute hard-cap prompt (FR-028c)

(Optional — slow path; skip if time-pressed and confirm later via integration log.)

1. Open drawer; leave it open for 30 minutes (or temporarily monkey-patch `PAY_SHEET_HARD_CAP_MS` for testing).
2. ✅ Expect: `<HardCapPrompt>` mounts; SR announces *"Are you still here? alert"* (R4 demoted from alertdialog to alert per nested-modality concern).
3. Continue / Cancel buttons reachable via Tab; Continue re-arms the timer.

---

## Part 3 — Pass / fail criteria

Record results in a **per-platform** table in your `sr-qa-{date}.md` output:

| Step | Platform 1 (e.g. NVDA) | Platform 2 (e.g. VoiceOver) |
|------|------------------------|------------------------------|
| 1 — Pay-now button reachable + announced | ✅ / ❌ | ✅ / ❌ |
| 2 — Method tabs label-in-name correct | ✅ / ❌ | ✅ / ❌ |
| 3 — Stripe iframe field announcements | ✅ / ❌ | ✅ / ❌ |
| 4 — Confirmation focus + Pause/Resume + countdown live region | ✅ / ❌ | ✅ / ❌ |
| 5 — Reduced-motion fallback | ✅ / ❌ | ✅ / ❌ |
| 6 — Hard-cap prompt (optional) | ✅ / ❌ / SKIP | ✅ / ❌ / SKIP |

**Pass threshold**: ≥ 5/6 steps pass on ≥ 2 platforms. Any failure must be triaged before the SAQ-A § 5 signature.

---

## Part 4 — Quick capture template

Copy-paste this into `specs/009-online-payment/sr-qa-{date}.md` and fill in:

```markdown
# F5 SR-QA Pass — {date}

**Tester**: {name}
**Branch**: 009-online-payment @ {hash}
**Platforms**: NVDA-Windows-Firefox + VoiceOver-iOS-Safari

## Results

| Step | NVDA | VoiceOver iOS | Notes |
|------|------|---------------|-------|
| 1    | ✅   | ✅            |       |
| 2    | ✅   | ✅            |       |
| 3    | ✅   | ✅            |       |
| 4    | ✅   | ✅            |       |
| 5    | ✅   | ✅            |       |
| 6    | SKIP | SKIP          | Hard-cap deferred to integration test  |

**Verdict**: ✅ PASS / ❌ FAIL

## Screenshots / clip
- {link or file path}

## Sign-off
Tested by: ____________________
Date: ____________________
```

---

*Generated as the R5 S005 closeout artefact. The plan is a stand-in for the manual SR walkthrough — it does not replace the human pass, but it makes the pass reproducible + scoped + ≤30 min.*
