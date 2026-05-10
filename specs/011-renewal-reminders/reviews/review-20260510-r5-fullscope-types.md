# F8 Type-Design Review — R5 Full-Scope (Types)

**Date**: 2026-05-10
**Branch**: `011-renewal-reminders`
**Scope**: Phase 10 verify-fix wave types (T262 batched-write infra) + spot-check of Phase 1–9 high-signal aggregates.
**Reviewer**: type-design specialist (1M-context Opus)

## Executive summary

F8's domain layer is **exceptionally well-typed for a TypeScript codebase of this size** — the renewal module makes systematic use of:

- **Discriminated unions over status** (`RenewalCycle`, `TierUpgradeSuggestion`, `RenewalEscalationTask`) so every "X is required when status='Y'" runtime invariant becomes a compile error.
- **Branded `unique symbol` ID types** (`CycleId`, `SuggestionId`, `TaskId`) with paired `parseX(raw): Result<X, E>` validators and `asX(raw): X` unsafe-trust constructors clearly distinguished by name.
- **Compile-time tuple-length assertions** (`_AssertCycleStatusCount`, `_AssertClosedReasonCount`) pinning const enum cardinality so a fifth status accidentally landed in code becomes a build break.
- **Type-linked closed enums** (`DispatchFailureKind = SendRenewalEmailError['kind'] | 'dispatcher_crash'`) so audit shapes stay in sync with gateway error shapes via lookup, not hand-mirroring.
- **Per-arm reason/evidence pairing** via the generic `TierUpgradeSuggestionBase<R extends TierUpgradeReasonCode>` + `Extract<TierUpgradeEvidence, { reasonCode: R }>` — the most sophisticated piece of Domain typing in the codebase. Eliminates the silent forensic-drift class where `reasonCode='multi_signal'` could pair with single-signal `evidence`.

The Phase 10 batched-write additions inherit these patterns cleanly, with **two minor inconsistencies** flagged below (LOW + MEDIUM).

## Phase 10 new types — focused review

### 1. `TierUpgradeSuggestionRepo.bulkInsertOpenIfAbsent` + `bulkGetSuppressedMembers`

`src/modules/renewals/application/ports/tier-upgrade-suggestion-repo.ts:148-178`

**Encapsulation 5/5** — methods take `TenantTx` (port-shaped opaque tx, not Drizzle's tx) + only domain inputs; returns are domain-typed `ReadonlyArray<TierUpgradeSuggestion>`. No Drizzle row leakage.

**Invariant expression 4/5** — the `{ inserted, conflicted }` discriminated outcome carries both halves so the caller can branch on conflict count without a second query. Empty-input no-op contract documented inline. **Asymmetry vs sibling port** (see MEDIUM-1 below) is the one notch lost.

**Usefulness 5/5** — `ReadonlySet<string>` return on `bulkGetSuppressedMembers` is a precise structural choice: O(1) membership tests on the caller's filter loop (which `evaluate-tier-upgrade.ts:342` exploits) without exposing iteration order. Clear docstring ties the perf reduction (333 RTTs → 1) to T264 perf bench.

**Enforcement 4/5** — `ReadonlyArray<TierUpgradeSuggestion>` + `ReadonlySet<string>` defend against caller mutation. `tx: TenantTx` in the signature forces caller to be inside an active tenant context. Adapter does cast `tx as unknown as typeof db` (`drizzle-tier-upgrade-suggestion-repo.ts:506,529`) — see LOW-1.

### 2. `RenewalReminderEventRepo.bulkInsertIfAbsent` + `bulkTransitionToSent`

`src/modules/renewals/application/ports/renewal-reminder-event-repo.ts:138-169`

**Encapsulation 5/5** — same TenantTx-shaped opaque port as sibling.

**Invariant expression 5/5** — `bulkInsertIfAbsent` returns `conflicted: ReadonlyArray<NewReminderEventInput>` (the full input, not a derived id). This is **better** than the tier-upgrade sibling (see MEDIUM-1) because the caller's "emit `renewal_reminder_skipped { reason: 'already_sent' }`" branch needs the cycle/step/year tuple anyway.

**Usefulness 5/5** — `bulkTransitionToSent`'s input shape `{ tenantId, reminderEventId, dispatchedAt, deliveryId }` is the minimal cross-section needed for the per-row `CASE` UPDATE the adapter generates. Returns `ReadonlyArray<ReminderEvent>` in input order (per docstring) so caller can correlate audits 1:1 — well-thought-out signature.

**Enforcement 4/5** — Caller-coordinated atomicity ("MUST pair with `bulkEmitInTx` inside the SAME `runInTenant`") is documented but not type-enforced. Same minor leak via `tx as unknown as typeof db` in adapter (line 341, 392). Per MEDIUM-2 below, the `nextStatus: Exclude<ReminderEventStatus, 'pending'>` discipline from sibling `transitionStatus` is **not** mirrored here (bulk fixes the target to `'sent'` literal — actually the safer choice; mention only for completeness).

### 3. Local types in `evaluate-tier-upgrade.ts`

`src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:312-315` (`PageDecision`) + 316-325 (`flushPage` signature)

**Encapsulation 5/5** — `PageDecision` is file-private (no `export`), correctly scoped to `flushPage`. Uses `import('../ports/...').TierUpgradeEvalCandidate` inline-import to avoid polluting the file's top-level imports.

**Invariant expression 5/5** — `decision: NonNullable<ReturnType<typeof decideUpgrade>>` derives the type from the function rather than re-stating it. Ensures `decision` can never be `null` inside the page-flush path (the `decideUpgrade(...) === null` short-circuit happens earlier at line 455-460). If `decideUpgrade`'s shape ever changes, `PageDecision` follows automatically.

**Usefulness 5/5** — eliminates the "is this candidate's decision still null?" defensive nullcheck from the inner loop, which would otherwise pollute three `.map`/`.filter` callbacks.

**Enforcement 5/5** — derived type can't drift; `ReadonlyArray<PageDecision>` parameter on `flushPage` blocks accidental mutation inside the helper.

## Spot-checked Phase 1-9 types (no drift detected)

### `F4InvoicePaidEvent` (`src/modules/invoicing/domain/f4-invoice-paid-event.ts:82-128`)

5/5 across the board. The 6-value `F4InvoicePaidPaymentMethod` union pinning Stripe rails (`stripe_card`, `stripe_promptpay`) at the **semantic layer** — even though F4's persisted enum collapses both to `'other'` — is the correct cross-module contract design. Listeners get the truth; the storage encoding is F4's internal concern. `currency: 'THB'` literal (not `string`) forces future widening to land as a typed compile error rather than silent misclassification — explicitly called out in the docstring as a defensive choice.

### `IssueRefundForInvoiceResult` (`src/modules/renewals/application/ports/f5-refund-bridge.ts:47-68`)

5/5. Three-arm discriminated union over `status`. The `'no_payment_found'` arm carries no payload (other than the discriminator itself) — correctly modelled as a non-error informational outcome. `'refund_failed'` carries `errorCode + detail` so caller can branch on F5 error class without parsing strings. Cross-module input uses **canonical** `TenantId` from `@/modules/members` + `InvoiceId` from `@/modules/invoicing` (Round 3 R3-CR1 fix per the file's docstring) — no parallel-type-system drift, arg-swap protection preserved.

### `RenewalCycle` (`src/modules/renewals/domain/renewal-cycle.ts:184-191`)

5/5. The DU-over-`status` design is exemplary:
- `CompletedCycleFields.linkedInvoiceId: string` (required, non-null) vs `LapsedCycleFields.linkedInvoiceId: string | null` (the lapsed cycle may or may not have ever issued an invoice) — the type system **prevents** `status='completed', linkedInvoiceId=null` at compile time.
- `PendingReactivationCycleFields.enteredPendingAt: string` makes the FR-005c ladder anchor non-nullable when in that state, while every other arm pins it to `null`.
- `_AssertClosedReasonCount` pins the 9-element tuple length so `CLOSED_REASONS` and the DB CHECK constraint (migration 0108) can drift only via a build break.
- `cycleFrozenPriceSatang(cycle): bigint` is the canonical conversion site with a defensive regex (`VALID_FROZEN_PRICE_RE`) that throws on malformed input — preventing silent wrong-magnitude bigint propagation into F5 PaymentIntent amounts.

### `TierUpgradeSuggestion` (`src/modules/renewals/domain/tier-upgrade-suggestion.ts:117-244`)

5/5. The 21 valid concrete shapes (3 reason codes × 7 lifecycle arms) are computed by a mapped type — no hand-listed combinatorial blowup. The split between `SupersededFromOpenFields` and `SupersededFromAcceptedFields` (both `status: 'superseded'`, sub-discriminated by `supersededFrom`) preserves the forensic invariant that a post-acceptance supersede must carry the original `acceptedAt + acceptedByUserId` (otherwise admin work is silently dropped from the audit trail). This is the kind of invariant most TypeScript codebases would push to a comment.

### `RenewalEscalationTask` (`src/modules/renewals/domain/renewal-escalation-task.ts:93-94`)

5/5. Same DU pattern. Notable that `OpenEscalationTaskFields.outcomeNote: null` and `closedByUserId: null` enforce the "open task carries no closure context" invariant — admins can't accidentally write a partial-close.

### `DispatchOneCycleOutcome` (`src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts:154-190`)

5/5. Five-arm DU. `'sent'` arm carries `{ reminderEventId, deliveryId, dispatchedAt }` — the exact triple needed to cross to F4-paid hooks without a second lookup. `'task_created'` arm has a deliberate-but-documented `taskType: string` looseness for tenant-customisable schedule policy steps (justified inline). Caller exhaustiveness is enforced by `satisfies DispatchOneCycleOutcome` at the per-branch return sites (e.g. line 545).

### `Result<T, E>` (`src/lib/result.ts:21-26`)

5/5. Stable since F1, no drift. `readonly` on both arms; `ok: true | false` discriminator gives clean exhaustive narrowing. Used consistently across F8 use-cases.

## Findings

### LOW-1 — `tx as unknown as typeof db` cast pattern proliferating in adapters

**Files**: `drizzle-tier-upgrade-suggestion-repo.ts:205, 250, 269, 506, 529`; `drizzle-renewal-reminder-event-repo.ts:85, 151, 199, 310, 341, 392` (10 sites total).

`TenantTx` from `@/lib/db` is intentionally opaque (port-shaped) but adapters double-cast it back to `typeof db` before invoking Drizzle methods. This is the canonical Clean-Architecture-meets-Drizzle pattern in this codebase — **not a bug** — but the cast does mean the adapter could accidentally run a non-tenant-scoped query against `txDb` if a maintainer omits the `inArray(...tenantId)` predicate. The DB-level RLS+FORCE policies are the backstop.

**Suggestion** (defer to F9): introduce `withTenantTx<T>(tx: TenantTx, fn: (txDb: TxDb) => Promise<T>): Promise<T>` helper in `@/lib/db` that performs the cast once + lints adapter call sites for the single-import. Out of scope for F8 ship.

### MEDIUM-1 — `bulkInsertOpenIfAbsent` returns `conflicted: ReadonlyArray<string>` (memberIds), `bulkInsertIfAbsent` returns `conflicted: ReadonlyArray<NewReminderEventInput>` (full input)

**Files**: `tier-upgrade-suggestion-repo.ts:177` vs `renewal-reminder-event-repo.ts:143`.

The two new bulk ports were added in the same wave (T262) but adopted **different shapes** for the `conflicted` half of the discriminated outcome:

- Tier-upgrade: `conflicted: ReadonlyArray<string>` — just memberIds.
- Reminder-event: `conflicted: ReadonlyArray<NewReminderEventInput>` — the full input.

For `evaluate-tier-upgrade.ts`, the caller never uses `bulkResult.conflicted` (only its `.length` for the metrics counter at line 441) — so the slim shape is sufficient today. But future audit emission for a `tier_upgrade_skipped { reason: 'open_conflict' }` event would need the original input back to know `(fromPlanId, toPlanId, reasonCode)` — which would force a port-signature change.

**Suggestion**: harmonise to `conflicted: ReadonlyArray<NewTierUpgradeSuggestionInput>` for symmetry + future-proofing. The cost is one extra map.from-input-array in the adapter. Tag as F9 polish; not a F8 ship blocker because `evaluate-tier-upgrade.ts` doesn't currently need it.

### MEDIUM-2 — `evidenceJsonb: input.evidence as unknown as Record<string, unknown>` cast in adapter

**File**: `drizzle-tier-upgrade-suggestion-repo.ts:538`.

The `TierUpgradeEvidence` discriminated union (`tier-upgrade-suggestion.ts:90-106`) is one of the strongest invariants in F8 — it ties `reasonCode` and the metric fields together via three exhaustive arms with no index signature. The adapter's `as unknown as Record<string, unknown>` widening **erases** that invariant at the persistence boundary. Drizzle's jsonb column type inference happens to be `Record<string, unknown>` by default; the cast is needed because TypeScript won't widen a closed union to an open record without help.

This is a **necessary** cast (no path around it without a Drizzle column-type customisation) but worth a comment at the cast site explaining that the DB CHECK constraint on `tier_upgrade_suggestions.reason_code` (paired with the `evidence_jsonb->>'reasonCode'` discriminator) is what re-establishes the invariant on the round-trip read.

**Suggestion**: add 3-line comment at `drizzle-tier-upgrade-suggestion-repo.ts:538` noting (1) why the cast is needed, (2) which DB constraint upholds the invariant on read, (3) where `rowToDomain` re-narrows to the union. No code change.

### LOW-2 — `transitionStatus` `args` is a flat optional bag

**File**: `tier-upgrade-suggestion-repo.ts:75-92`.

The `transitionStatus` method takes a flat object with 10 optional fields (`acceptedAt`, `acceptedByUserId`, `targetApplyAtCycleId`, `appliedAt`, `appliedAtInvoiceId`, …). With `exactOptionalPropertyTypes: true` enabled, this is at least typesafe-ish, but the type doesn't encode the **per-target-status field requirements** that the `TierUpgradeSuggestion` DU encodes elsewhere — i.e. when transitioning to `'applied'`, the caller MUST supply `acceptedAt + acceptedByUserId + targetApplyAtCycleId + appliedAt + appliedAtInvoiceId + closedAt`, but the port signature lets the caller supply none of them.

The runtime adapter probably enforces this via DB CHECK constraints, but the port is weaker than the aggregate.

**Suggestion**: refactor `transitionStatus` to take a discriminated `TransitionInput` union over the target status:

```ts
type TransitionInput =
  | { to: 'accepted_pending_apply'; acceptedAt: string; acceptedByUserId: string; targetApplyAtCycleId: string; }
  | { to: 'applied'; appliedAt: string; appliedAtInvoiceId: string; closedAt: string; }
  | { to: 'dismissed'; dismissedReason: string; closedAt: string; suppressedUntil: string; }
  | { to: 'superseded'; supersededFrom: 'open' | 'accepted_pending_apply'; closedAt: string; }
  | { to: 'auto_resolved'; closedAt: string; };
```

Mirrors `RenewalCycle`'s arm-fields-per-status pattern. Would catch a class of "transition to applied without setting closedAt" bugs at compile time. Tag as F9 hardening; **not** a blocker since the existing DB CHECK constraints catch this at runtime.

## Final ratings (Phase 10 new types)

| Dimension | Score | Notes |
|---|---|---|
| Encapsulation | 5/5 | Port + adapter cleanly split; opaque `TenantTx` everywhere |
| Invariant expression | 4.5/5 | DU patterns excellent; `transitionStatus` flat-bag is the one outlier (LOW-2) |
| Usefulness | 5/5 | Domain meaning carried in every type; no anaemic data bags |
| Enforcement | 4.5/5 | `ReadonlyArray`/`ReadonlySet` on returns; minor caller-coordinated invariants documented but not type-enforced |

## Phase 1-9 spot-check ratings (no drift)

All seven types reviewed (`RenewalCycle`, `TierUpgradeSuggestion`, `RenewalEscalationTask`, `F4InvoicePaidEvent`, `IssueRefundForInvoiceResult`, `DispatchOneCycleOutcome`, `Result<T,E>`) score **5/5 across all four dimensions**. No drift detected.

## Verdict

**APPROVED** for F8 ship from a type-design standpoint.

- 0 BLOCKER findings.
- 0 HIGH findings.
- 2 MEDIUM findings (cast comment + transitionStatus refactor) — both acceptable to defer to F9.
- 2 LOW findings (adapter cast helper + bulk-port `conflicted` shape harmonisation) — defer to F9.

F8 has set a new high-water mark for type design in this codebase. The systematic use of DU-over-status, per-arm reason/evidence pairing on `TierUpgradeSuggestion`, and the type-linked `DispatchFailureKind` alias are patterns worth back-porting to F1–F5 when those modules next get touched. Recommend documenting the DU-over-status pattern in `docs/ux-standards.md` or a new `docs/type-design-patterns.md` so future feature authors inherit the discipline by default.

## Files referenced

- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\ports\tier-upgrade-suggestion-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\ports\renewal-reminder-event-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\evaluate-tier-upgrade.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\_lib\dispatch-one-cycle.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\domain\renewal-cycle.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\domain\tier-upgrade-suggestion.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\domain\renewal-escalation-task.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\ports\f5-refund-bridge.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\invoicing\domain\f4-invoice-paid-event.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\drizzle\drizzle-tier-upgrade-suggestion-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\drizzle\drizzle-renewal-reminder-event-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\lib\result.ts`
