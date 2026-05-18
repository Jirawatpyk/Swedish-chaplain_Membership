# Feature Specification: F7.1a — Email Broadcast Advanced (Pagination + Image Embedding + Multi-Template)

**Feature Branch**: `014-email-broadcast-advance`
**Created**: 2026-05-17 (split to F7.1a on 2026-05-18 per critique Strategy B)
**Status**: Draft — F7.1a scope (US1 + US2 only)
**Input**: User description: "F7.1 Email Broadcast / E-Blast advance สร้าง worktree จะทำ paralle"

---

## Context (informational — not part of the spec contract)

F7 Email Broadcast (`010-email-broadcast`) shipped via PR #23 on 2026-05-03 with an explicit MVP scope-cut list. Twelve enhancements were deferred to F7.1 and tracked in `specs/010-email-broadcast/spec.md` § Out of Scope, in FR-002a / FR-015c / FR-016a, and in the F7 retrospective.

**F7.1a scope (this spec)** picks up the TWO highest-priority deferrals — both P1 — that have the strongest evidence of need, plus the lowest-risk P2 enhancement (multi-template library) that the F7 retrospective stakeholder review identified as the cheapest engineering investment with high UX value:
- **US1** (P1): Lift the 5,000-recipient broadcast ceiling to 50,000 via pagination
- **US2** (P1): Re-enable inline `<img>` embedding under a tenant-managed source allowlist
- **US7** (P2): Admin-authored multi-template library with snapshot semantics + 5 starter templates seeded per tenant in EN+TH+SV (maintainer-authored content; chamber compliance liaison refines post-ship)

**F7.1b backlog (deferred)**: The original F7.1 8-US bundle's remaining FIVE user stories (per-contact opt-in, attachments, open/click tracking, saved segments, PII scanner) are preserved in [`f71b-backlog.md`](./f71b-backlog.md) and will be re-spec'd into a separate feature branch when 4-6 weeks of F7 MVP + F7.1a production data validate which capabilities tenants actually need. Rationale: strategy decision documented in `critiques/critique-20260518-003047.md` § Verdict. US7 was promoted back into F7.1a after maintainer committed to writing starter template content directly (no compliance-liaison-blocker; admin refines post-ship).

---

## Clarifications

### Session 2026-05-17

The original F7.1 8-US spec held a 10-question Clarifications session across two rounds. Of those 10 questions, the four that apply to F7.1a's US1+US2 scope are reproduced below; the six that apply only to deferred user stories are preserved verbatim in [`f71b-backlog.md`](./f71b-backlog.md) for re-use when those user stories are promoted.

- Q: US1 batch boundary — How should batches partition the recipient list when a broadcast exceeds the email provider's per-audience size limit? → A: **Parallel with concurrency cap of 4** — Split into N provider-audiences (each ≤ provider per-audience cap of 10,000), dispatched in parallel with at most 4 simultaneous batches. Preserves F7 MVP's Broadcasts audience model + webhook payload contract + suppression-list semantics + reputation pool. Compresses a 50k broadcast to ~6–10 min wall-clock; respects Resend account-level rate limits via the concurrency cap; on cap saturation the remaining batches queue at the dispatcher.
- Q: US2 image-uploads virus-scanner choice — Which virus-scanning surface should the platform use for image uploads (and future F7.1b attachments)? → A: **Self-hosted ClamAV** (deployment topology refined post-clarify in `research.md § 1`: Fly.io `sin`-region persistent micro-VM running `clamav/clamav:stable` — the original "in-process Vercel Function sidecar" phrasing was technically incompatible with `clamd`'s daemon model + 150 MB signature DB and was corrected per audit finding C2; the high-level "self-hosted ClamAV" choice itself is unchanged). Zero per-scan cost; predictable latency ~50–500ms per file via daemon mode; signature-DB refresh via `freshclam` inside the Fly.io container (24h default — no external cron coordinator needed). Rejected alternatives: managed third-party API (recurring per-scan cost + bandwidth surcharge that scales adversely with tenant count, vendor downtime becomes platform downtime); email-provider built-in (Resend does not currently expose a customer-accessible scanning API, would constrain platform to single-vendor lock-in for both delivery + scanning).
- Q: US1 `partially_sent` state semantics — Is `partially_sent` terminal, or can admin retry only the failed batches? → A: **Non-terminal with explicit admin retry action** (capped at 3 manual retries per broadcast). The state machine adds a `retrying` transient state. Admin clicks "Retry failed batches" → re-attempts ONLY the failed batches with their original recipient sets (preserves recipient-set fidelity — admins cannot accidentally introduce duplicate sends via segment drift between attempts). Each retry emits a `broadcast_retry_initiated` audit event capturing the actor + retry attempt count + batch ids retried. After 3 manual retries (or admin's choice via "Accept partial delivery"), `partially_sent` becomes terminal.
- Q: US2 inline image upload hard size cap — What is the maximum size per inline image embedded in a broadcast body? → A: **5 MB per inline image**. Covers typical chamber use cases (banner ~1-2 MB, sponsor logos ~50-500 KB, event photos ~2-4 MB) without busting the ClamAV ~500ms scan SLO (Q2). Members attempting to upload >5 MB images receive a bilingual `broadcast_image_too_large` error at upload boundary and are directed to compress client-side. The cap is enforced at the upload boundary AND re-enforced on sanitiser pass at submit (defence in depth — catches paste-of-external-large-data-URI shenanigans).

### Session 2026-05-18 (round 3 — Open Considerations from critique round 2)

- Q: P2 — 3-US scope realistic for solo-dev 2-3 week timeline given F8 PR #24 took 13 review-fix rounds? → A: **Decide at `/speckit.tasks` gate** — generate tasks.md and count items; if >200 tasks, re-defer US7 back to F7.1b (cheap to lift since US7 contracts + entity + migration + UI tree are isolated under explicit sub-paths); if ≤200, ship all 3 USs as planned. Avoids premature scope cut + avoids over-commitment. Maintainer commits to "review at tasks.md gate" instead of "decide now". Rejected alternatives: ship-all-3-now (no fallback if tasks > 200), defer-US7-now (premature — actual task count unknown), defer-US7-AND-US1-ship-US2-only (over-conservative; US1 has clearest TAM-unlock value).
- Q: E12 — Tiptap MAJOR version compatibility risk (F7 MVP base version vs `@tiptap/extension-image@^3.22` proposed for F7.1a US2)? → A: **No upgrade needed** — verified via `grep -E "@tiptap" package.json` on the F7.1a worktree: F7 MVP is already on `@tiptap/react@3.22.5` + `@tiptap/starter-kit@3.22.5`, same MAJOR version as `@tiptap/extension-image@^3.22`. F7.1a US2 is a **clean extension-add** (single `pnpm add @tiptap/extension-image@^3.22` + Tiptap config change in `tiptap-image-extension-config.ts`); zero risk to F7 MVP compose surface. No Phase 0 prerequisite task needed; no regression suite re-run beyond the standard F7.1a integration tests.
- Q: E3 — Cross-locale template authoring policy (can admin in a TH-default tenant create EN-locale templates? warn? block? freely allow?) → A: **No warning, no block — permissive authoring**. Admins author templates in any locale freely; rationale: chamber admins know their tenant's audience composition (e.g., SweCham TH-default has Swedish and international members for whom EN/SV templates are legitimate). The picker filter (per contracts § 3 — cascading `current_user_locale || tenant_default_locale || 'en'` default + "Show all locales" toggle) handles the member-side display ergonomics, so admin-side restrictions add friction without benefit. Cross-locale authoring is a tenant-administrative judgement, not a platform invariant. Rejected alternatives: educational warning (adds friction; admins know what they're doing); block (rejects valid use cases like SweCham authoring SV templates for Swedish member subset); defer to F7.1b polish (leaves uncertainty for `/speckit.tasks`).
- Q: SC-007c — Template adoption metric calculation method (% of broadcasts vs % of submitting members)? → A: **% of submitting members** — `count(distinct members who used a template ≥1 time) / count(distinct members who submitted ≥1 broadcast) ≥ 30%`. Measures **adoption breadth** (did members try templates?) not volume-weighted bias from power-users. F7 MVP's likely member-distribution is long-tail (1-2 power-users may compose 50%+ of broadcasts); volume-weighted % can hide adoption failure if power-users happen to like templates while typical members stay on Blank. The chosen metric reveals whether the starter library is reaching the broad member base, which is the actual product question. Rejected alternatives: % of broadcasts (volume-weighted; hides breadth); both (over-instruments dashboard); drop SC-007c (loses the only template-adoption signal in F7.1a).

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Lift the 5,000-recipient broadcast ceiling (Priority: P1)

A medium-to-large chamber (≥2,000 members today, projecting 10,000+ over the next 24 months) wants to send a single newsletter to every member without splitting it into multiple manual sends. F7 MVP rejects any broadcast whose resolved+suppression-filtered recipient list exceeds 5,000 with `broadcast_audience_too_large`. F7.1a lifts the ceiling to 50,000 by paginating a single broadcast across multiple downstream audiences transparently, so the member sees one broadcast row, one audit trail, one delivery dashboard.

**Why this priority**: This is the only F7.1 item that **unblocks future tenants** entirely. Tenants above 5k are turned away today; every other F7.1 item is an enhancement to existing flows. Without US1 the platform's ceiling on TAM (Total Addressable Market) is roughly "any chamber with ≤5k members" — and US1 closes that ceiling.

**Independent Test**: Seed a tenant with 7,500 active members each having a unique `primary_contact_email`. Compose a draft targeting `all_members`, submit, admin-approve, dispatch. Assert: (a) the broadcast row reports `recipient_count=7500` (not rejected), (b) at the end of dispatch the per-recipient delivery rows total 7,500 with no duplicates, (c) the broadcast detail page shows one consolidated delivered/bounced/complained/unsubscribed roll-up across the entire 7,500, (d) cancelling the broadcast mid-dispatch halts all not-yet-dispatched batches.

**Acceptance Scenarios**:

1. **Given** a tenant with 7,500 active members targeted by `all_members`, **When** a member submits the broadcast and an admin approves and dispatches it, **Then** all 7,500 recipients are delivered, no recipient receives a duplicate, the broadcast detail page reports a single roll-up of delivery+bounce+complaint+unsubscribe counts, and the audit log contains exactly one `broadcast_submitted` + one `broadcast_approved` + one `broadcast_sent` event per broadcast (not per batch).
2. **Given** a broadcast targeting 12,000 recipients is mid-dispatch (e.g., batches 1–4 of 8 already accepted by the email provider), **When** the member or an admin cancels the broadcast, **Then** batches 5–8 are NOT dispatched, the broadcast `status` transitions to `cancelled`, and the partial roll-up clearly distinguishes "5,800 delivered" from "6,200 not dispatched (cancelled)". Already-dispatched batches cannot be recalled from recipient inboxes (impossible by physics — email is delivered the moment the provider accepts it); the admin UI surfaces this clearly.
3. **Given** a broadcast targets 5,500 recipients and the underlying email provider rejects one batch (e.g., provider 5xx on batch 3), **When** the dispatcher retries per the existing reconcile-stuck-sending policy, **Then** only batch 3 is re-attempted (not the entire broadcast), and the audit trail records the per-batch failure-and-retry events with: `batch_id` + `retry_attempt_count` + `failure_reason` (provider error text or HTTP status) + `recipient_count` + `before/after delivered/bounced/complained/unsubscribed counts` + ISO 8601 timestamps for failure + retry-initiated + retry-completed events — sufficient for an on-call engineer to confirm no double-send occurred without external tools.
4. **Given** a broadcast row dispatched to 9,000 recipients receives webhook events (delivered, bounced, complained, unsubscribed) over the next 72 hours, **When** an admin views the broadcast detail page, **Then** the displayed counts are correct totals across all batches and update in near-real-time (≤2 minutes lag from webhook arrival to displayed count).

---

### User Story 2 — Embed inline images safely in broadcast body (Priority: P1)

Members composing a chamber newsletter or member-spotlight email want to embed images (banner, sponsor logos, event photos) directly in the body so recipients see a rendered image without clicking through. F7 MVP strips `<img>` entirely to close a tracking-pixel privacy bypass. F7.1a reopens `<img>` but only when `src` resolves to a **strictly allowlisted origin** that the chamber controls — eliminating the third-party tracking-pixel attack class.

**Why this priority**: This is the single most common UX complaint surfaced in the F7 retrospective stakeholder review — "our members can't make their emails look professional without images." Without US2, F7's compose surface lags every general-purpose marketing tool, eroding members' perception of the chamber's E-Blast as a real benefit.

**Independent Test**: Compose a draft body containing three `<img>` tags: (a) `src="<chamber-asset-domain>/banner.png"` (allowlisted), (b) `src="<email-provider-cdn>/uploaded.jpg"` (allowlisted), (c) `src="https://attacker.com/track.gif?recipient=X"` (NOT allowlisted). Submit. Assert: (a) and (b) persist verbatim in `body_html`, (c) is stripped server-side (tag removed, no broken-image placeholder, no alt-text orphan), and the member sees a validation message naming each disallowed `src` so they can replace it.

**Acceptance Scenarios**:

1. **Given** a member pastes a body containing a banner image from the chamber's own asset domain, **When** they submit the broadcast, **Then** the image renders correctly in the approved-and-sent email (HTML and plain-text fallback show "[image: banner.png]" or the configured alt text).
2. **Given** a member attempts to paste a body containing `<img src="https://evil.example.com/tracker.gif">`, **When** they submit the broadcast, **Then** submission is rejected with `broadcast_body_image_source_unsafe` (bilingual, listing the offending `src` URL for each disallowed image), and the unsanitised body is never persisted.
3. **Given** an admin configures the tenant's image-source allowlist (chamber owns the choice), **When** the admin saves the configuration, **Then** subsequent submissions validate against the new allowlist within ≤60 seconds of save and the configuration change is audited.
4. **Given** a member uploads an image via the compose UI (rather than pasting an external URL), **When** they save the draft, **Then** the image is stored in the chamber's own asset bucket, the `src` is automatically rewritten to the allowlisted asset-domain URL, and no external request is required to render the email.

---

### User Story 7 — Multi-template library (Priority: P2)

A chamber administrator wants to maintain a small library of pre-defined broadcast templates so members composing a broadcast can start from a polished template instead of a blank page. F7 MVP ships a single starter template; F7.1a introduces a per-tenant template library with 5 starter templates seeded at ship (Monthly Newsletter, Event Invitation, Member Spotlight, Urgent Announcement, Sponsorship Thank-You) in EN+TH+SV. Admins can edit, delete, or add new templates.

**Why this priority**: Single largest authoring-UX improvement per unit of engineering effort. Reuses every existing surface — same sanitiser (FR-002a + US2 image allowlist), same dispatch flow, same audit trail. Closes the "blank compose page" problem that disproportionately discourages first-time and infrequent senders. The 5 starter templates ship the day of release so members see immediate value (no admin pre-work required to derive benefit). Promoted from F7.1b backlog after maintainer committed to writing starter content directly.

**Independent Test**: Admin opens template library day-1 → sees 5 starter templates already populated in EN+TH+SV. Member opens compose, picks "Event invitation" from the template dropdown, the editor pre-fills with the template's subject + body HTML, the member edits the event date and venue, submits. The dispatched broadcast contains the member's edits (not the original template), and the audit row records the template id the broadcast was started from.

**Acceptance Scenarios**:

1. **Given** a freshly-provisioned tenant at F7.1a ship, **When** an admin opens the template library page for the first time, **Then** they see exactly 5 starter templates (Monthly Newsletter, Event Invitation, Member Spotlight, Urgent Announcement, Sponsorship Thank-You) seeded in the tenant's primary locale with EN+TH+SV variants accessible.
2. **Given** an admin creates a new template with subject + body, **When** the admin saves, **Then** the template is persisted, audited (`broadcast_template_created` with actor + template id + name), and immediately available in the member compose dropdown without page reload.
3. **Given** a member opens compose and picks a template, **When** the template is selected, **Then** the subject + body editor populates with the template content (the template is a snapshot — subsequent template edits by admins do NOT modify drafts already started from the template).
4. **Given** an admin edits or deletes a template, **When** the action is saved, **Then** drafts already started from that template are NOT modified, and the audit log records `broadcast_template_updated` or `broadcast_template_deleted` (with prior values for forensics).
5. **Given** a template body contains image `<img src>` URLs from the tenant's allowlist (US2), **When** a member starts a draft from that template, **Then** the draft body inherits the image URLs verbatim and the US2 allowlist re-validates on submit (no allowlist bypass possible via templates).
6. **Given** a member starts a draft from a template, **When** the broadcast is later dispatched, **Then** the audit row for `broadcast_submitted` records the template id the draft originated from so analytics can identify which templates drive the most sends.
7. **Given** the tenant has zero templates beyond the seeded 5 starters, **When** a member opens compose, **Then** the compose surface defaults to "Blank" + the 5 starter templates (in MRU then alphabetical order).

---

### Edge Cases

- **Recipient list grows mid-compose** (US1): a draft targets 6,800 recipients now, but the chamber onboards 600 more members before submit. At submit time the resolved count is 7,400 — accepted under the new 50k cap.
- **Image source allowlist contains a wildcard that matches the chamber's own subdomain** (US2): the system MUST NOT permit `*.example.com` patterns that would inadvertently allow `attacker.example.com` if a subdomain takeover ever occurred. Allowlist entries are explicit hosts only.
- **Pagination dispatch partial-failure recovery** (US1): if batch 4 of 8 fails permanently (e.g., provider returns 5xx after exhausting retries), the broadcast moves to `partially_sent` state — NOT `failed` — and the admin sees a per-batch breakdown so they can decide whether to retry the failed batch manually or accept partial delivery. `partially_sent` is **non-terminal** per Clarifications Q3; admins may click "Retry failed batches" up to 3 times per broadcast; the retry attempts ONLY the failed batches with their original recipient sets. After the 3rd manual retry exhausts OR admin explicitly chooses "Accept partial delivery", the state transitions to terminal.
- **Cancel mid-dispatch UX** (US1): already-dispatched batches cannot be recalled from recipient inboxes (impossible by physics — email is delivered the moment Resend accepts the batch). The admin UI clarifies this with copy "N batches halted; M batches already delivered cannot be recalled from inboxes."
- **ClamAV daemon unreachable** (US2 image upload): the member sees an inline banner "Image scanning is temporarily unavailable. Your draft is saved; images will scan automatically when the service is restored (typically within 15 minutes)." Background retry scans the image when daemon returns; operator alert (`clamav_daemon_unreachable >2min critical`) triggers on-call.
- **Concurrent admin retry race** (US1): two admin tabs open, both click "Retry failed batches" simultaneously. Per-broadcast advisory lock (`broadcasts-retry:<tenantId>:<broadcastId>`) ensures first retry wins; second returns `ALREADY_RETRYING_IN_PROGRESS` error.
- **Inline image-upload size cap exceeded** (US2): member attempts >5 MB inline image upload → rejected at upload boundary with `broadcast_image_too_large`; member instructed to compress client-side.
- **Per-batch retry exhausts during Resend account-level rate-limit incident** (US1): if Resend account hits global rate limit, per-batch automatic retries (up to 5 per batch) may all fail. Broadcast transitions to `partially_sent`. Admin manual retry (up to 3) may also fail if rate limit persists. Admin chooses "Accept partial delivery" or waits for rate limit to clear before retrying.
- **Template referenced by an in-flight draft is deleted** (US7): the draft itself is unaffected (the template content was snapshotted at draft-start time); only future "Start from template" actions are affected. The template-deletion audit row records how many drafts had originated from it for forensic purposes.
- **Starter template seed conflict on existing tenant** (US7): the F7.1a migration seeds 5 starter templates per existing tenant. If a tenant somehow already has a template named "Monthly Newsletter" (e.g., manually created earlier), the seed MUST NOT overwrite — it skips that name and logs a `broadcast_template_seed_skipped_existing_name` operator-level audit signal.
- **Template body has image from now-removed allowlist entry** (US7 × US2): if admin removes a hostname from the allowlist AND that hostname is referenced by a template's `<img src>`, the template is NOT auto-modified (preserve admin's content authoring). Next member who starts a draft from that template + submits will hit US2 FR-011 rejection. Admin can re-add the hostname OR edit the template to remove the offending image.

---

## Requirements *(mandatory)*

### Functional Requirements

#### US1 — Recipient-list pagination beyond 5,000

- **FR-001**: The system MUST accept broadcasts whose resolved+suppression-filtered recipient list exceeds 5,000 entries, up to a new hard ceiling of **50,000 recipients per broadcast** (10× the F7 MVP ceiling; covers chambers up to ~50k members with headroom).
- **FR-002**: When the resolved list exceeds the per-batch dispatch primitive (the email provider's per-audience cap of 10,000 recipients), the dispatcher MUST split the broadcast into N batches of ≤10,000 recipients each and dispatch them **in parallel with a concurrency cap of 4 simultaneous batches** (Clarifications Session 2026-05-17 Q1). Each batch carries its own provider-side identifier and emits its own per-batch dispatch+webhook events; batches beyond the concurrency cap queue at the dispatcher and start as soon as a slot frees. The choice preserves F7 MVP's Broadcasts audience model + webhook payload contract + suppression-list semantics + reputation pool. The concurrency cap MUST be tenant-configurable in 1–8 range (default 4) so individual tenants with elevated Resend account limits can opt up, while keeping the default safe for shared-pool accounts.
- **FR-003**: The broadcast row MUST remain a single logical entity from the member's and admin's perspective: one broadcast id, one audit-event triple (`broadcast_submitted` / `broadcast_approved` / `broadcast_sent`), one detail page, one consolidated roll-up. Batch identifiers are an implementation concern surfaced only in audit detail and operator-facing telemetry.
- **FR-004**: Cancellation of a broadcast in `sending` state MUST halt all not-yet-dispatched batches within ≤60 seconds; the broadcast `status` transitions to `cancelled`, and the partial roll-up clearly distinguishes "delivered" from "not dispatched (cancelled)". Already-delivered batches cannot be recalled (email is irrevocable once accepted by the provider); the admin UI MUST display this with explicit microcopy ("N batches halted; M batches already delivered cannot be recalled from inboxes.").
- **FR-005**: Per-batch failure handling MUST retry only the failed batch (existing F7 reconcile-stuck-sending cron extended to per-batch granularity), with retry budget capped per the existing F7 retry policy.
- **FR-006**: The broadcast detail page MUST surface a per-batch breakdown (batch id, recipient-range, dispatch status, per-batch delivered/bounced/complained/unsubscribed) collapsible from the consolidated roll-up, for operator triage.
- **FR-007**: The 50,000-recipient ceiling MUST be enforced at BOTH submit boundary AND dispatch boundary (defence in depth — protects against late-membership-growth between submit and send pushing the count over).
- **FR-008**: The system MUST emit a new audit event `broadcast_dispatched_in_batches` capturing the broadcast id + total batch count + per-batch recipient ranges, so operators can diagnose partial-send incidents.
- **FR-008a**: When any batch reaches its terminal `failed` state after exhausting the existing per-batch retry budget (FR-005), the broadcast as a whole MUST transition to `partially_sent` (non-terminal per Clarifications Q3). Admins MUST have a "Retry failed batches" action on the broadcast detail page, capped at **3 manual retries per broadcast** (counted via a `manual_retry_count` column on the broadcast row). Each retry attempt MUST re-dispatch ONLY the failed batches with their original frozen recipient sets — no segment re-resolution is permitted (preserves recipient-set fidelity).
- **FR-008b**: The system MUST add a `retrying` transient state to the broadcast state machine entered on admin retry click and exited when all retried batches reach a terminal state (success → broadcast becomes `sent` if all batches now succeeded; partial → broadcast returns to `partially_sent` for the next retry attempt). Each retry attempt MUST emit a `broadcast_retry_initiated` audit event (actor id + retry attempt number + retried batch ids) and a `broadcast_retry_completed` audit event (per-batch outcome + new aggregate counts).
- **FR-008c**: Admins MUST have an "Accept partial delivery" action that explicitly transitions the broadcast from `partially_sent` to terminal without further retry, emitting a `broadcast_partial_delivery_accepted` audit event. After the 3rd manual retry exhausts OR the admin chooses Accept, the broadcast is terminal and the "Retry failed batches" action is no longer surfaced.
- **FR-008d**: Concurrent admin retry attempts on the same broadcast MUST be serialised via a per-broadcast advisory lock (`broadcasts-retry:<tenantId>:<broadcastId>` — disjoint namespace from `broadcasts:` and `broadcasts-batch:`). First retry wins; concurrent attempts return `ALREADY_RETRYING_IN_PROGRESS` without incrementing `manual_retry_count` (prevents budget exhaustion from accidental double-clicks across browser tabs).

#### US2 — Image embedding with allowlist

- **FR-009**: `<img>` tags MUST be re-enabled in the body-HTML sanitiser allowlist, but only when the `src` attribute resolves to a host on the tenant's image-source allowlist.
- **FR-010**: The image-source allowlist MUST be tenant-configurable by administrators, with default entries for (a) the chamber's own asset domain and (b) the email-provider's CDN. Wildcards (e.g., `*.example.com`) are explicitly forbidden — entries are exact hostname matches only. Default entries MUST be seeded on tenant provisioning and MUST NOT be removable by admins (only additional entries can be added/removed).
- **FR-011**: At submission, the sanitiser MUST inspect every `<img src="...">`; if the host of `src` is not in the tenant's allowlist, the submission MUST be rejected at submit boundary with `broadcast_body_image_source_unsafe`, listing each disallowed `src` URL for the editor to correct.
- **FR-012**: The compose UI MUST provide an upload action that uploads the image to the chamber's own asset bucket and rewrites the resulting `<img src="...">` to the allowlisted URL, so members do not need to host images elsewhere. Per-image upload size MUST be capped at **5 MB** (Clarifications Q4). Uploads exceeding the cap MUST be rejected at the upload boundary with a bilingual `broadcast_image_too_large` error code that surfaces the actual size + the 5 MB ceiling; the cap MUST be re-enforced on the sanitiser pass at submit time (defence in depth — catches paste-of-external-large-data-URI bypass attempts). Members are directed to compress the image client-side or use a smaller variant.
- **FR-013**: Image uploads MUST be virus-scanned using **self-hosted ClamAV** (Clarifications Q2) and rejected if flagged; the upload is content-hashed so identical images deduplicate storage across drafts and broadcasts. Per-image scan latency p95 MUST be ≤500ms for files ≤2MB. Image upload filename MUST be sanitised at the boundary (strip HTML/JS-meta characters; enforce max length 255) to prevent filename-XSS on admin review surfaces.
- **FR-014**: The sanitiser MUST reject `<img>` tags with `src` URIs using schemes other than `http://` or `https://` (i.e., `data:`, `javascript:`, `file:`, `vbscript:` are stripped), and reject `<img>` tags carrying inline event handlers or `style="..."` attributes (same hardening as the F7 MVP allowlist).
- **FR-015**: The audit log MUST record image-source-allowlist mutations (admin add/remove of allowlist entries) with actor + before/after value.

#### US7 — Multi-template library

- **FR-016**: Administrators MUST be able to create, edit, rename, and delete broadcast templates, scoped to the tenant. Templates MUST NOT be member-authored in F7.1a (admin-only authoring surface; member-authored templates are deferred to F7.1b+ requiring a moderation surface).
- **FR-017**: A template MUST consist of a name (≤100 chars, tenant-unique), a subject line (≤200 chars, same cap as broadcast subjects per F7 MVP), and a body HTML payload subject to the F7 MVP sanitiser PLUS the US2 image-source allowlist (templates carrying `<img>` tags with disallowed sources are rejected at template save, same as broadcast submit).
- **FR-018**: The compose surface MUST present a template picker as the first compose action, with the choices `Blank` + all active templates ordered by `most-recently-used-by-this-member` then alphabetical fallback.
- **FR-019**: Picking a template MUST snapshot the template's subject + body into the draft at the moment of selection; subsequent admin edits to the template MUST NOT mutate drafts already started from it. **Variable substitution** (per critique E1 / X1 / `contracts/broadcast-template.md § 5`): only `{{chamber_name}}` is server-substituted at snapshot time (HTML-escaped from `tenants.display_name`); all other placeholders in the form `[bracketed text]` are member-editable text that ships verbatim in the dispatched broadcast. The Tiptap editor renders bracketed text with a distinct visual style (per critique P4 — grey background + dashed border) + surfaces inline microcopy on first compose-from-template: "Click any [bracketed text] to replace with your content." When a template is snapshotted into a draft, the broadcast row records `template_name_snapshot TEXT` (denormalised copy of the template name at snapshot time per critique P9) so post-template-deletion forensic audit retains the name. **Stale draft banner (per critique E5)**: drafts started from a template >30 days ago that has been edited since show a "Template has been updated since you started this draft — refresh from current version?" banner on next member visit with optional CTA to re-snapshot (overwrites member edits).
- **FR-020**: The system MUST seed **5 starter templates per tenant at F7.1a ship time**: Monthly Newsletter, Event Invitation, Member Spotlight, Urgent Announcement, Sponsorship Thank-You — each authored in EN+TH+SV with locale-appropriate greeting + tone. Content lives in `starter-templates.md` (committed alongside the migration); admins can edit/delete the seeded templates post-ship. Seed migration MUST NOT overwrite if a same-named template already exists (logs `broadcast_template_seed_skipped_existing_name` operator audit signal).
- **FR-021**: The audit log MUST record `broadcast_template_created`, `broadcast_template_updated`, `broadcast_template_deleted` events with actor + template id + name + before/after values where applicable. **Starter badge UX (per critique P6)**: the admin template list page surfaces a "Starter" badge on rows where `is_seeded = TRUE` (visually distinct, dismissible). When admin clicks Edit on a starter template, the editor surfaces a confirmation banner: "This is a starter template seeded by the platform. Editing creates a tenant-specific version (it will no longer auto-update if the platform refines starter content)."
- **FR-022**: The `broadcast_submitted` audit event MUST be extended with an optional `started_from_template_id` field (null if the draft began Blank) so analytics can identify which templates drive the most sends.
- **FR-023**: Template deletion MUST NOT block on existing drafts that originated from the template (the drafts are independent of the template after snapshot); the template-deletion audit row MUST include a count of drafts that had referenced the template for forensic visibility.

---

### Key Entities *(include if feature involves data)*

- **BatchManifest** *(US1)*: A per-batch record bound to a broadcast row, capturing the batch id (provider-side audience id or similar), recipient-range, dispatch status, per-batch delivered/bounced/complained/unsubscribed counts, retry counts (both automatic per-batch and broadcast-level manual), and timestamps. One broadcast row → many batch-manifest rows.
- **TenantImageSourceAllowlist** *(US2)*: A tenant-scoped list of explicit hostnames (no wildcards) where `<img src>` URLs are permitted. Defaults populated on tenant provisioning (chamber asset domain + email-provider CDN); admin-managed thereafter (defaults non-removable).
- **BroadcastTemplate** *(US7)*: A tenant-scoped, admin-authored template carrying a name, subject, body HTML (subject to FR-002a sanitiser + US2 image allowlist at save), creation/update metadata, and a "started-from" count denormalised for visibility. One tenant → many templates; one template → snapshotted into many drafts. F7.1a ships 5 starter templates × 3 locales = 15 rows per tenant via migration `0134_f71a_default_template_seed.sql` (content authored in `starter-templates.md`; auto-generated via `scripts/generate-template-seed-migration.ts` per CI gate).

The original F7.1 8-US bundle included entities for `ContactBroadcastOptIn` (US3), `BroadcastAttachment` (US4), `SavedSegment` (US6), `EngagementEvent` (US5), `PiiDetectionSummary` (US8), and `TenantPiiDetectorSetting` (US8) — all preserved in [`f71b-backlog.md`](./f71b-backlog.md) for re-spec when those user stories are promoted.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** *(US1)*: A broadcast targeting 10,000 recipients completes end-to-end dispatch (submit → admin-approve → all batches accepted by provider) within **10 minutes** of admin approval, with **zero duplicate sends** verified by recipient-email uniqueness across the dispatched batches.
- **SC-002** *(US1)*: A broadcast targeting up to 50,000 recipients completes dispatch within **45 minutes** of admin approval, with all per-batch failure modes recoverable via the existing reconcile-stuck-sending cron extended to per-batch granularity.
- **SC-003** *(US2)*: 100% of dispatched broadcasts containing inline `<img>` tags have every `src` hostname matching the tenant's image-source allowlist (verified by post-dispatch scan of the persisted `body_html` against the allowlist that was effective at submit time).
- **SC-004** *(US2)*: Zero instances of `<img src>` to a non-allowlisted host reach `body_html` (verified by audit-event query — any `broadcast_body_image_source_unsafe` event indicates a successful rejection at submit, NOT a leak).
- **SC-005** *(US2)*: ClamAV scan of inline image uploads completes within **≤500ms p95** for files ≤2 MB; broadcasts containing flagged images cannot be submitted (verified by integration test seeding EICAR test signature).
- **SC-006** *(US1)*: Admin retry of failed batches on a `partially_sent` broadcast succeeds for ≥95% of cases within the 3-retry budget (measured over the first 3 months post-ship); broadcasts requiring more than 3 retries trigger an alert + operator runbook.
- **SC-007** *(US1)*: Concurrent admin retry attempts (race condition) result in exactly one retry being attempted (100% — verified by integration test with two simultaneous calls); the losing attempt receives `ALREADY_RETRYING_IN_PROGRESS` without incrementing `manual_retry_count`.
- **SC-007a** *(US7)*: A member starting a draft from a template sees the template content populated in the editor within **≤500ms** of selection at the 95th percentile, and the draft is fully decoupled from subsequent template edits (verified by integration test mutating a template and asserting drafts originated before the mutation remain unchanged).
- **SC-007b** *(US7)*: All 5 starter templates seed correctly per tenant at F7.1a ship time, with all 3 locales (EN+TH+SV) accessible — total 15 rows per tenant. Verified by automated post-migration integrity check in `tests/integration/broadcasts/starter-template-seed.test.ts` (per critique P10): seed migration runs in test setup → assert `SELECT COUNT(*) FROM broadcast_templates WHERE tenant_id = $1 AND is_seeded = TRUE` returns exactly 15 per tenant. Auto-runs in CI.
- **SC-007c** *(US7 — adoption metric per critique P11; calc method per Clarifications Session 2026-05-18 Q4)*: ≥30% of distinct broadcast-submitting members in the 60 days following US7 ship have submitted at least one broadcast with a non-null `started_from_template_id` (measures **adoption breadth** — `count(distinct members who used a template ≥1 time) / count(distinct members who submitted ≥1 broadcast) ≥ 30%`). Measured volume-weighted (% of broadcasts) was rejected because long-tail member distributions can hide breadth failures behind power-user adoption. Triggers product review if below threshold — possible actions: refine starter content, surface picker more prominently, A/B test with vs without preset.
- **SC-008** *(cross-cutting)*: All new F7.1a surfaces (admin batch breakdown, admin retry + accept-partial confirmations, admin image-source allowlist editor, admin template library + editor, member inline-image uploader, member template picker dropdown, ClamAV unreachable banner) pass WCAG 2.1 AA verified by automated a11y scan (axe-core) + manual screen-reader QA on at least one major SR (NVDA or VoiceOver).
- **SC-009** *(cross-cutting)*: All new F7.1a user-facing strings ship with full EN+TH+SV translation parity verified by the existing `pnpm check:i18n` gate.
- **SC-010** *(cross-cutting)*: Zero F7.1a surface regresses an F7 MVP success criterion (SC-001 to SC-014 from F7 spec) — verified by re-running the F7 spec's success-criteria suite as part of the F7.1a verify gate.

---

## Assumptions

- F7 MVP (`010-email-broadcast`) has shipped to production and is the **baseline** F7.1a builds on. Any F7 MVP gap that F7.1a surfaces is back-ported to F7 first.
- F8 (Renewals & At-Risk) has shipped and its at-risk-scorer is wired through the F8 EventAttendees port; F7.1a introduces no new cross-feature dependency on F6/F8.
- The chamber's "own asset domain" exists per tenant (a logical placeholder for the tenant's own image/asset CDN). For SweCham this may be the same host as the chamber's public website, fronted by a CDN; for future tenants this is a tenant provisioning concern.
- The chosen email provider's **audience-size limit** is 10,000 recipients per audience (Resend Broadcasts API as of 2026-05). The system batches transparently regardless of the per-provider primitive.
- The default tenant image-source allowlist on provisioning contains exactly two entries: the tenant's own asset domain (provisioned with the tenant) AND the email provider's CDN. Admins can add but not remove these two defaults.
- The 50,000-recipient ceiling (US1) is the operational maximum F7.1a supports without further architecture review; a future need for >50k triggers F7.2 design.
- The F7 quota model (per-tier monthly broadcast counts) is unchanged in F7.1a — F7.1a changes WHO is in a broadcast (recipient cap) and WHAT can be in it (images), not HOW MANY broadcasts a tenant may send.
- **F7.1b deferral**: The 6 originally-planned user stories (per-contact opt-in, attachments, open/click tracking, saved segments, multi-template library, PII scanner) are explicitly NOT in F7.1a scope. They live in [`f71b-backlog.md`](./f71b-backlog.md) for promotion when 4-6 weeks of F7 MVP + F7.1a production data validate which capabilities tenants actually need.

---

## Dependencies on existing systems

- **F1 Auth & RBAC**: admin-only configuration surface (US2 allowlist) gated by the existing `admin` role; member-portal surface (US2 image upload in compose) gated by the existing `member` role.
- **F7 Email Broadcast MVP** (`010-email-broadcast`): F7.1a extends the broadcast row, resolver, dispatcher, webhook, and detail UI; the F7 MVP audit-event taxonomy gains 7 new event types (FR-008, FR-008a..d audit events + FR-015 image allowlist audit).
- **Asset storage**: the chamber's own asset bucket (Vercel Blob, reused from F4 invoice PDF storage) is the storage primitive for US2 image uploads; content-hash dedup applies.
- **Virus scanner**: ClamAV daemon running on a Fly.io `sin`-region persistent micro-VM (`clamav/clamav:stable` image with in-container `freshclam` signature refresh). Cost ~$2/month or free tier at SweCham scale.

---

## Out of Scope (explicit — defer to F7.1b or beyond)

**Deferred to F7.1b** (preserved in [`f71b-backlog.md`](./f71b-backlog.md)):
- Per-contact `receive_broadcasts` opt-in (US3 from original 8-US bundle)
- File attachments (US4 from original 8-US bundle)
- Open + click engagement tracking (US5 from original 8-US bundle)
- Saved-segment editor (US6 from original 8-US bundle)
- Pre-submit PII detector (US8 from original 8-US bundle)

(Note: US7 Multi-template library was promoted BACK into F7.1a after maintainer committed to authoring starter content directly — see Context paragraph + FR-020.)

**Deferred to F7.2 or beyond** (per F7 MVP retrospective + critique X4):
- AI-assisted body or subject generation
- Send-time optimisation (auto-pick best send time per recipient)
- Link shortening / per-recipient redirect tracking
- Spam-score estimator on the compose surface
- Full visual query-builder with OR/NOT/grouping
- Member-authored templates (requires moderation surface)
- Adaptive / self-tuning PII detector
- Drip campaigns / automated multi-step sequences (F8 territory)
- Per-tenant Resend BYOK / white-label (remains F12 scope)
- Pay-per-send beyond quota (remains F11 SaaS billing scope)
- External-invitee broadcasts to a curated outside list with separate consent flow
- IMAP / inbox / reply tracking
- Social media cross-posting

---

## Open Questions Requiring Clarification

All `/speckit.clarify` questions applicable to F7.1a's US1+US2 scope have been resolved — see § Clarifications above for the canonical record. The spec is ready for `/speckit.plan` (already executed) and `/speckit.tasks`.

The 6 additional clarifications resolved in the original F7.1 8-US session that apply only to deferred user stories (per-contact opt-in semantics, attachment cap, virus-scanner choice for US4, PII admin workflow, click counting semantics, tracking toggle granularity) are preserved verbatim in [`f71b-backlog.md`](./f71b-backlog.md) for direct re-use when F7.1b user stories are promoted.
