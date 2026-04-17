# Staff-Engineer Review Round 2 — F3 US6 (Per-Member Timeline)

**Branch**: `005-members-contacts`
**Date**: 2026-04-16
**Commits reviewed since Round 1**: `5aa81c7` (S-1 to S-6 remediation) + uncommitted plans-table TranslatedSelectValue fix
**Reviewer**: Claude Opus 4.6
**Round 1 reference**: `staff-review-20260416-us6.md` — 6 suggestions, 0 blockers
**Round 2 scope**: verify Round 1 remediation is correct; catch regressions; audit the uncommitted plans-dropdown fix

---

## Executive Summary

**Verdict: ✅ APPROVED**

Round 1 remediation is **correctly applied across all 6 suggestions**. Zero regressions. Zero blockers, zero warnings. Round 2 found **4 minor suggestions** (R2-S1 to R2-S4), all non-blocking polish items.

**Round 1 verification**:

| Round 1 Finding | Fix Applied | Status |
|---|---|---|
| **S-1** Integration test for E2 enrichment | `timeline.test.ts` +1 case; seedSecondaryPlan helper; live Neon 7/7 | ✅ VERIFIED |
| **S-2** Actor resolution safety doc | `drizzle-timeline-repo.ts:122-131` expanded comment with RLS safety chain | ✅ VERIFIED |
| **S-3** Cursor tamper observability | `decodeCursor()` 4 paths all emit `logger.debug` | ✅ VERIFIED |
| **S-4** i18n hard-coded strings | `admin.members.timeline.payload.{primary, primaryContactPromoted}` × 3 locales; 695 keys parity | ✅ VERIFIED |
| **S-5** Drop unused `summary` | Removed from port type, repo select, API response, client shape, page mapping, contract mock | ✅ VERIFIED |
| **S-6** Thai BE unit test | 6 cases covering th/en/sv/bad-input/bad-locale/24h time | ✅ VERIFIED |

**Plans dropdown fix** (uncommitted): Correctly adopts the shared `<TranslatedSelectValue>` primitive. Keeps consistency with the Users page approach.

---

## Findings

| ID | Severity | File | Line(s) | Summary |
|---|---|---|---|---|
| **R2-S1** | 🟢 Suggestion | `drizzle-timeline-repo.ts:33-56` | 33-56 | `logger.debug({ cursor }, 'timeline.cursor.malformed')` is duplicated 4 times across each early-return path. DRY-refactor: either (a) extract a small helper `logMalformedCursor(cursor, reason?)` that adds a `reason` field, OR (b) log once at function entry into a deferred callback. Current version works but is noisy — audit readers can't easily distinguish which branch fired. |
| **R2-S2** | 🟢 Suggestion | `drizzle-timeline-repo.ts:54` | 54 | The `catch` block logs `{ cursor }` but not the underlying `err`. Pino's default error serialiser would surface the root cause for operational debugging. Suggest: `logger.debug({ cursor, err }, 'timeline.cursor.malformed')`. |
| **R2-S3** | 🟢 Suggestion | `tests/unit/.../timeline-event-item.test.tsx:39-47` | 39-47 | The "unsupported locale" test only asserts `typeof === 'string'` and `length > 0`. That's a smoke test, not a contract lock. Tighten to verify the **fallback path** actually runs: e.g. assert the output is the ISO slice (`'2026-04-10 10:00'`) when a truly invalid BCP47 tag is passed. Note: some invalid-looking tags are accepted by `Intl.DateTimeFormat` at runtime, so you may need a grammatically-invalid tag like `'--not-bcp47--'` to exercise the catch branch. |
| **R2-S4** | 🟢 Suggestion | `plans-table.tsx:259-270` | 259-270 | The `translate` callback in the new plans-dropdown fix is an inline if-else chain. For this 3-value case it's fine, but as a pattern it invites drift (e.g. adding a 4th category later). Consider extracting a map: `const CATEGORY_LABEL_KEYS = { all: 'filters.all', corporate: 'filters.category.corporate', partnership: 'filters.category.partnership' } as const;` and looking up once. Minor readability / future-proofing. |

---

## Regression Check

**Confirmed zero regressions** across the US6 surface:

| Check | Evidence |
|---|---|
| Contract tests still pass after `summary` removal | `pnpm vitest run tests/contract/members/timeline.test.ts` → **6/6 green** |
| Integration tests still pass + new enrichment case | `pnpm vitest run --config vitest.integration.config.ts tests/integration/members/timeline.test.ts` → **7/7 green** (was 6/6) |
| Unit tests new lock-in for formatLocalisedTimestamp | `pnpm vitest run tests/unit/members/presentation/timeline-event-item.test.tsx` → **6/6 green** |
| TypeScript strict | `pnpm typecheck` clean |
| Lint | `pnpm lint` clean (1 pre-existing warning in `clear-test-data.test.ts`, unrelated) |
| i18n parity | `pnpm check:i18n` → **695 keys × 3 locales** (was 693) |
| Payload type-flow post S-5 | `TimelineEvent` type no longer has `summary`; all 6 call sites updated (port, repo, use case, API, client fetch, page initial) |

---

## Spec Compliance (Unchanged from Round 1)

All US6 acceptance criteria remain satisfied:

- **AS1** newest-first + timestamp (Thai BE locked in S-6 test) + actor + localised event label + summary diff (plan names via enrichment verified in S-1 test): ✅
- **AS2** batches of 50, non-blocking, tenant+member scoped: ✅
- **AS3** member role sees only own + redacted (tested): ✅
- **AS4** reduced-motion → instant (static dots, no CSS animations): ✅

No spec deviation introduced by Round 1 remediation.

---

## Constitution Alignment (Unchanged from Round 1)

All 8 applicable principles remain compliant. Round 1 remediation reinforces:
- **Principle VII (Observability)** — S-3 adds diagnostic trace for cursor tampering
- **Principle V (i18n)** — S-4 removes English-hard-coded labels, adds TH/SV parity
- **Principle III (Clean Architecture)** — S-5 reduces API surface area (summary removal)
- **Principle II (Test-First)** — S-1 + S-6 add coverage for previously untested paths (E2 enrichment, Thai BE conversion)

---

## Metrics

- **Round 1 Findings Closed**: 6/6 (100%)
- **Round 2 Findings**: 🔴 0 blockers, 🟡 0 warnings, 🟢 4 suggestions (down from 6 in Round 1)
- **Files Re-Reviewed**: 13 (all changes in `5aa81c7` + uncommitted `plans-table.tsx`)
- **Test Coverage Delta**: +1 integration (E2 enrichment), +6 unit (formatLocalisedTimestamp), -0 regressions
- **i18n Keys**: 693 → 695 (+2 payload labels × 3 locales = 6 entries)
- **API Surface**: -1 unused field (`summary`)

---

## Recommended Actions

All 4 R2 findings are polish-grade suggestions. None block ship.

**Optional tightening** (if you want to close R2 fully before ship):
1. 🟢 **R2-S1** + **R2-S2** — refactor the 4 duplicated `logger.debug` calls into a small helper that also captures the failure reason + caught error (~10 lines, ~10 min)
2. 🟢 **R2-S3** — strengthen the "unsupported locale" unit test to assert actual fallback output (~5 min)
3. 🟢 **R2-S4** — extract plans-dropdown translate map as a const (~5 min)

**Action recommended regardless of above**:
- ⚠️ **Commit the uncommitted plans-table fix**. It's stable, typechecked, tested — don't leave it dangling in the working tree.

---

## Next Steps

✅ **Safe to proceed to `/speckit.ship`** — zero blockers, zero warnings across 2 review rounds.

Recommended sequence:
1. `git add src/components/plans/plans-table.tsx && git commit` — bring the dropdown fix into history
2. Optionally apply R2-S1 + R2-S2 (10 min polish) — or defer as post-ship
3. `/speckit.ship` — prepare PR for `main`

---

## Round-over-Round Summary

| Metric | Round 1 | Round 2 | Δ |
|---|---|---|---|
| Blockers | 0 | 0 | — |
| Warnings | 0 | 0 | — |
| Suggestions | 6 | 4 | -2 |
| Closed findings | — | 6/6 | +6 |
| Test files | 3 (contract/integration/E2E) | 4 (+1 unit) | +1 |
| Test count | 13 (6C + 6I + 1P) | 20 (6C + 7I + 1P + 6U) | +7 |
| i18n keys | 693 | 695 | +2 |
| API fields removed | 0 | 1 (summary) | -1 |
| Spec coverage | 9/9 | 9/9 | — |

---

*Round 2 generated per Constitution v1.4.0 § Development Workflow & Quality Gates — Gate 8 (Review). Part of the solo-maintainer substitute stack.*
