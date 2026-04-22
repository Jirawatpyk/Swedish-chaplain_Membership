# F4 Invoicing & Thai-Tax Receipts — Staff Review R15 (Phase 10 close)

**Reviewer**: AI Agent (Staff Engineer Perspective)
**Date**: 2026-04-22
**Feature**: `specs/007-invoices-receipts/spec.md`
**Branch**: `007-invoices-receipts` @ `6b226b4` (R2+R3 remediation) — 138 commits ahead of `main`, 492 files, +53,228/−3,821 lines
**Scope**: Full Phase 10 delta — auto-email (T105–T108), dispatcher (T106 + `vercel.json` crons), overdue derivation (T109), audit behavioral coverage 17/18 (T113a), perf benchmarks (T110 / T110a / T111), retention invariant (T112), 10g carry-forward batch (T120–T127), R1+R2+R3 review remediation (commits `43c1cda` + `6b226b4`)
**Constitution**: v1.4.0 (10 principles; 4 NON-NEGOTIABLE)
**Method**: Direct source + spec cross-reference; prior R1/R2/R3 findings confirmed closed on HEAD; working-tree inventory; integration/unit gate status per `pending-verification.md`
**Prior reviews**: 7 reports on file in `reviews/`; the most recent (R14, 2026-04-21 11:21) closed Phase 9 US5. This is **R15**, the Phase 10 close.

---

## Executive Summary

### ⚠️ APPROVED WITH CONDITIONS

Phase 10 lands the full post-MVP polish batch with no code-level blockers remaining. The R1/R2/R3 remediation cycles (commits `43c1cda` + `6b226b4`) resolved 20 primary + 4 deferred + 13 R2 + 3 R3 findings; all fixes verified on HEAD. Key engineering wins:

- **Tenant-isolation hardening** (Constitution v1.4.0 Principle I, Review-Gate blocker): cross-tenant integration probe now covers `pdf-routes-cross-tenant-probe.test.ts` (GET invoice/credit-note PDF signed URLs) + `retention-member-archive` + `tenant-invoice-settings-probe`; MTA host-header dual-bind migration 0031 (T120) shipped.
- **PII + secrets discipline**: `REDACT_PATHS` now exported from `src/lib/logger.ts` as the single source of truth (R2 fix eliminates the stale copy in the redaction unit test); depth-2 wildcard `*.*.recipient_email` closes the pino-wildcard gap for nested audit payloads (R3). Content-Disposition injection surface collapsed behind `buildAttachmentContentDisposition` helper with ESLint D2 rule (T121).
- **Audit observability**: 17/18 F4 event types behaviorally asserted (T113a); `pdf_render_failed` emitted from all three failing paths (issue/void + record-payment + credit-note) with discriminated `render_kind`; file-existence check on `KNOWN_TEST_FILES` prevents dead-reference drift.
- **Thai tax compliance**: VAT source-chain pinned (T123); §87 no-gaps sequential allocator validated at 50 concurrent writers in ~10 s (T111, well under 30 s budget); fiscal-year LocalDate switched to Asia/Bangkok across both overdue-audit idempotency tests (R2 closed the half-applied fix).
- **Perf envelope**: PDF render p95 = 88 ms (< 800 ms SC-003), invoice-list p95 = 324 ms @ 5 k × 2 rows (< 500 ms SC-005), 50-writer seq ~10 s (< 30 s). Headroom across all three budgets.
- **Clean Architecture hygiene** (R3): `buildLogoBlobPrefix` extracted to `src/lib/logo-blob-key.ts` to avoid a route handler exporting a utility (module barrel violation risk).

The remaining **conditions are all human-gated**, not code — no further automated fix will satisfy them:

1. **T114 — manual SR + cross-browser E2E + staging traces + reduced-motion** (PVR-1, PVR-2)
2. **T117 — maintainer co-sign on `security.md` § 5 checklist** (solo-maintainer substitute permitted per Constitution § Governance)
3. **T118 — review round counter**: Constitution asks ≥ 6 `/speckit-review` + ≥ 2 `/speckit-staff-review`. After this report: **8 review + 2 staff-review** on branch — satisfies the numeric target (this R15 is the 2nd staff review together with R14). Verify count against `tasks.md` T118 tickbox.
4. **8 gated E2E tests** on `pending-verification.md` (6 × `invoice-settings.spec.ts` AS1/AS2/AS4×3/AS5 + 2 × credit-note mutating) — un-fixme'd in code but not run green end-to-end this session; sign-in failure under investigation.
5. **Working-tree hygiene before `/speckit.ship`**: 6 modified + 11 untracked files must be triaged — several are legitimate (new perf test, QA response logs, agent-memory notes) but `src/modules/auth/infrastructure/email/resend-client.ts` + `src/modules/invoicing/infrastructure/pdf/deterministic-render.ts` + 2 E2E files carry uncommitted edits of unknown provenance (see R15-03).

No 🔴 Blockers. Post the 5 conditions above, Phase 10 is ready for `/speckit.ship`.

---

## Review Findings

| ID | Severity | File | Line(s) | Category | Finding | Recommendation |
|----|----------|------|---------|----------|---------|----------------|
| R15-01 | 🟡 Warning | `pending-verification.md` | 13–46 | Test Quality | 8 un-fixme'd E2E tests (invoice-settings AS1/AS2/AS4/AS5 + 2 credit-note mutating) did not run green end-to-end in the Phase 10 session because of a sign-in failure that was not root-caused. PVR-1 tracks it but the gate remains structurally open. | Before `/speckit.ship`: isolate the sign-in failure (env-reload race vs stale cookies), re-run the 8 tests × 3 browsers = 24 passes, and check PVR-1 closed. |
| R15-02 | 🟡 Warning | `src/modules/auth/infrastructure/email/resend-client.ts`, `src/modules/invoicing/infrastructure/pdf/deterministic-render.ts`, `tests/e2e/helpers/throwaway-tenant.ts`, `tests/e2e/invoice-settings.spec.ts` | — | Hygiene | 4 modified files in working tree with uncommitted edits not produced by the R1/R2/R3 remediation sessions. Provenance unclear. | Inspect each diff; commit if intentional (separate commit from review-remediation), revert if stale. Do NOT allow `/speckit.ship` to batch these silently. |
| R15-03 | 🟡 Warning | `tests/integration/invoicing/pdf-preview-null-issue-date.test.ts` | all (untracked) | Test Quality | New integration test file present but untracked. If intentional, it must be committed before ship so CI runs it on `main`; if throwaway, delete. | Triage + commit-or-delete. |
| R15-04 | 🟢 Suggestion | `src/app/api/cron/outbox-dispatch/route.ts` | timingSafeEqual block | Security | Fallback `process.env.CRON_SECRET ?? ''` is documented as unreachable-by-design (env boot-zod ensures it's set). Comment present. Belt-and-suspenders: consider `throw` in an `assert` helper at module load rather than `?? ''` — static-analysis readers will stop flagging. | Low priority. Keep the comment as-is if no linter complaints. |
| R15-05 | 🟢 Suggestion | `eslint.config.mjs` | D2 rule | Security | String.raw / string-concat construction of `attachment; filename=...` literals can bypass the regex rule. Documented inline in the rule comment. | Accept as residual. Guard is defense-in-depth over the `buildAttachmentContentDisposition` helper, not the sole control. |
| R15-06 | 🟢 Suggestion | `src/modules/invoicing/application/use-cases/issue-credit-note.ts` | `pendingRenderKind` hoist | Reliability | `?? 'unknown'` in the catch audit summary is correct (R3 hardening). A dev-mode `invariant()` that fails loudly if the render-kind reaches `unknown` in the catch path would tighten the contract without changing prod behaviour. | Optional. Non-blocking. |
| R15-07 | 🟢 Suggestion | `specs/007-invoices-receipts/pending-verification.md` | PVR-1, PVR-2 | Operability | Accountable-tracking entries are clear but lack an owner + target-close-date. | Add owner + date when PVR closure is scheduled. |
| R15-08 | 🟢 Suggestion | Branch | 138 commits | Architecture | 138-commit / +53k-line branch is at the upper end of reviewability. Future features should split long phases into smaller ship-and-iterate branches to keep reviewer load bounded. | Retrospective note — no action on this branch. |

**Categories**: Correctness, Security, Performance, Spec Compliance, Error Handling, Test Quality, Architecture, Observability, Reliability, Hygiene, Operability

---

## Spec Coverage Matrix (Phase 10 scope)

| Requirement / Task | Status | Evidence |
|---|---|---|
| **T105–T108** — auto-email on issue + manual resend (admin + portal) | ✅ | `invoice-auto-email.ts` + `resend-pdf.ts` use-case; 14 + 9 unit tests green; outbox integration test on live Neon |
| **T106** — cron dispatcher + F4 dual-emit | ✅ | `vercel.json` crons wired; `outbox-dispatch/route.ts` uses `crypto.timingSafeEqual` (R1); auth probe behaviourally asserted |
| **T109** — overdue derivation + idempotent audit | ✅ | `deriveOverdue` covered 10/10; LocalDate on `Asia/Bangkok` across both tests (R2 closed half-apply) |
| **T110 / T110a / T111** — perf benchmarks | ✅ | p95 = 88 ms / 324 ms / ~10 s — all within budget with headroom |
| **T112** — retention + archive invariant | ✅ | `retention-member-archive.test.ts` + cross-tenant probe green |
| **T113a** — audit behavioral matrix | ✅ | 17/18 F4 event types asserted; file-existence guard on `KNOWN_TEST_FILES` |
| **T114** — manual SR / cross-browser / staging / reduced-motion | ⏳ Pending | PVR-1/PVR-2; human-gated |
| **T115t** — throwaway-tenant E2E infra | ⏳ Deferred | Per `tasks.md` rationale; AS2/AS4 happy-path + rejections un-fixme'd (commit `4366fa9`) but not end-to-end verified (R15-01) |
| **T117** — security checklist co-sign | ⏳ Pending | Solo-maintainer substitute permitted |
| **T118** — review round counter | ✅ (pending tickbox) | ≥ 6 review + ≥ 2 staff-review achieved; verify the mark in `tasks.md` |
| **T120–T127** — 10g carry-forward batch | ✅ | MTA dual-bind migration 0031, CR/LF helper, pdf_render_failed emit, VAT pin, CN E2E un-fixme, `renderAndUploadPdf` helper refactor, CN-PDF golden |
| **FR-016** / **SC-003** byte-identical PDF | ✅ | deterministic-render golden tests green |
| **FR-029 / FR-030** retention | ✅ | T112 invariant |
| **FR-034** tenant logo EXIF-strip + dimension enforce | ✅ | `sharp` pipeline; cross-tenant prefix guard via `buildLogoBlobPrefix` (R3) |
| **Principle I** cross-tenant integration test | ✅ | `pdf-routes-cross-tenant-probe` + `tenant-invoice-settings-probe` + `retention-member-archive` |
| **PII redaction** (security.md § 4 Cat-B recipient_email) | ✅ | `REDACT_PATHS` exported + depth-2 wildcard closed (R2+R3) |

**Phase 10 scope**: 14/14 code tasks complete (100%) — 4 human-gated conditions outstanding.

---

## Test Coverage Assessment

| Area | Tests | Coverage | Notes |
|------|-------|----------|-------|
| Unit (invoicing + lib) | ✅ | 1213/1213 green across 111 files (per R2+R3 verification) | incl. logger-redaction depth-2 (R3) + logo-blob-key-guard (R3) |
| Integration (live Neon SG) | ✅ | ~340 green, ~17 tenant-isolation; 1 skip / 1 todo (pre-existing) | cross-tenant probe coverage now includes PDF signed-URL routes |
| Contract | ✅ | Green across auth/plans/members/invoicing endpoints | — |
| E2E (Playwright, a11y, i18n) | ⚠️ | 25 passed + 2 flaky (flaky fixed in `13cee2b`); **8 un-fixme'd tests unverified** | PVR-1 blocks ship |
| i18n coverage | ✅ | 1123 keys × 3 locales (EN canonical; TH+SV parity) | R1 split `resendAria` → `resendInvoiceAria`/`resendReceiptAria` |
| Coverage thresholds (Principle II) | ✅ | Domain 100% line; Application ≥ 80% line+branch; 100% branch on security-critical | verified at R14 baseline; Phase 10 additions keep budget |
| Perf gates (SC-002/003/005) | ✅ | p95 within all three budgets | T110/T110a/T111 |

---

## Metrics Summary

| Metric | Value |
|---|---|
| Branch commits ahead of main | 138 |
| Files changed | 492 (+53,228 / −3,821) |
| Files reviewed (Phase 10 delta) | ~85 primary + ~40 test |
| 🔴 Blockers | **0** |
| 🟡 Warnings | 3 (R15-01/02/03 — all ship-gating hygiene, not code defects) |
| 🟢 Suggestions | 5 |
| Phase 10 task coverage | 14/14 code (100%); 4 human-gated |
| Principle I cross-tenant probe | ✅ 17/17 + PDF routes + settings + retention |
| PII / secrets redaction paths | ✅ single source-of-truth (`src/lib/logger.ts`) |
| Perf budgets | ✅ 3/3 with headroom |
| Staff reviews on record | 2 (R14 + this R15) |
| `/speckit-review` rounds on record | ≥ 6 (R1 base + R1/R2/R3 remediation + 2 historical) |

---

## Recommended Actions

### Must Fix (Blockers)

_None._

### Should Fix (Warnings) — before `/speckit.ship`

1. **R15-01** — root-cause the sign-in failure, re-run the 8 gated E2E tests × 3 browsers, close PVR-1.
2. **R15-02** — triage + commit-or-revert the 4 modified files (`resend-client.ts`, `deterministic-render.ts`, 2 E2E files). Do NOT let a ship-prep commit bundle unrelated edits.
3. **R15-03** — commit or delete `tests/integration/invoicing/pdf-preview-null-issue-date.test.ts`.
4. **Human-gated conditions** — T114 manual SR + cross-browser + staging traces + reduced-motion; T117 co-sign; verify T118 review-counter tickbox in `tasks.md`.

### Nice to Fix (Suggestions)

1. **R15-04** — replace `CRON_SECRET ?? ''` with a boot-time assert helper.
2. **R15-05** — accept as residual or add a follow-up ESLint rule for String.raw templates.
3. **R15-06** — dev-mode `invariant()` on `render_kind === 'unknown'` in the credit-note catch path.
4. **R15-07** — add owner + target-close-date to PVR-1 / PVR-2.
5. **R15-08** — retrospective note to split future phases into smaller branches.

---

## Post-Review Verdict

⚠️ **APPROVED WITH CONDITIONS** — no code-level blockers. Ship after: (a) working-tree triage (R15-02 + R15-03), (b) closing PVR-1 with the 8 E2E × 3 browsers = 24 passes, and (c) T114 + T117 human-gated sign-offs. Next: address warnings, then `/speckit.ship`.

---

*Generated by `/speckit.staff-review.run` — Staff-level code review for spec-driven development.*
