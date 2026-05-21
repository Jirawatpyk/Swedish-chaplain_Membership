# F7 MVP Regression Matrix Template (T164)

**Purpose**: Re-run F7 MVP SC-001 through SC-014 with F7.1a flags ON to verify zero regression per SC-010.
**Operator**: copy to `f7-mvp-regression-2026-{date}.md` on ship-day, fill in observed results.
**Source-of-truth**: `specs/010-email-broadcast/spec.md § Success Criteria`
**Block-ship rule**: ANY F7 MVP SC regression blocks F7.1a ship (per SC-010 of F7.1a).

---

## Pre-condition

Staging env with `FEATURE_F71A_BROADCAST_ADVANCED=true` AND `FEATURE_F71A_US1_PAGINATION=true` AND `FEATURE_F71A_US2_IMAGES=true` AND `FEATURE_F71A_US7_TEMPLATES=true`. Section A (infra) + B.1-B.3 of ship-day-checklist.md complete.

---

## F7 MVP SC re-run matrix

| SC ID | Description | F7 MVP target | Verification path | Result | Notes |
|-------|-------------|---------------|-------------------|--------|-------|
| SC-001 | Quota tracking accuracy | Per-member-per-year counter increments correctly | Submit a broadcast → quota row's `quota_year_consumed` increments by 1 in same tx | TBD | |
| SC-002 | Submit performance | submit p95 <1.2s | Time 10 sequential submissions; compute p95 | TBD | |
| SC-003 | Approve-and-send performance | approve p95 <1.5s | Time 10 sequential approves; compute p95 | TBD | |
| SC-004 | Webhook ingest performance | p95 <250ms | Replay 10 webhook events via local script; measure p95 | TBD | |
| SC-005a | Bounce-rate auto-halt | 5% bounce → halt member | Force-bounce 5%+ via Resend dashboard event-replay; verify member transitions to `halted_pending_review` | TBD | |
| SC-005b | Complaint-rate auto-halt | 0.5% complaint → halt | Same as SC-005a with complaint events | TBD | |
| SC-006 | Sanitiser correctness | All allowlist tag set; reject disallowed | Submit a body with `<script>` → rejected with `broadcast_body_unsafe_html` | TBD | |
| SC-007 | Suppression-list correctness | Unsubscribed members never receive | Pre-suppress one member; submit broadcast; verify they're not in delivered cohort | TBD | |
| SC-008 | WCAG 2.1 AA on F7 MVP surfaces | axe-core 0 critical | Run axe-core on compose page + admin queue + admin detail | TBD | |
| SC-009 | i18n parity | EN+TH+SV present | `pnpm check:i18n` on the staging build | TBD | |
| SC-010 | Zero F7 MVP regression on F7.1a | This entire matrix passes | — | TBD | The meta-criterion |
| SC-011 | Dispatch failure rate | <1% over 1h | Monitor `broadcasts.dispatch_failure_rate` for 1h after submitting 100 broadcasts | TBD | |
| SC-012 | Recipient-count drift detection | `audience_drift_detected` fires on replay-with-different-count | Force a Resend replay with deliberately-mismatched count; verify `broadcast_audience_drift_detected` audit | TBD | |
| SC-013 | Halt-clear by admin | Admin can clear `halted_pending_review` | Admin reviews a halted member; clears halt; member can submit again | TBD | |
| SC-014 | Stuck-sending reconciliation | >24h sending → resolved via cron | Pre-seed a broadcast stuck in `sending` >24h; verify `reconcile-stuck-sending` cron resolves | TBD | |

---

## Result tally

- **PASS**: `<count>` / 14
- **FAIL**: `<count>` / 14
- **NOT-APPLICABLE**: `<count>` / 14 (e.g., SC requires production-only data)

**Ship verdict**:
- All 14 SCs PASS (or NOT-APPLICABLE with documented reason) → **CLEAR TO SHIP**
- Any SC FAIL → **HALT SHIP** — open a blocking issue + identify root cause before re-attempt

---

## Detailed findings per SC

(Document any verification details, deviations from F7 MVP expectations, or environmental quirks.)

### SC-001 — Quota tracking accuracy
`<TBD>`

### SC-002 — Submit performance
`<TBD>`

### SC-003 — Approve-and-send performance
`<TBD>`

(... continue for all 14 SCs)

---

## Cross-references

- F7 MVP spec: `specs/010-email-broadcast/spec.md § Success Criteria`
- F7.1a SC-010 anchor: `specs/014-email-broadcast-advance/spec.md § SC-010`
- F7.1a ship-day checklist: `specs/014-email-broadcast-advance/qa/ship-day-checklist.md`

**Reviewer**: `<name>` — `<date>`
**Sign-off**: `<signature/email>`
