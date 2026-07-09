# Audit log shows English in TH/SV UI — triage, fix, and residual-surface decision

**Reported**: 2026-07-09 by QA — "In Audit log, some Swedish shows in English; some Thai shows in English."
**Status**: FIXED (event labels) + DOCUMENTED-BY-DESIGN (stored summaries, payload detail)
**Branch**: `worktree-audit-i18n-labels`

## Root cause

`/admin/audit` (and the dashboard activity feed, member timeline, and the audit
filter dropdown) resolve an `audit_event_type` code to a display label via
`resolveEventLabel` (`src/lib/audit-event-label.ts`):

1. `admin.dashboard.activity.events` (29 keys, viewer-phrasing overrides)
2. `audit.eventType` (the broad catalogue — the ONLY catalogue the member
   timeline consults)
3. **humanised-English fallback** (`payment_initiated` → "Payment initiated") —
   fires in *every* locale (the timeline falls back to the stored English
   summary instead)

Two compounding gaps (exact numbers verified against migrations + `origin/main`):

- **Catalogue drift**: the catalogue was written in the F3/timeline era and
  never extended. The live DB enum holds **311 values** (`CREATE TYPE` + every
  `ALTER TYPE … ADD VALUE` across `drizzle/migrations/`); on `main`,
  `audit.eventType` had 100 keys — **212 of 311** missed the primary catalogue,
  and **194 of 311** missed *both* catalogues (English everywhere).
- **Universe drift** (reviewer-2 finding): the TS pgEnum tuple only carries
  **166** of the 311 values — F6/F7/F8 added 145 values via hand-written
  migrations without syncing the tuple. `ALL_AUDIT_EVENT_TYPES` (filter
  dropdown + any tuple-based guard) silently under-reported the enum, so the
  busiest families (broadcast lifecycle, CSV import, quota, renewal cycle) were
  unfilterable AND invisible to a tuple-based coverage test. Three of the 145
  (`lapsed_member_admin_reactivation_reminder_t-7/-3/-1`, migration 0109) carry
  a **hyphen** — the only non-`[a-z0-9_]` values — and were initially skipped
  by a word-char-class parser on *both* sides of the parity check (reviewer-2
  round-2 catch): keep any parser of this enum hyphen-safe (`'([^']+)'`).

No gate caught either drift: `check:i18n` verifies cross-locale **key parity**
only, and the keys were consistently *absent from all three locales*, so parity
held.

## Fix

1. **Coverage guard (TDD, committed RED first, then widened RED again after
   reviewer-2)** — `tests/unit/insights/audit-event-label-coverage.test.ts` pins:
   - `ALL_AUDIT_EVENT_TYPES` **equals the DB enum re-derived from
     `drizzle/migrations/`** (both directions — a migration-added value missing
     from the export fails, and an exported value no migration ever added fails);
   - every enum value has a label **in `audit.eventType` specifically** in
     EN/TH/SV (union with `activity.events` is NOT enough — the member timeline
     resolves against `audit.eventType` only);
   - every TH label contains Thai script (a TH value copy-pasted from EN passes
     parity but is exactly the reported bug — it now fails);
   - labels are non-empty.
   Adding an enum value without a label is now a RED unit test **regardless of
   whether it was added via the TS tuple or a hand-written migration**.
2. **`DB_ONLY_AUDIT_EVENT_TYPES`** (145 values) added to
   `src/modules/auth/infrastructure/db/schema.ts`; `ALL_AUDIT_EVENT_TYPES` is
   now tuple ∪ that list = the full 311-value enum, so the audit-viewer filter
   dropdown can filter every type that appears in the log.
3. **213 labels added** to `audit.eventType` ×3 locales across three rounds
   (86 in round 1 — 85 missing over the tuple universe +
   `renewal_cycle_reanchored` pre-seeded for the in-flight
   `renewal-rolling-anchor` branch; 124 in round 2 over the full DB universe —
   42 copied from the F6 `admin.events.detail.auditEvents` catalogue, 18 from
   `activity.events`, 64 fresh; 3 hyphenated F8 reminder values in round 3).
   Catalogue now 313 keys (311 enum + 2 non-enum extras:
   `renewal_cycle_reanchored` pre-seed and `manual_outreach_required`, a
   pre-existing catalogue key no migration ever added — harmless, F8 records
   that situation as `escalation_task_created`). Terminology matched to the
   existing catalogue (แพ็กเกจ / ใบแจ้งหนี้ / ใบลดหนี้ / บันทึกการตรวจสอบ /
   ทำเนียบสมาชิก; Paket / Faktura / Kreditnota / Granskningslogg /
   Medlemskatalog).
4. **Filter dropdown regrouped** — `auditEventCategory` gained `events` (F6
   attendee/CSV/quota/webhook-ingest/PII families) and `renewals` (F8
   renewal/tier-upgrade/at-risk/escalation families) categories; the `other`
   group would otherwise have held 117+ of 311 options. Cross-feature prefix
   collisions (a self-review follow-up, PR #175) are resolved by an explicit
   `AUDIT_CATEGORY_OVERRIDES` map keyed by verified emit-site module: the 12 F6
   EventCreate `webhook_*` ingest events → *Events* (they share the `webhook_`
   prefix with F5 payment webhooks); the two F4/088 invoicing values
   `event_buyer_pii_redacted` + `registration_cross_tenant_probe` → *Billing*
   (their `event_`/`registration_` prefix would otherwise be stolen by the
   events arm); `cron_dispatch_orchestrated` → *Renewals*;
   `member_acknowledged_broadcasts_terms` → *Broadcasts*. Two values are
   **genuinely shared** across features and deliberately keep their default
   group rather than being mislabelled: `webhook_signature_rejected` (emitted by
   both F5 payments and F6 events) stays *Billing*, and `cron_bearer_auth_rejected`
   (emitted by the shared `src/lib/cron-auth.ts` gate used by every feature's
   cron routes) stays *Other*. Note: category only affects the group *heading* —
   every event remains individually selectable and filters correctly regardless.
5. **Pre-existing label drift normalised at source + copies** (i18n review):
   SV `webbhok` misspelling (13 F6 keys), TH `เว็บฮุค` → `webhook`
   (label-catalogue convention), non-canonical cross-tenant-probe phrasings
   (`cross_tenant_probe`, `csv_import_cross_tenant_probe`), SV `Plan skapad` →
   `Paket skapat` family — fixed in both `admin.events.detail.auditEvents` /
   `activity.events` and their `audit.eventType` copies. A TH prose sentence in
   the F6 archive dialog still says เว็บฮุค (running text, not a label) and SV
   `inskickningar` remains in a broadcasts error message (different word sense)
   — both intentionally untouched.

Surfaces fixed: audit-viewer Event column, event-type filter dropdown (now
complete AND grouped), dashboard activity feed, and the member timeline
(previously fell back to the **stored English summary** for uncatalogued audit
events — every enum value now resolves to a localised label).

## Residual English surfaces — decision (go-live)

Two audit-viewer surfaces remain English **by design**; they are *stored data*,
not translatable UI strings:

| Surface | Why it stays | What full i18n would take |
| --- | --- | --- |
| **Summary column** | Written in English at emit time into the append-only `audit_log` (e.g. `audit log queried by admin`); rows cannot be rewritten retroactively (audit-integrity + PDPA/GDPR evidentiary value). It is redacted per role (`redactSummaryForRole`) but not localisable per row. | Architectural change: store `summary_key` + params instead of prose, render per locale. Post-launch item if ever needed. |
| **Payload detail rows** (expandable key/value, e.g. `Row count: 50`) | Keys are technical JSONB field names from ~170 emit sites — an **open set** (no enum), so a translation catalogue would silently drift back into this same bug class with no possible coverage guard; values themselves are raw stored data (ids, ISO dates, English enum strings). | Not planned — treat as technical detail, same class as request IDs / UUIDs shown in the same rows. |

**QA guidance**: re-test the Event column + event-type filter dropdown +
dashboard activity feed + member timeline in TH and SV — all labels must be
localised. The *Summary* text and the expandable payload key/values remain
English technical data; this is expected and documented here.

## Verification

- `tests/unit/insights/audit-event-label-coverage.test.ts` — 6/6 GREEN (round-1
  RED: 85 missing per locale over the tuple universe; round-2 RED: 142 enum
  values missing from `ALL_AUDIT_EVENT_TYPES` + 124 labels missing per locale
  over the DB universe)
- `pnpm check:i18n` — OK, all keys present in all 3 locales
- Adjacent suites (`tests/unit/i18n`, `tests/unit/insights`, `tests/unit/auth`
  all-audit-event-types, timeline i18n render test) — GREEN
- Both reviews complete: i18n-translation-reviewer (round 1: 7 findings applied,
  incl. a TH semantic fix on `payment_auto_refunded_stale_invoice`; round 2 on
  the 64 fresh labels) + QA reviewer #2 (universe/timeline findings — all
  addressed above)
