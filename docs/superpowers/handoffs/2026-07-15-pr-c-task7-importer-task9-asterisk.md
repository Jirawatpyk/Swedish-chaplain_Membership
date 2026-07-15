# Hand-off — PR-C: Task 7 (importer) + Task 9 (conditional Tax-ID asterisk)

**For:** a fresh chat picking up where PR-A left off.
**Date:** 2026-07-15.
**Branch:** `060-member-tax-id-required`, cut from `main` **after** PR-A merged (`973b4cc7`, #194). Working tree clean at hand-off.

---

## Where this fits (read first)

PR-A ("F4 tax correctness") **shipped to prod** on 2026-07-15 (#194). It replaced the `legal_entity_type`-derived guess for §86/4 buyer particulars with a **recorded** `members.is_vat_registered` column, and enforced a **`registrant ⇒ TIN` invariant** (a member marked VAT-registered MUST have a `tax_id`, or create/update is rejected). Prod migrations `0250`–`0253` verified applied.

The full PR-A plan is `docs/superpowers/plans/2026-07-14-member-form-pr-a-tax-correctness.md`. The running decision log — read it, it records every reversal and trap — is `.superpowers/sdd/progress.md`. Two tasks were **deliberately deferred** from PR-A to this PR-C:

- **Task 7 — the importer.** It does not yet write `legal_entity_type` / `is_vat_registered`. **This is the go-live blocker** the Thai-tax auditor flagged: running the current importer would give every imported member `legal_entity_type = NULL` + `is_vat_registered = false`, recreating the original defect (no member ever gets the branch line) through a third door.
- **Task 9 — the conditional Tax-ID asterisk.** The zod *rule* already exists (Task 4); only the visual + a11y signal is missing.

Do them in the order that suits you; they touch disjoint files (Task 7 = `scripts/import-members/**`, Task 9 = the member form). Task 9 is ~30 minutes; Task 7 is the substantial one.

---

## Standing constraints (these bit us repeatedly in PR-A — do not relearn them)

- **`pnpm`, never `npm`.** Zero new npm deps.
- **NEVER run `prettier --write`** — `.prettierrc` says printWidth 100 but the repo is ~80-col hand-formatted and no gate enforces it; a format run reflows whole files and destroys the diff.
- **`pnpm typecheck` is NOT in the pre-push hook.** Run `npx tsc -p tsconfig.tsccheck.json --noEmit` as the final gate before every commit. It exits 0 cleanly now (a fix committed in PR-A stops it emitting ~100 phantom errors from `.next/dev/types` while the dev server runs).
- **Read `pnpm lint` output past "0 errors" — warnings matter.** PR-A shipped dead code because I read "0 errors" and moved on; lint had warned. A clean run is `0 problems`.
- **`git mv` stages the RENAME only** — content edits made afterwards are NOT staged. `git status` shows `RM`; the `M` is a separate change you must `git add`. This silently committed the OLD body of a file under its NEW name once.
- **The `dev` Neon branch is SHARED.** `pnpm db:migrate` targets it (safe, not prod). Integration tests hit it via `.env.local`.
- **CRLF/`autocrlf`:** `git diff --numstat` empty + `git diff --ignore-cr-at-eol` empty = a pure line-ending artifact, not a real change. Node scripts that string-match a file must `.replace(/\r\n/g, '\n')` first, or template literals won't match.
- **Do NOT run test suites concurrently** and **do NOT run the full gate repeatedly** — capture output once to a file and grep it. Dynamic-`import()` tests time out at exactly 30s under load; that is contention, not a failure — re-run the file alone to confirm. Contract-test flakes are Upstash rate-limit quota; re-run clears them.
- **Never `git add -A`** (untracked `docs/uat/`, `public/brand/*.png`, prod-cred temp scripts live in the tree). Add explicit paths.
- The user runs the dev server on :3100 — never start/kill it.
- **Push:** the husky pre-push hook fails to spawn in this environment (MSYS fork error — empty output, exit 1). PR-A pushed with `git push ... --no-verify` after running the four fast guards by hand (`pnpm check:layout check:fixme check:template-seed check:dates`). Get the user's OK before `--no-verify`.

---

## TASK 9 — the conditional Tax-ID asterisk (small, do this first)

### The rule
The Tax-ID field must show a required marker **only when the VAT-registered checkbox is ticked**. A permanent `*` would lie to the 37 of 150 TSCC members with no TIN at all (all 15 individuals, all 7 state enterprises, both foundations). This mirrors the two conditional fields the form already has: `date_of_birth` on `needsDob`, `branch_code` on `!isHeadOffice`.

### The zod rule ALREADY EXISTS — do not add it
`src/components/members/member-form/schema.ts:425` (inside the `.superRefine`):
```ts
if (data.is_vat_registered === true && !data.tax_id?.trim()) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tax_id'],
    message: tf('errors.taxIdRequiredForRegistrant') });
}
```
Your job is the **visual + a11y signal that matches it** — an asterisk without the rule is a lie; the rule without the asterisk is a save button that fails for no visible reason. Task 4 gave us the second; Task 9 gives the first.

### What to change
**`src/components/members/member-form/sections/company-section.tsx`** — the Tax-ID block is at **`:306-328`** and currently has **no `RequiredMark` and no `aria-required`** (compare `company_name` at `:117-128` and `legal_entity_type` at `:279-294`, which have both).

1. The VAT flag lives in the **sibling** `TaxBranchSection`, but both sections are under one `FormProvider`, so `CompanySection` can read it. Add near the top of the component (it already imports what it needs; `useWatch` comes from `react-hook-form`):
   ```ts
   const isVatRegistered =
     useWatch({ control, name: 'is_vat_registered' }) === true;
   ```
   `control` is already destructured from `useFormContext` in this component — check. Read-only watch, so no mount-fire hazard (the PR-B Critical class).
2. In the Tax-ID `<Label htmlFor="tax_id">`, render `{isVatRegistered && <RequiredMark />}` (import is already present at `:21`).
3. On the `<Input id="tax_id">`, add `aria-required={isVatRegistered}` — **this is the load-bearing a11y line**: `RequiredMark` is `aria-hidden`, so the asterisk alone is invisible to assistive tech.

### Tests (this file has a documented UI-testing trap)
- **`tests/unit/members/presentation/company-section.test.tsx`** already exists — extend it. Assert: VAT ticked → `label[for="tax_id"]` contains the asterisk AND `#tax_id` has `aria-required="true"`; VAT unticked → neither. Render the REAL `MemberForm` with real `en.json` (that file's convention), toggle `is_vat_registered` via `initialValues`.
- **The Base UI Checkbox trap:** to toggle the VAT box in a test you must click `container.querySelector('input#is_vat_registered')` — the visible `<span role="checkbox">` does NOT drive `onCheckedChange`; the hidden native input (which the `id` lands on) does. `tax-branch-section.test.tsx` (added in PR-A) has the working pattern — copy it.
- `member-form-schema.test.ts` — a schema-level test that the rule fires is likely already there from Task 4; verify, don't duplicate.

### Gate for Task 9
`npx tsc -p tsconfig.tsccheck.json --noEmit` (exit 0) · `pnpm lint` (0 problems) · `pnpm vitest run tests/unit/members/presentation/` · `pnpm check:i18n`.

---

## TASK 7 — the importer reads `Member Type` (the go-live blocker)

The full step-by-step is **Task 7 in the plan** (`docs/superpowers/plans/2026-07-14-member-form-pr-a-tax-correctness.md`, the "### Task 7:" section) — it has the exact test cases and the coercer contract. This section is the context the plan can't give you.

### What it does
`members` is empty in prod (wiped 2026-07-12), so there is **no backfill** — the importer is where every member gets its entity type + VAT flag, once, correctly. It must read TSCC's `Member Type` column, map it to a `LegalEntityTypeCode`, and set `is_vat_registered`.

**Files:** create `scripts/import-members/entity-type.ts`; modify `scripts/import-members/columns.ts` (HEADER_ALIASES + RawRow), `validate.ts` (ValidatedMember + parse), `scripts/import-members.ts:278-295` (the insert); test `tests/unit/scripts/import-members-entity-type.test.ts`.

### The five traps (each cost real debugging in the analysis)

1. **The VAT flag is NOT `VAT_DEFAULT_BY_CODE[code]`.** It is:
   ```ts
   const isVatRegistered = VAT_DEFAULT_BY_CODE[code] === true && taxId !== null;
   ```
   **Why load-bearing, not defensive:** TSCC has **7 State Enterprise members, none with a Tax ID** (they sit in the 37-row "N/A" group with all 15 individuals + both foundations). `VAT_DEFAULT_BY_CODE.state_enterprise === true`. A naive `= VAT_DEFAULT_BY_CODE[code]` produces `is_vat_registered: true` + `tax_id: null` for all seven — which **Task 4's invariant (now live on prod) rejects at create**. The import fails on those rows. Relaxing the invariant would be fixing the wrong end: the invariant is the law. When TSCC later supplies a TIN, an admin ticks the box — a decision, not a derivation.

2. **`Individual` appears in TWO columns** of TSCC's sheet: `Member Type` = บุคคลธรรมดา (legal form, 15 rows) and `Plan` = the Individual membership package (17 rows), unrelated. Reading the wrong column mis-assigns both. The coercer must only ever see the Member Type column. The first plan test pins this.

3. **`columns.ts` already claims `'member type'` as an alias for `tier`** (the plan/package field, ~line 18). Two columns would fight over the header. The tier column is actually headed `Plan`, so **move** `'member type'` off `tier`'s aliases onto the new entity-type field — but verify against the real sheet headers first.

4. **Fail LOUD on an unmapped `Member Type` value.** A silent `NULL` is exactly how the branch line came to be missing from every invoice. Follow the `countryNameToCode` fail-loud pattern in `scripts/import-members/coerce.ts:110` (canonical code → display-name alias → `err`). Emit a warning (not a failure) for `association`/`foundation` where `VAT_DEFAULT_BY_CODE[code] === null`, so the import report tells the admin to confirm those by hand.

5. **Two uncommitted importer bug-fixes** from the 2026-07-12 import run are sitting unstaged/lost: `tax_id` relax + mononym `'-'` handling. **Find them** (check `git stash list`, the reflog, or `project_member_import_blocker` in memory) and fold them into this task, or they vanish. Memory note `[Member import 95/119 DONE]` (`project_member_import_blocker.md`) has the context.

### Entity-type mapping (TSCC's real 150-member sheet)
| Excel `Member Type` | rows | code | i18n key |
|---|---|---|---|
| Private Limited Company (Company Limited) | 111 | `limited_company` | shipped |
| Individual | 15 | `individual` | shipped |
| State Enterprise | 7 | `state_enterprise` | shipped (the one new key) |
| Public Limited Company | 5 | `public_company` | shipped |
| Foundation | 2 | `foundation` | shipped (→ warned) |
| N/A | 10 | `null` | — |

Consumes `LegalEntityTypeCode` + `VAT_DEFAULT_BY_CODE` from `@/modules/members` (shipped in PR-A). Sheet: `docs/import/Membership Database_Since 2025(...)_v2_Excel.xlsx`, sheet `Member Data New` — **gitignored (PII); never commit it or any `docs/*.xlsx`.**

### Also relevant (the Excel leading-zero issue) — importer concern, not the form's
113 of the Tax IDs in the sheet are **12 digits, not 13** — Excel ate the leading zero (`105562087242` is really `0105562087242`). The importer must **left-pad TH tax IDs to 13** before `asTaxId` validates them, or all 113 rows are silently dropped (the checksum + `/^\d{13}$/` reject 12 digits). This is documented in `docs/import/IMPORT_STATUS.md` (gitignored) and the design spec §16.4. It is separate from Task 7's entity-type work but must land before a real import — decide whether it belongs in this PR or a preflight step.

### Gate for Task 7
`npx tsc -p tsconfig.tsccheck.json --noEmit` · `pnpm lint` · `pnpm vitest run tests/unit/scripts/` · a **dry-run against the real sheet** confirming the report reads 111/15/7/5/2(warned)/10(null). Do NOT import to prod from this task — that is a separate, gated operator step, and the deploy checklist (`SELECT count(*) FROM members WHERE is_head_office=false` = 0) must pass first (it does today — prod `members` is empty).

---

## Review + ship

Gate for the PR: **tax + security sign-off, ≥2 reviewers** (Task 7 touches the tax-document data path). Use the specialist roster (`.claude/agents/**`) — `thai-tax-compliance-auditor` for Task 7's VAT-flag derivation, `senior-tester` / `chamber-os-qa-engineer` for the fixture traps (PR-A had TWO checksum-invalid fixtures that made assertions pass for the wrong reason — any 13-digit test TIN MUST pass the real check digit or the test lies). New branch → new PR against `main`.

## Deferred beyond PR-C (do not lose)
`docs/superpowers/follow-ups/2026-07-15-pr-a-gdpr-residuals.md` — four GDPR items (H-1 invite-path Art. 14 notice is the one to close before go-live).
