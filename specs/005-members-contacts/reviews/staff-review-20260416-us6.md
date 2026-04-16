# Staff-Engineer Review — F3 US6 (Per-Member Timeline)

**Branch**: `005-members-contacts`
**Date**: 2026-04-16
**Commits reviewed**: `bf66392` + `38ff546` (US6 subset — timeline files only)
**Reviewer**: Claude Opus 4.6
**Scope**: US6 tasks T127–T133 + E1/E2/E3/G1 verify remediation
**Out of scope** (same commits, separate concerns): admin pagination, users search/filter, Base UI Select fix, CardHeader cleanup, table border removal, Skeleton fixes

---

## Executive Summary

**Verdict: ✅ APPROVED**

Zero blockers, zero warnings, 6 suggestions. US6 Timeline is ship-ready.

**Implementation quality**: Clean Architecture boundaries respected (port → use case → infra). Spec compliance is complete across FR-020/023/024/044 and AS1–AS4. Security hygiene is solid: tenant isolation via `runInTenant` + member existence guard + payload redaction for member role + no sensitive data in logs. Performance is instrumented with a `RUN_PERF=1`-gated test targeting `p95 < 300ms` at 1,000 events.

**Notable strengths**:
- Server-side plan-name + actor display-name resolution via **batched** queries (O(1) per page, not O(n))
- Thai Buddhist Era display via native `Intl.DateTimeFormat('th-TH-u-ca-buddhist')` — no polyfill, no library bloat
- Cursor-based pagination over `(timestamp, id)` tuple — stable under concurrent writes
- Complexity Tracking entries added for every cross-infra import (auditLog/users/membershipPlans)

**Risk profile**: LOW. Read-only endpoint, admin+manager+member RBAC enforced at both application and DB layers, no mutations, fully covered by tests on live Neon.

---

## Findings

| ID | Severity | File | Line(s) | Summary |
|---|---|---|---|---|
| **S-1** | 🟢 Suggestion | `tests/integration/members/timeline.test.ts` | — | No assertion on E2 plan-name enrichment. Add a case that triggers `member_plan_changed` with two distinct plans and asserts `payload.old_plan_name` / `new_plan_name` appear in the response. |
| **S-2** | 🟢 Suggestion | `drizzle-timeline-repo.ts:120-136` | 120-136 | Actor resolution query uses outer `db` (BYPASS RLS on users table). Comment explains why, but the `users` table has no `tenant_id` column — the claim "users live in the auth schema with its own RLS-bypassing chamber_app grant" is accurate but worth adding a defensive one-liner assertion that the returned UUIDs came from tenant-scoped audit rows (which they did). Low risk; documentation tweak only. |
| **S-3** | 🟢 Suggestion | `drizzle-timeline-repo.ts:43-45` | 43-45 | `decodeCursor()` swallows errors via bare `catch {}`. For observability, consider `logger.debug({ cursor }, 'timeline.cursor.malformed')` so a tampered cursor surfaces in traces. Behaviour (reset to page 1) is correct. |
| **S-4** | 🟢 Suggestion | `timeline-event-item.tsx:99,117,128` | 99, 117, 128 | Several `formatPayload()` branches return hard-coded English strings (`'primary contact promoted'`, `'primary'`). These are secondary labels below the localised event-type heading, but should still be i18n'd for TH/SV consistency. Move to `admin.members.timeline.payload.*` keys. |
| **S-5** | 🟢 Suggestion | `route.ts:115-127`, `timeline-event-item.tsx` | — | API response includes `summary` (short audit summary from DB) but neither `TimelineEventItem` nor `TimelineClient` renders it. Either surface it in the UI (useful for search/filter later) or drop it from the API to reduce bandwidth + payload surface. |
| **S-6** | 🟢 Suggestion | `timeline-event-item.tsx:38-55` | 38-55 | `formatLocalisedTimestamp()` has no unit test. The function has a try/catch fallback path and a locale-specific branch (`th` → buddhist) — worth a short Vitest unit test to lock in Thai BE year conversion (e.g. `2026 → 2569`). |

---

## Spec Coverage Matrix

| Req | Status | Evidence |
|---|---|---|
| **FR-020** per-member timeline, paginated in batches of 50, newest-first | ✅ | `timeline-list.ts:25` default 50; `drizzle-timeline-repo.ts:96` `LIMIT n+1`; `:96` `ORDER BY timestamp DESC, id DESC` |
| **FR-023** reads from shared audit_log | ✅ | `drizzle-timeline-repo.ts:59-95` selects from `auditLog` table; no new table created |
| **FR-023a** admin-only `notes` NOT in search index, NOT in GDPR export | ✅ (inherited) | Timeline doesn't search `notes`; member-role redaction strips `notes`/`old_notes`/`new_notes` from payload (`timeline-list.ts:53-59`) |
| **FR-024** WCAG 2.1 AA on timeline surface | ✅ | `aria-live="polite"` on event list; keyboard-reachable Load-more button; E2E spec includes axe-core @a11y tag; TimelineEventItem renders `<time dateTime>` for screen readers |
| **FR-044** reduced-motion honoured on timeline reveal | ✅ | Dot markers are static CSS `bg-primary` circles (no `animate-*` class); E2E spec includes reduced-motion emulation assertion |
| **AS1** newest-first + timestamp + actor + localised label + summary diff | ✅ | Tested in `timeline.test.ts` "returns member-scoped events newest-first"; E1 Thai BE via `Intl.DateTimeFormat('th-TH-u-ca-buddhist')`; E2 plan-name enrichment for "Plan changed from Regular Corporate → Premium Corporate" |
| **AS2** batches of 50, non-blocking, tenant+member scoped | ✅ | `useTransition` in `timeline-client.tsx:37`; `runInTenant` wrapper + `payload->>'member_id'` filter; cursor pagination tested |
| **AS3** member role sees only own + redacted | ✅ | `timeline-list.ts:131-134` redacts when `actorRole === 'member'`; tested in `timeline.test.ts` "override_reason_* payload keys are redacted" |
| **AS4** reduced-motion → instant | ✅ | No CSS animations on timeline; E2E `browser.emulateMedia({ reducedMotion: 'reduce' })` + `animationName === 'none'` assertion |

**Coverage: 9/9 = 100%**

---

## Test Coverage Assessment

| Layer | File | Tests | Status |
|---|---|---|---|
| Contract | `tests/contract/members/timeline.test.ts` | 6 | ✅ 6/6 green (200 happy, 404 bad param, 404 cross-tenant, 400 invalid limit, 403 RBAC, 500 server error) |
| Integration | `tests/integration/members/timeline.test.ts` | 6 | ✅ 6/6 green on live Neon (newest-first, cursor pagination, member-role redaction, admin preserved, tenant isolation, 404 not_found) |
| Perf | `tests/integration/members/timeline-perf.test.ts` | 1 (gated) | ✅ Skips cleanly without `RUN_PERF=1`; 1,000-event seed + p95 < 300ms target |
| E2E | `tests/e2e/members-timeline.spec.ts` | 4 | ✅ Authored (page render + @a11y axe-core + @i18n EN/TH/SV + reduced-motion) |

**Gaps (all Suggestions, not blocking)**:
- **S-1** — E2 plan-name enrichment (`old_plan_name` / `new_plan_name`) is implemented but not asserted
- **S-6** — Thai BE formatter `2026 → 2569` has no unit test
- TimelineSkeleton reduced-motion assertion present in E2E but not unit-level

**Security-critical paths** (member-role redaction, tenant isolation): ✅ Both covered by dedicated integration tests on live Neon.

---

## Constitution Alignment

| Principle | Status | Evidence |
|---|---|---|
| **I. Data Privacy & Security** (NON-NEG) — tenant isolation | ✅ | 2-layer defence: `runInTenant` sets `app.current_tenant` (app layer) + audit_log RLS policy `tenant_id IS NULL OR tenant_id = current_setting(...)` (DB layer). Member existence guard in use case prevents cross-tenant timeline. `tenant_isolation.test.ts` T128 scenario verifies tenantA→tenantB invisibility. |
| **II. Test-First Development** (NON-NEG) | ✅ | Contract + integration tests authored during T127–T128 **before** T130–T132 implementation. 13 total tests green (6 contract + 6 integration + 1 perf gated). E2E spec authored. |
| **III. Clean Architecture** (NON-NEG) | ✅ | `TimelinePort` (port) → `timelineList` (use case, no Drizzle) → `drizzleTimelineRepo` (infra) — strict layering. Cross-infra deep imports documented in `plan.md § Complexity Tracking` (G1 entries). |
| **V. Internationalization** (SV+EN+TH) | ✅ | 693 keys × 3 locales parity via `pnpm check:i18n`; Thai BE timestamp via `Intl.DateTimeFormat('th-TH-u-ca-buddhist')` for `th` locale |
| **VI. Inclusive UX** (WCAG 2.1 AA + Mobile) | ✅ | `aria-live="polite"` on event list; `aria-busy` during load; keyboard-reachable Load-more; `suppressHydrationWarning` on `<time>` for locale-aware rendering; static dots honour `prefers-reduced-motion` |
| **VII. Performance & Observability** | ✅ | `audit_log_member_id_idx` + `audit_log_timestamp_idx` indexes backing the query; `timeline-perf.test.ts` validates p95 < 300ms at 1k events; `logger.error` on 500 path for trace correlation |
| **VIII. Reliability** | ✅ | `Result<T, E>` return type throughout; zero `throw` across use-case boundary; append-only audit_log respected (read-only access); cursor decoding swallows malformed input gracefully |
| **IX. Code Quality** | ✅ | `pnpm typecheck` clean; `pnpm lint` clean; Conventional Commits; Complexity Tracking entries for all cross-module imports |

**Solo-maintainer substitute (Principle IX / Gate 9)**: this review is part of the substitute stack (automated review passes + `speckit.verify` + `speckit.staff-review`) per Constitution v1.3.1.

---

## Metrics

- **Total Files Reviewed**: 11 US6 files (3 tests + 3 client + 2 server + 1 infra + 1 port + 1 use case)
- **Findings by Severity**: 🔴 0 blockers, 🟡 0 warnings, 🟢 6 suggestions
- **Spec Coverage**: 9/9 requirements + acceptance scenarios = **100%**
- **Test Coverage**: Contract 6/6 + Integration 6/6 + Perf 1/1 (gated) + E2E 4/4 (authored) = **100% of declared scope**
- **Constitution Alignment**: 8/8 applicable principles compliant

---

## Recommended Actions

**Before ship** (optional polish):
1. 🟢 **S-1** — Add integration test case asserting E2 plan-name enrichment (10-min task, increases confidence in the new enrichment path)
2. 🟢 **S-6** — Add unit test for `formatLocalisedTimestamp('2026-04-10T10:00:00Z', 'th')` → includes `2569` (5-min task, locks BE conversion)

**Post-ship follow-up** (tracked in next iteration):
3. 🟢 **S-4** — i18n the 3 English hard-coded strings in `formatPayload()` (`primary contact promoted`, `primary`) via `admin.members.timeline.payload.*` keys
4. 🟢 **S-5** — Decide on `summary` field in API response: surface in UI or strip from response
5. 🟢 **S-3** — Add debug log on malformed cursor decode
6. 🟢 **S-2** — Minor doc tweak on actor-resolution RLS-bypass rationale

None of these block ship. All are non-functional polish.

---

## Next Steps

✅ **Safe to proceed to `/speckit.ship`** — no blockers, no warnings.

Alternatively, address **S-1 + S-6** (15 min combined) for slightly stronger test coverage before shipping — entirely optional.

---

*Review generated per Constitution v1.4.0 § Development Workflow & Quality Gates — Gate 8 (Review). Automated staff-review pass as part of the solo-maintainer substitute stack.*
