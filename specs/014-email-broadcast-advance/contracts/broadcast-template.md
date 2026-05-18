# Contract: Broadcast Template Library (US7)

**Spec FRs**: FR-045..052 · **Use-cases**: `createBroadcastTemplate`, `updateBroadcastTemplate`, `deleteBroadcastTemplate`, `snapshotTemplateToDraft`

---

## 1. Server actions

### 1.1 `createBroadcastTemplate({ name, subject, bodyHtml })` — admin only

**Route**: `POST /api/admin/broadcasts/templates`
**Auth**: admin role + tenant ctx.
**Input**:
```typescript
const Input = z.object({
  name: z.string().min(1).max(100),
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().max(200 * 1024), // 200 KB matching F7 MVP body cap
});
```
**Output**: `Promise<Result<{ templateId: string }, BroadcastError>>`.
**Pipeline**:
1. Validate name uniqueness within tenant (FR-046)
2. Sanitise `bodyHtml` via existing F7 MVP sanitiser PLUS US2 image-source allowlist validation (FR-046) — same rules as broadcast submit
3. INSERT `broadcast_templates` row
**Audit event**: `broadcast_template_created` (actor + template_id + name + subject — body excluded from audit row to keep size bounded).

### 1.2 `updateBroadcastTemplate({ templateId, name, subject, bodyHtml })` — admin only

**Route**: `PATCH /api/admin/broadcasts/templates/:id`
**Auth**: admin role.
**Input**: same as create + `templateId`.
**Pipeline**: validate ownership (tenant) → re-sanitise → UPDATE row.
**Audit event**: `broadcast_template_updated` (actor + template_id + before/after value).
**Invariant**: Drafts already started from this template are NOT modified (FR-048 snapshot semantics).

### 1.3 `deleteBroadcastTemplate(templateId)` — admin only

**Route**: `DELETE /api/admin/broadcasts/templates/:id`
**Auth**: admin role.
**Pipeline**: SOFT-delete (set `deleted_at`) to preserve audit-trail forensics; do NOT block on existing drafts.
**Audit event**: `broadcast_template_deleted` (actor + template_id + name + started_from_count snapshot at delete time per FR-051).

### 1.4 `snapshotTemplateToDraft({ draftId, templateId })` — member compose surface

**Route**: `POST /api/member/broadcasts/draft/:id/snapshot-template`
**Auth**: member role + tenant ctx + draft ownership.
**Input**:
```typescript
const Input = z.object({
  draftId: z.string().uuid(),
  templateId: z.string().uuid(),
});
```
**Pipeline**:
1. Load template (validate tenant ownership; reject if soft-deleted)
2. Copy `template.subject` + `template.bodyHtml` into draft (overwrite — UI confirms first if draft is non-empty)
3. UPDATE draft: `started_from_template_id = templateId`
4. UPDATE template: `started_from_count++` (denormalised counter for FR-051 visibility)
**Audit**: Implicit via existing F7 MVP `broadcast_draft_started` event (extended with `started_from_template_id` field).

### 1.5 `listBroadcastTemplates()` — member compose + admin list

**Route**: `GET /api/broadcasts/templates`
**Auth**: member OR admin role + tenant ctx.
**Output**: array of `{ id, name, subject, started_from_count, updated_at }` — body NOT included in list view to keep payload bounded; full body loaded on snapshot.
**Ordering**: Per FR-047 — most-recently-used-by-this-member first (requires a per-member usage table OR a tenant-wide MRU heuristic — implementation TBD in `/speckit.tasks`; spec-level requirement is the ordering itself), then alphabetical fallback.

---

## 2. Error taxonomy

| Code | When | HTTP status |
|------|------|-------------|
| `template_name_duplicate` | Create with existing tenant-scoped name | 409 |
| `template_body_unsafe` | Body fails sanitiser OR contains non-allowlisted image | 422 (with `unsafeImageSources` for the latter) |
| `TEMPLATE_NOT_FOUND` | templateId invalid OR RLS hides OR soft-deleted | 404 |
| `CROSS_TENANT_PROBE` | Tenant ctx mismatch | 403 + audit |

---

## 3. UI surface

- **Admin template list** — `/admin/broadcasts/templates` — table with name, subject preview, started-from count, last modified; row actions Edit / Delete
- **Admin template edit** — `/admin/broadcasts/templates/[id]/edit` — Tiptap editor (same instance as member compose, with full F7 MVP sanitiser + US2 image upload) + form fields for name + subject
- **Member compose dropdown** — first-action picker on `/portal/broadcasts/new`: "Blank" + F7 MVP starter + all active templates (MRU ordered)

WCAG verification: dropdown is **shadcn Combobox** with proper ARIA roles (per critique X3/E8 — supports keyboard typing-to-filter; preferred over bare `<select>` at scale); template editor preserves Tiptap a11y from F7 MVP.

**Picker locale filter (per critique P3 / X3)**: dropdown default filters templates by `locale = current_user_locale || tenant_default_locale || 'en'` (cascading fallback). Power-users can toggle "Show all locales" to see all 15 seeded rows. Filter pills also available: "Starter only" (seeded templates) and "Admin-authored" (`is_seeded = FALSE`).

**Starter badge (per critique P6)**: rows with `is_seeded = TRUE` render a "Starter" badge (visually distinct, dismissible). When admin clicks Edit on a starter template, the editor surfaces a confirmation banner: "This is a starter template seeded by the platform. Editing creates a tenant-specific version (it will no longer auto-update if the platform refines starter content)."

---

## 5. Variable resolution semantics (per critique E1 / X1 — 2026-05-18)

F7.1a templates use **TWO** placeholder conventions with **DIFFERENT** resolution semantics:

### 5.1 `{{chamber_name}}` — server-substituted variable

The ONLY variable that is server-substituted at template-snapshot time.

| Property | Value |
|----------|-------|
| **WHO substitutes** | The `snapshotTemplateToDraft` Application use-case (Infrastructure layer ports.template-renderer-port resolves the actual value) |
| **WHEN** | At the moment a member picks a template in compose → `snapshotTemplateToDraft({draftId, templateId})` runs (per `contracts/broadcast-template.md § 1.4`). Substitution happens BEFORE the snapshot is written to the draft row. |
| **WHAT (source)** | `tenants.display_name` (per the cross-tenant probe test that resolves `tenantId` → tenant row → display_name field) |
| **WHAT (if missing)** | NEVER missing — `tenants.display_name` is NOT NULL (enforced by F1 schema). Defensive code MAY treat missing as render literal `{{chamber_name}}` (visible to admin reviewer → bug signal) instead of empty string (silently broken). |
| **HOW (escape)** | The substituted value is HTML-escaped using the existing F7 MVP sanitiser's `escapeHtml()` helper BEFORE insertion into draft body/subject. `<` → `&lt;`, `>` → `&gt;`, `&` → `&amp;`, `"` → `&quot;`, `'` → `&#39;`. Prevents XSS via tenant-name injection (e.g., a tenant admin who set display_name to `<script>alert(1)</script>` cannot inject script into broadcasts). |
| **WHEN NOT substituted** | At broadcast dispatch time, substitution does NOT re-run. The draft body already contains the snapshot-time substituted value. Broadcasts are static HTML at send time (consistent with F7 MVP semantics). |

### 5.2 `[bracketed text]` — member-editable placeholder

All other formerly-variable placeholders (`{{ member_name }}`, `{{ event_name }}`, `{{ month_year }}`, `{{ featured_company_name }}`, `{{ spokesperson_name }}`, `{{ spokesperson_title }}`) were CONVERTED to `[bracketed text]` form on 2026-05-18 per critique findings X1 + P5.

| Property | Value |
|----------|-------|
| **WHO substitutes** | The member, manually, in the Tiptap editor before submitting the broadcast |
| **WHEN** | At compose time (member opens the draft, sees `[event name]`, types over it with "Annual Gala 2026") |
| **WHAT (rendering)** | Tiptap renders `[bracketed text]` with a distinct visual style (per critique P4 — e.g., grey background + dashed border) and surfaces inline microcopy on first compose-from-template: "Click any [bracketed text] to replace with your content." |
| **WHAT (if not replaced)** | The literal `[bracketed text]` ships in the broadcast body. NO server-side validation rejects unreplaced brackets — chamber may intentionally want to ship a placeholder (e.g., "Save the date: [Date TBD]" as a teaser). |
| **HOW (escape)** | No special handling — `[bracketed text]` is plain HTML text in the body, sanitised by the existing F7 MVP body-sanitiser (allowlist of safe tags). Brackets are NOT a special syntax to the sanitiser; they are literal `[` and `]` characters. |

### 5.3 Why this two-tier scheme?

- **Broadcasts dispatch to segments of 5,000-50,000 recipients**, not single members. Per-recipient variable substitution (e.g., "Dear {{member_name}}") is INCOHERENT with F7 MVP's Broadcasts-audience model — Resend Broadcasts API does not support per-recipient variables in the same way `emails.send` does.
- **`{{chamber_name}}` is the ONE constant** across all recipients of a single broadcast — it's the tenant's display name, identical for every recipient. Server-substitution at snapshot time is safe + correct.
- **All other "variables" become member-editable text** — the member composing the broadcast knows the event name, the featured company, etc. They fill it in once at compose time → text ships verbatim.
- **Single source of truth for variable rules** = this section. Tests in `tests/contract/broadcasts/template-variable-substitution.test.ts` enforce the rules (per critique E9).

### 5.4 Contract tests (per critique E9)

Three new contract tests verify the semantics:

```typescript
// tests/contract/broadcasts/template-variable-substitution.test.ts
describe('Template variable substitution', () => {
  it('substitutes {{chamber_name}} at snapshot time with tenant.display_name', async () => {/* ... */});
  it('leaves [bracketed text] literal in draft body (no substitution)', async () => {/* ... */});
  it('HTML-escapes {{chamber_name}} value to prevent XSS', async () => {
    // Set tenant.display_name = '<script>alert(1)</script>'
    // Snapshot template containing {{chamber_name}}
    // Assert draft.body contains '&lt;script&gt;alert(1)&lt;/script&gt;' NOT '<script>'
  });
  it('does NOT re-substitute at broadcast dispatch time (snapshot is frozen)', async () => {/* ... */});
});

// tests/contract/broadcasts/template-save-image-allowlist.test.ts
describe('Template save image-source allowlist enforcement', () => {
  it('rejects template save with <img src> hostname not in tenant allowlist', async () => {/* ... */});
  it('accepts template save with <img src> hostname on tenant allowlist', async () => {/* ... */});
});

// tests/contract/broadcasts/template-render-html-escape.test.ts
describe('Template HTML escaping at snapshot', () => {
  it('escapes XSS payloads in {{chamber_name}}', async () => {/* ... */});
  it('does NOT escape [bracketed text] (literal text, not user-input)', async () => {/* ... */});
});
```
