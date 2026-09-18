# Implementation Plan: E-Blast Two-Sided Approval Workflow, Writing Tool Upgrade & Marketing Dashboard

**Branch**: `119-eblast-approval-workflow` | **Date**: 2026-09-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/119-eblast-approval-workflow/spec.md` (4 clarification
sessions; `spec-review-panel` GO WITH AMENDMENTS applied — FR-012a new, FR-017 extended, FR-041b
rewritten). Code evidence: [exploration-2026-09-18.md](./exploration-2026-09-18.md), re-verified
against `main` at `5f602fd30` on 2026-09-18.
**Phase outputs**: [research.md](./research.md) · [data-model.md](./data-model.md) ·
[contracts/](./contracts/) · [quickstart.md](./quickstart.md)

## Summary

Today an E-Blast is frozen at submit and staff can only approve or reject it. This feature adds a
**second, member-facing approval round** on top of the existing F7 record: marketing opens a
submitted E-Blast, starts a **formatted version** (a row in a new `broadcast_versions` table — the
member's submission is never edited), sends it to the member, and the member approves or requests
changes with a reason (`broadcast_member_decisions`, append-only). On approval marketing confirms
the send time and the **approved version is promoted into the sending record**, which is the only
way the delivery path can send exactly what the member signed off. Five new `broadcast_status`
values carry the stages; the member's proposed time moves to its own immutable `proposed_send_at`
column so it is never overwritten; the allowance bucket and the erasure/cancel cascade widen to the
new in-progress set. In parallel the writing tool gains the controls, images, design blocks (CTA
button, banner, chamber logo header) and a **real preview rendered by the send-time wrapper**, and
every E-Blast screen is brought to the platform's UX standard.

Technical approach (research R1–R24): one owning bounded context (`src/modules/broadcasts`, R1);
**three** new tenant-scoped tables (`broadcast_versions`, `broadcast_member_decisions`,
`broadcast_images`) plus brand columns on the existing `tenant_broadcast_settings`, all four surfaces each with
`tenant_id` + RLS ENABLE/FORCE and the 0064 policy; **two** hand-written migrations — `0304`
(PR-1: images, brand, 4 audit values) and `0305` (PR-2, the only other PR: the FR-012a bundle — `broadcast_status` +5,
`broadcasts_immutable_after_submit_fn` with exactly two new exemptions,
`broadcasts_state_machine_fn` CASE arms, the version/decision tables, `proposed_send_at`); **14** new
audit events (the twelve workflow events plus `broadcast_image_uploaded` / `broadcast_image_removed`,
which spec § Audit trail requires and which do **not** exist today — the live `broadcast_image_*`
values are refusals and configuration only), 5 new `notification_type` values with dispatcher arms
that render **at send time from ids**; marketing recipients derived from the permission evaluator, never a role literal; reminders,
the day-23 warning, the day-30 expiry and the image-blob sweep folded into the existing
`prune-expired-drafts` daily cron as a second, independently-transacted block — **no new cron job**
(37 of the 40 Pro slots are used); four new gauges on the existing 5-minute broadcasts tick.
**Zero new npm dependencies** (`@tiptap/extension-image` moves `^3.22.5` → exact `3.22.5`, a pin,
not an addition). Flag `FEATURE_EBLAST_MEMBER_APPROVAL` (default OFF) gates **entry** into the
approval round; it deliberately does not gate the exits, because FR-034 requires in-flight E-Blasts
to stay completable with the flag off.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`); Node 22 LTS; Next.js 16 App Router; React 19 — unchanged
**Primary Dependencies**: Drizzle ORM · next-intl · zod · shadcn/ui + Base UI · Tiptap 3.22.5
(`@tiptap/{core,pm,react,starter-kit}` exact; `@tiptap/extension-image` **re-pinned** `^3.22.5` →
`3.22.5`, `package.json:85`) · `isomorphic-dompurify` 2.36.0 exact · Resend (transactional surface
via the outbox; the Broadcasts surface is untouched) · `@vercel/blob` ^2.3.3 · `fast-check` ^4 (dev,
already present from F4) for the design-block round-trip property test. **Zero new npm
dependencies** (Constitution X)
**Storage**: Neon Postgres `ap-southeast-1`, hand-written SQL. Migration `0304`
(`when: 1798543700000`, journal `idx: 305`) and `0305` (`when: 1798543800000`, `idx: 306`) — verify
the journal tail at write time; the last entry today is `idx: 304` / `when: 1798543600000` /
`0303_member_change_requests_reason_partial_ck`. Tables **added**: `broadcast_versions`,
`broadcast_member_decisions`, `broadcast_images`. Tables **changed**: `broadcasts` (+6 columns),
`tenant_broadcast_settings` (+4 columns). Enums widened: `broadcast_status` +5,
`audit_event_type` +14, `notification_type` +5. No column drops, no data backfill except
`proposed_send_at := scheduled_for` for rows still in `submitted` (data-model § 3)
**Testing**: Vitest unit/contract · live-Neon integration on the dev branch (two-tenant probe on
each new table, cross-member probe, the FR-012a "direct edit still refused at the database" trigger
test, the state-machine edge matrix, the allowance bucket, erasure reach) · Playwright + axe
(`--workers=1`) · static gates (`check:multi-tenant`, `check:audit-events`, `check:audit-counts`,
`check:staff-page-guard`, `check:api-route-guard`, `check:actor-role-truth`, `check:i18n`,
`check:layout`, `check:env-example`, `check:portal-guard`)
**Target Platform**: Vercel `sin1` (prod live at `swecham.dxtspace.com`), Node-runtime route
handlers; native Vercel Cron (GET, UTC). **No new cron job** — the reminder / expiry / image-sweep
block joins `/api/cron/broadcasts/prune-expired-drafts` (`vercel.json:14`, `30 4 * * *` UTC =
11:30 Asia/Bangkok). 37 of 40 Pro slots in use
**Project Type**: Web application — existing modular monolith; presentation in
`src/app/(staff)/admin/broadcasts/**`, `src/app/(member)/portal/broadcasts/**`,
`src/app/(staff)/admin/settings/broadcasts/**`
**Bounded contexts touched**: `src/modules/broadcasts` (owner — new Domain sub-trees, use cases,
ports, repos); `src/modules/invoicing` (READ-ONLY: one new barrel export that resolves the public
URL of the logo already on file — FR-041b); `src/modules/auth` (enum tuples + the
`listActiveUsersByRole` read reused for marketing recipients). No new module
**Performance Goals**: preview render p95 < 400 ms (server render of ≤ 200 KB body) · save version
p95 < 400 ms · member approve / request-changes p95 < 400 ms · confirm schedule p95 < 400 ms ·
dashboard counts + first page < 2 s at 1,000 E-Blasts (SC-008; indexed, measured by the seeded
pagination test) · hand-off notification enqueued in the state-change tx, sent within one 1-minute
outbox tick (SC-004 ≤ 5 min) · test copy delivered synchronously < 3 s · compose LCP < 2.5 s,
INP < 200 ms, CLS < 0.1
**Constraints**: prod is live with real members and real sends — PR-1 changes the outgoing wrapper
for **every** E-Blast and is not behind a flag, so a byte-identical snapshot test for the
"no brand settings, no blocks" case is a merge blocker · every tenant-scoped query threads the
`runInTenant` tx (never the global `db`) and every new table carries RLS + FORCE · `return err()` is
never used inside a `runInTenant` callback (throw-to-rollback) · audit payloads carry ids, keys and
lengths, never subject/body/reason text · actor role = session role (`check:actor-role-truth`) ·
Buddhist Era display-only, storage ISO 8601 UTC · the Resend **Broadcasts** surface, audience build
and suppression list are untouched · no new permission key (spec § Roles) · the F7 master
kill-switch (`FEATURE_F7_BROADCASTS` + `matchesF7KillSwitchPath`, `src/proxy.ts:43-68`) continues to
disable everything
**Scale/Scope**: 3 new tables + 10 changed/added columns · 2 migrations · 5 `broadcast_status`
values · 14 audit events · 5 notification types · 22 use cases (**logical** — 18 use-case **files**
in § Project Structure; the voiding arm, the promotion, the reminder, the warning and the expiry are
arms inside `start-formatted-version.ts`, `confirm-schedule.ts` and
`expire-stale-member-approvals.ts`, not modules of their own) · **20 route paths** in § Project
Structure = **12 new handlers** + **8 existing handlers widened or extended** (`inline-image-upload`,
`broadcasts/[id]`, `broadcasts/[id]/cancel`, `admin/…/[id]/reject`, `admin/…/[id]/cancel`, the two
cron routes, the gauges route). The earlier flat "16 route handlers" matched neither number
(round 4 L2) · **1 new page** (`settings/broadcasts/brand`) + **2 rebuilt surfaces**
(the member sign-off view of `/portal/broadcasts/[id]`, the staff queue) + **1 filter preset**
(upcoming sends, a URL preset on the existing queue — round 5 A9) + 6 other changed screens ·
5 email templates × 3
locales · ~185 i18n keys × 3 · 4 gauges + 6 counters + 2 histograms + 3 alerts · 8 new ports ·
12 live-Neon integration suites · 1 env flag · ~34 test files. SweCham today:
~150 members, Resend Free plan (1,000 contacts / 3 segments), ≤ 2 broadcasts in flight, 500
recipients per tick

## Constitution Check

*GATE: evaluated against Constitution v1.4.2 (all 10 principles) — pre-Phase-0 PASS, re-checked
post-Phase-1 design (§ Post-Design Re-check). One documented deviation (solo-maintainer review
substitute) in § Complexity Tracking.*

**NON-NEGOTIABLE gates**:

- [x] **I. Data Privacy & Security** — New processing: E-Blast **versions** (subject + body, which
      may name individuals), marketing's **note to the member**, the member's **decision reason**,
      the identities of the authoring staff user and the deciding member contact, and **staff-uploaded
      images**. Lawful basis: performance of the membership contract — delivery of the E-Blast
      benefit (TH PDPA § 24(3), GDPR Art. 6(1)(b)); retention follows the parent E-Blast record
      (`broadcasts.retention_years` = 5, `schema.ts:231`). Purpose limitation: version and decision
      rows are read only by the two review surfaces, the five emails and the dashboard.
      Minimisation — audit payloads carry `broadcast_id`, `version_id`, `round`, `decision` and
      `reason_length`, **never the reason or the content**; outbox `context_data` carries ids only
      and the dispatcher renders at send time (R14, the F114 precedent at
      `outbox-dispatch/route.ts:415-542`). Erasure reaches every version, every decision reason,
      every image **and every notification about the E-Blast** — an unsent outbox row carries ids
      only and therefore renders the redacted rows, and its pending rows are cancelled in the same
      transaction (R17: the scrub port joins the existing atomic erasure tx alongside
      `scrubContentForMemberInTx`, `drizzle-broadcasts-repo.ts:1362-1412`, which has no status
      predicate and therefore already covers the new stages; images are marked and then deleted by
      a last-reference rule). DSAR export gains the versions/decisions section.
      **RBAC**: every staff route names `broadcasts.read` / `broadcasts.write` / `broadcasts.send` /
      `settings.broadcasts` via `requireApiPermission`; every staff page uses
      `requirePagePermission` (so `check:staff-page-guard` and `check:api-route-guard` see them);
      member routes use `requireMemberContext` **plus** an owning-member check, so a staff session
      can never give the member-side approval (FR-013). `settings.invoicing` (super-admin only,
      `permission-catalogue.ts:98`) is never widened — the Brand page only READS the logo
      (FR-041b) and a contract test asserts no `settings.broadcasts`-reachable route writes it.
      **OWASP**: broken access control (per-route permission + baseline pins), IDOR (member routes
      404 outside the caller's member; misses audited `broadcast_cross_member_probe` /
      `broadcast_cross_tenant_probe`), injection (Drizzle parameters; reasons rendered escaped,
      never as markup), XSS (content passes the single shared sanitiser policy; design-block markup
      is generated **after** sanitisation and never round-trips through it), SSRF (image sources
      keep the per-tenant allowlist; the logo is resolved through a module interface from the blob
      already on file, never from a user-supplied address), abuse (per-actor rate buckets on
      preview / test-copy / decision routes). TLS 1.2+ and Neon AES-256 at rest — unchanged.
      **Tenant isolation, all five v1.4.0 sub-clauses**:
      (1) *application* — every repo method takes the `tx` from `runInTenant(ctx, tx => …)`; no
      method reaches for the pool-global `db` (the F7.1a US2 incident rule);
      (2) *database* — `broadcast_versions`, `broadcast_member_decisions`, `broadcast_images` each
      get `ENABLE` + `FORCE  ROW LEVEL SECURITY` and the canonical 0064 policy
      (`USING/WITH CHECK tenant_id = current_setting('app.current_tenant', TRUE)`), and all three
      **plus the pre-existing `tenant_broadcast_settings`** are registered in
      `scripts/check-multi-tenant-ready.ts` `SCOPED_TABLES:77-80`;
      (3) *test* — a two-tenant probe integration test per new table, reads **and** writes in both
      directions, listed in tasks.md and a Review-Gate blocker (quickstart § 2);
      (4) *audit* — the deny path emits `broadcast_cross_tenant_probe` (already in the DB enum), and
      the within-tenant cross-member deny path emits `broadcast_cross_member_probe`;
      (5) *super-admin* — no bypass is introduced; `hasPermission` keeps its `super_admin`
      early-return (`evaluator.ts:80`) and no route reads `ROLE_BUNDLES` directly.
      `security-engineer` + `pdpa-gdpr-compliance-officer` sign at the Review gate; the record of
      processing is updated before the flag is flipped (quickstart § 3).
- [x] **II. Test-First Development** — Each user story's first task is its RED acceptance test:
      US1 format → send → approve → confirm → delivered-content-equals-approved-version
      (integration); US2 request-changes-without-reason refused + round 2 + withdraw-approval
      (integration); US3 element-parity editor→preview→test copy→delivered (contract, SC-011) and
      the alt-text gate (unit); US4 per-stage counts + whose-turn + stalled + upcoming (contract);
      US5 marketing notified on submit + exactly one reminder per threshold + never auto-approved
      (integration, with the clock injected through `ClockPort`); US6 template-picker confirm +
      dirty-state + announced editor error (unit/e2e); US7 flag OFF → today's flow byte-identical
      and an in-flight new-stage row still completable (contract). The FR-012a trigger test is RED
      before the migration is written: a direct `UPDATE broadcasts SET subject/body_html/
      scheduled_for` on every non-exempt transition must still raise
      `broadcast_immutable_after_submit`. Coverage: Domain 100% line (stage map, turn map,
      transitions, design-block serialiser/renderer, contrast helper, in-progress status set);
      Application 80% line + branch, with **100% branch** pinned in `vitest.config.ts` on the six
      security-critical use cases (`startFormattedVersion`, `sendVersionToMember`,
      `recordMemberDecision`, `confirmSchedule`, `promoteApprovedVersion`, `setBrandSettings`) —
      which live in **five files**, because `promoteApprovedVersion` is not its own module: it is the
      promotion arm inside `confirm-schedule.ts` (research R20 corrected; pinning a path that does
      not exist is silently satisfied, so the pin would stop measuring anything).
      **Every pin lands in the PR that creates the file it names**: T157 pins PR-1's four Domain
      files and `set-brand-settings.ts`; T157a pins PR-2's seven Domain files; T158 pins the four
      approval use cases; T158a then asserts all **sixteen** pins resolve to real paths — **eleven Domain
      100 %-line pins** (four from T157, seven from T157a) **and five Application 100 %-branch pins**
      (`set-brand-settings.ts` from T157, plus T158's four approval use cases). The total was written
      as "twelve" here and in T158a while the enumeration summed to sixteen
      (`/speckit.analyze` round 3 H7). A pin on a file a later PR creates fails the required
      `Unit + contract coverage vs pinned thresholds` check (`/speckit.analyze` H2/H6).
      A pinned file is measured with `--coverage --coverage.include=<file>` before pushing.
- [x] **III. Clean Architecture** — **Domain** (`src/modules/broadcasts/domain/**`, zero framework
      imports): the widened status tuple + transition policy, `BroadcastStage` + `stageOf` +
      `turnOf`, `IN_PROGRESS_BROADCAST_STATUSES` (the single source for the allowance bucket and
      the cancel cascade — the Finding-G derivation pattern already used for
      `TERMINAL_BROADCAST_STATUSES`), the version/decision aggregates and their invariants, the
      design-block serialiser/renderer, the WCAG contrast helper, the reminder/expiry schedule
      policy. **Application**: use cases orchestrate through ports — new
      `BroadcastVersionsRepo`, `BroadcastDecisionsRepo`, `BroadcastImagesRepo`,
      `BrandSettingsRepo`, `MarketingDirectoryPort`, `TenantLogoUrlPort`, `TestCopyMailerPort`,
      **`BroadcastApprovalScrubPort`** (the erasure reach into versions, decisions and images —
      T082; it was missing from this inventory and from T159's fakes list, so the one port that must
      reach every version, reason, note and image would have gone unstubbed);
      existing `AuditPort`, `EmailTransactionalPort`, `ClockPort`, `ImageStoragePort` (widened with
      `delete`), `HtmlSanitizerPort`. **Eight new ports and one widened** — PR-1 introduces four new
      (`BroadcastImagesRepo`, `BrandSettingsRepo`, `TenantLogoUrlPort`, `TestCopyMailerPort`) and
      widens `ImageStoragePort`; PR-2 introduces the other four (`BroadcastVersionsRepo`,
      `BroadcastDecisionsRepo`, `MarketingDirectoryPort`, `BroadcastApprovalScrubPort`). The earlier
      "eight new ports … five by PR-1 and four by PR-2" counted the widened port as a new one and
      summed to nine (`/speckit.analyze` round 3 L3). That five/four split is why the fakes helper is
      split T159 / T159a — T159 stubs the four new PR-1 ports **and** the widened method. No ORM/HTTP/React import. **Infrastructure**: Drizzle repos
      threading `tx`, the Resend wrapper, the blob adapters — Drizzle-inferred types never leave.
      **Presentation**: pages and route handlers call use cases through
      `src/modules/broadcasts/index.ts` only (97 exports today). Two seams are composed in
      `src/lib/`, the sanctioned pattern (108's `contact-marketing-deps.ts`, 114's
      `members-change-request-deps.ts`): `src/lib/broadcast-marketing-deps.ts` (marketing roster
      over the cross-tenant `users` table) and `src/lib/broadcast-brand-deps.ts` (the invoicing
      logo-URL read). The shared sanitiser policy lives in `src/lib/broadcast-content-policy.ts` —
      a pure, import-free data module readable by the client editor, the client preview and the
      server sanitiser alike, so Presentation never deep-imports Domain (R9; `src/lib/email-brand.ts`
      is the existing precedent for email/brand policy in `src/lib`).
- [x] **IV. Payment Security (PCI DSS)** — No payment surface, no card data, no invoice or tax
      document is created or changed. SAQ-A scope unchanged. The only adjacency is that the Brand
      page **reads** the logo that prints on tax documents; FR-041b forbids any write path from the
      E-Blast settings permission and a contract test proves it, so the super-admin-only control of
      a tax-document asset is preserved.

**Core principle gates**:

- [x] **V. Internationalization (EN/TH/SV)** — ~185 keys × 3 locales: 5 new stage labels in **both**
      `admin.broadcasts.queue.status` and `portal.broadcasts.list.status` (en.json:3214-3225 and
      6014-6025, mirrored at the same lines in th/sv); the new toolbar and block controls; the
      preview dialog; the member sign-off screen; the brand settings page; 14
      `audit.eventType.broadcast_*` labels (Thai script asserted by
      `audit-event-label-coverage.test.ts:107`); 5 email templates × 3. `check:i18n` gates; dead keys
      listed in exploration § B are deleted in PR-1 (FR-051). Send times render in the tenant time
      zone through the existing `bangkok-datetime.ts` helper; BE display-only for `th-TH`; italic is
      hidden when the interface locale is Thai (FR-044, and no italic on Thai anywhere).
- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — Designs start at 320 px: the widened
      toolbar **wraps onto further rows, with no overflow menu** — FR-048 decides the shape, and the
      live look on the dev server confirms the **row count** rather than choosing between wrap and
      overflow (exploration § C); the compose page becomes a two-column 72 rem layout ≥ lg and stacks
      below (FR-050, with the `docs/ux-standards.md` § 18.2 container exception recorded **in the
      same change**); the preview dialog offers desktop **600 px** and phone **375 px** widths,
      returns focus to its trigger (`finalFocus` on every dialog) and respects reduced-motion
      (FR-043); the toolbar adopts the APG roving-tabindex pattern **with Home/End and a visible
      focus state** (FR-048); the stalled flag carries an icon **and** a text label in its accessible
      name, never colour alone (FR-027); the body error is
      announced through the `TiptapEditor` `invalid`/`describedById` props that already exist
      (`tiptap-editor.tsx:106,113`) instead of the wrapper div; alt text is required before an image
      can be inserted (FR-040); every E-Blast route gains `error.tsx` and a skeleton shaped like the
      real page (FR-047); design blocks degrade to a plain link and a plain image (FR-042). axe at
      320 px on every E-Blast surface (`@a11y`), zero serious/critical (SC-013);
      `enterprise-ux-designer` pass on every UI-touching PR.
- [x] **VII. Performance & Observability** — Budgets in Technical Context. Logs: pino with
      `requestId`, `tenantId`, hashed user id, `broadcastId`, `versionId`, `round`; **never**
      subject, body, note or reason; failures carry `err: errKind(e)`; every fault arm names itself
      `M119.<route>.<arm>`. Metrics: 4 gauges + **6** counters + 2 histograms (contracts § 4.2 — the
      sixth is `broadcasts_version_saved_total`, emitted by the save path and previously named only
      in the admin route contract, so it would have shipped unregistered; `/speckit.analyze` M2).
      **Every registration lands in the PR that emits it**: `broadcasts_preview_rendered_total`,
      `broadcasts_preview_render_ms` and the `broadcasts.preview.render` span are registered by
      **T122a in PR-1**, because T032 emits them there and an emit against an unregistered field does
      not typecheck; T122 registers the other five counters, the decide histogram and the remaining
      three spans in PR-2 (`/speckit.analyze` round 3 C1). The
      gauges emitted from the existing broadcasts half of
      `/api/internal/metrics/broadcasts-gauges` (no new cron); **3** alerts — two bound to the
      awaiting-member oldest age (7 d warning / 14 d page, both inside the 30-day expiry clock)
      and one on `broadcasts_no_marketing_recipient_total > 0` (page), matching
      `contracts/dashboard-and-notifications.md` § 4.3.
      OTel spans `broadcasts.version.send`, `broadcasts.member.decide`,
      `broadcasts.schedule.confirm`, `broadcasts.preview.render` (T122, contracts § 4.4),
      attributes limited to ids, stage and round.
      `docs/observability.md` § 28 (the file ends at § 27, line 2205).
      **The budgets above are measured once, by T160a, and written into § 28 with their numbers** —
      a budget that is not met is recorded as UNVERIFIED with the measured value and the date, never
      dropped and never restated as if it had passed. Without that task nothing in this feature
      measures them, which is how F7's SLO budgets became permanently unverified
      (`/speckit.analyze` M12).
- [x] **VIII. Reliability** — Error paths enumerated per route in `contracts/` (403 / 404 / 409 /
      413 / 415 / 422 / 429 / 503 arms). Transactions: each state change is ONE
      `runInTenant` — re-read the broadcast `FOR UPDATE`, re-check the stage, write the version or
      decision, transition, `AuditPort.emit` and `EmailPort.enqueue` on the same tx, with
      throw-to-rollback (`return err()` inside the callback would COMMIT). Idempotency: the stage +
      version id **is** the key — a repeated approve on a row no longer in
      `awaiting_member_approval` answers 409 `stage_changed` with the recorded decision, so no
      `Idempotency-Key` reservation is introduced on these routes (which also keeps them working in
      CI smoke, where there is no Redis). Optimistic concurrency on version saves
      (`expectedUpdatedAt` → 409 `version_changed`, FR-033 / the "two marketing users" edge case).
      Read-only mode → 503 through the proxy. Audit entries listed in
      `contracts/dashboard-and-notifications.md` § 2. The five new `notification_type` values each
      get a dispatcher arm in the same PR — the `default:` arm returns `null`
      (`outbox-dispatch/route.ts:543`), which retries for ~16 h before permanently failing, so an
      arm-less enqueue is a silent 16-hour outage rather than a loud one; a contract test asserts
      every new type has an arm.
- [x] **IX. Code Quality Standards** — TS strict, ESLint clean, Conventional Commits with
      `[Spec Kit]` on gate commits, commitlint header ≤ 100 chars; `pnpm typecheck` **and** full
      `pnpm lint` as the last step before every commit (neither is in a gate). Review: member
      approval semantics + PII + audit + a live-email surface ⇒ ≥ 2 reviewers by default →
      **solo-maintainer substitute** (Complexity Tracking #1).
- [x] **X. Simplicity (YAGNI)** — Reuses: the `broadcasts` record, the review queue and its shared
      table primitive / mobile card list / bulk bar / single live region, the content-safety rules,
      the delivery path, the allowance rules, the outbox + dispatcher, the audit trail, the
      existing `ReasonConfirmationDialog`, `ageBadge`, `QueueFilters`' derivation from
      `OFFERED_BROADCAST_STATUSES`, the existing image upload pipeline, the existing gauges tick and
      the existing daily broadcasts cron. **Not built**: a parallel content-request system, a new
      module, a new permission key, a per-tenant approval setting, autosave, a text diff, a
      comment thread, member editing of the formatted version, open/click analytics, text
      alignment, a colour/font picker, raw HTML paste, tables, embedded video (all in spec
      § Out of scope). Zero new npm dependencies.

## Project Structure

### Documentation (this feature)

```text
specs/119-eblast-approval-workflow/
├── spec.md                                   # clarified ×4 + panel-amended
├── exploration-2026-09-18.md                 # code-level audit + panel carry-forwards
├── plan.md                                   # this file
├── research.md                               # Phase 0 — R1–R24 + V1–V5 verify-before-task items
├── data-model.md                             # Phase 1 — tables, stages, state machine, enums
├── contracts/
│   ├── portal-eblast-approval-api.md         # member: versions, approve, request changes, withdraw, test copy
│   ├── admin-eblast-formatting-api.md        # staff: start/save/send version, confirm schedule, images, brand
│   └── dashboard-and-notifications.md        # queue filters/columns, gauges, notifications, audit, cron
├── quickstart.md                             # validation walkthroughs, migration steps, flag matrix, UAT
├── uat-walkthrough-en.md                     # FR-035 — SweCham trial script, EN (written in PR-2, T153)
├── uat-walkthrough-th.md                     # FR-035 — SweCham trial script, TH (written in PR-2, T153)
└── tasks.md                                  # /speckit.tasks output — NOT created here
```

### Source Code (repository root)

```text
src/modules/broadcasts/
├── domain/
│   ├── value-objects/broadcast-status.ts        # +5 statuses; expired_no_member_response joins TERMINAL_*
│   ├── policies/broadcast-status-transitions.ts # +6 CASE arms (mirrors the DB trigger)
│   ├── policies/cancel-cutoff-policy.ts         # :47,49 → IN_PROGRESS_BROADCAST_STATUSES (T081)
│   ├── invariants/one-active-broadcast-state.ts # +5 keys in the Record<status, FieldRule[]>
│   ├── broadcast.ts                             # BroadcastPhase union + phaseOf switch +5 arms
│   ├── stage/
│   │   ├── broadcast-stage.ts                   # BroadcastStage tuple + stageOf(status) (FR-019)
│   │   ├── whose-turn.ts                        # turnOf(status): 'marketing'|'member'|null — no 'system' (FR-026)
│   │   └── in-progress-statuses.ts              # IN_PROGRESS_BROADCAST_STATUSES — allowance bucket AND cancel cascade
│   ├── approval/
│   │   ├── broadcast-version.ts                 # version aggregate + invariants (read-only once sent)
│   │   ├── member-decision.ts                   # approved | changes_requested | approval_withdrawn
│   │   └── approval-schedule-policy.ts          # day 3 / 7 reminders, day 23 warning, day 30 expiry
│   ├── design-blocks/
│   │   ├── block-markers.ts                     # data-eb="cta" | "banner" serialisation + parser
│   │   └── render-blocks.ts                     # platform-owned markup, generated AFTER sanitisation
│   └── brand/
│       ├── brand-settings.ts                    # primary colour + postal address value objects
│       └── contrast.ts                          # WCAG 2.1 relative luminance + ratio (pure, no dep)
├── application/
│   ├── ports/
│   │   ├── audit-port.ts                        # F7_AUDIT_EVENT_TYPES 55 → 69 (static assert :234)
│   │   ├── broadcast-versions-repo.ts           # new
│   │   ├── broadcast-decisions-repo.ts          # new
│   │   ├── broadcast-images-repo.ts             # new
│   │   ├── broadcast-approval-scrub-port.ts     # new — erasure reach: versions, decisions, images (T082)
│   │   ├── brand-settings-repo.ts               # new
│   │   ├── marketing-directory-port.ts          # new — active users holding broadcasts.write, minus admin tiers
│   │   ├── tenant-logo-url-port.ts              # new — READ-only public URL of the invoice logo
│   │   ├── test-copy-mailer-port.ts             # new — synchronous, non-durable. V4 RESOLVED: over the shared
│   │   │                                           #   transactional sender (auth/…/email/resend-client.ts); NO 6th notification_type
│   │   └── image-storage-port.ts                # + delete(key|url) ONLY (T034); the last-reference rule reads broadcast_images
│   └── use-cases/
│       ├── approval/
│       │   ├── start-formatted-version.ts       # submitted|changes_requested → in_design (+ materialise v0)
│       │   ├── save-formatted-version.ts        # optimistic concurrency on expectedUpdatedAt
│       │   ├── send-version-to-member.ts        # in_design → awaiting_member_approval
│       │   ├── record-member-decision.ts        # approve | request changes | withdraw approval
│       │   ├── confirm-schedule.ts              # member_approved → approved (+ promotion, FR-012a)
│       │   ├──                                  # voiding an approval is an ARM INSIDE start-formatted-version.ts (round 3 M8)
│       │   ├── list-broadcast-versions.ts       # history for both sides (FR-032)
│       │   └── expire-stale-member-approvals.ts # reminders + day-23 warning + day-30 expiry (cron)
│       ├── render-broadcast-preview.ts          # the send-time wrapper, for the preview surfaces
│       ├── send-test-copy.ts                    # FR-037 — requester's own address only
│       ├── set-brand-settings.ts                # colour + address; contrast-refused; audited {previous,next}
│       ├── get-brand-settings.ts                # + read-only logo URL + "address missing" flag
│       ├── upload-inline-image.ts               # + owner {broadcast|template}; records broadcast_images
│       ├── reclaim-orphaned-images.ts           # last-reference blob sweep (cron)
│       ├── scrub-broadcast-content-for-member.ts# + versions, decisions, images (FR erasure reach)
│       ├── cancel-in-flight-broadcasts-for-member.ts # widened to IN_PROGRESS_BROADCAST_STATUSES
│       ├── submit-broadcast.ts                  # + enqueue eblast_submitted_marketing IN the submit tx (T129)
│       ├── proxy-submit-broadcast.ts            # same enqueue on the staff proxy path (T129)
│       └── compute-quota-counter.ts             # bucket widened via the same Domain const
├── infrastructure/
│   ├── schema.ts                                # pgEnum +5; broadcasts +6 cols; tenantBroadcastSettings +4 cols
│   ├── db/
│   │   ├── drizzle-broadcast-versions-repo.ts   # new
│   │   ├── drizzle-broadcast-decisions-repo.ts  # new
│   │   ├── drizzle-broadcast-images-repo.ts     # new
│   │   ├── drizzle-brand-settings-repo.ts       # new
│   │   ├── drizzle-broadcasts-repo.ts           # :384 + :1322 literals → the Domain const
│   │   └── drizzle-broadcast-approval-counter.ts# :24 'submitted' → the marketing-turn set (T132)
│   ├── resend/email-template.ts                 # logo header, brand footer address, applyDesignBlocks
│   ├── email/broadcast-approval-emails.ts       # 5 templates × 3 locales
│   ├── sanitizer/dompurify-sanitizer.ts         # reads the shared policy; +data-eb
│   ├── rate-limiter.ts                          # :14 — the staff 30/60s and member 60/min buckets ride it (T026a, T062a)
│   ├── tiptap-cta-button-config.ts              # new Tiptap node (no new npm dep)
│   ├── tiptap-banner-image-config.ts            # new Tiptap node
│   └── feature-flags.ts                         # + isEblastMemberApprovalEnabled()

src/lib/
├── broadcast-content-policy.ts                  # the ONE sanitiser config (client + server) — SC-011
├── broadcast-marketing-deps.ts                  # marketing roster over auth users (III seam)
├── broadcast-brand-deps.ts                      # invoicing logo-URL read (III seam)
├── env.ts                                       # FEATURE_EBLAST_MEMBER_APPROVAL (zod boolean, default false)
└── metrics.ts                                   # broadcastsMetrics += 4 gauges, 6 counters, 2 histograms (two registered in PR-1 by T122a)

src/modules/invoicing/index.ts                   # + getTenantLogoPublicUrl (READ-only; FR-041b)

src/app/api/
├── broadcasts/preview/route.ts                  # POST — member
├── broadcasts/test-copy/route.ts                # POST — member
├── broadcasts/[id]/versions/route.ts            # GET — member: versions + decisions (own member only)
├── broadcasts/[id]/decision/route.ts            # POST — approve | request changes | withdraw approval
├── admin/broadcasts/preview/route.ts            # POST — staff
├── admin/broadcasts/test-copy/route.ts          # POST — staff
├── admin/broadcasts/[id]/version/route.ts       # POST start · PATCH save · GET current
├── admin/broadcasts/[id]/version/send/route.ts  # POST send to member
├── admin/broadcasts/[id]/schedule/route.ts      # POST confirm | change | cancel the confirmed time
├── admin/broadcasts/[id]/images/route.ts        # POST staff image (tied to this E-Blast)
├── admin/broadcasts/templates/[id]/images/route.ts # POST template image (FR-046a)
├── admin/broadcasts/brand/route.ts              # GET · PATCH (settings.broadcasts)
├── broadcasts/inline-image-upload/route.ts      # + real draft-ownership check (closes the :5 vs :76 gap)
├── broadcasts/[id]/route.ts                     # + subject/body (T141, PR-1); + workflow fields (T141a, PR-2)
├── broadcasts/[id]/cancel/route.ts              # member withdrawal widened to the in-progress set (T081)
├── admin/broadcasts/[id]/reject/route.ts        # marketing rejection widened to the in-progress set (T081)
├── admin/broadcasts/[id]/cancel/route.ts        # widened + NAMES broadcasts.write (it named no key) (T081)
├── cron/outbox-dispatch/route.ts                # + 5 buildPayload arms, one per new notification_type
└── cron/broadcasts/prune-expired-drafts/route.ts# + second block: reminders, expiry, image sweep
src/app/api/internal/metrics/broadcasts-gauges/route.ts  # + 4 gauges in the broadcasts half
src/modules/auth/infrastructure/db/schema.ts             # DB_ONLY_AUDIT_EVENT_TYPES += 14 (mandatory 5-place edit)
src/components/broadcast/status-badge-mapping.ts         # +5 status arms (compile-time exhaustive)
src/components/broadcast/compose-inline-image-uploader.tsx # wired into the proxy form (T145)
src/components/broadcast/compose/stale-draft-banner.tsx    # wired or deleted — never mounted today (T147)

src/app/(member)/portal/broadcasts/
├── [id]/page.tsx · loading.tsx · error.tsx      # + body, versions, compare + sign-off actions (FR-049)
└── new/page.tsx                                 # two-column layout, non-destructive template pick

src/app/(staff)/admin/
├── broadcasts/page.tsx · loading.tsx · error.tsx        # stage chips + counts, whose turn, round, upcoming preset
├── broadcasts/[id]/page.tsx · loading.tsx · error.tsx   # version thread, formatting entry, schedule confirm
├── broadcasts/new/page.tsx                              # proxy form parity (FR-039)
├── broadcasts/templates/**                              # error.tsx, shared empty state, block-capable editor
└── settings/broadcasts/brand/page.tsx · loading.tsx · error.tsx   # FR-041b

src/components/broadcast/
├── tiptap-toolbar.tsx                           # headings, quote, divider, image, CTA, banner; roving tabindex
├── tiptap-editor.tsx                            # shared policy, alt-text dialog, block nodes
├── preview-pane.tsx                             # real wrapper via the preview route, empty state
├── preview-dialog.tsx                           # new — desktop/phone widths, finalFocus
├── compose/template-picker.tsx                  # confirm when dirty (BLOCKER #1)
├── compose-form.tsx · proxy-compose-form.tsx    # saved-snapshot dirty state, describedById, parity
├── approval/version-thread.tsx                  # new — rounds, notes, decisions (both sides)
├── approval/member-sign-off-actions.tsx         # new — approve / request changes / withdraw
├── approval/schedule-confirm-dialog.tsx         # new — proposal pre-selected, difference called out
├── admin/queue-table*.tsx · queue-filters.tsx   # stage chips, whose turn, time in stage, round
└── brand/brand-settings-form.tsx                # new — colour with live contrast check, address

src/config/nav.ts                                # Settings → "E-Blast brand"; marketing count badge (FR-023)
src/app/(staff)/admin/settings/page.tsx          # + CATEGORIES card for the Brand page
src/i18n/messages/{en,th,sv}.json                # stage labels ×2 namespaces, 14 audit labels, 5 emails, UI
drizzle/migrations/0304_eblast_images_and_brand.sql          + meta/_journal.json (idx 305)
drizzle/migrations/0305_eblast_member_approval.sql           + meta/_journal.json (idx 306)
                                                 # BOTH backfills precede the CREATE OR REPLACE of the immutability fn
scripts/check-multi-tenant-ready.ts              # SCOPED_TABLES += 4 (3 new + tenant_broadcast_settings)
scripts/lib/enum-migration-guard.ts              # REQUIRED_ENUM_VALUES: NEW broadcast_status key ×5; audit ×14; notification ×5
scripts/reset-broadcast-quota.ts                 # :68-73 operator in-flight set widened by the shadow sweep (T051)
scripts/inventory-broadcast-outbox.ts            # :115,126 same — a report that hides five stages is worse than none (T051)
docs/observability.md                            # § 28
docs/changelog.md                                # one entry per PR, with PR number + review-round provenance (T163)
docs/ux-standards.md                             # § 18.2 container-tier exception for the compose width (FR-050, PR-1)
docs/compliance/processing-records.md            # RoPA: new fields, staff recipients, postal address (precondition of the flag flip)
docs/runbooks/eblast-approval.md                 # stuck stage, expiry, flag rollback, image sweep

tests/
├── helpers/eblast-approval-fakes.ts             # in-memory doubles for EVERY new port (an unstubbed method is an unexercised branch)
├── unit/broadcasts/domain/                      # stage map, turn map, transitions, blocks, contrast, schedule policy
├── unit/broadcasts/application/                 # the 6 pinned use cases + the rest
├── unit/broadcast/                              # toolbar a11y, template-picker confirm, preview dialog, brand form
├── contract/broadcasts/                         # every route × role × flag state; brand-cannot-write-logo; notification arms
│   └── eblast-flag-matrix.test.ts               # the PR-2 merge gate — T149/T150 create it, T152a adds the drainer-skip arm
└── integration/broadcasts/
    ├── eblast-approval-tenant-isolation.test.ts # Constitution I.3 — 3 tables, both directions
    ├── eblast-approval-cross-member-probe.test.ts
    ├── eblast-immutability-trigger.test.ts      # FR-012a — direct edits still refused
    ├── eblast-state-machine-edges.test.ts       # the full new edge matrix at the DB
    ├── eblast-allowance-bucket.test.ts          # FR-020 / SC-007 across all in-progress stages
    ├── eblast-erasure-reach.test.ts             # seeded at "Awaiting member approval"
    ├── eblast-content-parity.test.ts            # SC-011 element-by-element
    ├── eblast-dashboard-pagination.test.ts      # SC-008 at 1,000 rows
    ├── eblast-approval-happy-path.test.ts       # US1 end to end — delivered == approved version (T038)
    ├── eblast-approval-rounds.test.ts           # US2 round 2 + the ordered thread (T069)
    ├── eblast-submit-notifies-marketing.test.ts # US5 roster + admin fallback + empty-roster counter (T123)
    └── audit-event-type-parity.test.ts          # tuple <-> pg_enum on the broadcast_ prefix (T022/T050)
                                                 # TWELVE suites in all — quickstart § 2 and T165's PR-2 list run every one;
                                                 # T165's PR-1 list is the three PR-1 creates (round 3 M1)
tests/e2e/broadcasts/eblast-approval.spec.ts     # @eblast, @i18n — always --workers=1
tests/e2e/broadcasts/eblast-a11y.spec.ts         # @a11y axe at 320 px — T139 (PR-1) and T086a (PR-2)
```

**Structure Decision**: one feature, one existing bounded context. `src/modules/broadcasts` already
owns the aggregate, its state machine, the delivery path and the allowance accounting, so versions,
decisions, images and brand settings are extensions along the module's existing seams (Domain
policy → Application use case + port → Infrastructure Drizzle/Resend/Blob adapter), with
presentation in the two existing route groups plus one new settings page. The two cross-module
needs — enumerating marketing users from the cross-tenant `users` table, and reading the invoicing
logo's public URL — are ports implemented in `src/lib/*-deps.ts` composition files, the pattern 108
and 114 established. No new module, no new package, no new npm dependency.

## Delivery slicing

The spec's § Assumptions proposes tool + fixes first, then the approval round, then the dashboard.
**Confirmed, with two amendments.**

| PR | Scope | Flag | Migration | Rationale |
|---|---|---|---|---|
| **PR-1** — Writing tool + screen standard | US3 + US6. Shared sanitiser policy; toolbar (headings, quote, divider, image, CTA, banner) with roving tabindex and no italic on Thai; required alt text; real preview (route + wrapper + inline empty state + dialog with desktop/phone widths); design blocks + the post-sanitise renderer; brand settings page, columns and the read-only logo URL; staff + template image routes, `broadcast_images` and its lifecycle; member-route draft-ownership check; **the staff compose-on-behalf draft route (`POST \| PUT /api/admin/broadcasts/draft`) and the proxied-member allowance read (`GET /api/admin/broadcasts/quota?memberId=`)** (T145, Amendment 9); proxy-form parity; template-picker confirmation; dirty-state fix; `error.tsx` ×5; dead i18n removal; compose layout; the member detail **subject + body** (the FR-049 half that needs no `0305` column); the FR-051 pass on the **seven screens PR-1 builds** (Amendment 4) | **none** (live on merge, spec § Feature flag) | `0304` | The approval round is pointless without the tool (spec § Clarifications 2026-09-18), and SweCham must not test the trial on the defects the audit found. It is also the largest independent value: every E-Blast improves immediately. |
| **PR-2** — Approval round + dashboard + trial | US1 + US2 + US5 + **US4 + US7** (Amendment 8 — the former PR-3 is folded in here). Status widening + the full shadow sweep; `broadcast_versions` + `broadcast_member_decisions`; the FR-012a migration (enum, immutability trigger, state machine, `proposed_send_at` **backfilled before the function is replaced**, `stage_entered_at` backfilled from `submitted_at`, the reservation and cascade sets); staff format/send routes; member sign-off screen and routes; schedule confirm; the `in_design` widening of the staff image route (T106a); **the flag gate on the `submitted → in_design` EDGE and its two-state contract suite (T152 + T149/T150 — Amendment 7)**; **10** audit events (the other 4 landed with `0304` in PR-1, so 14 in all); 5 notification types + dispatcher arms + the 5 email templates × 3 locales + the marketing roster; reminders / warning / expiry in the daily cron; erasure reach; the approval i18n namespaces (T006a); the PR-2 write rate buckets (T062a); **the dashboard**: stage chips with counts, whose-turn / time-in-stage / round columns, stalled flag, upcoming-sends preset, delivery results, the status→**stage** vocabulary relabel **and the five new stage labels** (T120), the nav count (FR-023), 4 gauges + 5 of the 6 counters + 1 of the 2 histograms + **3** alerts, `docs/observability.md` § 28 and the one-off budget measurement recorded into it (T160a), the runbook; **the trial**: the EN + TH UAT walkthrough (FR-035) and the rollback-matrix walk; the FR-051 pass on `/admin/broadcasts/[id]`, the sign-off view of `/portal/broadcasts/[id]` **and the rebuilt staff queue** (T086a) | `FEATURE_EBLAST_MEMBER_APPROVAL` **gates the entry edge — and the five hand-off emails at the drainer (T152a, round 4 H2) — and the gate ships in this PR**; chip and nav-badge visibility follow the flag **or** the presence of rows (T151/T116) | `0305` | US1 is not shippable without US2 (spec's own reasoning), and US5's hand-off notifications are what make a two-sided flow not stall. US4 and US7 join them because a dark approval round whose dashboard, stage labels, metric registrations, runbook and UAT script arrive a PR later cannot be observed, cannot be trialled, and puts five defects across the boundary (Amendment 8). |

**Amendment 1 — the stage-vocabulary relabel stays out of PR-1.** `approved` is today labelled
"Approved" in both status namespaces; FR-019 names that stage **Scheduled**. Relabelling in PR-1
would change live copy before the stages it belongs to exist, so it ships in **PR-2** with the
dashboard that introduces the vocabulary. **The five new stage labels ship there too, and PR-2's own
screens depend on them**: T063's stage header, T085's thread, T084's sign-off and T141a's
`stage`/`whoseTurn` all render `stageOf(status)`, and next-intl does not throw on a missing key, so
they would have read raw key paths had T120 stayed a PR behind (`/speckit.analyze` round 3 C2 —
closed by folding the former PR-3 into PR-2; the ordering **inside** PR-2 is recorded in tasks.md
§ Phase dependencies).

**Amendment 2 — PR-1 carries a byte-identical wrapper guard.** PR-1 is unflagged and changes
`renderBroadcastHtml`, which every live SweCham send uses. A snapshot test asserting that, with no
brand colour, no postal address, no logo on file and no design block in the body, the rendered HTML
is **byte-identical** to today's output is a merge blocker for PR-1. Without it the tool upgrade is
an unreviewable change to production email. **This is no longer only a plan amendment**: spec
§ Feature flag now states it as a requirement ("that snapshot test is a merge blocker for the
unflagged tool upgrade"), so the gate is owned by the spec and the amendment merely records where in
the delivery it lands.

**Amendment 3 — PR-1 also lands two docs changes.** FR-050 requires the compose width's departure
from the form container tier to be recorded as an exception in `docs/ux-standards.md` § 18.2 **in the
same change**, and FR-051 requires the UX/a11y pass (`docs/ux-standards.md` § 15 +
the `@a11y` axe suite, dead i18n keys removed, unshown components wired or deleted) before the trial.
Both are PR-1 merge gates, listed in `quickstart.md` § 3.1.

**Amendment 4 — the FR-051 pass is taken where each screen is built, and the split is stated by
screen identity, not by a count.** FR-051 names nine screens. The earlier wording ("seven in PR-1,
two in PR-2") enumerated eight and summed to ten, because `/portal/broadcasts/[id]` was claimed by
both halves; `/speckit.analyze` M1 caught the arithmetic. The split is therefore:

- **PR-1 (T139 + T155)** — the **seven whole screens it builds**: portal compose · portal benefits
  E-Blast tab · staff queue · staff compose-on-behalf · template list/new/edit (one surface) ·
  E-Blast settings · Brand settings — **plus the body view of `/portal/broadcasts/[id]`**, which
  T141 builds in PR-1.
- **PR-2 (T086a)** — `/admin/broadcasts/[id]` (T063), which does not exist until PR-2 and is
  therefore scanned for the first time there; **the sign-off compare view of
  `/portal/broadcasts/[id]`** (T086), which PR-2 rebuilds; **and the staff queue**
  `/admin/broadcasts` with its filter bar, table, table-client and card list, which T116–T120 rebuild
  once US4 joins this PR (Amendment 8). PR-1's pass on the queue was taken on its pre-rebuild shape,
  and FR-051 requires the pass in **every** delivery that changes a screen, so PR-2 takes it again
  (`/speckit.analyze` round 3 H4).

`/portal/broadcasts/[id]` is scanned **once in each PR because each PR changes it**; that is the
rule (a screen takes the pass in every PR that changes it), not a double count. Gating PR-1 on
scanning screens PR-1 does not build would be an unsatisfiable merge gate; gating PR-2 on rescanning
a screen it rewrote is exactly the point. Same § 15 checklist, same axe scan, zero serious or
critical, both times. Spec § FR-051 now states this split, so it is owned by the spec.

**Amendment 5 — FR-049 splits across PR-1 and PR-2.** The member detail page must show the E-Blast's
subject and body (FR-049), which PR-1 can do from the record's own content. The rest of the widened
`GET /api/broadcasts/[id]` — `stage`, `whoseTurn`, `round`, `proposedSendAt`, `confirmedSendAt`,
`expiresAt`, and "the body shown is the latest **sent** version while awaiting the member" — depends
on `0305`'s columns, `broadcast_versions` and the Domain `stageOf`/`turnOf` maps, all of which are
PR-2. T141 therefore carries only the subject/body half in PR-1 and **T141a** carries the workflow
fields in PR-2, beside T087.

**Amendment 6 — the staff image route splits across PR-1 and PR-2 for the same reason.** The PR-1
row above claimed "staff + template image routes" outright, but `POST /api/admin/broadcasts/[id]/images`
was specified as accepting only stage `in_design` — a `broadcast_status` value migration `0305`
introduces in **PR-2**. In PR-1 that route could only ever answer 409, and its success path could
never go green, which would have left T096's positive assertion permanently unsatisfiable
(`/speckit.analyze` H1). The route therefore ships in PR-1 with the acceptance stage set
**`('draft','submitted')`**, which is what the staff **compose-on-behalf draft** needs and is the half
of US3-AS3 that PR-1 can honestly satisfy; **T106a** widens the set to include `in_design` in PR-2,
beside T062/T063, which is the half of US3-AS3 about formatting a member's submission. Template
images (T107) are unaffected — a template has no broadcast stage.

**Amendment 7 — the flag gate ships with the route it gates, and it gates an EDGE, not a route.**
T152 (the `isEblastMemberApprovalEnabled()` gate on `POST /api/admin/broadcasts/[id]/version`) and
its two-state contract suite T149/T150 were written into Phase 9 (US7) and therefore tagged PR-3,
while PR-2 was described as "ships dark behind `FEATURE_EBLAST_MEMBER_APPROVAL`". Those two
statements cannot both hold: PR-2 builds the entry route in T062, so without T152 in the same PR the
approval round is live in production for every `broadcasts.write` holder from the moment PR-2
deploys — on a tenant with real members — and "merge without setting the env var" protects nothing,
because nothing reads the flag. T063 hiding the button is not a gate (`/speckit.analyze` C1). The
three tasks keep their IDs and their place in the file (tasks.md § Ship order: ship order is not file
order) and are re-tagged **[PR-2]**; **T151**, the chip-visibility rule, is now [PR-2] as well, since
Amendment 8 brings its implementation T116 into the same PR. **The gate is edge-wide, not route-wide**
(`/speckit.analyze` round 3 H1): `POST …/[id]/version` answers 404 with the flag off **only when the
re-read row is `submitted`**. Re-entry from `changes_requested`, `member_approved` or `approved`
(round ≥ 1) stays available, because re-opening a working copy after the member asked for changes is
the only path by which an in-flight row can be **completed**, and FR-034 requires in-flight rows to
stay completable and not merely cancellable. A route-wide 404 would have dead-ended every row the
member had sent back. **PR-2 merge gate**: `eblast-flag-matrix.test.ts` green in both flag states,
with the `submitted` edge answering 404 when the variable is absent and the `changes_requested`
re-entry answering 201.

**The flag has a second effect, and it is not a transition: the five new hand-off emails are
behind it at the drainer** (maintainer decision, round 4 H2 — the F114 precedent at
`outbox-dispatch/route.ts`). `eblast_submitted_marketing` is the reason this had to be settled:
submit is an existing, unflagged action, so an unconditional drain would start emailing SweCham
marketing on every member submission the moment PR-2 deployed — new live behaviour from a PR that
is supposed to be dark, and a direct contradiction of FR-034's "behave as today". The resolution
keeps the write path flag-free: the enqueue is unconditional inside the state-changing transaction
(nothing branches on an env var where a rollback must be atomic), and the **drainer** skips the five
`notification_type` values while the flag is off. Rows accumulate and drain on the first tick after
the flip; a skipped row sets no `lastError`, counts no attempt and never reaches the
`no_template_handler` ladder. Built by **T152a**, RED in `eblast-flag-matrix.test.ts` beside
T149/T150.

**Amendment 8 — there is no PR-3: the dashboard and the trial merge into PR-2 (maintainer,
2026-09-18).** US4 and US7 shipped one PR behind the stages they report on and exercise, which put
five defects across the boundary at once: the metric registrations in `src/lib/metrics.ts` sat a PR
behind their emitters (round 3 C1), the five stage labels a PR behind the screens that render them
(C2), the FR-051 pass a PR behind the queue rebuild that invalidated it (H4), the flag flip was
scripted for a moment when neither the dashboard nor the runbook nor the UAT walkthrough existed
(M2), and T152's RED test sat a PR ahead of the gate it proves (M7). Folding the two stories into
PR-2 closes all five by construction rather than by cross-PR bookkeeping. **PR-1 is unchanged.** The
cost is a larger PR-2; the review substitute (Complexity Tracking #1) absorbs it because the agents
run per surface, not per PR. The one registration that still had to move the other way is the preview
counter and histogram, which T032 emits in **PR-1**: they are registered there by **T122a**, and
T122 registers the remaining five in PR-2.

**Amendment 9 (implementation, 2026-09-18) — FR-039's last three parity items needed two staff
routes the contract assumed but never defined.** `contracts/admin-eblast-formatting-api.md`
specifies `POST /api/admin/broadcasts/[id]/images` against "the staff **compose-on-behalf** draft",
and FR-039 asks the staff writing tool to offer "drafts, images … the member's allowance display".
Neither was reachable: **no route creates a staff-owned `draft`** — `proxy-submit` creates a
`submitted` row — and `GET /api/broadcasts/quota` resolves the member from the **session**, so a
staff user can never read the allowance of the member they are composing for. T137's three `it.todo`
named exactly these blockers. The contract was **incomplete, not wrong**: the Application layer
already supports both sides — `saveDraft` takes a `memberId` and `actorRole: 'admin_proxy'`, and
`computeQuotaCounter` takes a `memberId`. Closed in **T145** with two **thin** routes that reuse
those use cases unchanged, added to PR-1's route list and to the contract as their own sections:

- **`POST | PUT /api/admin/broadcasts/draft`** — `broadcasts.write` (NOT `proxy-submit`'s
  `broadcasts.send`: saving a draft is not sending), member named in the body and resolved through
  `proxy-submit`'s own member read (404 unknown / 409 erased), the staff 30 / 60 s write bucket above
  any read or write, and the **existing** `broadcast_drafted` audit carrying `actorRole:
  'admin_proxy'` — no new audit event type, no use-case change.
- **`GET /api/admin/broadcasts/quota?memberId=`** — `broadcasts.read`, the member from the query, the
  member route's envelope byte for byte so `QuotaDisplay` takes only an endpoint.

Both envelopes and the draft error mapping live in one shared module
(`src/lib/broadcasts-draft-response.ts`) which **both** the member and staff routes now use, and both
compose forms save through one shared client helper
(`src/components/broadcast/compose/save-compose-draft.ts`): FR-039 is a promise that the two tools
behave the same, so "the same" is enforced by shared code rather than by two copies agreeing today.
The frozen marketing-reachability pin in `tests/contract/rbac/role-endpoint-matrix.test.ts` moves
**57 → 60**.

**Submit in place**: `proxySubmitBroadcast` gains an optional `draftId`
(`src/modules/broadcasts/application/use-cases/proxy-submit-broadcast.ts`), threaded into the
delegate exactly as the member's `POST /api/broadcasts/submit` threads its own, so a staff draft that
is saved and then submitted is **updated + transitioned**, never left behind as a stranded `draft`
row beside a second `submitted` one. The delegate's per-member ownership check applies unchanged: a
`draftId` belonging to another member → `broadcast_not_found` (404, anti-enumeration).
`POST /api/admin/broadcasts/proxy-submit` accepts the optional uuid and the proxy form sends the
id it holds. Pinned by `tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts` (two
cases) and `tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts`.

## Complexity Tracking

| Violation / deviation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **#1 Gate 9 / Principle IX — solo-maintainer substitute for the ≥ 2 human reviewers** required on a PII + audit + member-approval surface | No second human reviewer is available on this repo (Constitution v1.4.1 / v1.4.2 precedent, and the F114 precedent at `specs/114-member-change-approval/plan.md` § Complexity Tracking #1) | Waiting for a second reviewer would block a feature SweCham is waiting to trial. The substitute is the 6 required CI checks plus named project-agent passes — `security-engineer`, `pdpa-gdpr-compliance-officer`, `reliability-guardian`, `drizzle-migration-reviewer`, `enterprise-ux-designer`, `senior-tester` — and a `whole-branch-reviewer` seam pass, with the security checklist co-signed by the staff-review agent and the maintainer |

No Principle I–IV, V–VIII or X deviation. Zero new npm dependencies, so Constitution X needs no
entry here; the design blocks are built on `@tiptap/core`, which is already an exact-pinned
dependency, and the WCAG contrast check is ~30 lines of pure Domain arithmetic rather than a colour
library.

## Post-Design Re-check (after Phase 1)

- **I** — `data-model.md` § 5 carries `ENABLE` + `FORCE  ROW LEVEL SECURITY` and the canonical 0064
  policy on all three new tables, plus their registration in `SCOPED_TABLES`; `contracts/` show
  ids-only audit payloads and ids-only outbox `context_data`; every route names its permission and
  its probe-audit event; the Brand page has no write path to the logo and a contract test says so.
  PASS.
- **II** — **`tasks.md` names the RED acceptance test per story** in each phase's "Tests first
  (write, observe RED)" block — T036/T038 (US1), T067/T069/T070 (US2), T088/T089 (US3),
  T109/T110/T111 (US4), T123/T124/T125 (US5), T133–T139 (US6), T149/T150 (US7). `quickstart.md` § 1
  is the **manual twin** of those tests, not a list of them, and § 2 the twelve live-Neon suites;
  `research.md` R20 pins the coverage targets and names the six 100%-branch use cases in five files.
  (The earlier citation pointed Principle II's evidence at quickstart § 1, which names no test file
  and has no US7 walkthrough at all — `/speckit.analyze` M9.) PASS.
- **III** — the source tree keeps Drizzle inside `infrastructure/`, ports in `application/ports`,
  pure policies in `domain/`; the two cross-module seams and the shared sanitiser policy are
  composed in `src/lib/`, so no Presentation file imports Domain or Infrastructure. PASS.
- **IV** — no payment surface; the tax-document logo stays super-admin-only and read-only here.
  PASS.
- **V–X** — as evaluated above. The one deviation is recorded in Complexity Tracking. PASS.

## Risks & open items

| # | Item | Impact | Handling |
|---|---|---|---|
| R-1 | **SweCham's pending answers Q2/Q3/Q4/Q7 and the 2–3 sample E-Blasts** (scope-confirmation document sent 2026-09-17, EN + TH) | The design-block set (CTA button, banner, logo header) was chosen without the samples. A sample may add a block or reorder them | Spec § Assumptions: samples refine, they do not gate. A block the samples show is unneeded is dropped at this gate — none has been shown yet, so all three are built. A block the samples ADD is a follow-up feature, not a PR-1 blocker |
| R-2 | **Feature 120 (chamber E-Newsletter) may be confirmed** | Would reuse this editor, delivery and dashboard | Out of scope here by the 2026-09-17 clarification; nothing in this plan forecloses it |
| R-3 | **Resend Free plan: 1,000 contacts, 3 segments, ≤ 2 broadcasts in flight**; audience ceiling 500 recipients/tick unless `FEATURE_F7_IMPORT_AUDIENCE` is ON | The UAT walkthrough can exercise at most two E-Blasts concurrently | Stated as a UAT precondition in `quickstart.md`; the approval round adds no Resend Broadcasts calls before `member_approved → approved`, so a long design round consumes no Resend capacity |
| R-4 | **PR-1 ships unflagged into live outgoing email** | A wrapper defect reaches real recipients on the next send | Amendment 2: the byte-identical no-brand snapshot test is a merge blocker; each design block ships only with its preview and its email rendering tested together (spec § Feature flag); rollback is a deploy |
| R-5 | **The flag gates entry, not exit** (FR-034) — a departure from the 108/114 "404 everywhere while dark" pattern | With the flag off, the member sign-off routes must still answer for rows already in a new stage | `research.md` R18 defines the rule precisely and `contracts/` encode it per route; the contract suite pins both flag states |
| R-6 | **Live-look items the audit could not settle by reading code** (exploration § C): the 320 px toolbar **row count** after adding buttons, layout shift as the deferred preview settles, first paint of the empty preview, NVDA on the changed toolbar, SV string lengths on the new stage chips | UX defects SweCham would hit in the trial | Each is a task in PR-1 / PR-2 that must be checked on the running dev server (the maintainer runs `pnpm dev` on :3100); they are not code-review findings. **The toolbar's shape is no longer open**: FR-048 requires it to wrap with no overflow menu, so the live look measures how many rows that costs and whether anything clips — it does not choose the pattern. FR-025 likewise makes the SV chip fit a requirement, not an observation |
| R-7 | **Three pre-existing Domain ↔ DB state-machine divergences** (`draft→cancelled`, `approved→failed_to_dispatch`, `sending→cancelled` exist in the trigger but not in the Domain map) | Widening touches both layers; leaving the drift risks a future widening copying the wrong side | Recorded, **not fixed here** (fixing changes `canTransition`, which drives UI disabled-state, on paths this feature does not touch). The new arms are added to both layers identically and a test asserts parity **for the new edges only** |
| R-8 | **Five F7 tables have RLS + FORCE but are absent from `SCOPED_TABLES`** (`broadcast_templates`, `broadcast_batch_manifests`, `tenant_image_source_allowlist`, `tenant_broadcast_settings`, `broadcast_batch_delivery_events`) | The gate is blind to a regression on them | This feature adds its three new tables **and** `tenant_broadcast_settings` (which it writes brand data into). The other four are recorded here as a separate cleanup, not taken on |
| R-9 | **`ALTER TYPE … ADD VALUE` then using the value in the same migration** | A partial index or CASE arm referencing a brand-new enum label can fail inside a transaction | `scripts/run-migrations.ts` hoists every `ADD VALUE` into an AUTOCOMMIT pass before the transactional pass (the 0301 precedent). Verified in `quickstart.md` § 0 with an `information_schema` check, and the five `broadcast_status` values are added to `REQUIRED_ENUM_VALUES` so a silent no-op fails the deploy instead of every hand-off |
| R-10 | **Two branches adding migrations in parallel** | A duplicate `when` makes `db:migrate` a silent no-op that prints "✓ applied" | Re-read `meta/_journal.json` immediately before writing `0304`/`0305`; verify the DDL landed via `information_schema`, not the migrator's output |

**Gate decision**: Constitution Check PASS on all 10 principles; one documented deviation
(solo-maintainer review substitute). No `NEEDS CLARIFICATION` remains — every open question is
resolved in `research.md` or recorded above as a risk with an owner. Ready for
`/speckit.checklist` and `/speckit.tasks`.

**`/speckit.analyze` round 2 (2026-09-18)** — 29 findings, all remediated in the artefacts
(1 CRITICAL, 6 HIGH, 14 MEDIUM, 8 LOW). The CRITICAL and the HIGHs were PR-boundary defects, not
wording: the flag gate sat one PR behind the route it gates (Amendment 7), the staff image route was
gated on an enum value its own migration did not yet add (Amendment 6), and the Phase-10 coverage
pins and port fakes named files their PR did not create (T157/T157a, T158/T158a, T159/T159a).
Requirement coverage is 100 % — 60 FRs and 9 buildable success criteria, all with tasks, and all 42
acceptance scenarios mapped. No Constitution amendment was needed.

**`/speckit.analyze` round 3 (2026-09-18)** — 25 findings (2 CRITICAL, 7 HIGH, 10 MEDIUM, 6 LOW), a
pass aimed squarely at PR-boundary dependencies. Six of them (C1, C2, H4, M2, M7, M9) were the same
defect wearing different clothes: **US4 and US7 shipped one PR behind the stages they report on**, so
metric registrations, stage labels, the FR-051 pass, the flag flip and a merge gate's own RED test
each straddled a boundary. The maintainer's answer was structural rather than clerical — **merge the
former PR-3 into PR-2** (Amendment 8) — which closes all six at once and leaves only the preview
metrics to move the other way, into PR-1 (T122a). The remaining blockers were fixed in place: the
flag gate became edge-wide so an in-flight `changes_requested` row stays completable (H1,
Amendment 7); T006's approval i18n namespaces moved to T006a so PR-1's own dead-key gate can pass
(H2); the staff and member write rate buckets that spec § Roles and both route contracts require but
no task built became T026a and T062a (H3); `0305`'s two backfills were ordered ahead of the
immutability function they would otherwise trip (H5); T051's four runtime-derived sweep citations
were re-pointed at the tasks that actually widen them (H6); and the pinned-file total was corrected
from twelve to sixteen (H7). No Constitution amendment was needed for any of it. **PR-1 is unchanged
in scope** — it gains only T026a, T046a and T122a, all of which close gaps in what it already ships.
