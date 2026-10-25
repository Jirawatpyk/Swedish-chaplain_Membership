# 129 — Members review leftovers (from PRs #649 and #650)

**Size**: S/M (members use case + route + edit form, one renewals audit payload, i18n, docs; no migration, no flag).
**Status**: built on `129-members-review-leftovers`, 25 Oct 2026.
**Source**: the LOW findings left by the security-engineer, financial-integrity-reviewer and enterprise-ux-designer reviews of #649, and the #650 retro trigger.

## Done when

1. **The `member_updated` audit records an override reason only when it was applied.** It is applied when a changed legal entity type is outside the plan's `memberTypeScope` and a reason is given. If the type is in scope or unchanged, a reason the client sent anyway is not recorded.
2. **A plan change that lands between `updateMember`'s pre-read and its row lock answers 409 `conflict`** (`details.reason: 'concurrent_change'`), not 500. The edit form shows "changed by someone else, reload" and refreshes.
3. **The `renewal_orphan_invoice_relinked` audit from an undelete carry names its source cycle** (`source_cycle_id`, the cancelled cycle the link moved off). The reconcile-orphans emit has no source and omits it.
4. **The override dialog on the member edit form:**
   - returns focus to the element that opened it (the Save button), on both confirm and cancel;
   - says so when it is cancelled: "Not saved" (`errors.overrideCancelled`), or the partial-save warning when an earlier step already saved;
   - uses the reviewed EN/TH/SV member-type copy.
5. **Docs:**
   - `specs/001-auth-rbac/security.md` notes that a member restored after undelete needs a new portal invitation;
   - `docs/retro.md` records the Upstash timeout fail-open (#650).

## Not changed
- **`findLatestCycleForMemberInTx` ignoring `_tenantId`** (security LOW). This is not changed here, because it follows a repo-wide pattern: Round 6 S-R5-6, about 81 `_tenantId` methods relying on RLS only. That pattern conflicts with Principle I's "every query MUST be scoped by `tenantId`", so it needs a decision plus a sweep, not a one-off. Tracked in issue #653.
