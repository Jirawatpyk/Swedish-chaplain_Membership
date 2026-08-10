# Security Requirements Quality Checklist: 016 RBAC Permissions

**Purpose**: Validate that the authorization requirements (spec.md + design v2 rev 3) are complete, unambiguous, internally consistent, and measurable — BEFORE tasks are cut. This is the Gate-4 security checklist that the Review Gate co-sign (Constitution v1.4.2 footer template) will later reference.
**Created**: 2026-08-10
**Feature**: [spec.md](../spec.md) · design companion `docs/superpowers/specs/2026-08-10-rbac-permission-system-design.md`

**Note**: Items test the REQUIREMENTS, not the implementation. `[Gap]` = missing requirement; `[Ambiguity]`/`[Conflict]` = wording defect to fix in spec/design before `/speckit.tasks`.

## Requirement Completeness — positive gates

- [ ] CHK001 - Is a positive permission requirement stated for EVERY class of staff surface (pages, API handlers, nav/palette data), with none left to "is signed in" semantics? [Completeness, Spec §FR-004, §FR-005]
- [ ] CHK002 - Are the 17 currently-ungated pages individually enumerable from the requirements (or from a referenced inventory), so "all pages gated" is checkable rather than aspirational? [Completeness, Spec §SC-001, Design §6.1]
- [ ] CHK003 - Are requirements defined for ALL FOUR call-site pattern classes (raw comparisons, escalate/demote ternaries, `as`-casts, default-deny if-chains) — not just raw comparisons? [Completeness, Spec §FR-005, Design §6.1]
- [ ] CHK004 - Are audit-emitter requirements (real role, no coercion, union widening incl. the F6 audit-port enum) stated for every emitter that today coerces unknown roles? [Completeness, Spec §FR-006, Design §6.1]
- [ ] CHK005 - Is the complete set of `superAdminOnly` keys enumerated in one authoritative place (design §4.1), and does the spec forbid adding SA keys outside it? [Completeness, Spec §FR-002, §FR-003]
- [ ] CHK006 - Are requirements defined for the six users-route mutations covering BOTH target classes (staff target → `users.manage`; member target → `users.member_accounts`) with per-target-role expectations? [Completeness, Spec §US1-AS5, Design §7.1]

## Requirement Clarity — evaluator, shim, flag

- [ ] CHK007 - Is "byte-identical flag-OFF behaviour" operationalised (observed-behaviour characterization cells, anti-circularity rule) rather than left as prose? [Clarity, Spec §FR-007, Design §6.1]
- [ ] CHK008 - Is the shim grammar unambiguous that `legacySessionOnly` applies ONLY to the 17 ungated pages, and every API row maps to its real current guard (multi-row keys like `settings.invoicing` spelled out)? [Clarity, Design §6.1, round-3 Criticals]
- [ ] CHK009 - Is the evaluator purity requirement precise about WHERE env reads are permitted (`src/lib/rbac.ts` only) and that client components receive booleans as props, never the flag? [Clarity, Design §6.1 purity pin]
- [ ] CHK010 - Is `super_admin` bypass scope stated as TOTAL (no carve-outs), so no reader can infer super_admin is subject to bundle content? [Clarity, Spec §FR-003, Design §3]
- [ ] CHK011 - Is the D16 totalisation stated per-role and per-leg (flag-OFF: super_admin→admin semantics; marketing→DENY) with the availability cost explicitly accepted? [Clarity, Spec §Edge Cases, Design D16]
- [ ] CHK012 - Are the pinned legacy folds (credit-note reads → `invoicing.read`; draft delete → `invoicing.write`; receipt-PDF download → `invoicing.read`) recorded so the sweep cannot re-litigate them? [Clarity, Design §4.1]

## Requirement Consistency

- [ ] CHK013 - Do spec FR-002's "37+ keys" and the design §4.1 pinned 40-key table agree on which artefact is authoritative, and is ADD-only evolution (never rename/repurpose) stated in both? [Consistency, Spec §FR-002, Design §4.1]
- [ ] CHK014 - Are the denial conventions consistent between FR-004 (404/403), D9 (F6 per-role override), and the contracts file — with the F6 families' `role_violation_blocked` taxonomy kept ALONGSIDE `permission_denied`? [Consistency, Spec §FR-004, §FR-006, Design D9]
- [ ] CHK015 - Do the D4 narrowing enumeration (manager losses) and US2-AS1's flag-OFF assertions (manager still DENIED on users routes, erasure, invoice-settings mutations) describe the same manager surface without contradiction? [Consistency, Spec §US2-AS1, Design D4]
- [ ] CHK016 - Is `directory.export` consistently manager-✓ everywhere it appears (⚑ #2 behaviour-preserving), with no surface list implying marketing or narrowing manager? [Consistency, Spec §Clarifications, Design §4.1]
- [ ] CHK017 - Do the audit-viewer redaction requirements distinguish ON-leg (permission-keyed) from OFF-leg (today's projection exactly) without a contradictory "never a role literal" claim spanning both legs? [Consistency, Spec §FR-011, Design §4.3]

## Scenario & Edge-Case Coverage

- [ ] CHK018 - Are last-super-admin requirements defined for ALL FOUR removal paths (demote, disable, delete, erase) at BOTH layers, including the erase path that has no pre-flight today? [Coverage, Spec §US1-AS4, §FR-009, Design D13]
- [ ] CHK019 - Are unknown/future-role scenarios specified for BOTH legs (deny, never escalate, never empty-escalate, audited with the literal role string)? [Coverage, Spec §Edge Cases, Design §6.1]
- [ ] CHK020 - Are the three system-actor rows' exclusion requirements stated with the canonical source (SYSTEM_ACTORS) and a post-promotion assertion? [Coverage, Spec §FR-008, Design §5]
- [ ] CHK021 - Are in-flight invitation scenarios covered across promotion (unconsumed+unexpired promoted atomically; expired skipped; redeem tamper-check coherence)? [Coverage, Spec §US1-AS6, Design §5]
- [ ] CHK022 - Is the SA-orphan window (flag ON before any SA exists) closed by an explicit requirement (D18 pre-mint + bootstrap refusal condition)? [Coverage, Spec §Edge Cases, Design D18]
- [ ] CHK023 - Are concurrency scenarios on the last-SA invariant addressed (racing demotes → DB trigger backstop; the accepted app-guard race residual between C and PR 5 named with its recovery)? [Coverage, Edge Case, Design §6.3]
- [ ] CHK024 - Are requirements defined for the promotion-migration failure modes: premature merge (build fails), silent no-op (`REQUIRED_ENUM_VALUES` + information_schema), reversed order C-before-B (abort)? [Coverage, Spec §FR-008, §FR-017, Design §5]

## Acceptance Criteria Quality

- [ ] CHK025 - Is SC-001 (100% surfaces declared) mechanically checkable from the stated gates (`check:staff-page-guard` + exhaustiveness test) rather than by manual audit? [Measurability, Spec §SC-001]
- [ ] CHK026 - Is SC-002 (zero behaviour change outside D4) verifiable ONLY against observed-behaviour cells — and is the D4 exception list closed (exhaustive), so "outside" is decidable? [Measurability, Spec §SC-002, Design D4]
- [ ] CHK027 - Is SC-006 (zero staff-lockout minutes) accompanied by requirements that make it falsifiable during cutover (verification checklist, expected-denial baseline as PASS evidence, abort signal)? [Measurability, Spec §SC-006, Design §11]
- [ ] CHK028 - Does SC-005's "100% of denials audited" state the fail-open exception (emit failure still serves denial) so the criterion cannot be read as requiring emit success? [Measurability, Spec §SC-005, §FR-006, Design D12]

## Dependencies, Assumptions & Threat Alignment

- [ ] CHK029 - Is the single-tenant assumption (global `users.role` acceptable until F10) stated WITH its trigger condition (second tenant ⇒ F10 before/with Phase 2)? [Assumption, Spec §Assumptions, Design D1]
- [ ] CHK030 - Is the F13 name-collision risk addressed as a requirement (`platform_admin` reserved, never defined here)? [Dependency, Design D1, §14]
- [ ] CHK031 - Are the OWASP broken-access-control mitigations traceable from requirement to gate (positive gates ↔ SC-001; escalation ternaries ↔ FR-005; deny-list removal ↔ US2)? [Traceability, Spec §US2, plan Constitution §I]
- [ ] CHK032 - Does the requirement set state who MAY hold `users.manage` in the end state (SA only) such that privilege-escalation-via-role-assignment is closed by construction (no role can grant itself upward)? [Coverage, Spec §US1-AS3, Design D3]

## Notes

- Check items off as completed: `[x]`; record the fix location (spec §/design §) inline for any item that required an edit.
- Any UNRESOLVED [Conflict]/[Ambiguity] item blocks `/speckit.tasks`.
