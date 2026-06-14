All code anchors confirmed:

- `InvoiceForPayment.memberId: string` (non-null, line 65) — confirms PM NF-2: F5 self-pay bridge will TS-error for non-member event invoices. The spec's §9 claim that this works "naturally via the subject-agnostic bridge" is incorrect as written.
- `INVOICE_LINE_KINDS = ['membership_fee', 'registration_fee']` (line 12) — `'event_fee'` absent, confirming thai-tax NF (domain const must be added atomically with migration). Note `enforceOneMembershipLine` exists at `invoice.ts:208` (not yet `enforceOneSubjectLine`).

I have verified every load-bearing code claim the specialists relied on. The convergent finding across 5 of 6 specialists (thai-tax B5, architect HIGH, PDPA HIGH, pm NF-1, AppSec SEC-EI-06) is real and code-confirmed: `MemberTimelineAuditPayload.member_id: string` is non-null and the discriminated union routes `invoice_issued`/`credit_note_issued` through it — so v2's "payload variant: member_id: string | null" is under-specified and will cause a TS2322 compile error or a silently weakened timeline contract. Plus PM NF-2 (`InvoiceForPayment.memberId`) is a second, independent compile-breaking gap v2 hand-waves.

Here is the consolidated report.

---

# Consolidated Go/No-Go — Event-Fee Invoice Spec v2

## 1. Verdict

**NOT YET READY for writing-plans.** All 8 prior BLOCKERS are correctly resolved at spec level, but v2 introduced **two HIGH new findings that are compile-breaking and code-confirmed** — they are effectively re-openings of B5/B6, not net-new noise. The spec must commit to the audit-payload mechanism and the F5 bridge DTO decision before plan. These are small, targeted edits (no re-architecture). Once the checklist in §4 lands → READY.

The good news: the load-bearing v1 lie ("issueInvoice is subject-agnostic") is now correctly refuted (§3a), the VAT math is verified correct, and the PDPA/tenant-isolation scaffolding is in place. The residual gaps are TypeScript-contract decisions the spec defers without naming the resolution.

## 2. Resolution Scorecard

Prior blocker/high findings across all 6 specialists: **31 verdicts** → **24 RESOLVED · 7 PARTIAL · 0 UNRESOLVED.**

| Specialist | Resolved | Partial | Unresolved |
|---|---|---|---|
| thai-tax | B3, B1c/H6, B6, H7, H8, H9, H10 (7) | B5 (1) | — |
| architect | B1, B2, B3, B4, B5, B6, B7, B8, H1 (9) | — | — |
| PDPA officer | B7-basis, B7-DSR, B7-pino (3) | B7-secondary-notice, B7-redaction-job, B7-RoPA, B7-email-footer (4) | — |
| UX architect | H2, H3-dialog, B8-disclosure, H2-CTA, H2-palette (5) | B8 (1) | — |
| pm | B1, B2, B3, B4, B5, comp-ticket, Q1, Q2, batch-CN (9) | B6, Decision-7 (2) | — |
| AppSec | B4, H4, H3, H5 (4) | H1, B6 (2) | — |

**PARTIAL items — what's still missing (deduped):**

- **B5/B6 audit-payload mechanism (thai-tax, pm, AppSec)** — CODE-CONFIRMED at `audit-port.ts:177-202`. `MemberTimelineAuditPayload.member_id` is `string` (non-null, L187); the union routes `invoice_issued`/`credit_note_issued` (L177-183) through it. v2 §3b/§3f say "member_id: string | null" but never name *how*: (a) widen the shared type, or (b) route non-member events through the `Exclude<…>` non-timeline branch. Naive widening silently weakens the F3 timeline guarantee for the 5 other membership events. **Must pick (b)** (cleaner; timeline filter `payload->>'member_id'` already excludes nulls) — and name `audit-port.ts` as the **5th** place in the §3f 4-place update table.
- **B6 hashed-email payload field (PDPA)** — v2 says "any buyer email is sha256Hex.slice(0,16)" but never names the field (e.g. `contact_email_sha256`); existing `invoice_issued` payload (`issue-invoice.ts:362-370`) has no email field today. Implementer will likely skip it. Name the field + omit-when-empty rule.
- **B7 secondary-use notice (PDPA)** — intent correct, but no target file, no i18n key namespace. `check:i18n` fails at ship if keys unknown. Name file(s) + key namespace.
- **B7 redaction/tombstone job (PDPA)** — no cron route exists (`src/app/api/cron/**` verified empty of it); v2 gives the *what* but not endpoint path, SQL predicate, replacement value, audit event, or runbook entry. Must be fully specified before plan per §87/3 + Art. 5(1)(e). Also: the claimed "retention table" in §7 does not exist (§7 lists edge cases only).
- **B7 RoPA + email footer (PDPA)** — `processing-records.md:17` still says F4 is out of scope; no content outline. Email footer i18n keys don't exist. Deferred to ship-gate is acceptable, but add a content skeleton + key namespace so it isn't omitted.
- **B8 loading.tsx shape mismatch (UX)** — field-level spec is complete, but the existing static `loading.tsx` is an RSC with no `?type=event` access → wrong (membership) skeleton flashes for event path → CLS violation of ux-standards §2.1. v2 names `EventAttendeePickerSkeleton` but doesn't address that `loading.tsx` can't be type-aware. Decide: shape-neutral skeleton OR move Suspense boundary to client sections.
- **H1 Principle-I sub-clause 5 (AppSec)** — v2 §3e says "five Principle-I sub-clauses" but enumerates only four (app-layer, db-layer, integration test, audit). Sub-clause 5 (super-admin bypass path: gated/logged/covered?) is omitted. Per Constitution v1.4.0 this is itself a Review-Gate blocker. One sentence fix: state no super-admin bypass exists for `EventRegistrationLookupPort`.
- **Decision-7 F5 self-pay (pm)** — see new finding NF-2 below; same root cause.

## 3. New Findings v2 Introduced

**HIGH (block plan — both code-confirmed, both are deferred TS-contract decisions):**

1. **NF-A — `MemberTimelineAuditPayload` widening is under-specified (thai-tax, architect, PDPA, pm, AppSec all converge).** CONFIRMED `audit-port.ts:186-188` = `{ readonly member_id: string }`. Emitting `invoice_issued`/`credit_note_issued` with `member_id: null` is a TS2322 error under strict. v2 must explicitly state: route non-member event audit events through the `Exclude<F4AuditEventType, F4MemberTimelineAuditEventType>` branch (`payload: Record<string, unknown>` with `event_registration_id`), **do NOT widen `MemberTimelineAuditPayload`**, audit-port type unchanged, call-site switches branch on `invoice_subject`. Add a TS compile-test assertion to tasks.

2. **NF-B — `InvoiceForPayment.memberId: string` blocks the F5 self-pay reuse claim (pm NF-2).** CONFIRMED `get-invoice-for-payment.ts:65` = `memberId: string` (non-null). v2 §9 Decision-7 says matched members self-pay "via the subject-agnostic `getInvoiceForPayment`" — but a matched-member event invoice with non-null memberId works, while the DTO mapper still can't represent a DB `member_id IS NULL` row. v2 must either (a) widen `InvoiceForPayment.memberId: string | null` + note `initiate-payment` must handle null (no F3 ownership check for non-members), or (b) explicitly scope F5 self-pay to matched-member event invoices only and leave the DTO unchanged. As written the reuse claim is incorrect.

**MEDIUM (fold into spec, not plan-blockers):**

- **NF-C — `amountOverride` ceiling is a placeholder** (thai-tax, architect, AppSec all flag). `max(<ceiling, e.g. 1_000_000_00>)` is a TODO masquerading as a decision; the underscore grouping `1_000_000_00` is also non-standard/ambiguous (AppSec N-01). Commit to a concrete value as a named constant `MAX_EVENT_INVOICE_SATANG` (suggest `100_000_000` = 1M THB) so use-case + route-handler zod agree.
- **NF-D — `INVOICE_LINE_KINDS` domain const not cross-referenced to migration** (thai-tax). CONFIRMED `invoice-line.ts:12` = `['membership_fee', 'registration_fee']` — `'event_fee'` absent. `enforceOneSubjectLine` comparing `'event_fee'` against this `as const` type is TS2367 (always-false) until the const is updated. Add explicit bullet: domain const + pgEnum + Migration N must land atomically (F4-R8 pattern).
- **NF-E — F6 `RegistrationsRepository` tx-threaded method location unspecified** (architect). F6's `findById` at `registrations-repository.ts:161-163` takes no `tx`. State unambiguously: extend F6 barrel with `findByIdInTx(tx, tenantId, registrationId)` mirroring `InvoiceRepo.findByIdInTx`; F6 Drizzle adapter implements it. (Note AppSec observes the adapter can construct via `makeDrizzleRegistrationsRepository(executor: TenantTx)` without a new port method — reconcile these two views in the spec.)

**LOW (note, defer):** `auto_email_skipped_no_contact` payload shape + 5y retention undefined (architect, PDPA); `assertSnapshotsSet` still checks non-null snapshot — fine for event invoices but needs a tasks wiring note (pm NF-3); odd-bps VAT rounding bias is benign at 7%/0% but document the even-denominator assumption (UX).

## 4. Remaining Spec Edits Before writing-plans

Plan-blocking (must land first):

- [ ] **§3b/§3f — NF-A:** state non-member event audit events route through the `Exclude<…>` non-timeline branch; do NOT widen `MemberTimelineAuditPayload`; audit-port unchanged; add `audit-port.ts` call-site branch as the explicit decision + a TS compile-test in tasks.
- [ ] **§9 Decision-7 — NF-B:** commit to widen `InvoiceForPayment.memberId: string | null` (+ note F5 null-member handling) OR scope self-pay to matched-members only with DTO unchanged.
- [ ] **§3e — H1 sub-clause 5:** add the super-admin-bypass Principle-I sub-clause (one sentence: none exists / is gated+logged+tested).
- [ ] **§6/§2 — B7 redaction job:** specify cron endpoint path, SQL predicate, PII replacement value, audit event + retention, runbook entry. Add the actual Retention table v2 claims exists.

Fold-in (cheap, prevents omission — can be batched with the above):

- [ ] **§3d — NF-C:** replace `amountOverride` placeholder with concrete `MAX_EVENT_INVOICE_SATANG` constant.
- [ ] **§2/§3 — NF-D:** add `INVOICE_LINE_KINDS` += `'event_fee'` atomic-with-migration bullet.
- [ ] **§3e — NF-E:** name `findByIdInTx` on F6 barrel as the cross-module method.
- [ ] **§3f — B6 email field:** name `contact_email_sha256` payload field + omit-when-empty.
- [ ] **§6/§5 — B7 notice/footer/RoPA:** name target files + i18n key namespaces + RoPA content skeleton.
- [ ] **§4 — B8 loading.tsx:** decide shape-neutral skeleton vs client-level Suspense boundary.

Net: 4 plan-blocking edits + 6 fold-ins. No re-architecture, no re-design — all are "name the decision the spec already gestures at." After these, the spec is READY for writing-plans.