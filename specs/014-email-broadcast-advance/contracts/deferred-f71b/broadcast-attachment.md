# Contract: Broadcast Attachments (US4)

**Spec FRs**: FR-023..030a · **Clarifications**: round-1 Q2 + Q4, round-2 Q3 · **Use-cases**: `uploadBroadcastAttachment`, `scanBroadcastAttachment`, `garbageCollectOrphanAttachments`

---

## 1. Server actions

### 1.1 `uploadBroadcastAttachment(file, draftId)` — member compose surface

**Route**: `POST /api/member/broadcasts/attachment-upload`
**Auth**: member role + tenant ctx + ownership check (draft must belong to authenticated member).
**Input** (multipart):
```typescript
const Input = z.object({
  file: z.instanceof(File)
    .refine(f => f.size > 0, 'file_empty')
    .refine(f => f.size <= 25 * 1024 * 1024, 'broadcast_attachment_limit_exceeded'),
  draftId: z.string().uuid(),
});

const AllowedMimeTypes = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',// .pptx
  'text/plain', 'text/csv',
]);
```
**Output**: `Promise<Result<{ attachmentId: string; scanStatus: 'pending'; uploadDurationMs: number }, BroadcastError>>`.
**Pipeline**:
1. Boundary: validate MIME type allowlist (FR-025) — reject if not on list with `broadcast_attachment_type_forbidden`
2. Boundary: validate combined size against the existing draft attachments (FR-023 25 MB cap, 10 files cap) — reject with `broadcast_attachment_limit_exceeded`
3. Boundary: content-hash check — if hash already exists for this tenant, dedupe (don't re-upload)
4. Upload to Vercel Blob in tenant-scoped path
5. INSERT `broadcast_attachments` row with `scan_status='pending'`
6. Async invoke ClamAV scanner (background — DOES NOT block upload response)
**Audit events**: `broadcast_attachment_type_forbidden` (on MIME rejection), `broadcast_attachment_limit_exceeded` (on size/count rejection).

### 1.2 `scanBroadcastAttachment(attachmentId)` — internal async worker

**Invocation**: Background after upload (queued via `setImmediate` or workflow trigger).
**Auth**: System.
**Input**: `{ tenantId, attachmentId }`.
**Behavior**:
1. Read attachment blob from Vercel Blob
2. Send to ClamAV via `VirusScannerPort.scan()` (research.md § 1) with 5-minute timeout per FR-027
3. UPDATE attachment row:
   - verdict 'clean' → `scan_status='clean'` + `scan_completed_at=now()`
   - verdict 'infected' → `scan_status='infected'` + `scan_verdict='<signature>'`; DELETE blob; notify draft owner (in-portal + email)
   - verdict 'error' OR timeout → `scan_status='error'`/`'timeout'`; treat as unsafe (FR-027 timeout policy)
**Audit events**: `broadcast_attachment_unsafe` (CRITICAL severity, FR-027) on infected/timeout — carries actor + filename + content-hash + scan verdict.

### 1.3 `submitBroadcastWithAttachments(broadcastId)` — submit guard

**Invocation**: Inside the existing F7 MVP `submitBroadcast` use-case.
**Behavior**: Before transitioning to `submitted` state, verify all bound attachments have `scan_status='clean'`. If any are still pending → reject submit with `broadcast_attachment_scan_pending`. If any are flagged → reject submit with `broadcast_attachment_unsafe` (should not happen if step 1.2 deletes flagged attachments — defensive check).
**Audit event**: `broadcast_attachment_scan_pending` (INFO) when reject due to pending scan.

### 1.4 `garbageCollectOrphanAttachments()` — internal sweeper cron

**Route**: `POST /api/cron/broadcasts/prune-expired-drafts` (extended F7 MVP cron — now also handles attachment GC)
**Auth**: cron-job.org Bearer auth via `CRON_SECRET`.
**Behavior**:
1. DELETE attachments whose `draft_id` references a draft that's been deleted/expired (existing F7 MVP 30d draft retention) AND `content_hash` is not referenced by ANY other surviving draft or broadcast
2. DELETE attachments whose `broadcast_id` references a broadcast purged by the F7 MVP retention sweeper AND `content_hash` is not referenced anywhere else (FR-030a co-termination per Clarifications round-2 Q3)
3. For each deleted attachment row, also DELETE the underlying Vercel Blob
**Audit**: No event (silent GC — matches F7 MVP `prune-expired-drafts` behavior).

---

## 2. Error taxonomy

| Code | When | HTTP status |
|------|------|-------------|
| `broadcast_attachment_type_forbidden` | MIME not on allowlist | 422 (with `mimeType: string` in body) |
| `broadcast_attachment_limit_exceeded` | >10 files OR >25 MB combined | 413 |
| `broadcast_attachment_unsafe` | ClamAV verdict='infected' or timeout | 422 |
| `broadcast_attachment_scan_pending` | Submit broadcast with pending-scan attachment | 409 |
| `file_empty` | Zero-byte file | 400 |
| `DRAFT_NOT_FOUND` | draftId invalid or RLS hides | 404 |
| `CROSS_TENANT_PROBE` | Tenant ctx mismatch | 403 + audit |

---

## 3. UI surface

- **Member compose** — attachment list with add/remove + size + scan-status badge per file (pending/scanning/clean/infected/error)
- **Admin broadcast detail** — attachment manifest table (filename, content-type, size, content-hash, scan verdict, scan completed_at) per FR-029
- **Member archive view** — download links for clean attachments only; infected/error/pending attachments show error state

WCAG verification: drag-drop has keyboard alternative; scan-status is `aria-live="polite"` so SRs announce verdict; download links have explicit `download` attribute + filename label.
