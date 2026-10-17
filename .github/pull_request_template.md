## What and why

<!-- One paragraph: what changes for whom, and why. Link the spec (specs/<nnn-name>/spec.md) or, for a size-S change, state the Done-when lines below. Size: S / M / L. Flow: feature-flow / Spec Kit. -->

## Done when — with evidence

<!-- One line per Done-when line in the spec, each with its evidence: test name, command output, numbers, screenshot. -->

- [ ] …

## Definition of Done (`docs/workflow.md`)

<!-- Tick only what has evidence; strike through lines that don't apply. -->

- [ ] M / L: `plan.md` agreed before build, and matching what was built
- [ ] L slice: this PR sets its own row in the `plan.md` Slices table to its PR number and `done` (D-020)
- [ ] Each behaviour has a test that went red before the code that made it pass
- [ ] `pnpm check` · `pnpm test:coverage` · `pnpm vitest run tests/contract/` green
- [ ] Touched integration suites green (by path, `dev` branch); cross-tenant test for a tenant-scoped surface
- [ ] Migration applied on `dev`, DDL confirmed in `information_schema`, unique `when` in `_journal.json`
- [ ] Touched e2e specs green on chromium + mobile-chrome
- [ ] Review: no High or Medium left (fixed, or refuted with evidence and confirmed on re-run), Lows fixed or listed below, `whole-branch-reviewer` done if the review was split; M / L: `spec-compliance-auditor` confirmed every Done-when line against its evidence
- [ ] UI: `enterprise-ux-designer` pass; EN / TH / SV; 320 px and a 32 px font checked
- [ ] Sensitive surface (auth / RBAC / payment / PII / audit / GDPR): ≥2 reviewers or the solo-maintainer review (`review-and-ship` § 2), security checklist signed
- [ ] Docs: `docs/changelog.md`; `docs/operational-state.md` if a flag moved; module rule if a trap or dependency was added; `docs/decisions.md` if a decision was made
- [ ] New flag OFF; unflagged behaviours listed below
- [ ] No `test.fixme` / bare `test.skip`, no secrets, no `.env*`, no PII workbook

## Review findings

<!-- Reviewer · severity · finding · the fixing commit, or the refutation evidence + the reviewer re-run that confirmed it. Lows may stay open only if listed here. -->

## Unflagged on merge

<!-- Behaviours that go live on merge regardless of any flag, or "none". -->
