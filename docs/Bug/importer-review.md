counts: {"raw": 65, "deduped": 22, "survived": 21, "sweep_new": 8, "final": 15}

[1] CONFIRMED/bug scripts/import-members.ts:133
    Member-level idempotency skip fires if ANY one contact email is already active; a member that has one pre-existing contact plus genuinely NEW contacts is skipped entirely, dropping the new contacts.
    SCENARIO: A prior partial run (or a manual add) created contact A (active) for a company; the import file lists that company with contact A AND a new contact B. On re-run, the activeRows query matches A, so skippedExistingMembers++ and `continue` — the member is skipped and contact B is never inserted. Spec §

[2] CONFIRMED/bug scripts/import-members.ts:178
    When a contact's email matches a SOFT-DELETED row it is skipped, but the member row was already inserted — if the skipped contact is the (single) primary, the member is committed with ZERO primary contacts (and possibly zero contacts at all), silently violating FR-003 'exactly one primary per member'.
    SCENARIO: validateRows guarantees exactly one isPrimary:true contact. In commit, that primary's email happens to match a previously soft-deleted contact (e.g. a member re-joining after archival). The member INSERT at line 151 already ran; the primary contact hits softEmails.has(...) and is skipped (skippedSof

[3] CONFIRMED/bug scripts/import-members/coerce.ts:62
    Date.parse fallback accepts ambiguous/locale/partial strings and silently produces WRONG dates (and off-by-one under Asia/Bangkok UTC+7), instead of rejecting them.
    SCENARIO: Operator runs in Asia/Bangkok (confirmed UTC+7). Cells that aren't leading-ISO fall to Date.parse, which is locale/engine-dependent: '2026' => 2026-01-01 (invented Jan 1); 'Jan 2026' => 2025-12-31 (WRONG YEAR via TZ shift); US-style '01/13/2026' => stored 2026-01-12 (off-by-one, local-midnight -> pr

[4] CONFIRMED/bug scripts/import-members/coerce.ts:58
    The ISO branch builds new Date(`${y}-${m}-${d}T00:00:00.000Z`) without validating that the day is in range for the month. JS rolls a day overflow forward instead of rejecting it, so an out-of-range day silently becomes a different (wrong) date rather than a date.invalid error.
    SCENARIO: Cell '2026-02-30' matches /^(\d{4})-(\d{2})-(\d{2})/, constructs Date('2026-02-30T00:00:00Z') which JS normalizes to 2026-03-02. The year (2026) passes isGregorianYear, so the row is accepted and the member is stored with registration_date 2026-03-02 — a silently wrong date a full month off, with no

[5] CONFIRMED/bug scripts/import-members.ts:71
    readWorkbook reads with { cellDates: true } but NOT { UTC: true }. SheetJS parses Excel date serials into JS Dates at LOCAL midnight; on the operator's Asia/Bangkok (UTC+7) machine, cell 2026-02-03 becomes 2026-02-02T17:00:00Z. columns.ts cellToString then does v.toISOString().slice(0,10) → '2026-02-02' — one day earlier. parseGregorianDate ISO-parses it cleanly (no error) and commitMembers stores the off-by-one registration_date.
    SCENARIO: Operator in Bangkok imports a workbook with native Excel date cells. Every registration_date is stored one day earlier than the spreadsheet shows, corrupting F8 renewal math. No test catches it: every unit/integration test hand-constructs Dates as new Date('...T00:00:00Z') or passes ISO text strings

[6] CONFIRMED/bug scripts/import-members/validate.ts:141
    Member grouping keys solely on normalized company name (normCompanyKey: trim+lowercase+collapse-spaces). Two DISTINCT legal entities sharing a display name are silently merged into one member, their contacts combined, and every member-level field (country, taxId, tier, registrationDate, turnover, city...) is taken from the group head (groupRows[0]) — the second entity's values are discarded with no warning (only 'tier' mismatch is even checked, lines 198-202).
    SCENARIO: SweCham's ~131-company workbook contains two different members both named e.g. 'Scandinavian Trading Co Ltd' (or one row 'ABC Co' and another 'abc co'). They collapse to one member row; one company's tax_id/country/registration_date is silently dropped and its contacts attach to the wrong company. N

[7] CONFIRMED/bug scripts/import-members/validate.ts:223
    An invalid contact phone is recorded as a hard ERROR (err 'invalid_e164'), which raises the group's error delta and sets memberHasError → the ENTIRE member (and all its valid contacts) is dropped. Spec §3 rule 6 says only 'normalize to E.164 or is empty (never store malformed)' — i.e. drop the bad phone value, not the member. asPhone also requires a leading '+', so common Thai local-format numbers like '0812345678' fail.
    SCENARIO: A large fraction of SweCham rows have Thai phones entered as local '08x-xxx-xxxx' (no +66). Each such row throws an invalid_e164 error that excludes the whole otherwise-valid member from the import, instead of just nulling the phone and warning — many members silently missing after --commit.

[8] CONFIRMED/bug scripts/import-members.ts:151
    Soft-deleted-contact skip can leave a member with ZERO contacts and/or NO primary. The member row is inserted unconditionally (line 151) after the active-email check passes, but the per-contact loop (line 178-182) skips every contact whose email matches a soft-deleted row. If all (or the only) contacts are soft-deleted, the committed member ends up with no contacts at all; if the skipped one was the primary, the member has no primary contact. The DB index contacts_one_primary_per_member is partial-unique (at-most-one), so it does NOT catch zero-primary/zero-contact — no error is raised.
    SCENARIO: A member previously archived (its contact soft-deleted via removed_at). On import, activeRows is empty (soft-deleted rows are filtered by isNull(removedAt)), so the member is NOT treated as existing → a fresh members row is inserted. Then the single contact is in softEmails → skipped. Result: an orp

[9] CONFIRMED/bug scripts/import-members/coerce.ts:61
    parseGregorianDate's fallback uses Date.parse() for any non-ISO cell. Date.parse interprets slash-dates as US M/D/Y and parses in LOCAL time. On a UTC+7 Bangkok operator machine the resulting Date is midnight local = 17:00 UTC the previous day, and import-members.ts:159 slices toISOString() to YYYY-MM-DD, storing the date off-by-one-day. Worse, ambiguous DD/MM vs MM/DD inputs silently parse to the wrong calendar date with no validation error.
    SCENARIO: Workbook cell '03/04/2026' (operator means 3 April, EU/Thai convention). Date.parse parses it as 4 March in local time -> Date 2026-03-03T17:00:00Z on UTC+7 -> stored registration_date '2026-03-03'. Both the month/day swap and the timezone day-shift are silent (res.ok === true), corrupting F8 renewa

[10] CONFIRMED/bug scripts/import-members/columns.ts:79
    cellToString converts a SheetJS cellDates Date via `v.toISOString().slice(0,10)`; SheetJS builds dates at LOCAL midnight, so under Asia/Bangkok (UTC+7) toISOString yields the PREVIOUS calendar day (off-by-one).
    SCENARIO: The most common real path: registration date is stored as an actual Excel date-typed cell (not ISO text). readWorkbook uses cellDates:true, so the cell arrives as a JS Date constructed at local-midnight Bangkok. `v.toISOString().slice(0,10)` of 2026-01-15 local-midnight in UTC+7 renders '2026-01-14'

[11] CONFIRMED/bug scripts/import-members.ts:76
    readWorkbook parses with `blankrows: false`, which drops truly-empty Excel rows from the array; mapDataRows then computes rowIndex as firstExcelRow + arrayIndex, so every row after a blank gap is reported at the WRONG Excel row number.
    SCENARIO: A real workbook has a blank separator row (e.g. row 3 empty, data resumes row 4). sheet_to_json(blankrows:false) returns [header, row2, row4] (row 3 removed). mapDataRows assigns row4 rowIndex = 2 + arrayIndex(1) = 3. The PII-free report (spec §7) cross-references issues ONLY by rowIndex, so when va

[12] CONFIRMED/bug scripts/import-members.ts:179
    When a contact's email matches a SOFT-DELETED row it is skipped (skippedSoftDeletedContacts++), but the member was already inserted at line 157 and the skip is unconditional — including for the PRIMARY contact. The code inserts members/contacts raw and bypasses F3's primary-contact-invariant policy (stage3-survey.md:454 expected reuse), so nothing forces a surviving primary.
    SCENARIO: A company whose only/primary contact email matches a soft-deleted contact gets its member row created but every contact skipped → an orphan member with ZERO contacts and ZERO primary. The partial unique index contacts_one_primary_per_member permits 0 primaries (it only forbids >1), so there is no DB

[13] CONFIRMED/bug scripts/import-members/validate.ts:133
    emailCounts tallies emails across ALL rows including rows whose company name is blank (those rows are errored at lines 142-144 and skipped from grouping, but remain counted here). A valid email that appears on one blank-company row AND on one legitimate member row gets count===2, so the legitimate contact is wrongly flagged 'duplicate_in_import' at line 213 and its member is excluded.
    SCENARIO: Source workbook has a stray row with an empty Company Name but a filled-in email that duplicates a real member's contact email (e.g. a leftover/partial row). The blank-company row errors on companyName.required, but it still bumped emailCounts. The real member's contact then trips duplicate_in_impor

[14] CONFIRMED/bug scripts/import-members/columns.ts:57
    Each field independently runs norm.findIndex over the alias list, so the SAME header column can be claimed by two different fields (both index[f] point at the same column) and a real first-match field can lose to a later one with no warning. The alias sets are also collision-prone by design (e.g. 'member'->companyName, 'member type'->tier, 'member name'->companyName, 'membership'->tier) — fragile against the real Excel, which the spec says only arrives at run time. Header matching requires an EXACT normalized alias; close-but-unlisted real headers fall to unmappedHeaders and, if required, block with missingRequired (fail-loud, acceptable) but non-required real columns (turnover/city/phone/role/locale) are silently dropped to '' with no surfaced warning.
    SCENARIO: Real workbook uses 'Annual Revenue (THB)' or 'Mobile No.' or 'Tax ID Number' for turnover/phone/taxId. normHeader yields 'annual revenue thb' / 'mobile no' / 'tax id number', none of which are in the alias lists, so those columns map to null and every value becomes '' — turnover/phone silently lost,

[15] CONFIRMED/bug scripts/import-members/coerce.ts:60
    ISO-branch builds `new Date(`${y}-${m}-${d}T00:00:00.000Z`)` with NO range check on the day-of-month. JS rolls overflow forward instead of rejecting, so an out-of-range day silently becomes a DIFFERENT calendar date rather than a `date.invalid` error. Verified: `new Date('2026-02-31T00:00:00.000Z')` → 2026-03-03 (Feb 31 → March 3). The BE/year guard at line 68-71 still passes (year is 2026), so the wrong registration_date is committed. Distinct from the listed Date.parse-fallback item — this is the *preferred* ISO path that the workbook's cellDates round-trip flows through.
    SCENARIO: An operator's workbook (or a cellToString of a slightly-off Excel serial) yields '2026-02-31'; parseGregorianDate returns ok(2026-03-03) with no error; the member is committed with registration_date one-plus month wrong, corrupting F8 renewal math — the exact off-by-N class the BE guard was added to

