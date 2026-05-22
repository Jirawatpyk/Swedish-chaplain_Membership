# Contract: Inline Image Upload + Source Allowlist (US2)

**Spec FRs**: FR-009..015 · **Clarifications**: round-2 Q2 · **Use-cases**: `validateImageSourceAllowlist`, `uploadInlineImage`, `manageImageAllowlist`

---

## 1. Server actions

### 1.1 `uploadInlineImage(file)` — member compose surface

**Route**: `POST /api/member/broadcasts/inline-image-upload`
**Auth**: member role + tenant ctx.
**Input** (multipart):
```typescript
const Input = z.object({
  file: z.instanceof(File).refine(f => f.size <= 5 * 1024 * 1024, 'broadcast_image_too_large'),
  draftId: z.string().uuid(),
});
```
**Output**: `Promise<Result<{ blobUrl: string; allowlistedHostname: string; contentHash: string }, BroadcastError>>`.
**Audit events**: `broadcast_image_too_large` on cap exceed (5 MB hard cap per FR-012 / Clarifications round-2 Q2).
**Pipeline**: validate size → scan via ClamAV port (FR-013) → content-hash + dedup → upload to Vercel Blob in tenant-scoped path → return `blobUrl` that resolves to a hostname AUTOMATICALLY in the tenant's `tenant_image_source_allowlist` (default seed entries cover the chamber's asset domain).
**Contract test**: (a) 4 MB PNG → succeeds + returns blobUrl matching default allowlist hostname; (b) 6 MB JPG → rejected with `broadcast_image_too_large`; (c) ClamAV flags as infected → rejected with `broadcast_image_unsafe` + audit; (d) duplicate upload (same content-hash) → returns existing blobUrl, no second upload.

### 1.2 `validateImageSourceAllowlist(bodyHtml, tenantId)` — submit-time validation

**Invocation**: Inside the existing `sanitiseBroadcastBody` Application use-case from F7 MVP, after Tiptap parse and before persistence.
**Input**: `bodyHtml: string, tenantId: TenantId`.
**Output**: `Result<{ sanitisedBody: string }, { unsafeImageSources: string[] }>`.
**Behavior**: Parse body for `<img src="...">`; for each, extract hostname; lookup in `tenant_image_source_allowlist`; if NOT present, accumulate offending src in error result. Returns first error (all unsafe srcs) so the editor can highlight all at once (per FR-011 UX requirement).
**Audit events**: `broadcast_body_image_source_unsafe` (one event per failed submit, carrying the list of offending src URLs — NOT the body content itself).

### 1.3 `manageImageAllowlist({ action, hostname })` — admin server actions

**Routes**: `POST /api/admin/broadcasts/settings/allowlist` (action: 'add' | 'remove').
**Auth**: admin role.
**Input**:
```typescript
const Input = z.object({
  action: z.enum(['add', 'remove']),
  hostname: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/), // RFC 1035 hostname format; explicit no-wildcard
});
```
**Output**: `Promise<Result<{ allowlist: string[] }, BroadcastError>>`.
**Audit event**: `broadcast_image_allowlist_updated` (carries actor + before/after value).
**Preconditions**: default entries (chamber asset domain + Resend CDN) are NOT removable — server rejects `remove` with `CANNOT_REMOVE_DEFAULT_ALLOWLIST_ENTRY`.
**Contract test**: (a) Add `example.com` → succeeds; (b) Remove `example.com` → succeeds; (c) Remove a default entry → rejected; (d) Add wildcard `*.example.com` → rejected by zod regex; (e) Cross-tenant probe → tenant B cannot see/modify tenant A's allowlist.

---

## 2. Error taxonomy

| Code | When | HTTP status |
|------|------|-------------|
| `broadcast_image_too_large` | Upload >5 MB | 413 |
| `broadcast_image_unsafe` | ClamAV verdict='infected' | 422 |
| `broadcast_body_image_source_unsafe` | Submit body contains `<img>` with non-allowlisted host | 422 (with `unsafeImageSources: string[]` in body) |
| `CANNOT_REMOVE_DEFAULT_ALLOWLIST_ENTRY` | Admin attempts remove of seeded default | 403 |
| `INVALID_HOSTNAME_FORMAT` | Add with non-RFC-1035 or wildcard hostname | 400 |
| `CROSS_TENANT_PROBE` | Tenant ctx mismatch | 403 + audit |

---

## 3. UI surface

- **Member compose** — Tiptap toolbar adds "Upload image" button (US2) — modal previews + size check + upload progress; on failure surfaces locale-aware error
- **Admin settings page** — `/admin/broadcasts/settings` adds "Image source allowlist" section with add/remove + default entries shown as locked

WCAG verification: drag-drop upload alternative via keyboard `Enter` to open file picker; image upload progress is `<progress>` with `aria-label`; allowlist editor uses semantic `<table>`.
