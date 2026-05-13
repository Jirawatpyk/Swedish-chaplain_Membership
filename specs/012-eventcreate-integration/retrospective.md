# F6 EventCreate Integration — Retrospective (in progress)

**Status**: live document — appended as each phase ships. F6 ships dark behind `FEATURE_F6_EVENTCREATE=false`; final retrospective signs off the pre-flag-flip operator checklist before per-tenant flag-flip.

---

## Phase 4 — US2 Admin events list + event detail (shipped 2026-05-12)

**Commits**: `cf44b978` (RED) · `15355361` (GREEN 2a) · `fbc73e40` (GREEN 2b) · (TBD verify-fix commit closing F1+F2+F3+F4+F5+F6+F7 findings)

### What landed
- Application use-cases: `listEvents` + `loadEventDetail`
- Infrastructure: `drizzle-events-repository.list/getMatchCountsByEventIds/getEmptyContext` + `drizzle-registrations-repository.findByEventId` (replaced 3 `not_implemented` stubs)
- Composition adapter: `src/lib/events-admin-deps.ts` (runListEvents + runLoadEventDetail)
- Routes: `GET /api/admin/events` + `GET /api/admin/events/[eventId]` with FR-035 RBAC + kill-switch + `role_violation_blocked` audit emit on member-role 404
- Pages: `/admin/events` list + `/admin/events/[eventId]` detail (server components + shimmer skeletons + 3-variant empty state)
- Components: events-list-table · event-detail-header · attendee-table · match-status-badge · quota-effect-badge
- Placeholder `/admin/integrations/eventcreate` page so empty-state CTA doesn't 404 (F4 verify-fix)
- i18n: ~75 EN keys × 3 locales (~225 entries) — `check:i18n` 2320 keys parity

### Test counts at ship
- Unit + contract: 21/21 GREEN (T053 admin events API)
- Integration: 36/36 GREEN regression check on F6 (Phase 3 ingest still passes)
- Typecheck + lint + check:i18n + check:layout: all clean

### Pre-flag-flip operator checklist (Phase 4 contributions — folded into final ship-day list)

| # | Item | Owner | Status |
|---|---|---|---|
| P4-G1 | `pnpm test:e2e --grep "F6 events list and detail" --workers=1` against seeded tenant + admin login | maintainer | **CLOSED 2026-05-13** — 7/7 PASS chromium/3.6min after `seedF6Events` helper landed in `tests/e2e/helpers/eventcreate-seed.ts` + wired in `global-setup.ts` (3 events + 6 registrations + 1 webhook_config UPSERT idempotent). Required env var addition: `FEATURE_F6_EVENTCREATE=true` + `EVENTCREATE_PII_PSEUDONYM_SALT=<base64>` in `.env.local`. |
| P4-G2 | `pnpm test:e2e --grep "@a11y T055" --workers=1` axe-core scan of list + detail | maintainer | **CLOSED 2026-05-13** — 3/3 PASS chromium/2.3min (list + detail + Phase 5 D2 wizard). Round-1 flaky on detail closed via spec-side fix: added `page.waitForFunction(() => document.title.length > 0)` inside `expectNoAxeViolations` helper because Next.js 16 RSC streams `generateMetadata` AFTER DOM-ready → axe-core saw empty `<title>` and falsely flagged WCAG 2.4.2-A. Production code is unaffected (test-only timing race). |
| P4-G3 | `pnpm test:e2e --grep "@i18n T056" --workers=1` EN+TH+SV leak-key + `<html lang>` scan | maintainer | DEFERRED (T056 — code-complete, manual gate) |
| P4-G4 | Cross-browser smoke (chromium + mobile-chrome + mobile-safari) on /admin/events list + detail | maintainer | DEFERRED (parallels F8 T270 cross-browser gate) |
| P4-G5 | Manual SR pass on list + detail (NVDA + VoiceOver) — verify aria-pressed toggle, table sort indicators, deep-link "opens in new tab" announcement | maintainer | DEFERRED |
| P4-G6 | Visual smoke EN/TH/SV with seeded data — confirm no leaked translation keys, BE display on `th-TH`, currency formatting | maintainer | DEFERRED |
| P4-G7 | Verify FR-035 audit trail in production logs: member-role hits to /admin/events* SHOULD generate `role_violation_blocked` rows with `payload.actorRole='member'` + `attemptedRoute` + `attemptedAction` | maintainer | DEFERRED (depends on flag-flip + audit query) |
| P4-G8 | Verify empty-state variants render correctly when toggling `tenant_webhook_configs.enabled` and clearing `event_registrations` between sessions | maintainer | DEFERRED |

These 8 gates parallel the F8 T269/T270/T277/T277b/T282 pattern — code is complete and merged ship-dark; physical execution against real fixtures is deferred to the pre-flag-flip QA pass.

### Verify-gate findings closed (2026-05-12)
8 findings raised by `/speckit.verify.run`, all closed in follow-up commit:
- **F1 (HIGH)**: FR-035 `role_violation_blocked` audit emit missing on member-role 404 → wired `makeStandaloneAuditDeps` into both routes with try/catch fallback (audit failure never blocks 404)
- **F2 (HIGH)**: contract test missing audit assertion → 3 new tests assert audit type + payload + audit-failure-tolerance
- **F3 (MEDIUM)**: deferred E2E execution → documented above as P4-G1..G6 pre-flag-flip gates
- **F4 (MEDIUM)**: empty-state CTA dead-link → added placeholder `/admin/integrations/eventcreate/page.tsx` (admin-only; manager+member → 404 per FR-035; replaced by canonical Phase 5 T080 wizard at ship)
- **F5 (MEDIUM)**: data-model.md not updated for offset pagination switch → added Phase-4 port-shape note in § 8
- **F6 (LOW)**: tests/setup.ts F6 flag-on side-effect un-documented → added explanatory comment
- **F7 (LOW)**: `MATCH_TYPES` tree-shake hack → removed (URL `matchTypeFilter` is parsed via `isMatchType` guard which keeps the union live)
- **F8 (LOW)**: informational only — confirmed WCAG SC 1.4.1 non-colour-alone compliance on badges

### Staff-review (round-5) findings closed (2026-05-13)

12 findings raised by `/speckit.staff-review.run` after the 4 `/speckit.review` rounds, all closed in follow-up commit. Full report at `reviews/review-20260512-234816.md`.

- **R001 (BLOCKER)**: `drizzle-registrations-repository.findByEventId` ilike'd the raw `attendee_email` column, bypassing both the contract pin (`attendee_email_lower`) and the supporting btree index `event_regs_tenant_email_lower_idx` (migration 0131). Swapped to `like(attendeeEmailLower, lowerPattern)` + companion R011 EXPLAIN test.
- **R002 (WARNING)**: `[eventId]/route.ts` ordered `eventId.length > 200 → 404` AFTER the role-violation audit emit, letting an oversized eventId from a member actor bloat the audit payload. Moved the length guard above the role gate so the cap is enforced before any audit row is composed.
- **R003 (WARNING)**: Both routes used `requireSession('staff').catch(() => null)` which swallowed every error class — including DB/cookie-parse infrastructure failures — and falsely surfaced them as 404. Replaced with `getCurrentSession()` so no-session paths return null (→ 404) and infra throws propagate (→ 500). Contract-test T2 split into T2a (null→404) + T2b (throw→propagates).
- **R004 (WARNING)**: `findByEventId` issued matchCounts + totalCount + items SELECTs serially. Parallelised via Promise.all (3 reads × ~1 round-trip saved on the admin detail surface).
- **R005 (WARNING)**: `drizzle-events-repository.list` (count+items) and `listEvents` use-case (list+getEmptyContext) ran serially. Parallelised both — same pattern as R004.
- **R006 (WARNING)**: `role-violation-audit` ternary had byte-identical arms — the documented "append eventId on detail-route variant" intent was a dead-code lie. Actually appended `eventId` in the detail branch; safe because R002 caps `eventId.length` upstream.
- **R007 (SUGGESTION)**: `[eventId]/page.tsx` redirect on invalid `matchTypeFilter` did not validate the eventId UUID shape before composing the Location URL — sent a 302 to a path the use-case would immediately 404. Added UUID_V4 guard → `notFound()` before redirect.
- **R008 (SUGGESTION)**: `sanitize-db-error.redactStack` regex covered `var|usr|home|opt|tmp|root|users` but leaked `/private/*` (macOS), `node_modules/*`, and `webpack-internal:///` URLs (Next.js dev). Extended prefix list + added explicit webpack-internal scrub.
- **R009 (SUGGESTION)**: `pino-audit-port.actorSentinel` used bare strings (`system`, `zapier_webhook`, `csv_import`, `cron:f6`) that risked colliding with real user_id values. Namespaced under `system:f6-*` matching the F5/F8 precedent (`system:bootstrap`, `system:cron`, `system:stripe-webhook`). No tests assert on sentinel values, so the rename is code-only.
- **R010 (SUGGESTION)**: `load-event-detail.ts` ran `tryEventId(input.eventId)` AND `UUID_V4.test(input.eventId)` — the regex already enforces non-empty AND well-formed, so the `tryEventId` non-empty check was strictly redundant. Dropped `tryEventId`; brand with `asEventId` after the regex passes.
- **R011 (SUGGESTION)**: Behavioural test for `emailSearch` was passing even when the implementation bypassed the email-lower index. Added EXPLAIN-based integration assertion that the query plan references `attendee_email_lower` and does NOT show `ilike` on the raw column.
- **R012 (SUGGESTION)**: `contracts/admin-events-api.md § GET detail` example used `/* same shape as list item */` placeholder, omitting the `lastUpdatedAt` field added by U5 round-1. Inlined the full detail-event shape with `lastUpdatedAt`.

### Constitution alignment (Phase 4)
- I — Tenant isolation: `runListEvents` / `runLoadEventDetail` wrap `runInTenant(ctx, fn)`; tenant_id derived from session never URL
- II — TDD: 3 commits in RED → GREEN → GREEN cadence
- III — Clean Architecture: Application use-cases import zero Drizzle/next/react; route layer only Presentation seam
- V — i18n: EN+TH+SV at 2320 keys parity
- VI — Inclusive UX: shape+icon+text+colour badges, aria-pressed toggles, aria-sort columns, sr-only captions, target=_blank rel=noopener noreferrer + "opens in new tab" SR announcement
- VII — Perf: pageSize clamps + index-friendly queries; perf-bench deferred to Phase 10 T-bench-list
- IX — Workflow: 3 `[Spec Kit]` Conventional Commits; solo-maintainer substitute applies

### Smart features status (per docs/smart-chamber-features.md)
- ✓ At-a-glance match-rate column on events list
- ✓ Filter chips with aria-pressed state (partner-benefit only · cultural only · include archived)
- ✓ 3-variant context-aware empty state (no integration / no deliveries yet / all archived)
- ✓ Unmatched-only attendee table toggle with URL state
- ✓ Substring search on attendee email + name
- DEFERRED (Phase 6+): partner-benefit / cultural-event toggle mutations, archive event, relink registration

---

## Phase 5 — US3 Tenant onboarding wizard (planned, not started)

T068–T081 — generate-secret + rotate-secret + test-webhook + walkthrough + recent-deliveries panel. Canonical `/admin/integrations/eventcreate` page lands here, replacing the Phase 4 placeholder.

---

## Pre-flag-flip operator checklist (cumulative — will grow as each phase lands)

The full list will live here as the final pre-flag-flip gate. Phase 4 contributes 8 items (P4-G1..G8 above). Phases 5–10 will add their own. Final checklist must be 100% green before any tenant gets `FEATURE_F6_EVENTCREATE=true`.

### Phase 4 alerting + runbook contracts (MEDIUM-3 round-3 fix)

The Phase 4 admin detail route emits a `logger.warn` with the event discriminator `admin_event_detail_not_found` on every 404 — this includes legitimate stale URLs (browser tabs, bookmarks to archived events) AND potential enumeration attempts. The hashed `event_id_hash` field (first 16 chars of SHA-256) is the correlation key.

**Alerting requirement** — when the Grafana alert is wired in Phase 10 T124+:
- DO NOT alert on **absolute count**. Staff fat-fingering URLs will create background noise.
- DO alert on **rate per actor**: ≥10 distinct `event_id_hash` values in 5 minutes from a single `actor_user_id` (clear enumeration signal).
- DO alert on **rate per tenant**: ≥50 events/min sustained (could indicate a script).
- Tune thresholds during the first 30 days post-flag-flip based on real noise floor.

Document this contract in `docs/runbooks/f6-admin-event-detail-not-found.md` (to be created in Phase 10).
