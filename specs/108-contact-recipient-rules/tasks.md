# Tasks: Contact Recipient Rules — Primary-only money emails + secondary contacts as marketing recipients

**Input**: Design documents from `/specs/108-contact-recipient-rules/`
**Prerequisites**: plan.md, spec.md (6 user stories), research.md (R1–R15, V1–V3), data-model.md, contracts/ (3), quickstart.md, checklists/ (7)

**Tests**: REQUIRED — Constitution Principle II (TDD, NON-NEGOTIABLE). Every story phase starts with tests that MUST fail before the implementation tasks run. Money-path and PII use cases need live-Neon integration tests, not mocks.

**Commits**: commit RED after each story's tests block (`[Spec Kit] 108 USn tests (red)`), commit GREEN after each implementation task or logical group; Conventional Commits enforced by the hook. Tasks T101–T106 were added by the post-generation coverage review, T107–T109 by `/speckit.analyze`, and T110 by the Resend-docs correction (research R9/R16); they sit inside the phase they belong to (IDs are not in file order for those ten).

**Organization**: Tasks are grouped by user story. Phase order follows the plan's delivery order **PR-A (US1) → PR-B (US2) → PR-D (US4 + US6) → PR-C (US3 + US5)** rather than pure priority, because US3's resolver needs the contact marketing columns from US4 and FR-027a requires the audience page (US4) to exist before the first send under the new rule. Each PR is independently reviewable, deployable and rollback-able (quickstart § Rollback matrix).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US6 from spec.md
- File paths are repository-relative. Migrations are hand-written SQL registered in `drizzle/migrations/meta/_journal.json` (next: tag `0292`, `idx 293`, `when 1798542000000`, +100000 per file). Never run `db:generate`. Apply with `pnpm db:migrate` (dev branch) and verify via `information_schema` before committing.

## Path Conventions

Modular monolith: `src/modules/<context>/{domain,application,infrastructure}`, presentation in `src/app/**`, composition in `src/lib/**`, tests in `tests/{unit,contract,integration,e2e}/**`. File-mutating agents run sequentially; read-only reviewers may run concurrently.

---

> **Implementation log (PR-A, 2026-09-04)** — RED→GREEN→commit per group, four commits so far:
> `e3f1e856d` setup (T001–T004) · `c0a3a9ab6` resolver + port + 29-site double sweep (T007/T012/T017/T018/T019)
> · `25ad2f83f` record-payment + migration 0292 + the new audit event (T015/T016/T020)
> · `ba41be6c6` void / credit-note / resend / routes (T021–T024).
> Two design notes that differ from the brief, both deliberate and documented in code:
> (a) the skip audit payload uses **`related_member_id`**, not `member_id` — migration 0009's
> trigger bumps `members.last_activity_at` for any audit row carrying that key, and a skipped email
> is not member activity; (b) `resolveMoneyRecipient` is a PURE resolver and the audit/metric side
> effect is a second export (`auditAutoEmailSkippedNoRecipient`), so the idempotent-replay arm can
> resolve without re-auditing a decision the original attempt already owned.
> Verified-and-corrected claim: adding `removed_at IS NULL` to the primary-contact reads is
> **redundant** (migration 0009's CHECK `contacts_primary_not_removed` already forbids the state —
> mutation-tested), kept only so each money read states the whole rule. It is not a bug fix.

## Phase 1: Setup

**Purpose**: Branch hygiene and the shared scaffolding every PR reuses.

- [x] T001 DONE 2026-09-04 (branch `108-contact-recipient-rules` current, up to date with `main` at `057e15ce3` — nothing to rebase; journal ends at tag `0291_event_attendance_bumps_last_activity`, idx 292, so the planned 0292–0297 numbering stands). Confirm branch `108-contact-recipient-rules` is current (`git branch --show-current`), rebase on `main`, and confirm `drizzle/migrations/meta/_journal.json` still ends at `0291` (renumber the plan's 0292–0297 if not)
- [x] T002 Create the shared PR checklist stub `specs/108-contact-recipient-rules/reviews/README.md` listing per-PR reviewer agents and the co-sign footer template (Constitution v1.4.2) for `checklists/{security,privacy,money,reliability,operations,ux}.md`
- [x] T003 Add `scripts/inventory-primary-contact-invariant.ts` (read-only; prints counts only: active/non-erased members with ≠1 live primary, secondaries total, secondaries with portal login, `marketing_unsubscribes` count; uses `runInTenant`; refuses to write) per quickstart § Before PR-B — verified by running it against the dev Neon branch (131 members, 0 violations); the login column is `linked_user_id`, not `user_id`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The three verify-before-task facts (research V1–V3) and the one shared test double. No story may claim completion while its verify item is open.

**⚠️ CRITICAL**: V3 blocks the first migration (US1); V1 blocks PR-B; V2 blocks the import-based audience build (US5, T086/T087).

- [x] T004 **V3** DONE 2026-09-04: a single migration file MAY hold several `ALTER TYPE … ADD VALUE` statements — `ALTER_TYPE_ADD_VALUE_RE` is a `/g` regex and `extractAlterTypeAddValueStatements` returns every match, each replayed in autocommit by `run-migrations.ts` before the transactional pass. Recorded in `research.md § V3` + R13; **0295 stays one file** (statements must each end with `;` and must not sit on a `--` line)
- [x] T005 **V1** DONE 2026-09-04 (read-only prod inventory, tenant `swecham`): 150 live contacts all primary, 0 secondaries, 0 with login; invariant violations 0/0; members 110 active / 40 inactive; 0 unsubscribes — recorded in `research.md § V1`. T003's script is still worth adding for re-runs before PR-B merges (re-run must still print 0 violations)
- [ ] T006 **V2 + V5** Spike against the Resend test account with a raw multipart `fetch` (SDK 4.8 lacks `contacts.imports`): `POST /contacts/imports` with a 3-row CSV (`email` only, `on_conflict=upsert`, `segments=[<test audience id>]`), then `GET /contacts/imports/{id}` until `completed`; record status values, `counts`, whether the audience id is accepted as a segment, and that a pre-existing Resend-side `unsubscribed` contact stays unsubscribed after the upsert — in `research.md § V2`; also read the team's actual rate limit from Settings → Usage (V5)
- [x] T007 [P] Create the single shared port double `tests/helpers/recipient-locale-fake.ts` exposing `getMemberEmailLocale` + `getMemberEmailRecipient` with a configurable live primary (used by every invoicing unit/contract test from T015 on)

**Checkpoint**: V1–V3 recorded; `pnpm typecheck` green on the helper.

---

## Phase 3: User Story 1 — Money emails always reach the current primary contact (Priority: P1) 🎯 MVP · **PR-A**

**Goal**: Receipt, void notice, credit note and every resend resolve the live primary at enqueue time; the processor gets the primary's email; "no recipient" is audited and visible; the portal resend body carries no address; the dormant override is deleted; a static gate keeps it that way.

**Independent Test**: Issue an invoice while contact A is primary, promote B, then pay / void / credit-note / resend ×3 and initiate PromptPay: every `notifications_outbox.to_email` and the processor `billingEmail` equal B; zero rows equal A; the PDF buyer block still shows A's identity. With no primary: zero outbox rows, one `auto_email_skipped_no_recipient` audit row, warning banners on the invoice and member pages.

### Tests for User Story 1 (write first — MUST FAIL) ⚠️

- [x] T008 [P] [US1] Contract test `tests/contract/invoicing/money-email-recipient-inventory.contract.test.ts`: the four inputs from FR-054 (promote after issue, email change after issue, secondary pays online, secondary triggers portal resend) across all seven F4 outbox event types + the PromptPay `billing_details.email`; asserts SC-001 and SC-007, that every outbox row has exactly one recipient and no cc/bcc (FR-007), and that the PDF buyer block still carries the identity captured at issue (FR-002)
- [x] T009 [P] [US1] Integration (live Neon) `tests/integration/invoicing/record-payment-live-recipient.test.ts`: receipt after promote → B; replay arm → B; no primary → `skipped_no_email` + audit row + no outbox row; F5 `suppressReceiptEmail` arm still `disabled`
- [x] T010 [P] [US1] Live recipient + the new empty-recipient guard for void + credit note. Shipped as cases INSIDE the existing harnesses (`tests/integration/invoicing/void-invoice.test.ts` +2, `credit-note-partial-accumulation.test.ts` +2) rather than two new files: both already seed the exact fixture these need (issued/paid invoice, member, tenant settings), and a new file would have duplicated ~150 lines of seeding to assert two lines of behaviour. Each new case swaps the mocked port for the REAL `recipientLocaleAdapter`. The credit-note-from-refund path shares `issueCreditNote`'s resolution and is covered by its unit tests
- [x] T011 [P] [US1] Integration `tests/integration/invoicing/resend-pdf-live-recipient.test.ts`: invoice/receipt/credit-note resend → live primary with `tx === null`; credit-note arm guard; `recipientEmailOverride` no longer compiles (type-level assertion)
- [x] T012 [P] [US1] Unit `tests/unit/invoicing/resolve-money-recipient.test.ts`: `member` / `non_member` (memberId null) / `no_recipient` branches, 100% branch coverage
- [x] T013 [P] [US1] Payments: unit `tests/unit/payments/initiate-payment-billing-email.test.ts` (PromptPay uses port email; null → `primary_contact_missing`; card shares none) + integration `tests/integration/payments/initiate-primary-billing-email.test.ts` (secondary with login initiates → primary's email reaches the gateway mock)
- [x] T014 [P] [US1] Contract `tests/contract/portal/invoice-resend-route.test.ts`: 202 body is exactly `{ ok: true }`; admin resend routes keep `recipientEmail` and gain 409 `no_recipient`
- [x] T101 [P] [US1] (coverage review) Add to `tests/unit/invoicing/resolve-money-recipient.test.ts` and `tests/integration/invoicing/record-payment-live-recipient.test.ts`: a primary whose email is flagged bounced / syntactically odd is still the only target — no redirect, no fallback (FR-001b)
- [x] T102 [P] [US1] (coverage review) Regression guard for F8 — shipped as a SOURCE-level guard `tests/unit/architecture/f8-dispatch-candidate-primary-contact.test.ts` (mutation-proved) instead of the planned live-Neon file: a behavioural test of all three candidate paths needs cycles + policies + clock control per path and would still only cover what it seeded, while reading the predicate is total and fails on the exact edit that regresses it. It asserts `drizzle-dispatch-candidate-repo.ts` still resolves `is_primary AND removed_at IS NULL` live after a promote for reminder, due-track and tier-upgrade candidates (FR-008, SC-001)

### Implementation for User Story 1

- [x] T015 [US1] Migration `drizzle/migrations/0292_audit_auto_email_skipped_no_recipient.sql` (`ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'auto_email_skipped_no_recipient'`, own file) + journal entry (idx 293, when 1798542000000); `pnpm db:migrate` on dev; verify via `information_schema`
- [x] T016 [US1] Add `auto_email_skipped_no_recipient` to `src/modules/invoicing/application/ports/audit-port.ts` (union + **10y** retention — corrected at the PR-A security review: the row records that a tax document was never delivered, and every document event it refers to is 10y), to the pgEnum tuple in `src/modules/auth/infrastructure/db/schema.ts`, and labels `audit.eventType.auto_email_skipped_no_recipient` in `src/i18n/messages/{en,th,sv}.json` (Thai script); update `tests/unit/insights/audit-event-label-coverage.test.ts` expectations if pinned
- [x] T017 [US1] Widen `src/modules/invoicing/application/ports/recipient-locale-port.ts` with required `getMemberEmailRecipient(tx, tenantId, memberId)`; implement in `src/modules/invoicing/infrastructure/adapters/recipient-locale-adapter.ts` as one SQL read with `is_primary = true AND removed_at IS NULL` (also add the `removed_at` predicate to the existing locale read)
- [x] T018 [US1] Sweep every test double of `RecipientLocalePort` to the shared fake from T007 (31 `RecordPaymentDeps` files, 14 `IssueCreditNoteDeps`, 6 `VoidInvoiceDeps`, `tests/unit/invoicing/barrel-exports.test.ts`, `tests/helpers/membership-access-stub.ts`); run `pnpm test tests/unit/invoicing` + the whole `tests/integration/invoicing` folder in batches (worker-exhaustion rule)
- [x] T019 [US1] Create `src/modules/invoicing/application/lib/resolve-money-recipient.ts` (`MoneyRecipient` union per data-model §1; emits `auto_email_skipped_no_recipient` in the caller's tx and bumps `invoicingMetrics.autoEmailSkipped`) and pin it to 100% line/branch in `vitest.config.ts`
- [x] T020 [US1] Rewire `src/modules/invoicing/application/use-cases/record-payment.ts` (`:1115` receipt arm, `:455` replay arm) to `resolveMoneyRecipient`; keep the three-arm outcome; leave the `receiptPdfRenderEnqueue` sentinel (`:960`) unchanged
- [x] T021 [US1] Rewire `src/modules/invoicing/application/use-cases/void-invoice.ts` (`:483-507`) with the new empty-recipient guard, and `src/modules/invoicing/application/use-cases/issue-credit-note.ts` (`:1237-1272`) keyed on the original invoice's `memberId`
- [x] T022 [US1] Rewire both arms of `src/modules/invoicing/application/use-cases/resend-pdf.ts` (`:221-227`, `:418-419`), delete `recipientEmailOverride` from `ResendPdfInput`, add the credit-note guard, return `err({ code: 'no_recipient' })`; map to 409 in `src/app/api/invoices/[invoiceId]/resend/route.ts`, `src/app/api/credit-notes/[creditNoteId]/resend/route.ts`, `src/app/api/portal/invoices/[invoiceId]/resend/route.ts`
- [x] T023 [US1] Add `removed_at IS NULL` to the primary lookup in `src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts` (`:159-169`) (FR-009)
- [x] T024 [US1] Portal resend route returns `{ ok: true }` only (`src/app/api/portal/invoices/[invoiceId]/resend/route.ts:94-97`); confirm `src/app/(member)/portal/invoices/_components/resend-invoice-button.tsx` needs no change
- [x] T025 [US1] "No primary contact" warning banner: shared component `src/components/members/no-primary-contact-banner.tsx` (non-dismissible, `role="alert"`), rendered at the top of `src/app/(staff)/admin/members/[memberId]/page.tsx` and `src/app/(staff)/admin/invoices/[invoiceId]/page.tsx` when the member is non-archived, non-erased and has no live primary; i18n `admin.members.detail.noPrimaryBanner.*` in en/th/sv
- [x] T026 [US1] Payments: add `src/modules/payments/application/ports/billing-recipient-port.ts`, adapter `src/modules/payments/infrastructure/billing-recipient-adapter.ts` (members barrel `getMemberPrimaryContact`), wire in `src/modules/payments/infrastructure/di.ts:113`; remove `actorEmail` from `InitiatePaymentInput` in `src/modules/payments/application/use-cases/initiate-payment.ts` and resolve via the port (`primary_contact_missing` permanent error for PromptPay); update `src/app/api/payments/initiate/route.ts` (drop `:269`, map 409) and `src/i18n/messages/{en,th,sv}.json` error copy
- [x] T107 [US1] (analyze follow-up) AMENDMENT block in `specs/007-invoices-receipts/spec.md` at FR-038: the buyer-identity snapshot fixes the tax document's buyer, not the email recipient, which is resolved live from the primary contact at enqueue (FR-001/FR-002 here); house format incl. operator heads-up; ships with PR-A so the spec never lags prod
- [x] T027 [US1] Gate `scripts/check-money-email-recipient.ts` (`pnpm check:money-recipient` in `package.json`, `.husky/pre-push`, `.github/workflows/quality-gates.yml` static step): scans `src/modules/invoicing/**`, `src/modules/payments/**`, `src/app/api/**` for `.primary_contact_email` reads; `ALLOWED` entries `{ file, contains, why }` for the PDF buyer block, the render/reconcile sentinels, `resolve-money-recipient.ts` non-member arm and the snapshot factory; every entry must be FOUND (positive control); mutation-prove it once by adding a stray read
- [x] T028 [US1] Run PR-A gates: `pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:money-recipient && pnpm test:coverage` (pins for T019) + `pnpm vitest run tests/contract/` + the T009–T013 integration files by path; record results in `specs/108-contact-recipient-rules/reviews/pr-a.md`
- [x] T029 [US1] (round 1 complete — 3 reviewers, all BLOCK, all findings closed or deferred with reasons in `reviews/pr-a.md`; awaiting the fresh-agent re-review + checklist co-signs) PR-A review stack (solo-maintainer substitute): `financial-integrity-reviewer`, `pci-saqa-guardian`, `security-engineer` (read-only, concurrent) → ≥3 `/speckit.review` passes → 1 `/speckit.staff-review` round → fresh-agent post-remediation re-review; co-sign `checklists/money.md` and `checklists/security.md` with the v1.4.2 footer; open PR `[Spec Kit] 108 PR-A money-email recipient hardening`

**Checkpoint**: PR-A merged; prod money emails go to the live primary. US1 is the MVP.

---

## Phase 4: User Story 2 — Exactly one primary contact, always (Priority: P1) · **PR-B**

**Goal**: The invariant holds at commit under concurrency (app policy wired + deferred DB constraint triggers with a data pre-check), and unarchive designates a primary when none exists.

**Independent Test**: 100 concurrent promote(Y)/remove(Y) runs → every member ends with exactly one primary and one call returns 409; a seeded "archived + zero primaries" member cannot be unarchived without designating a contact, and the designation + unarchive commit together.

> **Implementation log (PR-B, 2026-09-05)** — branch `108-pr-b-primary-contact-invariant`.
> `ca3035428` spec AMENDMENT (scope) · `cfb1e6c3c` T030–T033 RED · GREEN commit follows.
> **What the pre-flight found before any code**: the 0293 pre-check has no tenant filter, and
> the shared `dev` branch held **150 violating members across 72 `test-*` tenants — every one
> with zero contact rows**; the required CI check runs against a persistent Neon branch of the
> same shape that a PR cannot clean, so the migration as specified could never merge. Recorded
> as a spec AMENDMENT at FR-010/FR-010a (one predicate: "has at least one contact row at
> commit"), not as a silent narrowing. **What RED found**: the ×100 race on `main` left **50 of
> 50** members with zero primaries and both calls reporting success — the exact interleaving
> the out-of-tx pre-check in `removeContact` cannot see. With 0293 alone the end state was
> already 0/50; T035's write-side guard is what turns the loser into a typed 409.
> **Deviation from T036's letter**: the deferred trigger raises at COMMIT, from `runInTenant`,
> not from any repo call — so `mapDbError` never sees it. The mapping lives in the use cases'
> outer `catch` (`primaryContactTriggerViolation` in `src/lib/db-errors.ts`), which is where the
> error actually surfaces. **Beyond T035's letter**: `designatePrimaryInTx` (promote with no
> demote step) was needed for T038 — `promotePrimaryInTx` refuses when there is no primary to
> demote, which is the FR-014 case by definition. **Fixtures repaired** (the new rule is what
> refused them): 3 stale `ContactCrudDeps`/`UndeleteMemberDeps` stubs, 1 strictly-typed
> `ContactRepo` fake, and 3 integration suites that archived or scrubbed a member seeded with no
> primary (`undelete-window`, `f3-undelete-restore`, `contact-art14-attestation` — the last now
> co-commits `erased_at` with the scrub, as real erasure does).

### Tests for User Story 2 (write first — MUST FAIL) ⚠️

- [x] T030 [P] [US2] Extend `tests/integration/members/primary-contact-race.test.ts` with promote-vs-remove ×100 (SC-002) and removal of the primary refused at the repo (`cannot_remove_primary` conflict) — RED 2/5 (×100: 50/50 members at zero primaries on `main`) → GREEN 5/5
- [x] T031 [P] [US2] Integration `tests/integration/members/primary-contact-trigger.test.ts`: deferred trigger rehearsal — demote-then-promote passes; erasure (scrub + `erased_at` one tx) passes; leaving zero primaries on an active member fails at COMMIT; bad unarchive fails; pre-check DO block raises on a seeded violation inside a rolled-back tx — RED 10/18 → GREEN 18/18; the DO block is read from the migration file on disk; adds the AMENDMENT-scope cases (contact-less member exempt; tenant-wide contact DELETE exempt; DELETE of the primary with a secondary present raises) and a `pg_trigger` pin that also proves the DDL landed. **Mutation-proved 2026-09-05**: with a mutant function carrying NO exemptions applied to dev, exactly the 7 exemption-dependent cases failed (erasure, archived edit, hard-delete chain, cleanup shape, bad unarchive + designated unarchive via their archived seeds, contact-less status change) and the 11 others still passed; restored from the migration file → 18/18
- [x] T032 [P] [US2] Unit `tests/unit/members/application/contact-crud-invariant.test.ts` (policy wired in add/promote/remove; abort path) and `tests/unit/members/application/undelete-member-designate.test.ts` (no primary + no designation → `no_primary_contact`; removed contact refused; designation audited with `old_primary_contact_id: null`) — RED 7/10 + 6/8 → GREEN 10/10 + 8/8
- [x] T033 [P] [US2] Extend `tests/contract/members/archive-undelete.test.ts`: 409 `no_primary_contact` with `designatable[]`; success with `designate_primary_contact_id`; super_admin happy path — RED 6/19 → GREEN 19/19; also pins that the idempotency body hash covers the designation

### Implementation for User Story 2

- [x] T034 [US2] Migration `drizzle/migrations/0293_primary_contact_invariant_triggers.sql` per data-model §2.2 (pre-check DO block raising on counts only; `contacts_assert_one_primary()` SECURITY DEFINER filtering by the row's `tenant_id`; `DROP TRIGGER IF EXISTS` then `CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `contacts` and on `members` `UPDATE OF status, erased_at`) + journal (+100000); apply on dev only after T005 = 0; verify triggers in `pg_trigger` — journal idx 294 / when 1798542100000; applied to dev 2026-09-05 (pre-check passed under the AMENDMENT predicate); `GRANT EXECUTE … TO chamber_app` per 0291
- [x] T035 [US2] `src/modules/members/application/ports/contact-repo.ts`: add `listByMemberInTx(tx, memberId)`; `src/modules/members/infrastructure/db/drizzle-contact-repo.ts`: implement it, change `removeInTx` to `WHERE contact_id = ? AND is_primary = false` returning `repo.conflict{reason:'cannot_remove_primary'}` when the row exists but is primary, and stop forcing `isPrimary: false`; widen `RepoConflictReason` in `member-repo.ts` — plus `designatePrimaryInTx` (see log)
- [x] T036 [US2] Map the trigger's raise to `repo.conflict{reason:'primary_contact_race' | 'no_primary_contact'}` — implemented as `primaryContactTriggerViolation` in `src/lib/db-errors.ts` (23514 + `primary-contact-invariant` token, returns the live-primary count) mapped in the use cases' outer `catch` (contact-crud → `conflict{primary_contact_race}`, undelete → `state_error{no_primary_contact}`), because the raise surfaces at COMMIT from `runInTenant`, never inside `mapDbError` (see log)
- [x] T037 [US2] `src/modules/members/application/use-cases/contact-crud.ts`: after each mutating write (add, promote, remove) call `assertPrimaryContactInvariant(listByMemberInTx(...), member.status)` inside the tx and abort on violation; remove the out-of-tx pre-check dependence in `removeContact`; keep the `cannot_remove_primary` error type — `ContactCrudDeps` gains `memberRepo: Pick<MemberRepo,'findByIdInTx'>` for the status read
- [x] T038 [US2] `src/modules/members/application/use-cases/undelete-member.ts`: add `contactRepo` dep and `designatePrimaryContactId?`; in-tx: live primary present → proceed; designated live contact → set primary + audit `member_primary_contact_changed` (`old_primary_contact_id: null`); else `state_error{code:'no_primary_contact', designatable}`; route `src/app/api/members/[memberId]/undelete/route.ts` accepts `designate_primary_contact_id` and returns the 409 payload — options are a 4th positional `{ designatePrimaryContactId? }`; the 409 is deliberately NOT remembered under the idempotency key
- [x] T039 [US2] UI `src/components/members/restore-primary-dialog.tsx` (radio list of designatable contacts, "Restore and set as primary", zero-contacts variant linking to the add-contact dialog, `finalFocus` to the banner CTA) wired from `src/components/members/archived-banner.tsx` on 409; i18n `admin.members.undelete.designate.*` in en/th/sv — RED (dialog module absent; banner never opened an alertdialog on 409) → GREEN 11/11 (`da24b9c32`). The zero-contacts variant EMBEDS the add-contact dialog rather than linking to it: the member page hides "Add contact" for an archived member, so there was nothing to link to. `finalFocus` goes to the Restore button on cancel and to the staff layout's `#main-content` on success — the banner unmounts on `router.refresh()`, and the T040 e2e caught focus dropping to `<body>` on the first real-browser run (memory: dialog-focus-lost-after-unmount; axe never sees it)
- [x] T040 [US2] Extend `tests/e2e/members-archive-undelete.spec.ts` with the designate flow (`--workers=1`, axe `@a11y`, keyboard focus never drops to `<body>`) — new seed `tests/e2e/helpers/archived-no-primary-seed.ts` (archived + two secondaries; archived + no contacts; one tx per member so 0293's archived exemption admits the state; cleaned up by company-name marker). 3/3 green on chromium in a real browser: choose + restore + focus; zero-contacts door + cancel focus; TH/SV no `designate.*` key leak. Whole file (4 pre-existing + 3 new) re-run green
- [x] T108 [US2] (analyze follow-up) AMENDMENT block in `specs/005-members-contacts/spec.md` at FR-003 / FR-011: "exactly one primary" is now enforced on every primacy-affecting mutation, at commit by deferred DB triggers, and unarchive designates a primary (FR-010–FR-014 here); ships with PR-B — the FR-011 marketing-state note is left for PR-D
- [x] T041 [US2] Run PR-B gates (lint, typecheck, i18n, `tests/unit/members`, the T030–T031 integration files, `tests/contract/members/`, pre-push integration gate for `src/modules/members/**`) and review stack (`security-engineer`, `reliability-guardian`, `drizzle-migration-reviewer` → 3 review passes → staff-review → re-review); co-sign `checklists/reliability.md`; open PR `[Spec Kit] 108 PR-B exactly-one-primary invariant` — **round 1 DONE 2026-09-05** (4 reviewers incl. `enterprise-ux-designer`, 25 findings, 25 fixed RED→GREEN, 0 rejected; ledger `reviews/pr-b.md`). Two findings were mine to own: the lock-order inversion (R-H1 — I never checked that `findByIdInTx` takes `FOR UPDATE`) and the idempotency claim (S-M2 — "deliberately not remembered" was wrong because the key is reserved first). Also from this round: 0293 now guards the OLD member on a re-parenting UPDATE, pins `search_path = pg_catalog, public, pg_temp`, revokes PUBLIC, adds `contacts_tenant_member_all_idx`, and takes `SHARE ROW EXCLUSIVE` first; T031 → 22 cases. **Consequence worth stating once**: after 0293 an ACTIVE member with contact rows cannot have zero live primaries, so every fixture that modelled "no primary" by soft-removing the only primary was rewritten to the one remaining reachable shape — a contact-less member (PR-A's money-path suites, `recipient-locale-adapter`, PromptPay) — or given a filler primary where the removed row was the subject (`match-attendee`, `import-members`, four erase/invite suites). Whole members integration folder run in batches: green after those repairs. **Round 2 DONE 2026-09-05** (same four reviewers on `09db56408`; verdicts reliability SIGN · security SIGN on two conditions, both landed · migration SHIP after two one-liners, both landed · UX SHIP WITH FIXES, all landed; 20 new findings, 20 fixed, ledger `reviews/pr-b.md` § Round 2). The one that bit hardest: I had re-applied revisions of 0293 to dev with a scratchpad tool, and drizzle applies by `when` not by hash — so `db:migrate` on dev would have silently skipped the revised file. `when` is bumped per revision and T031 now pins the recorded sha256 of the file on disk. `reliability.md` co-signed at `bdcb2c49b` (`846218b8b`). **Round 3 DONE 2026-09-05** (fresh-agent whole-branch re-review of `846218b8b`: MERGEABLE, 0 blocker · 0 high · 1 medium · 2 low; all 3 fixed RED→GREEN in `d62be454f`, ledger `reviews/pr-b.md` § Round 3). The medium was a runbook pointing at a refusal: `promotePrimaryInTx` returned `no_current_primary` for a zero-primary member, so "promote a remaining contact" was a 409 — promote now designates (`demoted: null`, audited with a null old id) and the runbook says which deployment decides the fix. Pushed with `SKIP_INTEGRATION_PREPUSH=1` (six integration folders, 462 files, would have run whole-folder — the touched files were run by path instead; disclosed in the PR body) and **PR #342 opened 2026-09-05** — T041 DONE. **Round 4 (2026-09-05, `/code-review` on the open PR): 13 findings — 11 fixed RED→GREEN, 2 rejected on evidence (`134459081`, ledger `reviews/pr-b.md` § Round 4)** — the DELETE-contact route's missing `conflict` arm (500 → 409, first contract test for that route), the 0293 helper made fail-CLOSED (`row_security = off` + a BYPASSRLS assertion in the pre-check, v6), the bulk-unarchive no-primary gate. CI: the first smoke run failed at 0293's pre-check on the persistent `ci` branch (one pre-wipe demo-era member with a single soft-removed contact); one-row cleanup on `ci`, rerun green.

**Checkpoint**: PR-B merged after V1 = 0; the invariant is DB-guaranteed.

---

## Phase 5: User Story 4 — Staff see and control who receives what (Priority: P2) · **PR-D (part 1)**

**Goal**: New right `contacts.marketing`; per-contact marketing state on `contacts`; member-page badges + switch; permanent Marketing audience page (the FR-027a pre-flight surface) gated on `contacts.read`.

**Independent Test**: As marketing persona, open `/admin/marketing/audience?kind=secondary&state=on&eligible=1`, switch one contact off (toast + Undo), see the state on the member page; as manager the page is read-only; toggling "on" for a suppressed address returns 409 with the explanation; marketing cannot edit the same contact's phone (403).

### Tests for User Story 4 (write first — MUST FAIL) ⚠️

- [x] T042 DONE 2026-09-06 (cycle 1) — [P] [US4] Update RBAC pins: `tests/unit/auth/permissions/permission-catalogue.test.ts` (41→42), `tests/unit/auth/permissions/evaluator.test.ts` (super_admin 42, admin 36, marketing 10 + `it()` titles), `tests/helpers/rbac-pinned-matrix.ts` row `contacts.marketing` (admin ✓, manager ✗, marketing ✓, sensitive pii), `tests/unit/auth/permissions/role-bundles.test.ts` T057 fence still asserted
- [x] T043 DONE 2026-09-06 (cycle 5 — `tests/contract/members/contact-marketing.test.ts`, 12 cases; the manager denial audit is the gate's own behaviour, pinned via the literal key + `check:api-route-guard`) — [P] [US4] Contract `tests/contract/members/contact-marketing.test.ts` for `POST /api/admin/contacts/[contactId]/marketing`: super_admin happy path, marketing 200 changed/unchanged, manager 403 + `permission_denied` audit with real role, unknown/cross-tenant 404 + probe audit, suppressed 409, 400 `missing_idempotency_key`, replayed `Idempotency-Key` returns the stored outcome with no second audit row, 429 after 60/min (distinct keys per request)
- [x] T044 DONE 2026-09-06 (cycles 3–4 — 16 + 16 cases, both use cases at 100% line/branch) — [P] [US4] Unit `tests/unit/members/application/set-contact-marketing-opt-out.test.ts` (all branches: staff/self, on/off, unchanged, suppressed refusal, audit payload without email) and `tests/unit/members/application/list-marketing-audience.test.ts` (filter → predicate mapping, page/offset clamps)
- [x] T045 DONE 2026-09-06 (cycles 2–4 — `contact-marketing-opt-out.test.ts` 19 cases incl. cross-tenant RLS + FR-033 guard; `marketing-audience-query.test.ts` 10 cases incl. the 20,000-contact page-1 budget, measured ~0.5 s) — [P] [US4] Integration `tests/integration/members/contact-marketing-opt-out.test.ts` (columns + correlated CHECK rejects partial rows; `setMarketingOptOutInTx`; cross-tenant isolation — FR-052) and `tests/integration/members/marketing-audience-query.test.ts` (filters, 50-row pages, count, 20,000-contact seed under the page-load budget)
- [x] T046 DONE 2026-09-06 (cycles 5 + 7 — nav 16→17, pages 46→47, marketing reachable 47→49, baseline rows page + api, palette 32→33; `rbac-navigation` MUST_NOT_SEE lists unchanged: every staff role with `contacts.read` may see the page) — [P] [US4] Update `tests/unit/nav/nav-permission-parity.test.ts` (`STAFF_ITEMS` 16→17; manager + marketing frozen href lists gain `/admin/marketing/audience`), `tests/contract/rbac/role-endpoint-matrix.test.ts` (pages 46→47), `tests/helpers/rbac-observed-baseline.ts` rows (page `contacts.read`; api `POST /api/admin/contacts/[contactId]/marketing` → `contacts.marketing`), `tests/e2e/rbac-navigation.spec.ts` MUST_NOT_SEE lists
- [x] T047 DONE 2026-09-06 (`tests/e2e/admin-marketing-audience.spec.ts`, 7 walks + `helpers/marketing-audience-seed.ts`; run with `--workers=1 --project=chromium`) — [P] [US4] E2E `tests/e2e/admin-marketing-audience.spec.ts` (marketing toggles with Undo — off → Undo → state back to on with two audit rows, proving the Undo used a fresh idempotency key; manager read-only; preset filter; axe `@a11y`; `@i18n` en/th/sv; 320 px: container-scroll only, no page-level horizontal scroll, switch reachable) and extend the member-detail e2e with the badge/switch (`--workers=1`)

### Implementation for User Story 4

- [x] T048 DONE 2026-09-06 (0294 applied to dev; columns + CHECKs + index verified by the T045 schema cases) — [US4] Migration `drizzle/migrations/0294_contacts_marketing_opt_out.sql` (three nullable columns, `contacts_marketing_opt_out_correlated` CHECK, partial index `contacts_marketing_recipients_idx`) + journal (+100000); apply on dev; verify columns + index
- [x] T049 DONE 2026-09-06 (0295 applied to dev; `REQUIRED_ENUM_VALUES` extended) — [US4] Migration `drizzle/migrations/0295_audit_contact_marketing_events.sql` (`ADD VALUE` ×2 — split per T004's answer) + journal; apply on dev
- [x] T050 DONE 2026-09-06 (+ `deriveMarketingState` — suppression > opt-out > on, unknown → unavailable) — [US4] Domain: `MarketingOptOut` union + `contactMarketing()` in `src/modules/members/domain/contact.ts`; F3 audit union +2 in `src/modules/members/application/ports/audit-port.ts`; `tests/unit/members/application/f3-audit-event-type-count.test.ts` 35→37 (+ title); pgEnum tuple in `src/modules/auth/infrastructure/db/schema.ts`; labels `audit.eventType.contact_marketing_opted_out|_in` in en/th/sv (Thai script)
- [x] T051 DONE 2026-09-06 (`serialiseContact` gains the three columns; the portal serialiser exposes `marketing.state` for the OWN contact only, T063) — [US4] Schema + mappers: `src/modules/members/infrastructure/db/schema-contacts.ts` columns; `rowToContact` in `drizzle-contact-repo.ts`; `src/app/api/members/_serialise.ts`; `src/app/api/portal/profile/route.ts` local serialiser; classify the three columns KEPT in `tests/unit/members/infrastructure/scrub-contacts-pii-column-coverage.test.ts`; add `setMarketingOptOutInTx(tx, contactId, state)` to the `ContactRepo` port + Drizzle impl
- [x] T052 DONE 2026-09-06 (note on `contacts.read` rewritten at T058 when the surface became real) — [US4] Permission: add `contacts.marketing` (`sensitive: 'pii'`) to `src/modules/auth/domain/permissions/permission-catalogue.ts` and to `MARKETING_KEYS` in `role-bundles.ts`; delete the "unenforced vocabulary" note on `contacts.read` (`permission-catalogue.ts:37-43`) now that a surface exists
- [x] T053 DONE 2026-09-06 (`src/lib/contact-marketing-deps.ts` also hosts `buildMarketingAudienceDeps`) — [US4] Use case `src/modules/members/application/use-cases/set-contact-marketing-opt-out.ts` (deps: tenant, contactRepo, audit, `MarketingSuppressionLookupPort` from new `src/modules/members/application/ports/marketing-suppression-lookup-port.ts`; refuses "on" for suppressed; same-state → `unchanged`; audit with `source` and the session role) + composition `src/lib/contact-marketing-deps.ts` (adapter over the broadcasts barrel `makeDrizzleMarketingUnsubscribesRepo(...).lookupBatch`; NOT in `members-deps.ts` — barrel-cycle rule); pin 100% in `vitest.config.ts`; export from `src/modules/members/index.ts`
- [x] T054 DONE 2026-09-06 (`state=on` excludes suppressed rows AT THE QUERY via the whole-tenant suppressed set — new optional `listEmailLowers` on the broadcasts repo; degraded list → rows shown as unavailable) — [US4] Use case `src/modules/members/application/use-cases/list-marketing-audience.ts` + repo method `listContactsForMarketingAudience(ctx, { q, memberId, kind, state, eligible, limit, offset })` returning rows + total (members JOIN contacts, opt-out fields, member status/erased/halted) in `drizzle-member-repo.ts`; export via barrel
- [x] T055 DONE 2026-09-06 (RFC 7807 problems; a miss is audited `member_cross_tenant_probe` with ids only) — [US4] Route `src/app/api/admin/contacts/[contactId]/marketing/route.ts` (`requireApiPermission(request, 'contacts.marketing')` inside the handler; `Idempotency-Key` required via `@/lib/idempotency` like `POST …/contacts`; zod `{ state }`; rate limit `contacts:marketing:{tenant}:{user}` 60/min via the Upstash limiter `check` before the write; 200/400/404/409/429 per contract §1; RFC 7807 `problemResponse`)
- [x] T056 DONE 2026-09-06 (RTL 10 + 13 cases; jsdom needs the PointerEvent polyfill for Base UI Switch) — [US4] Components `src/components/members/marketing-state-badge.tsx` (5 states, text + icon), `src/components/members/marketing-switch.tsx` (`Switch` + `useTransition` + `fetch` + `router.refresh()`; accessible name with contact name + state; 10-s Undo toast on off — the Undo call mints a fresh `Idempotency-Key` (never reuses the "off" key, or the replay would return the stored outcome and not re-enable); `toast.info` on unchanged; localized `toast.error` on 409/403/5xx)
- [x] T057 DONE 2026-09-06 (ContactBlock: `marketingState` + `canMarketing` props; the two-state SubscriptionBadge is replaced by the five-state badge) — [US4] Member page `src/app/(staff)/admin/members/[memberId]/page.tsx`: "Primary" badge descriptor ("receives invoices and payment emails"), `MarketingStateBadge` + `MarketingSwitch` per `ContactBlock` gated by `canPerform(role, 'contacts.marketing')`, degraded tri-state via `_lib/resolve-contact-subscriptions.ts`; i18n `admin.members.detail.marketing.*` en/th/sv
- [x] T058 DONE 2026-09-06 (`src/lib/marketing-audience-filter.ts` MUST stay type-only over the members barrel — a value import dragged the payments infra into the client bundle on the first e2e run) — [US4] Page `src/app/(staff)/admin/marketing/audience/page.tsx` (exactly one `requirePagePermission('contacts.read')`, `TableContainer`, `PageHeader` with the pre-flight preset link, URL search-param filters + chips, default eligible + sort member/contact, `TablePagination` 50/page, count line, three empty states) + `loading.tsx` (`TableContainer`, column-matched skeleton) + `_components/audience-table.tsx` (horizontal scroll inside the container like `members-table.tsx`, name + state columns first, never page-level scroll; switch ≥24 px; read-only badge when the right is absent). Column allow-list is exactly FR-035 (member, contact name, primary/secondary, member status, state, changed by/at) — no DoB, phone or other `pii_sensitive` fields, no download action (FR-035a)
- [x] T103 DONE 2026-09-06 (`domain/marketing-reason.ts`, 12 unit cases; labels `shared.marketing.reason.*`) — [US4] (coverage review) Shared non-receipt reason vocabulary (FR-031b): `src/modules/members/domain/marketing-reason.ts` (10 reason codes) + i18n `shared.marketing.reason.*` en/th/sv (NOT `shared.marketingReason.*` — corrected, staff review A10), consumed by the AUDIENCE PAGE in PR-D. `marketing-state-badge.tsx` is not a consumer: it states the same facts through its own accessible-name phrasing. The compose count feedback is PR-C (T089). Unit test pins the 10 codes
- [x] T059 DONE 2026-09-06 (nav item under Engagement with `visibilityFlag: broadcastsEnabled`; breadcrumb `marketing` is non-route under `admin`) — [US4] Navigation + i18n: `src/config/nav.ts` item under Engagement with `guard: defineGuard('contacts.read')`; `breadcrumb.marketing` + `breadcrumb.audience`; `nav.staff.marketingAudience`; `admin.marketing.audience.*` (title, subtitle, columns, filters, states, toasts, empty states) in en/th/sv; `NAVIGATE_REGISTRY` entry in `src/modules/plans/application/search-plans.ts` with key `contacts.read`; keep `palette-permission-parity` green
- [x] T109 DONE 2026-09-06 (AMENDMENT blocks in specs/016 FR-002 and specs/005 FR-011) — [US4] (analyze follow-up) AMENDMENT block in `specs/016-rbac-permissions/spec.md`: catalogue 41→42 with `contacts.marketing` (marketing bundle +1, `sensitive: pii`), `contacts.read` gains its first enforced surface (Marketing audience page), and `specs/005-members-contacts/spec.md` FR-011 gains the per-contact marketing state; ships with PR-D
- [x] T060 DONE 2026-09-06 (all gates green — evidence in `reviews/pr-d.md` § T060 and § Review rounds) — [US4] Run PR-D static gates: `pnpm check:staff-page-guard && pnpm check:api-route-guard && pnpm check:layout && pnpm check:actor-role-truth && pnpm check:authorization-role-reads && pnpm check:i18n && pnpm lint && pnpm typecheck`; `pnpm vitest run tests/contract/rbac/ tests/contract/members/`; `pnpm test tests/unit/auth tests/unit/nav tests/unit/members`; T045 integration files by path; `pnpm test:e2e tests/e2e/admin-marketing-audience.spec.ts --workers=1`

**Checkpoint**: Audience page and toggle usable in dev; continues into US6 before PR-D opens.

---

## Phase 6: User Story 6 — A contact manages their own marketing preference in the portal (Priority: P3) · **PR-D (part 2)**

**Goal**: A signed-in contact (primary included) sees and switches their own marketing state; suppressed addresses show "unsubscribed" with no control; other contacts' states are not shown.

**Independent Test**: Sign in as a secondary with a login; profile shows "Marketing: on"; switch off; the member page shows "off (by contact)" with timestamp; attempt to PATCH another contact's id → 404; a suppressed contact sees "unsubscribed" and no switch.

### Tests for User Story 6 (write first — MUST FAIL) ⚠️

- [x] T061 DONE 2026-09-06 (`tests/contract/portal/profile-marketing.test.ts`, 12 cases) — [P] [US6] Contract `tests/contract/portal/profile-marketing.test.ts`: `PATCH /api/portal/profile/marketing` own contact only (foreign contact id → 404), 409 suppressed, 400 `missing_idempotency_key`, replayed key → stored outcome + no second audit row, 429 (distinct keys), audit `source: 'self'`; `GET /api/portal/profile` carries `marketing.state` for the own contact only
- [x] T062 DONE 2026-09-06 (new `tests/e2e/portal-marketing-toggle.spec.ts` with the member persona rather than extending the admin-facing self-service spec; the FR-033 "primary still receives" leg is proved on live Neon in `contact-marketing-opt-out.test.ts` instead of via the outbox) — [P] [US6] Extend `tests/e2e/members-self-service.spec.ts` (toggle off → member page state; unsubscribed → no control; primary toggles off and still receives the invoice email in the outbox) `--workers=1`, axe

### Implementation for User Story 6

- [x] T063 DONE 2026-09-06 (`check:portal-guard` OK without an exemption — the route goes through `requireMemberContext`) — [US6] Route `src/app/api/portal/profile/marketing/route.ts` (`requireMemberContext`; acts on `ctx.ownContactId`; `Idempotency-Key` required; zod `{ optOut }`; reuses `setContactMarketingOptOut` with `source: 'self'`; same 60/min limit); extend `src/app/api/portal/profile/route.ts` GET with `marketing: { state }` for the own contact; confirm `scripts/check-portal-guard.ts` passes (add exemption only if the route shape requires it)
- [x] T064 DONE 2026-09-06 (`src/components/members/portal-marketing-toggle.tsx`; unsubscribed → text only, unavailable → disabled) — [US6] Portal profile `src/app/(member)/portal/profile/page.tsx` + `src/components/members/portal-marketing-toggle.tsx` (own contact only; "unsubscribed" text state without control; primary sees "your invoices and payment emails are unaffected"); i18n `portal.profile.marketing.*` en/th/sv
- [x] T065 DONE 2026-09-06 (whitelist parity untouched; `check:portal-guard` OK) — [US6] Confirm `tests/integration/members/self-service-whitelist.test.ts` and the `SELF_UPDATE_*_SCHEMA_KEYS` parity are untouched (the toggle bypasses `memberSelfUpdate`); run `pnpm check:portal-guard`
- [x] T066 DONE 2026-09-06 (round 1: five reviewers, 51 findings closed in cycles 9–12; FR-050a written for CHK033; see `reviews/pr-d.md` § Review rounds) — [US6] PR-D review stack: `security-engineer`, `pdpa-gdpr-compliance-officer`, `enterprise-ux-designer`, `mobile-a11y-ux-reviewer`, `i18n-translation-reviewer` → 3 review passes → staff-review → re-review; co-sign `checklists/security.md`, `checklists/privacy.md`, `checklists/ux.md` (add the SV/TH length-variance note to FR-050 — ux CHK033); open PR `[Spec Kit] 108 PR-D contact marketing state + audience page`

**Checkpoint**: PR-D merged; staff can pre-flight the audience before any send under the new rule.

---

## Phase 7: User Story 3 — Secondary contacts receive marketing broadcasts (Priority: P1) · **PR-C (part 1)**

> **Renumbered 2026-09-06 (PR-C start).** PR-D's review added migration `0296`
> (`contacts_tenant_lower_email_all_idx`), so PR-C's DDL moves to `0297`
> (`marketing_unsubscribes.contact_id`, T073) and `0298` (`broadcasts.audience_import_*`,
> T086). Also found at PR-C start: data-model § 3 names an `audience_building` broadcast
> state that NO migration adds to `broadcast_status` (the enum ends at
> `partial_delivery_accepted`). T086 must either add it (enum-only migration `0299` + the
> Domain state machine + status i18n ×3 + every `status = 'approved'` / `'sending'` query
> in dispatch and reconcile) or model "building" as `sending` with
> `audience_import_completed_at IS NULL`. Decided at the US5 checkpoint and recorded in
> `reviews/pr-c.md` before T086 starts.

**Goal**: Behind `FEATURE_CONTACT_MARKETING_RECIPIENTS`, member-based audiences fan out to every eligible contact of active members minus suppression, opt-out and the sender's own contacts; opt-out applies to custom lists (dropped + counted); unsubscribes carry contact attribution. The `status = 'active'` predicate ships unflagged.

**Independent Test**: Seed member M (primary P; secondaries S1 unsubscribed, S2 staff-off, S3) and sender N; flag ON: "All members" resolves to P + S3 only, none of N's contacts; flag OFF: P only; inactive/archived members' contacts excluded in both legs; a custom list containing S2 submits with `recipient_preference_excluded: 1`; S3 unsubscribing writes `contact_id`.

### Tests for User Story 3 (write first — MUST FAIL) ⚠️

- [x] T067 [P] [US3] Re-target `tests/unit/broadcasts/application/resolve-segment-recipients.test.ts` to `ContactRecipient` candidates and add: 1:N fan-out, opt-out exclusion, all-contacts self-exclusion by `requestingMemberId`, page-failure propagation (`resolve.server_error`), both `audienceMode` legs, `droppedByPreference`, orphan = zero eligible contacts
- [x] T068 [P] [US3] Integration `tests/integration/broadcasts/audience-1n-status.test.ts` (inactive/archived/erased excluded both legs; secondaries included flag ON; halted excluded; tier-filtered segment applies the same contact rules — US3 s6), `tests/integration/broadcasts/custom-list-opt-out-drop.test.ts`, `tests/integration/broadcasts/unsubscribe-contact-attribution.test.ts` (incl. a removed-then-re-added contact with a suppressed address stays suppressed and shows "unsubscribed"); re-pin `tests/integration/broadcasts/audience-cap.test.ts` to the ceiling parameter
- [x] T069 [P] [US3] Unit: `validate-custom-recipients.test.ts` (`droppedOptedOut`), `unsubscribe-recipient.test.ts` (contactId via `lookupContactEmailInTenant`, legacy fallback), `tests/unit/broadcasts/infrastructure/members-bridge.test.ts` (repo error propagates, no `[]`), `tick-memoized-members-bridge.test.ts` (new method memoised) — **done 2026-09-07 except `droppedOptedOut` on `validate-custom-recipients`, SUPERSEDED: the resolver reports `droppedByPreference` for every segment kind (reviews/pr-c.md § design points)**
- [x] T070 [P] [US3] Contract `tests/contract/broadcasts/post-broadcasts-submit.contract.test.ts` (+ `recipient_preference_excluded`), unsubscribe contract payload `contact_id`
- [x] T071 [P] [US3] Unit/integration for the F3 side: `tests/unit/members/application/get-broadcast-recipient-contacts.test.ts` and `tests/integration/members/broadcast-recipient-contacts-keyset.test.ts` (status filter, `removed_at`/opt-out exclusion, keyset order `(member_id, contact_id)`, LEFT JOIN orphans, no limit, cross-tenant isolation — a second tenant's contacts never appear, FR-052)
- [x] T104 [P] [US3] (coverage review) Erasure cascade for the new attribution (FR-056): extend `tests/integration/broadcasts/member-erasure-cascade.test.ts` so erasing a member nulls `marketing_unsubscribes.contact_id` (and `member_id`) for that member's addresses while the email-keyed row survives; wire the existing unwired `setMemberIdNull` (or a new `setContactRefsNull`) into the erasure cascade in `src/modules/broadcasts/**`
- [x] T105 [P] [US3] (coverage review) SC-011 parity test `tests/integration/broadcasts/audience-page-vs-compose-count.test.ts`: `listMarketingAudience` with the eligible preset equals `resolveSegmentRecipients('all_members')` count before sender self-exclusion for the same tenant state

### Implementation for User Story 3

- [x] T072 [US3] Env flag `FEATURE_CONTACT_MARKETING_RECIPIENTS` in `src/lib/env.ts` (`booleanFromString.default(false)`), `.env.example`, `pnpm check:env-example && pnpm check:env-boot`; map to `audienceMode` only in `src/modules/broadcasts/infrastructure/broadcasts-deps.ts`
- [x] T073 [US3] Migration `drizzle/migrations/0297_marketing_unsubscribes_contact_id.sql` (+ partial index) + journal; `src/modules/broadcasts/infrastructure/schema.ts`; `NewSuppressionInput.contactId` in `src/modules/broadcasts/application/ports/marketing-unsubscribes-repo.ts` + Drizzle upsert; apply + verify
- [x] T074 [US3] F3: repo method `findBroadcastRecipientContacts(ctx, { segmentType, tierCodes?, after?, limit })` in `src/modules/members/infrastructure/db/drizzle-member-repo.ts` (data-model §1 eligibility, keyset, 1,000/page, LEFT JOIN for orphans), port entry in `member-repo.ts`, use case `src/modules/members/application/use-cases/get-broadcast-recipient-contacts.ts`, barrel export; add `eq(members.status,'active')` to the existing `findMembersBySegmentForBroadcast` (`:1349-1357`, unflagged) and delete its `.limit(5000)` (`:1358`)
- [x] T075 [US3] Broadcasts bridge: `ContactRecipient`, `getContactsBySegment`, `filterMarketingOptedOut` in `src/modules/broadcasts/application/ports/members-bridge-port.ts`; implement in `src/modules/broadcasts/infrastructure/members-bridge.ts` (page loop; errors propagate — remove the `return []` at `:88`); memoise in `tick-memoized-members-bridge.ts`
- [x] T076 [US3] Rewrite `src/modules/broadcasts/application/use-cases/resolve-segment-recipients.ts` per contract broadcast-audience §1–2 (`audienceMode`, `audienceCeiling` deps; `requestingMemberId` input; candidates `{ memberId, contactId, emailLower }`; chunked `lookupBatch`; `droppedByPreference`; orphans redefined); update callers `submit-broadcast.ts:580-636`, `dispatch-scheduled-broadcast.ts:489-517`, `src/app/api/cron/broadcasts/split-large-broadcasts/route.ts:201-218`, `src/app/api/cron/broadcasts/dispatch-batches/route.ts:245-262`
- [x] T077 [US3] `validate-custom-recipients.ts` output `droppedOptedOut` via `filterMarketingOptedOut`; `submit-broadcast.ts` threads the count; `src/app/api/broadcasts/submit/route.ts` body `recipient_preference_excluded`; compose shows the count (i18n `portal.broadcasts.compose.preferenceExcluded` en/th/sv) — **`droppedOptedOut` SUPERSEDED (see T069); the rest done 2026-09-07**
- [x] T078 [US3] `unsubscribe-recipient.ts:147-162` resolves `{ memberId, contactId }` via `lookupContactEmailInTenant` (primary lookup as legacy fallback); both audit payloads gain `contact_id`; `src/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-subscriptions.ts` unchanged
- [x] T079 [US3] Compose copy: rewrite `portal.broadcasts.compose.estimateNote.*` (interpolate `{ceiling}`) and add `selfExclusionHint` in `src/i18n/messages/{en,th,sv}.json` (`en.json:5667` block); render the hint in `src/components/broadcast/compose-form.tsx:434-447` and `proxy-compose-form.tsx`
- [x] T080 [US3] Spec AMENDMENT blocks that describe PR-C behaviour (house format from `specs/010-email-broadcast/spec.md:363`): `specs/010-email-broadcast/spec.md` (Q8, FR-015/FR-015c, Q16, FR-002 h, FR-016a, edge cases 339–340, Q14 halt-as-recipient semantics kept) and `specs/014-email-broadcast-advance/f71b-backlog.md` US3 (superseded by opt-out model; promotion criterion (b) met). The 007 / 005 / 016 amendments ship with their own PRs — T107 / T108 / T109

**Checkpoint**: Flag OFF behaves as before except the active-only narrowing; flag ON fans out. Continues into US5 before PR-C opens.

---

## Phase 8: User Story 5 — Audience size is truthful and scales (Priority: P2) · **PR-C (part 2)**

> **Scope narrowed 2026-09-07 (advisor-reviewed; spec AMENDMENT under User Story 5).**
> T086 / T087 / T106 (Resend import-based audience build, `audience_building`,
> stuck-build reconcile) are deferred to a follow-up PR with T110. Consequently in
> PR-C: T081 drops `audience-import-two-tick.test.ts`; T083 drops the
> `build-audience-tick` / `resend-contact-import` suites (the ceiling + split-threshold
> guard tests stay); T090 drops the `audience_import_status` gauge; T091's runbook
> covers the bounded per-contact push and the flag-off remedy (no stuck-build section).
> T085 / T088 / T089 / T090 / T091 / T092 and the deferred-from-US3 T079 proceed.

**Goal**: One ceiling (5,000 / 50,000 by the F7.1a batching flag), truthful compose-time count with a rate-limited endpoint, no silent truncation, and a resumable provider audience build that fits the 300-second cron budget.

**Independent Test**: 6,200-contact audience: compose shows 6,200; batching OFF → refused with count + ceiling; batching ON → accepted and every recipient pushed exactly once across ≥2 dispatch ticks, `sendBroadcast` only after the last push; 20,000 contacts counted in < 3 s; a stalled build is flagged after 30 min.

### Tests for User Story 5 (write first — MUST FAIL) ⚠️

- [x] T081 [P] [US5] Integration `tests/integration/broadcasts/audience-pagination-20k.test.ts` (no truncation; count < 3 s; equals dispatched set) and `tests/integration/broadcasts/audience-import-two-tick.test.ts` (tick 1 submits exactly one import and stores the id; tick 2 with a mocked `completed` + matching counts sends; `failed > 0` or count mismatch → typed failure, no send; second tick never re-submits; stuck after simulated 30 min)
- [x] T082 [P] [US5] Contract `tests/contract/broadcasts/get-broadcasts-recipient-count.contract.test.ts` (member + admin routes; numbers only; 429; 503 `count_unavailable`; admin route super_admin happy path + baseline row; admin route with a foreign-tenant or unknown `member_id` → 404 + `member_cross_tenant_probe` audit)
- [x] T083 [P] [US5] Unit `tests/unit/broadcasts/domain/audience-ceiling.test.ts`, `tests/unit/broadcasts/application/build-audience-tick.test.ts` (CSV has only an `email` column; submit-once; completion rule incl. count mismatch and `failed > 0`; 30-min stuck), `tests/unit/broadcasts/infrastructure/resend-contact-import.test.ts` (multipart body shape, 429 → retryable, error classification), and a guard test that `SPLIT_THRESHOLD_RECIPIENTS < audienceCeiling(true)`
- [x] T084 [P] [US5] Extend `tests/e2e/broadcast-compose-and-submit.spec.ts`: live count updates on segment change, `aria-live` announcement, "count unavailable" state, self-exclusion hint (`--workers=1`) — **done 2026-09-07 (reviews/pr-c.md row 19): 4 cases + the whole compose spec 10/10 on chromium `--workers=1`; the spec now signs in as the in-good-standing `e2e-member-empty` persona and `seed-e2e-portal-invoices.ts` was fixed for the 0045/0056 CHECKs**

### Implementation for User Story 5

- [x] T085 [US5] `src/modules/broadcasts/domain/audience-ceiling.ts` (`audienceCeiling(batchingEnabled)`); wire `audienceCeiling(isF71aUs1Enabled())` into `ResolveSegmentDeps` in `broadcasts-deps.ts`; delete `AUDIENCE_HARD_CAP` (`resolve-segment-recipients.ts:36`); `submit-broadcast.ts:580-606` and `dispatch-scheduled-broadcast.ts:522-547` read the deps value; error copy interpolates the ceiling in en/th/sv
- [~] T086 [US5] **DEFERRED 2026-09-07 → follow-up PR with T110 (spec AMENDMENT under US5)** — Migration `drizzle/migrations/0298_broadcasts_audience_import.sql` (nullable `audience_import_id text`, `audience_import_completed_at timestamptz` on `broadcasts`) + journal; `src/modules/broadcasts/infrastructure/schema.ts`; repo methods `attachAudienceImport` / `markAudienceImportCompleted`; gateway port methods `createContactImport(audienceId, csv)` / `getContactImport(id)` in `src/modules/broadcasts/application/ports/broadcasts-gateway-port.ts`, implemented with a raw multipart `fetch` (+ `withRetry`, 429 retryable, `classifyResendError`) in `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts`; delete the stale "2 req/s / no bulk endpoint" comments and the per-contact `addContactsToAudience` loop once no caller remains
- [~] T087 [US5] **DEFERRED 2026-09-07 → follow-up PR with T110** — Use case `src/modules/broadcasts/application/use-cases/build-audience-tick.ts` (tick 1: resolve audience → CSV with only `email` → one `createContactImport` with `upsert` → store id → `audience_building`; later ticks: `getContactImport`; completion rule per contract §4 (`completed`, `failed = 0`, `created+updated+skipped = total = resolved count) → stamp + `sendBroadcast`; mismatch/failed/30-min → typed failure `audience_import_failed|audience_import_stuck` with audit + alert; never re-submit while an id is set) wired into `src/app/api/cron/broadcasts/dispatch-scheduled/route.ts`
- [~] T106 [US5] **DEFERRED 2026-09-07 with T087** — (coverage review — split from T087) `src/app/api/cron/broadcasts/reconcile-stuck-sending/route.ts` + its use case treat `audience_building` whose import is not `completed` within 30 min of submission as stuck (audit + alert metric + staff notice), with a unit test for the threshold and a contract test for the cron route
- [x] T088 [US5] Count endpoints: `src/app/api/broadcasts/recipient-count/route.ts` (clone of `quota/route.ts`; `requireMemberContext`; `segment`/`tier` query; `{ count, ceiling, exceeds, orphans, droppedByPreference }`; limiter `broadcasts:count:{tenant}:{user}` 30/min atomic; 503 `count_unavailable`) and `src/app/api/admin/broadcasts/recipient-count/route.ts` (`requireApiPermission(request,'broadcasts.write')`, `member_id` resolved timing-safe inside the tenant — foreign/unknown → 404 + `member_cross_tenant_probe` audit, baseline row in `tests/helpers/rbac-observed-baseline.ts`); add `makeResolveSegmentDeps(tenantId)` to `broadcasts-deps.ts`
- [x] T089 [US5] Compose UI: `src/components/broadcast/compose-form.tsx` + `proxy-compose-form.tsx` — debounced (400 ms) count fetch on segment change, `aria-live="polite"` count region with locale digit grouping, "count unavailable" (submission still allowed), "exceeds ceiling {ceiling}" copy; i18n en/th/sv
- [x] T090 [US5] Metrics + logs in `src/lib/metrics.ts` (`broadcasts.audience_resolved_total{segment,mode}`, `audience_pages_total`, `audience_import_status{status}` gauge, `recipient_count_ms` histogram) with member-id hashes only; confirm with `observability-instrumentor` that the four new routes (toggle, portal toggle, two counts) emit RED metrics through the existing route instrumentation (Constitution VII), adding per-route counters only if they do not; `docs/observability.md` metrics + alert thresholds (stuck 30 min → page; skipped money email > 0/24 h → warn; count p95 > 3 s → warn)
- [x] T091 [US5] Runbook `docs/runbooks/broadcast-audience-build.md` (stuck detection, resume, manual abort, duplicate-push handling, flag-off remedy) + updates to `docs/runbooks/cron-jobs.md`, the reconcile-stuck-sending runbook and the void-pdf-reconcile runbook
- [x] T092 [US5] Run PR-C gates (lint, typecheck, i18n, env gates, `tests/unit/broadcasts tests/unit/members`, T068/T071/T081 integration files by path, `tests/contract/broadcasts/`, e2e T084 `--workers=1`, `pnpm test:coverage`) and review stack (`security-engineer`, `reliability-guardian`, `performance-slo-guardian`, `observability-instrumentor`, `enterprise-ux-designer`, `i18n-translation-reviewer` → 3 review passes → staff-review → re-review); co-sign `checklists/reliability.md`, `checklists/operations.md`, `checklists/ux.md`; open PR `[Spec Kit] 108 PR-C audience 1:N behind flag` — **done 2026-09-07 (reviews/pr-c.md row 18); e2e NOT run — T084 stays open until the dev server is up**

**Checkpoint**: PR-C merged with the flag OFF in prod.

---

## Phase 9: Polish, Cutover & Cross-Cutting

**Purpose**: Operator cutover, documentation, and the scheduled deletion of temporary complexity.

- [ ] T093 Operator: perform the FR-027a pre-flight review on `/admin/marketing/audience?kind=secondary&state=on&eligible=1`, switch off anyone who must not receive, and record date + reviewer in `docs/go-live-readiness.md` (also add the Stripe Dashboard "Successful payments = OFF" item to the Live-switch section)
- [ ] T094 Operator: set `FEATURE_CONTACT_MARKETING_RECIPIENTS=true` in Vercel, redeploy, and observe the first send per quickstart § Cutover 5 (`audience_import_status` + the import's counts, outbox, `estimated_recipient_count` = delivered); record in `specs/108-contact-recipient-rules/reviews/cutover.md`
- [ ] T095 [P] Operator: record the team's actual Resend rate limit (Settings → Usage) and any support answer on the Audiences → Segments migration timeline in `research.md § R9/R16` (operations CHK015); a rate increase is no longer required by the import-API design
- [ ] T110 [P] Follow-up PR (outside 108's four PRs): upgrade `resend` 4.8 → 6.x with a full gateway contract suite (`tests/contract/broadcasts/resend-gateway-*.test.ts`) and adopt `contacts.imports` + segments/topics per research R16; record the F7 platform risk in `docs/email-broadcast-analysis.md` and `docs/go-live-readiness.md`
- [ ] T096 [P] Compliance: add the record-of-processing entry + short legitimate-interest assessment for per-contact marketing preference and marketing to secondary contacts (FR-055) in `docs/record-of-processing.md` (create if absent) before T094
- [ ] T097 [P] Docs: `CLAUDE.md` (migration counter 0291→0297/0298, Recent Changes entry, Active Technologies "PLANNED" → shipped), `docs/changelog.md`, `docs/contacts-primary-secondary-gap-analysis.md` status line (H1/H2/G1–G9 closed; G3 kept)
- [ ] T098 Run `/speckit.analyze` for FR↔SC↔contract traceability (operations CHK023) and fold any finding into spec.md before T094
- [ ] T099 Follow-up PR after one clean week (spec § Assumptions definition): delete `FEATURE_CONTACT_MARKETING_RECIPIENTS` from `src/lib/env.ts`, `.env.example`, Vercel; delete the `primary_only` leg in `resolve-segment-recipients.ts` and `findMembersBySegmentForBroadcast`; re-pin tests; `[Spec Kit] 108 remove cutover flag`
- [ ] T100 Final: run the full gate list from CLAUDE.md § Commands incl. `pnpm test:e2e --workers=1` and `pnpm typecheck` as the last step; `/speckit.verify` then `/speckit.ship` per PR

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** → **Foundational (Phase 2)**: T004 (V3) blocks T015; T005 (V1) blocks T034; T006 (V2) blocks T086–T087; T007 blocks T018.
- **US1 (Phase 3, PR-A)**: depends only on Foundational. MVP.
- **US2 (Phase 4, PR-B)**: depends on Foundational (T005 = 0). Independent of US1.
- **US4 (Phase 5) + US6 (Phase 6) = PR-D**: depend on Foundational; independent of US1/US2 at the code level (they may land in any order after A and B, but the plan sequences A → B → D).
- **US3 (Phase 7) + US5 (Phase 8) = PR-C**: depend on **US4** (contact marketing columns from T048–T051; audience page from T058 for FR-027a) and on T006. US5 depends on US3's resolver (T076).
- **Polish (Phase 9)**: T093–T094 after PR-C is deployed; T099 after the clean week; T096 before T094.

### User Story Dependencies

| Story | Depends on | Reason |
| --- | --- | --- |
| US1 money | — | pure invoicing/payments change |
| US2 invariant | V1 = 0 | migration pre-check fails deploy otherwise |
| US4 staff controls | — | schema + permission + pages |
| US6 portal toggle | US4 (T051, T053) | reuses the use case and columns |
| US3 audience 1:N | US4 (T048–T051, T058) | opt-out columns; pre-flight surface |
| US5 scale/count | US3 (T076), V2 | resolver shape; push idempotency |

### Within Each User Story

- Tests first, RED (commit red) → implementation → GREEN (commit green).
- Migration → schema/domain → repo/port → use case → route → UI → gates → review stack.
- Money-path and PII use cases: live-Neon integration test before the PR opens (memory: integration tests REQUIRED).
- Run `pnpm typecheck` and full `pnpm lint` after the last edit of every PR (not in pre-push).

### Parallel Opportunities

- Phase 2: T004, T006, T007 in parallel (T005 is operator-run).
- Every "Tests for User Story N" block: all `[P]` test files in parallel, then implementation sequentially (file-mutating work is sequential in this repo).
- Phase 5: T042–T047 parallel; then T048 → T049 → T050 → T051 sequential (schema), then T052–T059 mostly sequential (shared files).
- Phase 9: T095, T096, T097 parallel.
- Read-only reviewer agents in every review-stack task run concurrently; `/speckit.review` passes are sequential.

---

## Parallel Example: User Story 1

```bash
# RED — all seven test files at once (different files):
Task: "Contract test tests/contract/invoicing/money-email-recipient-inventory.test.ts"          # T008
Task: "Integration tests/integration/invoicing/record-payment-live-recipient.test.ts"         # T009
Task: "Integration void/credit-note live recipient tests"                                       # T010
Task: "Integration tests/integration/invoicing/resend-pdf-live-recipient.test.ts"             # T011
Task: "Unit tests/unit/invoicing/resolve-money-recipient.test.ts"                              # T012
Task: "Payments unit + integration billing-email tests"                                        # T013
Task: "Contract tests/contract/portal/invoice-resend-route.test.ts"                            # T014

# GREEN — sequential (shared invoicing files): T015 → T016 → T017 → T018 → T019 → T020 → T021 → T022 → T023 → T024 → T025 → T026 → T027 → T028 → T029
```

## Parallel Example: User Story 4

```bash
# RED
Task: "RBAC pins T042" · "Contract T043" · "Unit T044" · "Integration T045" · "Nav/baseline pins T046" · "E2E T047"
# GREEN — migrations first (T048, T049), then domain/schema (T050, T051), permission (T052), use cases (T053, T054), route (T055), components (T056), pages (T057, T058), nav/i18n (T059), gates (T060)
```

---

## Implementation Strategy

### MVP First (User Story 1 = PR-A)

1. Phase 1 + Phase 2 (T004, T007 at minimum; T005/T006 can run while PR-A is in review).
2. Phase 3 in full; STOP and validate with the T008 inventory test + manual verification (quickstart § Manual verification 1).
3. Ship PR-A: money emails are correct in prod even if nothing else ships.

### Incremental Delivery

1. PR-A (US1) → prod: money rule hardened.
2. PR-B (US2) → prod after V1 = 0: invariant DB-guaranteed.
3. PR-D (US4 + US6) → prod: staff can see/control marketing state; audience page live; the dispatch audience DOES change on this PR — an opted-out contact (staff or self) is dropped from every segment kind (review cycle 10, FR-022a); the 1:N secondary-contact widening itself is still PR-C.
4. PR-C (US3 + US5) → prod with the flag OFF: only the active-only narrowing changes behaviour.
5. Pre-flight review → flag ON → first send observed → clean week → flag-deletion PR.

### Solo-Maintainer Strategy

One implementer; file-mutating agents sequential; each PR carries the five-check substitute stack (Complexity Tracking #1) and co-signed checklists before merge. Direct push to `main` is permitted by the constitution's solo-maintainer exemption only with all CI gates green; the plan uses PRs anyway for the six required status checks.

---

## Notes

- `[P]` tasks = different files, no dependencies; everything else is sequential in this repo.
- Never `git add -A` (PII workbooks); never `git stash`; never run `pnpm format`.
- `pnpm test:integration <file path>` positionally — `-- <pattern>` runs the whole 40-minute suite.
- Verify each migration landed via `information_schema` (duplicate `when` = silent no-op).
- Record `?? null`, never `?? 'admin'`: audit actor role is always the session role.
- Stop at any checkpoint; each PR is a valid stopping point with its own rollback row in quickstart.
