# Quickstart — 114 Member Portal: Approval Workflow for Member Changes

A validation/run guide: how to prove the feature end-to-end on the dev Neon branch and how to cut it
over. Implementation detail lives in `tasks.md`; shapes in `data-model.md` and `contracts/`.

## 0. Prerequisites

- `.env.local` → the **dev** Neon branch (`pnpm db:verify` green); prod is never touched by these steps.
- `FEATURE_MEMBER_CHANGE_APPROVAL=true` in `.env.local` (default OFF — with it off every new route
  is 404 and the portal edit form behaves exactly as today).
- The tenant switch ON for the dev tenant. Until US6 (PR-3) ships the admin card +
  `PATCH /api/admin/settings/member-changes`, flip the column directly — the e2e seed does exactly
  this (`tests/e2e/helpers/change-request-seed.ts` `ensureApprovalSetting`):
  `INSERT INTO tenant_member_settings (tenant_id, member_change_approval_enabled) VALUES ('swecham', true)
  ON CONFLICT (tenant_id) DO UPDATE SET member_change_approval_enabled = true`.
- Personas: `e2e-member-empty` (a primary contact with a portal login — the `e2e-member` persona is
  LAPSED by the F8 fixture; see memory), an `admin`, a `manager`, and one secondary contact with a
  login (seed via "Invite colleague" from the primary; prod has none, so the seed is the only source).
- Dev server: the maintainer runs `pnpm dev` on :3100 themselves.

```bash
pnpm db:migrate                                  # applies 0300 AND 0301 to the dev branch
pnpm db:verify                                   # 13 canaries incl. the two tables' composite keys + the settings column (0300) and the 7 enum values (0301, also asserted by scripts/lib/enum-migration-guard.ts at deploy) — a duplicate `when` makes migrate a silent no-op
pnpm check:multi-tenant                          # both new tables registered in SCOPED_TABLES
pnpm check:audit-events && pnpm check:i18n       # 5 events × 5 places; ~160 leaf keys × 3 locales
```

## 1. Story walkthroughs (each is the RED acceptance test's manual twin)

### US1 — submit, nothing applied, staff emailed
1. As the primary contact, open `/portal/edit`, change phone + billing address, Submit.
2. Expect: HTTP 201 `outcome: submitted`; `/portal/profile` shows the **pending banner** with both proposed values; `/admin/members/[id]` still shows the old values.
3. `pnpm outbox:dispatch-once` (or wait for the cron) → each admin/super_admin inbox (Resend test domain) has one email listing member, submitter, both fields old → new (billing address marked "affects tax documents"), link to `/admin/change-requests?submitter=…`.
4. Negative: submit again with an identical body → 200 `already_pending`, no email; send `{ "company": { "tax_id": "…" } }` → 403 + `member_self_update_forbidden` in `/admin/audit`; as the **secondary** contact send a `company` key → 403 `company_fields_require_primary`.

### US2 — approve in part; both portals in sync; member emailed
1. As admin open the email link → review page: two rows, both pre-selected; de-select "billing address", type a reason, confirm ("Approve 1, reject 1").
2. Expect: `/admin/members/[id]` and `/portal/profile` both show the new phone and the **old** billing address; request shows *partially approved*, reviewer, time, reason; `/admin/audit` has `member_change_request_decided { outcome: partially_approved }` with the admin as actor and **no field values**.
3. Member inbox: one email listing "Phone — now live" and "Billing address — not approved: <reason>" with the resubmit link.
4. Repeat the same confirm (double-click simulation via curl with the same body) → 200 `repeated: true`, no second email, no second audit row.
5. As **manager**: the queue and the review page load (read-only), the confirm button is absent; `POST …/decide` → 403 + `permission_denied` audit.

### US3 — reject all with a reason; resubmit prefilled
1. Decide with every row de-selected and a reason → *rejected*; record unchanged.
2. Member follows the email link → `/portal/edit?resubmit=<id>` shows the reason and prefills **only** the rejected values → submit → a new pending request.

### US4 — history
1. `/admin/members/[id]` → "Change requests" section lists both requests with per-field outcomes; `/admin/change-requests?state=decided&outcome=partially_approved` finds the first.
2. `/portal/change-requests` as the primary shows both; as the **secondary** shows only their own + company-level ones.
3. `/admin/members/[id]/timeline` and `/portal/timeline` show the submitted/decided events.

### US5 — withdraw / replace / cap
1. Submit, then `DELETE /api/portal/change-requests/current` → *withdrawn*; queue no longer lists it; a second DELETE → 404.
2. Submit twice within a minute → first becomes *withdrawn/replaced*, exactly one pending, and — in PR-1 — **two** staff emails, both `staffNotified: true` (the 1 h coalescing is T087 / PR-2; `staffNotified: false` today means the reviewer roster was EMPTY, which pages).
3. Submit 10 times in a row (script) → the 11th is 429 with `Retry-After`; `member_change_request_rate_limited` in the audit; works with `UPSTASH_*` unset.

### US6 — tenant switch + dashboard
1. Switch the setting OFF with one request pending → the queue still lists it and it can be decided; a new member edit at `/portal/edit` saves immediately (F3 behaviour) and emits `member_self_updated`.
2. Switch ON → `/admin` home "Needs attention" shows "N change requests waiting · oldest X days" linking to the queue; the Membership nav item carries the count.
3. `/admin/audit` shows `member_change_approval_setting_changed { previous, next }` for each flip.

## 2. Automated proof

```bash
# unit + contract (fast)
pnpm vitest run tests/unit/members/change-requests tests/contract/portal/change-requests-submit.test.ts tests/contract/members/admin-change-requests-decide.test.ts
# integration — pass FILE PATHS, never "-- <pattern>" (that runs the whole 40-min suite)
pnpm test:integration tests/integration/members/change-requests-tenant-isolation.test.ts
pnpm test:integration tests/integration/members/change-requests-concurrency.test.ts
pnpm test:integration tests/integration/members/change-requests-decide-rollback.test.ts
pnpm test:integration tests/integration/members/change-requests-erasure-scrub.test.ts   # PR-2 (T070) — does not exist yet
# e2e (local only, workers=1 mandatory) — ≤ 10-min foreground chunks
pnpm test:e2e --grep "@change-requests" --workers=1
pnpm test:e2e --grep "@a11y" --workers=1
# gates before the PR
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm check:fixme && pnpm check:audit-events && pnpm check:multi-tenant && pnpm check:staff-page-guard && pnpm check:api-route-guard && pnpm check:actor-role-truth && pnpm check:env-example
```

Expected: tenant-isolation test creates two tenants, submits in each, and proves zero cross-tenant
reads/decides in both directions (SC-009); concurrency test shows exactly one pending after ×50
same-submitter submits and exactly one decision after ×2 concurrent decides; rollback test leaves the
request pending and the member row untouched when the contact write throws; erasure test finds no
non-sentinel value in `member_change_request_fields` after `eraseMember`.

## 3. Cutover (prod)

### Pre-flip gates (PR-1 review round 1 — each one MUST be merged before step 2)

Everything in PR-1 ships dark, and on this repo setting the env var IS the deploy. These are
not "nice to have before launch"; each converts a documented deferral into a live defect the
moment the flag is set:

| Gate | Why it blocks | Closes in |
|---|---|---|
| **T078 + T070** — the FR-030 erasure scrub adapter wired into `eraseMember` (+ its live-Neon test + table-scoped guard) | Until it merges, `member_change_request_fields.seen_value` / `proposed_value` and `member_change_requests.decision_reason` / `decision_note` are OUTSIDE the GDPR Art. 17 / PDPA §33 path — an erasure leaves the subject's proposed name / phone / addresses and the reviewer's reason intact. The `ChangeRequestScrubPort` exists; nothing implements or calls it. Also cancel pending outbox rows of the two new `notification_type`s by `context_data->>'memberId'`, not only by `to_email`. Note for the RoPA / erasure runbook: a remembered `Idempotency-Key` response on `POST /api/portal/change-requests` carries the serialised request view (proposed values) for the record's 24 h TTL; the scrub does not reach it, so an erasure completes fully only after that window — document it, or purge the tenant's keys in the adapter. | PR-2 (US4) |
| **T087** — the durable 10 / 24 h cap + 1 h staff-email coalescing | PR-1 carries an interim Upstash cap (10 / 24 h per tenant + user) on `POST /api/portal/change-requests`, but no coalescing: every submit still fans one email out per reviewer. | PR-2 (US5) |
| **T102** — the pending-count / oldest-age gauges | FR-037's > 7 d warning / > 14 d page alerts cannot fire until the gauges have a caller. | PR-3 (US6) |
| **T072 / T074** — the real queue (filters, cursor paging, overdue flag) | The PR-1 `/admin/change-requests` page lists 50 pending rows with no paging; row 51 is invisible. | PR-2 (US4) |
| e2e `tests/e2e/change-requests.spec.ts` green on every Playwright project with the flag ON | **Run 2026-09-11 on chromium + mobile-safari: 8 passed, 1 skipped** (the secondary-contact case waits for an `E2E_MEMBER_SECONDARY_*` persona — research § V4). Five fixture defects fixed on the way (staff sessions probing the member gate, the `page.request` POST without an Origin, the required-mark label, a pre-hydration click, the dialog-focus assertion) and ONE product defect: Base UI's Checkbox renders `disabled` as `data-disabled` only, so a manager's read-only row carried no `aria-disabled` (fixed). Note for anyone re-running locally: the dev roster must be sane — the shared `dev` branch had 3,774 leaked `createActiveTestUser` admins and every submit fanned one outbox row out to each (a 3-minute transaction); they are now `disabled`. | before flip (re-run on the release branch) |
| `TENANT_PRIVACY_POLICY_URL` set in Vercel | The FR-010 privacy link on the portal form hides when the variable is unset (review round 1, UX Critical: a dead `/privacy` link); with it unset the member is asked to propose PII changes with no link to the policy — PDPA §23 notice. | before flip (operator) |
| Command-palette entry for `/admin/change-requests` (the navigate registry in `src/modules/plans/application/search-plans.ts`) | The queue is reachable from the Membership nav (round 1, UX I7) but not from the palette; staff who live in it will not find the queue. | PR-2 UX pass |

1. Merge → prod auto-migrates 0300 and 0301 on deploy (`vercel-build`); `pnpm db:verify:prod`.
2. Set `FEATURE_MEMBER_CHANGE_APPROVAL=true` in Vercel **only when ready to redeploy immediately**
   (setting the env var IS the flip on this repo — no `ignoreCommand`) **and only after every
   pre-flip gate above is merged**.
3. Update the record of processing (RoPA) entry for member data with the new purpose ("review of
   member-proposed changes; accountable history") and the new disclosure (staff notification
   emails) — FR-040 makes this a precondition of the switch.
4. Switch the tenant setting ON. Until US6 / PR-3 ships the audited admin card (T098 / T099,
   `/admin/settings/member-changes`) this is one SQL statement on
   `tenant_member_settings.member_change_approval_enabled` (the e2e seed's
   `ensureApprovalSetting` is the reference) — record who ran it and when in `reviews/cutover.md`,
   since no `member_change_approval_setting_changed` audit row exists yet. Before that moment the
   portal behaves exactly as before.
5. First-submission observation: one real member submits → confirm the staff email arrives, the
   queue shows it, the dashboard count is 1, and `SELECT count(*) FROM member_change_requests
   WHERE state = 'pending'` for the tenant is 1 (the `members_change_requests_pending_count` gauge
   has no emitter until T102 / PR-3). Record the observation in `reviews/cutover.md`.

### Rollback matrix (FR-039)

| Layer | Action | Pending rows | Portal | Nav / dashboard | `PATCH /api/portal/profile` | Time |
|---|---|---|---|---|---|---|
| 1 — tenant setting OFF | SQL on `tenant_member_settings.member_change_approval_enabled` until PR-3 ships the audited admin card (T098 / T099) | kept, still decidable | no new requests; existing pending banner stays | count stays while rows pending | Group B saves immediately again | seconds |
| 2 — platform flag OFF | remove `FEATURE_MEMBER_CHANGE_APPROVAL` in Vercel + redeploy | kept untouched, decidable again when the flag returns; **queued outbox rows** of the two F114 types stay `pending` — the dispatcher filters them at query time while the flag is off (the F4 R7-B4 precedent) and drains them when it returns | no pending/decision state shown | hidden | widened back to today's field set | one deploy |
| 3 — code revert | revert the PR | kept (see below) | — | — | — | one deploy |

**Unflagged and live on merge** — none of the layers above undoes these (re-derived from the
final tree after review rounds 1–3; the review rounds themselves added the last four):

- migration `0300` (two tables, `outcome_acknowledged_at`, the `tenant_member_settings` column) and
  the seven enum values in `0301` (`ADD VALUE` is irreversible);
- the `ReasonConfirmationDialog` promotion to `components/shell/` (the old path re-exports), the nav
  item type's optional `badgeCount` slot, and the relocation of the contact's language setting to
  the account page (save semantics unchanged);
- **GDPR Art. 15 / PDPA §30 audit subset** (`isInMemberAuditSubset` + the SQL arm in
  `gdpr-audit-subset-repo.ts`) now matches `payload->>'related_member_id'` — every member's DSAR
  export gains the rows keyed that way, including pre-existing `auto_email_skipped_no_recipient`
  and marketing opt-out rows. A correct fix (review privacy I-3); tell the DPO;
- **`ConfirmationDialog`** wraps every non-empty body in a bounded, scrollable `space-y-4` container
  (review UX I2) — the 3 existing dialogs that pass children gain vertical spacing + nested scroll
  on short viewports (the 9 self-closing call sites are untouched);
- **`member_self_update_forbidden`** (the forged-edit audit on `PATCH /api/portal/profile`, both
  gates) carries `refusal: 'gate_narrowed' | 'forged'` and a BOUNDED `attempted_fields` (20 keys ×
  64 chars, `attempted_fields_truncated`) — on the flag-OFF path the `summary` prefix is unchanged
  (`forged fields: …`), so a dashboard keyed on it does not drift; what changed is the payload
  shape and the bound (review privacy I-5 / M-7);
- the portal timeline route / page / recent-activity resolve the viewer's own contact (one extra
  `contactRepo.listByMember` per render — perf only); `MembersDeps` gains three members; the
  `verify-schema` + `check-multi-tenant-ready` canaries; the test-tenant helper deletes the new
  tables.

Rolling any of these back is a new migration / code change, not a flag flip.

## 4. Watch after cutover

- `members.change_request_oldest_age_seconds` — warning at 7 d, page at 14 d (FR-037).
- `email_dispatch_failed` audit rows with `notification_type` starting `member_change_request_`.
- `member_self_update_forbidden` spikes (a client still posting Group B keys to `/api/portal/profile`).
