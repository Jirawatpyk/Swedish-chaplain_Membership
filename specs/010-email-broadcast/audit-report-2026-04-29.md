# F7 Email Broadcast — Plan Audit Report

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29 | **Status**: Complete
**Auditor**: `/speckit.plan` second invocation with `audit plan or re-verify` argument
**Scope**: Verify plan + research + data-model + contracts + quickstart for FR coverage, internal consistency, naming, audit-event traceability, Constitution Check.

---

## TL;DR

✅ **Plan audit GREEN**. Spec is plan-ready and tasks-ready. Three minor polish items were fixed in-flight during this audit (data-model audit table missing one event, redundant DB-CHECK placeholders, floating TBD note in webhook contract). Five FRs are addressed thematically but lack explicit FR-id citations in the implementation artefacts (yellow — non-blocking traceability polish).

---

## Audit dimensions + findings

### 1. Functional Requirement coverage

**Method**: Cross-grep every `FR-NNN` identifier from spec.md against plan.md, data-model.md, contracts/, research.md.

**Spec FRs (50 total)**: FR-001…FR-042 plus 8 amendments (FR-002a, FR-015a, FR-015c, FR-015d, FR-016a, FR-002 preconditions a-j shorthand).

**Coverage map**:

| FR | Plan | Data-model | Contracts | Research | Verdict |
|----|------|------------|-----------|----------|---------|
| FR-001..FR-009 | ✅ all | ✅ all | partial | partial | OK |
| **FR-010** | ❌ | ❌ | ❌ | ❌ | 🟡 thematic only — admin queue surface covered in plan § Project Structure + contracts § 2.1 but not by FR-id |
| FR-011..FR-014 | ✅ | partial | ✅ | – | OK |
| FR-015..FR-018 (incl. amendments a/c/d) | ✅ | ✅ | ✅ | ✅ | OK |
| FR-019..FR-028 | ✅ | ✅ | ✅ | partial | OK |
| FR-029..FR-032 | ✅ | ✅ | ✅ | ✅ | OK |
| FR-033 | ✅ | ✅ (32 events catalogued) | – | – | OK |
| **FR-034** | ❌ | ❌ | ❌ | ❌ | 🟡 thematic only — audit hashing rule covered in audit catalogue + log-redact list |
| **FR-035** | ❌ | ❌ | ❌ | ❌ | 🟡 thematic only — plan § VII enumerates 16 metrics + 10 alerts; FR-035 not cited |
| **FR-036** | ❌ | ❌ | ❌ | ❌ | 🟡 thematic only — Constitution Principle I treatment in plan § Gates covers it |
| FR-037 | ✅ | – | ✅ | – | OK |
| **FR-038** | ❌ | ❌ | ❌ | ❌ | 🟡 thematic only — `tests/integration/broadcasts/tenant-isolation.test.ts` listed in plan § Testing as Review-Gate blocker, but not by FR-id |
| FR-039..FR-042 | ✅ | – | ✅ | – | OK |

**Verdict**: 5 FRs (FR-010, 034, 035, 036, 038) are addressed thematically but lack explicit FR-id citations in the artefacts. **Yellow — non-blocking**. The implementation is unambiguous; the FR-id citation gap is a traceability polish item that `/speckit.tasks` can backfill by mapping each task to its source FR.

---

### 2. Audit event type catalogue consistency

**Method**: Cross-grep `\`broadcast_*\``+ `\`member_missing_primary_contact\`` in spec FR-033, data-model § 5 table, CLAUDE.md, plan.md.

**Findings**:

- Spec FR-033 prose: 32 unique events ✅
- CLAUDE.md "Active Technologies": 32 unique events (after subtracting 2 false matches `broadcast_deliveries` + `broadcast_segment_definitions` which are TABLE names) ✅
- **Data-model § 5 audit catalogue table: 31 entries (missing `broadcast_member_missing_primary_contact_email`)** ❌ → **FIXED IN AUDIT** — added as row 13 + renumbered 14–32 + updated prose.
- Plan.md prose: previously said "27 named audit events" → **FIXED IN AUDIT** to "32 named audit events (full catalogue in data-model.md § 5)"
- CLAUDE.md "Recent Changes" entry: previously said "31 audit event types" → **FIXED IN AUDIT** to "32 audit event types"
- CLAUDE.md "Active Technologies" header: previously said "31 new audit event types" → **FIXED IN AUDIT** to "32"

**Verdict**: ✅ **Reconciled** — all four authoritative locations now agree on 32 audit event types.

**Resend orphan event**: contracts/resend-webhook.md previously mentioned `broadcast_webhook_orphan_event` as "32nd audit event type — TBD". Reviewed and **revised** to a low-severity LOG event (NOT audit-log event), since orphan events have no tenant context to bind to. Final F7 catalogue remains 32 entries.

---

### 3. Clarifications Q1–Q12 traceability

**Method**: Grep `Clarifications Q[0-9]+` per artefact.

**Findings**:

| Clarification | spec | plan | research | data-model | contracts |
|---------------|------|------|----------|------------|-----------|
| Q1 (quota timing) | ✅ | ✅ | – | – | – |
| Q2 (admin SLA 48h) | ✅ | – (covered as SC-002 + FR-013 wording) | – | – | – |
| Q3 (immutable after submit) | ✅ | ✅ | – | ✅ | ✅ |
| Q4 (HTML sanitiser) | ✅ | ✅ | ✅ | – | – |
| Q5 (F6 stub-port) | ✅ | ✅ | ✅ | – | – |
| Q6 (perf budgets) | ✅ | ✅ | – | – | – |
| Q7 (5k recipient cap) | ✅ | ✅ | – | – | – |
| Q8 (primary contact only) | ✅ | ✅ | – | ✅ | – |
| Q9 (custom-list validation) | ✅ | ✅ | – | – | – |
| Q10 (cancel cutoff) | ✅ | ✅ | ✅ | – | – |
| Q11 (reply-to fallback) | ✅ | – (covered as FR-002 precondition `j`) | ✅ | ✅ (loose ref `Q11/FR`) | – |
| Q12 (admin proxy) | ✅ | ✅ | – | ✅ | ✅ |

**Verdict**: 🟡 **Q2 + Q11 not explicitly cited in plan.md** but their content is fully covered (Q2 → FR-013 + SC-002 + SLO-F7-008; Q11 → FR-002 precondition `j` + research § 7 reply-to construction). Non-blocking traceability polish. Data-model uses non-standard `Q11/FR` shorthand (should be "Clarifications Q11 / FR-002 precondition `j`"); also non-blocking.

---

### 4. Naming + env var + migration consistency

**Method**: Cross-grep env vars, migration numbers, segment type names, audit event names.

**Env vars** (5 checked):

| Env var | spec | plan | research | data-model | quickstart | contracts | CLAUDE |
|---------|------|------|----------|------------|------------|-----------|--------|
| `RESEND_BROADCASTS_API_KEY` | ✅ | ✅ | ✅ | – | ✅ | – | ✅ |
| `RESEND_BROADCASTS_WEBHOOK_SECRET` | ✅ | ✅ | ✅ | – | ✅ | ✅ | ✅ |
| `UNSUBSCRIBE_TOKEN_SECRET` | ✅ | ✅ | ✅ | – | ✅ | – | ✅ |
| `FEATURE_F7_BROADCASTS` | – | ✅ | – | ✅ | ✅ | – | ✅ |
| `CRON_SECRET` (reused F4/F5) | – | ✅ | ✅ | – | ✅ | ✅ | ✅ |

✅ **No drift** — all 5 env var names spelled identically in every artefact that references them. Spec doesn't enumerate `FEATURE_F7_BROADCASTS` directly (it's a plan-time concern).

**Migration numbers**: 0064–0069 across plan + data-model + quickstart. ✅ **No drift**.

**Segment types**: `all_members`, `tier`, `event_attendees_last_90d`, `custom` — consistent across spec FR-015, data-model enum, plan project structure, contracts segment-type enum. ✅

**Sanitiser allowlist**: spec FR-002a (Q4) lists 14 tags; data-model + plan + research § 3 + CLAUDE.md all match the same list. ✅

---

### 5. Constitution Check post-audit

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Data Privacy & Security (NON-NEGOTIABLE) | ✅ | Tenant isolation 2-layer; OWASP Top 10 mapped; PII inventory complete; lawful basis documented |
| II. Test-First Development (NON-NEGOTIABLE) | ✅ | 100% branch on 8 security-critical use cases; 14 integration tests authored red; coverage thresholds set |
| III. Clean Architecture (NON-NEGOTIABLE) | ✅ | Public barrel + ESLint rule for `src/modules/broadcasts/`; F3+F2 unidirectional; no framework imports in Domain |
| IV. Payment Security (PCI DSS) (NON-NEGOTIABLE) | N/A | F7 has zero payment surface (explicitly stated) |
| V. Internationalization (SV+EN+TH) | ✅ | ~200 keys × 3 locales; system chrome locale-aware; member body content not auto-translated (FR-041) |
| VI. Inclusive UX (Mobile First + WCAG 2.1 AA) | ✅ | UX Implementation Patterns section maps every surface to ux-standards.md § 15 checklist |
| VII. Performance & Observability | ✅ | 6 SLOs (SC-010); 16 metrics; 10 alerts; 3 runbooks; 3 budget exceptions in CT |
| VIII. Reliability | ✅ | 8 transactional boundaries; 5 idempotency primitives; 32 audit events; FR-021/022 retry semantics |
| IX. Code Quality Standards | ✅ | TS strict + ESLint + Conventional Commits + ≥2 reviewer (or solo-maintainer 6-stack substitute) |
| X. Simplicity (YAGNI) | ✅ | 14 OUT-of-scope items; new deps justified line-by-line in CT |

✅ **Post-audit Constitution Check: GREEN**. No new deviations surfaced beyond the 12 already documented in plan.md § Complexity Tracking.

---

### 6. NEEDS CLARIFICATION markers

```bash
grep -rn "NEEDS CLARIFICATION" specs/010-email-broadcast/
```

**Result**: 2 hits — both are negative confirmations (checklist + research close-out paragraph). ✅ **No open markers**.

---

### 7. In-flight fixes applied during this audit

| File | Change | Reason |
|------|--------|--------|
| `data-model.md` § 5 | Added row 13 `broadcast_member_missing_primary_contact_email`; renumbered 14–32; updated table footer prose to "32 entries" | Reconciled spec FR-033 + CLAUDE.md (which both had the event) with data-model (which had been missing it) |
| `data-model.md` § 5 prose | "27 new audit event types" → "32 new audit event types" with reconciliation note | Self-contradiction with the 32-row table |
| `data-model.md` § 1.1 inline comments | Removed misleading `cancelEligibleStateCheck: /* defined as separate trigger below */` placeholder; replaced with cross-reference to § 4.2 state-machine trigger | The state-machine trigger already enforces cancel-cutoff via empty `allowed_targets` arrays in non-cancellable states; a separate CHECK was redundant |
| `plan.md` § Summary | "27 named audit events" → "32 named audit events (full catalogue in data-model.md § 5)" | Same reconciliation |
| `CLAUDE.md` Active Technologies | "31 new audit event types" → "32" | Same reconciliation |
| `CLAUDE.md` Recent Changes | "31 audit event types" → "32 audit event types" | Same reconciliation |
| `contracts/resend-webhook.md` § 5 | `broadcast_webhook_orphan_event` audit event with "TBD" → low-severity LOG event (not audit) | The orphan-event has no tenant context to bind a tenant-scoped audit row to; ops observability via log line is the right level |

---

### 8. Yellow findings (non-blocking; tracked for `/speckit.tasks` to backfill)

1. **FR-id citation gap** — FR-010, FR-034, FR-035, FR-036, FR-038 are addressed thematically but not by FR-id in implementation artefacts. `/speckit.tasks` SHOULD map each task to its source FR; this surfaces the gap automatically.
2. **Clarifications Q2 + Q11 not explicitly cited in plan.md** — coverage is via FR cross-refs (FR-013 + SC-002 + SLO-F7-008 for Q2; FR-002 precondition `j` + research § 7 for Q11). Non-blocking.
3. **Data-model.md uses non-standard `Q11/FR` shorthand** — should be "Clarifications Q11 / FR-002 precondition `j`". Cosmetic.
4. **FR-002 precondition shorthand** ("FR-002a", "FR-002b" etc. in plan/data-model) overloads with the actual FR-002a (sanitiser FR added in clarify Q4). Future maintainers may be momentarily confused. Suggest plan.md/data-model.md adopt "FR-002 precondition (a)" etc. naming convention; cosmetic, non-blocking.

---

### 9. Red findings (blocking)

**None.** Plan is tasks-ready.

---

### 10. Recommendation

✅ **Proceed to `/speckit.tasks`**. The audit identified 3 in-flight fixes (now applied) and 4 cosmetic polish items that `/speckit.tasks` can address as part of its FR-to-task mapping.

`/speckit.analyze` (gate 6) should be the cross-artefact consistency check that catches the same FR-id citation gap mechanically — this audit is a manual preview of what `/speckit.analyze` will run.

---

## Audit close-out

| Section | Status |
|---------|--------|
| FR coverage | 🟡 5 thematic-only (yellow) |
| Audit event consistency | ✅ FIXED |
| Clarifications traceability | 🟡 Q2 + Q11 indirect (yellow) |
| Naming / env vars / migrations | ✅ |
| Constitution Check | ✅ GREEN |
| NEEDS CLARIFICATION markers | ✅ none |
| In-flight fixes | 7 applied |
| Yellow findings | 4 (non-blocking) |
| Red findings | 0 |

**Verdict**: Plan is tasks-ready. Yellow findings folded into `/speckit.tasks` backfill scope.
