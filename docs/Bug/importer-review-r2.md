counts: {"raw": 40, "deduped": 14, "survived": 14, "sweep_new": 8, "final": 15}

[1] CONFIRMED/bug scripts/import-members.ts:177
    PARTIAL path inserts every new contact as isPrimary:false on the assumption 'the member already has its primary', but it never verifies the existing member actually has an ACTIVE primary. existingMemberId is set whenever ANY one matching contact is active — that active contact may be a non-primary while the member's primary was soft-deleted. The import's own primary contact is then inserted as non-primary, leaving the member with zero active primary contact (the contacts_one_primary_per_member partial index permits zero, so no DB error).

[2] CONFIRMED/bug scripts/import-members.ts:181
    PARTIAL path unconditionally inserts new contacts with isPrimary:false (line 185), assuming the existing member already has an active primary. But the member is matched via ANY surviving active contact, not specifically its primary. If the member's original primary was soft-deleted while a non-primary active contact still exists, the `emails.every(active)` skip (line 172) fails, the code enters the PARTIAL branch, and adds the new contacts as non-primary too — leaving the member with ZERO active primary contacts. The DB partial unique index (contacts_one_primary_per_member) only enforces AT MOST one primary, not at-least-one, so nothing rejects this; the exactly-one-primary spec invariant (spec §1) is silently violated. No test covers this (the soft-deleted-primary integration test at line 150 exercises the NEW-member branch, not PARTIAL).

[3] CONFIRMED/bug scripts/import-members/validate.ts:207
    member_field_mismatch compares RAW cell strings (norm = trim+lowercase only), not resolved/canonical values, for country/taxId/tier. Two rows of the same real company that spell a field differently but equivalently raise a false mismatch warning. The pre-fix code compared tier RESOLUTION outcome, so this is a regression in warning precision for tier.

[4] CONFIRMED/bug scripts/import-members.ts:169
    PARTIAL-path picks the target member arbitrarily via activeRows[0].memberId. The active-rows query has NO ORDER BY, so when an import group's contact emails are already active across TWO different existing members (e.g. a shared consultant email on member M1 plus another existing email on M2), existingMemberId is whichever row Postgres happens to return first. Any genuinely-new contact in that group is then attached to an arbitrary/wrong member.

[5] CONFIRMED/bug scripts/import-members.ts:185
    PARTIAL path always inserts new contacts as isPrimary:false on the assumption 'the member already has its primary', but that is never verified. If the existing member's only active contact is non-primary (its primary was soft-deleted), the member ends up with active contacts and STILL no active primary — the residual of Round-1 findings [2]/[8] that the fix only closed for the NEW-member path.

[6] CONFIRMED/bug tests/integration/scripts/import-members.test.ts:127
    The new PARTIAL-path test only exercises the same-member case (re-running ONE company with one pre-existing + one new contact). It does NOT cover the cross-member email scenario where a group's emails belong to two different existing members — the exact regression the activeRows[0] pick introduces — so the suite is green while the arbitrary-attachment bug goes undetected.

[7] CONFIRMED/bug scripts/import-members.ts:177
    PARTIAL path (existingMemberId truthy) always inserts the import group's new contacts with isPrimary:false, but the existing member was matched via ANY surviving active contact (activeRows[0]), not specifically its primary. If that member's original primary was soft-deleted (its non-primary active contact still survives), the member ends with active contacts but ZERO active primary. The contacts_one_primary_per_member partial unique index only enforces at-MOST-one primary, so no DB error fires — the spec 'exactly one primary' invariant is silently violated.

[8] CONFIRMED/bug scripts/import-members.ts:169
    existingMemberId = activeRows[0]?.memberId picks an arbitrary member when the import group's emails are active across TWO different existing members. The active-rows SELECT has no ORDER BY, so [0] is whatever Postgres returns first. Any genuinely-new contact in that group is then attached to a non-deterministic / wrong member, and the group's Excel-marked primary is silently demoted to is_primary:false on that wrong member.

[9] CONFIRMED/bug scripts/import-members/validate.ts:207
    member_field_mismatch now compares RAW trim+lowercase cell strings for country/taxId/tier instead of resolved/canonical values. For tier this is a regression: the pre-fix code compared tierResolver.resolve() OUTCOME, so 'Premium' vs 'Premium Corporate' (both resolving to plan_id premium) produced NO warning; post-fix they norm-differ ('premium' vs 'premium corporate') and raise a false member_field_mismatch warning. The same raw-string compare also false-flags equivalently-formatted taxId/country (e.g. '0105500000000' vs '01055 0000 0000', or 'th' vs 'Thailand').

[10] CONFIRMED/bug tests/unit/scripts/import-members-columns.test.ts:59
    The local-component date regression test (new Date(2026,0,15) → '2026-01-15') is a vacuous guard on a UTC CI runner. Verified: under TZ=UTC the OLD buggy toISOString().slice(0,10) ALSO yields '2026-01-15', so the test passes against both the fixed and the buggy implementation — it only fails (and only proves the off-by-one fix) when the process TZ is non-UTC (e.g. the maintainer's Asia/Bangkok box). vitest.config.ts pins no TZ, so in CI a regression to toISOString would slip through silently.

[11] CONFIRMED/cleanup tests/unit/scripts/import-members-columns.test.ts:59
    The mapDataRows local-component-date test uses new Date(2026,0,15) and asserts '2026-01-15'. In a UTC CI runner (the default here) both the new local-component formatter and the OLD toISOString().slice(0,10) implementation produce '2026-01-15', so the test does NOT actually prove the off-by-one fix — it only fails if the suite runs in a non-UTC timezone. The fix is correct, but the test is effectively vacuous as a regression guard in CI. A case with a non-midnight time component or an explicit assertion against a UTC-shifting value (e.g. a date whose local day differs from its UTC day) would lock the behavior.

[12] CONFIRMED/cleanup tests/unit/scripts/import-members-columns.test.ts:74
    The local-component date test only distinguishes the fix from the old buggy toISOString() code when the test process runs in a non-UTC timezone. vitest.config.ts pins no TZ env (jsdom only), so on a UTC CI runner new Date(2026,0,15) → '2026-01-15' under BOTH the old and new cellToString implementations — the regression guard for the off-by-one fix is silently inert there. Same gap applies to the parseGregorianDate/cellToString round-trip assertions. Pin TZ (e.g. process.env.TZ='Asia/Bangkok' in vitest setup) so the off-by-one guard actually fires in CI.

[13] CONFIRMED/cleanup scripts/import-members/report.ts:24
    skippedPrimaryCollisionMembers (and the new PARTIAL mis-attach paths) are surfaced ONLY as aggregate counts in CommitOutcome — there is no rowIndex-keyed RowIssue emitted for a skipped or mis-routed member. validateRows already carries ValidatedMember.rowIndices and the report's issue list is rowIndex-only (PII-free per spec § 7), so per-row commit-phase notices were feasible. As written, when a member is skipped on primary collision or a contact is attached to an unexpected existing member, the operator sees a number but cannot identify which Excel row(s) need manual resolution — defeating the stated 'operator must resolve the collision manually' intent.

[14] CONFIRMED/cleanup scripts/import-members.ts:172
    The emails.every((e) => activeEmails.has(e)) idempotency skip returns true for an empty emails array (vacuous .every), which would classify a zero-contact member as 'already imported'. It is only safe because validateRows rule 1 rejects zero-contact members upstream — a hidden cross-module coupling with no guard at the commit boundary.

[15] CONFIRMED/cleanup tests/unit/scripts/import-members-workbook.test.ts:40
    The blankrows:true change in readWorkbook (import-members.ts:74-82) is justified by a rowIndex-alignment claim (interior blank rows keep their slot so report rowIndex matches the true Excel row), but the only workbook fixture has no interior blank row. I verified the fix is genuinely correct via SheetJS, yet the central behavior of the change is locked in by zero tests, so a future regression to blankrows:false would re-introduce the off-by-one silently.

