# F6 EventCreate Integration — Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 16 confirmed defects (22 sub-fixes) from the 2026-07-06 full F6 review so the live CSV/match/quota/erasure path is correct for SweCham launch, then make the dormant EventCreate webhook path safe to enable.

**Architecture:** F6 = `src/modules/events/**` (Clean Architecture: domain → application use-cases → infrastructure repos) + presentation in `src/app/(staff)/admin/events/**`. Both the LIVE CSV import path and the DORMANT webhook path funnel through one shared helper `process-attendee-in-tx.ts` (match → event bind → registration insert → quota); the `input.targetEvent` discriminator (CSV always sets it since the 095 dup-fix; webhook never does) is the isolation contract. Quota is NEVER stored — computed on read via `SUM` over `counted_against_*` flags, serialized by per-`(tenant,member,…)` advisory locks.

**Tech Stack:** Next.js 16 App Router · React 19 · TypeScript strict · Drizzle ORM + Neon Postgres (RLS via `runInTenant` tx) · next-intl (EN canonical + TH + SV) · Vitest (unit + live-Neon integration) + Playwright.

## Global Constraints

- **Tenant isolation (Principle I, NON-NEGOTIABLE):** every tenant-scoped repo query MUST thread `tx` from `runInTenant` (never the global `db`). Every new integration test MUST include a cross-tenant probe (Review-Gate blocker).
- **TDD (Principle II, NON-NEGOTIABLE):** failing test → commit red → implement → commit green. Integration tests hit live Neon `dev` branch.
- **Clean Architecture (Principle III):** Application imports Domain + its own ports only; no framework/ORM imports leak up.
- **i18n:** EN is canonical (missing EN key fails build); TH + SV must be added or release CI fails `check:i18n`. Grep all consumers on any key rename (MISSING_MESSAGE runtime risk).
- **Logs:** never log attendee email/name/company (the exact PII being erased). Log `registrationId` / `tenantId` / error-constructor-name only — a PostgresError can embed SQL param values = PII.
- **Migrations:** apply to dev + run `pnpm test:integration` BEFORE committing any migration (enum ADD VALUE can print ✓ while absent). Only ONE fix (W#9) needs a migration.
- **Commits:** Conventional Commits, `[Spec Kit]` prefix, `Co-Authored-By: Claude Opus 4.8 (1M context)`. Stage explicit paths — NEVER `git add -A` (stray OneDrive zip + untracked `docs/uat/` carry PII). Never `git stash` (concurrent-session tree). Re-check branch before each commit batch.
- **Decisions locked (2026-07-06):** FR-026 = **BUILD** the full CSV remap (#10a + #10b), EventCreate/SweCham path first (Phase 4). FR-032a = **BUILD** the by-email erasure surface (P1–P4, not the P5 deferral). Scope = **CSV-FIRST** — **Phase 3 (webhook-gate: W#1 · W#2 · W#9 · W#14 + F6-3 rate-limit) is DEFERRED** until the EventCreate webhook path is actually enabled (it is not used at SweCham; CSV import is the live primary path). **Active scope = Phase 1 + Phase 2 + Phase 4.** Do the Phase-3 work as a bundle only when someone decides to turn the webhook on for a tenant.

---

## Phase & PR Overview

| Phase | Goal | PRs | Effort |
|-------|------|-----|--------|
| **1** | SweCham-blocking correctness (LIVE CSV/match/quota path) | 1.1 Match · 1.2 Badge · 1.3 CSV preview · 1.4 Quota-lock cluster | 7S + 1M |
| **2** | PDPA by-email cross-event erasure (live compliance gap) | 2.1 Erasure backend · 2.2 Erasure surface | 1S + 3M + 1L |
| **4** | Cleanup / spec reconciliation | 4.1 Spec+RBAC (F6-12 + F6-17) · 4.2 CSV remap | 2S + 1M |
| ~~**3**~~ | ~~Webhook-gate~~ **DEFERRED** (webhook not enabled) | 3.1 · 3.2 · 3.3 + F6-3 | 5S + 1L *(not counted below)* |

**Active roll-up (Phase 1 + 2 + 4):** 10 S · 4 M · 1 L. **Migrations: 0** (the only migration, W#9, is in the deferred Phase 3). **≥2-reviewer + security-checklist PRs: 3** (1.4, 2.1, 2.2). **Minimal SweCham launch gate = Phase 1 + Phase 2 (13 fixes).** Phase 4 is post-launch cleanup. **Deferred (Phase 3, do when enabling the webhook): W#1, W#2, W#9 (+migration, ≥2 reviewers), W#14 (PII sign), F6-3.**

### Highest-risk diff (integration-test gate before commit)
- **#8** (`buildQuotaLockKey` signature change, 7 call sites) mutates the shared live-CSV helper `process-attendee-in-tx.ts` — run `pnpm test:integration` on the events module + keep the CSV-green regression suite as the merge gate. *(The other high-risk diff, W#9, is in the deferred Phase 3.)*

---

## PHASE 1 — SweCham-blocking correctness

### PR 1.1 — Match engine (M4 + M5 + M6, one PR)

All three edit `src/modules/events/infrastructure/drizzle-attendee-matcher.ts` (the shared match pipeline both CSV + webhook funnel through). Do the `import { and, asc, eq, isNull, sql } from 'drizzle-orm';` edit (line 25) ONCE. Author all new integration tests first (commit RED), then apply edits (commit GREEN). Gate: existing `match-attendee-to-member.test.ts` (5 outcomes) + `csv-webhook-equivalence` + `quota-accounting` stay green.

#### Task M4: raise fuzzy threshold 2 → 3 (FR-012)

**Files:**
- Modify: `src/modules/events/infrastructure/drizzle-attendee-matcher.ts:43` (+ comment lines 19), `src/modules/events/application/ports/attendee-matcher.ts` (comments ~11/39-42)
- Test: `tests/integration/events/match-attendee-to-member.test.ts` (line 244 assertion + new case)

- [ ] **Step 1 (RED):** append an integration test — seed ONE member normalised `zephyr robotics` (companyName `Zephyr Robotics AB`), attendee company `Zephyr Rabotix` (Levenshtein 3, unique in pool). Assert `resolution.type === 'member_fuzzy'`, `matchedMemberId === seeded`, `fuzzyDetail.levenshteinDistance === 3`. Run → FAIL (distance-3 filtered at threshold 2 → non_member).
- [ ] **Step 2 (GREEN):** change `const DEFAULT_FUZZY_THRESHOLD = 2;` → `= 3;`. Fix the misattributing comments (matcher L19 `(default 2 per research.md R4)` → `(default 3 per research.md R4 / FR-012)`; port comments to `<=3`). Retarget the existing assertion `toBeLessThanOrEqual(2)` → `(3)` (its fixture distance is 1, still passes).
- [ ] **Step 3:** run the 5-outcome suite → all green. Commit.

**Risk:** behaviour-changing on live CSV match (distance-3 → member_fuzzy — the intended spec effect). Only ADDS matches; verify no test asserted non_member on a now-in-range pair (checked: none).

#### Task M5: exclude soft-removed contacts from Rules 1 & 2

**Files:** Modify `drizzle-attendee-matcher.ts` (Rule 1 lines 85-90, Rule 2 lines 122-127, import line 25); Test `match-attendee-to-member.test.ts`

- [ ] **Step 1 (RED):** two new integration tests. (a) Rule 1: member whose ONLY email-matching contact is soft-removed (`removed_at = NOW()`), attendee email = that address → assert `resolution.type !== 'member_contact'`. (b) Rule 2: member whose ONLY `@ghost-co.example` contact is soft-removed, attendee `new@ghost-co.example` → assert `!== 'member_domain'`. Run → FAIL (removed contact wins).
- [ ] **Step 2 (GREEN):** add `isNull(contacts.removedAt)` to the `and(...)` in Rule 1 and Rule 2. Add Rule 1 tie-break `.orderBy(asc(contacts.createdAt), asc(contacts.contactId))` before `.limit(2)`. Update the import to include `asc, isNull`.
- [ ] **Step 3:** all-active fixtures still green (filter is a no-op for them). Commit.

**Risk:** strictly safer (only removes soft-removed candidates). Synergy: erasure soft-removes contacts, so erased members also drop out of Rules 1/2.

#### Task M6: exclude archived/erased members from Rule 3 fuzzy pool

**Files:** Modify `drizzle-attendee-matcher.ts` (Rule 3 line 153); Test `match-attendee-to-member.test.ts`

- [ ] **Step 1 (RED):** two new integration tests. (a) archived-winner: seed an ARCHIVED member normalised `nimbus data`, attendee company `Nimbus Data`, unique → assert `!== 'member_fuzzy'`. (b) false-tie: ACTIVE `Nimbus Data Co` + ARCHIVED `Nimbus Data Limited` (both → `nimbus data`), attendee `Nimbus Data` → assert `member_fuzzy` AND `matchedMemberId === ACTIVE`. Run → FAIL.
- [ ] **Step 2 (GREEN):** change Rule 3 WHERE to `and(eq(members.tenantId, input.tenantId), isNull(members.archivedAt), isNull(members.erasedAt))`. KEEP inactive (non-archived) members in the pool — identity resolution, not quota-eligibility (excluding inactive would depress SC-002).
- [ ] **Step 3:** all-active pools return the same set → green. Commit.

**Note (do NOT widen this PR):** Rules 1/2 join a member only via `contacts.member_id` and never check the member's own status — an archived member's still-active contact can still resolve exact/domain. Lower-risk (high-certainty identity signal + admin can relink); file as a separate follow-up.

### PR 1.2 — Quota over-quota badge (#7, display-only)

**Files:** Modify `src/modules/events/application/use-cases/load-event-detail.ts:245-253`; Test `tests/unit/modules/events/load-event-detail.test.ts`

The current `isOverQuota = (isPartnerBenefit||isCulturalEvent) && isNonQuotaMatchType(match.type)` flags only non_member/unmatched (spurious per FR-013) and NEVER the real over-quota matched member.

- [ ] **Step 1 (RED):** rewrite the `it.each` fixture so it independently parameterises `matchedMemberId`, `paymentStatus`, and BOTH `countedAgainst*` flags. Author cases: (1) partner + member_contact + paid + partnership counted=false → `isOverQuota TRUE`; (2) …counted=true → FALSE; (3) partner + non_member + paid → FALSE; (4) partner + member_contact + pending → FALSE; (5) refunded → FALSE; (6) cultural mirrors; (7) both-flags independent scopes; (8) archived event → FALSE. Run → FAIL (old code encodes the buggy expectations).
- [ ] **Step 2 (GREEN):** replace the derivation: `eventActiveBenefit = event.archivedAt === null`; `isMatchedMember = match.matchedMemberId !== null`; `isConfirmedSeat = isQuotaCountedStatus(ticket.paymentStatus)`; `partnershipOver = eventActiveBenefit && event.isPartnerBenefit && isMatchedMember && isConfirmedSeat && !quotaEffect.countedAgainstPartnership`; `culturalOver` = same for cultural; `isOverQuota = partnershipOver || culturalOver`. Remove the `isNonQuotaMatchType` import; add `import { isQuotaCountedStatus } from '../../domain/value-objects/payment-status'`. This is the exact negation of apply-quota-effect's `quota_over_quota_warning` condition.
- [ ] **Step 3:** `attendee-table.tsx` already renders on `r.isOverQuota`; no presentation/i18n change. Commit.

**Risk:** display-only; keep the predicate aligned to the domain over-quota definition.

### PR 1.3 — CSV mismatch preview preservation (#11)

**Files:** Modify `src/components/events/csv-mapping-form.tsx` (submitImport ~L280, mismatch branch L321-330, callers L470-480); Test `tests/unit/components/events/csv-mapping-form.test.tsx` (new)

On `event_mismatch_warning` the form overwrites `phase.preview` with an EMPTY literal; dismissing the dialog leaves a blank preview + an enabled "Confirm and import 0 rows" loop.

- [ ] **Step 1 (RED):** new RTL test. Mock `global.fetch` → `{status:200, json:()=>({kind:'event_mismatch_warning', priorImports:[…]})}`; mock `@/components/events/event-picker` to a stub calling `onChange(fixedEventId)`. `userEvent.upload` a 3-row File. Assert: mismatch dialog appears; after Escape/Cancel the PreviewPanel still shows "Preview (3 rows)" and the Confirm CTA text contains "3" (not "0"); a second Confirm re-opens the dialog with count still 3. Use `findBy*`/`waitFor` (jsdom + Radix focus-effect hang). Run → FAIL.
- [ ] **Step 2 (GREEN):** change `submitImport(file, forceProceed)` → `submitImport(file, forceProceed, preview: PreviewData)`. In the `event_mismatch_warning` branch keep `setMismatchDialog({open:true, priorImports})` but restore `setPhase({kind:'preview', file, preview})` with the passed-in REAL preview. Update callers under their `phase.kind==='preview'` guards: onSubmit → `submitImport(phase.file, false, phase.preview)`; onContinueDespiteMismatch → `void submitImport(phase.file, true, phase.preview)`. (Deps array `[selectedEventId,t,tErrors]` unchanged — preview is a param.)
- [ ] **Step 3:** confirm "Continue anyway" still passes the REAL preview. Commit.

**Risk:** low, edge-triggered (FR-019b safety net only). Shares `submitImport` with #10a → ship #11 FIRST, rebase #10a onto it.

### PR 1.4 — Quota lock cluster (#8 → #13 → #16, bundled, ≥2 reviewers + security checklist)

Ordered commit series; #8 foundational, #16 shares the erase.ts region with #8.

#### Task #8: year-scoped cultural quota lock (fix double-decrement)

**Files:** Modify `apply-quota-effect.ts` · `_helpers/process-attendee-in-tx.ts` · `import-csv.ts` · `toggle-event-category.ts` · `archive-event.ts` · `relink-registration.ts` · `erase-attendee-pii.ts` · `ports/advisory-lock-acquirer.ts` (JSDoc); Tests `apply-quota-effect.test.ts` · `ingest-webhook-attendee.test.ts` · `tests/integration/events/quota-concurrency.test.ts`

Cultural quota is per-`(member, YEAR)` but the advisory lock is per-`(member, EVENT)` → two concurrent cultural events double-decrement a 1/year allotment. **Chosen: Option A′** — single year-scoped lock (coarsens partnership per-event → per-year; correctness-safe, negligible concurrency cost at STD scale). Rejected: A-literal (dual locks — larger diff) and B (stored counter — contradicts the never-store-quota invariant + needs a migration).

- [ ] **Step 1 (RED):** add a deterministic sub-test to `quota-concurrency.test.ts` — Large-tier member (culturalPerYear=1), TWO `is_cultural_event=true` events same calendar year, concurrent `ingestWebhookAttendee` via `Promise.all` + random delays → assert `SUM(counted_against_cultural_quota) === 1`. Run → FAIL (=2 under per-event lock). Also add a partnership regression sub-test (two partner events, allotment 6 each → each reaches 6).
- [ ] **Step 2 (GREEN):** change `buildQuotaLockKey(tenantId, memberId, eventId)` → `(tenantId, memberId, fiscalYear: number)` returning `eventcreate-quota:${tenantId}:${memberId}:${fiscalYear}`. Update ALL 7 call sites to pass the year in scope: apply-quota-effect (`input.fiscalYear`), toggle-event-category, archive-event, relink-registration (2 sites) already have a `fiscalYear` var; process-attendee-in-tx (refund branch) + import-csv (state-change) derive `deriveFiscalYear(event.startDate.toISOString(), F6_FISCAL_YEAR_START_MONTH)`; erase-attendee-pii loads the event via the already-declared-but-unused `deps.eventsRepo.findById(tenant, registration.eventId)` (this load also feeds #16). Update JSDoc documenting the deliberate partnership coarsening.
- [ ] **Step 3:** update unit lock-key assertions (`apply-quota-effect.test.ts:455-477` → `:${YEAR}`; `ingest-webhook-attendee.test.ts:456` regex last segment `evt-…` → `\d{4}`). `grep 'buildQuotaLockKey(' ` confirms all 7 updated; `typecheck` catches any missed 3rd arg. Run `pnpm test:integration` (mandatory before commit). Commit.

**Risk:** HIGH blast radius (shared lock primitive, 7 sites). Rolling-deploy window where old/new key holders coexist = the pre-existing bug, tx-short. No migration.

#### Task #13: relink gates decrement on paid|free

**Files:** Modify `relink-registration.ts` (step 6, lines 555-646); Tests `relink-registration.test.ts` (unit + integration)

Relink sets `counted_against_*=true` from event flags + allotment only, never `paymentStatus` → relinking a refunded/pending seat consumes a benefit ticket.

- [ ] **Step 1 (RED):** unit — relink a `pending` registration onto member B (partner event, room) → assert `quotaImpact.decrementedFor === null`, `countedAgainstPartnership === false`, NO `quota_partnership_decremented` audit. Add a `refunded` variant. Regression: `paid` → still decrements. Mixed: `pending` row whose OLD member had counted=true → OLD credit-back (step 5) STILL fires while NEW decrement does not. Cultural mirror. Run → FAIL.
- [ ] **Step 2 (GREEN):** above step 6 compute `const seatCountsTowardQuota = isQuotaCountedStatus(registration.ticket.paymentStatus)`; change guards to `if (event.isPartnerBenefit && seatCountsTowardQuota)` / `if (event.isCulturalEvent && seatCountsTowardQuota)`. When not counting: `nextPartnership/nextCultural` stay false, emit NO quota audit for the new side (quota-neutral, NOT over-quota). Leave step 4b lock + step 5 OLD credit-back UNCHANGED. Add `import { isQuotaCountedStatus } from '../../domain/value-objects/payment-status'`.
- [ ] **Step 3:** commit after #8 (shares the file; different regions).

**Risk:** localized to step 6. Guard: the paid regression + `pending`-with-old-counted tests pin that step-5 credit-back stays payment-status-independent.

#### Task #16: erase re-reads quota flags under the lock

**Files:** Modify `erase-attendee-pii.ts:229-236`; Test `tests/unit/modules/events/erase-attendee-pii.test.ts`

Quota flags are read pre-lock → a concurrent toggle/refund makes the credit-back audit `quotaReversals` count stale.

- [ ] **Step 1 (RED):** unit via a seam — stub `registrationsRepo.findById` returning counted=true on initial load, counted=false on the post-lock re-read → assert `quotaReversals === {partnership:0, cultural:0}` and NO `quota_credit_back_archive` audit. Inverse (false→true) fires credit-back. Null re-read → graceful completion, no throw. Assert lock acquired BEFORE the re-read (call-order on the mock acquirer). Run → FAIL.
- [ ] **Step 2 (GREEN):** (a) widen the lock gate to `memberId !== null`; (b) after acquire, re-fetch via `deps.registrationsRepo.findById(tenant, registrationId)` INSIDE the lock and recompute `wasPartnership/wasCultural/memberId` from the fresh row (reuse #8's event load for the year); (c) emit credit-back + count reversals from the fresh flags. Null re-read → treat as already-handled. Keep `pii_erasure_requested` (step 3) pre-lock.
- [ ] **Step 3:** preserve the registration-not-found idempotency + event_path_mismatch guards. Commit (same series as #8).

**Risk:** audit-fidelity only (row still hard-deleted; live consumed self-heals on read). `launch_priority: cleanup` but rides PR 1.4 (shared region + depends on #8's year-lock).

---

## PHASE 2 — PDPA by-email cross-event erasure (finding #15)

SweCham's CSV path ingests NON-MEMBER attendees; the COMP-1 member cascade keys on `matched_member_id` and never reaches them → today a multi-event guest is only erasable via raw `neondb_owner` SQL (RLS-bypass), risking SC-012 (30-day) + Art.17 completeness. `findByEmailLower` is a `not_implemented` stub; no route calls it → purely additive. NO migration (reuses index 0131 + shipped audit events).

### PR 2.0 (rider on 2.1) — Task P0: fix stale runbook status

**Files:** Modify `docs/runbooks/f6-manual-erasure.md`

- [ ] Scope the "INTERIM — superseded by T110" claim to per-registration erase only; add a §2 banner that cross-event by-email enumeration is manual until the surface ships (ticket ref) and MUST run to completeness. (Mandatory regardless of build/defer — removes contradictory DPO guidance.) Commit.

### PR 2.1 — Erasure backend (P1 + P2 + P3), ≥2 reviewers + security checklist

#### Task P1: real `findByEmailLower`

**Files:** Modify `src/modules/events/infrastructure/drizzle-registrations-repository.ts:459-461`; Test `tests/integration/events/find-by-email.test.ts` (new)

- [ ] **Step 1 (RED):** integration test on live Neon — tenant A: 3 regs sharing `lower('Guest@X.com')` across 2 events + 1 different-email reg → assert `findByEmailLower` returns exactly the 3, `registeredAt DESC`; a pseudonymised row for the same email is NOT returned; **cross-tenant probe** (tenant B → `[]`); mixed-case input hits the lowered column. Expect `ok(array)` while stub returns `err(not_implemented)` → RED.
- [ ] **Step 2 (GREEN):** implement the declared port signature — `executor.select().from(eventRegistrations).where(and(eq(tenantId), eq(attendeeEmailLower, emailLower.toLowerCase()))).orderBy(desc(registeredAt), asc(registrationId)).limit(FIND_BY_EMAIL_CAP + 1)` using the threaded `executor` (tx from runInTenant). Add `const FIND_BY_EMAIL_CAP = 500`; slice to cap + `logger.warn({event:'f6_find_by_email_cap_hit', tenantId, cap})` (NO email/name). Map via `toAggregate`; catch → `wrapRepoError`. Rides index `event_regs_tenant_email_lower_idx` (0131) — no migration.
- [ ] **Step 3:** commit.

**Risk:** add of a dead stub — zero change to existing methods. Hazards: email in cap-hit log (log tenantId+cap only); missing `.toLowerCase()` (mixed-case test covers).

#### Task P2: `searchAttendeeRegistrationsByEmail` use-case (read)

**Files:** Create `src/modules/events/application/use-cases/search-attendee-registrations-by-email.ts`; Modify `src/lib/events-admin-deps.ts` (add `runSearchAttendeesByEmail`); Tests `tests/unit/events/search-attendee-registrations-by-email.test.ts` + `tests/integration/events/search-attendees-by-email.test.ts`

- [ ] **Step 1 (RED):** unit (mock repo + batch lookup) — asserts mapping shape, event-name enrichment join (one query, no N+1 via `makeEventDetailsBatchLookupForTenant.findByIds`), empty passthrough, repo-error → `Result.err`. Integration via `runSearchAttendeesByEmail` — 2 events + 3 same-email regs (partnership/cultural/non_member) → 3 matches with correct `eventName` + counted flags; cross-tenant probe → `[]`; no PII in logs. Run → FAIL.
- [ ] **Step 2 (GREEN):** pure Application use-case (no framework imports). Input `{tenantId, emailLower}` → `findByEmailLower` → enrich each `eventId` → `{registrationId, eventId, eventName, eventStartDateIso, matchType, countedPartnership, countedCultural, attendeeName, attendeeEmail, isPseudonymised}`. Composition wrapper `runSearchAttendeesByEmail(tenantSlug, {emailLower})` mirroring `runLoadEventDetail` (plain `runInTenant`). Batch-lookup error → degrade to null `eventName`, not 500.
- [ ] **Step 3:** commit.

#### Task P3: `eraseAttendeeRegistrationsByEmail` bulk fan-out (destructive)

**Files:** Create `src/modules/events/application/use-cases/erase-attendee-registrations-by-email.ts`; Modify `events-admin-deps.ts` (add `runEraseAttendeesByEmail`); Tests unit + `tests/integration/events/erase-attendees-by-email.test.ts`

- [ ] **Step 1 (RED):** unit mirrors `erase-all-registrations-for-member.test` — best-effort tallies (`erasedCount`/`alreadyErasedCount`/`failedCount`); a THROWN `eraseOne` → `failedCount`, loop continues (explicit throwing stub — mock-only suites miss this). Integration — 2 same-email regs (1 partnership-counted) → both hard-deleted + `pii_erasure_requested/completed` + 1 `quota_credit_back_archive` + `failedCount 0`; idempotent re-run → `alreadyErasedCount 2`, no new audits; cross-tenant probe → erases nothing. Run → FAIL.
- [ ] **Step 2 (GREEN):** near-clone of `eraseAllRegistrationsForMember` but enumerating by email. Input `{tenantId, emailLower, actorUserId, reasonText, occurredAt}`; deps `list` (→ `findByEmailLower`) + `eraseOne` (→ `runEraseAttendeePii`, **OWN `runInTenant` tx per row** — a shared tx would let one poisoned row abort the whole DSR). Error channel `never`; log failures with `registrationId` + error-constructor-name ONLY. Reuses shipped audit events (no new type). Wrapper `runEraseAttendeesByEmail(tenantSlug, input)`.
- [ ] **Step 3:** commit.

**Risk:** destructive path. Own-tx-per-row + surface `failedCount` (no reconciler on the admin path → admin clears stragglers via the per-row dialog). Bounded by `FIND_BY_EMAIL_CAP` + route `maxDuration=30`. **Separable:** P1+P2+P4-search alone close the enumeration gap; P3 is the "erase all in one action" ergonomics — can be an immediate fast-follow.

### PR 2.2 — Erasure surface (P4), L, ≥2 reviewers + security checklist

**Files:** Create `src/app/(staff)/admin/events/erasure/{page,loading,error}.tsx` · `src/app/api/admin/events/erasure/route.ts` · `src/components/events/erase-by-email-panel.tsx`; Modify `src/app/(staff)/admin/events/page.tsx` (discoverability Link) + `en/th/sv.json`; Tests `tests/contract/admin-events-erase-by-email.test.ts` + `tests/e2e/admin-events-erasure.spec.ts`

- [ ] **Step 1 (RED):** contract test for `POST /api/admin/events/erasure` — admin 200 tally shape; manager 403 + `role_violation_blocked` audit; member 404; flag-off 404; malformed email 400; missing reasonText 400. E2E — @a11y axe scan; @i18n EN/TH/SV resolve; happy path search → N rows → "Erase all" → toast → re-search 0. Run → FAIL.
- [ ] **Step 2 (GREEN):** SEARCH PAGE `/admin/events/erasure` (static segment — wins over `[eventId]`): flag-gate → notFound; admin-only per FR-035; zod-validate `?email=`; on valid call `runSearchAttendeesByEmail` → results table where each row embeds the SHIPPED `ErasePiiDialog` (posts to the existing per-reg /erase route) + an "Erase all N" button. Name-free `<title>` via `metaTitle`; sr-only aria-live count. BULK ROUTE `POST` (nodejs, maxDuration 30): zod body `{email, reasonText≤500}`; `adminOnlyWriterGuard`; `runEraseAttendeesByEmail` → 200 tally. CLIENT PANEL: email input pushes `?email=`; "Erase all" AlertDialog (reason textarea) → POST → toast summarising erased/alreadyErased/**failed** → `router.refresh`. Add the admin-only Link in `/admin/events` PageHeader actions. i18n: new `admin.events.erasure.*` block in all 3 locales.
- [ ] **Step 3:** `pnpm check:i18n` passes; `<title>` has no PII. Commit.

**Risk:** new destructive surface. `?email=` in the URL surfaces the DSR subject's own email in history (admin-only, acceptable — document it, keep out of audit summaries). If P3 slips, ship P4 WITHOUT "Erase all" (search + per-row erase alone closes the gap).

---

## PHASE 3 — Webhook-gate (enable the dormant webhook) — ⏸️ DEFERRED

> **DEFERRED (2026-07-06 decision): do NOT build this phase now.** The EventCreate webhook is not used at SweCham (CSV import is the live primary path), so none of these defects affect production. Build this entire phase — **W#2 → W#1 (PR 3.1), W#14 (PR 3.2), W#9 (PR 3.3), and F6-3 (rate-limit reconciliation)** — as a single bundle only when someone decides to enable the webhook for a tenant. The content below is the ready-to-execute spec for that future work; it is intentionally out of the active launch scope.

Gated on the F6-3 rate-limit reconciliation landing first. Causal chain: today every real Zapier delivery 401s at HMAC verify (W#2), so W#1/W#9 are moot until W#2 lands. Flip `FEATURE_F6…` webhook per-tenant only after 3.1+3.2+3.3+F6-3 land.

### PR 3.1 — Deliverable + safe (W#2 then W#1)

#### Task W#2: fix the Zapier walkthrough headers + HMAC recipe

**Files:** Modify `src/i18n/messages/{en,th,sv}.json` (phaseB.step6, en L4210-4214); Test `tests/unit/events/zapier-walkthrough-step6.test.tsx` (new)

- [ ] **Step 1 (RED):** test asserting step6 body names all three headers + the `<timestamp>.<rawBody>` HMAC recipe. Run → FAIL.
- [ ] **Step 2 (GREEN):** i18n-only (component renders `step{n}.title/body/alt`). Retitle step6 to cover signature + timestamp + request-id. Rewrite body to instruct, in order: (1) `X-Chamber-Timestamp` = current Unix epoch SECONDS, within 5 min of server time (FR-003); (2) `X-Chamber-Signature` = `sha256=` + HMAC-SHA256 keyed by the webhook secret over `<timestamp>.<rawBody>` (NOT body alone); (3) `X-Request-ID` = per-delivery UNIQUE (Zap run id / random GUID). Keep header token names + `sha256=`/`.` literal (untranslated) in TH/SV. Keep step numbering (5=map,6=headers,7=test,8=publish).
- [ ] **Step 3:** `check:i18n` passes. Commit.

#### Task W#1: per-delivery UUID fallback for absent X-Request-ID

**Files:** Modify `src/app/api/webhooks/eventcreate/v1/[tenantSlug]/route.ts:213-215`; Test `tests/integration/events/webhook-missing-request-id-idempotency.test.ts` (new)

- [ ] **Step 1 (RED):** integration — POST two DISTINCT attendee payloads (distinct event+attendee externalId), BOTH with NO `X-Request-ID`, same tenant/window → assert BOTH persist (2 registrations + 2 `webhook_receipt_verified`). Run → FAIL (2nd collapses to `no-request-id` → 409).
- [ ] **Step 2 (GREEN):** `import { randomUUID } from 'node:crypto'`; change derivation to `const requestId = rawRequestId.length > 0 ? rawRequestId : \`gen-${randomUUID()}\`;`. KEEP the `f6_webhook_missing_request_id` warn; KEEP the standalone-audit correlation emitting `rawRequestId.length>0 ? rawRequestId : null` (audit shows null, not the synthetic key); KEEP `NO_REQUEST_ID` (still used by the test-webhook fallback L720). Transport idempotency degrades to no-op for header-less deliveries → FR-011 `(tenant,event,externalId)` domain dedup governs.
- [ ] **Step 3:** commit (bundle with W#2 in PR 3.1).

**Risk:** route-only; webhook dormant → zero live blast radius.

### PR 3.2 — Task W#14: scrub metadata JSONB on pseudonymisation (PII/GDPR reviewer signs)

**Files:** Modify `src/modules/events/infrastructure/drizzle-registrations-repository.ts:922-980` (pseudonymiseRow); Test `tests/integration/events/pseudonymise-metadata-scrub.test.ts` (new)

- [ ] **Step 1 (RED):** integration — non_member reg with `metadata {phone,dietary}`, `registeredAt > 2y` → run `pseudonymiseStaleNonMemberPii` → assert `metadata === {}` AND email/name/company are `sha256:` hashes AND `pii_pseudonymised_at` stamped. Run → FAIL (metadata retains phone/dietary).
- [ ] **Step 2 (GREEN):** add `metadata: sql\`'{}'::jsonb\`` to the same `.set()` (column is jsonb NOT NULL DEFAULT '{}'). CSV rows already store `{}` → no-op for them; only webhook-origin rows affected (dormant). **Verify** the separate `eventcreate_adapter_metadata` column holds only adapter classification + consent text (not raw attendee free-text); if it does carry PII, null it in the same `.set()` (bumps effort to M).
- [ ] **Step 3:** commit. Independent — ship anytime in the phase (or pull into Phase 2 as cheap PDPA defense-in-depth if the PII reviewer is engaged).

### PR 3.3 — Task W#9: webhook pending→paid state-change (L, migration, ≥2 reviewers + security checklist)

**Files:** Modify `src/modules/events/application/use-cases/_helpers/process-attendee-in-tx.ts` (~L730) + audit-port.ts + schema.ts + `drizzle/migrations/*` (new) + both audit count/completeness tests; Test `tests/integration/events/webhook-pending-to-paid.test.ts` (new) + unit throw-path

Webhook pending→paid re-delivery never updates payment_status (ON CONFLICT identity no-op) nor decrements quota; `maybeApplyStateChange` exists only in the CSV importer.

- [ ] **Step 1 (migration):** hand-author `ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'webhook_registration_state_changed'` (per 0132/0137/0150). Apply to dev + run integration BEFORE committing (enum gotcha). Add the value in all 4 places: `F6_AUDIT_EVENT_TYPES` const + `AuditPayloads` map (audit-port.ts) + pg enum (schema.ts) + both count/completeness tests (43→44).
- [ ] **Step 2 (RED):** integration — deliver attendee as `pending` (member-matched, partner event) → row created, quota NOT counted; deliver SAME event+attendee externalId with a DISTINCT X-Request-ID as `paid` → assert `payment_status='paid'` AND quota decremented AND exactly one `webhook_registration_state_changed` audit. Plus a unit: a failing `audit.emit` in the new branch throws `TxStageError('audit_emit')` + rolls back. Run → FAIL.
- [ ] **Step 3 (GREEN):** add a state-change branch to the webhook side of the shared helper, GATED on `input.targetEvent === undefined` (webhook only — CSV always sets targetEvent since 095). Mirror the CSV `maybeApplyStateChange`: update payment_status + apply quota on the pending→paid boundary + emit the new audit. Consider a belt-and-suspenders `actorContext.actorType === 'zapier_webhook'` co-guard. Fix the misleading comment (L730-737).
- [ ] **Step 4:** REGRESSION — `csv-status-mirroring.test.ts` + `csv-state-change-quota-rollback.test.ts` stay GREEN (proves the targetEvent gate leaves the live CSV path untouched). Rebase on #8 (shared file). `pnpm test:integration` before commit. Commit.

**Risk:** HIGH — shared core of live CSV + webhook. Entire safety rests on the `targetEvent === undefined` gate + the CSV-green regression gate. Note an F6.2 follow-up to unify `maybeApplyStateChange` into the helper once webhook is live.

---

## PHASE 4 — Cleanup / spec reconciliation

### PR 4.1 — Spec + RBAC (F6-12 + F6-17)

> **F6-3 (rate-limit reconciliation) moved to the deferred Phase 3** — it only governs webhook ingest, which is off. Do it in the webhook bundle.

#### Task F6-12: rescope US5/FR-027/SC-006 to the single-event picker model — ✅ DONE (PR #170)
**Files:** `specs/012-eventcreate-integration/spec.md` (AS2 L130, US5 Independent Test L125, FR-027 L232, SC-006 L281)
- [x] Rescoped AS2 ("1,000 rows → 12 events" → "…→ 940 matched, 60 non-member; 0 events created"), the US5 Independent Test, FR-027 (added a post-095 picker-binding scope note: per-event registration/quota/match equivalence holds, event-count equivalence out of scope), and SC-006 to the picker-bound single-event model.

#### Task F6-17: align manager deny on the erase page — ✅ ACCEPTED (no change)
**Decision (2026-07-07):** the two erase surfaces (per-reg erase page + the by-email erasure page from PR #168) BOTH use `redirect('/admin/events')` for a non-admin — they are internally consistent, and the distinction from import/history's `notFound()` is defensible: Phase-1 reviewer #2 noted FR-035's "manager sees the surface" intent leans toward redirect over 404-surface-hiding, and both erase surfaces already 403+audit the actual mutation. Changing the by-email page (shipped + e2e-verified with redirect) to `notFound()` would churn approved code + require re-running its e2e for a LOW consistency nit. No code change.

### PR 4.2 — CSV remap (#10a + #10b) — rebase on #11 (Phase 1)

**Decision: BUILD (Option A).** EventCreate/SweCham path never triggers remap (canonical headers), so this serves non-EventCreate (Eventbrite/Meetup) tenants — schedule after Phase 1-2.

#### Task #10a: build the FR-026 "confirm or remap" Select UI + wire form→route
**Files:** Modify `csv-mapping-form.tsx` · `src/app/api/admin/events/import/route.ts` · `en/th/sv.json`; Test `tests/contract/events/csv-import-api.test.ts` + `csv-mapping-form.test.tsx` + `tests/e2e/csv-mapping-remap.spec.ts`

Backend chain (deps→use-case→parser) already consumes `columnMapping` on the generic path — the ONLY dead links are form→route.

- [ ] **Step 1 (RED):** route contract — append a `column_mapping` multipart field; assert `runImportCsv` called with `columnMapping:<Map>` keyed **CSV-header→canonical** (pins the direction-inversion, the top hazard); negatives → 400 `csv-column-mapping-invalid` (malformed JSON / non-canonical value / too many entries). Form RTL — non-canonical headers render a `<select>` per unmapped required column; Confirm enables only when all required mapped; submit carries an inverted `header→canonical` map. Run → FAIL.
- [ ] **Step 2 (GREEN):** FORM — hoist `Record<canonicalKey, csvHeader|''>` state outside the phase machine; replace the read-only chips (L788-816) with native `<select>` (options = `preview.detectedColumns`, default to identity match); recompute an "all required mapped?" gate; in `submitImport` INVERT selections to `header→canonical`, drop identity/unassigned entries, `fd.append('column_mapping', JSON.stringify(obj))` only when non-empty. ROUTE — read `formData.get('column_mapping')`; JSON.parse in try/catch → 400 on error/non-object; validate `Record<string,string>` every VALUE in the canonical set (reject unknown → 400), cap ≤19 entries + key length; `new Map(Object.entries(obj))` → pass `columnMapping` into `runImportCsv`. Add i18n keys (all 3 locales). deps/use-case/parser unchanged.
- [ ] **Step 3:** e2e drives the selects + asserts the success card (needs #10b or an event-name-column fixture). Commit (rebased on #11).

**Risk:** new external input boundary → fail-closed on malformed/oversized/non-canonical maps. Direction-inversion silently no-ops the feature — pinned by the contract test. Does NOT touch the shared parser/adapter — webhook + SweCham canonical imports unaffected.

#### Task #10b: relax the event_* required-gate on the picker-bound path
**Files:** Modify `src/modules/events/infrastructure/streaming-csv-importer.ts` (parseHeader L325-369, generic branch L855-872); Tests `streaming-csv-importer.test.ts` + `csv-import-selected-event-binding.test.ts`

- [ ] **Step 1 (RED):** parser unit — `parseStreamWithFormat` with a generic CSV of ONLY renamed `attendee_email`+`attendee_name` + a `columnMapping` + a `SelectedEventContext` → `ok format:'generic_csv'`, rows fill `event_*` from eventContext (NOT `invalid_header`). Regression — legacy `parseStream` (no eventContext) on the same 2-column CSV STILL `invalid_header` (proves the relaxation is scoped). Run → FAIL.
- [ ] **Step 2 (GREEN):** parameterise `parseHeader` to accept an explicit `requiredColumns` set (default = full 5, preserves legacy); in the generic branch (eventContext present) call with the reduced set `[attendee_email, attendee_name]`. `iterateGenericRowsWithEventContext` already fills `event_*` post-validation. FR-027 note for reviewer: persisted binding is picker-authoritative post-095, so accepting more source CSVs doesn't change persisted-state shape.
- [ ] **Step 3:** integration — Eventbrite-shaped CSV (no event columns) bound via picker + remap → registrations attach to the selected event. Commit.

**Risk:** touches shared `parseHeader` — relaxation MUST be scoped to the eventContext branch; the legacy-strictness regression test is the guardrail. Requires an FR-027 webhook-equivalence sign-off.

---

## Cross-fix shared-file map (conflict management)

| File | Fixes | Rule |
|------|-------|------|
| `drizzle-attendee-matcher.ts` | M4+M5+M6 | one PR (1.1); shared `isNull` import once |
| `process-attendee-in-tx.ts` | #8 (P1) + W#9 (P3) | **highest blast radius**; W#9 rebases on #8; CSV-green regression = merge gate |
| `buildQuotaLockKey` (advisory-lock port) | #8 | signature change → 7 call sites; `typecheck` is the net |
| `relink-registration.ts` | #8 + #13 | PR 1.4, different regions, #8 before #13 |
| `erase-attendee-pii.ts` | #8 + #16 | same region → one commit series, #8 first |
| `csv-mapping-form.tsx` + `submitImport` | #11 (P1) + #10a (P4) | #11 first, #10a rebases |
| `specs/012…/spec.md` | F6-3 + F6-12 | one pass (PR 4.1) |
| `drizzle-registrations-repository.ts` | W#14 + P1 | different methods, additive |
| `events-admin-deps.ts` | P2, P3, P4 | additive export wrappers only |
| `en/th/sv.json` | W#2, #10a, P4 | additive blocks; `check:i18n` parity gate |

**Audit-enum ceremony (4 places + migration) applies to W#9 ONLY** (`webhook_registration_state_changed`, 43→44).

---

## Self-Review — spec coverage

Every review finding maps to a task: #1→W#1, #2→W#2, #3→F6-3, #4→M4, #5→M5, #6→M6, #7→PR1.2, #8→#8, #9→W#9, #10→#10a+#10b, #11→PR1.3, #12→F6-12, #13→#13, #14→W#14, #15→P1-P4, #16→#16, #17→F6-17. Decisions recorded: FR-026 BUILD (#10a+#10b), FR-032a BUILD (P1-P4), **CSV-first — Phase 3 webhook DEFERRED** (W#1/#2/#9/#14 + F6-3 out of active scope until the webhook is enabled). No placeholders — every task carries exact files, a RED-first test, and the concrete edit. Type consistency: `isQuotaCountedStatus` (shared by #7/#13), `buildQuotaLockKey(tenant,member,fiscalYear)` (all 7 sites), `findByEmailLower(tenantId,emailLower)` (P1→P2→P3) are used consistently across tasks.

## Execution notes

- **Active order: Phase 1 → Phase 2 → Phase 4.** Phase 1 + Phase 2 is the SweCham launch gate; Phase 4 is post-launch cleanup.
- **Phase 3 (webhook) is DEFERRED** — not built until the webhook is enabled for a tenant. When that day comes, execute it as one bundle (W#2 → W#1 → W#14 → W#9 + F6-3); W#9 rebases on #8 and carries the only migration.
- Run each PR's tests + `pnpm lint && pnpm typecheck` before commit; `pnpm test:integration` before committing **#8** (and W#9 when Phase 3 is done).
- 3 active PRs need ≥2 reviewers, one signing the security checklist: **1.4, 2.1, 2.2**. (Deferred Phase 3 adds 3.3 + the 3.2 PII sign.)
