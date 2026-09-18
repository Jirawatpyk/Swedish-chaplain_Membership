# Data Model — 119 E-Blast Two-Sided Approval Workflow

Phase 1 output. Entities from `spec.md` § Key Entities, resolved against `research.md` (R2, R3, R4,
R5, R7, R8, R13, R17, R22, R24). DDL is **hand-written SQL** in two migrations; Drizzle schema in
`src/modules/broadcasts/infrastructure/schema.ts`. Drizzle-inferred types stay in Infrastructure;
the Domain types in § 9 are hand-declared.

| migration | journal | carries |
|---|---|---|
| `0304_eblast_images_and_brand.sql` | `idx: 305`, `when: 1798543700000` | `broadcast_images` (+RLS/FORCE) · 4 brand columns on `tenant_broadcast_settings` · `audit_event_type` += `broadcast_test_copy_sent`, `broadcast_brand_settings_changed` |
| `0305_eblast_member_approval.sql` | `idx: 306`, `when: 1798543800000` | **the FR-012a bundle**: `broadcast_status` +5 · `broadcasts_immutable_after_submit_fn` amended · `broadcasts_state_machine_fn` amended · `broadcast_versions` + `broadcast_member_decisions` (+RLS/FORCE) · 6 columns on `broadcasts` incl. `proposed_send_at` · `audit_event_type` += 10 · `notification_type` += 5 · the `proposed_send_at` backfill |

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
| `reason` | `text NULL CHECK (char_length BETWEEN 1 AND 2000)` | **required** for `changes_requested` and `approval_withdrawn` (FR-010, FR-015a), optional note for `approved`. Enforced by a CHECK: `(decision = 'approved') OR (reason IS NOT NULL)` |
| `decided_by_user_id` | `uuid NOT NULL` | the portal user |
| `decided_by_contact_id` | `uuid NOT NULL` | the contact record they were linked to |
| `decided_at` | `timestamptz NOT NULL DEFAULT now()` | |

**Indexes**: `(tenant_id, broadcast_id, decided_at DESC)` (the thread); `(tenant_id, version_id)`.

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
| `current_round` | `smallint NOT NULL DEFAULT 0` | incremented when a version is sent to the member (FR-026). 0 = never formatted |
| `approved_version_id` | `uuid NULL` | FK `(tenant_id, approved_version_id)` → `broadcast_versions(tenant_id, id)`. Set on member approval, cleared when the approval is voided or withdrawn. **The proof for SC-002** |
| `member_reminder_stage` | `smallint NOT NULL DEFAULT 0 CHECK (BETWEEN 0 AND 3)` | 0 none · 1 day-3 sent · 2 day-7 sent · 3 day-23 warning sent. Reset to 0 on every entry into `awaiting_member_approval` |
| `member_expiry_notified_at` | `timestamptz NULL` | stamped when the day-30 closure notice is enqueued (idempotency for the daily tick) |

**Backfill** (same migration): `UPDATE broadcasts SET proposed_send_at = scheduled_for WHERE status
= 'submitted' AND scheduled_for IS NOT NULL;` — only rows still awaiting a decision still carry an
untouched proposal (`approveBroadcast` overwrites `scheduled_for`,
`approve-broadcast.ts:118-119,151`). Every other historical row keeps `NULL`, and the UI shows
"not recorded".

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
| `deleted_at` | `timestamptz NULL` | marked by erasure / withdrawal / rejection; the bytes go on the next sweep |

**Indexes**: `(tenant_id, owner_kind, owner_id)`; `(tenant_id, content_hash)` — the
**last-reference rule** (`DELETE the blob only when no row with the same `content_hash` has
`deleted_at IS NULL``); `(tenant_id, deleted_at) WHERE deleted_at IS NOT NULL` — the sweep.

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
| `brand_postal_address` | `text NULL CHECK (char_length(brand_postal_address) BETWEEN 1 AND 500)` | FR-041c. NULL ⇒ the footer shows the chamber name only and the Brand page flags it missing |
| `brand_updated_at` | `timestamptz NULL` | |
| `brand_updated_by_user_id` | `uuid NULL` | |

The contrast rule (white text ≥ 4.5:1) is **Application + Domain**, not a CHECK: it needs the WCAG
luminance formula, it must produce a human-readable refusal with the computed ratio, and a CHECK
could not be relaxed if the platform ever supports dark button text. The **logo** is never written
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

### 7.2 `audit_event_type` += 12

`broadcast_test_copy_sent`, `broadcast_brand_settings_changed` (0304);
`broadcast_version_started`, `broadcast_version_sent_to_member`, `broadcast_member_approved`,
`broadcast_member_changes_requested`, `broadcast_member_approval_withdrawn`,
`broadcast_member_approval_voided`, `broadcast_schedule_confirmed`,
`broadcast_approval_reminder_sent`, `broadcast_approval_expiry_warned`,
`broadcast_approval_expired` (0305).
Five places (research R24): `F7_AUDIT_EVENT_TYPES` **55 → 67** with the static assert at
`audit-port.ts:234` updated in the same edit · `DB_ONLY_AUDIT_EVENT_TYPES`
(`auth/infrastructure/db/schema.ts:522-678` — every `broadcast_*` value lives there) · the migration
statements · `audit.eventType.*` labels EN/TH/SV · `scripts/lib/enum-migration-guard.ts`.
Retention: `f7RetentionFor` returns 5 for every F7 event (`audit-port.ts:257`) — no tax document is
produced, so none of the twelve is a 10-year event.

### 7.3 `notification_type` += 5 (0305)

`eblast_submitted_marketing`, `eblast_member_decided_marketing`, `eblast_version_sent_member`,
`eblast_schedule_confirmed_member`, `eblast_approval_lifecycle`. Each **must** ship with its
`case` arm in `buildPayload` (`src/app/api/cron/outbox-dispatch/route.ts:194`) in the same PR: the
`default:` arm returns `null` (`:543`), which retries for ~16 h before permanently failing, so an
arm-less type is a silent outage. Also added to `enum-migration-guard.ts`.

## 8. Stages, statuses and the state machine

### 8.1 Stage ↔ status (FR-019) — `stageOf(status)`, pure Domain

| FR-019 stage | `broadcast_status` | whose turn (FR-026) |
|---|---|---|
| Draft | `draft` | member (or the staff proxy owner) |
| Awaiting marketing review | `submitted` | marketing |
| In design | `in_design` | marketing |
| Awaiting member approval | `awaiting_member_approval` | member |
| Changes requested by member | `changes_requested` | marketing |
| Member approved — awaiting schedule | `member_approved` | marketing |
| Scheduled | `approved` | system |
| Sending | `sending` | system |
| Sent | `sent` | — |
| Rejected | `rejected` | — |
| Withdrawn / Cancelled | `cancelled` | — |
| Expired — no member response | `expired_no_member_response` | — |
| Failed | `failed_to_dispatch` | — |
| *(historical only, never offered)* | `partially_sent`, `partial_delivery_accepted` | — |

`approved` is the **only** dispatchable status (`dispatch-scheduled/route.ts:168-183` scans
`status = 'approved' AND scheduled_for <= now()`), which is why no waiting stage sits on it (R5).
"Scheduled" replaces today's "Approved" label in both status namespaces — an unflagged copy change
shipped with PR-3, not PR-1.

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
`submitted → in_design` requires the feature flag (R18 — the only flagged edge).

### 8.3 What the immutability trigger exempts, and where

| write | permitted on | mechanism |
|---|---|---|
| `scheduled_for` | `submitted → approved` (today, unchanged) | existing exemption, kept verbatim |
| `subject`, `body_html`, `body_source` | **`member_approved → approved` only** — the promotion of the approved version (FR-012a a) | new exemption E1 |
| `scheduled_for` | `OLD.status ∈ ('member_approved','approved')` → `NEW.status ∈ ('approved','changes_requested','in_design')` — confirm, change, and cancel on withdrawal or a voiding edit (FR-012a b) | new exemption E2 |
| `segment_type`, `segment_params`, `custom_recipient_emails` | **never** after `draft` | unchanged (FR-005) |
| `proposed_send_at` | **never** after `draft` | added to the frozen set |
| the six new columns | freely (they are workflow bookkeeping, not content) | not in the blocklist; **added to the GUC redaction arm's forbidden list** so the erasure scrub cannot move a row through the workflow |

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
type WhoseTurn = 'marketing' | 'member' | 'system' | null;

stageOf(status: BroadcastStatus): BroadcastStage;          // total, no default arm
turnOf(status: BroadcastStatus): WhoseTurn;                // total
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
nextReminder(stageEnteredAt, now, reminderStage): 'day3'|'day7'|'day23'|'expire'|null;  // FR-022/022a
scheduleDiffers(proposed: Date | null, confirmed: Date): boolean;                        // FR-018

// design-blocks/
type DesignBlock = { kind: 'cta'; href: string; text: string }
                 | { kind: 'banner'; src: string; alt: string };
parseBlockMarkers(sanitisedHtml: string): readonly DesignBlock[];     // tolerant of attribute order
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
| subject | 200 chars | `broadcasts_subject_length` (`schema.ts:278-281`), mirrored on versions |
| body HTML | 200 KB (`octet_length`) | `broadcasts_body_html_size` (`:284-287`), mirrored on versions |
| note to member | 1,000 chars | new CHECK |
| decision reason | 1–2,000 chars | new CHECK; FR-010 makes it mandatory for two of the three kinds |
| brand postal address | 500 chars | new CHECK |
| brand primary colour | `#RRGGBB`, contrast ≥ 4.5:1 vs white | CHECK (format) + Domain (contrast) |
| image | 5 MB, png/jpeg/webp/gif, ClamAV-clean, allowlisted host | `upload-inline-image.ts:38`, `image-storage-port.ts:20-24` — unchanged for staff and template images (FR-040) |
| versions per broadcast | no cap (FR: "no hard cap"); the round number is visible so a long negotiation is noticed | spec § Edge Cases |
| reminders | exactly one per threshold; day 3, day 7, day 23 warning, day 30 close | FR-022 / FR-022a, `member_reminder_stage` |
| recipients per tick | 500 unless `FEATURE_F7_IMPORT_AUDIENCE` is ON | unchanged (`DELIVERABLE_RECIPIENTS_PER_TICK`) |
