# 119 — Code-level exploration + UX audit (2026-09-18)

Read-only findings from three exploration passes over the E-Blast writing tool and screens, kept
here as the evidence behind US3 (writing tool) and US6 (screen standard) in `spec.md`. File:line
references are as of `main` at `5f602fd30` (branch `119-eblast-approval-workflow` has no code
changes yet). Verify before relying on a line number.

## A. Editor, sanitisers, preview, wrapper, images

### Editor (`src/components/broadcast/tiptap-editor.tsx`)
- Extensions: `StarterKit` (no options) + `broadcastBracketPlaceholderExtension`, plus
  `broadcastImageExtension` only when `imagesEnabled` (`:156-162`). No text-align / colour /
  table / button extension anywhere.
- Image ext: `inline:false`, `allowBase64:false`, `HTMLAttributes:{loading:'lazy'}`
  (`tiptap-image-extension-config.ts:26-32`) — no width/alt/class.
- Bracket placeholder: decoration-only plugin marking `[text]` (`tiptap-bracket-placeholder-config.ts:30-62`).
- Typeable via StarterKit input rules without a button: heading `# `, blockquote `> `, hr `---`,
  `code`, ```` ``` ````, `~~strike~~`. Server keeps h1–h4/blockquote/hr but **strips code, pre,
  s/del, h5/h6** with `KEEP_CONTENT:true` → formatting silently lost after submit
  (`dompurify-sanitizer.ts:46-66, :98`).
- Toolbar (`tiptap-toolbar.tsx:152-236`): bold / italic / underline / bullet / ordered / link /
  unlink only. `role="toolbar"` without roving tabindex (`:147-151`).
- Packages: `@tiptap/{core,pm,react,starter-kit}` 3.22.5 exact; **`@tiptap/extension-image` is
  `^3.22.5` (caret)**; `isomorphic-dompurify` 2.36.0.

### Client vs server sanitiser parity
- Client paste config (`tiptap-editor.tsx:74-90`) `ALLOWED_ATTR` lacks `target`,`rel` (server
  allows + forces them, `dompurify-sanitizer.ts:163-164`).
- Client forbids `img` unless `imagesEnabled`; server always allows → on the staff proxy form and
  the template form a pasted `<img>` is destroyed at paste time.
- span/div/table/tr/td unwrapped (content kept) both sides; `<style>` dropped; `style` attr in
  `FORBID_ATTR` both sides; `class` dropped → `text-align` cannot survive anywhere.

### Preview (`src/components/broadcast/preview-pane.tsx`)
- Renders the **bare body**, not the wrapper; own third sanitiser config with `'img'` in
  `FORBID_TAGS` (`:55`) → **uploaded images never show in preview**. `dangerouslySetInnerHTML`
  (`:115`), no iframe, no width toggle, no dialog. Empty body → `<h3>{' '}</h3>` + empty prose div
  (`:102`). Always visible: `compose-form.tsx:599`, `proxy-compose-form.tsx:495`.
- Member detail `portal/broadcasts/[id]/page.tsx` renders **no body**. Staff detail
  `admin/broadcasts/[id]/page.tsx:171-176` renders bare body, wrapper not applied.

### Outgoing wrapper (`src/modules/broadcasts/infrastructure/resend/email-template.ts:150-173`)
- Header = escaped tenant display name, bold 14px `#666` text, **no logo** (`:161`). Outer
  `#f6f6f6`, card `#ffffff` 600px radius 8, system font stack 15px/1.6, footer 11px `#888`. No
  dark mode, no `<style>`. Tenant name from `env-tenant-display-name.ts`; the address line is an
  i18n string with `{tenantDisplayName}` — **no real postal address** (`:100-119`).
- Tenant logo exists for F4: private blob `invoicing/<tenantId>/logos/<uuid>` read as bytes
  (`load-tenant-logo.ts:11-12,118`); invoicing barrel exports only `uploadTenantLogo`
  (`src/modules/invoicing/index.ts:420`) — **no port for broadcasts to reach it**. A public logo
  blob adapter exists in insights (`modules/insights/infrastructure/logo/public-logo-blob-adapter.ts`).

### Images end to end
- `POST /api/broadcasts/inline-image-upload` (node, 60s), kill-switch `isF71aUs2Enabled()`.
  Limits: client 5 MB, route 5.5 MB → 413, use case 5 MB; MIME png/jpeg/webp/gif; sha256 dedup;
  ClamAV fail-closed before storing; Blob **public**, key `broadcasts/images/{tenant}/{sha256}.{ext}`
  (`vercel-blob-image-storage.ts:47,91-108`); blob host auto-seeded into the tenant allowlist
  (`upload-inline-image.ts:250-267`), enforced at submit (`submit-broadcast.ts:561-575`).
- `<img>` inserted via `setImage({src})` — **no alt, no alt UI, no width** (`tiptap-editor.tsx:218`).
- **No blob cleanup** anywhere; `draftId` only echoed into audit.
- Staff blocked by `requireMemberContext` role check (`member-context.ts:65-69`); **draft
  ownership never checked** — `draftId` is an unvalidated form string (`route.ts:76`) despite the
  docstring (`route.ts:5`). `proxy-compose-form.tsx:469-477` passes no `imagesEnabled`/`draftId`.

### What an upgrade touches

| Change | Component | Tiptap ext | Client sanitiser | Server sanitiser | Wrapper | DB/limits | Tests |
|---|---|---|---|---|---|---|---|
| Buttons for supported nodes | `tiptap-toolbar.tsx`, `AnnounceKey`, i18n ×3 | — | — | — | — | — | `broadcast-a11y.spec.ts`, `broadcast-i18n.spec.ts` |
| Staff image on submitted broadcast | `proxy-compose-form.tsx:469`, staff uploader, editor props | — | — | — | — | new staff route (not `requireMemberContext`), real ownership + status check | `upload-inline-image.test.ts`, `admin-proxy-submit.spec.ts` |
| CTA button block | toolbar + node view | new node | allow output | allow (`<a>` + presentational table; `style` forbidden today) | button CSS in wrapper | 200 KB cap | sanitiser tests, node test |
| Full-width banner | uploader UI; `preview-pane.tsx:55` | image ext attrs | `width`/`class` | same (`:68`) | width rule in 600px table | 5 MB; cleanup | `image-upload-allowlist.spec.ts`, `image-virus-scan-flow.test.ts` |
| Alignment | toolbar | `@tiptap/extension-text-align` (new dep) | `style` forbidden | same (`:93`) — or `align` attr | client-safe `align=` | — | sanitiser tests |
| Tenant logo header | — | — | — | — | `email-template.ts:161` | public logo URL port from invoicing/insights barrel | wrapper snapshot, `broadcasts-barrel.test.ts` |
| Dialog preview | wrapper around `preview-pane.tsx`; call sites `compose-form.tsx:599`, `proxy-compose-form.tsx:495`, staff detail `:171` | — | match server (allow `img`) | — | must call `renderBroadcastHtml` (+ iframe for full doc) | — | a11y focus-trap + i18n specs |

## B. Templates, compose form, other screens, tests, docs

### Templates (F7.1a US7)
- Schema `broadcast_templates` (`schema.ts:632-680`): name ≤100, subject ≤200, body ≤204800,
  `startedFromCount`, `isSeeded`, soft delete; partial unique (tenant,name,locale).
- Seed content is markdown → SQL: `specs/014-email-broadcast-advance/starter-templates.md` →
  `drizzle/migrations/0168_f71a_default_template_seed.sql` via
  `scripts/generate-template-seed-migration.ts` (5 × 3 locales = 15). Five: Monthly Newsletter,
  Event Invitation, Member Spotlight, Urgent Announcement, Sponsorship Thank-You. **Plain-text
  skeletons with `[bracket placeholders]`, no layout, no images**; only `{{chamber_name}}` is
  substituted.
- Picker `src/components/broadcast/compose/template-picker.tsx`: cmdk combobox; selecting does
  `router.push('/portal/broadcasts/new?template=<id>')` (`:71-78`); page re-fetches and remounts
  the form via `key={selectedTemplateId}` (`new/page.tsx:322`) → **typed content lost, no
  confirm** (BLOCKER).
- `snapshot-template-to-draft.ts` increments `startedFromCount`, but its route
  (`api/member/broadcasts/draft/[id]/snapshot-template`) has **no UI caller**; the shipped
  `?template=` path does not count → adoption (SC-007c of 014) unmeasurable.
- Admin CRUD `admin/broadcasts/templates/**`, `template-form.tsx` (Tiptap, `imagesEnabled={false}`),
  gate `check:template-seed`, test `starter-template-seed.test.ts`.

### Compose form (`compose-form.tsx`, 626 lines) + `new/page.tsx`
- Order: QuotaDisplay → Subject (+counter) → SegmentPicker → estimate → self-exclusion →
  RecipientCountLine → CustomListInput → Body (Tiptap) + UnsafeImageSourcesList → SchedulePicker →
  PreviewPane → note → footer (ghost Save as draft, Submit). Template picker sits **above** the form.
- Plain `useState` (header comment says react-hook-form — stale). zod `SubmitSchema`; server error
  → field map (`:74-90`) + focus. Draft save manual only (`:366-432`); no `?draftId=` resume; dirty
  guard = `beforeunload` comparing against **immutable initial props** (`:203-217`) → still warns
  after a successful save; no router-level guard; no submit confirmation.
- `aria-invalid`/`aria-describedby` on a wrapper `<div tabIndex={-1}>` (`:536-550`) although
  `TiptapEditor` has `invalid`/`describedById` props (`tiptap-editor.tsx:106,113`) that
  `admin/template-form.tsx:283-286` already uses.
- Terms acknowledgement is a portal-shell banner, not part of compose.
- `loading.tsx` omits QuotaDisplay card, template combobox, Card wrapper, count lines.
- **Proxy form** (`proxy-compose-form.tsx`, 509 lines): + MemberPicker, − quota display, − save
  draft, − template picker, − images, − beforeunload guard, − subject counter, − notes; order
  MemberPicker → Segment → Subject → Body → Schedule → Preview → Submit.

### Other screens
- `/portal/broadcasts/[id]` read-only detail with delivery breakdown + cancel — **no body**.
- Benefits `?tab=broadcasts` panel: QuotaDisplay + compose button + 10/page table.
- `/admin/broadcasts` queue: SLA/overdue/halt/manager banners, `QueueFilters`, `QueueTable` +
  `QueueCardList` (<md) on one TanStack instance; single permanently-mounted `role="status"`
  announcer (`queue-table-client.tsx:439-447`); fixed-bottom bulk toolbar; `finalFocus` on dialogs.
- `/admin/broadcasts/[id]`: bare sections `rounded-md border` (`:114,158`) instead of `Card`.
- `templates/page.tsx:94-114` hand-rolls an empty state; `portal/broadcasts/[id]/page.tsx:147` raw
  `<h2 className="text-h4">` inside `CardContent`.
- Only `/portal/broadcasts/new/error.tsx` exists; missing on `[id]`, `/admin/broadcasts`,
  `/admin/broadcasts/[id]`, templates, settings.
- Dead i18n: `compose.delete.*`, `button.deleteDraft`, `fields.bodyPlaceholder`,
  `fields.previewLoading`, `imageUpload.progressAria`, `editor.bracketHint`, whole
  `staleDraftBanner.*` (component `compose/stale-draft-banner.tsx` never mounted).

### Tests pinning these screens
- Editor: `tests/unit/broadcasts/infrastructure/tiptap-bracket-placeholder.test.ts` (no toolbar test).
- Sanitiser: `tests/unit/broadcasts/application/sanitize-html.test.ts`,
  `tests/integration/broadcasts/html-sanitiser.test.ts`,
  `tests/contract/broadcasts/template-render-html-escape.test.ts`.
- Preview: none dedicated (e2e `broadcast-compose-and-submit.spec.ts`, `broadcast-a11y.spec.ts`).
- Images: contract `upload-inline-image`, `image-source-allowlist`, `manage-image-allowlist`;
  integration `image-virus-scan-flow`, `image-allowlist-propagation`,
  `image-allowlist-cross-tenant-probe`; e2e `broadcasts/image-upload-allowlist.spec.ts`.
- Templates: contract `create-/update-/delete-/list-broadcast-template`, `api-templates-route`,
  `api-snapshot-template-route`, `snapshot-template-to-draft`, `template-save-image-allowlist`,
  `template-variable-substitution`; integration `starter-template-seed`,
  `template-snapshot-decoupling`, `snapshot-template-perf`, `template-cross-tenant-probe`,
  `template-already-soft-deleted`, `template-name-reuse-after-delete`,
  `template-allowlist-cross-mutation`, `template-provenance-xor-check`; unit
  `admin-template-library`, `admin-template-edit-confirm-starter`, `admin-template-form-catch-shape`;
  e2e `broadcasts/template-library-flow.spec.ts`.
- Compose: unit `build-segment-payload`, `submit-feedback`, `recipient-count-line`,
  `use-recipient-count`, `stale-draft-banner`, `broadcasts-compose-suspended-redirect`; contract
  `post-broadcasts-submit`, `post-broadcasts-draft`; integration `audience-page-vs-compose-count`.
- Proxy: unit `proxy-compose-missing-email`, `member-picker`, `proxy-submit-broadcast`; contract
  `post-admin-broadcasts-proxy-submit`; integration `proxy-submit-cross-tenant`,
  `proxy-submit-quota-cap`; e2e `admin-proxy-submit.spec.ts`.
- Queue/review: unit `queue-card-list`, `queue-table-client-a11y`, `queue-table-segment`,
  `queue-filters-grouping`, `queue-with-bulk`, `queue-bulk-action-bar`, `approve-dialog-*`,
  `bulk-approve-confirm-dialog`, `sla-banner`, `overdue-banner`, `is-default-view`, `reject-dialog`,
  `approve-reject-final-focus`, `dialog-final-focus-landmark`, `bulk-approve-halt-unknown`,
  `halt-state-unavailable-banner`; contract `post-admin-broadcasts-{approve,reject,cancel}`.
- E2E: `broadcast-compose-and-submit`, `broadcast-a11y`, `broadcast-i18n`, `admin-proxy-submit`,
  `member-quota-history`, `broadcasts/template-library-flow`, `broadcasts/image-upload-allowlist`.

### i18n namespaces
`portal.broadcasts.compose.*`, `portal.broadcasts.{quota,banner,list,cmdk,detail}`,
`admin.broadcasts.{queue,review,approveDialog,rejectDialog,cancelDialog,proxySubmitDialog,proxySubmitButton,haltBanner,clearHaltDialog,managerReadonlyBanner,toast,templates,settings}`,
`portal.benefits.tabs`.

### Prior docs
- `docs/email-broadcast-analysis.md:350-354` asked for a split-view preview "as rendered in
  Gmail/Outlook" and a subject character count; `:520` deferred a template library.
- `specs/010-email-broadcast/spec.md:621` — "1 starter HTML template (chamber-branded header +
  footer + unsubscribe link). Members customise the body inside that frame."
- `specs/014-email-broadcast-advance/spec.md:146-153, :209-232` — template FRs; deferred AI
  generation, spam score, member-authored templates.
- **No doc anywhere specifies a logo header, CTA buttons or design blocks** for member bodies.

## C. UX/UI audit — ranked findings

| # | Sev | Where | Experience | Fix |
|---|---|---|---|---|
| 1 | BLOCKER bug | `compose/template-picker.tsx:71-78`, `new/page.tsx:322` | Picking a template remounts the form; typed subject/body vanish, no confirm, no undo | Confirm dialog when dirty, or re-seed instead of remount |
| 2 | HIGH bug | `preview-pane.tsx:54` | Preview strips `<img>` → uploaded image looks like a failed upload | Share `makeSanitizerConfig(imagesEnabled)` with the preview |
| 3 | HIGH a11y (3.3.1) | `compose-form.tsx:536-550`, `proxy-compose-form.tsx:452-466` | Body error never announced on the contenteditable | Pass `describedById` + `invalid` to `TiptapEditor` |
| 4 | HIGH bug | `compose-form.tsx:204-206` | "Unsaved changes" still warns after Save as draft | Track a saved snapshot |
| 5 | HIGH design | `tiptap-toolbar.tsx:152-236` | No heading/quote/hr controls; `editor.bracketHint` never rendered | T1 toolbar |
| 6 | HIGH design | `preview-pane.tsx:92-117` | Labelled empty rectangle on first paint; not the real email | Real wrapper + empty state + Preview dialog |
| 7 | MED a11y | `tiptap-toolbar.tsx:147-151` | `role="toolbar"` without roving tabindex — 7+ tab stops | APG toolbar pattern |
| 8 | MED i18n | `tiptap-toolbar.tsx:153` | Italic offered for Thai | Hide for `th` |
| 9 | MED bug (119 blocker) | `tiptap-editor.tsx:251-264`, `proxy-compose-form.tsx:59-64` | Images only after Save draft (hint has no button); staff form has no images, no drafts | Draft lifecycle + uploader on proxy form |
| 10 | MED design | `new/page.tsx:303`, `admin/broadcasts/new/page.tsx:30` | 42rem `FormContainer` for a tool whose email is 600px | 72rem + two columns ≥lg (record the § 18.2 exception) |
| 11 | MED CLS | `portal/broadcasts/new/loading.tsx` | Skeleton shorter than the page | Re-shape |
| 12 | MED gap | routes / i18n | Missing `error.tsx` ×5; dead keys; unmounted stale-draft banner | Add boundaries; delete or wire |

Decisions taken from the audit (now in spec.md): preview = inline (real, with empty state) + Preview
dialog/sheet with desktop/phone widths, `finalFocus` back to the trigger, reused on the compare
screen; templates kept, demoted, non-destructive; dashboard = extend the existing queue (stage
chips with counts, Whose turn, Time in stage via the existing `ageBadge`, Round; upcoming sends
as a filter preset; proposed-vs-confirmed rows + round thread on detail) preserving the shared
table primitive, mobile card list, fixed-bottom bulk bar, the single live region and `finalFocus`.

**Needs a live look (dev server), not code reading**: the 320 px toolbar after adding buttons
(wrap vs overflow menu); layout shift when the deferred preview settles; first paint of the empty
preview; NVDA on the toolbar change; SV string lengths on the new stage chips.

## D. Panel carry-forwards (`spec-review-panel`, 2026-09-18 — GO WITH AMENDMENTS)

Verdict: 3 confirmed (#9, #5 premise — immutability trigger; #7 blocker — invoice-logo privilege),
9 refuted, 101 dropped. Amendments applied to spec.md: FR-012a (new), FR-017 (extended), FR-041b
(rewritten). Plan-time notes from the refuted residuals (LOW, not gate blockers):

- **Design blocks**: platform-owned markup with user data only; never route block markup through
  `dompurifySanitizer.sanitize` — render blocks from structured data at send time.
- **UAT precondition**: `validateCustomRecipients` accepts any contact email in the tenant graph, so
  the staff-only trial list works only if the staff addresses exist as contacts of the designated
  test member — state this in the UAT walkthrough.
- **Schedule columns**: keep the member's proposal off `scheduled_for` (own column, e.g.
  `proposed_send_at`); no new stage may sit on status `approved`, because the dispatcher scans
  `status='approved' AND scheduled_for <= now()`.
- **Notification recipients**: derive "marketing" via `hasPermission(role, 'broadcasts.write')`
  minus admin tiers (F114 FR-011 precedent, `specs/114-member-change-approval/plan.md:42`), not a
  literal role string; MTA+STD makes "in the tenant" vacuous today.
- **Image lifecycle**: state redaction-vs-delete and a last-reference rule; today's COMP-1 scrub
  redacts the reference, not the bytes; `@vercel/blob del` is already used in three adapters;
  widen `ImageStoragePort` accordingly.
- **Erasure + cancel set**: `scrubContentForMemberInTx` has no status predicate; the literal
  `('submitted','approved')` set is the cancellation cascade AND the allowance-reservation bucket
  (`countMemberQuotaBucketsOnTx`) — both must be widened to the new in-progress stages in the same
  migration that widens `broadcasts_state_machine_fn` CASE arms; seed an erasure test at "Awaiting
  member approval".
- **`marketing` role cannot open a `settings.broadcasts` page**: the "no logo on file" edge case
  must point marketing at whoever holds the permission, or grant read-only.
- **FR-019** omits the retired statuses `partially_sent` / `partial_delivery_accepted` — they stay in
  the DB enum and must remain representable in any stage mapping.
- Trigger history to mirror: `0064` → `0075` → `0124` → `0224` → `0299` (`broadcasts_immutable_after_submit_fn`);
  the live body is `drizzle/migrations/0299_broadcasts_audience_import_coherence.sql:86-175`.

Full panel output (JSON) is in the session task file `wl20oq0hl.output`; the markdown report is
saved beside this session's scratchpad as `spec-review-panel-119.md`.
