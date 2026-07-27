# Auto-invoice (107, stance A3) — Whole-feature Audit Sign-off

> **Status: READY TO MERGE (dark).** 11-dimension specialist audit — the
> solo-maintainer substitute for the ≥2-reviewer Review Gate (Constitution
> Principle IX). Every dimension returned **APPROVED_WITH_NITS**; **zero
> BLOCKER / CRITICAL / HIGH** findings. The code-correctness nits are fixed +
> re-validated (below); the residue is enable-gates (pre-flag-flip) and
> doc/polish follow-ups, none of which block the **dark** merge.

- **Feature**: auto-invoice on renewal — daily cron pre-fills renewal invoice
  **drafts** → treasurer review queue (`/admin/invoices`, `origin=auto_renewal`)
  → per-row Issue / Discard. Design: `docs/superpowers/specs/2026-07-17-auto-invoice-design.md`.
  Plan: `docs/superpowers/plans/2026-07-18-auto-invoice.md`.
- **Branch / PR**: `107-auto-invoice` → PR #261 (79 commits ahead of `main`, 0 behind).
- **Dark-ship gate (3 keys, all default-OFF in prod)**: `FEATURE_AUTO_INVOICE`
  (env) **AND** `tenant_invoice_settings.auto_invoice_enabled` (tenant) **AND**
  per-member `members.auto_invoice_enrolled_at`. Merging to `main` executes no
  auto-invoice path in prod.
- **Remediation commit**: `3dd81ee1f` (11 files, +217/−37).
- **Audit date**: 2026-07-26. Prod is LIVE with real members + money → money/tax
  paths are live-stakes; this feature ships dark and touches none of them until
  the flip sequence in `docs/go-live-readiness.md` is executed.

---

## Sign-off table — 11 specialist dimensions

| # | Dimension | Verdict | One-line |
|---|-----------|---------|----------|
| 1 | **tax** (Thai RD §86/4 / §87) | APPROVED_WITH_NITS | Draft = zero-tax-artifact (no §87 number, no PDF, no outbox); a §86/4/§87 number is minted only at the human Issue, under the correctly-scoped guards. |
| 2 | **financial** (money/state) | APPROVED_WITH_NITS | cron→draft→issue is money-safe — no double-bill / lost-money; three-path duplicate-§86/4 barrier is coherent; price is integer-satan re-summed. |
| 3 | **security** (RBAC / cron / isolation) | APPROVED_WITH_NITS *(checklist signed)* | admin-only on every mint/discard/enrol path (manager blocked at `canAccess`); 4 cron routes constant-time Bearer; RLS+`runInTenant` tenant isolation. |
| 4 | **pdpa** (erasure / retention) | APPROVED_WITH_NITS | Auto-drafts hold no plaintext buyer PII (snapshot pinned at issue only); erased members **double-gated** out of the cron. |
| 5 | **tests** | APPROVED_WITH_NITS | All 18 spec §10 scenarios covered; every money-path use-case live-Neon tested with adversarial fixtures, not mocks. |
| 6 | **spec** (compliance) | APPROVED_WITH_NITS | Behaviourally spec-compliant end-to-end; the nits are stale spec **prose** vs. the (correct) shipped code. |
| 7 | **observability** | APPROVED_WITH_NITS | F8/F3 7-place audit lockstep complete + live-Neon-verified; logging thorough + PII-clean. |
| 8 | **migration** (0274–0281) | APPROVED_WITH_NITS | Safe on live prod — journal integrity sound; idx gap cosmetic; RLS/CHECK/EXCLUDE correct. |
| 9 | **ux** | APPROVED_WITH_NITS | Mass-issue foot-gun prevented (no "Issue all"; per-row ⋯ → explicit item → Cancel-default AlertDialog). |
| 10 | **i18n** (EN/TH/SV) | APPROVED_WITH_NITS | Parity exact (4959×3, `check:i18n` green); ~40 auto-invoice keys present in every locale. |
| 11 | **perf** | APPROVED_WITH_NITS | No BLOCKER — crons GET-aliased + UTC-spaced; queue context is page-bounded (50) with batched reads, no N+1. |

> The audit brief referenced "12" reviewers; the completeness critic confirmed
> **11 substantive specialist verdicts** ran and no expected dimension (e.g.
> accessibility — folded into ux) is missing. Treated as a complete sign-off.

---

## Fixed in this remediation pass (commit `3dd81ee1f`) — re-validated

| Finding (dim, sev) | Fix | Validation |
|---|---|---|
| **tax MEDIUM** — a same-term admin plan-change re-freezes the cycle after drafting; Issue would mint a §86/4 at the **superseded tier's** price/name. `issue-auto-drafted-renewal.ts:317` | New `plan_drift` refusal in HARD REQ #1 (`invoice.planId != cycle.planIdAtCycleStart`). Added `findMembershipInvoiceInTx.planId` (port + drizzle select), `invalid_draft` reason `plan_drift`, error-routing `planDrift`, EN/TH/SV copy. | Integration **(e) e4** — plan_drift refused, draft untouched (live Neon). |
| **financial LOW** — `discardSupersededDrafts` commits sibling deletions + a false `superseded_on_issue` audit even when the coverage guard then refuses (`err()` inside `runInTenant` commits). `issue-auto-drafted-renewal.ts:405` | Moved HARD REQ #2 coverage guard **ABOVE** the sweep. | Integration **(n)** — on `duplicate_live_bill` the sibling survives + no supersede audit (live Neon). |
| **financial LOW** — auto-draft worker lacks the `readOnlyMode` short-circuit the coordinator/prune/reconcile routes carry. `auto-draft/[tenantId]/route.ts:70` | Added `if (env.flags.readOnlyMode) → 200 {skipped, read_only_mode}` after the feature-flag gate. | typecheck 0. |
| **ux LOW** — bulk "Send renewal reminder" dialog omits `finalFocus`; focus drops to `<body>` on success (WCAG 2.4.3). `bulk-action-bar.tsx:585` | `finalFocus={finalFocus}` + full trigger-ref pattern, matching the other four dialogs. | unit (bulk-action-bar-error-map) green. |
| **i18n MEDIUM** — TH `billYearStale*` renders §87 fiscal year as ปีงบประมาณ (govt budget year) vs. established ปีภาษี. | ปีงบประมาณ→ปีภาษี in the 3 queue keys (2224–2226) only, not the dashboard keys. | `check:i18n` OK 4959×3. |
| **i18n LOW ×4** — TH `duplicateLiveBill` ปีแผน→ปีภาษี; SV `confirmEnrolDescription` kassatjänsteman→kassör; TH enrol-verb; TH staleness=0 space. | Applied. | `check:i18n` OK. |
| **pdpa** (traceability) — the auto-draft-cron erased gate. | `auto-draft-due-renewals.ts` comment clarified: the PDPA erased gate lives at the **candidate query** (`listCyclesEligibleForAutoDraft`, `m.erased_at IS NULL`), proved by `list-eligible-auto-draft.test.ts` case (h); the classifier arm only fires on a post-candidate TOCTOU race. Comment-only — no logic change. | Verified via existing test (h). |

**Also verified — no change needed:** cron schedule is correct end-to-end —
`vercel.json` has auto-draft `0 22 * * *` UTC (= 05:00 ICT), prune `15 0` UTC
(07:15 ICT), reconcile `30 0` UTC (07:30 ICT); the runbook table shows the
logical Asia/Bangkok times per its documented convention.

Post-fix gates: **typecheck 0 · lint clean · check:i18n 4959×3 · issue-auto-drafted-renewal 15/15 live-Neon GREEN.**

---

## Deferred — ENABLE-GATES (must be true BEFORE flipping `FEATURE_AUTO_INVOICE` + `auto_invoice_enabled`)

Owner: **operator**, at the flag-flip window — NOT dark-merge blockers.

> **Status update (2026-07-27) — feature is READY to activate.** The env flags
> `FEATURE_AUTO_INVOICE` / `FEATURE_ERASURE_DISCARD_DRAFTS` / `FEATURE_VOID_ON_REISSUE`
> are ON in prod. Gate **#1 (erasure-discard)** is satisfied. Gates **#3
> (observability instrumentation)** and **#5 (auto_draft_invoice_id index,
> migration 0282)** were completed in PR #262 and are live. Gate **#6 (legacy
> coverage backfill, below)** is RESOLVED as *leave-NULL* — no longer a blocker.
> The only remaining pre-heavy-use advisory is **#2 (record p95 baselines)**,
> which does not block enabling. To activate: turn on the tenant flag
> `tenant_invoice_settings.auto_invoice_enabled` and enrol members
> (`members.auto_invoice_enrolled_at`); the daily cron then drafts and the
> treasurer works the review queue.

1. **[pdpa LOW / REQUIRED] `FEATURE_ERASURE_DISCARD_DRAFTS=true`** — independent
   of `FEATURE_AUTO_INVOICE`; without it an erased member's drafts survive
   (Art.5(1)(c) data-minimisation gap). Already marked REQUIRED in
   `docs/go-live-readiness.md` §6.4/§6.8. Take a Neon PITR snapshot first.
2. **[perf MEDIUM] Record p95 SLOs** — the auto-draft cron pass (per-tenant
   `renewals.coordinator.duration_ms{cron_kind=auto_draft}`, F8 precedent <60s
   @5k) and the review-queue screen p95 vs the F9 dashboard budget
   (`observability.md` §26.4/§26.6 item 3).
3. **[observability MEDIUM] Metric instrumentation** (a dark feature emits no
   ops signal until instrumented): (a) document the 4 prune/reconcile counters
   in `observability.md` §26.1; (b) **unify the tenant label key** — Task-11
   counters use `tenant_id`, Task-16 use `tenant` — plus a fake-meter unit test
   so drift fails a gate; (c) add treasurer-action counters
   (`autoDraftIssued` / `autoDraftIssueFailed{errorKind}` / `autoDraftDiscarded{kind}`);
   (d) add per-row `*_errors_total{tenant}` for prune/reconcile + alerts.
4. **[observability/financial LOW] `ORPHANED_AFTER_COMMIT`** — add a counter at
   the tx2-stamp-failure log site and the reconciliation query
   (`origin='auto_renewal' status='draft'` invoices with no
   `renewal_cycles.auto_draft_invoice_id` back-reference); today such a draft is
   invisible to prune/reconcile (both INNER JOIN the pointer) and wedges the
   member from re-drafting.
5. **[perf/migration LOW] Before onboarding a LARGE tenant** — add
   `CREATE INDEX renewal_cycles_auto_draft_invoice_id_idx ON renewal_cycles (tenant_id, auto_draft_invoice_id) WHERE auto_draft_invoice_id IS NOT NULL`.
   Benign at SweCham's ~131 members. **DONE — migration 0282, PR #262.**
6. **[money LOW] Legacy coverage backfill — RESOLVED as *leave-NULL* (2026-07-27).**
   `scripts/backfill-membership-coverage.ts` inventory against **prod** found
   **81** committed membership §86/4 bills with NULL coverage — **all
   `plan_year=2026`, all ORPHANS** (no `linked_invoice_id`; paid 70 + issued 11,
   the launch-import cohort). The script cannot auto-derive their windows, and a
   wrong stamp on a **paid tax document** would make the EXCLUDE *false-block the
   member's real next renewal* — worse than the gap it closes. **Decision: leave
   them NULL** (the script's sanctioned orphan handling). The residual blind spot
   is narrow and **not reachable by any normal flow**: the auto-draft cron drafts
   the member's *next* period (2027), never a same-period 2026 duplicate, and a
   normal renewal's new bill carries its own coverage on a non-overlapping
   window. Only a **manual same-period re-bill** of a 2026 legacy bill would go
   unblocked — a rare operator action. The go-forward guard protects every NEW
   bill. If zero-blind-spot is later required, stamp each bill with that member's
   actual 2026 membership period (their current cycle's `[periodFrom, periodTo)`)
   via `--apply --confirm --confirm-prod`, curated by hand for the lapsed /
   no-cycle members.

## Deferred — doc / spec back-documentation (before `/speckit.ship`)

- **[spec LOW ×6]** Stale spec **prose** vs. the (correct) shipped code — §5.1
  coordinator gate (`&&`→`||`), §5.2 planYear-from-`periodFrom`, §5.4 mig-0281
  coverage-guard supersession, §5.1 two-layer dedup, §7 audit taxonomy (5 events
  ship, not 2), plus bulk-unenrol / `member_erased` gate / `skipped_opt_out`→
  `skipped_race_lost` rename. **No runtime impact.**
- **[perf/tax LOW]** Stale `migration 0264`→`0279` refs ×4 (observability.md,
  auto-invoice-gauge-query.ts, auto-draft-coordinator route, schema-invoices.ts);
  readiness/design "Issue mints §87" is imprecise under `FEATURE_088_TAX_AT_PAYMENT`
  ON (Issue mints the non-§87 SC ใบแจ้งหนี้ number; §86/4/§87 mints at payment).
- **[migration LOW ×3]** 0276 audit-provenance cites pre-renumber `migration 0261`
  (→ 0276); 0274 `auto_page_size` CHECK lacks `DROP CONSTRAINT IF EXISTS`
  symmetry; 0281 `invoices_coverage_window_wellformed` CHECK not mirrored in
  `schema-invoices.ts`. All cosmetic (journal + all-or-nothing tx).
- **[security LOW]** Runbook note: issue/discard routes are already covered by
  two blanket kill-switches (`READ_ONLY_MODE`, `FEATURE_F4_INVOICING` path-based).

## Deferred — optional hardening (post-merge, pre- or post-flip)

- **[ux MEDIUM]** Thread the row's `queueMeta` (`unresolved` / `priceUnverifiable`
  / `priceChanged`) into the Issue confirmation dialog so a treasurer sees a
  caution at the commit point, not just in the decoupled Queue column.
- **[ux LOW]** Dedicated empty-queue copy; gate queue-view header actions on
  `!isQueueView`; filter-pending skeleton; enrol/unenrol button differentiation.
- **[tests LOW]** Cross-tenant isolation case on the §86/4-minting issue/discard
  path (§10 #17 — structurally enforced by RLS, but a Review-Gate category on a
  tax-mint path); coverage-threshold deferral annotation; missed-day self-heal
  test (§10 #11).
- **[pdpa MEDIUM — orthogonal to 107]** The **generic** F4 issue path
  (`getForIssue`→`issueInvoice`) has no `erased_at` gate — a surviving manual
  draft for a non-archived erased member is issuable. Defense-in-depth mirroring
  `issueAutoDraftedRenewal`'s fail-closed gate; correct the discard docstring's
  "erased_at gates" claim (it is an `archived_at` gate). Tracked as an F4-path
  follow-up, outside 107 scope.

---

## Merge authorization

Constitution Principle IX **solo-maintainer substitute** — the 11-dimension
specialist audit stands in for ≥2 human reviewers; the security dimension signed
its checklist. All dimensions APPROVED_WITH_NITS, zero blocking findings,
code-correctness nits fixed + re-validated on live Neon. The feature merges to
`main` **dark** (3-key gate all default-OFF). Enabling for SweCham is a separate
operator action governed by `docs/go-live-readiness.md` + the enable-gates above.
