# PR-B — exactly-one-primary invariant (US2)

**Branch**: `108-pr-b-primary-contact-invariant` · **Commits**: `ca3035428` … `0b111c317` (5 on top of `main` at `bdbd631d9`)
**Scope**: T030–T040 + T108 · **Status**: implementation + tests complete; T041 gate + review rounds recorded below.

## What changed, and why it was wrong before

FR-003 (005) said "exactly one primary contact". The database only ever guaranteed **at most**
one (partial unique index `contacts_one_primary_per_member`). The application refused to remove
a primary — from a read taken **outside** the write transaction. So:

| Interleaving | Before | After |
|---|---|---|
| `promotePrimary(Y)` racing `removeContact(Y)` | both succeed; member ends with **zero** live primaries — reproduced **50 of 50** times on `main` in T030 | the write refuses (`WHERE is_primary = false` → 409 `cannot_remove_primary`); every member ends with exactly one; the DB trigger backstops any path that is not the app |
| unarchive of a member with no primary | restored into the one state FR-010 forbids | refused until a primary is designated in the same transaction (409 `no_primary_contact` + `designatable[]` → dialog) |

Since 108 PR-A, a member with no live primary silently stops receiving receipts, void notices
and credit notes — so the race above was not theoretical damage.

## Delivered

| Area | Change |
|---|---|
| Write | `removeInTx` refuses the live primary in its own WHERE; `designatePrimaryInTx` (promote with no demote step) |
| Tx | `assertPrimaryContactInvariant` over `listByMemberInTx` after add / promote / remove, throw-to-rollback; suspended for `archived` |
| Commit | migration `0293`: pre-check DO block (counts only, fails the deploy) + `contacts_assert_one_primary()` SECURITY DEFINER + two `DEFERRABLE INITIALLY DEFERRED` constraint triggers (contacts INSERT/UPDATE/DELETE; members UPDATE OF status, erased_at) |
| Mapping | `primaryContactTriggerViolation` (`src/lib/db-errors.ts`, 23514 + token) mapped in the use cases' **outer** catch — the raise surfaces from `runInTenant` at COMMIT, never inside `mapDbError` |
| Unarchive | `undeleteMember(…, { designatePrimaryContactId })`; route accepts `designate_primary_contact_id`, hashes the body into the idempotency key, does not remember the 409 |
| UI | `restore-primary-dialog.tsx` (radio list, nothing pre-selected, zero-contacts door) wired from `archived-banner.tsx`; `finalFocus` → Restore button on cancel, `#main-content` on success |
| i18n | `admin.members.undelete.designate.*` ×9 in en/th/sv |
| Spec | AMENDMENT at FR-010/FR-010a (DB guarantee scoped to members with ≥1 contact row at commit); 005 FR-003/FR-011 AMENDMENTs; research V1 re-run; data-model §2.2 |
| Ops | `inventory-primary-contact-invariant.ts` uses 0293's predicate and prints contact-less members on their own line |

## What the pre-flight found before any code

The pre-check DO block scans **every tenant**. V1 had only ever measured `swecham`. On the
shared `dev` branch: 87 tenants / 411 members; 72 `test-*` tenants held 150 violators — **every
one with zero contact rows**. `integration-smoke.yml` (REQUIRED on `main`) runs against one
persistent CI Neon branch of the same shape that no PR can clean, so the migration as specified
could never merge. Recorded as a spec AMENDMENT, not a silent narrowing. Also verified: the
migration role is `neondb_owner` with `rolbypassrls = true` — the pre-check genuinely reads
every row under RLS FORCE (not a vacuous "0 violations").

## Gate output (T041)

| Gate | Result |
|---|---|
| `pnpm lint` (full) | 0 |
| `pnpm typecheck` | 0 |
| `pnpm check:i18n` | 5184/5184 keys in all 3 locales |
| static pre-push gates (fixme, dates, money-recipient, api-route-guard, actor-role-truth, authorization-role-reads, staff-page-guard, template-seed, env-example) | all 0 |
| `tests/unit/architecture` | 133/133 |
| `tests/unit/members` | 1205/1205 (145 files) |
| `tests/contract/members` | 204/204 |
| T030 `primary-contact-race` (live Neon) | 5/5 — RED had been 2/5 with 50/50 members at zero primaries |
| T031 `primary-contact-trigger` (live Neon) | 18/18 — RED had been 10/18; **mutation-proved**: a mutant with no exemptions failed exactly the 7 exemption-dependent cases and restored → 18/18 |
| repaired fixtures (`undelete-window`, `f3-undelete-restore`, `contact-art14-attestation`, `self-service-whitelist`) | green |
| e2e `members-archive-undelete.spec.ts` (chromium, `--workers=1`) | 7/7 — 4 pre-existing + 3 new (axe clean on both dialog variants; focus never on `<body>`; TH/SV no leak) |
| full `pnpm test` | _pending — recorded when the background run completes_ |

## Review rounds

### Round 1 — 2026-09-05, four read-only reviewers concurrently, on `0b111c317`

No BLOCKER from any reviewer. 25 findings; **25 fixed**, 0 rejected. Each fix went RED → GREEN
(the unit/contract/integration case listed is the one that failed first).

| # | Reviewer / sev | Finding | Resolution |
|---|---|---|---|
| R-H1 | reliability HIGH | `findByIdInTx` is `SELECT … FOR UPDATE` on `members`; contact-crud wrote `contacts` first and locked `members` after — lock-order inversion vs erase/undelete → deadlock (40P01) → 500 | `lockMemberInTx` runs FIRST in add / promote / remove; pinned by `mock.invocationCallOrder` in `contact-crud-invariant.test.ts` |
| R-M2 | reliability MED | bulk `unarchive` skips the designate flow; the trigger's raise collapsed the whole batch into `server_error` with no member id | `bulk-action.ts` maps `primaryContactTriggerViolation` → `state_error{memberId, no_primary_contact}` (uuid parsed from the raise); `bulk-action-primary-contact-refusal.test.ts` |
| R-M3 | reliability MED | zero-primary dead end: `addContact` always added a secondary and zero mapped to "try again" | policy `zero_primaries` and trigger count 0 → `no_primary_contact`; `addContact` makes the FIRST contact of a member with no live primary the primary, audited `member_primary_contact_changed` with `old_primary_contact_id: null` |
| R-L4a/b/c | reliability LOW | trigger-residual path offered an empty list; lost race refused with the stale pre-UPDATE list; toast claimed "primary set" when a primary had appeared meanwhile | non-tx `listByMember` re-read on residual; in-tx re-read before refusing; `undeleteMember` returns `{ member, designatedContactId }`, route emits `designated_primary_contact_id`, banner keys the toast on it |
| R-L5 | reliability LOW | no `erased_at` gate on undelete (pre-existing; the page hid the banner, the API did not) | `findErasedIdsInTx` partition → `state_error{undelete_erased}` → 409 |
| S-H1 | security HIGH (Review-gate hold) | no cross-tenant live-Neon test for `listByMemberInTx` / `designatePrimaryInTx` (Principle I §iii) | `tests/integration/members/undelete-designate-isolation.test.ts` — (a) B cannot restore A's member; (b) A naming B's contact is refused with A's list only; (c) happy path commits designation + audit + restore together |
| S-M2 | security MED | "deliberately not remembered" 409 was wrong: the key is reserved first, so a replay hit `idempotency_conflict` | the 409 is remembered (non-mutating, replay-safe); a new designation is a new key; contract test pins `rememberIdempotentResponse` with status 409 |
| S-M3 + M-L4 | security MED / migration LOW | `search_path = public, pg_catalog` (CVE-2018-1058 order; 0124 had moved the others) and no explicit `pg_temp` | `pg_catalog, public, pg_temp` on both functions; `REVOKE ALL … FROM PUBLIC` before the grant; T031 pins `proconfig` and the acl |
| S-L4 | security LOW | `repo.unexpected` during designation collapsed into 409 | refuse only on `not_found`/`conflict`; anything else throws → 500 |
| S-L5 + M-M1 | security LOW / migration MED | an UPDATE re-parenting a contact checked only the NEW member; the OLD could end at zero (a script does this move) | check split into `contacts_check_member_primary(tenant, member)`; the trigger runs it for OLD when `(tenant_id, member_id)` changed; T031 re-parent case |
| S-L6 | security LOW | e2e seed client had no prod-host guard | `TEST_DB_HOST_BLOCKLIST` fail-closed in `open-seed-client.ts` (mirrors integration-setup); unit test |
| M-L2 | migration LOW | the per-row count used no index (all contact indexes are partial) | `contacts_tenant_member_all_idx (tenant_id, member_id)`; comment corrected; T031 pins it |
| M-L3 | migration LOW | writer window between the pre-check and CREATE TRIGGER | `LOCK TABLE members, contacts IN SHARE ROW EXCLUSIVE MODE` as the batch's first statement |
| UX-H1 | ux HIGH | retry toast under the modal is `aria-hidden` | `notice` prop → `role="alert"` inside the dialog; `retryNone` for the empty-list case; no toast |
| UX-H2 | ux HIGH | after "Add a contact" the dialog stayed on "no contacts" | `ContactFormDialog.onSaved` → banner restores again in place; with R-M3 the new contact is already primary so it succeeds |
| UX-H3 | ux HIGH | no `max-h` — footer off-screen at 320×568 | `max-h-[85vh] overflow-y-auto` |
| UX-M4 | ux MED | Escape closed the dialog mid-request | `onOpenChange` ignores close while `submitting` |
| UX-M5 | ux MED | radio showed a name, not the email the decision is about | `email` on `designatable` end to end; second line per radio |
| UX-M6 | ux MED | nested add-contact copy said "another person … as a secondary" | `ContactFormDialog.description` prop + `designate.addContactDescription` |
| UX-M7 | ux MED | copy: EN/SV title read as "restore a contact"; TH `retry` idiom; TH em-dashes; SV `successDesignated` fragment | all five rewritten; `noContactsDescription` now says the new contact becomes the primary |
| UX-M8 | ux MED | `router.refresh()` raced the close cycle / `finalFocus` | refresh runs from `onCloseComplete` (Base UI `onOpenChangeComplete`) when the dialog was open |
| UX-L9 | ux LOW | label `mb` offset; radiogroup named twice; add-contact button placement; initial-focus deviation undocumented | `mb-0`; `aria-labelledby={legendId}` only; button moved to the footer as the primary action; deviation documented in the file header |

Also surfaced by the members-folder integration run and repaired the same way as the T034
fixtures (the new rule refused them correctly): `contact-scrub`, `erase-member-linked-user-shadow`
(scrub without a co-committed `erased_at`), `erase-member-outbox-cancel` and
`invite-colleague-membership-suspended` (a member seeded with only a non-primary contact).

Not a finding, checked anyway: the three scripts the security reviewer named
(`seed-demo-members`, `seed-e2e-portal-invoices`, `smoke-link-user-to-contact`) already write
member + primary in one tx, demote-then-promote in one tx, or only read.
