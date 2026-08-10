# Operations / Cutover Requirements Quality Checklist: 016 RBAC Permissions

**Purpose**: Validate that migration, flag-lifecycle, observability, and operator-procedure requirements are complete and unambiguous — the risk class unique to this feature (live prod, zero-lockout cutover). Gate-4 artefact for `drizzle-migration-reviewer` + `observability-instrumentor` passes.
**Created**: 2026-08-10
**Feature**: [spec.md](../spec.md) · design §5/§6.2/§9/§11 · plan Complexity #3/#4

## Migration Requirements (§5)

- [ ] CHK065 - Are the migration-discipline requirements complete per repo law: `IF NOT EXISTS` enum DDL, `REQUIRED_ENUM_VALUES` extension, journal `when` > global max, no literal BEGIN/COMMIT in C, tuple widening in the SAME commit as A? [Completeness, Spec §FR-017, Design §5]
- [ ] CHK066 - Is the Migration C promotion predicate fully specified (human admins only; system-actor ids enumerated at write time from SYSTEM_ACTORS; invitations filter `consumed_at IS NULL AND expires_at > now()`; D18 row untouched)? [Clarity, Spec §FR-008, Design §5]
- [ ] CHK067 - Is the D7 technical gate requirement precise: WHAT identifies the promotion migration (filename tag), WHERE the assertion runs (pre-migrate, exit 1), and WHICH env value unlocks it (`FEATURE_RBAC_V2 === 'true'` in build env)? [Clarity, Spec §FR-008, Design D7]
- [ ] CHK068 - Are ordering guarantees stated for A→B→C (journal order) AND is the reversed-order behaviour (C-before-B aborts under old guard) a REQUIRED rehearsal, not an accident? [Coverage, Design §5, §10]
- [ ] CHK069 - Is the trigger-rewrite contract (ERRCODE 23514 + `'last-admin-protection'` substring + 0004 return-row) stated as MUST-KEEP with its consumers named, for BOTH the transitional and strict versions? [Completeness, Spec §FR-009, Design §5]
- [ ] CHK070 - Are dev-branch operational requirements defined (when the dev Neon branch receives Migration C, coordinated with PR-3 E2E persona changes)? [Gap, Spec §Assumptions, Design §9 PR 3]

## Flag Lifecycle & Rollback (§6.2)

- [ ] CHK071 - Is each flag window's OFF/ON semantics specified separately (PR2→pre-mint, pre-mint→C, C→PR4, PR4→PR5, PR5) with no window left implicit? [Completeness, Spec §FR-007, Design §6.2]
- [ ] CHK072 - Are rollback requirements defined PER WINDOW (before C: flag OFF = true rollback; after C: flag OFF = degraded-safe + demotion; promotion floor on `vercel promote`)? [Completeness, Spec §Edge Cases, Design §6.2]
- [ ] CHK073 - Is the PR-4 default-flip hazard (leftover explicit `'false'` env var silently defeating the zod default) a named verification requirement? [Coverage, Design §6.2 PR4 row]
- [ ] CHK074 - Is the PR-5 deletion scope closed (legacy leg + shim + façade + env read + Vercel env var), so no half-deleted state is a valid end state? [Completeness, Spec §FR-007, Design §6.2]
- [ ] CHK075 - Is the marketing-availability cost during emergency flag-OFF documented BOTH as a requirement (deny, never manager-map) and as a runbook note (operator expectation)? [Consistency, Spec §Edge Cases, Design D16, §11]

## Observability & Verification (§11)

- [ ] CHK076 - Is the expected-denial baseline derivation specified mechanically (§4.1 diff → role×key pairs newly denied) rather than hand-listed, and does it extend when marketing activates? [Clarity, Spec §FR-016, Design §11]
- [ ] CHK077 - Are the alert semantics unambiguous: unexpected pair = wrong-mapping signal/abort; expected pair = PASS evidence, alert only past a per-actor sanity bound? [Clarity, Spec §SC-005, Design §11]
- [ ] CHK078 - Are flag-ON verification requirements a CHECKLIST with an abort criterion (not "verify it works") — including what the operator observes with the D18 persona? [Measurability, Spec §SC-006, Design §11]
- [ ] CHK079 - Does the runbook requirement enumerate ALL steps end-to-end (pre-mint → flag flip + verification → C merge/deploy with gate + information_schema check → promotion floor → per-window rollback → PR-4 env verify → PR-5 env delete → bundle-change procedure → READ_ONLY_MODE)? [Completeness, Spec §FR-016, Design §11]
- [ ] CHK080 - Is the silent-no-op class covered by TWO named layers (Phase-3 `REQUIRED_ENUM_VALUES` assertion primary; runbook `information_schema` check backstop)? [Coverage, Spec §FR-017, Design §14]

## Test-Infrastructure Requirements (§10)

- [ ] CHK081 - Are E2E persona re-provisioning requirements explicit (fresh plain-admin `E2E_ADMIN_*` post-C; `E2E_SUPER_ADMIN_*` restricted to users/audit/erasure/settings suites; `E2E_MARKETING_*` in PR 4) with the vacuous-coverage rationale recorded? [Completeness, Spec §Edge Cases, Design §9 PR 3]
- [ ] CHK082 - Are live-Neon rehearsal requirements pinned to the mechanism (transaction-wrapped + ROLLBACK on shared dev; population reduced in-tx; reads real migration files — never stubbed counts)? [Clarity, Design §10]
- [ ] CHK083 - Is the characterization CI-job requirement explicit that `FEATURE_RBAC_V2` must NOT be force-set in `tests/setup.ts` (the job parameterises the env), so both legs genuinely run? [Coverage, Design §10]
- [ ] CHK084 - Are the gate-wiring edits themselves named deliverables (`.husky/pre-push` line + `quality-gates.yml` static step for `check:staff-page-guard`), so the gate cannot exist unwired? [Completeness, Design §6.3]

## Dependencies & Assumptions

- [ ] CHK085 - Is the operator-availability assumption for the cutover session (pre-mint → verify → merge C in one sequenced session) stated, with what happens if the session is interrupted mid-window? [Gap, Spec §SC-006, Design §11]
- [ ] CHK086 - Are the bundle-change (post-ship role tweak) procedure requirements defined — code change + deploy + which reviews re-run (sensitive-flag diff) — so Phase-1 maintenance is not undefined? [Completeness, Design §4.2, §11]

## Notes

- CHK085 is the only item with no existing anchor — answer belongs in the runbook requirement (design §11) or spec §Edge Cases.
