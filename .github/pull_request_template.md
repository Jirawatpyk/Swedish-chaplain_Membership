## What and why

<!-- One paragraph: what changes for whom, and why. Link the spec (specs/<nnn-name>/spec.md) or, for a size-S change, state the Done-when lines below. Size: S / M / L. Flow: feature-flow / Spec Kit. -->

## Done when — with evidence

<!-- One line per Done-when line in the spec, each with its evidence: test name, command output, numbers, screenshot. -->

- [ ] …

## Definition of Done (`docs/workflow.md`)

<!-- Tick only what has evidence; strike through lines that don't apply. -->

- [ ] M / L: `plan.md` agreed before build, and matching what was built
- [ ] Each behaviour has a test that went red before the code that made it pass
- [ ] `pnpm check` · `pnpm test:coverage` · `pnpm vitest run tests/contract/` green
- [ ] Touched integration suites green (by path, `dev` branch); cross-tenant test for a tenant-scoped surface
- [ ] Migration applied on `dev`, DDL confirmed in `information_schema`, unique `when` in `_journal.json`
- [ ] Touched e2e specs green on chromium + mobile-chrome
- [ ] Review: every High fixed, every Medium fixed or reasoned below, reviewer re-run after substantial fixes, `whole-branch-reviewer` done
- [ ] UI: `enterprise-ux-designer` pass; EN / TH / SV; 320 px and a 32 px font checked
- [ ] Sensitive surface (auth / RBAC / payment / PII / audit / GDPR): two reviewers, security checklist signed
- [ ] Docs: `docs/changelog.md`; `docs/operational-state.md` if a flag moved; module rule if a trap or dependency was added; `docs/decisions.md` if a decision was made
- [ ] New flag OFF; unflagged behaviours listed below
- [ ] No `test.fixme` / bare `test.skip`, no secrets, no `.env*`, no PII workbook

## Review findings

<!-- Reviewer · severity · finding · how it was closed (commit) or why it was not taken (Medium only). -->

## Unflagged on merge

<!-- Behaviours that go live on merge regardless of any flag, or "none". -->
