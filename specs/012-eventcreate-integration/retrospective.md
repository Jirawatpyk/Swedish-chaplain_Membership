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
| P4-G1 | `pnpm test:e2e --grep "F6 events list and detail" --workers=1` against seeded tenant + admin login | maintainer | DEFERRED (T054 — code-complete, manual gate) |
| P4-G2 | `pnpm test:e2e --grep "@a11y T055" --workers=1` axe-core scan of list + detail | maintainer | DEFERRED (T055 — code-complete, manual gate) |
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
