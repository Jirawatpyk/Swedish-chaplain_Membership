# Staff Review Report: F7 — R8 (verify R7)

**Reviewer**: 5 specialist agents (`/speckit-staff-review-run`)
**Date**: 2026-05-03
**Branch**: `010-email-broadcast-phase-8` HEAD `e0d7bf6` (R7 fixes)
**Verdict**: ⚠️ **APPROVED WITH CONDITIONS** — no Blocker/HIGH; small carry-forward gaps from R7 partial closures.

## R7 Verification — 23 fixes verified

| Pass | Verified | Issues found |
|------|----------|--------------|
| 1 Reliability | HIGH-1 ✅, MED-R1 ✅, MED-R2 ✅, MED-S3 ✅, MED-S5 ✅, LOW-D/F/G/P1 ✅ | 2 MED (naming/pattern), 2 Nits |
| 2 Security | MED-S1/S2/S4/S5 ✅, LOW-E/G ✅ | 2 LOW (R8-01 body diff, R8-02 POST mirror) |
| 3 Performance | LOW-P1 ✅, LOW-A ✅, LOW-B ✅, LOW-F ✅ | 0 (PASS) |
| 4 Spec | MED-1 partial, LOW-C ✅, LOW-S1 ✅, count assertion 43 ✅ | 3 FAIL (carry-forward) |
| 5 Test | All R7 test additions placed correctly | 2 MED + 1 LOW (incomplete fixes) |

## Findings (8 actionable)

| ID | Sev | File:Line | Defect | Fix |
|----|-----|-----------|--------|-----|
| R8-A1 | 🟡 | `specs/010-email-broadcast/plan.md:15` | scope-header still says "37 named audit events"; should be 43 | Update count + reference data-model.md § 5 |
| R8-A2 | 🟡 | `audit-port.ts:152` | comment "all 41 event types" stale (should be 43) | 41 → 43 |
| R8-A3 | 🟡 | `src/modules/broadcasts/index.ts` | `UnverifiedTenantSlug` brand not re-exported from barrel — caller must reach into `infrastructure/` (Principle III violation) | Add `export type { UnverifiedTenantSlug }` |
| R8-T1 | 🟡 | `submit-broadcast.test.ts:549` | MED-T3 still uses `if (!result.ok)` conditional; doesn't pin `result.ok===true` directly | Replace with `expect(result.ok).toBe(true)` (use audit-emit-only assertion otherwise — narrower contract) |
| R8-T2 | 🟡 | `dispatch-scheduled-broadcast.test.ts:1853` | HIGH-3 comment promises "two events together" pin but only asserts `preSendAudit`; missing `broadcast_failed_to_dispatch` assertion | Add second `expect(audit.emits.find(e => e.eventType === 'broadcast_failed_to_dispatch')).toBeDefined()` |
| R8-T3 | 🟢 | `logger-redact.test.ts` depth-2 it.each | 2 cases miss `.not.toContain(secret)` negative assertion | Add negative side per case |
| R8-S1 | 🟢 | webhook route 200-ack body `{received:true, ignored:'unknown_event_type'}` | Differs from normal 200 body — info-disclosure to attacker who already has signing secret (low impact) | Return identical `{received:true}` body; log distinguishing info |
| R8-S2 | 🟢 | `lockout-cleanup/route.ts` `export const POST = GET` | Auth gate present on both; risk = operational (CSRF requires secret) | Comment intent or drop POST |

Plus 2 nits from Pass 1: hmac-signer.ts:165 `unsafeBrandTenantSlug` confusing-name comment; process-webhook-event.ts logger.error pattern inconsistency (line 602 narrow object, lines 720+773 string only).

## Recommended Actions

**Should fix (gating):**
1. R8-A1, R8-A2, R8-A3 — 3 small doc/barrel fixes (≤ 5 min)
2. R8-T1, R8-T2 — 2 incomplete-test-fix completions (≤ 10 min)

**Nice-to-fix:**
3. R8-T3, R8-S1, R8-S2 — pure polish

## Verdict

**⚠️ APPROVED WITH CONDITIONS.** No new Blocker/HIGH; R7 closed every code-correctness defect. The remaining 8 items are mostly carry-forward from R7's incomplete edits + 2 documentation drift. Total fix scope: < 30 min. Stakeholder gates (DPO/Resend DPA/marketing consent) remain orthogonal.

**Next**: Apply R8 fixes → validate → ship.
