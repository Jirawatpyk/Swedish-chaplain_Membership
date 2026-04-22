# Spec Drift Report

Generated: 2026-04-22
Project: Chamber-OS (SweCham / TSCC — first tenant)
Active branch: `007-invoices-receipts`
Scope: 7 specs (001–007) — deep analysis on 007 (active), status summary on 001–006 (shipped / review-ready)

---

## Summary

| Category | Count |
|---|---|
| Specs Analyzed | 7 |
| Functional Requirements surveyed | 211 (F1=25, F2=36, F3=53, F4=43, F5=19, F6=12, F7=23) |
| Success Criteria surveyed | 82 |
| ✓ Aligned | 198 (≈ 94 %) |
| ⚠️ Drifted | 3 (≈ 1.4 %) |
| ✗ Not Implemented (by-design deferral or WIP) | 10 (≈ 4.7 %) |
| 🆕 Unspecced code of material size | 0 (of material size — UI-infra spec 006 was itself the "unspecced" F5-track work that was retro-specced) |

> The "drifted" count is small because branches `002/003/004/005/006/007` were all developed under Spec Kit discipline with Constitution v1.4.0 gates — FRs were pinned in code comments and tests before implementation. The 3 drift items are narrowly scoped polish gaps. See Detailed Findings.

---

## Detailed Findings

### Spec: 007-invoices-receipts — F4 Invoices & Thai-Tax Receipts (ACTIVE)

42 FRs in spec (FR-001 … FR-042). Grep of `src/modules/invoicing/**` + `tests/**` finds explicit `FR-###` comment references for **36/42**. The 6 FRs without an explicit comment tag are nonetheless implemented (verified by direct code inspection + integration tests); project convention tags FRs at use-case / test granularity, not at every surface.

#### Aligned ✓ (40 / 42)

FR-001 … FR-003, FR-005 … FR-017, FR-019 … FR-025, FR-028 … FR-030, FR-032 … FR-038, FR-040, FR-042 →
See `src/modules/invoicing/{domain,application,infrastructure}/` + `src/app/(staff)/admin/invoices/**` + `src/app/(member)/portal/invoices/**` + `tests/integration/invoicing/**`.

**FR-004** (Thai RD-compliant bilingual PDF) — implemented via `react-pdf-render-adapter` + golden tests. *No code comment tag*; covered by `tests/unit/invoicing/deterministic-render.test.ts` + `credit-note-pdf-golden`.

**FR-018** (SV/EN/TH locale rendering, bilingual PDF) — implemented; 1 123 i18n keys × 3 locales; `check:i18n` green.

**FR-026** (email-delivery failure surfaced + NOT rolling back financial event) — implemented via outbox dispatcher pattern + admin `resend-pdf` use-case + portal resend.

**FR-027** (due_date = issue_date + tenant.default_net_days, snapshotted) — `src/modules/invoicing/application/use-cases/issue-invoice.ts:257` — `dueDate = addDays(issueDate, settings.defaultNetDays)` + `netDaysSnapshot` persisted.

**FR-039** (Preview vs Issue button distinction) — `src/app/(staff)/admin/invoices/[invoiceId]/page.tsx:268,275` — Preview is a `href` link with `actions.preview` label; Issue is an `IssueInvoiceDialog` typed-phrase confirmation (primary).

**FR-041** (mobile Content-Disposition behaviour) — `src/lib/content-disposition.ts` + D2 ESLint rule; helper enforces `attachment; filename={document_number}.pdf`.

#### Drifted ⚠️ (1 / 42)

- **FR-044** *(out-of-scope code reference)* — `tests/e2e/members-reduced-motion.spec.ts:2` cites `FR-044`, but F4 spec only defines up to FR-042. FR-044 is actually an **F3 (005-members-contacts)** reduced-motion requirement. Minor cross-reference drift — not a scope or behavior bug, just a potentially confusing comment. **Severity: minor.** **Location**: `tests/e2e/members-reduced-motion.spec.ts:2`. **Fix**: nothing to fix in code; the FR-044 tag is correct for F3. Optional: cross-reference the F3 spec path in the test file header to avoid future readers thinking it's F4.

#### Not Implemented ✗ (1 / 42 — by design)

- **FR-031** (GDPR/PDPA data-access, export, erasure for tax documents) — **F9 scope**. The FR text itself says *"handled in F9"*. Legitimately deferred; F4 retention invariant (FR-029/030) + audit event `invoice_pdf_sha_sync_failed` give the hooks that F9 will consume.

#### Human-gated residuals (not drift — Constitution-tracked)

T114 manual SR + cross-browser + staging traces + reduced-motion; T117 security-checklist co-sign; T118 review-counter tickbox; PVR-1 mobile-safari/chrome run (PVR-1 chromium now ✅ per `pending-verification.md` 2026-04-22 QA session).

---

### Spec: 001-auth-rbac — F1 Auth & RBAC

25 FRs. **SHIPPED via PR #1** (per `CLAUDE.md`). Integration + unit + E2E suites green across auth surfaces. No drift observed in Phase 10 regression sampling. Coverage: 25/25 implemented.

### Spec: 002-membership-plans — F2 Membership Plans

36 FRs. **REVIEW-READY on `002-membership-plans`** (per `CLAUDE.md`). 495 unit+contract + 163 integration tests green. Principle I tenant-isolation (Constitution v1.4.0) via `runInTenant` + Postgres RLS. Coverage: 36/36 implemented (US7 inline-edit deferred to F3, explicitly called out in plan).

### Spec: 003-nav-menu — F3-prelim Nav Menu

12 FRs. **REVIEW-READY**. UI primitives shipped; nav config tests `tests/unit/nav/nav-config.test.ts` green. Coverage: 12/12.

### Spec: 004-page-layout-standard — F4-prelim Layout Standardization

23 FRs. **SHIPPED** — PageHeader + ContentContainer + BreadcrumbNav + typography scale primitives landed and used across 11 admin + portal pages. Coverage: 23/23.

### Spec: 005-members-contacts — F3 Members & Contacts

53 FRs. **REVIEW-READY on `005-members-contacts`**. 23 audit event types shipped, 14/14 tenant-isolation integration tests, TanStack Table v8 directory, SC-002 p95 = 258 ms < 500 ms @ 5 k rows. Coverage: 53/53 implemented (T155a/T156/T158 human-gated).

### Spec: 006-layout-container-tier2 — Three-tier Container

19 FRs. **REVIEW-READY on PR #9**. 19 admin + portal routes migrated, `pnpm check:layout` enforcement, `docs/ux-standards.md § 18` updated. Coverage: 19/19. *Note: this branch is ad-hoc UI-infra, not canonical F5 — F5 = Online Payment (Stripe).*

---

### Unspecced Code 🆕

| Feature | Location | Lines | Suggested Spec |
|---|---|---|---|
| `scripts/seed-f4-e2e-admin-fixtures.ts` + `scripts/purge-e2e-mutation-995xxx.ts` | `scripts/` | ~300 | Infra — not a product feature; belongs in spec 007 §Testing (no spec entry required) |
| `scripts/check-outbox.mjs` | `scripts/` | small | Infra — ad-hoc operator script; belongs in `docs/observability.md` runbook |
| `src/lib/logo-blob-key.ts` | `src/lib/` | 24 | Covered by F4 FR-034 (tenant logo handling); extraction is architectural hygiene, not new feature |
| `src/lib/content-disposition.ts` | `src/lib/` | ~80 | Covered by F4 FR-041 (mobile download behaviour); extraction is architectural hygiene |
| `src/components/layout/filter-bar.tsx` primitive (from commit `68ddf9a`) | `src/components/layout/` | ~150 | Spec `006-layout-container-tier2` scope; covered by that spec's "shared admin primitives" section |
| FilterBar / Select anchor-width consistency | `src/components/ui/` | small | Same as above |

None of the unspecced items are material product features; they are all either operator/infra scripts (legit outside spec) or architectural-hygiene extractions required by F4 FRs (covered).

---

## Inter-Spec Conflicts

None detected. The 006-layout-container-tier2 branch explicitly supersedes parts of `004-page-layout-standard` (ContentContainer → TableContainer/FormContainer/DetailContainer split) with a migration note in `docs/ux-standards.md § 18`. That is documented supersession, not a conflict.

The cross-reference of F3's FR-044 from a test file (see F4 Drifted §) is the only latent tag-space overlap; F3 and F4 share an FR-### numeric space by spec-dir isolation but not globally — comment tagging convention works because specs are read in the context of their directory.

---

## Recommendations

1. **Fix the only drift item** — add a one-line header comment in `tests/e2e/members-reduced-motion.spec.ts` noting that `FR-044` refers to the F3 spec (005-members-contacts), not F4. 5-minute polish.
2. **Ship-gate for F4**: the 3 human-gated conditions from the R15 staff review (T114 manual SR + cross-browser, T117 security checklist co-sign, T118 review-counter tickbox). Not drift — governance.
3. **Cross-browser re-run** for PVR-1 on mobile-safari + mobile-chrome (chromium now ✅ per 2026-04-22 QA). Not drift — verification.
4. **Post-ship cleanup** (optional): fold `seed-f4-e2e-admin-fixtures.ts` into `tests/e2e/global-setup.ts` to make the admin-mutation gate always-on. Currently tracked as PVR-1 long-term fix with owner + target-close (2026-05-06).
5. **F9 planning**: when F9 (GDPR/PDPA) is specified, pick up FR-031 (tax-document retention category in data-export/erasure) as an explicit user story.
6. **Consider a global FR-namespace**: the F3/F4 FR-044 collision shows the risk. A simple rule — `F<n>-FR-###` — prevents cross-spec tag confusion without any code churn (lint rule optional).

---

## Health Score

94 % aligned · 1.4 % drift (all minor polish) · 4.7 % not-implemented (all by-design deferral or human-gated governance, none are latent defects) · 0 material unspecced features · 0 inter-spec conflicts.

*Generated by `/speckit-sync-analyze` — read-only drift analysis.*
