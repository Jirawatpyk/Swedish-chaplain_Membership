-- F7 US3 G2 — covering index for member-history paginated lookup.
--
-- The benefits page server component calls
--   `listForMemberPaginated(tenantId, memberId, { page, perPage })`
-- which executes:
--   SELECT … FROM broadcasts
--   WHERE tenant_id = ? AND requested_by_member_id = ?
--   ORDER BY created_at DESC, broadcast_id DESC
--   LIMIT ? OFFSET ?
--
-- Without a covering index Postgres falls back to scanning the
-- existing `broadcasts_tenant_status_member_idx` (which leads with
-- `status`) and re-sorting on `created_at`, costing O(N · log N) per
-- page request even when the per-member subset is small.
--
-- This index is laid out exactly to match the query shape:
--   (tenant_id, requested_by_member_id, created_at DESC, broadcast_id DESC)
-- so Postgres can satisfy both the WHERE and the ORDER BY from index
-- order alone — pagination becomes O(perPage) regardless of how many
-- rows the tenant has.
--
-- Why OFFSET (not cursor) at this scale: FR-016a caps each tenant at
-- 5,000 broadcasts/year, and per-member subsets stay in the low
-- hundreds even for high-engagement chambers. OFFSET on a covering
-- index is O(1) seek + O(perPage) read; cursor-based pagination
-- adds complexity (encode/decode + page→cursor mapping for numbered
-- UI) without measurable performance benefit at this scale. If a
-- tenant ever materially exceeds the 5k cap, the F7.1 follow-up can
-- migrate the read path to keyset/cursor without altering this index.

CREATE INDEX IF NOT EXISTS broadcasts_tenant_member_created_at_idx
  ON broadcasts (
    tenant_id,
    requested_by_member_id,
    created_at DESC,
    broadcast_id DESC
  );
