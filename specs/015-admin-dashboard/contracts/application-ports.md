# Contract — F9 Application Ports (internal interfaces)

**Branch**: `015-admin-dashboard` | **Date**: 2026-05-25

These are the Application-layer use-case + port contracts for F9. Types are
descriptive (TS-flavoured) — Infrastructure implements the ports; Presentation calls
only the use-cases. All use-cases take `ctx: TenantContext` and thread `tx` via
`runInTenant`. All return `Result<T, E>` (no thrown control flow). RBAC is checked
inside each use-case via the role policy.

---

## `insights` module (new) — public barrel `@/modules/insights`

### `listDashboard` (US1)
```
listDashboard(
  meta: { actorUserId: UUID; actorRole: Role; requestId: string },
  ctx: TenantContext,
  deps: InsightsDeps
): Promise<Result<DashboardView, DashboardError>>
```
- Reads the cached `dashboard_metrics_cache` row; returns `{ metrics, computedAt }`.
- Role projection: `admin` → full; `manager` → finance fields redacted; `member` →
  `forbidden`. Emits `dashboard_viewed`.
- `DashboardError`: `forbidden | snapshot_unavailable`.

### `computeDashboardSnapshot` (US1, invoked by cron)
```
computeDashboardSnapshot(ctx, deps): Promise<Result<DashboardSnapshot, SnapshotError>>
```
- Recomputes counts (members by status, YTD paid revenue, overdue, broadcasts awaiting
  approval, under-delivered benefits), the activity-feed head, and the smart-insight set
  (minus dismissals). Upserts the cache row in a transaction; clears `stale`.
- Pure inputs read via source-reader ports (no direct cross-module table access).

### `listSmartInsights` / `dismissInsight` (US1)
```
dismissInsight(input: { insightKey: InsightKey; scopeRef?: string },
  meta, ctx, deps): Promise<Result<void, InsightError>>
```
- Writes `smart_insight_dismissals` (idempotent on unique key). Emits
  `smart_insight_dismissed`. Catalogue is the fixed Domain enum (≥3 keys).

### `computeBenefitUsage` (US4)
```
computeBenefitUsage(input: { memberId: UUID; year?: number },
  meta, ctx, deps): Promise<Result<BenefitUsageView, BenefitError>>
```
- Reads `benefitMatrix` (plans barrel) + e-blast consumption (broadcasts barrel) +
  cultural-ticket consumption (events barrel) for the membership year. Computes
  `used/entitlement` per quantifiable benefit, `lastUsedAt`, and the under-use warning
  (`elapsedYear% − consumed% ≥ 25pp`). Unlimited benefits → `{ kind: 'unlimited' }`.
- Authorisation: member → own only; admin/manager → any. Emits `member_benefit_viewed`
  on staff reads.

### `projectEngagementScore` (US1, pure)
```
projectEngagementScore(member: { riskScore: number|null; riskScoreBand: Band|null })
  : { score: number|null; band: EngagementBand|null }
```
- `score = clamp(100 − riskScore, 0, 100)`; band inverted. Pure Domain function; no I/O.
  Consumed by the member-list column + dashboard. Staff-only at the presentation layer.

### Directory: `searchDirectory` / `updateDirectoryListing` / `generateDirectoryEbook` / `exportDirectoryJson` (US5)
```
searchDirectory(input: { q?; tier?; industry?; location?; page?; pageSize? },
  meta, ctx, deps): Promise<Result<DirectorySearchResult, DirectoryError>>   // staff: all members
updateDirectoryListing(input: { memberId; listed; fieldVisibility; metadata },
  meta, ctx, deps): Promise<Result<void, DirectoryError>>                    // member: own; admin: any
generateDirectoryEbook(meta, ctx, deps): Promise<Result<ExportJobRef, DirectoryError>>  // → async job
exportDirectoryJson(meta, ctx, deps): Promise<Result<ExportJobRef, DirectoryError>>     // → async job
```
- Published outputs (E-Book/JSON) include a member only if `listed=true`, only fields
  with `fieldVisibility[field]=true`, email omitted unless toggled on (FR-025/028).
- Emit `directory_listing_updated` / `directory_ebook_generated` / `directory_json_exported`.

### GDPR export: `requestDataExport` / `processExportJob` (US6)
```
requestDataExport(input: { subjectMemberId: UUID },
  meta, ctx, deps): Promise<Result<ExportJobRef, ExportError>>
processExportJob(input: { jobId: UUID },
  ctx, deps): Promise<Result<void, ExportError>>   // cron worker
```
- `requestDataExport`: member → own only (`forbidden` otherwise); admin → on-behalf
  (attributed to admin). Idempotent (returns existing job for same idempotency key).
  Emits `data_export_requested`.
- `processExportJob`: claims `requested` job under advisory lock → builds archive
  (profile, contacts, invoices+PDFs, events, broadcasts, **redacted audit subset** =
  member-performed ∪ member-targeted, third-party PII + internal annotations stripped)
  → uploads to **private** Blob → `ready` + token hash + `expires_at`. Emits
  `data_export_generated` / `data_export_failed`. State-machine transitions Domain-enforced.

### Ports (Infrastructure implements)
- `SnapshotRepo` (read/upsert cache), `InsightDismissalRepo`, `DirectoryRepo`,
  `ExportJobRepo`, `InsightsAuditPort` (record/recordInTx), `PdfRenderPort` (reuse F4
  react-pdf adapter), `PrivateBlobPort` (put private + sign token + delete), and
  **source-reader ports** (`MemberSource`, `PlanSource`, `BroadcastConsumptionSource`,
  `EventConsumptionSource`, `InvoiceSource`) — each implemented by an adapter that calls
  the respective module's barrel (no direct foreign-table imports).

---

## `auth` module (extend) — barrel `@/modules/auth`

### `auditQuery` (US2)
```
auditQuery(
  input: { eventType?: AuditEventType[]; actorUserId?: UUID; targetRef?: string;
           from?: ISODate; to?: ISODate; cursor?: string; limit?: 1..100 },
  meta: { actorUserId; actorRole; requestId },
  ctx: TenantContext,
  deps: AuditQueryDeps
): Promise<Result<AuditQueryResult, AuditQueryError>>
```
- Read-only over `audit_log`; tenant-scoped; keyset paginated `(timestamp DESC, id DESC)`.
- Role redaction of payload fields (admin full; manager/member projected). Emits
  `audit_log_queried`. A sibling `auditExport` streams the filtered set (sync) and emits
  `audit_log_exported`.
- `AuditQueryError`: `forbidden | invalid_range`. **No mutation path exists** (append-only).

---

## `members` module (extend)

### `timelineList` (US3) — signature UNCHANGED
```
timelineList(input: { memberId; cursor?; limit? }, meta, ctx, deps)
  : Promise<Result<TimelineListOutput, TimelineListError>>
```
- Same input/output + same role redaction as F3. **Only the backing repo changes**: it
  now reads `member_timeline_v` (6 sources) instead of `audit_log` alone, and accepts
  optional filters `{ source?: TimelineSource[]; from?; to?; actorKind? }` (additive,
  defaulted) per FR-015.

---

## Result / error conventions
- Every use-case returns `Result<T, E>` from `src/lib/result.ts`.
- Authorisation failures → `forbidden` variant (never a thrown 403).
- Cross-tenant access is impossible by construction (RLS); any probe that still reaches
  a guard emits `insights_cross_tenant_probe` (high-severity) and returns empty/forbidden.
