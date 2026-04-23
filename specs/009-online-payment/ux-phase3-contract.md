# F5 Phase 3 — UX Contract (Stripe Elements + PromptPay QR)

**Status**: LOCKED before any Phase 3 route handler or component code lands.
**Authority**: Staff review R003 (2026-04-23) — Review-Gate blocker for Phase 3.
**Parents**: `spec.md` FR-025, FR-028 (a–j); `docs/ux-standards.md` §§ 2.1, 2.3, 2.4, 4.2, 5.1, 7, 8.2, 10.1.
**Consumers**: every T041+ task under Phase 3 MUST reference this file; divergence requires a Complexity Tracking entry on `plan.md` and maintainer sign-off.

---

## 1. Scope

This contract locks three UX decisions that historically drifted between spec prose and component code:

| ID | Decision | Source |
|----|----------|--------|
| C-A | Stripe `<PaymentElement>` SHALL be wrapped in a shimmer skeleton until Stripe's `ready` event fires. | `docs/ux-standards.md` § 2.1, 2.3; FR-028(f) |
| C-B | PromptPay QR countdown SHALL announce via `aria-live="polite"` + surface a **Refresh QR** toast at T-2 min. | FR-028(j); `docs/ux-standards.md` § 5.1, 10.1 |
| C-C | i18n keys `portal.payment.{success,retry,qrExpiring}` SHALL exist in EN (canonical) + TH + SV before any T041+ component imports them. | FR-023, FR-028(e), `pnpm check:i18n` |

No other pay-sheet behaviour is re-specified here — FR-028 (a–j) remains authoritative.

---

## 2. C-A — Stripe Elements shimmer contract

### 2.1 State machine

```text
  Sheet open
  ┌──────────────────────────┐
  │  skeleton (mandatory)    │  aria-busy="true"
  │  min 300 ms displayed    │  (ux-standards § 2.3)
  └──────────┬───────────────┘
             │  Stripe `<PaymentElement onReady>` fires
             ▼
  ┌──────────────────────────┐
  │  PaymentElement visible  │  aria-busy="false"
  └──────────────────────────┘
```

### 2.2 Implementation rules

1. **Skeleton component**: MUST use `<Skeleton>` from `@/components/ui/skeleton` — do NOT fork. Motion-reduce fallback is handled inside the primitive by the `.skeleton-shimmer` CSS class (`src/app/globals.css`) via `@media (prefers-reduced-motion: reduce)` — DO NOT add a redundant Tailwind `motion-reduce:animate-pulse` utility on the wrapper.
2. **Shape fidelity** (CLS = 0): skeleton layout MUST match the real `<PaymentElement>` — 3 rectangular rows (card number ~48 px; expiry+CVC half-width pair ~48 px; zip/country ~48 px) + 1 button rect ~40 px, matching the `<Elements>` `appearance.variables.borderRadius` token. Verified by a visual-regression Playwright snapshot in T046.
3. **Minimum display duration**: 300 ms from Sheet open, even if `ready` fires sooner. Use a `useMinDelay(300)` hook — **this hook does NOT exist yet in the codebase** (verified 2026-04-23). T073 (SheetSkeleton) MUST create it at `src/hooks/use-min-delay.ts` with a RED-first unit test at `tests/unit/hooks/use-min-delay.test.ts` per Constitution Principle II before wiring it into the skeleton wrapper. Signature: `useMinDelay(ms: number, ready: boolean): boolean` — returns `true` only when both `ready === true` AND `ms` has elapsed since mount.
4. **Ready signal**: rely on the official Stripe callback — `<PaymentElement onReady={() => setElementReady(true)} />`. Do NOT poll, do NOT use timeouts as a proxy for readiness.
5. **Failure fallback**: if `<PaymentElement>` dispatches `loaderror` (network / SDK blocked), replace the skeleton with the error-state card per `docs/ux-standards.md` § 4.3 using i18n key `portal.payment.error.elementLoadFailed` (add alongside C-C keys if absent at implementation time).
6. **ARIA-busy contract**: the skeleton container MUST carry `aria-busy="true"` + `role="status"` so screen readers announce progress. Flip to `aria-busy="false"` once the element is ready.
7. **Test hook**: the skeleton container MUST carry `data-testid="pay-sheet-card-skeleton"`; required for Playwright T046 + visual-regression.

### 2.3 Anti-patterns (MUST NOT)

- Rendering `<PaymentElement>` without a skeleton wrapper — bare Stripe iframe causes visible layout shift when SDK bootstraps (~250–700 ms on typical Thai broadband).
- Using a plain spinner instead of the shimmer — violates `docs/ux-standards.md` § 2.2 (spinners are reserved for button-submit state).
- Replacing skeleton before 300 ms minimum — causes the "flash of skeleton" on fast connections (§ 2.3).

---

## 3. C-B — PromptPay QR countdown + Refresh toast contract

### 3.1 Countdown region

- Location: directly beneath the QR image, inside the PromptPay tab of the Sheet.
- Markup: `<div role="status" aria-live="polite" aria-atomic="true">{countdownText}</div>`.
- Copy (bilingual, announced once per minute boundary — not once per tick):
  - EN: `"QR expires in {minutes} min {seconds} s"` on the last minute only → `"QR expires in {seconds} s"`.
  - TH: `"QR หมดอายุใน {minutes} นาที {seconds} วินาที"` → last minute `"QR หมดอายุใน {seconds} วินาที"`.
  - SV: `"QR-koden förfaller om {minutes} min {seconds} s"` → last minute `"QR-koden förfaller om {seconds} s"`.
- Visual tick cadence: 1 Hz. SR announcement cadence: **throttle to at most one aria-live update per 60 s** (prevents SR flood) — the visual digit continues to tick silently via a second node with `aria-hidden="true"`.

### 3.2 T-2 min refresh toast

- Trigger: exactly once when `remainingSeconds === 120`.
- Surface: `sonner.info` toast (non-blocking) with action button.
- Copy keys: `portal.payment.qrExpiring` (see § 4).
- Action: clicking "Refresh QR" MUST cancel the current PaymentIntent (per FR-028d "no stale intents") and issue a fresh `POST /api/payments/initiate` — same endpoint, same idempotency key bumped (`inv-{invoice_id}-attempt-{seq+1}`).
- Dismiss: auto-dismiss after 10 s; re-emits at T-30 s if still not refreshed.
- Motion-reduce: toast slide is replaced with fade-only per `docs/ux-standards.md` § 10.1.

### 3.3 Expiry transition

- At `remainingSeconds === 0` the QR panel swaps to the "QR expired — Regenerate" empty-state card (FR-025 parity). The aria-live region emits the localised `portal.payment.qrExpired` string once, then stops.

### 3.4 Anti-patterns (MUST NOT)

- `aria-live="assertive"` — violates FR-028(j) (must be polite).
- Announcing every second — floods SR users; 60 s throttle is the contract.
- Client-only countdown without server-side expiry validation — the webhook + reconciliation ledger is the source of truth; the countdown is display-only.
- Silently regenerating the QR without canceling the old PaymentIntent — creates orphan pending rows that break `payments.stale_pending_count` gauge.

---

## 4. C-C — i18n key contract

These keys MUST be added to **all three locales** (EN canonical, TH, SV) in `src/i18n/messages/{en,th,sv}.json` under the existing `portal.payment` namespace before any T041+ component imports them. `pnpm check:i18n` enforces coverage on release branches.

### 4.1 Key list + English canonical copy

| Key | English (canonical) | Purpose |
|-----|---------------------|---------|
| `portal.payment.success.title` | `"Payment received"` | Confirmation panel title (FR-028e) |
| `portal.payment.success.summaryCard` | `"Paid {amount} via card ending ****{last4} on {dateTime}"` | Confirmation panel summary — card rail |
| `portal.payment.success.summaryPromptPay` | `"Paid {amount} via PromptPay on {dateTime}"` | Confirmation panel summary — PromptPay rail |
| `portal.payment.success.downloadReceipt` | `"Download receipt"` | Primary CTA on confirmation panel |
| `portal.payment.success.autoCloseCountdown` | `"Closing in {seconds} s"` | 5 s auto-dismiss hint (FR-028e) |
| `portal.payment.success.toast` | `"Payment received. Receipt emailed to you."` | `sonner.success` body (FR-028e) |
| `portal.payment.retry.title` | `"Payment failed"` | Failed-state panel title (FR-028j) |
| `portal.payment.retry.body` | `"{reason} Please try again or choose a different payment method."` | Failed-state body; `{reason}` is populated from the decline-reason sub-catalogue at `src/i18n/messages/{locale}/payment-decline-reasons.json` |
| `portal.payment.retry.cta` | `"Try again"` | Primary CTA on failed-state panel |
| `portal.payment.retry.alternativeMethod` | `"Use another method"` | Secondary CTA — switches tab back to method picker |
| `portal.payment.qrExpiring.title` | `"QR expiring soon"` | T-2 min refresh-toast title |
| `portal.payment.qrExpiring.body` | `"Your PromptPay QR will expire in 2 minutes. Refresh to get a fresh code if you need more time."` | T-2 min refresh-toast body |
| `portal.payment.qrExpiring.action` | `"Refresh QR"` | T-2 min refresh-toast action button |
| `portal.payment.qrExpired` | `"QR code expired. Generate a new one to continue."` | Zero-second expiry aria-live announcement + panel copy (§ 3.3) |

### 4.2 Thai translation guidance (authoritative copy added in T083; preview here)

| Key | Thai |
|-----|------|
| `portal.payment.success.title` | `"ชำระเงินสำเร็จ"` |
| `portal.payment.success.summaryCard` | `"ชำระ {amount} ด้วยบัตรลงท้าย ****{last4} เมื่อ {dateTime}"` |
| `portal.payment.success.summaryPromptPay` | `"ชำระ {amount} ด้วย PromptPay เมื่อ {dateTime}"` |
| `portal.payment.success.downloadReceipt` | `"ดาวน์โหลดใบเสร็จ"` |
| `portal.payment.success.autoCloseCountdown` | `"กำลังปิดใน {seconds} วินาที"` |
| `portal.payment.success.toast` | `"รับชำระเงินแล้ว เราจะส่งใบเสร็จไปที่อีเมลของคุณ"` |
| `portal.payment.retry.title` | `"ชำระเงินไม่สำเร็จ"` |
| `portal.payment.retry.body` | `"{reason} กรุณาลองใหม่อีกครั้ง หรือเลือกวิธีชำระเงินอื่น"` |
| `portal.payment.retry.cta` | `"ลองอีกครั้ง"` |
| `portal.payment.retry.alternativeMethod` | `"ใช้วิธีชำระเงินอื่น"` |
| `portal.payment.qrExpiring.title` | `"QR ใกล้หมดอายุ"` |
| `portal.payment.qrExpiring.body` | `"QR PromptPay จะหมดอายุในอีก 2 นาที กด ‘สร้าง QR ใหม่’ หากต้องการเวลาเพิ่ม"` |
| `portal.payment.qrExpiring.action` | `"สร้าง QR ใหม่"` |
| `portal.payment.qrExpired` | `"QR หมดอายุแล้ว กรุณาสร้างรหัสใหม่เพื่อดำเนินการต่อ"` |

### 4.3 Swedish translation guidance (authoritative copy added in T083; preview here)

| Key | Swedish |
|-----|---------|
| `portal.payment.success.title` | `"Betalningen mottagen"` |
| `portal.payment.success.summaryCard` | `"Betalt {amount} med kort som slutar på ****{last4} den {dateTime}"` |
| `portal.payment.success.summaryPromptPay` | `"Betalt {amount} via PromptPay den {dateTime}"` |
| `portal.payment.success.downloadReceipt` | `"Ladda ner kvitto"` |
| `portal.payment.success.autoCloseCountdown` | `"Stänger om {seconds} s"` |
| `portal.payment.success.toast` | `"Betalningen mottagen. Kvittot har skickats till din e-post."` |
| `portal.payment.retry.title` | `"Betalningen misslyckades"` |
| `portal.payment.retry.body` | `"{reason} Försök igen eller välj en annan betalningsmetod."` |
| `portal.payment.retry.cta` | `"Försök igen"` |
| `portal.payment.retry.alternativeMethod` | `"Använd en annan metod"` |
| `portal.payment.qrExpiring.title` | `"QR-koden förfaller snart"` |
| `portal.payment.qrExpiring.body` | `"Din PromptPay-QR förfaller om 2 minuter. Uppdatera för en ny kod om du behöver mer tid."` |
| `portal.payment.qrExpiring.action` | `"Uppdatera QR"` |
| `portal.payment.qrExpired` | `"QR-koden har förfallit. Skapa en ny för att fortsätta."` |

### 4.4 Interpolation contract

- `{amount}`: formatted via the existing F4 `formatThbAmount()` helper — includes currency symbol + thousands separator per locale.
- `{dateTime}`: formatted via `@js-joda` + `Asia/Bangkok` — Thai localisation uses Buddhist Era display (consistent with F4). Never store BE; only render.
- `{last4}`: always displayed preceded by four visible asterisks `****`; never unmasked.
- `{reason}`: resolved from `payment-decline-reasons.json` sub-catalogue; fall-through to `portal.payment.retry.genericReason` on unknown codes.
- `{minutes}`, `{seconds}`: integers; SR-throttling per § 3.1 applies to the rendered string, not to the interpolation itself.

---

## 5. Downstream task references

| Task | Consumes contract |
|------|-------------------|
| T041 (contract test — initiate endpoint) | C-C key names for success path shape |
| T042 (contract test — webhook) | None (server-side) |
| T046 (E2E happy path) | `data-testid="pay-sheet-card-skeleton"` (§ 2.2 rule 7) + aria-live throttle assertion |
| T073 (SheetSkeleton component) | C-A § 2.1 layout contract |
| T076 (card-form.tsx) | C-A `ready` signal + `useMinDelay(300)` hook |
| T077 (processing-panel) + T078 (3DS panel) | Inherit `role="status"` aria-live contract from § 3.1 |
| T079 (confirmation-panel) | C-C `portal.payment.success.*` keys |
| T083 (i18n keys) | § 4.1, 4.2, 4.3 copy — authoritative |
| Phase 4 PromptPay QR panel (T087+) | C-B end-to-end |

---

## 6. Out of scope (this document)

- Admin refund-dialog UX — see FR-029, separate contract surface.
- Offline-payment empty-state card — see FR-030 + T082.
- Idle-warning pause/resume — FR-028(c); the component contract is frozen and owned by T080.
- Webhook + server-side state transitions — authoritative in `contracts/stripe-webhook.md`.

---

## 7. Change control

Any edit to §§ 2–4 after this file is merged requires:
1. A Complexity Tracking entry on `plan.md`;
2. Maintainer co-sign (solo-maintainer substitute acceptable per Constitution v1.4.0 Principle IX);
3. `pnpm check:i18n` + `pnpm check:audit-events` both GREEN on the amending PR.

Contract locked: 2026-04-23 — staff review R003 resolution (see `specs/009-online-payment/reviews/review-20260423-211654.md`).
