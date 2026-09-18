# Data Model — 119 E-Blast Two-Sided Approval Workflow

Phase 1 output. Entities from `spec.md` § Key Entities, resolved against `research.md` (R2, R3, R4,
R5, R7, R8, R13, R17, R22, R24). DDL is **hand-written SQL** in two migrations; Drizzle schema in
`src/modules/broadcasts/infrastructure/schema.ts`. Drizzle-inferred types stay in Infrastructure;
the Domain types in § 9 are hand-declared.

| migration | journal | carries |
|---|---|---|
| `0304_eblast_images_and_brand.sql` | `idx: 305`, `when: 1798543700000` | `broadcast_images` (+RLS/FORCE) · 4 brand columns on `tenant_broadcast_settings` · `audit_event_type` += `broadcast_test_copy_sent`, `broadcast_brand_settings_changed`, `broadcast_image_uploaded`, `broadcast_image_removed` |
| `0305_eblast_member_approval.sql` | `idx: 306`, `when: 1798543800000` | **the FR-012a bundle**: `broadcast_status` +5 · `broadcasts_immutable_after_submit_fn` amended · `broadcasts_state_machine_fn` amended · `broadcast_versions` + `broadcast_member_decisions` (+RLS/FORCE) · 6 columns on `broadcasts` incl. `proposed_send_at` · `audit_event_type` += 10 · `notification_type` += 5 · the `proposed_send_at` backfill |

FR-019 names `data-model.md` § State machine **normative** for the stage list: § 8.1a below carries
the entry condition, exit conditions and acting party of **every** stage including Draft, and § 8.1b
the closed outcomes including Expired.

Verify the journal tail before writing (research V5). Every `ALTER TYPE … ADD VALUE IF NOT EXISTS`
is **one statement per line**: `scripts/run-migrations.ts` hoists them into an AUTOCOMMIT pass ahead
of the transactional pass (the 0301 precedent), which is what lets one file both add
`'in_design'` and create a partial index that references it.

---

## 1. `broadcast_versions` (new, 0305)

One row per version of the content. `version_no = 0` is the member's original, materialised lazily
when marketing first starts formatting (R2); `1..n` are marketing's formatted versions.

| column | type | notes |
|---|---|---|
| `tenant_id` | `text NOT NULL` | RLS FORCE, 0064 policy |
| `id` | `uuid NOT NULL DEFAULT gen_random_uuid()` | PK is `(tenant_id, id)` — the module's composite-PK convention (`broadcasts_pkey`) |
| `broadcast_id` | `uuid NOT NULL` | FK `(tenant_id, broadcast_id)` → `broadcasts(tenant_id, broadcast_id)` `ON DELETE CASCADE` |
| `version_no` | `smallint NOT NULL CHECK (version_no >= 0)` | 0 = member's original |
| `subject` | `text NOT NULL CHECK (char_length BETWEEN 1 AND 200)` | mirrors `broadcasts_subject_length` |
| `body_html` | `text NOT NULL CHECK (octet_length BETWEEN 1 AND 200*1024)` | mirrors `broadcasts_body_html_size`; sanitised in Application before insert |
| `body_source` | `text NOT NULL` | the editor's own serialisation, as on `broadcasts` |
| `note_to_member` | `text NULL CHECK (char_length <= 1000)` | FR-006, optional |
| `authored_by_user_id` | `uuid NOT NULL` | the marketing user; for `version_no = 0` the broadcast's `submitted_by_user_id` |
| `authored_by_role` | `broadcast_actor_role NOT NULL` | reuses the existing enum; audit-truth (the role actually held) |
| `sent_to_member_at` | `timestamptz NULL` | NULL = the working copy. Set ⇒ read-only (FR-003) |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | `updated_at` is the optimistic-concurrency token (R19) |

**Indexes**
- `UNIQUE (tenant_id, broadcast_id, version_no)`
- `broadcast_versions_one_unsent_idx` — `UNIQUE (tenant_id, broadcast_id) WHERE sent_to_member_at IS NULL` (at most one working copy)
- `(tenant_id, broadcast_id, version_no DESC)` — the history thread
- `(tenant_id, broadcast_id)` — FK-column index (the 0302 lesson)

**Trigger** `broadcast_versions_immutable_after_send_fn` (BEFORE UPDATE): when
`OLD.sent_to_member_at IS NOT NULL`, any change to `subject`, `body_html`, `body_source`,
`note_to_member`, `version_no`, `authored_by_user_id` or `sent_to_member_at` raises
`broadcast_version_immutable_after_send` (`ERRCODE = check_violation`). The erasure scrub is
exempted by the same `app.allow_broadcast_redaction` GUC the parent table uses, and under that GUC
**only** `subject`, `body_html`, `body_source` and `note_to_member` may change (whitelist by
omission, the 0299 shape).

**No brand snapshot.** A version stores **no** copy of the logo URL, the brand colour or the postal
address. Brand chrome is applied live by `renderBroadcastHtml` at send time and in every preview
(FR-041c), so a brand change never alters a version and never voids an approval. Adding a
`brand_*` column here would be the frozen-chrome design FR-041c forbids.

**"Content" (FR-012) is `subject` + `body_html` + `body_source` — nothing else.** Those three columns
(including the design-block markup and image references inside them) are what the member approves and
what a later edit voids. `note_to_member` is **not** content: it is marketing's covering note and
changing it does not void an approval. Neither is the schedule (`broadcasts.scheduled_for`) nor the
brand chrome. Concretely, only the `member_approved|approved → in_design` transition — which is a
content edit by definition (it opens a new working copy) — clears `approved_version_id`; a brand
`PATCH` and a schedule `PATCH` do not touch it.

**Erasure** (R17): those four columns → `'[redacted]'`; row kept.

## 2. `broadcast_member_decisions` (new, 0305)

Append-only. One row per member action on one version.

| column | type | notes |
|---|---|---|
| `tenant_id` | `text NOT NULL` | RLS FORCE |
| `id` | `uuid NOT NULL DEFAULT gen_random_uuid()` | PK `(tenant_id, id)` |
| `broadcast_id` | `uuid NOT NULL` | FK `(tenant_id, broadcast_id)` → `broadcasts` `ON DELETE CASCADE` |
| `version_id` | `uuid NOT NULL` | FK `(tenant_id, version_id)` → `broadcast_versions(tenant_id, id)` `ON DELETE CASCADE` — the decision is *about* a version (FR-011) |
| `round` | `smallint NOT NULL CHECK (round >= 1)` | the version's `version_no` at decision time |
| `decision` | `text NOT NULL CHECK (decision IN ('approved','changes_requested','approval_withdrawn'))` | |
| `reason` | `text NULL` | **required, 1–2,000 chars** for `changes_requested` and `approval_withdrawn` (FR-010, FR-015a); for `approved` it is the **optional note, ≤ 500 chars** (FR-009). One CHECK carries both bounds: `(decision = 'approved' AND (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500)) OR (decision <> 'approved' AND reason IS NOT NULL AND char_length(reason) BETWEEN 1 AND 2000)` |
| `decided_by_user_id` | `uuid NOT NULL` | the portal user |
| `decided_by_contact_id` | `uuid NOT NULL` | the contact record they were linked to |
| `decided_at` | `timestamptz NOT NULL DEFAULT now()` | |

**Indexes**: `(tenant_id, broadcast_id, decided_at DESC)` (the thread); `(tenant_id, version_id)`;
`(tenant_id, decided_by_contact_id)` — "which contact approved this" is a DSAR and audit-review
query, and the 0302 FK-column-index lesson applies to the lookup even where no constraint exists.

**No FK on either actor column, by decision.** `decided_by_user_id` points at the cross-tenant
`users` table, which a composite `(tenant_id, …)` FK from a tenant-scoped table cannot reach;
`decided_by_contact_id` is left unconstrained for the same reason the erasure scrub keeps the row
and redacts only `reason` — SC-002's proof of who approved must survive the contact's removal. This
is recorded rather than left implicit so a later reviewer does not "fix" it into a cascade that
would delete the proof.

**Triggers**: `broadcast_member_decisions_append_only_fn` — BEFORE UPDATE raises
`broadcast_decision_append_only` **except** when `app.allow_broadcast_redaction = 'on'` and only
`reason` changes; BEFORE DELETE raises unconditionally (the CASCADE from the parent is a DELETE on
the parent row, which this trigger does not see).

**Erasure**: `reason` → `'[redacted]'`; row kept (SC-002's proof must survive).

## 3. `broadcasts` (existing) — six new columns (0305)

| column | type | notes |
|---|---|---|
| `proposed_send_at` | `timestamptz NULL` | the member's proposal, written at submit beside `scheduled_for`, **frozen** by the immutability trigger thereafter (FR-016, R8) |
| `stage_entered_at` | `timestamptz NOT NULL DEFAULT now()` | stamped on every status change. Drives "time in stage" (FR-026), the stalled flag (FR-027) and the reminder/expiry clock (FR-022/FR-022a) |
| `current_round` | `smallint NOT NULL DEFAULT 0` | **the count of versions sent to the member** (FR-026), incremented on `→ awaiting_member_approval` and **only** there. 0 = never formatted. A withdrawn approval does **not** start a round: it moves the row to `changes_requested` without touching this column, and the counter next moves when marketing actually sends the following version |
| `approved_version_id` | `uuid NULL` | FK `(tenant_id, approved_version_id)` → `broadcast_versions(tenant_id, id)`. Set on member approval, cleared when the approval is voided or withdrawn. **The proof for SC-002** |
| `member_reminder_stage` | `smallint NOT NULL DEFAULT 0 CHECK (BETWEEN 0 AND 3)` | 0 none · 1 day-3 sent · 2 day-7 sent · 3 day-23 warning sent. Reset to 0 on every entry into `awaiting_member_approval` |
| `member_expiry_notified_at` | `timestamptz NULL` | stamped when the day-30 closure notice is enqueued (idempotency for the daily tick) |

**Statement order in the file is normative — three steps, in this order**: (1) the
`ALTER TABLE broadcasts ADD COLUMN` statements for all six columns above; (2) the two backfills
below; (3) the `CREATE OR REPLACE FUNCTION broadcasts_immutable_after_submit_fn`. Columns before
backfills is not merely tidy — backfill (1) writes `proposed_send_at`, which does not exist until
step (1) — and backfills before the function replacement is the H5 rule restated below.

**Backfills** (same migration, and **both MUST precede the `CREATE OR REPLACE` of
`broadcasts_immutable_after_submit_fn` in the file**):

1. `UPDATE broadcasts SET proposed_send_at = scheduled_for WHERE status = 'submitted' AND
   scheduled_for IS NOT NULL;` — only rows still awaiting a decision still carry an untouched
   proposal (`approveBroadcast` overwrites `scheduled_for`, `approve-broadcast.ts:118-119,151`).
   Every other historical row keeps `NULL`, and the UI shows "not recorded".
2. `UPDATE broadcasts SET stage_entered_at = COALESCE(submitted_at, updated_at) WHERE
   stage_entered_at IS DISTINCT FROM COALESCE(submitted_at, updated_at);` — without it the column's
   `DEFAULT now()` would make **every** pre-existing waiting row look freshly entered, and T117
   re-bases the existing `ageBadge` on this column, so the live 24 h / 48 h SLA badges would all
   reset to zero on the deploy (`/speckit.analyze` round 3 M3).

**Why the order is normative**: exemption F1 below adds `proposed_send_at` to the immutability
function's frozen blocklist, and that function is a **BEFORE UPDATE** trigger. Replace it first and
backfill (1) — an `UPDATE` of `proposed_send_at` on `submitted` rows — raises
`broadcast_immutable_after_submit` and aborts the whole migration
(`/speckit.analyze` round 3 H5). Backfill, then replace.

**New indexes**
- `broadcasts_stage_queue_idx` — `(tenant_id, status, stage_entered_at DESC)` — the dashboard's
  per-stage list and the stalled comparison at 1,000 rows (SC-008)
- `broadcasts_awaiting_member_idx` — `(tenant_id, stage_entered_at) WHERE status =
  'awaiting_member_approval'` — the daily reminder/expiry scan and the oldest-age gauge
- `broadcasts_approved_version_idx` — `(tenant_id, approved_version_id)` (FK column)

**Unchanged and load-bearing**: `broadcasts_quota_year_only_on_sent` (`0217:85-88`) still requires
`quota_year_consumed IS NULL` for every status but `sent` / `partial_delivery_accepted`, so
`expired_no_member_response` frees the allowance place by construction (FR-022a).

## 4. `broadcast_images` (new, 0304)

The record that makes image ownership enforceable and image erasure reachable (R22, R17).

| column | type | notes |
|---|---|---|
| `tenant_id` | `text NOT NULL` | RLS FORCE |
| `id` | `uuid NOT NULL DEFAULT gen_random_uuid()` | PK `(tenant_id, id)` |
| `owner_kind` | `text NOT NULL CHECK (owner_kind IN ('broadcast','template'))` | a draft IS a `broadcasts` row with `status='draft'`, so there is no third kind |
| `owner_id` | `uuid NOT NULL` | the `broadcast_id` or the `broadcast_templates.id`. No FK (two possible parents); orphan rows are reaped by the daily sweep |
| `content_hash` | `text NOT NULL` | SHA-256, as computed by `upload-inline-image.ts:131-133` |
| `blob_url` | `text NOT NULL` | the public Vercel Blob URL |
| `blob_key` | `text NOT NULL` | `broadcasts/images/{tenant}/{sha256}.{ext}` (`vercel-blob-image-storage.ts:41-48`) |
| `mime_type` | `text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp','image/gif'))` | mirrors `image-storage-port.ts:20-24` |
| `byte_size` | `integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5*1024*1024)` | mirrors `MAX_BYTES` (`upload-inline-image.ts:38`) |
| `uploaded_by_user_id` | `uuid NOT NULL` | member or staff |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `deleted_at` | `timestamptz NULL` | marked by **erasure** (T082), **member withdrawal** and **staff rejection** (both T081) — each stamping in the same transaction as the state change and auditing `broadcast_image_removed` with the matching `reason`; the bytes go on the next sweep (T035, `reason: 'sweep'`). All four declared reasons therefore have an emit site (`/speckit.analyze` round 3 M4) |

**Indexes**: `(tenant_id, owner_kind, owner_id)`; `(tenant_id, content_hash)` — the
**last-reference rule** (`DELETE the blob only when no row with the same `content_hash` has
`deleted_at IS NULL``); `(tenant_id, deleted_at) WHERE deleted_at IS NOT NULL` — the sweep.

**Lifecycle wording the spec fixes (§ Personal data)**: "not reachable" means the **reference is
removed from the content immediately** (the scrub/withdrawal/rejection transaction stamps
`deleted_at` and the HTML no longer points at it), and the **file is deleted by the daily sweep
within 24 hours** once **nothing** — neither an E-Blast nor a template, i.e. no live row of either
`owner_kind` — shares its `content_hash`. An image still referenced elsewhere is kept, by design.

**No per-block authorship column, by decision.** Blocks and links carried into a draft from a
template are ordinary content the member may edit or delete, and authorship is **not tracked per
block** (FR-046a) — there is no `source_template_id` on a block and no provenance field anywhere in
the body. A template image simply gains a second `broadcast_images` row under
`owner_kind='broadcast'`, sharing the content hash, which is what the last-reference rule needs.

**Not backfilled.** Images uploaded before 0304 have no row, so they are never swept; they remain
reachable exactly as today. Recorded rather than guessed — reconstructing owners from historical
HTML would attribute bytes to the wrong member.

## 5. RLS — identical on all three new tables

Byte-identical to the canonical template at `drizzle/migrations/0064_create_broadcasts.sql:160-169`
(note the two spaces in `FORCE  ROW LEVEL SECURITY`, which is how every existing broadcasts table
is written):

```sql
ALTER TABLE "broadcast_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_versions" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_broadcast_versions"
  ON "broadcast_versions"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint
```

`scripts/check-multi-tenant-ready.ts` `SCOPED_TABLES` (the F7 block at `:77-80`) gains **four**
entries: `broadcast_versions`, `broadcast_member_decisions`, `broadcast_images` and the
pre-existing-but-unlisted `tenant_broadcast_settings`, which this feature starts writing
tenant-authored brand content into.

## 6. `tenant_broadcast_settings` (existing) — four new columns (0304)

| column | type | notes |
|---|---|---|
| `brand_primary_color` | `text NULL CHECK (brand_primary_color ~ '^#[0-9a-fA-F]{6}$')` | FR-041b/c. NULL ⇒ the platform default `#10487a` (`src/lib/email-brand.ts:20`) |
| `brand_postal_address` | `text NULL CHECK (char_length(brand_postal_address) BETWEEN 1 AND 300)` | FR-041c — free text, **line breaks allowed** (the CHECK bounds length only; no format is imposed). NULL ⇒ the footer shows the chamber name only and the Brand page flags it missing |
| `brand_updated_at` | `timestamptz NULL` | |
| `brand_updated_by_user_id` | `uuid NULL` | |

The contrast rule (white text ≥ 4.5:1) is **Application + Domain**, not a CHECK: it needs the WCAG
luminance formula, it must produce a human-readable refusal with the computed ratio, and a CHECK
could not be relaxed if the platform ever supports dark button text. The brand **colour is used in
email only**, never in the portal or admin UI (FR-041c), and none of these four values is ever copied
into a version — brand chrome is read live at render time, so a brand change never voids an approval
(FR-012). The **logo** is never written
here — it stays `tenant_invoice_settings.logo_blob_key`
(`schema-tenant-invoice-settings.ts:79`), gated by `settings.invoicing` (super-admin only,
`permission-catalogue.ts:98`), and is only READ (FR-041b, research R12).

## 7. Enum widenings (one `ADD VALUE` statement per line)

### 7.1 `broadcast_status` += 5 (0305)

`in_design`, `awaiting_member_approval`, `changes_requested`, `member_approved`,
`expired_no_member_response`. The Drizzle `broadcastStatusEnum` (`schema.ts:61-80`) and the Domain
tuple `BROADCAST_STATUSES` (`broadcast-status.ts:15-27`) go 10 → 15 in the same order.
`expired_no_member_response` joins `TERMINAL_BROADCAST_STATUSES` (`:93-99`).
`RETIRED_BROADCAST_STATUSES` is unchanged, so `OFFERED_BROADCAST_STATUSES` goes 8 → 13 and the
queue's chip strip and its loading skeleton follow automatically.

### 7.2 `audit_event_type` += 14

`broadcast_test_copy_sent`, `broadcast_brand_settings_changed`, **`broadcast_image_uploaded`**,
**`broadcast_image_removed`** (0304);
`broadcast_version_started`, `broadcast_version_sent_to_member`, `broadcast_member_approved`,
`broadcast_member_changes_requested`, `broadcast_member_approval_withdrawn`,
`broadcast_member_approval_voided`, `broadcast_schedule_confirmed`,
`broadcast_approval_reminder_sent`, `broadcast_approval_expiry_warned`,
`broadcast_approval_expired` (0305).

The two image values are **new**, not reused: spec § Audit trail requires "image uploaded / removed"
to be auditable and the existing `broadcast_image_*` values are refusals and configuration only
(`broadcast_image_too_large`, `broadcast_image_unsafe`, `broadcast_image_allowlist_updated` —
`audit-port.ts:136-138`). They ship in 0304 with `broadcast_images` itself.

Five places (research R24): `F7_AUDIT_EVENT_TYPES` **55 → 69** with the static assert at
`audit-port.ts:234` updated in the same edit · `DB_ONLY_AUDIT_EVENT_TYPES`
(`auth/infrastructure/db/schema.ts:522-678` — every `broadcast_*` value lives there) · the migration
statements · `audit.eventType.*` labels EN/TH/SV · `scripts/lib/enum-migration-guard.ts`.
Retention: `f7RetentionFor` returns 5 for every F7 event (`audit-port.ts:257`) — no tax document is
produced, so none of the fourteen is a 10-year event.

### 7.3 `notification_type` += 5 (0305)

`eblast_submitted_marketing`, `eblast_member_decided_marketing`, `eblast_version_sent_member`,
`eblast_schedule_confirmed_member`, `eblast_approval_lifecycle`. Each **must** ship with its
`case` arm in `buildPayload` (`src/app/api/cron/outbox-dispatch/route.ts:194`) in the same PR: the
`default:` arm returns `null` (`:543`), which retries for ~16 h before permanently failing, so an
arm-less type is a silent outage. Also added to `enum-migration-guard.ts`.

**All five are behind `FEATURE_EBLAST_MEMBER_APPROVAL` at the drainer** (maintainer decision,
round 4 H2 — the F114 precedent): the enqueue is unconditional, but
`src/app/api/cron/outbox-dispatch/route.ts` **skips these five values while the flag is off**, so
with the variable absent nothing is emailed, rows wait, and they drain on the first tick after the
flip. A skipped row is not an error: no `lastError`, no attempt counted, no `no_template_handler`.
Contract: `dashboard-and-notifications.md` § 3; task T152a.

**Exactly five — there is no sixth.** The test copy (FR-037) is **not** an outbox type: research V4
is resolved and it sends synchronously through the shared transactional sender
(`src/modules/auth/infrastructure/email/resend-client.ts:148`) behind `TestCopyMailerPort`. That
matters to the migration split: the test copy ships in **PR-1**, whose migration `0304` carries no
`notification_type` change at all, so a test copy that needed an enum value would have had no
migration to live in.

## 8. Stages, statuses and the state machine

### 8.1 Stage ↔ status (FR-019) — `stageOf(status)`, pure Domain

| FR-019 stage | `broadcast_status` | whose turn (FR-026) |
|---|---|---|
| Draft | `draft` | — |
| Awaiting marketing review | `submitted` | marketing |
| In design | `in_design` | marketing |
| Awaiting member approval | `awaiting_member_approval` | member |
| Changes requested by member | `changes_requested` | marketing |
| Member approved — awaiting schedule | `member_approved` | marketing |
| Scheduled | `approved` | — |
| Sending | `sending` | — |
| Sent | `sent` | — |
| Rejected | `rejected` | — |
| Withdrawn / Cancelled | `cancelled` | — |
| Expired — no member response | `expired_no_member_response` | — |
| Failed | `failed_to_dispatch` | — |
| *(historical only, never offered)* | `partially_sent`, `partial_delivery_accepted` | — |

FR-026 fixes this mapping exactly: **Marketing** for Awaiting marketing review, In design, Changes
requested and Member approved; **Member** for Awaiting member approval; and **"—" (nobody)** for
Draft, Scheduled, Sending and every closed stage. `turnOf` therefore returns
`'marketing' | 'member' | null` — there is **no** `'system'` turn (an earlier draft had one for
Scheduled/Sending; a stage nobody is waiting on is "—", and the dashboard must not invite a staff
user to act on a row the dispatcher owns).

### 8.1a Entry, exit and acting party of every stage (FR-019 — normative)

| stage (status) | entry condition | exit conditions | acting party |
|---|---|---|---|
| **Draft** (`draft`) | a member starts a compose, or staff start a proxy compose | submit → Awaiting marketing review; the 30-day draft prune → deleted | the author (member, or the staff proxy owner until submitted) — but **nobody is waiting**, so whose turn is "—" |
| **Awaiting marketing review** (`submitted`) | the member (or the proxy) submits; `proposed_send_at` and `scheduled_for` are written here | approve as submitted → Scheduled · start formatted version (flag) → In design · reject → Rejected · withdraw → Withdrawn | marketing |
| **In design** (`in_design`) | marketing starts or resumes a formatted version, from Awaiting marketing review, Changes requested, Member approved or Scheduled (round ≥ 1) | send version to member → Awaiting member approval · reject → Rejected · withdraw → Withdrawn | marketing |
| **Awaiting member approval** (`awaiting_member_approval`) | marketing sends a version; `sent_to_member_at` stamped, `current_round` incremented, `member_reminder_stage` reset | member approves → Member approved · member requests changes → Changes requested · day 30 → Expired · marketing rejects → Rejected · member withdraws → Withdrawn | the member (a **lapsed** member may still act — see § 8.2) |
| **Changes requested by member** (`changes_requested`) | the member requests changes, **or** the member withdraws an approval from Member approved / Scheduled | start formatted version → In design · reject → Rejected · withdraw → Withdrawn | marketing |
| **Member approved — awaiting schedule** (`member_approved`) | the member approves; `approved_version_id` set | confirm schedule → Scheduled (**promotion**, FR-012a E1) · marketing edits → In design (approval voided) · member withdraws approval → Changes requested · reject → Rejected · withdraw → Withdrawn | marketing |
| **Scheduled** (`approved`) | marketing confirms the time, **or** today's approve-as-submitted path | dispatcher picks it up → Sending · cancel the time → Changes requested · marketing edits (round ≥ 1) → In design · member withdraws approval → Changes requested · withdraw → Withdrawn | — (the dispatcher acts) |
| **Sending** (`sending`) | the dispatcher hands the E-Blast to the delivery provider — **this is "sending begins"** (FR-015) | all batches accepted → Sent · dispatch failure → Failed | — |
| **Sent** (`sent`) | delivery completed; `quota_year_consumed` set | terminal | — |

### 8.1b Closed outcomes (terminal)

| stage (status) | entered from | how | allowance |
|---|---|---|---|
| **Rejected** (`rejected`) | Awaiting marketing review · In design · Awaiting member approval · Changes requested · Member approved | marketing rejects with a reason, at any stage before Sending (FR-015) | freed |
| **Withdrawn / Cancelled** (`cancelled`) | every in-progress stage incl. Scheduled | the member withdraws the E-Blast, or staff cancel, at any stage before Sending (FR-015) | freed |
| **Expired — no member response** (`expired_no_member_response`) | **only** Awaiting member approval | the daily tick at day 30 (FR-022a) | freed |
| **Failed** (`failed_to_dispatch`) | Scheduled · Sending | dispatch failure | freed |

No closed stage can be reopened; the member submits a new E-Blast (FR-022a).

`approved` is the **only** dispatchable status (`dispatch-scheduled/route.ts:168-183` scans
`status = 'approved' AND scheduled_for <= now()`), which is why no waiting stage sits on it (R5).
"Scheduled" replaces today's "Approved" label in both status namespaces — an unflagged copy change
shipped with PR-2 (which now also carries the dashboard), not PR-1 — and the **five new stage
labels** ship there too, in the same task (T120), because PR-2's own screens render them.

### 8.2 Transitions (Domain `TRANSITIONS` and `broadcasts_state_machine_fn`, kept identical)

```
draft ──submit──▶ submitted ──approve as submitted──▶ approved ──▶ sending ──▶ sent
                     │                                   ▲  │                └──▶ failed_to_dispatch
                     │                                   │  └──withdraw approval──▶ changes_requested
      start version  │                                   │  └──marketing edits─────▶ in_design
                     ▼                                   │
                  in_design ◀──────────────┐             │ confirm schedule (+ PROMOTION, FR-012a E1)
                     │                     │             │
        send version ▼                     │             │
        awaiting_member_approval ──approve─┼─────▶ member_approved
                     │  │                  │             │
   request changes   │  └──30 days──▶ expired_no_member_response (TERMINAL)
                     ▼                     │
              changes_requested ───────────┘  (marketing prepares the next version)

rejected · cancelled · sent · failed_to_dispatch · expired_no_member_response  = TERMINAL
rejected/cancelled reachable from: submitted · in_design · awaiting_member_approval ·
changes_requested · member_approved · approved (cancel only, as today)
```

New/changed CASE arms (the `ELSE → empty targets` fail-closed default of `0217:65-70` is kept):

| from | allowed targets after 0305 |
|---|---|
| `submitted` | `approved`, `rejected`, `cancelled`, **`in_design`** |
| `in_design` | `awaiting_member_approval`, `rejected`, `cancelled` |
| `awaiting_member_approval` | `member_approved`, `changes_requested`, `rejected`, `cancelled`, `expired_no_member_response` |
| `changes_requested` | `in_design`, `rejected`, `cancelled` |
| `member_approved` | `approved`, `changes_requested`, `in_design`, `rejected`, `cancelled` |
| `approved` | `sending`, `cancelled`, `failed_to_dispatch`, **`changes_requested`**, **`in_design`** |
| `expired_no_member_response` | ∅ |

Application guards on top of the DB machine: `approved → in_design` and `approved →
changes_requested` require `current_round >= 1` (an approve-as-submitted E-Blast was never in a
design round); `→ awaiting_member_approval` requires an unsent version that passed the sanitiser
and size rules (FR-004); `awaiting_member_approval → member_approved | changes_requested` requires
a **member** session of the owning member company (FR-013); `member_approved → approved` requires
`broadcasts.send` and a confirmed time ≥ `now + 5 min` (`approve-broadcast.ts:110-116`);
`submitted → in_design` requires the feature flag — **the only flagged edge, and the gate is on the
edge, not on the route that carries it** (R18): the same `POST …/[id]/version` from
`changes_requested`, `member_approved` or `approved` is an exit-side write on a row already inside
the round and stays available with the flag off, because FR-034 requires an in-flight E-Blast to
remain **completable** and re-opening a working copy is the only way to complete one the member sent
back (`/speckit.analyze` round 3 H1). The flag's **second** effect is not a transition at all: the
outbox drainer skips the five new `notification_type` values while it is off (§ 7.3), so no F119
email leaves the platform in that state even though the enqueues still happen (round 4 H2).

**Expiry scope (FR-022a)**: `→ expired_no_member_response` exists on **one** `from` state,
`awaiting_member_approval`, and the daily scan's predicate names that same status. Once the member
has approved, or marketing has confirmed a schedule, **no expiry can occur** — there is no edge for
it in either the Domain map or the DB trigger.

**The Sending cut-off (FR-015)**: "sending begins" is the moment the platform hands the E-Blast to
the delivery provider, i.e. entry into `sending`. Before that moment a member withdrawal and a
marketing rejection are **always** available (every in-progress stage above has a `cancelled` /
`rejected` exit); from `sending` onward **never** — the row is off the withdrawable set and the
application answers 409 while the send completes. `cancel-cutoff-policy.ts:47,49` widens to
`IN_PROGRESS_BROADCAST_STATUSES`; its existing `sending`-with-batches arm is the pre-existing
operator path and is not extended to the member.

**A lapsed member still decides (spec § Edge Cases)**: reading an E-Blast and deciding on a pending
version are **not** benefit actions, so a lapsed or halted member may still open their own E-Blast
and approve, request changes or withdraw. The existing membership refusals apply at **send** time
only, and the 30-day expiry clock keeps running throughout.

### 8.3 What the immutability trigger exempts, and where

| write | permitted on | mechanism |
|---|---|---|
| `scheduled_for` | `submitted → approved` (today, unchanged) | existing exemption, kept verbatim |
| `subject`, `body_html`, `body_source` | **`member_approved → approved` only** — the promotion of the approved version (FR-012a a) | new exemption E1 |
| `scheduled_for` | `OLD.status ∈ ('member_approved','approved')` → `NEW.status ∈ ('approved','changes_requested','in_design')` — confirm, change, and cancel on withdrawal or a voiding edit (FR-012a b) | new exemption E2 |
| `segment_type`, `segment_params`, `custom_recipient_emails` | **never** after `draft` | unchanged (FR-005) |
| `proposed_send_at` | **never** after `draft` | added to the frozen set |
| the six new columns | freely (they are workflow bookkeeping, not content) | not in the blocklist; **added to the GUC redaction arm's forbidden list** so the erasure scrub cannot move a row through the workflow |

**What voids a member approval (FR-012)**: only a change to the **content** columns —
`subject`, `body_html`, `body_source` — which in practice means the
`member_approved|approved → in_design` transition, the single place a new working copy is opened.
That transition clears `approved_version_id` and `scheduled_for` and emits
`broadcast_member_approval_voided`. Writes that are **not** content and therefore void nothing:
`note_to_member` on a version, `scheduled_for` alone (E2 — confirm, change, cancel), the four
`tenant_broadcast_settings.brand_*` columns, and any of the six workflow-bookkeeping columns.

The FR-012a test (`tests/integration/broadcasts/eblast-immutability-trigger.test.ts`) asserts a
direct DB `UPDATE` of `subject`, `body_html` or `scheduled_for` still raises
`broadcast_immutable_after_submit` on every non-exempt transition **and** on a no-status-change
update in each new stage, and that the two exempt edges succeed.

## 9. Allowance bucket after the change (FR-020, SC-007)

`IN_PROGRESS_BROADCAST_STATUSES` (Domain, one constant — R7):

```
submitted · approved · in_design · awaiting_member_approval · changes_requested · member_approved
```

- **Reserved** while the status is in that set — `countMemberQuotaBucketsOnTx`
  (`drizzle-broadcasts-repo.ts:384`, today the literal `('submitted','approved')`), under the
  existing `pg_advisory_xact_lock('broadcasts-quota:…')` recheck (`:1132-1134`).
- **Consumed** on `sent` / `partial_delivery_accepted` with `quota_year_consumed` set — unchanged
  (`:394`).
- **Freed** on `rejected`, `cancelled`, `failed_to_dispatch` and the new
  `expired_no_member_response`, because none of them is in either set and the
  `broadcasts_quota_year_only_on_sent` CHECK forbids a consumed year on them.
- The **same** constant drives `listInFlightOwnedByMember` (`:1322`), the erasure/cancel cascade, so
  "in progress" means one thing everywhere. Rounds do not multiply the cost: the allowance is a
  property of the broadcast row, and there is exactly one row however many versions it carries.

## 10. Domain types (hand-declared, `src/modules/broadcasts/domain/**`)

```ts
// stage/
type BroadcastStage =
  | 'draft' | 'awaiting_marketing_review' | 'in_design' | 'awaiting_member_approval'
  | 'changes_requested' | 'member_approved' | 'scheduled' | 'sending' | 'sent'
  | 'rejected' | 'cancelled' | 'expired' | 'failed' | 'historical';
type WhoseTurn = 'marketing' | 'member' | null;            // FR-026: no 'system' turn

stageOf(status: BroadcastStatus): BroadcastStage;          // total, no default arm
turnOf(status: BroadcastStatus): WhoseTurn;                // total; null for draft/scheduled/sending/closed
const IN_PROGRESS_BROADCAST_STATUSES: readonly BroadcastStatus[];

// approval/
type BroadcastVersion = {
  id; tenantId; broadcastId; versionNo: number;
  subject: string; bodyHtml: string; bodySource: string; noteToMember: string | null;
  authoredByUserId: string; authoredByRole: BroadcastActorRole;
  sentToMemberAt: Date | null; createdAt: Date; updatedAt: Date;
};
type MemberDecisionKind = 'approved' | 'changes_requested' | 'approval_withdrawn';
type MemberDecision = {
  id; tenantId; broadcastId; versionId; round: number;
  decision: MemberDecisionKind; reason: string | null;
  decidedByUserId: string; decidedByContactId: string; decidedAt: Date;
};

// pure policies
isVersionEditable(v: BroadcastVersion): boolean;            // sentToMemberAt === null
requiresReason(kind: MemberDecisionKind): boolean;          // true unless 'approved'
// approved: NULL or 1–500 — never 0–500. A 0-length note passes a {min:0} Domain check and is then
// refused by the DB CHECK (`reason IS NULL OR char_length BETWEEN 1 AND 500`), i.e. a 500 at runtime
// instead of a 422. See § 12.
reasonBounds(kind: MemberDecisionKind): { min: 1; max: 500 | 2000; nullable: boolean };
nextReminder(stageEnteredAt, now, reminderStage): 'day3'|'day7'|'day23'|'expire'|null;  // FR-022/022a
scheduleDiffers(proposed: Date | null, confirmed: Date): boolean;                        // FR-018

// design-blocks/
type DesignBlock = { kind: 'cta'; href: string; text: string }        // text 1–60, href on the scheme allow-list, ≤ 3 per message
                 | { kind: 'banner'; src: string; alt: string };     // alt 1–125, full 600 px width, placeable anywhere
parseBlockMarkers(sanitisedHtml: string): readonly DesignBlock[];     // tolerant of attribute order
validateBlocks(blocks: readonly DesignBlock[]): BlockViolation[];     // cta_text_length | cta_link_scheme | too_many_cta | banner_alt_required
applyDesignBlocks(sanitisedHtml: string, brand: BrandSettings): string;  // runs AFTER sanitisation

// brand/
type BrandSettings = { primaryColor: string | null; postalAddress: string | null; logoUrl: string | null };
relativeLuminance(hex: string): number;                    // WCAG 2.1
contrastRatio(a: string, b: string): number;
meetsAaOnWhiteText(hex: string): boolean;                  // ratio(hex, '#ffffff') >= 4.5
```

## 11. Relationships

```
tenants(slug) 1──* broadcasts 1──* broadcast_versions 1──* broadcast_member_decisions
                     │  └─ approved_version_id ─────────▶ broadcast_versions (the SC-002 proof)
                     └──* broadcast_images (owner_kind='broadcast')
broadcast_templates 1──* broadcast_images (owner_kind='template')
tenant_broadcast_settings 1──1 tenants            (brand colour + postal address)
tenant_invoice_settings   1──1 tenants            (logo — READ ONLY from here, FR-041b)
users 1──* broadcast_versions (authored_by_user_id) · 1──* broadcast_member_decisions (decided_by_user_id)
contacts 1──* broadcast_member_decisions (decided_by_contact_id)
audit_log ← one row per transition (research R24)
notifications_outbox ← queued per hand-off, ids only (research R14)
```

## 12. Sizes and limits

| thing | limit | source |
|---|---|---|
| subject | 200 chars | `broadcasts_subject_length` (`schema.ts:278-281`), mirrored on versions. Checked at **every save and again at send-to-member** (FR-004) |
| body HTML | 200 KB (`octet_length`), **including design-block markup** | `broadcasts_body_html_size` (`:284-287`), mirrored on versions; same two checkpoints (FR-004) |
| marketing's note to the member | 1,000 chars | FR-006; new CHECK on `broadcast_versions.note_to_member` |
| member's approval note | **null, or 1–500 chars** (optional, but never an empty string) | FR-009; the `decision = 'approved'` arm of the decisions CHECK. The Domain `reasonBounds('approved')` must say *null or 1–500*, not *0–500* — a 0-length note would pass Domain and be refused by the CHECK |
| member's changes-requested / withdrawal reason | 1–2,000 chars, **mandatory** | FR-010, FR-015a; the other arm of the same CHECK |
| brand postal address | 300 chars, line breaks allowed | FR-041c; new CHECK |
| brand primary colour | `#RRGGBB`, contrast ≥ 4.5:1 vs white; **email only** | CHECK (format) + Domain (contrast) |
| image | 5 MB, png/jpeg/webp/gif, ClamAV-clean, allowlisted host | `upload-inline-image.ts:38`, `image-storage-port.ts:20-24` — unchanged for staff and template images (FR-040) |
| image description (alt) | 1–125 chars, any language, required before insert | FR-040; Domain + editor dialog, carried into the sent email |
| CTA button | text 1–60 chars; link on the scheme allow-list; **≤ 3 per message** | FR-041; Domain `validateBlocks` |
| banner image | the image rules + a required description; full 600 px width; placeable anywhere | FR-041 |
| member writes (approve / request changes / withdraw) | 60 per minute per user | spec § Roles — the existing E-Blast action bucket |
| test copies | **10 per user per hour** (members and staff alike) | FR-037, spec § Roles |
| preview renders | 30 per minute per actor | R11 + spec § Roles — an amplification guard on a server-side render, not a workflow limit |
| versions per broadcast | no cap (FR: "no hard cap"); the round number is visible so a long negotiation is noticed | spec § Edge Cases |
| reminders | exactly one per threshold; day 3, day 7, day 23 warning, day 30 close | FR-022 / FR-022a, `member_reminder_stage` |
| recipients per tick | 500 unless `FEATURE_F7_IMPORT_AUDIENCE` is ON | unchanged (`DELIVERABLE_RECIPIENTS_PER_TICK`) |
