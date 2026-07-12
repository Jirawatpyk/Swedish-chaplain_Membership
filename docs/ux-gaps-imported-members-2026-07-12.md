# UX Gap Register — Imported-Member Class & Broader (2026-07-12)

**Source:** adversarial UX-gap sweep (8 finder angles → per-candidate verify) over member-management, renewals, invoicing, portal, directory surfaces. 32 candidates → **28 CONFIRMED**, 0 plausible, 4 refuted.

**Why:** after fixing the unlinked-contact email-edit gap (PR #186), swept for other gaps of the same class — operations that reject/degrade for **imported members** (unlinked contacts, no portal user, no invoice/payment, no tax_id, no consent) and code/UI that contradicts its own comment or promise.

**Status legend:** `[ ]` open · `[x]` fixed. Each finding below carries its own checkbox.

## Remediation plan (grouped)

| # | Theme | Findings (by title/angle) | Target PR | Status |
|---|-------|---------------------------|-----------|--------|
| 1 | **Contact email edit — UI still blocks it** (dialog disables email + note contradicts the shipped backend) | comment-vs-code + unlinked-ops (contact-form-dialog) | **PR #186** | ✅ done — email field editable for unlinked contacts, sent in PATCH; linked read-only w/ corrected note; G1/G-dialog fixed |
| 2 | **At-risk scoring wrong for whole imported cohort** (zero in-system engagement = +50; tenure from `created_at` not `registration_date`) | imported-data-shape ×2 | follow-up: launch-critical | open |
| 3 | **Portal invite lifecycle dead-end** (expired invite → false "Portal linked", no re-invite path) | unlinked-ops + lifecycle | follow-up: launch-critical | open |
| 4 | **Archived/undelete breaks renewal tracking** (undelete doesn't restore cycle; "Renew" shown on archived always fails; lapsed dashboard dead-end) | lifecycle ×3 | follow-up: launch-critical | open |
| 5 | **Invoicing a bare imported member** (auto-email silently skipped but "success"; raw error-code dumps when plan-year/settings/tax_id missing) | invoicing-renewals ×4 | follow-up: launch-critical | open |
| 6 | **Raw / untranslated errors to users** (server English `error.message`, dev strings, a leaked member UUID; TH/SV see English) — ~11 spots, same fix pattern | error-map-ux + i18n-copy | polish PR | open |
| 7 | **"No data" shown when the read actually FAILED** (admin renewal card + timeline) | empty-disabled-states ×2 | polish PR | open |
| 8 | **Dead / wrong docstrings** (tax_id gate removed but doc'd; manager-disabled vs hidden) | comment-vs-code ×2 | polish PR | open |

> Findings are listed below sorted by verified severity then angle (G1…G28). The `Angle` tag on each maps it to a theme above.

---

## Findings (28)

### G1. Contact Edit dialog hard-disables email + docstring falsely claims an unlinked contact "must be invited to the portal first" — no UI path to fix a secondary imported contact's email
- **Severity:** 🟠 MED · **Angle:** comment-vs-code
- **Where:** `members/contact-form-dialog.tsx:12`
- **Trigger:** An imported member has an unlinked (linked_user_id = NULL) SECONDARY contact whose email was typo'd on import. An admin opens the per-contact "Edit" dialog (ContactActions → ContactFormDialog, mode="edit") to correct it.
- **Wrong:** The email field is rendered `disabled={mode === 'edit'}` (line 331) and the edit branch builds a `patch` that deliberately excludes `email` (lines 210-222), so the dialog can never change an email. The docstring justifies this by claiming "an unlinked contact must be invited to the portal first" — but the member Edit form (edit-member-client.tsx) only edits the PRIMARY contact, so a secondary unlinked contact's email is editable NOWHERE in the UI. The docstring's stated reason is also false: the shipped `updateUnlinkedContactEmail` use-case updates an unlinked contact's email in place, and edit-member-client.tsx step 3 (lines 314-324) already uses exactly that path for the primary contact ('an unlinked contact (e.g. imported members) is updated in place').
- **Expected:** Because the PATCH route + `updateUnlinkedContactEmail` now update an unlinked contact's email in place, the dialog should allow editing an unlinked contact's email (or the docstring should stop asserting the contact must be portal-invited first). As shipped, an admin hits a dead end when fixing a typo on an imported member's secondary contact email, and the docstring contradicts the actual system capability.
- **Fix:** In edit mode, enable the email field (at least when the contact is unlinked) and add email to the PATCH patch — the route already updates unlinked emails in place; also correct the docstring and en.json emailEditNote to drop the false "must be invited to the portal first" assertion.
- [ ] fixed

### G2. Bulk action bar surfaces the raw English server message (untranslated + leaks a member UUID) instead of a mapped, localized message
- **Severity:** 🟠 MED · **Angle:** error-map-ux
- **Where:** `_components/bulk-action-bar.tsx:116`
- **Trigger:** A TH/SV admin runs a bulk archive where one selected member is already archived (or another state conflict). Server returns 409 { error.code: 'state_error', message: `State transition failed for member <uuid>.` }.
- **Wrong:** Only 429 is mapped; every other non-ok status falls to `toast.error(body.error?.message ?? t('unknownError'))`, which prints the server's raw English string verbatim. For state_error that string embeds a raw member UUID (bulk/route.ts:376) — a dev-facing message shown to the admin, in English regardless of the admin's locale. not_found/plan_not_found/bulk_cap_exceeded/invalid_body are likewise never mapped to localized copy.
- **Expected:** Branch on body.error.code and render localized messages (e.g. 'One or more selected members can't be archived — they may already be archived'), never the raw server string. The `t('unknownError')` fallback is effectively dead because the server always includes a message.
- **Fix:** In bulk-action-bar.tsx branch on body.error.code (state_error/not_found/plan_not_found/bulk_cap_exceeded/invalid_body) to localized copy (e.g. "One or more selected members are already archived") instead of falling through to the raw server message.
- [ ] fixed

### G3. Admin member-lifecycle failure toasts (archive / erase / undelete / bulk / inline status) render the server's hardcoded English error.message instead of the localised fallback
- **Severity:** 🟠 MED · **Angle:** i18n-copy
- **Where:** `members/archive-member-button.tsx:78`
- **Trigger:** A Thai/Swedish admin performs a lifecycle action on an imported member and the route returns a non-ok body — e.g. archiving a member a concurrent session already archived (route returns 409 { message:'Member is already archived.' }), a 404 ('Member not found.'), or a 500 ('Internal server error.').
- **Wrong:** `toast.error(data.error?.message ?? t('archiveError'))` prefers the server's raw English message over the localised t('archiveError'); since the routes ALWAYS include an English message, the localised fallback is effectively dead code and TH/SV admins see English. The same pattern repeats at erase-member-button.tsx:178, archived-banner.tsx:77 (undelete), bulk-action-bar.tsx:116, and members-table.tsx:352 (fed by directory-with-bulk.tsx:85 inline status toggle) — the exact operations run on imported members.
- **Expected:** Client toasts should map the response's error.code to a localised message and never display the server's English error.message. (The team already knows this risk — benefits/page.tsx:95 comments "Use the discriminant code, not error.message — a raw repo message can [leak]".)
- **Fix:** Replace `error.message ?? t(...)` with a `error.code`→localised-message lookup (map known codes like state_error/not_found/server_error to i18n keys), defaulting to the generic localised `t(...Error)`; never render the server's raw message. Apply at archive-member-button:78, erase-member-button:178, archived-banner:77, bulk-action-bar:116, directory-with-bulk:85.
- [ ] fixed

### G4. Snooze/Outreach at-risk dialogs pass a non-existent next-intl `fallback` option, so unmapped route codes render a raw i18n key path in the toast
- **Severity:** 🟠 MED · **Angle:** i18n-copy
- **Where:** `_components/snooze-dialog.tsx:73`
- **Trigger:** The renewals feature flag is off (or a server-side body rejection occurs) while the snooze/outreach dialog is submitted: the route returns { error: { code: 'feature_disabled' } } (503) or { code: 'invalid_body' } — codes that have NO key under admin.renewals.atRisk.snooze.toast.error.* (present keys: server_error, invalid_input, member_not_found) or ...outreach.toast.error.* (present: server_error, invalid_input).
- **Wrong:** The code calls `t(`toast.error.${code}`, { fallback: t('toast.error.server_error') })`. next-intl's t(key, values) has no `fallback` option — the object is treated as ICU interpolation values and ignored. With no custom onError/getMessageFallback configured (i18n/request.ts), a missing key falls back to next-intl's default: the raw dotted key path. So the toast description shows literal text like "admin.renewals.atRisk.snooze.toast.error.feature_disabled" instead of a readable message. Same bug at outreach-dialog.tsx:107.
- **Expected:** Guard with t.has(`toast.error.${code}`) (as done elsewhere in the codebase) and fall back to t('toast.error.server_error') when absent, OR add feature_disabled/invalid_body keys — so an unmapped code degrades to real localised copy, never a raw key path.
- **Fix:** Guard with t.has: `t.has(`toast.error.${code}`) ? t(`toast.error.${code}`) : t('toast.error.server_error')` at snooze-dialog.tsx:73 and outreach-dialog.tsx:107 (next-intl has no `fallback` option), and/or add feature_disabled/invalid_body/no_session/forbidden keys under each toast.error namespace.
- [ ] fixed

### G5. At-risk scorer flags healthy imported members as "at-risk": zero in-system engagement fires +50 risk points
- **Severity:** 🟠 MED · **Angle:** imported-data-shape
- **Where:** `domain/at-risk-score.ts:300`
- **Trigger:** An imported corporate member whose plan grants e-blast/event/cultural benefits, ~30 days after import (once created_at-based tenure passes the 30-day min-tenure gate). They were never onboarded to the portal, so in-system usage is zero: eBlastQuotaPctUsed=0, eventsAttendedLast12Months=0, culturalTicketQuotaPctUsed=0.
- **Wrong:** computeAtRiskScore fires e_blast_quota_under_30pct (+15, line 300-305), events_attended_last_12mo_zero (+25, line 272-276) and cultural_ticket_quota_under_50pct (+10, line 288-293) = ~50/100, pushing a paid-up long-standing member into an elevated risk band. The scorer gathers these zeros from empty F4/F6/F7 data in drizzle-at-risk-scorer.ts (eblast usedCount defaults 0 → pct 0 at lines 385-389; events filter length 0 at lines 437-444). The whole imported cohort (the launch reality) reads as low-engagement/at-risk.
- **Expected:** A member with NO pre-import engagement history should not be auto-classified as at-risk purely because their historical activity predates the system. Note the payment factor is correctly skipped when daysSinceLastPayment is undefined (no in-system payment) — but the eblast/event/cultural factors treat 'no data' as '0% used' and penalize it, which is the opposite (mis-flagging) handling.
- **Fix:** For engagement factors (eblast/events/cultural), treat 'no in-system history yet' like the payment factor treats undefined — skip (pass undefined, contributing 0) for members whose in-system observation window (created_at / first onboarding) is shorter than one full quota year, instead of scoring their pre-import zero usage as disengagement.
- [ ] fixed

### G6. At-risk tenure gate uses members.created_at (import timestamp), not registration_date — wrong for the entire imported cohort
- **Severity:** 🟠 MED · **Angle:** imported-data-shape
- **Where:** `drizzle/drizzle-at-risk-scorer.ts:167`
- **Trigger:** Any imported member. import-members.ts inserts the members row WITHOUT setting created_at (DB default now()) — see scripts/import-members.ts:278-295 — so created_at = the import instant while registration_date holds the real historical date (e.g. 2015).
- **Wrong:** tenureDays is computed from memberRow.createdAt (line 167-173), so a member who joined a decade ago reads as ~0-day tenure. The FR-035 min-tenure gate (at-risk-score.ts:240-254) then SKIPS scoring for every imported member for the first 30 days after import, and thereafter treats long-standing members as brand-new. The scorer's own docblock calls created_at a 'tenure proxy' (line 20) — false for the imported cohort.
- **Expected:** Tenure should derive from registration_date (the real membership start), not the row-insert timestamp, so the min-tenure gate and any tenure-sensitive logic reflect the member's true standing.
- **Fix:** Derive tenureDays from members.registration_date (e.g. COALESCE(registration_date, created_at)) instead of created_at in both drizzle-at-risk-scorer.ts:167 and the batch gather feeding recompute-at-risk-scores-batch.ts:185.
- [ ] fixed

### G7. Renewing an imported member with an unseeded plan-year (or archived member) shows "please try again" for a permanently-failing action
- **Severity:** 🟠 MED · **Angle:** invoicing-renewals
- **Where:** `use-cases/mark-paid-offline.ts:541`
- **Trigger:** Admin opens an imported member's renewal cycle (created at import) and clicks Mark paid offline, but the member's plan_id_at_cycle_start + deriveFiscalYear(periodFrom) has no membership_plans row (or the row is soft-deleted), or the member was archived after import. The F4 createInvoiceDraft returns plan_not_found / settings_missing / member_archived.
- **Wrong:** The bridge returns kind:'create_invoice_failed' (f4-invoice-bridge.ts:166-170), mark-paid-offline maps every non-record_payment failure to kind:'f4_failure' (mark-paid-offline.ts:541-546), the route returns 502 f4_failure with the real reason scrubbed (route.ts:176-202), and CycleAdminActions surfaces t('markPaidOffline.error.f4_failure') = "The invoice could not be created. The cycle was left as-is — please try again." (en.json:3286). The admin retries repeatedly; the cause (missing catalogue plan-year / archived member) is a permanent config gap, so every retry fails identically with no hint what to fix.
- **Expected:** Distinguish non-transient causes (plan_not_found → "this member's plan/year is not in the fee catalogue — add it first"; member_archived → "restore the member first") from genuinely transient F4 faults, instead of a blanket "please try again" that guarantees a doomed retry loop.
- **Fix:** In mark-paid-offline.ts:541-546 branch on bridgeResult.error.reason (the F4 code) to emit distinct route error codes for plan_not_found / member_archived / settings_missing / member_not_found, each with actionable i18n copy (seed the plan-year, restore the member, configure invoice settings) instead of the blanket transient-sounding f4_failure "please try again".
- [ ] fixed

### G8. New membership invoice draft fails with a raw "Error code: plan_not_found" dump for a freshly-imported member
- **Severity:** 🟠 MED · **Angle:** invoicing-renewals
- **Where:** `_components/invoice-form.tsx:294`
- **Trigger:** Admin picks an imported member on /admin/invoices/new and submits. planYear is derived from the member's F3 record (selectedMember.currentPlanYear); createInvoiceDraft calls getAnnualFeeSatang(tenant, planId, planYear) which returns null when that (tenant,plan,year) row is absent or soft-deleted → CreateInvoiceDraftError 'plan_not_found' (also 'settings_missing' before invoice settings exist, 'member_archived' on a race).
- **Wrong:** The catch shows toast.error(t('errors.create_failed'), { description: t('errors.codeFallback', { code }) }) = "Could not create draft / Error code: plan_not_found". admin.invoices.form.errors (en.json:2113-2117) only defines create_failed, codeFallback, unknown — no human copy for plan_not_found / settings_missing / member_archived, so the admin sees a raw internal code with no guidance on what to fix.
- **Expected:** Map the create-draft error codes reachable for imported members to actionable copy (e.g. "This member's plan for {year} isn't set up in the fee catalogue yet — add the plan-year before invoicing"), not a raw "Error code: …" fallback.
- **Fix:** Add en.json admin.invoices.form.errors keys for plan_not_found / settings_missing / member_archived / member_not_found with actionable copy (e.g. "This member's plan for {year} isn't in the fee catalogue yet — add the plan-year before invoicing") and switch the invoice-form catch to look them up by code, falling back to codeFallback only for truly unknown codes.
- [ ] fixed

### G9. Irreversible §86/4 issue dialog dumps a raw error code for almost every failure
- **Severity:** 🟠 MED · **Angle:** invoicing-renewals
- **Where:** `_components/issue-error-routing.ts:33`
- **Trigger:** Admin issues a membership invoice/bill for an imported member and the server rejects with any code other than invoice_already_issued, event_no_tin_requires_paid_issue, or registration_refunded — e.g. settings_missing, member_archived, no_buyer_snapshot, invalid_lines, overflow, pdf_render_failed, blob_upload_failed.
- **Wrong:** DEDICATED_MESSAGE_CODES contains only event_no_tin_requires_paid_issue and registration_refunded (issue-error-routing.ts:33-36); every other code falls to { messageKey:'errors.codeFallback', codeArg:code }, and IssueInvoiceForm renders t('errors.codeFallback', { code }) = "Error code: settings_missing" etc. as the focused inline alert (issue-invoice-form.tsx:262-264). On the one irreversible tax-document path the admin gets a raw internal code instead of an explanation.
- **Expected:** Give operator-actionable inline copy for the reachable issue failures (settings_missing → "configure invoice settings first"; member_archived → "restore the member first"; infra faults → "temporary problem, retry"), reserving codeFallback for truly unexpected codes.
- **Fix:** Add dedicated i18n keys + DEDICATED_MESSAGE_CODES entries for the reachable business rejects (settings_missing→"configure invoice settings first", member_archived→"restore the member", no_buyer_snapshot/invalid_lines→actionable copy) and a generic "temporary problem, retry" for infra faults (pdf_render_failed/blob_upload_failed/overflow); reserve codeFallback for genuinely unexpected codes.
- [ ] fixed

### G10. Invoice/receipt auto-email is silently skipped for an imported member with no contact email, but the admin is told it succeeded
- **Severity:** 🟠 MED · **Angle:** invoicing-renewals
- **Where:** `use-cases/record-payment.ts:1015`
- **Trigger:** Admin issues or records payment on a membership invoice for an imported member whose buyer snapshot has an empty primary_contact_email (imported members may have no email / were never invited or verified).
- **Wrong:** recordPayment enqueues no receipt email and only logs a warn + bumps a metric when recipientEmail is null (record-payment.ts:1015-1031); issueInvoice's enqueueInvoiceAutoEmail likewise skips-with-warn on an empty buyer email (issue-invoice.ts:807-828). The API returns success with no email-status field, and PaymentForm/IssueInvoiceForm fire toast.success(...) unconditionally (payment-form.tsx:164-170, issue-invoice-form.tsx:278). The admin believes the member was emailed their invoice/tax receipt when nothing was sent.
- **Expected:** Return an email-dispatch outcome and surface it in the success toast (e.g. "Receipt issued — no email on file, not sent") so the admin knows to deliver the document another way, instead of a success message that implies delivery.
- **Fix:** Have /api/invoices/[id]/pay and the issue endpoint return an emailDispatch outcome (sent | skipped_no_email | disabled), and branch the client toast to append a warning line like "No email on file — not sent; deliver manually" when skipped, instead of an unqualified success.
- [ ] fixed

### G11. Expired-but-unaccepted portal invitation makes an imported contact falsely display "Portal linked"
- **Severity:** 🟠 MED · **Angle:** lifecycle-transitions
- **Where:** `[memberId]/page.tsx:357`
- **Trigger:** Admin invites an imported contact (linked_user_id is NULL → set at invite time). The member never accepts within the 7-day window. Admin reopens the member detail page on day 8+.
- **Wrong:** The contact shows a secondary "Portal linked" badge, implying an active portal account. In reality the invited user is still `pending` and never signed in. This happens because `invitePortal` sets `contacts.linked_user_id` at INVITE time (invite-portal.ts:135-137), while `findPendingInvitationsForMember` filters out expired rows (`gt(invitations.expiresAt, NOW())` + `isNull(consumedAt)`, drizzle-member-repo.ts:1273-1274). Once the invite expires, `pendingInvitation` becomes undefined, so the guard `contact.linkedUserId && !pendingInvitation` (page.tsx:357-359) resolves TRUE and renders "Portal linked". No badge represents "invite expired, never accepted."
- **Expected:** After an invitation expires unaccepted, the contact should NOT read "Portal linked" — it should show an "Invitation expired" (or still-pending) state prompting a re-invite, since `linked_user_id` alone does not mean the account was activated.
- **Fix:** Badge should reflect account activation state, not mere linked_user_id: derive "Portal linked" only when the linked user is active/consumed, and show an "Invitation expired" state (with a re-invite/resend affordance) when a linked contact has an unconsumed, past-expiry invitation.
- [ ] fixed

### G12. Unarchiving a member never restores the renewal cycle that archiving cancelled, silently removing them from renewal tracking
- **Severity:** 🟠 MED · **Angle:** lifecycle-transitions
- **Where:** `use-cases/undelete-member.ts:97`
- **Trigger:** Admin archives an imported member (bulk or single) then unarchives them within the 90-day window.
- **Wrong:** Archiving runs `cancelInFlightCyclesForMember`, transitioning the member's only active cycle to terminal `cancelled` (cancel-in-flight-cycles-for-member.ts:346-356). `undeleteMember` only flips `status: archived→active` and clears `archived_at` (undelete-member.ts:97-101); it does NOT recreate the cycle. The restored member is `active` but their most-recent cycle is terminal `cancelled`, so they are excluded from the renewal pipeline (no `cancelled` urgency bucket) and receive no reminders. If the cancelled cycle's `expiresAt` has passed, `isMembershipLapsed` returns true and they also render a "Lapsed" badge across directory/portal despite being freshly restored. The undelete docstring documents the session + invitation asymmetry but is silent on the renewal cycle.
- **Expected:** Undelete should either recreate/restore an active renewal cycle (re-entering the pipeline) or clearly surface that the admin must click "Renew / reactivate" to restore renewal tracking. A restored active member should not be silently dropped from renewal reminders.
- **Fix:** In undeleteMember, reverse the archive cascade — recreate/restore an active renewal cycle so the member re-enters the pipeline, or surface a clear "renewal tracking not restored — click Renew/Reactivate" prompt on member detail after undelete instead of silently leaving the cycle 'cancelled'.
- [ ] fixed

### G13. "Renew / reactivate this member" button is shown for archived members but the server always rejects it
- **Severity:** 🟠 MED · **Angle:** lifecycle-transitions
- **Where:** `[memberId]/page.tsx:722`
- **Trigger:** Admin opens the detail page of an archived member (archive cancelled their cycle → status `cancelled`, so `isLapsed(status)` is true).
- **Wrong:** `canModify = canWrite && !isErased` (page.tsx:722) is NOT gated on archived status, and it is passed as `canRenew` to `MemberRenewalHealthSection` (page.tsx:1070,1088). The card renders the RenewLapsedMemberDialog whenever `canRenew && isLapsed(status)` (renewal-health-card.tsx:130), and `isLapsed` returns true for `cancelled`/`null` (renewal-health-card.tsx:69-76). So an archived member shows an enabled "Renew / reactivate this member" button — right next to the "Archived" banner. Clicking through the confirmation dialog always fails: `adminRenewLapsedMember` rejects with `member_archived` (admin-renew-lapsed-member.ts:201). The comment there even notes "the renew-lapsed UI affordance is NOT gated on archive status." The admin only learns it's impossible after confirming.
- **Expected:** The Renew/reactivate affordance should be hidden (or disabled with an inline "Restore member first" hint) for archived members, matching the Archive/Edit buttons which do check `member.status !== 'archived'`.
- **Fix:** Gate the renew affordance on archived status: pass `canRenew={canModify && member.status !== 'archived'}` (or hide/disable the RenewLapsedMemberDialog trigger with a "Restore member first" hint) so it matches the Archive/Edit gates.
- [ ] fixed

### G14. Expired portal invite for an imported member becomes an un-recoverable dead end: contact shows "Portal linked", invite button is hidden, only a wrong-purpose "Re-send verification email" action remains
- **Severity:** 🟠 MED · **Angle:** unlinked-ops
- **Where:** `[memberId]/page.tsx:327`
- **Trigger:** Admin invites an imported member's (unlinked) contact via "Invite to portal". invitePortal sets contacts.linked_user_id to a NEW pending F1 user + 7-day invitation token. The member never accepts within 7 days, so the invitation row is consumed_at IS NULL AND expires_at < NOW(). Admin reopens the member detail page.
- **Wrong:** The contact now has linked_user_id set (to a never-activated pending user). findPendingInvitationsForMember filters `gt(invitations.expiresAt, NOW())` (drizzle-member-repo.ts:1274) so the expired invite is dropped from the pending set → the amber "Expires in N days" badge disappears and the contact instead renders the misleading `portal.linked` "Portal linked" badge (page.tsx:357-359), implying an active portal account that does not exist. The re-invite affordances are all unreachable: InvitePortalButton is gated on `!contact.linkedUserId` (page.tsx:327 canInvite) → HIDDEN; ResendBouncedInviteButton requires `contact.inviteBouncedAt` (page.tsx:422) which is null (the invite lapsed, it did not bounce) → HIDDEN. The ONLY visible action is ResendVerificationButton (gated on `linkedUserId && verificationPending`, page.tsx:430; the pending user's email is unverified so resolveContactVerification marks it pending). Clicking it runs resendVerificationEmail, which passes its eligibility gate (linkedUserId set, not removed, email unverified) and sends an `email_verification_resent` "verify your new email address" message — the wrong email; it issues a 24h verification token, NOT an invitation/set-password link, so the member still cannot activate their portal account. There is no UI path to re-issue the invitation.
- **Expected:** A contact whose invitation expired unaccepted must remain re-invitable: either keep showing an "Invite expired — re-send invitation" state that re-issues the invitation (set-password link), or surface the InvitePortalButton / ResendBouncedInviteButton for the lapsed-invite case. The "Portal linked" badge should only appear for contacts whose invitation was actually consumed (active portal account), not for pending/expired invitations.
- **Fix:** Gate the "Portal linked" badge on the linked user actually being active/consumed (not status='pending'), and add a "Invite expired — re-send" affordance for a linked-but-pending/expired contact that calls reissue-invitation, instead of relying on inviteBouncedAt or verificationPending (both false for a plain lapse).
- [ ] fixed

### G15. No way to correct a secondary contact's email for imported members: the edit dialog disables the email field and its note misdirects to a page that can't do it (and contradicts the shipped in-place unlinked-email update)
- **Severity:** 🟠 MED · **Angle:** unlinked-ops
- **Where:** `members/contact-form-dialog.tsx:331`
- **Trigger:** An imported member has a secondary (non-primary) contact whose email was mistyped in the source spreadsheet. The contact is unlinked (linked_user_id NULL). Admin opens the per-contact Edit dialog to fix the email.
- **Wrong:** The email input is hard-disabled on edit (`disabled={mode === 'edit'}`, line 331) and the dialog never sends an `email` field on PATCH (lines 210-222 only diff name/phone/role/language). The accompanying note (line 344, i18n `emailEditNote`) tells the admin: "To change this contact's email, edit it on the member Edit page. An unlinked contact must be invited to the portal first." Both instructions are wrong: (1) the member Edit page only ever loads and PATCHes the PRIMARY contact (edit/page.tsx:87 `contacts.find(c => c.isPrimary)`, passed as `primaryContact` at :195; edit-member-client.tsx wires only that one contact's email at step 3, line 314) — it has no field for a secondary contact, so following the instruction leads nowhere; (2) "must be invited to the portal first" directly contradicts the now-shipped backend (`updateUnlinkedContactEmail`, the fix for the earlier 409 not_supported gap), which updates an unlinked contact's email in place with no portal invitation required. Net result: for a secondary unlinked contact there is no UI path to correct the email except the lossy remove-and-re-add workaround.
- **Expected:** The edit dialog should allow editing an unlinked contact's email in place (routing to the same PATCH → updateUnlinkedContactEmail path the primary-contact edit now uses), for both primary and secondary contacts. If email edit is intentionally deferred, the note must not point to a page that cannot perform it, and must not claim a portal invitation is a prerequisite.
- **Fix:** In contact-form-dialog.tsx drop `disabled={mode==='edit'}`, include an `email` diff in the edit PATCH (routes to updateUnlinkedContactEmail / changeContactEmail server-side), and delete/rewrite the stale emailEditNote (en.json:1400) and the top-of-file docstring that falsely require a portal invitation.
- [ ] fixed

### G16. member-identity port/adapter docstrings promise a "company members MUST carry a tax_id" issuance gate that the code no longer implements (gate was removed); memberTypeScope is dead data
- **Severity:** ⚪ LOW · **Angle:** comment-vs-code
- **Where:** `ports/member-identity-port.ts:16`
- **Trigger:** Reading the port contract (or the adapter comment) while an imported company member without a tax_id (common at launch) has a §86/4 tax invoice issued.
- **Wrong:** The `MemberIdentityView.memberTypeScope` docstring states: "`'company'` members MUST carry a tax_id to be issued a Thai tax invoice (FR-009a / Revenue Code §86) ... The gate fires ONLY on an explicit `'company'` scope", and the adapter comment (member-identity-adapter.ts:38-39) says it LEFT JOINs the plan "so issue-invoice can require a tax_id on company tax invoices." No such gate exists: it was deliberately removed (issue-invoice.ts:407-446, auditor ruling 2026-06-12: 'MEMBERSHIP + no TIN → ... NOT blocked'; create-event-invoice-draft.ts:238 'tax_id_required gate is therefore REMOVED'). `memberTypeScope` is read into the view but never consulted to block issuance — the promised behavior is unimplemented.
- **Expected:** The docstrings should describe the actual (correct) behavior — a membership invoice is issued regardless of whether a company buyer has a tax_id (the TIN line is simply omitted). As written, a maintainer trusting the contract would believe a company-tax_id gate exists (and might reintroduce the removed block, re-breaking issuance for imported no-tax_id members) or rely on `memberTypeScope`, which is now dead.
- **Fix:** (see finding)
- [ ] fixed

### G17. member-invoices-section docstring says manager mutating actions are "rendered disabled with a tooltip," but the New-invoice affordances are hidden with no explanation
- **Severity:** ⚪ LOW · **Angle:** comment-vs-code
- **Where:** `_components/member-invoices-section.tsx:19`
- **Trigger:** A read-only `manager` opens the detail page of an imported member that has zero invoices.
- **Wrong:** The RBAC docstring promises "`manager` — list only; mutating actions rendered disabled with a tooltip explaining the role constraint." The per-row Record Payment / Void / Issue-CN actions do follow that (ManagerDisabledAction), but the header "New invoice" CTA (`canMutate && total > 0`, line 236) and the empty-state "create invoice" CTA (gated on `canMutate`, lines 271-274) are simply HIDDEN for managers — no disabled control, no tooltip. A manager viewing a zero-invoice imported member sees only bare empty text and cannot tell why no create affordance exists.
- **Expected:** Either surface the create affordance as a disabled-with-tooltip control (consistent with the docstring and the per-row actions), or correct the docstring to state that create affordances are hidden (not disabled-with-tooltip) for managers.
- **Fix:** Correct the docstring (lines 18-19) to state that create affordances are HIDDEN for managers while per-row actions are disabled-with-tooltip; or, for full consistency with the promise, render the create CTA as a ManagerDisabledAction.
- [ ] fixed

### G18. Admin Renewal & Health card shows "No active renewal cycle" when the renewal read actually FAILED (no error state exists)
- **Severity:** ⚪ LOW · **Angle:** empty-disabled-states
- **Where:** `members/renewal-health-card.tsx:143`
- **Trigger:** Admin opens the detail page of an imported member during a renewal call and the F8 renewal read hits a transient failure (Neon/RLS blip). Imported members ALWAYS have exactly one renewal_cycle, so status===null on this card can only mean the read failed — never a genuine no-cycle.
- **Wrong:** MemberRenewalHealthSection (member-renewal-health-section.tsx:64-70) collapses a failed read (`!renewalRes.ok`) to `cycle = null`, and RenewalHealthCard renders `status === null ? t('empty')` = "No active renewal cycle". There is NO error/unavailable branch. The card even ships a "View renewal" link to the generic /admin/renewals dashboard, so the admin is told this specific member has no cycle (and no retry), hiding the real DB failure. The section docstring itself admits: "a renewal-read failure renders the empty-state copy."
- **Expected:** Distinguish read-failure from genuine no-cycle and render a distinct "Status unavailable — please try again" state (with retry), exactly as the portal already does: dashboard-reads.ts loadDashboardRenewalCycle returns an 'error' sentinel and dashboard-stats.ts deriveMembershipStat has a dedicated `error` kind precisely so "a DB-throw is never shown as the first-run state." The admin card is the one surface without that fix.
- **Fix:** Mirror the portal's error sentinel: when `!renewalRes.ok`, pass a distinct `readFailed`/`status:'error'` signal from MemberRenewalHealthSection into RenewalHealthCard and render a "Status unavailable — please try again" branch (with retry) instead of `t('empty')`.
- [ ] fixed

### G19. Admin member timeline preview shows "No recent activity yet" when the audit read FAILED — same bug the portal explicitly fixed
- **Severity:** ⚪ LOW · **Angle:** empty-disabled-states
- **Where:** `_components/timeline-preview-section.tsx:115`
- **Trigger:** Admin views an imported member (who genuinely has near-zero activity — often only member_created) and the timelineList read throws or returns !ok.
- **Wrong:** The try/catch (lines 68-92) leaves `events = []` on BOTH the `!result.ok` and the thrown-error paths, and the render then shows `events.length === 0 ? t('timelinePreview.empty')` = "No recent activity yet." A read failure is indistinguishable from a genuinely-quiet imported member, so an admin is told nothing happened when the audit read actually failed.
- **Expected:** Render a distinct "Couldn't load activity — try again" state on failure, separate from the legitimately-empty state. The portal RecentActivitySection was explicitly fixed for this exact case (D1 review finding B2: "a failed read must NOT fall open to the 'No activity yet' empty state") and now renders a `loadFailed` variant; the admin preview never got that treatment.
- **Fix:** Mirror the portal fix: track a separate `loadFailed` flag (set on `!result.ok` and in `catch`) and render a distinct "Couldn't load activity — try again" state instead of falling through to the `events.length === 0` empty branch; add a `timelinePreview.loadFailed` i18n key across en/th/sv.
- [ ] fixed

### G20. Lapsed member's dashboard card says "Renew to restore your benefits" but provides NO way to renew (dead-end for imported members re-activated to the portal)
- **Severity:** ⚪ LOW · **Angle:** empty-disabled-states
- **Where:** `_components/membership-stat-section.tsx:74`
- **Trigger:** An imported member whose roster row was imported with an already-lapsed membership year (cycle terminal: lapsed/cancelled) is later invited and logs into the portal.
- **Wrong:** deriveMembershipStat returns kind:'lapsed' with sub-copy "Your membership has ended. Renew to restore your benefits", but `renewable = stat.kind === 'overdue' || stat.kind === 'due'` deliberately EXCLUDES 'lapsed', so no "Renew now" button renders. The copy instructs the member to renew while offering no control; navigating to /portal/renewal/[memberId] silently redirect()s back to /portal (page.tsx:110-113 findActiveForMember rejects terminal cycles). The member is in a copy-vs-action contradiction with no path forward and no explanation that admin action is required.
- **Expected:** Either surface an actionable affordance (e.g. a 'Contact us to reactivate' mailto/support link) or change the sub-copy so it does not promise a self-serve renewal the UI can't deliver — the lapsed member should not read an instruction they cannot act on.
- **Fix:** Change en.json lapsedSub to drop the self-serve "Renew to restore" promise and instead surface an actionable "Contact us to reactivate" mailto/support affordance for the lapsed kind (add an action branch for stat.kind==='lapsed' pointing at a support contact, not /portal/renewal).
- [ ] fixed

### G21. invite-portal button drops the 'contact_removed' code into a generic 'Something went wrong' toast
- **Severity:** ⚪ LOW · **Angle:** error-map-ux
- **Where:** `members/invite-portal-button.tsx:66`
- **Trigger:** Admin clicks 'Invite to portal' on a contact whose row was soft-removed (e.g. the member/contact was erased via GDPR/PDPA erasure, but the button is still on a stale rendered page). Server returns 409 { error.code: 'contact_removed' }.
- **Wrong:** The client switch (lines 46-68) has cases for already_linked, no_email, invalid_email, email_taken, not_found, link_failed only; 'contact_removed' hits `default` → toast.error(t('errors.serverError')) which is 'Something went wrong. Please try again.' (en.json:1422). This tells the admin it's a transient failure to retry, when it is a terminal state (the contact no longer exists).
- **Expected:** Map 'contact_removed' to a dedicated message like 'This contact has been removed.' (matching the server's static 409 semantics) so the admin stops retrying and refreshes. Exactly the class of the fixed email-edit gap: server names the real cause, client discards it.
- **Fix:** Add a `case 'contact_removed':` arm to the client switch mapping to a new i18n key admin.members.invitePortal.errors.contactRemoved (e.g. "This contact has been removed. Refresh the page.") in en/th/sv.json.
- [ ] fixed

### G22. Inline directory edit surfaces the raw English server message (incl. dev-y 'State transition failed: <code>') in the cell error
- **Severity:** ⚪ LOW · **Angle:** error-map-ux
- **Where:** `_components/directory-with-bulk.tsx:85`
- **Trigger:** Admin inline-edits a member's status in the directory and the transition is rejected (server 409 state_error) or a field value is invalid (400 invalid_field_value). Non-en admin locale.
- **Wrong:** handleInlineEdit returns `error: body.error?.message ?? t('saveFailed')`, so the cell shows the raw English server message. inline-edit/route.ts sets state_error message to `State transition failed: <code>` (line 194) and invalid_field_value message to the domain `reason` (line 178) — both English, dev-oriented strings surfaced directly to the admin, ignoring the machine `code`.
- **Expected:** Map the returned error.code to localized cell copy; only fall back to t('saveFailed') when no code is recognized. As written the localized saveFailed fallback is almost never reached because the server always sends a message.
- **Fix:** In handleInlineEdit (directory-with-bulk.tsx:85), map body.error.code (e.g. 'state_error') to localized cell/toast copy and only fall back to t('saveFailed'); stop forwarding the server's raw English message, and drop the hardcoded `State transition failed: <code>` string from route.ts:194.
- [ ] fixed

### G23. Edit-member contact steps map a retryable 503 to a generic error, inconsistent with the member step in the same file
- **Severity:** ⚪ LOW · **Angle:** error-map-ux
- **Where:** `members/edit-member-client.tsx:153`
- **Trigger:** Admin edits an imported member's primary-contact email/fields while Upstash is briefly unavailable; the contacts PATCH returns 503 { error.code: 'idempotency_reservation_failed' } with Retry-After.
- **Wrong:** handleContactResponse (lines 116-157) has no 503 arm — 503 falls to the final `else { toast.error(t('errors.generic')) }`, i.e. 'Something went wrong'. Yet the sibling handleResponse for the member-field/plan step DOES map 503 to `tCreate('errors.serverBusy')` (lines 203-206). So the same outage produces 'server busy, retry shortly' for a company-field edit but a dead-end generic error for a contact/email edit, and the partial-save warning can compound it.
- **Expected:** handleContactResponse should map 503 → serverBusy (retryable) identically to handleResponse, so the admin knows to retry rather than assuming a permanent failure on the contact save.
- **Fix:** Add a 503 arm to handleContactResponse before the final else — `else if (res.status === 503) { toast.error(tCreate('errors.serverBusy')); }` — mirroring handleResponse:203-206 so the contact/email save reports the outage as retryable.
- [ ] fixed

### G24. Add/Edit contact dialog maps a retryable 503 to a generic 'something went wrong' toast
- **Severity:** ⚪ LOW · **Angle:** error-map-ux
- **Where:** `members/contact-form-dialog.tsx:180`
- **Trigger:** Admin adds or edits a contact while Upstash reservation is unavailable; POST/PATCH contacts returns 503 { error.code: 'idempotency_reservation_failed' } with Retry-After: 5.
- **Wrong:** handleError (lines 162-183) branches on 409/conflict, 400, 404 only; 503 falls to `else { toast.error(tA('errors.generic')) }`. The admin gets a permanent-sounding generic error instead of a 'server busy, retry shortly' cue, unlike the create/edit member forms which explicitly map 503 to errors.serverBusy.
- **Expected:** Add a 503 branch that surfaces a retryable message (parity with member-form clients), since the server explicitly signals a transient, retryable outage via 503 + Retry-After.
- **Fix:** In handleError add `else if (res.status === 503) toast.error(tA('errors.serverBusy'))` and add a `serverBusy` key under admin.members.detail.contactActions.errors (en/th/sv), matching create/edit-member clients.
- [ ] fixed

### G25. Portal invite-colleague form drops server invalid_email / validation_error into a raw or generic toast with no field highlight
- **Severity:** ⚪ LOW · **Angle:** error-map-ux
- **Where:** `members/invite-colleague-form.tsx:116`
- **Trigger:** A member submits a colleague invite whose email passes the client zod .email() rule but is rejected by the server's stricter domain validator (400 invalid_email), or the server returns 400 validation_error.
- **Wrong:** The client maps only email_taken (inline), forbidden, and link_failed; invalid_email and validation_error fall to `else { toast.error(data?.error?.message ?? t('sendError')) }`. invalid_email surfaces the server's raw English 'Invalid email address' (never localized, and the email field is NOT highlighted despite being field-attributable), while validation_error has no message so it degrades to the generic 'sendError' toast with nothing marked.
- **Expected:** Map invalid_email to an inline, localized error on the email input (parity with the email_taken handling), and map validation_error to a localized message rather than the server's raw string or a bare generic toast.
- **Fix:** Add an else-if for `invalid_email` that calls form.setError('email', {message: t('invalidEmail')}) + setFocus (parity with email_taken), add a localized `portal.invite.invalidEmail` key, and map `validation_error` to a localized message instead of relying on the absent data.error.message.
- [ ] fixed

### G26. Contact email-edit note gives stale, incorrect instructions for imported/unlinked members (contradicts the just-fixed behavior)
- **Severity:** ⚪ LOW · **Angle:** i18n-copy
- **Where:** `members/contact-form-dialog.tsx:345`
- **Trigger:** An admin opens the Edit-contact dialog on an IMPORTED member (contact.linked_user_id = NULL) to correct a typo in the primary contact's email. The read-only email field shows the note t('emailEditNote').
- **Wrong:** The note reads (EN) "To change this contact's email, edit it on the member Edit page. An unlinked contact must be invited to the portal first." The second sentence is false after the email-edit fix: the member Edit page (edit-member-client.tsx lines 311-324, step 3) now updates an unlinked contact's email IN PLACE with no invite required ("an unlinked contact (e.g. imported members) is updated in place"). The copy tells the admin they must first invite the contact to the portal — an unnecessary, non-existent precondition — in all three locales (EN/TH/SV all carry the stale sentence: admin.members.contactForm.emailEditNote).
- **Expected:** The note should state that the email can be changed directly on the member Edit page (no invite needed for unlinked/imported contacts). The stale "must be invited to the portal first" clause should be removed/updated in en.json, th.json and sv.json to match the fixed in-place-edit behavior.
- **Fix:** Delete the "An unlinked contact must be invited to the portal first." clause (and its TH/SV equivalents) from admin.members.contactForm.emailEditNote in en/th/sv.json, leaving only "To change this contact's email, edit it on the member Edit page."
- [ ] fixed

### G27. Member self-service profile-save leaks the server's hardcoded English error.message, contradicting the component's own comment that promises localised copy
- **Severity:** ⚪ LOW · **Angle:** i18n-copy
- **Where:** `members/portal-edit-form.tsx:134`
- **Trigger:** A Thai- or Swedish-locale member edits their profile and the save hits a non-validation error path: 500 (route returns { code:'internal', message:'Server error' }), 404 ({ message:'Member not found' }), or 403 forbidden ({ message: result.error.reason }).
- **Wrong:** The catch-all falls back to `toast.error(data?.error?.message ?? t('saveError'))`, so it shows the route's raw ENGLISH message ('Server error' / 'Member not found' / the forbidden reason) to a non-English member. This directly contradicts the same function's comment at lines 124-127 ("Use a LOCALISED message, never the server's raw issue.message ... the message stays localised").
- **Expected:** Non-field errors should surface the localised t('saveError') (or a code-mapped localised message), never the server's English error.message string. The passthrough `?? data.error?.message` should be dropped in favour of a localised fallback, matching the component's stated intent.
- **Fix:** Drop the `data?.error?.message` passthrough on line 134; map error.code (forbidden/not_found/internal) to localised next-intl strings and always fall back to t('saveError'), so the server's raw English reason is never toasted to non-English members.
- [ ] fixed

### G28. Portal dashboard header status chip ("Active") contradicts the membership stat card ("Membership lapsed")
- **Severity:** ⚪ LOW · **Angle:** lifecycle-transitions
- **Where:** `(home)/page.tsx:118`
- **Trigger:** An imported member (invited + verified) whose renewal cycle has lapsed/expired signs into the portal. `members.status` stays 'active' (nothing flips it on lapse) while the most-recent cycle is terminal-lapsed or overdue.
- **Wrong:** The PageHeader chip is derived purely from `member.status` → renders "Active" (statusChipKey, page.tsx:101-106,118), while the `MembershipStatSection` card immediately below derives from the renewal cycle via `deriveMembershipStat` and renders "Membership lapsed — Renew" (destructive). The unlabelled header chip reads as the authoritative membership status and directly contradicts the card. Two different data sources (members.status vs renewal cycle) are shown as if both describe membership standing.
- **Expected:** The header status chip and the membership stat card must agree — either the header should reflect renewal standing, or the chip should be relabelled (e.g. "Account: Active") so it isn't read as membership status.
- **Fix:** Relabel the header chip so it reads as account status (e.g. statusChip key "Account: Active") or suppress/replace it with the renewal-derived standing so it can't be read as, and contradict, the membership card.
- [ ] fixed

