# Staff Review: US5 Member Self-Service Portal — Round 1

**Date**: 2026-04-16
**Scope**: Phase 7 (T114–T126) — US5 only
**Branch**: `005-members-contacts`
**Reviewer**: Claude Opus 4.6 (automated staff-engineer-level review)

---

## Executive Summary

**Verdict**: ❌ **CHANGES REQUIRED**

US5 delivers the intended 3 surfaces (profile view, whitelist edit, colleague invite) with solid test coverage (contract 7/7, integration 5/5, unit 4/4) and complete i18n (667 keys × 3 locales). However, the review identified **5 blockers** and **10 warnings** across security, correctness, and spec compliance that must be resolved before shipping.

The most critical findings are:
1. **B-1**: No ownership verification — `contactId` not validated against `memberId` in `memberSelfUpdate`
2. **B-2**: `linkUser` result silently discarded in `inviteColleague` — orphan user + false success
3. **B-3**: `null → undefined` coercion prevents members from clearing website/description
4. **B-4**: Misleading `primaryContact` naming in `MemberContext` (is actually "own contact")
5. **B-5**: Cross-member authorization gap in `inviteColleague` — actor's memberId not verified

---

## Findings

| ID | Severity | File | Line(s) | Summary | Recommendation |
|----|----------|------|---------|---------|----------------|
| B-1 | 🔴 Blocker | `member-self-update.ts` | 261–276 | No ownership check — `contactId` never verified to belong to `memberId`. A malicious actor could update another member's contact by forging `contactId`. | Add `contactRepo.findById` + verify `contact.memberId === input.memberId` before update, or add `findByIdForMember()` repo method. |
| B-2 | 🔴 Blocker | `invite-colleague.ts` | 144–151 | `linkUser()` result discarded — if it fails, F1 user + contact both exist unlinked. Unlike `invitePortal` (which has invitation email in-flight), no recovery mechanism exists here. | Check `linkUser` result; return `server_error` on failure. |
| B-3 | 🔴 Blocker | `member-self-update.ts` | 186–192 | `data.website ?? undefined` coerces explicit `null` (clear intent) to `undefined` (Drizzle skips). Members cannot clear website/description. Same for `description` at line 191. | Remove `?? undefined` — pass `data.website` directly. Ensure `MemberPatch` type accepts `null` for nullable fields. |
| B-4 | 🔴 Blocker | `member-context.ts` | 104–123 | `primaryContact`/`primaryContactId` fields are actually the caller's own contact (found by `linkedUserId`), not the member's primary contact. Misleading naming causes confusion across all consuming routes. | Rename to `ownContact`/`ownContactId` and update all call sites. |
| B-5 | 🔴 Blocker | `invite-colleague.ts` | 73–88 | Actor's `actorContactId` is verified as `isPrimary` but NOT verified as belonging to `input.memberId`. A primary contact of Member A can invite into Member B. | Add `actorContact.value.memberId !== input.memberId` → reject. |
| W-1 | 🟡 Warning | `invite-colleague.ts` | 98 | Raw email sent to `createUser` instead of normalized `emailResult.value`. F1 user email may differ in case from contact email. | Use `emailResult.value` (lowercase) for `createUser`. |
| W-2 | 🟡 Warning | `invite-colleague.ts` | 68–157 | `deps.audit` is in `InviteColleagueDeps` but never called — no `contact_created` audit event emitted. Missing audit trail for PII-touching operation (Constitution Principle I). | Add `deps.audit.record()` with type `'contact_created'` after success. |
| W-3 | 🟡 Warning | `invite-colleague.ts` | 116 | `deps.tenant.slug as Contact['tenantId']` — unsafe cross-brand cast bypasses type safety. | Use `asTenantId(deps.tenant.slug)` constructor. |
| W-4 | 🟡 Warning | `member-self-update.ts` | 142, 281 | `audit.record()` result unchecked — silent failure on security-critical events. Forgery path (line 142) should fail-closed if audit fails. | Check result; log warning on failure; consider `server_error` on forgery path. |
| W-5 | 🟡 Warning | `member-self-update.ts` | 38–53 | Zod schema keys hardcoded, not structurally derived from tuples. T116 test catches drift but `satisfies Record<Tuple, ZodType>` would provide compile-time safety. | Add `satisfies Record<PortalSelfUpdateContactField, z.ZodTypeAny>`. |
| W-6 | 🟡 Warning | `profile/route.ts`, `invite/route.ts` | 140, 26 | Idempotency-Key format validated but not classified/reserved/remembered. Duplicate requests process twice. | Wire full `withIdempotency()` flow or document as intentional deferral. |
| W-7 | 🟡 Warning | `portal-edit-form.tsx`, `invite-colleague-form.tsx` | 179, 176 | Hardcoded language option labels ("English", "ไทย", "Svenska") bypass i18n. | Extract to i18n keys `portal.languageOptions.*`. |
| W-8 | 🟡 Warning | `portal-edit-form.tsx`, `invite-colleague-form.tsx` | 134, 115 | Missing `aria-invalid`, `aria-describedby`, `role="alert"` on validation error messages. WCAG 2.1 AA SC 4.1.3. | Add `aria-invalid`, `aria-describedby`, `role="alert"` per field. Match existing `member-form.tsx` pattern. |
| W-9 | 🟡 Warning | `portal-edit-form.tsx`, `invite-colleague-form.tsx` | 169, 166 | `Select` uses `watch()`/`setValue()` instead of `<Controller>` — validation errors silently dropped. Deviates from project pattern. | Use `<Controller>` wrapper per `member-form.tsx`. |
| W-10 | 🟡 Warning | `portal/profile/page.tsx` | 164 | `registrationDate.toISOString().split('T')[0]` ignores Thai Buddhist Era display requirement for `th-TH` locale. | Use `next-intl` formatter: `format.dateTime(date, { dateStyle: 'medium' })`. |
| S-1 | 🟢 Suggestion | `member-self-update.ts` | 50–54 | Exported `selfUpdateSchema` lacks `.strict()` — standalone use could bypass forbidden-field gate. | Add `.strict()` for defence-in-depth. |
| S-2 | 🟢 Suggestion | `member-self-update.ts` | 245–258 | `isPreferredLanguage` guard is dead code post-zod-parse — enum already validated. | Remove redundant guard or make it the sole validator. |
| S-3 | 🟢 Suggestion | `portal-edit-form.tsx`, `invite-colleague-form.tsx` | 106, 89 | `router.refresh()` fires on current route before `router.push` navigates — profile page may see stale data. | Remove `router.refresh()` — Server Component re-fetches on navigation. |

---

## Spec Coverage Matrix

| Requirement | Status | Evidence |
|-------------|--------|----------|
| FR-013 (member reads own profile) | ✅ Covered | `GET /api/portal/profile` + profile page |
| FR-014 (whitelist enforcement + 403 + audit) | ⚠️ Partially | Forbidden-field detection works; **B-1 ownership gap** undermines security |
| FR-014a (compile-time tuple → zod) | ⚠️ Partially | Tuple + schema exist; T116 parity test green; **W-5** hardcoded keys |
| FR-015 (colleague invite, primary-only) | ⚠️ Partially | Primary gate works; **B-5 cross-member gap** + **B-2 orphan** |
| FR-042 (hidden fields, not disabled) | ✅ Covered | Edit form renders only whitelisted fields; E2E asserts forbidden fields absent |
| US5 AS1 (profile view) | ✅ Covered | Profile page renders 3 surfaces |
| US5 AS2 (phone edit + audit) | ⚠️ Partially | Works but **B-3 null coercion** prevents field clearing |
| US5 AS3 (forged plan_id → 403 + audit) | ✅ Covered | T115 integration test 5/5 green |
| US5 AS4 (colleague invite) | ⚠️ Partially | **B-2 + B-5** undermine correctness |
| US5 AS5 (READ_ONLY_MODE → 503) | ✅ Covered | proxy.ts global guard + E2 remediation tests |

---

## Test Coverage Assessment

| Test File | Count | Status | Gaps |
|-----------|-------|--------|------|
| `tests/contract/portal/profile.test.ts` | 7/7 | ✅ Green | — |
| `tests/integration/members/self-service-whitelist.test.ts` | 5/5 | ✅ Green | Does not test contactId ownership (B-1) |
| `tests/unit/members/application/whitelist-schema-equals-tuple.test.ts` | 4/4 | ✅ Green | — |
| `tests/e2e/members-self-service.spec.ts` | Authored | ⚠️ Fixture-dependent | Needs seeded member user for CI |
| `tests/integration/middleware/readonly-mode.test.ts` | +2 new | ✅ Green | — |
| Missing: invite-colleague use case unit tests | — | ❌ Missing | No unit/integration tests for `inviteColleague` |
| Missing: cross-member authorization test | — | ❌ Missing | No test for B-5 cross-member bypass |

---

## Metrics

| Metric | Value |
|--------|-------|
| Files Reviewed | 17 |
| Total Findings | 18 |
| 🔴 Blockers | 5 |
| 🟡 Warnings | 10 |
| 🟢 Suggestions | 3 |
| Spec Coverage | 6/10 fully covered (60%) |
| US5 Tasks Complete | 13/13 |

---

## Recommended Actions (Priority Order)

### Must Fix (Blockers)

1. **B-1**: Add ownership verification in `memberSelfUpdate` — verify `contactId` belongs to `memberId`
2. **B-5 + B-2**: Fix `inviteColleague` — (a) verify actor belongs to target member, (b) check `linkUser` result
3. **B-3**: Remove `?? undefined` coercion on website/description — pass `null` through to repo
4. **B-4**: Rename `primaryContact` → `ownContact` in `MemberContext` + update all call sites

### Should Fix (Warnings)

5. **W-1**: Use normalized email in `inviteColleague` createUser call
6. **W-2**: Add audit event in `inviteColleague`
7. **W-4**: Check audit result on forgery path (fail-closed)
8. **W-7 + W-8 + W-9**: Fix i18n hardcoded labels + WCAG aria attrs + Controller pattern in both forms
9. **W-10**: Use locale-aware date formatting on profile page
10. **W-6**: Wire full idempotency flow or document deferral

### Nice to Fix (Suggestions)

11. **S-1**: Add `.strict()` to exported schema
12. **S-2**: Remove dead `isPreferredLanguage` guard
13. **S-3**: Remove unnecessary `router.refresh()`

---

## Verdict

❌ **CHANGES REQUIRED** — 5 blockers found (security ownership gap, orphan state, null coercion, misleading naming, cross-member bypass). Fix blocker issues, then run `/speckit.staff-review` again.
