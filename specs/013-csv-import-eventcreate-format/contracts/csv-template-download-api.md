# ~~Contract — `GET /api/admin/events/import/template`~~ — DROPPED v1

**Phase 1 contract · Feature**: `013-csv-import-eventcreate-format`
**Status**: DROPPED per Clarifications Session 2026-05-15 post-critique Q5

---

## Why dropped

US4 (CSV template download) had no v1 user persona:
- TSCC chamber uses EventCreate's "Guestlist" export verbatim per US1 — no template needed
- Non-EventCreate workflows (Eventbrite / Luma / Meetup native CSV builds) are out-of-v1 scope per spec § Out of Scope (deferred to F6.2)
- Phase 7's generic CSV path still works for any admin who hand-builds a CSV per the documented canonical schema

User clarification 2026-05-15 post-critique Q5: "ตัด US3 + US4 ออก ตรง pattern Q2 cut philosophy — no recycling work, drop unneeded surfaces early."

---

## Re-eligibility for v1.x

Re-introduce this contract if/when:
- Eventbrite / Luma / Meetup native connectors land (F6.2+) AND admins ask for "what schema does Chamber-OS accept?" reference
- Multi-tenant onboarding includes chambers without an EventCreate-equivalent platform → CSV-from-scratch becomes a daily-driver workflow
- Support tickets indicate "I don't know how to format my CSV" as a recurring onboarding question

Until then, the canonical schema is documented in `contracts/csv-import-eventcreate-api.md` (generic-format header) + `specs/012-eventcreate-integration/contracts/csv-import-api.md` (Phase 7 baseline) for any admin who needs the reference manually.

---

## Original design (reference)

The original v1 design proposed:
- Route: `GET /api/admin/events/import/template`
- Response: static UTF-8 CSV with canonical header + 2-3 example rows
- Admin-only RBAC
- 1-hour `Cache-Control` (template changes only with releases)
- Cells passed through `csvSafeCell()` for formula-injection mitigation (R3)
- ~6 contract tests

Effort estimate when re-introduced: ~1 day (static file + route + i18n keys + tests + a11y).
