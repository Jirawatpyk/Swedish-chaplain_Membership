# Contract: Saved Segments (US6)

**Spec FRs**: FR-038..044 · **Use-cases**: `createSavedSegment`, `previewSavedSegmentCount`, `updateSavedSegment`, `deleteSavedSegment`

---

## 1. Server actions

### 1.1 `createSavedSegment({ name, filters })` — admin only

**Route**: `POST /api/admin/broadcasts/segments`
**Auth**: admin role + tenant ctx.
**Input**:
```typescript
const SavedSegmentFilter = z.object({
  field: z.enum(['tier', 'status', 'country', 'joined_at', 'last_renewed_at']),
  operator: z.enum(['in', 'not_in', 'gte', 'lte', 'between']),
  value: z.union([z.string(), z.array(z.string()), z.number(), z.array(z.number())]),
});

const Input = z.object({
  name: z.string().min(1).max(100),
  filters: z.array(SavedSegmentFilter).min(1).max(4), // FR-039: 1-4 rows AND-only
});
```
**Output**: `Promise<Result<{ segmentId: string }, BroadcastError>>`.
**Audit event**: `saved_segment_created` (actor + segment_id + name + filters snapshot).

### 1.2 `previewSavedSegmentCount(filters)` — admin only, read-only

**Route**: `POST /api/admin/broadcasts/segments/preview`
**Auth**: admin role + tenant ctx.
**Input**: `{ filters: SavedSegmentFilter[] }` (same shape as create).
**Output**: `Promise<Result<{ count: number; durationMs: number }, BroadcastError>>`.
**Pipeline**: Translate filters → SQL via a whitelisted predicate builder (one branch per allowed (field, operator) combination — NO dynamic SQL string construction) → run COUNT(*) against `members` joined to `contacts` with `receive_broadcasts=true` (US3 cross-cutting).
**Latency**: ≤2s p95 for tenants ≤10k members (SC-011).
**No audit event** (read-only preview).

### 1.3 `updateSavedSegment({ segmentId, name, filters })` — admin only

**Route**: `PATCH /api/admin/broadcasts/segments/:id`
**Auth**: admin role.
**Pipeline**: Validate segment is NOT referenced by a broadcast in `submitted`/`approved`/`sending` state (FR-043); reject with `SEGMENT_IN_USE` if so.
**Audit event**: `saved_segment_updated` (actor + before/after value).

### 1.4 `deleteSavedSegment(segmentId)` — admin only

**Route**: `DELETE /api/admin/broadcasts/segments/:id`
**Auth**: admin role.
**Pipeline**: Same in-use guard as update; hard-delete (no soft-delete since the segment is a definition, not member-facing content).
**Audit event**: `saved_segment_deleted`.

### 1.5 `resolveBroadcastSavedSegment({ broadcastId, segmentId })` — invoked during dispatch

**Invocation**: Inside the existing F7 MVP `resolveSegmentRecipients` use-case, when `segment_kind='saved'`.
**Behavior**: Load saved segment by id (RLS-scoped); translate filters → SQL; resolve to recipient list using SAME downstream rules as F7 MVP fixed segments (dedup + primary-contact + US3 opt-in + self-exclude + suppression filter).
**Audit**: Existing F7 MVP `broadcast_segment_resolved` event carries `segment_id` field.

---

## 2. Error taxonomy

| Code | When | HTTP status |
|------|------|-------------|
| `segment_name_duplicate` | Create with existing tenant-scoped name | 409 |
| `segment_filter_invalid` | Field/operator/value combination invalid OR >4 rows OR <1 row | 400 |
| `SEGMENT_IN_USE` | Update/delete a segment referenced by in-flight broadcast | 409 |
| `SEGMENT_NOT_FOUND` | segmentId invalid OR RLS hides | 404 |
| `CROSS_TENANT_PROBE` | Tenant ctx mismatch | 403 + audit |

---

## 3. UI surface

- **Admin saved segments page** — `/admin/broadcasts/segments` — list of segments + "New segment" CTA
- **Segment editor** — modal with name field + filter rows (add/remove + field selector + operator selector + value input); "Preview count" button calls 1.2
- **Compose segment picker** — extends existing F7 MVP segment dropdown with saved segments under a sub-heading "Custom segments"

WCAG verification: filter row controls are `<fieldset>` per row with `<legend>`; field/operator selects are semantic `<select>` (no comboboxes — accessibility win over typing-search); preview-count result has `aria-live="polite"`.
