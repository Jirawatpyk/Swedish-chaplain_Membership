# F7.1a Phase 5 — User Story 7 (Multi-template library) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD RED-first is NON-NEGOTIABLE per Constitution v1.4.0 Principle II.

**Goal:** Deliver F7.1a US7 (Multi-template library) — admin CRUD over tenant-scoped broadcast templates with snapshot-to-draft semantics, 5 starter templates × 3 locales already seeded by migration 0168, member compose template picker with cascading locale filter, `{{chamber_name}}` server-substitution at snapshot time, `[bracketed]` placeholders member-editable.

**Architecture:** Extends `src/modules/broadcasts/` bounded context (Domain + Application + Infrastructure) without touching F7 MVP or US1/US2 surfaces. New Domain VO `substituteChamberName` (HTML-escapes via existing F7 sanitiser helper). 5 new Application use-cases (create/update/delete/snapshot/list). Real Drizzle repo replaces Phase 2 skeleton. 3 new audit-event emits (already in 55-event taxonomy from Phase 2 T031). 4 new admin routes + 1 member compose extension + 4 new API endpoints. ~60 new i18n keys × 3 locales. Three-layer feature-flag gate (`isF71aUs7Enabled()`) matches US1+US2 dark-launch pattern.

**Tech Stack:** TypeScript 5.7+ strict · Next.js 16 App Router · React 19 · Drizzle ORM · shadcn Combobox (template picker) · existing F7 Tiptap editor (compose) · next-intl (EN+TH+SV) · vitest + Playwright + axe-core (TDD)

**Critical files surveyed (Phase 5 foundation already complete):**
- `src/modules/broadcasts/application/ports/broadcast-templates-port.ts` (6 methods — port interface ready; needs `withTx` extension for atomic audit)
- `src/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo.ts` (skeleton — all methods throw `notImplemented`)
- `src/modules/broadcasts/infrastructure/schema.ts:535` (`broadcastTemplates` table — 15 starter rows already seeded by 0168)
- `src/modules/broadcasts/application/ports/audit-port.ts:129-131` (3 template events already in 55-event tuple)
- `src/modules/broadcasts/index.ts:499-510` (port types already in barrel)
- `src/modules/broadcasts/infrastructure/feature-flags.ts` (US1+US2 pattern to mirror for US7)
- `src/modules/broadcasts/application/use-cases/manage-image-allowlist.ts` (reference pattern — `port.withTx` + `audit.emit(tx)` atomicity)
- `src/modules/broadcasts/application/use-cases/upload-inline-image.ts` (reference pattern — `safeAuditEmit` for security-reject paths)

**Critical discovery (architectural deviation from spec):**
- Spec contract says `{{chamber_name}}` resolves from `tenants.display_name` — but **NO `tenants` table exists** in the codebase (verified via `find src/modules/tenants -type f` + `grep pgTable.*tenants` returning empty for table definitions). Tenant display name is currently read from `process.env.NEXT_PUBLIC_TENANT_NAME` (default 'SweCham'), surfaced in `src/app/(staff)/admin/layout.tsx:53` and 8 auth-public pages. **Resolution**: introduce a narrow `TenantDisplayNamePort` in Application layer; production adapter reads from `env.NEXT_PUBLIC_TENANT_NAME` (with 'SweCham' fallback matching existing pattern); when multi-tenant SaaS lands (F10+), the port impl swaps to query a real `tenants` table without touching use-cases. This deviation is documented inline in T097 + T102 implementation comments.

**Session scoping:** This plan covers **all 36 tasks T086-T121**. Given absolute LOC (~80 source files + ~180 i18n keys), it WILL span multiple commits across multiple sessions. Phase G+H of this plan is the natural per-session boundary; if a session runs out, the next session resumes at the next unchecked `- [ ]` step.

---

## Task organisation (groupings + commit boundaries)

The 36 spec tasks fan out into **9 phased commits** for bisect-ability:

| Phase | Spec tasks | LOC est | Commit | Verification |
|---|---|---|---|---|
| **5A** | T086-T096 (11 RED tests) | ~700 | RED commit | tests RED + pre-push contract suite passes |
| **5B** | T097-T098 (Domain VO + aggregate ext) | ~140 | GREEN commit | T086-T092 contract tests start going GREEN |
| **5C** | Phase 5b skeleton→real Drizzle repo (replaces T028) | ~280 | GREEN commit | T093 (cross-tenant probe) + T094 (snapshot decoupling) integration tests GREEN on live Neon |
| **5D** | T099-T103 (5 Application use-cases) + barrel exports | ~700 | GREEN commit | All US7 contract tests GREEN; broadcasts barrel exports new use-cases |
| **5E** | Composition root factories (broadcasts-deps.ts) | ~150 | GREEN commit | typecheck GREEN; barrel exposes 5 new make* factories |
| **5F** | T107-T110 API routes (4 endpoints) + T121 feature-flag gate | ~500 | GREEN commit | API route contract tests GREEN; routes 404 when flag OFF |
| **5G** | T104-T106 admin pages + T111 member compose extension | ~700 | GREEN commit | `pnpm check:layout` GREEN (page/loading consistent) |
| **5H** | T112-T117 (6 React components) | ~900 | GREEN commit | unit tests GREEN; a11y axe-core spec authored |
| **5I** | T118-T120 (i18n EN+TH+SV, ~60 × 3 = 180 keys) | ~600 (json) | GREEN commit | `pnpm check:i18n` GREEN at ~3047+180 = ~3227 keys × 3 |
| **5J** | T096 E2E spec + T121 final flag verification + full CI run | ~250 | Verify commit | full pre-push chain GREEN + 14 incomplete checklist items audited |

**Total: ~80 source files + 180 i18n keys + 10 commits.**

---

## Pre-flight verification (run BEFORE Task 1)

- [ ] **PV1** Confirm Phase 2 foundation is intact

```bash
# All should pass with no output (port file present + skeleton intact + audit events present + barrel re-exports OK)
test -f src/modules/broadcasts/application/ports/broadcast-templates-port.ts && echo "PORT OK"
test -f src/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo.ts && echo "SKELETON OK"
grep -q "broadcast_template_created" src/modules/broadcasts/application/ports/audit-port.ts && echo "AUDIT EVENTS OK"
grep -q "BroadcastTemplatesPort" src/modules/broadcasts/index.ts && echo "BARREL OK"
```

- [ ] **PV2** Confirm migration 0161 + 0166 + 0168 are applied on live Neon

```bash
pnpm tsx scripts/verify-f71a-migrations.ts
# Expected: "166 migrations applied" + "broadcast_templates table present" + "15 starter templates seeded for swecham"
```

- [ ] **PV3** Capture baseline test counts (so we can measure delta after each commit)

```bash
pnpm test --reporter=verbose 2>&1 | tail -10 > /tmp/baseline-tests.txt
pnpm check:i18n 2>&1 | tail -3 > /tmp/baseline-i18n.txt
# Expected baseline: ~3050 i18n keys × 3 locales (post Round-3-Final)
```

---

## Phase 5A — RED tests (T086-T096) · 1 commit · ~700 LOC

**Files:**
- Create: `tests/contract/broadcasts/create-broadcast-template.test.ts` (T086)
- Create: `tests/contract/broadcasts/update-broadcast-template.test.ts` (T087)
- Create: `tests/contract/broadcasts/delete-broadcast-template.test.ts` (T088)
- Create: `tests/contract/broadcasts/snapshot-template-to-draft.test.ts` (T089)
- Create: `tests/contract/broadcasts/template-variable-substitution.test.ts` (T090)
- Create: `tests/contract/broadcasts/template-save-image-allowlist.test.ts` (T091)
- Create: `tests/contract/broadcasts/template-render-html-escape.test.ts` (T092)
- Create: `tests/integration/broadcasts/template-cross-tenant-probe.test.ts` (T093)
- Create: `tests/integration/broadcasts/template-snapshot-decoupling.test.ts` (T094)
- Create: `tests/integration/broadcasts/starter-template-seed.test.ts` (T095)
- Create: `tests/e2e/broadcasts/template-library-flow.spec.ts` (T096) — env-gated stub

**Pattern for not-yet-existent use-case imports** (per memory `project_f5_red_import_pattern`):
Use `vi.fn()` mocks of the port directly + dynamic `import()` wrapped in `new Function('m', 'return import(m)')` so typecheck doesn't fail before T099-T103 land. For use-cases that DO exist (e.g., the variable-substitution VO from T097), use direct static imports.

- [ ] **Step 1: T086 create-broadcast-template.test.ts (RED)** — 5 cases per contracts § 1.1:
  1. Admin creates template → port.create called → audit `broadcast_template_created` emitted with actor + template_id + name + subject (body NOT in audit)
  2. Member role rejected with `forbidden` (RBAC enforced at use-case)
  3. Name length >100 → `invalid_input`
  4. Subject length >200 → `invalid_input`
  5. Body fails US2 image-source allowlist → `template_body_unsafe` with `unsafeImageSources` payload

  Use port mock pattern matching `upload-inline-image.test.ts:30-75`. Use-case import via dynamic `import()` wrapper (use-case doesn't exist yet — lands at T099).

- [ ] **Step 2: T087 update-broadcast-template.test.ts (RED)** — 5 cases per contracts § 1.2:
  1. Admin updates name → port.update called → audit `broadcast_template_updated` with before/after value
  2. Member role rejected
  3. Cross-tenant probe (templateId belongs to tenant B) → `not_found` + `broadcast_cross_tenant_probe` audit
  4. Update body with non-allowlisted img → `template_body_unsafe`
  5. Update non-existent → `not_found`

- [ ] **Step 3: T088 delete-broadcast-template.test.ts (RED)** — 5 cases per contracts § 1.3:
  1. Admin soft-deletes → port.softDelete called → audit `broadcast_template_deleted` with `started_from_count` snapshot per FR-023
  2. Member role rejected
  3. Cross-tenant probe → `not_found`
  4. Delete starter (`is_seeded=TRUE`) → succeeds (admin freedom)
  5. Delete already-deleted → `not_found`

- [ ] **Step 4: T089 snapshot-template-to-draft.test.ts (RED)** — 5 cases per contracts § 1.4 (SC-007a):
  1. Member picks template → draft updated with subject + body + `started_from_template_id` + `template_name_snapshot`
  2. template.started_from_count incremented atomically
  3. Subsequent template UPDATE does NOT mutate draft
  4. Cross-tenant template id → `template_not_found` + `broadcast_cross_tenant_probe` audit
  5. Soft-deleted template → `template_not_found`

- [ ] **Step 5: T090 template-variable-substitution.test.ts (RED)** — 4 cases per contracts § 5.4:
  1. `{{chamber_name}}` substituted at snapshot time with tenant.display_name (resolved via TenantDisplayNamePort)
  2. `[bracketed text]` literal preserved (no substitution)
  3. `{{chamber_name}}` HTML-escaped — set display_name to `<script>alert(1)</script>` → assert draft body contains `&lt;script&gt;` not `<script>`
  4. Does NOT re-substitute at dispatch time (snapshot frozen) — assert the snapshotted draft body remains identical after dispatch

- [ ] **Step 6: T091 template-save-image-allowlist.test.ts (RED)** — 2 cases per critique E9:
  1. Template save with `<img src="https://allowed.com/x.png">` succeeds (allowlist contains `allowed.com`)
  2. Template save with `<img src="https://blocked.com/x.png">` → `template_body_unsafe` with `unsafeImageSources: ['blocked.com']` + audit `broadcast_body_image_source_unsafe` emitted

- [ ] **Step 7: T092 template-render-html-escape.test.ts (RED)** — 2 cases per critique E6:
  1. `{{chamber_name}}` value with HTML metacharacters fully escaped (5 metachars: `<>&"'`)
  2. `[bracketed text]` left literal (it's plain text, not user-input — no escape needed)

- [ ] **Step 8: T093 template-cross-tenant-probe.integration.test.ts (RED, live Neon)** — Principle I sub-clause 3:
  1. Setup: 2 tenants (tenant_a, tenant_b) — seed 1 template per tenant via runInTenant
  2. From tenant_b context, attempt findById on tenant_a's templateId → returns null + audit row `broadcast_cross_tenant_probe` written to audit_log
  3. From tenant_b context, attempt update on tenant_a's templateId → `not_found`
  4. From tenant_b context, attempt softDelete on tenant_a's templateId → `not_found`
  5. SELECT count from broadcast_templates BYPASSRLS proves both rows still exist (tenant_a's was never touched)

- [ ] **Step 9: T094 template-snapshot-decoupling.integration.test.ts (RED, live Neon)** — SC-007a:
  1. Setup: create template T1 with subject 'V1' + body 'V1 body'
  2. Member starts draft D1 from T1 → assert D1.subject='V1' D1.body='V1 body' D1.started_from_template_id=T1.id
  3. Admin updates T1 to subject 'V2' + body 'V2 body'
  4. Reload D1 → assert D1.subject still 'V1' D1.body still 'V1 body' (NOT mutated by template update)

- [ ] **Step 10: T095 starter-template-seed.integration.test.ts (RED, live Neon)** — SC-007b per critique P10:
  1. SELECT COUNT(*) FROM broadcast_templates WHERE tenant_id='swecham' AND is_seeded=TRUE → assert exactly 15 (5 templates × 3 locales)
  2. Per template name, assert 3 locale rows present (EN+TH+SV)
  3. Run starter-template seed migration script in idempotent mode → assert no duplicate rows + `broadcast_template_seed_skipped_existing_name` audit emitted

- [ ] **Step 11: T096 template-library-flow.spec.ts (RED Playwright stub)** — env-gated `describe.skipIf(!ADMIN_EMAIL || !ADMIN_PASSWORD)`:
  Full happy path stub matching `tests/e2e/broadcasts/image-upload-allowlist.spec.ts` shape. Real assertions land at Phase 5H after components ship.

- [ ] **Step 12: Run all 11 tests — confirm RED**

```bash
pnpm test tests/contract/broadcasts/ tests/integration/broadcasts/ tests/e2e/broadcasts/ --run 2>&1 | tail -20
# Expected: 11 new tests FAIL with module-not-found / notImplemented / mock-not-called errors. F7 MVP + US1 + US2 tests remain GREEN.
```

- [ ] **Step 13: Commit RED**

```bash
git add tests/contract/broadcasts/{create,update,delete,snapshot}-broadcast-template.test.ts \
        tests/contract/broadcasts/template-{variable-substitution,save-image-allowlist,render-html-escape}.test.ts \
        tests/integration/broadcasts/{template-cross-tenant-probe,template-snapshot-decoupling,starter-template-seed}.test.ts \
        tests/e2e/broadcasts/template-library-flow.spec.ts
git commit -m "$(cat <<'EOF'
[Spec Kit] test(F7.1a US7): Phase 5A RED — 11 tests (7 contract + 3 integration + 1 E2E stub)

T086-T096 — TDD RED-first per Constitution v1.4.0 Principle II.
All 11 tests authored before any T097+ implementation. GREEN lands
across Phase 5B (Domain VO) → Phase 5D (use-cases) → Phase 5H (E2E).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5B — Domain layer (T097-T098) · 1 commit · ~140 LOC

**Files:**
- Create: `src/modules/broadcasts/domain/value-objects/template-snapshot.ts` (T097)
- Modify: `src/modules/broadcasts/domain/broadcast.ts` (T098 — extend aggregate)

- [ ] **Step 1: T097 template-snapshot.ts VO** — pure functions, no framework imports:

```ts
/**
 * T097 (F7.1a US7) — Template snapshot Domain VO.
 *
 * Pure functions for template → draft substitution per critique E1/X1/E6
 * + contracts/broadcast-template.md § 5. `{{chamber_name}}` is the ONLY
 * server-substituted variable; HTML-escaped via shared `escapeHtml`
 * helper to prevent XSS via tenant-name injection.
 *
 * `[bracketed text]` is intentionally NOT touched — those are member-
 * editable placeholders rendered with distinct visual style in the
 * Tiptap editor (T116 compose-bracket-placeholder).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

/** HTML-escape per OWASP — same 5 metachars as F7 MVP sanitizer. */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Substitute `{{chamber_name}}` literal in template body + subject with
 * the tenant's display name (HTML-escaped first per § 5.1).
 *
 * Leaves `[bracketed text]` and ALL other `{{var}}` literals untouched
 * (deliberate — only chamber_name is server-resolved; other variables
 * were converted to bracket placeholders on 2026-05-18).
 *
 * Pure — no I/O, no clock, no globals.
 */
export function substituteChamberName(
  body: string,
  chamberName: string,
): string {
  const escaped = escapeHtml(chamberName);
  return body.replace(/\{\{chamber_name\}\}/g, escaped);
}
```

- [ ] **Step 2: Run T090 + T092 (variable-substitution + html-escape) — verify GREEN**

```bash
pnpm test tests/contract/broadcasts/template-variable-substitution.test.ts \
         tests/contract/broadcasts/template-render-html-escape.test.ts --run
# Expected: GREEN
```

- [ ] **Step 3: T098 broadcast.ts aggregate extension** — add a pure helper at the END of the existing file (do NOT change the `Broadcast` interface — `startedFromTemplateId` + `templateNameSnapshot` columns are already on it per existing lines 170-171):

```ts
/**
 * T098 (F7.1a US7) — Record that a draft was snapshotted from a template.
 *
 * Returns a new Broadcast snapshot with `started_from_template_id` +
 * `template_name_snapshot` set. The use-case (T102 snapshotTemplateToDraft)
 * is responsible for the additional Drizzle UPDATEs (draft.subject +
 * draft.body + template.started_from_count++) inside the same tx.
 *
 * This helper exists for type-safety on the aggregate transition; it does
 * NOT touch the database. Pure — no I/O.
 */
export function startedFromTemplate(
  broadcast: Broadcast,
  templateId: string,
  templateNameSnapshot: string,
): Broadcast {
  return {
    ...broadcast,
    startedFromTemplateId: templateId,
    templateNameSnapshot,
  };
}
```

- [ ] **Step 4: Re-run all 11 RED tests — confirm T090 + T092 GREEN (rest still RED)**

```bash
pnpm test tests/contract/broadcasts/ --run 2>&1 | tail -10
# Expected: 2 GREEN + 5 still RED (5 contract tests need use-cases at T099-T103)
```

- [ ] **Step 5: Commit GREEN**

```bash
git add src/modules/broadcasts/domain/
git commit -m "[Spec Kit] feat(F7.1a US7): Phase 5B — Domain VO substituteChamberName + Broadcast.startedFromTemplate helper (T097+T098)"
```

---

## Phase 5C — Real Drizzle repo replaces skeleton · 1 commit · ~280 LOC

**Files:**
- Modify: `src/modules/broadcasts/application/ports/broadcast-templates-port.ts` (add `withTx` + tx param to mutations — extends the port surface; non-breaking because skeleton + factory haven't been called yet)
- Modify: `src/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo.ts` (replace skeleton with real impl)

- [ ] **Step 1: Extend BroadcastTemplatesPort with `withTx<T>` + tx parameter on mutations**

Add at the end of the port interface (matches `ImageAllowlistPort.withTx` signature):

```ts
import type { TenantTx } from '@/lib/db';

// Within BroadcastTemplatesPort interface:
withTx<T>(
  tenantId: TenantSlug,
  callback: (tx: TenantTx) => Promise<T>,
): Promise<T>;

// Modify existing signatures to accept optional tx as last param:
create(
  tenantId: TenantSlug,
  input: CreateTemplateInput,
  tx?: TenantTx,
): Promise<Result<BroadcastTemplate, TemplateCreateError>>;

// Same pattern for update/softDelete/incrementStartedFromCount.
// findById + findByTenantId stay without tx (read-only).
```

- [ ] **Step 2: Implement real `makeDrizzleBroadcastTemplatesRepo()` in `drizzle-broadcast-templates-repo.ts`**

Per memory `project_drizzle_repo_tx_pattern`: every method MUST use `tx` from `runInTenant`, NEVER global `db`. Pattern mirrors `drizzle-batch-manifests-repo.ts` (Phase 3 Cluster 3B.3 real impl).

Key implementation points:
- `withTx(tenantId, callback)`: opens `runInTenant(asTenantContext(tenantId), callback)` — callback receives the TenantTx
- `findById`: SELECT … WHERE id=$1 AND deleted_at IS NULL — RLS+FORCE (migration 0166) provides storage-layer tenant guard
- `findByTenantId(opts)`: ORDER BY updated_at DESC + optional `locale` filter + optional `includeDeleted`
- `create`: INSERT with ON CONFLICT (tenant_id, name, locale) DO NOTHING + RETURNING — map empty RETURNING to `{kind: 'duplicate_name'}`
- `update`: UPDATE … RETURNING — map 0 rows to `{kind: 'not_found'}`; map unique-violation Postgres `23505` → `{kind: 'duplicate_name'}`
- `softDelete`: UPDATE deleted_at = now() WHERE id=$1 AND deleted_at IS NULL — map 0 rows to `{kind: 'not_found'}`
- `incrementStartedFromCount`: UPDATE started_from_count = started_from_count + 1 (atomic at row level)

Use `BroadcastTemplateRow` / `NewBroadcastTemplateRow` from schema.ts (already exported at line 582-583).

- [ ] **Step 3: Run integration tests T093 + T094 (cross-tenant probe + snapshot decoupling) on live Neon**

```bash
pnpm test:integration tests/integration/broadcasts/template-cross-tenant-probe.test.ts \
                       tests/integration/broadcasts/template-snapshot-decoupling.test.ts
# Expected: T093 cross-tenant probe GREEN (RLS+FORCE enforces); T094 snapshot decoupling RED until T102 use-case lands
```

- [ ] **Step 4: Run T095 starter-template-seed integration on live Neon**

```bash
pnpm test:integration tests/integration/broadcasts/starter-template-seed.test.ts
# Expected: GREEN — migration 0168 already seeded 15 rows for swecham per scripts/verify-f71a-migrations.ts
```

- [ ] **Step 5: Commit GREEN**

```bash
git add src/modules/broadcasts/application/ports/broadcast-templates-port.ts \
        src/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo.ts
git commit -m "[Spec Kit] feat(F7.1a US7): Phase 5C — Real Drizzle templates repo replaces skeleton (replaces T028)"
```

---

## Phase 5D — Application use-cases (T099-T103) · 1 commit · ~700 LOC

**Files (all new):**
- `src/modules/broadcasts/application/use-cases/create-broadcast-template.ts` (T099)
- `src/modules/broadcasts/application/use-cases/update-broadcast-template.ts` (T100)
- `src/modules/broadcasts/application/use-cases/delete-broadcast-template.ts` (T101)
- `src/modules/broadcasts/application/use-cases/snapshot-template-to-draft.ts` (T102)
- `src/modules/broadcasts/application/use-cases/list-broadcast-templates.ts` (T103)
- `src/modules/broadcasts/application/ports/tenant-display-name-port.ts` (NEW — narrow port for T102)
- Modify: `src/modules/broadcasts/index.ts` (export 5 new use-cases + their Input/Output/Error types)

**Pattern for each mutation use-case** (mirrors `manageImageAllowlist`):
1. Validate input (zod or domain VO)
2. `port.withTx(tenantId, async (tx) => {...})`
3. Inside tx: call port method with tx → validate Result → audit.emit(tx, ...) raw (NOT safeAuditEmit — mutation needs atomic audit)
4. Return Result<Output, Error>

**Special pattern for T102 snapshotTemplateToDraft**:
- Reads tenant display_name via TenantDisplayNamePort (env-backed adapter for single-tenant; future-proof for multi-tenant)
- Pipes template.bodyHtml + template.subject through `substituteChamberName(value, tenantDisplayName)` (T097)
- UPDATEs draft.subject + draft.bodyHtml + draft.started_from_template_id + draft.template_name_snapshot in same tx
- UPDATEs template.started_from_count++ in same tx
- Audit via existing `broadcast_drafted` event extended with `started_from_template_id` payload key (no NEW event-type)

**Special pattern for T103 listBroadcastTemplates**:
- Reads `currentUserLocale` from input (route handler resolves from session)
- Applies cascading locale filter: `locale=currentUserLocale || tenantDefaultLocale || 'en'`
- Returns `readonly BroadcastTemplate[]` (no Result wrapper — read-path can't fail meaningfully)
- MRU ordering already enforced by repo's `ORDER BY updated_at DESC`

**Special pattern for T099/T100 image-allowlist validation**:
- Reuse existing `validateImageSourceAllowlist` use-case (Phase 4 T070)
- Run template.bodyHtml through it BEFORE persisting
- On failure: return `{kind: 'template_body_unsafe', unsafeImageSources: [...]}`

- [ ] **Step 1: Create TenantDisplayNamePort narrow port**

```ts
// src/modules/broadcasts/application/ports/tenant-display-name-port.ts
import type { TenantSlug } from '@/modules/tenants';

/**
 * Narrow port for tenant display name resolution.
 *
 * Single-tenant MVP (F7.1a): adapter reads from
 * `process.env.NEXT_PUBLIC_TENANT_NAME` (default 'SweCham') — same source
 * as `src/app/(staff)/admin/layout.tsx:53`.
 *
 * Multi-tenant future (F10+): adapter swaps to query a real `tenants`
 * Drizzle table; use-cases unaffected per Clean Architecture.
 *
 * Pure interface — no framework imports.
 */
export interface TenantDisplayNamePort {
  resolve(tenantId: TenantSlug): Promise<string>;
}
```

- [ ] **Step 2: Implement T099 createBroadcastTemplate** — input zod schema + port.withTx + validate image-source allowlist + port.create + audit.emit + Result wrap

- [ ] **Step 3: Implement T100 updateBroadcastTemplate** — same pattern + before/after values in audit payload

- [ ] **Step 4: Implement T101 deleteBroadcastTemplate** — SELECT for `started_from_count` snapshot → port.softDelete → audit.emit with the snapshotted count per FR-023

- [ ] **Step 5: Implement T102 snapshotTemplateToDraft** — load template → substituteChamberName → UPDATE draft + UPDATE template.started_from_count++ → no NEW audit event (extends existing broadcast_drafted payload)

- [ ] **Step 6: Implement T103 listBroadcastTemplates** — port.findByTenantId with cascading locale filter + return array (no Result)

- [ ] **Step 7: Extend broadcasts barrel** — export 5 use-cases + Input/Output/Error types + `TenantDisplayNamePort` type

- [ ] **Step 8: Re-run all RED contract tests — confirm GREEN**

```bash
pnpm test tests/contract/broadcasts/ --run
# Expected: all 11 GREEN (Domain VO tests already GREEN; use-case tests now GREEN)
```

- [ ] **Step 9: Commit GREEN**

```bash
git add src/modules/broadcasts/application/use-cases/{create,update,delete,snapshot,list}*broadcast-template*.ts \
        src/modules/broadcasts/application/use-cases/snapshot-template-to-draft.ts \
        src/modules/broadcasts/application/use-cases/list-broadcast-templates.ts \
        src/modules/broadcasts/application/ports/tenant-display-name-port.ts \
        src/modules/broadcasts/index.ts
git commit -m "[Spec Kit] feat(F7.1a US7): Phase 5D — 5 Application use-cases + TenantDisplayNamePort + barrel exports (T099-T103)"
```

---

## Phase 5E — Composition root factories · 1 commit · ~150 LOC

**Files:**
- Modify: `src/modules/broadcasts/infrastructure/broadcasts-deps.ts` (add 5 make* factories at end of file)
- Create: `src/modules/broadcasts/infrastructure/env-tenant-display-name.ts` (adapter for TenantDisplayNamePort)
- Modify: `src/modules/broadcasts/index.ts` (export 5 new make* factories)

- [ ] **Step 1: Create env-tenant-display-name.ts adapter**

```ts
// Reads from process.env.NEXT_PUBLIC_TENANT_NAME with 'SweCham' fallback.
// Mirrors existing pattern at src/app/(staff)/admin/layout.tsx:53.
import type { TenantDisplayNamePort } from '../application/ports/tenant-display-name-port';

export const envTenantDisplayName: TenantDisplayNamePort = {
  resolve: async () =>
    process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham',
};
```

- [ ] **Step 2: Add 5 factories to broadcasts-deps.ts** — symmetric with US2 `makeManageImageAllowlistDeps` pattern (lines 619-664):

```ts
// ----- F7.1a Phase 5 (US7 — Template library) -----------------------------
export function makeCreateBroadcastTemplateDeps(_tenantId: string): CreateBroadcastTemplateDeps {
  return {
    port: makeDrizzleBroadcastTemplatesRepo(),
    audit: f7AuditAdapter,
    validateImageSourceAllowlist: makeValidateImageSourceAllowlistDeps(_tenantId),
  };
}
// Same for makeUpdate.../makeDelete.../makeSnapshot.../makeList...
```

- [ ] **Step 3: Export 5 factories at the END of broadcasts barrel**

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck
# Expected: GREEN
```

- [ ] **Step 5: Commit GREEN**

```bash
git add src/modules/broadcasts/infrastructure/broadcasts-deps.ts \
        src/modules/broadcasts/infrastructure/env-tenant-display-name.ts \
        src/modules/broadcasts/index.ts
git commit -m "[Spec Kit] feat(F7.1a US7): Phase 5E — composition root factories + env-backed TenantDisplayName adapter"
```

---

## Phase 5F — API routes + feature flag (T107-T110 + T121) · 1 commit · ~500 LOC

**Files (all new):**
- `src/app/api/admin/broadcasts/templates/route.ts` (T107 POST + GET)
- `src/app/api/admin/broadcasts/templates/[id]/route.ts` (T108 PATCH + DELETE)
- `src/app/api/member/broadcasts/draft/[id]/snapshot-template/route.ts` (T109)
- `src/app/api/broadcasts/templates/route.ts` (T110 GET, member OR admin)
- Modify: `src/modules/broadcasts/infrastructure/feature-flags.ts` (add `isF71aUs7Enabled` + `f71aUs7DisabledReason`)
- Modify: `src/modules/broadcasts/index.ts` (export the 2 new feature-flag helpers)

**Pattern for each API route** (matches US2 `/api/admin/broadcasts/settings/allowlist/route.ts`):
1. Feature-flag check: `if (!isF71aUs7Enabled()) return notFound()` (admin routes) OR return 503 `feature_disabled` (member routes — same as US1+US2)
2. Auth check: getSession() → role check (admin vs member) → 403 on mismatch
3. Tenant context bind: `runInTenant(asTenantContext(session.tenantId), async () => {...})`
4. zod input validation → 400 on fail
5. Call use-case factory → use-case → map Result error kinds to HTTP status codes per contracts § 2
6. Audit gaps handled by use-case (not route)

- [ ] **Step 1: T121 feature-flag helpers in feature-flags.ts** (append after `f71aUs2DisabledReason`):

```ts
export function isF71aUs7Enabled(): boolean {
  return (
    env.features.f7Broadcasts &&
    env.features.f71aBroadcastAdvanced &&
    env.features.f71aUs7Templates
  );
}

export type F71aUs7DisabledReason =
  | 'f7_master_off'
  | 'f71a_master_off'
  | 'f71a_us7_off';

export function f71aUs7DisabledReason(): F71aUs7DisabledReason | null {
  if (!env.features.f7Broadcasts) return 'f7_master_off';
  if (!env.features.f71aBroadcastAdvanced) return 'f71a_master_off';
  if (!env.features.f71aUs7Templates) return 'f71a_us7_off';
  return null;
}
```

- [ ] **Step 2: T107 POST + GET /api/admin/broadcasts/templates** — POST creates template; GET lists for admin (no locale cascade — admins see all)

- [ ] **Step 3: T108 PATCH + DELETE /api/admin/broadcasts/templates/[id]** — uuid param validation + admin role + use-case calls

- [ ] **Step 4: T109 POST /api/member/broadcasts/draft/[id]/snapshot-template** — member role + draft ownership check + snapshotTemplateToDraft use-case

- [ ] **Step 5: T110 GET /api/broadcasts/templates** — member OR admin role + cascading locale filter from `acceptLanguage` header or session locale

- [ ] **Step 6: Author route contract tests** (4 new files in tests/contract/broadcasts/):
  - `post-admin-broadcasts-templates.contract.test.ts`
  - `patch-admin-broadcasts-templates.contract.test.ts`
  - `post-member-snapshot-template.contract.test.ts`
  - `get-broadcasts-templates.contract.test.ts`

  Each verifies feature-flag-off behaviour + auth check + use-case wiring.

- [ ] **Step 7: Run contract tests**

```bash
pnpm test tests/contract/broadcasts/ --run
```

- [ ] **Step 8: Commit GREEN**

```bash
git add src/app/api/admin/broadcasts/templates/ \
        src/app/api/member/broadcasts/draft/ \
        src/app/api/broadcasts/templates/ \
        src/modules/broadcasts/infrastructure/feature-flags.ts \
        src/modules/broadcasts/index.ts \
        tests/contract/broadcasts/post-admin-broadcasts-templates.contract.test.ts \
        tests/contract/broadcasts/patch-admin-broadcasts-templates.contract.test.ts \
        tests/contract/broadcasts/post-member-snapshot-template.contract.test.ts \
        tests/contract/broadcasts/get-broadcasts-templates.contract.test.ts
git commit -m "[Spec Kit] feat(F7.1a US7): Phase 5F — 4 API routes + isF71aUs7Enabled flag gate (T107-T110 + T121)"
```

---

## Phase 5G — Admin pages + member compose extension (T104-T106 + T111) · 1 commit · ~700 LOC

**Files (all new + 1 modify):**
- `src/app/(staff)/admin/broadcasts/templates/page.tsx` (T104 list)
- `src/app/(staff)/admin/broadcasts/templates/loading.tsx` (companion skeleton — required by check:layout)
- `src/app/(staff)/admin/broadcasts/templates/new/page.tsx` (T105)
- `src/app/(staff)/admin/broadcasts/templates/new/loading.tsx`
- `src/app/(staff)/admin/broadcasts/templates/[id]/edit/page.tsx` (T106)
- `src/app/(staff)/admin/broadcasts/templates/[id]/edit/loading.tsx`
- Modify: `src/app/(member)/portal/broadcasts/new/page.tsx` (T111 — add template picker as first compose action)

**Layout containers per `docs/ux-standards.md` § 18:**
- T104 list page → `TableContainer` (96rem max-width)
- T105 new page + T106 edit page → `FormContainer` (42rem)
- T111 compose page → existing FormContainer (already in use)

**Loading skeleton convention** (per Round-3-Final Phase H7 closure):
Mirrors `/admin/settings/broadcasts/loading.tsx` — real `PageHeader` + real Card title/description from i18n; skeleton only the interactive content.

- [ ] **Step 1: T104 admin template list page** — server component, fetches via use-case, renders semantic table + Starter badges + filter pills

- [ ] **Step 2: T105 admin new template page** — Tiptap editor + name/subject form + locale picker + submit calls POST /api/admin/broadcasts/templates

- [ ] **Step 3: T106 admin edit template page** — same editor + form, pre-populated; if `is_seeded=TRUE` shows confirmation banner (T114)

- [ ] **Step 4: Loading skeletons** — 3 companion files per page

- [ ] **Step 5: T111 member compose extension** — add template picker (T115) as first compose action; auto-snapshot if URL has `?template={id}` query

- [ ] **Step 6: Run check:layout**

```bash
pnpm check:layout
# Expected: page/loading pairs consistent (FR-007 CLS-0)
```

- [ ] **Step 7: Commit GREEN**

```bash
git add src/app/\(staff\)/admin/broadcasts/templates/ \
        src/app/\(member\)/portal/broadcasts/new/page.tsx
git commit -m "[Spec Kit] feat(F7.1a US7): Phase 5G — 3 admin pages + member compose template-picker extension (T104-T106 + T111)"
```

---

## Phase 5H — React components (T112-T117) · 1 commit · ~900 LOC

**Files (all new under `src/components/broadcast/` to match existing singular folder convention):**
- `src/components/broadcast/admin/template-library.tsx` (T112)
- `src/components/broadcast/admin/template-editor.tsx` (T113)
- `src/components/broadcast/admin/template-edit-confirm-starter.tsx` (T114)
- `src/components/broadcast/compose/template-picker.tsx` (T115 — shadcn Combobox)
- `src/components/broadcast/compose/bracket-placeholder.tsx` (T116 — Tiptap node-view)
- `src/components/broadcast/compose/stale-draft-banner.tsx` (T117)

**a11y requirements** (SC-008 — WCAG 2.1 AA):
- T115 Combobox: shadcn Combobox primitive with proper ARIA roles (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`) — preferred over bare `<select>` at scale
- T114 confirmation banner: `role="alert"` for screen-reader announcement
- T117 stale-draft banner: `role="status"` + `aria-live="polite"` + dismissible button with `aria-label`

- [ ] **Step 1: T112 admin-template-library.tsx** — table with Starter badges + 3 filter pills (Starter only / Admin-authored / All)

- [ ] **Step 2: T113 admin-template-editor.tsx** — Tiptap editor wrapper + name/subject form + sanitiser pre-check; reuses existing US2 editor primitives

- [ ] **Step 3: T114 admin-template-edit-confirm-starter.tsx** — banner shown when `is_seeded=TRUE`, dismissible with localStorage memory

- [ ] **Step 4: T115 compose-template-picker.tsx** — shadcn Combobox with cascading locale filter + MRU ordering + Starter badge in dropdown items + "Show all locales" toggle

- [ ] **Step 5: T116 compose-bracket-placeholder.tsx** — Tiptap node-view rendering `[bracketed text]` with grey background + dashed border + first-use microcopy tooltip

- [ ] **Step 6: T117 compose-stale-draft-banner.tsx** — banner on draft load if `template_updated_at > draft.created_at AND draft.created_at < now() - interval '30 days'` with "Refresh from current" CTA

- [ ] **Step 7: Author component unit tests** in `tests/unit/broadcasts/`:
  - admin-template-library.test.tsx (filter pills + Starter badge presence)
  - compose-template-picker.test.tsx (Combobox a11y + locale filter + MRU)
  - stale-draft-banner.test.tsx (date threshold + dismiss + CTA fires)

- [ ] **Step 8: Run unit tests + axe-core check on E2E E1 spec**

```bash
pnpm test tests/unit/broadcasts/ --run
pnpm test:e2e --grep "@a11y.*template" --workers=1
```

- [ ] **Step 9: Commit GREEN**

```bash
git add src/components/broadcast/admin/ src/components/broadcast/compose/ \
        tests/unit/broadcasts/{admin-template-library,compose-template-picker,stale-draft-banner}.test.tsx
git commit -m "[Spec Kit] feat(F7.1a US7): Phase 5H — 6 React components (T112-T117) + 3 unit tests"
```

---

## Phase 5I — i18n EN+TH+SV (T118-T120) · 1 commit · ~600 JSON LOC

**Files:**
- Modify: `src/i18n/messages/en.json` (T118 — ~60 keys; canonical)
- Modify: `src/i18n/messages/th.json` (T119 — ~60 keys; Thai chamber-business register)
- Modify: `src/i18n/messages/sv.json` (T120 — ~60 keys; Swedish formal but warm)

**Key categories** (per T118 spec):
1. `admin.broadcasts.templates.library.*` — list page (~10 keys: title, description, columns, filterPills, emptyState, createButton, starterBadge, etc.)
2. `admin.broadcasts.templates.editor.*` — new + edit pages (~15 keys: fields, validation messages, save/cancel buttons, etc.)
3. `admin.broadcasts.templates.editConfirmStarter.*` — T114 banner (~5 keys: title, body, confirmButton, dismissButton)
4. `portal.broadcasts.compose.templatePicker.*` — T115 picker (~12 keys: triggerLabel, placeholder, blankOption, mruSection, allLocalesToggle, etc.)
5. `portal.broadcasts.compose.bracketPlaceholder.*` — T116 microcopy (~3 keys: firstUseTooltip, ariaLabel, replacePrompt)
6. `portal.broadcasts.compose.staleDraftBanner.*` — T117 (~5 keys: title, body, refreshCta, dismissButton, ariaLabel)
7. `auditEvents.broadcasts.template.*` — 3 audit display strings (`broadcast_template_created/updated/deleted`)
8. `errors.broadcasts.template.*` — error taxonomy (~10 keys: duplicate_name, template_body_unsafe, template_not_found, etc.)

**TH register note** (per FR-020): chamber compliance liaison refines post-ship; maintainer writes initial translations using formal-business tone matching existing TH catalogue.

**SV register note**: formal but warm — matches existing `admin.broadcasts.*` SV translations.

- [ ] **Step 1: Author EN keys** (canonical reference for the other 2 locales)

- [ ] **Step 2: Author TH translations** (chamber-business register)

- [ ] **Step 3: Author SV translations** (formal warm)

- [ ] **Step 4: Run check:i18n**

```bash
pnpm check:i18n
# Expected: GREEN at ~3047 + 180 = ~3227 keys × 3 locales (depending on baseline)
```

- [ ] **Step 5: Commit GREEN**

```bash
git add src/i18n/messages/{en,th,sv}.json
git commit -m "[Spec Kit] i18n(F7.1a US7): Phase 5I — ~60 keys × 3 locales (T118-T120)"
```

---

## Phase 5J — E2E + checklist + final verification · 1 commit

- [ ] **Step 1: Flesh out T096 E2E spec** (was stub at Phase 5A) — full happy path:
  1. Sign in as admin → navigate to `/admin/broadcasts/templates`
  2. Verify 15 starter templates visible (5 names × 3 locales)
  3. Click "Create new" → fill form → save → assert new row appears
  4. Click row → Edit → modify name → save → assert audit row written
  5. Sign in as member → navigate to compose → pick template → assert draft populated
  6. Re-edit template as admin → reload member draft → assert NOT mutated (snapshot decoupling)
  7. axe-core scan on all 3 surfaces (list + editor + picker)

- [ ] **Step 2: Run full E2E suite (env-gated)**

```bash
pnpm test:e2e tests/e2e/broadcasts/template-library-flow.spec.ts --workers=1
```

- [ ] **Step 3: Audit incomplete checklist items**
  - `specs/014-email-broadcast-advance/checklists/a11y.md` — 11 incomplete; check which are US7-touching (T112-T117 unit + axe-core E2E should close most)
  - `specs/014-email-broadcast-advance/checklists/performance.md` — 4 incomplete; T103 list use-case + T102 snapshot benchmark
  - `specs/014-email-broadcast-advance/checklists/security.md` — 5 incomplete; T093 cross-tenant probe + T092 HTML-escape XSS test close some

- [ ] **Step 4: Mark all 36 spec tasks T086-T121 as `[X]` in tasks.md**

- [ ] **Step 5: Run full pre-push CI chain**

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm check:fixme
```

- [ ] **Step 6: Commit verification artefacts + tasks.md updates**

```bash
git add specs/014-email-broadcast-advance/tasks.md \
        specs/014-email-broadcast-advance/checklists/
git commit -m "[Spec Kit] docs(F7.1a US7): Phase 5J — close 36 spec tasks T086-T121 + audit incomplete checklist items"
```

---

## Critical files (all paths)

**Production code (new):**
- Domain: `src/modules/broadcasts/domain/value-objects/template-snapshot.ts` (T097)
- Application: 5 use-cases + 1 port under `src/modules/broadcasts/application/`
- Infrastructure: env-tenant-display-name + composition factories (existing broadcasts-deps.ts)
- Presentation: 3 admin pages + 6 components + 4 API routes
- i18n: 3 JSON catalogues modified

**Production code (modified):**
- `src/modules/broadcasts/domain/broadcast.ts` (T098 helper at end)
- `src/modules/broadcasts/application/ports/broadcast-templates-port.ts` (add withTx + tx params)
- `src/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo.ts` (skeleton → real)
- `src/modules/broadcasts/infrastructure/feature-flags.ts` (add US7 flag helpers)
- `src/modules/broadcasts/infrastructure/broadcasts-deps.ts` (add 5 factories)
- `src/modules/broadcasts/index.ts` (export use-cases + factories + feature-flag helpers)
- `src/app/(member)/portal/broadcasts/new/page.tsx` (T111 picker integration)

**Tests (new):**
- 7 contract tests under `tests/contract/broadcasts/`
- 4 API route contract tests
- 3 integration tests under `tests/integration/broadcasts/`
- 3 unit tests under `tests/unit/broadcasts/`
- 1 E2E spec under `tests/e2e/broadcasts/`

---

## Existing utilities to reuse

- `runInTenant` from `@/lib/db` — mandatory per memory `project_drizzle_repo_tx_pattern`
- `asTenantContext` from `@/modules/tenants` — tenant context wrapping
- `validateImageSourceAllowlist` use-case (Phase 4 T070) — image src validation on template body
- F7 MVP DOMPurify sanitizer (`dompurifySanitizer` from broadcasts barrel) — body HTML sanitisation
- `f7AuditAdapter` — audit emission via existing AuditPort
- `BroadcastTemplate*` types — already in port + barrel from Phase 2
- `BroadcastTemplateRow` Drizzle type — already inferred from schema
- shadcn Combobox primitive — already in `src/components/ui/`
- existing F7 Tiptap editor — `src/components/broadcast/tiptap-editor.tsx`
- `PageHeader` + `FormContainer` + `TableContainer` layout primitives
- `PageSkeletonShell` + `SkeletonBlock` from `@/components/shell/page-skeletons`

---

## Risks + mitigations

1. **No central `tenants` table** for `display_name` resolution (verified via filesystem). Mitigation: env-backed adapter (`NEXT_PUBLIC_TENANT_NAME` → 'SweCham' fallback) matches existing UI pattern; port boundary keeps swap-cost low when SaaS multi-tenant lands.
2. **Test file path drift**: tasks.md says `src/components/broadcasts/*` (plural) but existing folder is `src/components/broadcast/` (singular). Mitigation: follow existing convention; document deviation in Phase 5H commit message.
3. **F2 concurrent agent dirty working tree** (9 fixture-fix files unstaged from migration 0174). Mitigation: per memory `feedback_no_git_stash_concurrent`, leave them alone — F2 agent will commit. Phase 5 tests don't touch members.plans description column.
4. **F7 sanitizer escapeHtml not exported**: T097 needs an HTML-escape helper. Mitigation: include `escapeHtml` directly in the new VO (5 lines, no risk).
5. **Cascading locale filter at use-case vs route layer**: spec ambiguous. Decision: use-case accepts `currentUserLocale` from input; route resolves it from session. Documented in T103 implementation comment.
6. **i18n size**: ~180 new keys is the largest single i18n addition since F8. Mitigation: split into 3 commits (1 per locale) if `pnpm check:i18n` fails on one locale and not others; but if all 3 land atomically the first attempt should pass.
7. **Session sizing**: ~80 source files + 180 i18n keys spans ~10 commits. Mitigation: each phase is independently committable + bisectable; if a session ends mid-phase, the next session resumes at the next unchecked `- [ ]` step.

---

## Out of scope (deferred)

- F7.1b backlog (per-contact opt-in, attachments, open/click tracking, saved segments, PII scanner) — separate feature branch
- Member-authored templates (requires moderation surface)
- Template versioning / history (snapshots are forward-only)
- Cross-tenant template sharing (single-tenant scope)
- Template categorisation / folders
- AI-assisted template generation
- Template usage analytics dashboard (basic `started_from_count` is exposed; deeper metrics in F9 or later)

## Self-Review (run after writing this plan)

- [x] **Spec coverage**: 36 tasks T086-T121 are all mapped to a phase step
- [x] **Constitution Check**:
  - Principle I (Tenant isolation): T093 cross-tenant probe authored RED; Drizzle repo uses runInTenant; ports take TenantSlug
  - Principle II (TDD): RED-first commit precedes any GREEN implementation
  - Principle III (Clean Architecture): Domain pure (no framework imports verified); Application owns ports; Infrastructure adapter never exposes Drizzle types upward
  - Principle IV (PCI DSS): N/A — no payment surface
  - Principle V (i18n): all 3 locales mandatory per FR-020
  - Principle VI (Inclusive UX): WCAG 2.1 AA verified by axe-core E2E + shadcn Combobox a11y
  - Principle VII (Perf & Obs): SC-007a 500ms snapshot target — add benchmark in Phase 5J
  - Principle VIII (Reliability): atomic audit + mutation via port.withTx
  - Principle IX (Solo-maintainer substitute): `[Spec Kit]` prefixed commits
  - Principle X (Simplicity): zero new npm deps; reuses Tiptap + DOMPurify + Combobox + shadcn primitives + audit-port
- [x] **Type consistency**: TenantSlug used throughout (not raw string); BroadcastTemplate type from port; Result<T,E> for fallible operations
- [x] **No placeholders**: all steps have concrete code blocks or specific assertions
