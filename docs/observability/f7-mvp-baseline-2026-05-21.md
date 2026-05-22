# F7 MVP Baseline Snapshot — pre-F7.1a ship

**Captured by**: T137 (F7.1a Phase 6 polish, `014-email-broadcast-advance`)
**Captured at**: 2026-05-21 (scaffold) — operator MUST re-run on ship-day and replace placeholders
**Purpose**: Lock the F7 MVP empirical baseline so F7.1b promotion criteria (in `specs/014-email-broadcast-advance/f71b-backlog.md`) reference concrete numbers rather than hand-waved assumptions per critique P1.

## How to run

Each section below has a SQL query block. Run via Neon Console (Project → SQL Editor) against the `swecham_prod` database. The query results MUST be pasted into the "Result" line under each block, then the file committed as `f7-mvp-baseline-2026-{ship-date}.md` (rename today's file at ship-time).

> **Tenant scoping note**: Today's production has one tenant (SweCham). Multi-tenant aggregates collapse to single-row results. The query shapes are forward-compatible for future tenants — collect them now so the SaaS expansion has a baseline.

---

## 1. Tenant count

```sql
SELECT COUNT(DISTINCT tenant_id) AS tenant_count
  FROM broadcasts;
```

**Result**: `<TBD on ship-day>` (expected: 1 — SweCham only)

## 2. Broadcasts per week per tenant (last 12 weeks)

```sql
SELECT tenant_id,
       date_trunc('week', sending_started_at) AS week,
       COUNT(*) AS broadcasts_sent
  FROM broadcasts
 WHERE status = 'sent'
   AND sending_started_at > now() - interval '12 weeks'
 GROUP BY tenant_id, week
 ORDER BY week DESC, tenant_id;
```

**Result**: `<TBD on ship-day — paste table>`

**Aggregate (median + p95)**:
- Median broadcasts/week/tenant: `<TBD>` (expected low — ≤2)
- p95 broadcasts/week/tenant: `<TBD>` (expected ≤5)
- Max in any single week: `<TBD>`

## 3. Segment distribution

```sql
SELECT tenant_id,
       segment_type,
       COUNT(*) AS broadcasts_with_this_segment,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY tenant_id), 1)
         AS pct_of_tenant_total
  FROM broadcasts
 WHERE status = 'sent'
 GROUP BY tenant_id, segment_type
 ORDER BY tenant_id, broadcasts_with_this_segment DESC;
```

**Result**: `<TBD on ship-day — paste table>`

**Top-3 segments (per tenant)**:
- `<TBD>`

## 4. Maximum recipient count (per broadcast)

```sql
SELECT MAX(estimated_recipient_count) AS max_recipients_per_broadcast,
       AVG(estimated_recipient_count)::int AS avg_recipients_per_broadcast,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY estimated_recipient_count)
         AS p95_recipients_per_broadcast
  FROM broadcasts
 WHERE status = 'sent';
```

**Result**:
- Max recipients/broadcast: `<TBD>` (expected ≤131 — SweCham total members)
- Avg recipients/broadcast: `<TBD>`
- p95 recipients/broadcast: `<TBD>`

**Implication for F7.1a US1**: if max < 5,000 (F7 MVP ceiling) by a wide margin, the US1 50k ceiling is provisioned for future tenants, not today's SweCham scale.

## 5. Draft-abandonment rate

```sql
WITH lifecycle AS (
  SELECT broadcast_id,
         requested_by_member_id,
         status,
         created_at,
         submitted_at,
         CASE
           WHEN status = 'draft' AND created_at < now() - interval '30 days' THEN 'abandoned'
           WHEN status IN ('sent', 'partially_sent') THEN 'completed'
           WHEN status = 'cancelled' THEN 'cancelled'
           WHEN status = 'rejected' THEN 'rejected'
           ELSE 'in_progress'
         END AS lifecycle_state
    FROM broadcasts
   WHERE created_at > now() - interval '90 days'
)
SELECT lifecycle_state,
       COUNT(*) AS broadcast_count,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
  FROM lifecycle
 GROUP BY lifecycle_state
 ORDER BY broadcast_count DESC;
```

**Result**: `<TBD on ship-day — paste table>`

**Abandonment rate** (drafts > 30 days old / total drafts): `<TBD>` (expected < 20%)

## 6. Suppression-list growth rate (last 90 days)

```sql
SELECT date_trunc('week', suppressed_at) AS week,
       COUNT(*) AS new_suppressions,
       SUM(COUNT(*)) OVER (ORDER BY date_trunc('week', suppressed_at)) AS cumulative_suppressions
  FROM marketing_unsubscribes
 WHERE suppressed_at > now() - interval '90 days'
 GROUP BY week
 ORDER BY week;
```

**Result**: `<TBD on ship-day — paste table>`

**Weekly growth rate (avg)**: `<TBD>` new suppressions/week
**Cumulative suppressions at snapshot**: `<TBD>`

## 7. Quota consumption (per member, last 12 months)

```sql
SELECT requested_by_member_id_plan_snapshot AS plan_tier,
       AVG(quota_year_consumed) AS avg_consumed,
       MAX(quota_year_consumed) AS max_consumed,
       COUNT(DISTINCT requested_by_member_id) AS members_in_tier
  FROM broadcasts
 WHERE status = 'sent'
   AND sending_started_at > now() - interval '12 months'
 GROUP BY plan_tier;
```

**Result**: `<TBD on ship-day — paste table>`

**Tier with highest avg quota consumption**: `<TBD>`
**Members at quota cap (consumed == benefit_matrix.eblast_per_year)**: `<TBD>`

---

## Cross-references

- F7.1a critique P1 (originating call for this baseline): `specs/014-email-broadcast-advance/critiques/critique-20260518-003047.md`
- F7.1b backlog promotion criteria (downstream consumer): `specs/014-email-broadcast-advance/f71b-backlog.md § Promotion criteria`
- F7 MVP retrospective (qualitative source of the 8-US set): `specs/010-email-broadcast/retrospective.md`

## Re-snapshot cadence

- **Ship-day**: replace all `<TBD>` placeholders with live SQL results. Rename to `f7-mvp-baseline-2026-{actual-ship-date}.md` so the filename matches the captured-at date.
- **Quarterly**: re-snapshot to track baseline drift. New file per quarter; the latest filename always represents the most recent baseline.
- **Pre-F7.1b promotion**: re-run if any F7.1b user-story is up for promotion, to verify the promotion criteria conditions are met against the latest data (not the stale F7-MVP-ship snapshot).
