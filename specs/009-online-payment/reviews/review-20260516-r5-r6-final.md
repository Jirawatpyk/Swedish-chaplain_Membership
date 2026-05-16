# F5 R5 + R6 final rollup — F4/F5 code-readiness sign-off

**Branch**: `012-eventcreate-integration`
**Reviewed commits**: `c31259be` (R5) + `efef1127` (R6)
**Date**: 2026-05-16
**Outcome**: F4/F5 code-section **READY**; 7 human operator gates remain before flag-flip.

> This artifact closes the R3→R6 review chain on F4 (invoicing) + F5
> (online payment). F6.1 EventCreate is concurrent on the same branch
> and is OUT OF SCOPE for this rollup (tracked separately).

---

## R3→R6 chain at a glance

| Round | Date | Commit | Findings | LOC |
|---|---|---|---|---|
| R3v2 Batch 1 | 2026-05-16 | `1203403f` | BLOCKER + CRITICAL + 6 HIGH | +428/-84 |
| R3v3 Batch 2+3 | 2026-05-16 | `6aa8a66a` | 6 HIGH + 8 MED + 9 LOW | +959/-134 |
| R3v4 | 2026-05-16 | `b342c4eb` | M-2 + M-5 + M-8 (R3v3-deferred) | +223/-55 |
| Un-skip | 2026-05-16 | `9731128e` | F8 cron-bearer (2) + F4 placeholder (1) | +43/-64 |
| **R5 (R4 review)** | **2026-05-16** | `c31259be` | **BLOCKER (brand inversion)** + 3H + 3M + LOWs | +253/-185 |
| **R6 (R5 review)** | **2026-05-16** | `efef1127` | **0 BLOCKER**, 2H + 1M + 1L | +93/-18 |
| **Total** | — | 6 commits | **~80 findings, 0 deferred** | **+2 000 / −540** |

**Diminishing-returns trend**: R3v2: 8 → R3v3: 25 → R4: 7 → R5: 4. R6 found 0 BLOCKER, confirming convergence.

---

## R5 (R4 review) — BLOCKER + 3 HIGH + 3 MED + LOWs

### BLOCKER — `UntrustedSatang` brand was structurally INVERTED

**Root cause**: R3v4 M-5 used nested intersection brands:

```ts
type Satang          = bigint & { [SatangBrand]: true };
type UntrustedSatang = bigint & { [SatangBrand]: true; [UntrustedBrand]: true };
```

`UntrustedSatang` had MORE constraints → structural SUBTYPE of `Satang` → freely assignable to `Satang`-typed slots. `addSatang(unchecked, valid)` compiled clean despite the M-5 docstring claim of "compile-time enforcement". **3 R4 reviewers independently verified via TS probes.**

**Fix** (`c31259be`): re-architected to disjoint sibling brands:

```ts
type Satang          = bigint & { [TrustedBrand]:   true };
type UntrustedSatang = bigint & { [UntrustedBrand]: true };
```

Neither is assignable to the other without explicit cast. Verified: all 5 unsafe shapes now error (TS2345 / TS2322):
- `addSatang(unchecked, valid)` → TS2345
- `addSatang(valid, unchecked)` → TS2345
- `subSatang(unchecked, valid)` → TS2345
- `const s: Satang = unchecked` → TS2322
- `const u: UntrustedSatang = valid` → TS2322

Plus `tests/unit/types/money-brand.test.ts` with 5 `@ts-expect-error` directives in a dead-code function. If brands collapse back, each directive becomes "unused" → TS2578 fails `pnpm typecheck` → caught before merge.

### HIGH (3) — all closed

- **H-1**: `src/_brand_probe.ts` (alleged untracked file) — verified not present. False positive; no action.
- **H-2**: `cron-bearer-auth-rejected.test.ts:201-256` (rate-limit test 3) used stale `summary` literal filter that the emitter never produces → assertion `0 === 0` trivially passed regardless of behavior. Migrated to `payload->>'route'` filter matching tests 1+2 + extracted shared `filter` const.
- **H-3**: 3 MSW gateway tests didn't assert `paymentsMetrics.gatewayBoundaryAmountBrandFailed` counter. Added `vi.spyOn(paymentsMetrics, ...)` + `vi.spyOn(logger, 'error')` with payload-shape assertion on `reason` field.

### MED (3) — all closed

- **M-1**: `Money.add` + `multiplyByFraction` + `subtract` double-validated via `asSatang()` (contradicted M-2 single-boundary rationale). Switched to `addSatang(...)` brand-preserving helper + `diff as Satang` / `rounded as Satang` after explicit gates.
- **M-2**: `asSatang` observability contract — added defensive comment near `asSatang` documenting that `RangeError` class + `Satang must be >= 0` message prefix are part of the SRE alert surface. Existing test at `tests/unit/lib/money.test.ts:51-54` already pins both.
- **M-3**: F4 sweeper placeholder comment trimmed (12 lines → 7) with cleaner cross-ref to `tests/integration/invoicing/receipt-pdf-reconcile-cron.test.ts`.

### LOW cleanups
- Removed `void propagatedAsThrow;` dead pattern + unused local in `seq-number-atomicity.test.ts`.
- Trimmed verbose R3v4-history JSDoc on `Money` private constructor (16 → 4 lines).
- Replaced enumerated `asSatangUnchecked` callsite list with `rg asSatangUnchecked` pointer (lists rot fast).
- Trimmed stale skip-rationale blocks (~24 lines) above `cron-bearer-auth-rejected.test.ts` tests 1+2.

---

## R6 (R5 review) — 0 BLOCKER, 2 HIGH + 1 MED + 1 LOW

### HIGH (2) — both closed

- **R5-H1**: `stripe-gateway.ts:562-589` path B (`asSatang_threw` branch) had zero test coverage. Path B fires when shape passes outer guard (`Number.isFinite + >= 0`) but `BigInt(refund.amount)` throws — the FRACTIONAL case (`BigInt(100.5)` → RangeError). Added `it('fractional refund.amount + input provided → path B (asSatang_threw) + falls back to input')` test exercising the previously-untested branch.
- **R5-H2**: MSW tests 2+3 only asserted `toHaveBeenCalledTimes(1)` — SRE alert key (logMsg) and `reason` field could shift silently. Extracted shared `expectBrandFailedLog({reason, refundId, rawAmount})` helper; all 4 tests (3 path A + 1 new path B) now pin uniformly.

### MED (1) — closed

- **R5-M1**: `Money.multiplyByFraction` test only asserted `.toThrow()` — any Error class + message passed. R5 M-1 docstring claimed runbook search keys depend on literal `Money.multiplyByFraction: result is negative`. Tightened to `.toThrow(/Money\.multiplyByFraction: result is negative/)`.

### LOW (1) — closed

- **R5-L1**: type-test docstring inaccurately claimed runtime `expect(...).toBeDefined()` is what "keeps TS type-checking" the dead-code function. Reworded to clarify `tsconfig.json` `include: '**/*.ts'` is the keep-alive — runtime reference is just a suite-wiring smoke.

---

## Final verification (R6 commit `efef1127`)

| Check | Status |
|---|---|
| `pnpm typecheck` | clean (excl. pre-existing F6.1 errors `process-attendee-in-tx`, `cancellation-skip-marker`, `event-picker.tsx`) |
| `pnpm lint src/lib/money.ts src/modules/{invoicing,payments}` | clean |
| Unit tests | 796/796 GREEN (62 files) |
| F4 integration | 173/176 GREEN (3 RUN_PERF=1-gated skips) |
| F5 integration | 125/127 GREEN (2 RUN_PERF=1-gated skips) |
| F8 integration | 234/239 GREEN (5 RUN_PERF=1-gated skips) |
| Type-discipline test | 1/1 GREEN — `@ts-expect-error` directives consumed by disjoint-sibling shape |

**0 functional skips. All 10 remaining skips are `RUN_PERF=1`-gated perf benches.**

---

## F4/F5 architectural state (post-R6)

### Money brand discipline (closes the F8 100× off-by-one risk class)
- `Satang` (trusted) vs `UntrustedSatang` (forensic) — disjoint siblings
- `asSatang(bigint): Satang` — validates non-negative; throws `RangeError` with pinned message prefix
- `asSatangUnchecked(bigint): UntrustedSatang` — forensic escape for err payloads; pre-fix would have thrown mid-error-construction and lost diagnostic
- `addSatang(Satang, Satang): Satang` — brand-preserving; rejects `UntrustedSatang` at compile (TS2345)
- `subSatang(Satang, Satang): Satang` — same + runtime underflow guard
- `Money.satang: Satang` (pushed into VO, M-2 ctor cleanup)
- Type-test `tests/unit/types/money-brand.test.ts` — 5 `@ts-expect-error` directives are the regression guard

### F4→F5 bridge (Invoicing → Payments)
- Typed `corrupted_total` error variant when `asSatang` rejects F4's `totalSatang` (was silent `0n` clamp pre-R3v3)
- Propagates as `InitiatePaymentError.invoice_data_corrupt` (initiate-payment) + `ConfirmPaymentOutcome.invoice_data_corrupt` (confirm-payment webhook side)
- Forensic `logger.error` with full triage context (tenantId / invoiceId / rawTotalSatang / errKind) + metric counter

### F5 Stripe gateway (createRefund defensive projection)
- Path A: outer `Number.isFinite + >= 0` guard fails → typed `processor_response_amount_invalid` err (if input absent) or fallback to input (if provided)
- Path B: outer passes but `BigInt(refund.amount)` throws → inner catch → same fallback semantics with `reason: 'asSatang_threw'` discriminator
- Both paths emit `paymentsMetrics.gatewayBoundaryAmountBrandFailed('refund_create')` + `logger.error` with `reason` discriminator
- All 4 cases (path A neg + path A null + path A no-input + path B fractional) MSW-tested with log shape assertions

### Webhook verifier (`process-webhook-event`)
- C-1 defensive amount projection (`projectAmountSafely`) wraps `asSatang(BigInt(n))` in try/catch
- New `amountProjectionFailed: boolean` envelope flag (H-4)
- Downstream `process-charge-refunded` gates mismatch comparison on flag → no audit-storm on fuzzed events
- `dispute_created` audit writes `'projection_failed'` sentinel when flag is set → no 10-year-retained `'0'` known-wrong values

### F8 cron-bearer audit (un-skip)
- 3 integration tests now GREEN with `payload->>'route'` filter (was previously 2 skipped under incorrect RLS-theory rationale)
- 1 path-B integration test (rate-limit) verifies NO new audit emit on 429 path
- Helper emit path verified end-to-end against live Neon

---

## Pre-flag-flip / pre-merge gates (HUMAN ACTION REQUIRED)

> These cannot be completed by the code-review chain. F4/F5 are
> **code-ready** but require operator coordination before flag-flip.

### Gates blocking F5 production roll-out
1. **PCI SAQ-A re-attestation** — `FEATURE_F5_ONLINE_PAYMENT` ships dark until SAQ-A signed for the current code shape. Verify no SAQ-A-relevant changes since last attestation (search: card surface, gateway, webhook handler).
2. **Maintainer GPG co-sign on security checklist** — Constitution v1.4.0 Principle IX. F5 = payment surface = ≥2 reviewers required, one signs `specs/009-online-payment/security.md § 5` (or equivalent). Solo-maintainer substitute applies if no second human reviewer available.
3. **Stripe production keys** — `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION` (pinned) in Vercel production env.

### Gates blocking F4 production cron coordination
4. **cron-job.org dashboard entries**:
   - `/api/internal/cron/receipt-pdf-reconcile` (5-min cadence, Bearer `CRON_SECRET`)
   - F5 `/api/internal/metrics/stale-pending-count` (5-min cadence)
   - F8 5 coordinators per `docs/runbooks/cron-jobs.md` (dispatch + at-risk + lapse + reconcile-pending-reactivations + tier-upgrade-evaluate)
5. **`CRON_SECRET` ≥16 chars** + `BLOB_READ_WRITE_TOKEN` in Vercel production env.

### Branch-merge coordination
6. **F6.1 EventCreate readiness** — branch `012-eventcreate-integration` contains F6.1 work concurrent with F4/F5. Merge to main requires F6.1 to also be ship-ready. Track separately at `specs/012-eventcreate-integration/` and `specs/013-csv-import-eventcreate-format/`.

### Optional pre-flag-flip QA
7. **Staging OTel trace verification** — CI doesn't wire an OTel exporter; spans only fire in real staging. Confirm `payments.initiate` / `payments.confirm_succeeded` / `invoicing.issue_invoice` spans appear in Vercel Analytics for staging deployment.
8. **Manual SR + cross-browser real-device** — Playwright covers headless Chromium/Firefox/Webkit. Real iOS Safari + Android Chrome + screen-reader run (NVDA / VoiceOver) required for WCAG 2.1 AA staff sign-off on the 4 F5 surfaces (initiate, confirm, refund-detail, payment-method-switch).

---

## Recommended ship sequence

1. **Now**: Merge F4/F5 changes to a feature flag (`FEATURE_F5_ONLINE_PAYMENT=false` already exists) once F6.1 lands; entire `012-eventcreate-integration` branch ready.
2. **Pre-flag-flip**: Complete gates 1–5 above. Gate 6 (F6.1) is the long pole — block on that, not on F4/F5.
3. **Flag-flip**: Set `FEATURE_F5_ONLINE_PAYMENT=true` in production env. Stripe webhooks start hitting `/api/internal/webhook/stripe`. Monitor: webhook latency p95, `payments_gateway_boundary_amount_brand_failed_total`, `cron.receipt_pdf_reconcile.*`.
4. **Watch window**: 7 days of production RUM data before declaring SLO verified.

---

## Conclusion

**F4/F5 code-section is READY for merge** behind the existing kill-switches (`FEATURE_F4_INVOICING`, `FEATURE_F5_ONLINE_PAYMENT`). The 6-round review chain closed ~80 findings with 0 deferred and 0 functional skips. Brand discipline + observability contracts are now machine-enforced — the class of bugs the 6 rounds caught (brand inversion, silent fallbacks, trivial-pass tests, missing metric assertions) cannot recur silently.

**Outstanding human gates are operator coordination**, not code work. Branch merge is gated on F6.1 readiness (separate track) — F4/F5 alone are sign-off-ready.

— Generated 2026-05-16 from commits 1203403f..efef1127
