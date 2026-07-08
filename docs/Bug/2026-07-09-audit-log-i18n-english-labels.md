# Audit log shows English in TH/SV UI — triage, fix, and residual-surface decision

**Reported**: 2026-07-09 by QA — "In Audit log, some Swedish shows in English; some Thai shows in English."
**Status**: FIXED (event labels) + DOCUMENTED-BY-DESIGN (stored summaries, payload detail)
**Branch**: `worktree-audit-i18n-labels`

## Root cause

`/admin/audit` (and the dashboard activity feed, member timeline, and the audit
filter dropdown) resolve an `audit_event_type` code to a display label via
`resolveEventLabel` (`src/lib/audit-event-label.ts`):

1. `admin.dashboard.activity.events` (29 keys, viewer-phrasing overrides)
2. `audit.eventType` (the broad catalogue)
3. **humanised-English fallback** (`payment_initiated` → "Payment initiated") — fires in *every* locale

The catalogue was written in the F3/timeline era and never extended as
F1/F2/F4/F5/F6/F9/COMP-1/088 added enum values. On `main`, **85 of 167 enum
values** resolved through step 3 — i.e. English regardless of UI locale. No gate
caught the drift: `check:i18n` verifies cross-locale **key parity** only, and the
keys were consistently *absent from all three locales*, so parity held.

## Fix

1. **Coverage guard (TDD, committed RED first)** —
   `tests/unit/insights/audit-event-label-coverage.test.ts` pins:
   - every `ALL_AUDIT_EVENT_TYPES` value resolves via `activity.events ∪ audit.eventType` in EN/TH/SV;
   - every TH label contains Thai script (a TH value copy-pasted from EN passes
     parity but is exactly the reported bug — it now fails);
   - labels are non-empty.
   Adding an enum value without a label is now a RED unit test.
2. **86 labels added** to `audit.eventType` in `en.json` / `th.json` / `sv.json`
   (85 missing on `main` + `renewal_cycle_reanchored` pre-seeded for the
   in-flight `renewal-rolling-anchor` branch so it stays green against the new
   guard). Terminology matched to the existing catalogue (แพ็กเกจ / ใบแจ้งหนี้ /
   ใบลดหนี้ / บันทึกการตรวจสอบ / ทำเนียบสมาชิก; Paket / Faktura / Kreditnota /
   Granskningslogg / Medlemskatalog).

Bonus surface fixed by the same catalogue additions: the member timeline
(`timeline-event-item.tsx`) previously fell back to the **stored English
summary** for uncatalogued audit events — those now resolve to localised labels.

## Residual English surfaces — decision (go-live)

Two audit-viewer surfaces remain English **by design**; they are *stored data*,
not translatable UI strings:

| Surface | Why it stays | What full i18n would take |
|---|---|---|
| **Summary column** | Written in English at emit time into the append-only `audit_log` (e.g. `audit log queried by admin`); rows cannot be rewritten retroactively (audit-integrity + PDPA/GDPR evidentiary value). It is redacted per role (`redactSummaryForRole`) but not localisable per row. | Architectural change: store `summary_key` + params instead of prose, render per locale. Post-launch item if ever needed. |
| **Payload detail rows** (expandable key/value, e.g. `Row count: 50`) | Keys are technical JSONB field names from ~170 emit sites — an **open set** (no enum), so a translation catalogue would silently drift back into this same bug class with no possible coverage guard; values themselves are raw stored data (ids, ISO dates, English enum strings). | Not planned — treat as technical detail, same class as request IDs / UUIDs shown in the same rows. |

**QA guidance**: re-test the Event column + event-type filter dropdown +
dashboard activity feed + member timeline in TH and SV — all labels must be
localised. The *Summary* text and the expandable payload key/values remain
English technical data; this is expected and documented here.

## Verification

- `tests/unit/insights/audit-event-label-coverage.test.ts` — 5/5 GREEN (was RED with 85/85/85 missing per locale)
- `pnpm check:i18n` — OK, 4292 keys present in all 3 locales
- Adjacent suites (`tests/unit/i18n`, `tests/unit/insights`, timeline i18n render test) — 384/384 GREEN
