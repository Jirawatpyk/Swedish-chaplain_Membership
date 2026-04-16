# Staff Review: US5 Member Self-Service Portal — Round 2

**Date**: 2026-04-16
**Scope**: Re-review of Round 1 fixes (18 findings)
**Branch**: `005-members-contacts`
**Reviewer**: Claude Opus 4.6 (automated staff-engineer-level review)
**Prior**: `reviews/review-20260416-us5-round1.md`

---

## Executive Summary

**Verdict**: ⚠️ **APPROVED WITH CONDITIONS**

All 18 Round 1 findings are **confirmed fixed**. The re-review found **0 blockers**, **4 warnings**, and **1 suggestion** — all introduced as side-effects of the Round 1 fixes. None are security-critical. The most impactful is the ESLint barrel-import violations (W-1) which will fail CI lint.

---

## Round 1 Fix Verification

| R1 ID | Status | Evidence |
|-------|--------|----------|
| B-1 | ✅ Fixed | `contactRepo.findById` + `memberId` check at `member-self-update.ts:196–213` |
| B-2 | ✅ Fixed | `linkUser` result checked at `invite-colleague.ts:163–177` |
| B-3 | ✅ Fixed | `data.website` passed directly (no `?? undefined`) at `member-self-update.ts:224` |
| B-4 | ✅ Fixed | `ownContact`/`ownContactId` throughout `member-context.ts`, route files, and tests |
| B-5 | ✅ Fixed | `actorContact.memberId !== input.memberId` at `invite-colleague.ts:91–96` |
| W-1 | ✅ Fixed | `emailResult.value` at `invite-colleague.ts:107` |
| W-2 | ✅ Fixed | `audit.record('contact_created')` at `invite-colleague.ts:180` |
| W-3 | ✅ Fixed | `asTenantId(deps.tenant.slug)` at `invite-colleague.ts:126` |
| W-4 | ✅ Fixed | Audit result checked at both paths (`member-self-update.ts:160,319`) |
| W-5 | ✅ Fixed | `satisfies Record<Tuple, ZodType>` at lines 47,53 |
| W-6 | ✅ Fixed | TODO comment at `profile/route.ts:141`, `invite/route.ts:27` |
| W-7 | ✅ Fixed | `t('languageOptions.*')` in both forms |
| W-8 | ✅ Fixed | `aria-invalid`, `aria-describedby`, `role="alert"` on all fields |
| W-9 | ✅ Fixed | `Controller` wrapping `Select` in both forms |
| W-10 | ✅ Fixed | `format.dateTime()` at `profile/page.tsx:167` |
| S-1 | ✅ Fixed | `.strict()` on `selfUpdateSchema` |
| S-2 | ✅ Fixed | Dead `isPreferredLanguage` guard removed |
| S-3 | ✅ Fixed | `router.refresh()` removed from both forms |

---

## New Findings (Round 2)

| ID | Severity | File | Line(s) | Summary | Recommendation |
|----|----------|------|---------|---------|----------------|
| R2-W1 | 🟡 Warning | `portal/contacts/invite/route.ts` | 12, 19 | Deep imports `@/modules/members/application/use-cases/invite-colleague` + `invite-portal` bypass barrel — ESLint `no-restricted-imports` error, will fail CI lint | Import `inviteColleague`, `inviteColleagueSchema`, `CreateUserPort` from `@/modules/members` barrel; export them from `index.ts` if missing |
| R2-W2 | 🟡 Warning | `portal/profile/route.ts` | 15, 18 | Deep imports `member-self-update` + `@/modules/members/domain/member` bypass barrel — same ESLint error | Import `memberSelfUpdate`, `MemberId` from `@/modules/members` barrel |
| R2-W3 | 🟡 Warning | `member-self-update.ts` | 329–340 | Redundant `contactRepo.findById` when no contact fields patched — B-1 ownership check already loaded the contact | Reuse `contactCheck.value` as `baseContact`; set `updatedContact = baseContact` when no contact mutation |
| R2-W4 | 🟡 Warning | `invite-colleague.ts` | 115–119 | Non-email-taken `createUser` errors surfaced as misleading 409 `email_taken` | Add explicit `code === 'email-taken'` branch; fall through to `server_error` for unknown errors |
| R2-S1 | 🟢 Suggestion | `member-self-update.ts` | 48, 53 | Inner `contactFieldsSchema` and `memberFieldsSchema` not `.strict()` — nested forged keys silently stripped (mitigated by `detectForbiddenFields`) | Add `.strict()` to inner schemas for defence-in-depth |

---

## Spec Coverage Matrix

| Requirement | Status | Evidence |
|-------------|--------|----------|
| FR-013 | ✅ Covered | GET /api/portal/profile + profile page |
| FR-014 | ✅ Covered | Forbidden-field detection + B-1 ownership + audit |
| FR-014a | ✅ Covered | Tuple + `satisfies` + T116 parity test |
| FR-015 | ✅ Covered | Primary gate + B-5 cross-member check + B-2 linkUser |
| FR-042 | ✅ Covered | Edit form hidden fields + E2E assertion |
| US5 AS1–AS5 | ✅ All covered | Profile view, phone edit + audit, forged payload → 403, colleague invite, READ_ONLY 503 |

---

## Metrics

| Metric | Value |
|--------|-------|
| Files Reviewed | 10 |
| Round 1 Findings Fixed | **18/18 (100%)** |
| New Findings | 5 (0 blockers, 4 warnings, 1 suggestion) |
| Spec Coverage | **10/10 (100%)** |
| Test Suite | 848/848 green + 281 integration |
| i18n | 673 keys × 3 locales parity green |
| Typecheck | PASS |

---

## Conditions for Ship

1. **R2-W1 + R2-W2**: Fix ESLint barrel-import violations (4 errors) — these will fail CI lint. Add missing exports to `@/modules/members/index.ts` and update route file imports.
2. **R2-W3**: Eliminate redundant DB round-trip in `memberSelfUpdate` (performance, not correctness).
3. **R2-W4**: Fix misleading `email_taken` error mapping in `inviteColleague`.

---

## Verdict

⚠️ **APPROVED WITH CONDITIONS** — No blockers. All Round 1 security/correctness issues verified fixed. 4 warnings (ESLint violations + performance + error mapping) should be addressed before merge to pass CI.

**Next step**: Address conditions (R2-W1/W2 are lint-blocking), then run `/speckit.ship`.
