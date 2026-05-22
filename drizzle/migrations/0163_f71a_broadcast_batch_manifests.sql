-- ---------------------------------------------------------------------------
-- F7.1a US1 (T013 + T016) — broadcast_batch_manifests table.
--
-- Source of truth: specs/014-email-broadcast-advance/data-model.md § 2.2
-- + plan.md § Discoveries (FK is composite (tenant_id, broadcast_id) →
-- broadcasts(tenant_id, broadcast_id); data-model wrote broadcasts.id
-- which does not exist).
--
-- One row per dispatch batch under a broadcast. F7.1a US1 splits
-- broadcasts of >10k recipients (Resend per-audience cap) into N
-- parallel batches with concurrency cap 4. Each batch carries:
--   - own provider audience id (Resend audience for that batch)
--   - own idempotency key (extension of F7 MVP convention:
--     `broadcast-{broadcastId}-batch-{batchIndex}-attempt-{retryCount}`)
--   - per-batch delivery counters (rolled up to broadcast row by
--     reconcile-stuck-sending + webhook handler)
--
-- Status enum (TEXT — not pgEnum since the set is small + extends
-- without ALTER TYPE rituals):
--   pending → sending → sent | failed
--   pending → cancelled    (set by cancelBroadcast use-case per FR-004
--                           when admin halts mid-dispatch; per
--                           data-model § 2.2 N1)
--   sending → cancelled    (rare race; cancelBroadcast wins via
--                           advisory lock per FR-004)
--
-- ON DELETE CASCADE — manifests are bound to a broadcast row's
-- lifetime; deleting the broadcast (admin force-delete in F7.1b+)
-- removes them.
-- ---------------------------------------------------------------------------

CREATE TABLE "broadcast_batch_manifests" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                text NOT NULL,
  "broadcast_id"             uuid NOT NULL,

  "batch_index"              integer NOT NULL,
  "recipient_count"          integer NOT NULL,
  "recipient_range_start"    integer NOT NULL,
  "recipient_range_end"      integer NOT NULL,

  "status"                   text NOT NULL DEFAULT 'pending',
  "provider_audience_id"     text,
  "idempotency_key"          text NOT NULL,
  "retry_count"              integer NOT NULL DEFAULT 0,

  "delivered_count"          integer NOT NULL DEFAULT 0,
  "bounced_count"            integer NOT NULL DEFAULT 0,
  "complained_count"         integer NOT NULL DEFAULT 0,
  "unsubscribed_count"       integer NOT NULL DEFAULT 0,

  "dispatched_at"            timestamptz,
  "failed_at"                timestamptz,
  "failure_reason"           text,

  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "broadcast_batch_manifests_status_check"
    CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),

  CONSTRAINT "broadcast_batch_manifests_recipient_range_check"
    CHECK ("recipient_range_end" >= "recipient_range_start"),

  CONSTRAINT "broadcast_batch_manifests_retry_count_check"
    CHECK ("retry_count" >= 0 AND "retry_count" <= 5),

  -- Resend per-audience cap = 10000 (FR-002).
  CONSTRAINT "broadcast_batch_manifests_recipient_count_check"
    CHECK ("recipient_count" <= 10000),

  -- Composite FK to broadcasts. Cascade on broadcast delete.
  CONSTRAINT "broadcast_batch_manifests_broadcast_fkey"
    FOREIGN KEY ("tenant_id", "broadcast_id")
    REFERENCES "broadcasts"("tenant_id", "broadcast_id")
    ON DELETE CASCADE
);--> statement-breakpoint

-- Per-broadcast batch order uniqueness.
CREATE UNIQUE INDEX "broadcast_batch_manifests_tenant_broadcast_batch_uniq"
  ON "broadcast_batch_manifests" ("tenant_id", "broadcast_id", "batch_index");--> statement-breakpoint

-- Idempotency-key uniqueness within tenant (prevents Resend
-- double-dispatch on retry).
CREATE UNIQUE INDEX "broadcast_batch_manifests_idempotency_key_uniq"
  ON "broadcast_batch_manifests" ("tenant_id", "idempotency_key");--> statement-breakpoint

-- Cron dispatch scan (T055) and reconcile-stuck-sending (T056) filter
-- by tenant + status.
CREATE INDEX "broadcast_batch_manifests_tenant_status_idx"
  ON "broadcast_batch_manifests" ("tenant_id", "status");--> statement-breakpoint
