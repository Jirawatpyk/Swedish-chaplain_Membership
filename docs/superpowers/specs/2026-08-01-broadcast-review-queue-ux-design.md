# E-Blast broadcast review queue — full UX pass (triage + consistency + send-safety)

**Date:** 2026-08-01
**Author:** brainstorming session (Jirawat + Claude)
**Status:** design — pending user review
**Scope area:** `src/app/(staff)/admin/broadcasts/**` + `src/components/broadcast/admin/**` + `src/i18n/messages/{en,th,sv}.json`

## Problem

`/admin/broadcasts` is the admin's **primary task surface** for F7 Email Broadcast: members submit broadcasts, an admin reviews each `submitted` broadcast and **approves + sends** (now or scheduled) or **rejects** it. A UX audit (2026-08-01, enterprise-ux-designer + a consistency sweep vs members/renewals/invoices) found the page is functionally solid but has four material gaps:

1. **Triage gap.** `SlaBanner` shows median / p95 time-to-decision over a **rolling 30-day window** — a *lagging* indicator. It can render "Within SLA budget" (green) while broadcasts are **currently** overdue (waiting > 48 h right now), because the 30-day p95 smooths the present spike. An admin opening the queue to clear it gets the wrong signal. There is no page-level "overdue right now" count.
2. **Consistency outlier.** The queue is the only admin list that (a) **hand-rolls its own `<table>`** instead of the shared `@/components/ui/table.tsx` primitive; (b) anchors its bulk bar **sticky-TOP** as a custom `role="region"` div while members/renewals use a **fixed-BOTTOM `role="toolbar"`** extracted component with `aria-live` count, `indeterminate` select-all, 24 px checkbox targets, and shared `useDialogFinalFocus` + `BulkProgressIndicator` + `BULK_CAP`; (c) has **no mobile card fallback** (renewals has `PipelineCardList`); and (d) carries **dead virtualization** (`@tanstack/react-virtual`, threshold 100 rows) that never activates because the query pages at `pageSize: 50`.
3. **Real i18n bug.** The "Audience" column renders the **raw enum** (`event_attendees_last_90d`, `all_members`, `tier`, `custom`) in every locale — the translated labels exist (`review.segmentType.*`) but are not used. Bulk toast/count strings use manual `.replace()` (no ICU pluralisation).
4. **Send-path safety gap.** **Bulk-approve fires `send_now` immediately** — no confirmation, no recipient count shown — despite emails going out irreversibly (≤ 60 s cron) and affecting sender reputation. This is *less* friction than members' bulk archive (which has a confirm + 10 s Undo) for a *more* dangerous, irreversible, member-facing action.

Also spotted: **success/warning token drift** — `SlaBanner` + the queue age badges use raw `emerald-*`/`amber-*` for green/amber while `red` uses the tokenised `bg-destructive-surface text-destructive` (the exact drift just fixed on the erasure-log page; the repo has AA-tuned `--success`/`--warning` tokens).

This is a **full UX pass**, delivered as **three sequenced PRs**. No money-path, approve/reject endpoint, or RBAC change — only PR3 adds a client-side confirmation layer on the send decision.

## What the page already gets RIGHT — do NOT churn

- **Focus-return chain** — `approve-dialog.tsx` / `reject-dialog.tsx` use `useDialogFinalFocus` + `closedViaSuccessRef` to handle "trigger unmounts after approve success → focus falls to body". Correct; keep.
- **Reject dialog** — shared `ReasonConfirmationDialog`, reason required, verbatim to member, counter + `aria-live`, destructive paint. Keep.
- **Schedule path (single)** — Bangkok wall-time parse + preview + 5-min min-lead. Keep (PR3 reuses it for bulk).
- **Empty state** — title + body + Inbox anchor, deliberately no CTA (admin can't manufacture submissions). Keep.
- **Halt banner + Manager-readonly banner** — `halt-state-banner.tsx` already uses `bg-destructive-surface text-destructive` (tokenised); manager sees an inline note, not disabled buttons. Keep.
- **Sort `submitted_at_asc` (oldest-first)** — FIFO protects the SLA. Keep as default.
- **Default filter `['submitted']`** (with the `status_all=1` "show every status" sentinel) — focuses the admin's actual task (FR-010). Keep.

## Decisions (locked with user)

1. **Full pass = 3 sequenced PRs**, implemented PR1 → PR2 → PR3 (each is a separate review):
   - **PR1** — triage + presentation / a11y / i18n / tokens (pure presentation, ~3 files, 1 reviewer).
   - **PR2** — shared `<Table>` primitive + mobile card fallback + bulk-bar placement/extraction (render-tree change → full e2e/axe sweep).
   - **PR3** — send-path confirmation ⚠️ (behaviour change on the irreversible send path → **≥ 2 reviewers** + test coverage; **must be a separate PR**).
2. **WS-F confirm style = confirm dialog with recipient total** (NOT typed-match) — friction proportionate to single-approve, which is at this level.
3. **WS-F: bulk-approve gets a send-now / schedule choice** (mirroring single-approve). One shared scheduled time for the whole batch. Reuses the **existing** approve endpoint's schedule support — no endpoint change.
4. **Mobile card fallback IS included** (PR2) — consistency with renewals is the point of this task.
5. **Preserve** everything in the section above.
6. **Send-now Undo toast (PR3).** After a send-now approve (bulk or single), show a "Sending in 60 s — Undo" toast that cancels via the **existing** cancel path (`cancel-broadcast`, cancellable while status is `submitted`/`approved`, before the cron dispatches ≤ 60 s) — parity with members' bulk-archive Undo. The race (cron already dispatched → cancel returns 409 → a "too late" toast) is handled gracefully.
7. **Single-approve recipient count ships in PR1, not PR3** (review re-scope) — it is presentation-only (thread + display `estimatedRecipientCount`), shares no logic with the bulk confirm/schedule, so it moves to PR1 to keep the high-scrutiny PR3 diff minimal.

## Review round 1 (enterprise-ux-designer + security-engineer, 2026-08-01) — folded in

Both reviewed every spec claim against the live code. **No blocker; security-sound.** Security confirmed: the approve endpoint already accepts `{decision:'schedule', scheduledFor}` with server-side double-validation (route `.refine` + use-case vs clock — client never trusted); RBAC denies manager (403) on every per-id call; the concurrency guard (status must be `submitted`) → 409 `broadcast_concurrent_action_blocked` prevents double-send; the recipient count is **display-only** (`ApproveBodySchema` has no recipient field; the real recipient set is resolved at dispatch) so tampering it cannot change who is emailed; scheduled broadcasts ARE per-row cancellable before dispatch. Folded-in corrections: (a) the schedule payload field is **`scheduledFor`**, not `scheduledAt` (security minor — would 400 if implemented literally); (b) the truncation guard uses `listResult.nextCursor !== null`, not the filter-unaware `totalPending` (§ WS-A); (c) the overdue banner + truncation note gate to the default/`submitted` view (mirror erasure-log's unfiltered gating); (d) banner-stacking priority rule added (§ WS-A); (e) single-approve recipient count moved to PR1; (f) i18n deletions must use the FULL key path (§ WS-B); (g) the send-now Undo toast (decision 6). The SLA-blindness is worse than "lagging": `computeSlaStatsForTenant` (`page.tsx:56-74`) computes median/p95 only over `status IN ('approved','rejected','sending','sent')`, so a `submitted` backlog is **structurally invisible** to it — the overdue banner is the only current-state signal.

---

# PR1 — Triage signal + presentation / a11y / i18n / tokens

Pure presentation + read-only SQL. Files: `page.tsx`, `queue-table.tsx`, `queue-table-client.tsx`, `sla-banner.tsx`, `loading.tsx`, i18n.

## WS-A — Triage: make an over-SLA backlog impossible to miss

- **Overdue-now banner (MUST).** Add a page-level count of `submitted` broadcasts older than the 48 h SLA: a read-only `COUNT(*)` via `runInTenant` (same tenant-safe shape/boundary as the existing `totalPending` at `page.tsx:254-260` — reviewed incident precedent "Round-4 CRIT-A", `WHERE status='submitted' AND submitted_at < now()-interval '48 hours'`; 48 h matches the existing `SLA_RED_HOURS` at `queue-table.tsx:85`). When `> 0`, render a **destructive breach banner above `SlaBanner`**, reusing the erasure-log pattern (`erasure-log/page.tsx` breach banner → `t('overdueBanner', { count })` on `bg-destructive-surface text-destructive`, `role="alert"`, visibly prominent). This separates the two signals cleanly: **SlaBanner = historical trend, Overdue banner = act now.**
  - **Gate to the default/`submitted` view** (mirror erasure-log's unfiltered gating): show the overdue banner only when the current view includes the default `submitted` filter, so it doesn't compete with a `rejected`-only or `status_all=1` view.
- **Banner-stacking priority (SHOULD).** On a bad day the overdue banner + `SlaBanner` + `HaltStateBanner` can all be destructive/amber at once. Rule: when the overdue banner is showing, **demote `SlaBanner` to a compact inline stat** (not a full-width coloured banner) — the "act now" signal wins; the 30-day trend must not visually compete with it.
- **Silent-truncation guard (SHOULD, replaces the old "showing 50 of N").** `listByTenantStatus` returns no filtered total — only `rows` + `nextCursor`. Use **`listResult.nextCursor !== null`** as the "more rows exist beyond this page" signal (works for ANY filter, no extra query) and render a muted "showing the first 50 — refine the filter" note. Do NOT use the filter-unaware `totalPending` count for this.
- **De-jargon SLA copy (SHOULD).** `sla-banner.tsx` copy `"SC-002 breach — review queue capacity"` + `"p95"` → plain admin language (e.g. "9 in 10 decisions within Xh" / "review backlog is slow"). Internal spec jargon should not reach a DPO/admin.
- **Sort control (COULD — DEFER within PR1).** `sort` is hardcoded `submitted_at_asc` (`page.tsx:151`); a newest/recipient-count control is a nicety but the default is correct — leave.

## WS-B — i18n correctness (real bugs, not style)

- **Audience column raw-enum leak (MUST).** `queue-table.tsx:115` sets `segmentLabel: row.segmentType` (raw enum). Map it through the existing `review.segmentType.*` labels (a `tSegment(row.segmentType)` lookup) so "Audience" shows human copy in every locale.
- **ICU pluralisation (MUST).** Replace the manual `.replace('{count}'…)` / `.replace('{ok}'…)` (`queue-table-client.tsx:370-372,422-425`) with ICU plural messages passed pre-formatted from the server wrapper (`queue-table.tsx`), so `bulk.selected` / `bulk.partial` pluralise (EN/SV "1 selected" vs "3 selected") and interpolate all occurrences.
- **Remove dead i18n keys (SHOULD).** `filters.apply`, `pagination.*`, `filters.statusAll` under `admin.broadcasts.queue` are orphaned (filters are URL-driven, no Apply button, no pagination UI). Delete from all three locales — **scoping on the FULL key path** (`admin.broadcasts.queue.filters.apply`, not a bare `"apply"`): the leaf names `apply`/`pagination` collide with other namespaces (renewals, invoices, F9 audit) — a bare find/replace would delete another module's key. **Note:** `filters.statusAll` (dead "All statuses" copy) is NOT the live `status_all=1` URL sentinel in `page.tsx`/`queue-filters.tsx` — the names look alike; the sentinel stays.
- **Single-approve shows recipient count (MOVED here from PR3 — presentation-only).** Thread `estimatedRecipientCount` (already on `QueueRow`, `queue-table.tsx:32`) → `ReviewActions` → `ApproveDialog` and display it, so a single approve also shows who it reaches. No behaviour change; ships in PR1.
- **SV length note.** SV bulk-button strings run ~15-25 % longer; the bulk bar must `whitespace-nowrap` its buttons and wrap the row on narrow screens (addressed structurally in PR2's bar extraction).

## WS-C — bulk-bar a11y (quick wins on the existing bar)

Applied to the current sticky-top bar in PR1 (the placement move to fixed-bottom `role="toolbar"` is PR2, coupled to the bar extraction):

- **`aria-live="polite"` on the selected-count (MUST)** — `queue-table-client.tsx:434` (members `bulk-action-bar.tsx:398` has it). SR users must hear the count change as they tick rows.
- **`indeterminate` select-all header checkbox (MUST)** — `queue-table-client.tsx:107-123` is a plain boolean; use the shadcn `Checkbox` `indeterminate` state for the "some selected" case (members/renewals already do).
- **24 px checkbox targets (SHOULD)** — add `min-h-[24px] min-w-[24px]` to the select checkboxes (`queue-table-client.tsx:115-131`) per WCAG 2.5.8.

## WS-E — success/warning token drift

- **SlaBanner (SHOULD)** — `sla-banner.tsx:24-30` `SEVERITY_STYLES` + `:70-79` pill: green `emerald-*` → `bg-success-surface text-success border-success/40`; amber `amber-*` → `bg-warning-surface text-warning border-warning/40`; red already tokenised. (The file's own comment `:75-78` documents a hand-tuned contrast fix — exactly what the tokens exist to solve.)
- **Age badges (SHOULD)** — `queue-table-client.tsx:154` amber `amber-*` → warning tokens (red at `:153` already tokenised).

## WS-G — polish (PR1 slice)

- **Skeleton chip count (COULD)** — `loading.tsx:36` renders 8 chips vs 10 `BROADCAST_STATUSES`; derive the count from `BROADCAST_STATUSES.length` (small CLS on hydrate).

---

# PR2 — Shared `<Table>` primitive + mobile cards + bulk-bar convergence

Render-tree change; full e2e/axe sweep. Files: `queue-table-client.tsx` (+ a new card list + a `queue-with-bulk` wrapper), `queue-filters.tsx` (chip grouping).

## WS-D — table + bulk convergence

- **Drop dead virtualization (SHOULD, do first).** Remove `VIRTUALIZE_THRESHOLD` (`:34`), the `useVirtualizer` block (`:255-264`), and the padding-row branch (`:489-557`). `shouldVirtualize` is always `false` at `pageSize: 50`. Removing it unblocks the shared primitive.
- **Adopt the shared `<Table>` primitive (SHOULD).** Replace the hand-rolled `<table>`/`<thead>`/`<tbody>` (`:462,519`) with `@/components/ui/table.tsx` (Table/TableHeader/TableRow/TableHead/TableCell) — inherits the focusable scroll region, sticky `bg-card` header, and `--table-row-height`/`--table-cell-padding-*` tokens. Keep the `useReactTable` instance + column defs.
- **Mobile card fallback (SHOULD).** Dual-render like renewals: `<table>` `hidden md:block` + a `QueueCardList` `md:hidden`, sharing ONE `useReactTable` instance (mirror `pipeline-table.tsx` + `pipeline-card-list.tsx`). The card shows subject (link) + member + status badge + age badge + recipient count + submitted-at + the select checkbox (24 px) + per-row review actions.
- **Bulk bar → fixed-bottom `role="toolbar"` + extract (SHOULD).** Move the bulk bar out of the table client into a `queue-with-bulk` wrapper mounting a fixed-bottom `role="toolbar"` bar (mirror `directory-with-bulk.tsx` + `pipeline-bulk-action-bar.tsx`): `fixed bottom-0 … z-40 backdrop-blur shadow-lg`, a ResizeObserver spacer so it never covers the last row, `aria-live` count, `whitespace-nowrap` wrapping buttons, and reuse `useDialogFinalFocus` (already in the broadcast module) + `BulkProgressIndicator` + a shared `BULK_CAP`. The bulk-approve fan-out logic moves with it. **Mirror the existing bars' keyboard behaviour exactly** — do not add broadcast-specific toolbar roving-tabindex nav (a new divergence would defeat PR2's whole point).

## WS-G — filter polish (PR2 slice)

- **Group status chips (COULD)** — `queue-filters.tsx:238-253` renders all 10 statuses equally; group in-review vs terminal (`sent`/`cancelled`) so the common ones lead. Heed the renewals month-lens lesson: keep the **Reset** control adjacent to the chip strip, not pushed away by `ml-auto` (`:317-328`).

---

# PR3 — Send-path confirmation ⚠️ (behaviour change)

Files: `queue-table-client.tsx` / the extracted bulk bar, a new bulk-approve confirm dialog, `review-actions.tsx` + `approve-dialog.tsx`. **≥ 2 reviewers, test coverage for the new schedule path.** No approve-endpoint / RBAC / money change — a client confirmation layer + passing the chosen decision to the (already schedule-capable) endpoint.

## WS-F — recipient-count confirmation + bulk schedule

- **Bulk-approve confirm dialog (MUST).** Currently `queue-table-client.tsx:305` posts a hardcoded `{ decision: 'send_now' }` for every selected row with no confirm. Add a confirm dialog that:
  - summarises **N broadcasts → ~M total recipients** (M = client-side sum of the selected rows' `recipientCount`, already on `EnrichedQueueRow` — no extra query; **display-only**, never sent in any request body — the real recipient set is resolved server-side at dispatch);
  - offers a **send-now / schedule** choice reusing single-approve's schedule picker (Bangkok-TZ input + preview + 5-min min-lead); one scheduled time applies to the whole batch;
  - states the action is immediate + irreversible (send-now) / scheduled;
  - on confirm, the fan-out posts the **chosen** decision per row — **`{decision:'send_now'}`** or **`{decision:'schedule', scheduledFor}`** (field name is `scheduledFor`, matching `ApproveBodySchema` + single-approve; the endpoint already accepts both and re-validates min-lead server-side).
  - Keep the existing chunked `Promise.allSettled` (BULK_CHUNK concurrency), per-row failure handling, and failed-rows-stay-selected retry.
- **Send-now Undo toast (MUST — decision 6).** After a send-now approve completes (bulk or single), show a "Sending in 60 s — Undo" toast. Undo calls the **existing** cancel path (`cancel-broadcast`, valid while status is `submitted`/`approved`, i.e. before the cron dispatches) for the just-approved broadcast(s). If the cron already dispatched (status `sending`/`sent`), the cancel returns 409 and the toast reports "already sending — too late to undo" — no error surfaced beyond that. This gives the same escape hatch members' bulk-archive has, using zero new endpoint.
- (Single-approve recipient count moved to **PR1** — presentation-only.)

---

## i18n (EN canonical → TH + SV)

New/changed keys under `admin.broadcasts.queue` (+ `admin.broadcasts.approveDialog`):
- `overdueBanner` (`{count, plural, …}`, PR1 WS-A), de-jargoned SLA copy (`slaBanner.*`, PR1 WS-A).
- `bulk.selected` / `bulk.partial` → ICU plural (PR1 WS-B); the Audience/segment labels wired through `review.segmentType.*` (PR1 WS-B).
- Delete `filters.apply`, `pagination.*`, `filters.statusAll` (PR1 WS-B).
- Bulk-approve confirm dialog copy — recipient total + send-now/schedule + irreversible warning (`{count}`/`{recipients}` plural, PR3 WS-F).
EN/TH/SV parity (`check:i18n`); TH no `italic`; SV bulk strings need `whitespace-nowrap` + wrap (PR2); the PR3 confirm-dialog body is long-sentence copy — give TH adequate `leading` (line-height) so the recipient-total + irreversible warning stays readable. `text-muted-foreground` stays the empty-`—` sentinel.

## Test impact

- **PR1** — unit: overdue-count derivation (tenant + status + 48 h threshold, live-Neon not mock); component: bulk-count `aria-live`, `indeterminate` header checkbox, overdue-banner gating to the default/`submitted` view + `SlaBanner`-demote when it shows, truncation note driven by `nextCursor` (any filter), token classes, single-approve dialog shows recipient count; e2e: `@a11y` axe (banner + bulk bar), `@i18n` EN/TH/SV (no raw-enum leak in Audience).
- **PR2** — component: shared-`<Table>` render, mobile `QueueCardList` at ≤ md, fixed-bottom toolbar spacer/`aria-live`; e2e: full `@a11y` sweep (desktop table + mobile card at 360 px), keyboard/SR on the toolbar; confirm no regression to select/approve.
- **PR3** — component: recipient-total sum, send-now vs schedule branch, confirm-required-before-fan-out, **negative assertion that the displayed recipient-total is NOT in any request body**, retry-after-partial-schedule-failure **re-opens the dialog + revalidates min-lead** (never resubmits a now-stale `scheduledFor`), Undo toast → cancel path + the 409 "too late" race; contract/integration: the bulk-schedule fan-out posts `{decision:'schedule', scheduledFor}` matching the current `ApproveBodySchema` (catches the field-name at the first red test — the endpoint's schedule path is already covered for single; add the bulk case); e2e: bulk-approve confirm flow + schedule flow + Undo.
- Gates per PR: `pnpm lint` + `typecheck` + `check:i18n` + `check:layout` + unit/component. **Any UI PR → `enterprise-ux-designer` pass.** **PR3 → `security-engineer` + a second reviewer** (send path, member-facing, irreversible).

## Risk classification

| Work | Type | Guard |
|------|------|-------|
| PR1 (WS-A/B/C/E/G) | Pure presentation + one read-only `COUNT` via `runInTenant` | 1 reviewer; tenant boundary reused from `totalPending` |
| PR2 (WS-D) | Presentation, but touches the whole render tree | full e2e + axe sweep |
| **PR3 (WS-F)** | **⚠️ Behaviour change — irreversible SEND path** | **≥ 2 reviewers + tests; approve/reject/cancel endpoint semantics UNCHANGED, RBAC UNCHANGED (manager still sees no buttons) — client confirm + decision passthrough + Undo via the existing cancel endpoint only. Recipient total is display-only (never in a request body).** |
| Pagination | Behaviour (query param + cursor) | **DEFERRED** |

Nothing touches the money path, the approve/reject endpoint semantics, or RBAC.

## Open questions / deferred

- **Terminal-status chip grouping** (WS-G COULD) — confirm during PR2 whether admins ever filter `sent`/`cancelled`; group or collapse accordingly.
- **Pagination** (DEFER) — `page.tsx:144-152` pages at 50 with no Next/Prev UI (`nextCursor` unused). At SweCham scale (~131 members) a pending queue > 50 is near-impossible. The silent-truncation guard is handled by PR1's WS-A `nextCursor` note (not a `totalPending` count); a real Next/Prev UI is deferred until scale demands it.
- **Bulk `BULK_CAP`** — adopt the shared members/renewals cap (100, `@/lib/members-bulk-constants`) with an over-cap `role="alert"` when the bulk bar is extracted (PR2), replacing the current cap-less `BULK_CHUNK=5` throttle (throttle stays for concurrency). **PR3 (send-safety) sequences AFTER PR2, so the cap is in place before bulk-approve gains the send confirmation.** (If the order is ever swapped, PR3 must add an interim selection cap so the confirm can't summarise an unbounded batch.)
- **Overlapping-audience batch send (nice-to-have)** — a bulk send-now/schedule can dispatch two broadcasts to overlapping segments (e.g. both `all_members`) in the same instant, which reads as spam to a member. Not a blocker; consider a soft warning in the confirm dialog when the selected rows' segments overlap.
