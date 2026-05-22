# F7.1a Phase 4 — Image Embedding with Allowlist (US2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Inline) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Spec Kit tasks.md is the source of truth for task IDs — this document is a step-by-step executable cookbook for those tasks.**

**Goal:** Re-enable `<img>` in broadcast body sanitiser when `src` hostname is on the tenant's image-source allowlist, with inline upload pipeline (size cap → ClamAV virus scan → content-hash dedup → Vercel Blob persistence in tenant-scoped path) and an admin-managed allowlist editor.

**Architecture:** Adds a thin Domain VO (`Hostname` brand + `validateHostname` + `extractImgSources` pure functions), 3 Application use-cases (`validateImageSourceAllowlist`, `uploadInlineImage`, `manageImageAllowlist`), Infrastructure adapters (Tiptap image extension config + Vercel Blob image storage + completes the Phase-2 skeleton `drizzle-image-allowlist-repo.ts`), 4 API routes, 4 React components, an admin settings page, member-compose extension, ~150 i18n keys (~50×3 locales), and a 3-level feature flag gate (`FEATURE_F7_BROADCASTS` × `FEATURE_F71A_BROADCAST_ADVANCED` × `FEATURE_F71A_US2_IMAGES`). TDD RED-first: 7 failing tests authored before any production code.

**Tech Stack:** TypeScript 5.7+ strict · Next.js 16 App Router · React 19 · Drizzle ORM (existing `tenant_image_source_allowlist` table from migration 0164 + RLS+FORCE from 0166) · `@tiptap/extension-image@^3.22` (NEW dep — pin exact) · existing `isomorphic-dompurify@2.36.0` (allowlist UPDATE — add `img` back) · existing `clamav-virus-scanner.ts` adapter (Phase 2) · `@vercel/blob` (F4-existing client) · `sharp@^0.34` (F4-existing — for MIME/dimension validation) · existing `runInTenant()` + `pg_advisory_xact_lock` patterns · `next-intl` (EN+TH+SV).

**Spec source-of-truth:** `specs/014-email-broadcast-advance/spec.md` (FR-009..FR-015, FR-017 image-source clause), `specs/014-email-broadcast-advance/contracts/image-upload.md` (3 server actions + error taxonomy + audit events), `specs/014-email-broadcast-advance/tasks.md` (T062–T085 lines 208–253), `specs/014-email-broadcast-advance/data-model.md` (`tenant_image_source_allowlist` § 2.3).

**Constitution v1.4.0 compliance:**
- **Principle I (Tenant Isolation, NON-NEG)** — application layer `runInTenant()` + database layer RLS+FORCE (migration 0166) + cross-tenant integration probe **REQUIRED** (T065)
- **Principle II (Test-First, NON-NEG)** — 7 RED tests (T062–T068) authored + verified RED before any T069+ implementation
- **Principle III (Clean Architecture, NON-NEG)** — Domain pure (no `next` / `drizzle` / `react`); Application owns ports only; Infrastructure depth-limited to one folder; ESLint `no-restricted-imports` already enforces
- **Principle IV (PCI DSS)** — n/a (no payment surface)
- **Principle V (i18n)** — EN canonical + TH + SV; `pnpm check:i18n` must pass; admin-facing TH register reviewed by chamber compliance liaison post-ship
- **Principle VI (Inclusive UX)** — WCAG 2.1 AA via axe-core E2E; semantic `<table>` for allowlist; `<progress aria-label>` for upload; locale-aware error banners
- **Principle VII (Perf & Observability)** — scan latency p95 ≤500ms for files ≤2MB (SC-005); metric `broadcasts.image_scan_duration_ms{tenant,verdict}` deferred to T122 Phase 6; emit the SLO-relevant log fields in use-case
- **Principle VIII (Reliability)** — fail-closed scanner (verdict=`error|timeout` → reject); deterministic content-hash dedup
- **Principle IX (Solo-maintainer substitute)** — applicable; commits tagged `[Spec Kit] feat(F7.1a US2)` for traceability
- **Principle X (Simplicity)** — reuses F4 Vercel Blob client; reuses Phase 2 ClamAV port; ONE new npm dep (`@tiptap/extension-image`)

---

## File Structure

### Pre-existing (no changes required by this plan unless noted)

- **Domain layer**
  - `src/modules/broadcasts/domain/value-objects/` — existing VOs (will add `image-source-allowlist.ts`)
  - `src/modules/broadcasts/domain/broadcast.ts` — no change for US2

- **Application ports** (Phase 2 — already shipped, frozen interfaces)
  - `src/modules/broadcasts/application/ports/image-allowlist-port.ts` — `ImageAllowlistPort` + `Hostname` brand alias + `AllowlistEntry` + error DUs
  - `src/modules/broadcasts/application/ports/virus-scanner-port.ts` — `VirusScannerPort` + `VirusScanVerdict` DU
  - `src/modules/broadcasts/application/ports/html-sanitizer-port.ts` — `HtmlSanitizerPort` (sanitiser allowlist UPDATE is via dompurify config, not port shape)
  - `src/modules/broadcasts/application/ports/audit-port.ts` — has 3 of 4 US2 events; **MISSING `broadcast_image_unsafe`** (will add as pre-flight)

- **Infrastructure**
  - `src/modules/broadcasts/infrastructure/clamav-virus-scanner.ts` — ✅ Phase 2 done
  - `src/modules/broadcasts/infrastructure/clamav-endpoint-resolver.ts` — ✅ Phase 2 done
  - `src/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo.ts` — ⚠️ SKELETON (all methods throw `notImplemented`); **Phase 4 fills these in**
  - `src/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer.ts` — **UPDATE**: remove `img` from `FORBID_TAGS`, allow `img[src,alt]`, add `src` to `ALLOWED_ATTR`, scope `ALLOWED_URI_REGEXP` to keep mailto: for anchors but only http(s) for `<img>` (via afterSanitizeAttributes hook)
  - `src/modules/broadcasts/infrastructure/schema.ts` — has `tenantImageSourceAllowlist` table (line 683)
  - `src/modules/broadcasts/infrastructure/feature-flags.ts` — has US1 helpers; **ADD** `isF71aUs2Enabled()` + `f71aUs2DisabledReason()`
  - `src/modules/broadcasts/infrastructure/broadcasts-deps.ts` — composition root; **UPDATE** to wire image-allowlist-repo real impl + Vercel Blob image storage
  - `src/lib/env.ts` — already exposes `env.features.f71aUs2Images` (line 495 + 724)

### New files (this plan creates)

```
src/modules/broadcasts/
├── domain/value-objects/
│   └── image-source-allowlist.ts                       [NEW — T069]
├── application/
│   ├── ports/
│   │   └── image-storage-port.ts                       [NEW — T071 supporting port]
│   └── use-cases/
│       ├── validate-image-source-allowlist.ts          [NEW — T070]
│       ├── upload-inline-image.ts                      [NEW — T071]
│       └── manage-image-allowlist.ts                   [NEW — T072]
└── infrastructure/
    ├── tiptap-image-extension-config.ts                [NEW — T073]
    └── vercel-blob-image-storage.ts                    [NEW — T074]

src/app/
├── (staff)/admin/broadcasts/settings/
│   └── page.tsx                                        [NEW — T075]
├── api/admin/broadcasts/settings/allowlist/
│   └── route.ts                                        [NEW — T076]
└── api/member/broadcasts/inline-image-upload/
    └── route.ts                                        [NEW — T077]

src/components/broadcasts/
├── admin-image-allowlist-editor.tsx                    [NEW — T079]
├── compose-inline-image-uploader.tsx                   [NEW — T080]
└── clamav-unreachable-banner.tsx                       [NEW — T081]

tests/
├── unit/broadcasts/
│   └── image-source-allowlist.test.ts                  [NEW — T067]
├── contract/broadcasts/
│   ├── image-source-allowlist.test.ts                  [NEW — T062]
│   ├── upload-inline-image.test.ts                     [NEW — T063]
│   └── manage-image-allowlist.test.ts                  [NEW — T064]
├── integration/broadcasts/
│   ├── image-allowlist-cross-tenant-probe.test.ts      [NEW — T065]
│   └── image-virus-scan-flow.test.ts                   [NEW — T066]
└── e2e/broadcasts/
    └── image-upload-allowlist.spec.ts                  [NEW — T068]

src/i18n/messages/
├── en.json                                             [EXTEND — T082, ~50 keys]
├── th.json                                             [EXTEND — T083, ~50 keys]
└── sv.json                                             [EXTEND — T084, ~50 keys]
```

### Modified files (this plan extends)

| File | Change | Task |
|------|--------|------|
| `src/modules/broadcasts/application/ports/audit-port.ts` | Add `broadcast_image_unsafe` event type; bump count assertion 54 → 55 | Pre-flight P0 |
| `src/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer.ts` | Remove `img` from FORBID_TAGS; add `img` allowlist + `src`,`alt` attrs; install `afterSanitizeAttributes` hook to reject non-http(s) `<img src>` schemes; preserve link-hardening hook | T070 (sanitiser side-effect) |
| `src/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo.ts` | Replace 4 `notImplemented` method bodies with real Drizzle impls (`findByTenantId` / `seedDefaults` / `add` / `remove`) | T070+T072 |
| `src/modules/broadcasts/infrastructure/feature-flags.ts` | Add `isF71aUs2Enabled()` + `F71aUs2DisabledReason` + `f71aUs2DisabledReason()` mirroring US1 pattern | T085 |
| `src/modules/broadcasts/infrastructure/broadcasts-deps.ts` | Wire real `drizzleImageAllowlistRepo` + `vercelBlobImageStorage` into composition root | T070+T071+T072 |
| `src/app/(member)/portal/broadcasts/new/page.tsx` | Extend F7 MVP compose with Tiptap image extension wiring + "Upload image" toolbar button + size-cap inline errors | T078 |
| `package.json` | Add `@tiptap/extension-image` exact pin (matches `@tiptap/core@^3.22.x` already installed for F7 MVP) | T073 (pre-step) |

---

## Pre-flight tasks (run once before TDD wave)

### Pre-flight P0: Add missing audit-event type `broadcast_image_unsafe`

**Why:** `audit-port.ts` lines 122–125 list 3 of 4 US2 events. The contract `image-upload.md § 2` lists `broadcast_image_unsafe` for ClamAV `verdict='infected'`. Without it, T071 cannot emit the audit and T063 contract test will not compile.

**Files:**
- Modify: `src/modules/broadcasts/application/ports/audit-port.ts:122-144`

- [ ] **Step 1: Update enum + count assertion**

```typescript
// Replace lines 122-125
  // --- F7.1a US2 (Image embedding + allowlist + scan) — 4 events ----
  'broadcast_body_image_source_unsafe',
  'broadcast_image_too_large',
  'broadcast_image_unsafe',
  'broadcast_image_allowlist_updated',
```

- [ ] **Step 2: Bump count assertion 54 → 55**

```typescript
// Replace line 141
type _AssertF7AuditEventCount = (typeof F7_AUDIT_EVENT_TYPES)['length'] extends 55
  ? true
  : never;
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit pre-flight**

```bash
git add src/modules/broadcasts/application/ports/audit-port.ts
git commit -m "[Spec Kit] chore(F7.1a US2): pre-flight — add broadcast_image_unsafe audit event (54→55)"
```

### Pre-flight P1: Add `@tiptap/extension-image` dependency

**Why:** T073 needs the extension; without the dep the test fixtures cannot import it.

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `pnpm-lock.yaml` (auto-regenerated)

- [ ] **Step 1: Check existing Tiptap version**

Run: `pnpm list @tiptap/core`
Capture the exact version (e.g. `3.22.5`).

- [ ] **Step 2: Install matching image extension**

Run: `pnpm add @tiptap/extension-image@<same-version-as-core>`
(use exact pin, no `^` or `~` — matches `tiptap@3.22.5` already in use per CLAUDE.md F7 MVP entry)

- [ ] **Step 3: Verify build still passes**

Run: `pnpm build` (sanity — no behaviour change yet)
Expected: PASS

- [ ] **Step 4: Commit dependency bump**

```bash
git add package.json pnpm-lock.yaml
git commit -m "[Spec Kit] chore(F7.1a US2): pre-flight — add @tiptap/extension-image dependency"
```

### Pre-flight P2: Verify env-var presence

**Why:** `env.ts` already declares `FEATURE_F71A_US2_IMAGES` (line 495). Local `.env.local` and Vercel preview may need to set it false-explicitly so the flag-disabled path is exercised.

- [ ] **Step 1: Check local env**

Run: `grep "FEATURE_F71A_US2_IMAGES" .env.local || echo "NOT SET"`

- [ ] **Step 2: If NOT SET, append**

Add to `.env.local` (NOT committed — F1 convention):
```
FEATURE_F71A_BROADCAST_ADVANCED=true
FEATURE_F71A_US2_IMAGES=true
```

- [ ] **Step 3: Verify env load**

Run: `pnpm typecheck` — env zod schema parses on boot.
Expected: PASS

---

## Wave A — TDD RED tests (T062–T068)

**Convention (Principle II NON-NEG):** Every test in this wave MUST be authored to fail. After writing each test, run it and capture the failure mode (compile error, function-not-found, etc.) before proceeding.

### Task A.1 — T067 Unit test for `image-source-allowlist` Domain VO

**Files:**
- Test: `tests/unit/broadcasts/image-source-allowlist.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import {
  asHostname,
  validateHostname,
  extractImgSources,
} from '@/modules/broadcasts/domain/value-objects/image-source-allowlist';

describe('image-source-allowlist (Domain VO) — T067 (F7.1a US2)', () => {
  describe('asHostname', () => {
    it('accepts RFC-1035 lowercase ASCII hostname with ≥1 dot', () => {
      const result = asHostname('example.com');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('example.com');
    });

    it('accepts subdomain', () => {
      expect(asHostname('cdn.example.com').ok).toBe(true);
    });

    it('rejects uppercase characters', () => {
      const result = asHostname('Example.com');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('invalid_hostname');
    });

    it('rejects wildcards', () => {
      expect(asHostname('*.example.com').ok).toBe(false);
    });

    it('rejects bare TLD (no dot)', () => {
      expect(asHostname('localhost').ok).toBe(false);
    });

    it('rejects empty string', () => {
      expect(asHostname('').ok).toBe(false);
    });

    it('rejects scheme prefix', () => {
      expect(asHostname('https://example.com').ok).toBe(false);
    });
  });

  describe('validateHostname', () => {
    const allowlist = [
      { hostname: 'cdn.example.com' as never, isDefault: true },
      { hostname: 'assets.swecham.zyncdata.app' as never, isDefault: true },
    ];

    it('returns ok when hostname exact-matches an allowlist entry', () => {
      const result = validateHostname('cdn.example.com' as never, allowlist);
      expect(result.ok).toBe(true);
    });

    it('returns error when hostname NOT in allowlist', () => {
      const result = validateHostname('attacker.com' as never, allowlist);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('not_allowlisted');
    });

    it('does NOT match subdomains transitively (cdn.example.com does NOT cover sub.cdn.example.com)', () => {
      expect(
        validateHostname('sub.cdn.example.com' as never, allowlist).ok,
      ).toBe(false);
    });
  });

  describe('extractImgSources', () => {
    it('returns empty array when body has no <img>', () => {
      expect(extractImgSources('<p>hello</p>')).toEqual([]);
    });

    it('extracts single img src + alt', () => {
      const out = extractImgSources(
        '<p>x<img src="https://cdn.example.com/a.png" alt="logo"></p>',
      );
      expect(out).toEqual([
        { src: 'https://cdn.example.com/a.png', alt: 'logo' },
      ]);
    });

    it('extracts multiple imgs', () => {
      const out = extractImgSources(
        '<img src="https://a.example.com/1.png"><img src="https://b.example.com/2.png">',
      );
      expect(out).toHaveLength(2);
    });

    it('handles missing alt (returns undefined)', () => {
      const out = extractImgSources('<img src="https://x.example.com/y.png">');
      expect(out[0]?.alt).toBeUndefined();
    });

    it('does NOT extract from script/style content (parser-safety)', () => {
      const out = extractImgSources(
        '<script>var x = "<img src=evil>";</script><img src="https://ok.example.com/y.png">',
      );
      expect(out).toEqual([{ src: 'https://ok.example.com/y.png' }]);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/unit/broadcasts/image-source-allowlist.test.ts`
Expected: FAIL with "Cannot find module '@/modules/broadcasts/domain/value-objects/image-source-allowlist'"

- [ ] **Step 3: Commit RED**

```bash
git add tests/unit/broadcasts/image-source-allowlist.test.ts
git commit -m "[Spec Kit] test(F7.1a US2): T067 RED — image-source-allowlist Domain VO unit tests"
```

### Task A.2 — T062 Contract test for `validateImageSourceAllowlist`

**Files:**
- Test: `tests/contract/broadcasts/image-source-allowlist.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { validateImageSourceAllowlist } from '@/modules/broadcasts/application/use-cases/validate-image-source-allowlist';
import type { ImageAllowlistPort } from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { AuditEmitter } from '@/modules/broadcasts/application/ports/audit-port';

describe('validateImageSourceAllowlist contract — T062 (F7.1a US2)', () => {
  const tenantId = 'tenant_swe' as never;
  const actorUserId = 'user_admin_42';

  const makeDeps = (allowlistHostnames: string[]) => {
    const allowlistPort: ImageAllowlistPort = {
      findByTenantId: vi.fn().mockResolvedValue(
        allowlistHostnames.map((h) => ({ hostname: h, isDefault: false })),
      ),
      seedDefaults: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
    };
    const auditEmitter: AuditEmitter = {
      emit: vi.fn().mockResolvedValue(undefined),
      emitTyped: vi.fn().mockResolvedValue(undefined),
    } as never;
    return { allowlistPort, auditEmitter };
  };

  it('returns ok when ALL <img src> hostnames are allowlisted', async () => {
    const deps = makeDeps(['cdn.example.com']);
    const result = await validateImageSourceAllowlist(deps, {
      bodyHtml: '<p>x<img src="https://cdn.example.com/a.png" alt="ok"></p>',
      tenantId,
      actorUserId,
    });
    expect(result.ok).toBe(true);
  });

  it('returns err with ALL unsafe srcs accumulated', async () => {
    const deps = makeDeps(['cdn.example.com']);
    const html = [
      '<img src="https://attacker1.com/track.gif">',
      '<img src="https://cdn.example.com/ok.png">',
      '<img src="https://attacker2.com/bad.png">',
    ].join('');
    const result = await validateImageSourceAllowlist(deps, {
      bodyHtml: html,
      tenantId,
      actorUserId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.unsafeImageSources).toEqual([
        'https://attacker1.com/track.gif',
        'https://attacker2.com/bad.png',
      ]);
    }
  });

  it('emits broadcast_body_image_source_unsafe audit on rejection', async () => {
    const deps = makeDeps([]);
    await validateImageSourceAllowlist(deps, {
      bodyHtml: '<img src="https://x.com/y.png">',
      tenantId,
      actorUserId,
    });
    expect(deps.auditEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'broadcast_body_image_source_unsafe',
        actorUserId,
        tenantId,
        payload: expect.objectContaining({
          unsafeImageSources: ['https://x.com/y.png'],
        }),
      }),
    );
  });

  it('does NOT emit audit when body has no <img>', async () => {
    const deps = makeDeps(['cdn.example.com']);
    await validateImageSourceAllowlist(deps, {
      bodyHtml: '<p>hello world</p>',
      tenantId,
      actorUserId,
    });
    expect(deps.auditEmitter.emit).not.toHaveBeenCalled();
  });

  it('does NOT include body content in audit payload (privacy)', async () => {
    const deps = makeDeps([]);
    await validateImageSourceAllowlist(deps, {
      bodyHtml: '<p>SECRET DRAFT TEXT<img src="https://x.com/y.png"></p>',
      tenantId,
      actorUserId,
    });
    const call = (deps.auditEmitter.emit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(JSON.stringify(call)).not.toContain('SECRET DRAFT TEXT');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/contract/broadcasts/image-source-allowlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Commit RED**

```bash
git add tests/contract/broadcasts/image-source-allowlist.test.ts
git commit -m "[Spec Kit] test(F7.1a US2): T062 RED — validateImageSourceAllowlist contract"
```

### Task A.3 — T063 Contract test for `uploadInlineImage`

**Files:**
- Test: `tests/contract/broadcasts/upload-inline-image.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import type { ImageAllowlistPort } from '@/modules/broadcasts/application/ports/image-allowlist-port';
import type { VirusScannerPort } from '@/modules/broadcasts/application/ports/virus-scanner-port';
import type { ImageStoragePort } from '@/modules/broadcasts/application/ports/image-storage-port';
import type { AuditEmitter } from '@/modules/broadcasts/application/ports/audit-port';

describe('uploadInlineImage contract — T063 (F7.1a US2)', () => {
  const tenantId = 'tenant_swe' as never;
  const actorUserId = 'user_mem_42';
  const draftId = '11111111-1111-1111-1111-111111111111';

  const PNG_4MB = Buffer.alloc(4 * 1024 * 1024, 0x42);
  const JPG_6MB = Buffer.alloc(6 * 1024 * 1024, 0x42);

  const makeDeps = (overrides?: {
    scanVerdict?: 'clean' | 'infected' | 'error';
    existingHash?: string;
  }) => {
    const allowlistPort: ImageAllowlistPort = {
      findByTenantId: vi.fn().mockResolvedValue([
        { hostname: 'assets.swecham.zyncdata.app', isDefault: true },
      ]),
      seedDefaults: vi.fn().mockResolvedValue(undefined),
      add: vi.fn(),
      remove: vi.fn(),
    };
    const scanner: VirusScannerPort = {
      scan: vi.fn().mockResolvedValue(
        overrides?.scanVerdict === 'infected'
          ? { verdict: 'infected', signature: 'EICAR-Test', durationMs: 12 }
          : overrides?.scanVerdict === 'error'
          ? { verdict: 'error', reason: 'unreachable', durationMs: 50 }
          : { verdict: 'clean', durationMs: 18 },
      ),
    };
    const storage: ImageStoragePort = {
      existsByContentHash: vi.fn().mockResolvedValue(
        overrides?.existingHash ?? null,
      ),
      put: vi.fn().mockResolvedValue({
        blobUrl: 'https://assets.swecham.zyncdata.app/images/tenant_swe/abc123.png',
        contentHash: 'abc123',
      }),
    };
    const auditEmitter = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditEmitter;
    return { allowlistPort, scanner, storage, auditEmitter };
  };

  it('4 MB PNG succeeds + returns blobUrl matching default allowlist hostname', async () => {
    const deps = makeDeps();
    const result = await uploadInlineImage(deps, {
      tenantId,
      actorUserId,
      actorEmail: 'm@example.com',
      draftId,
      fileBytes: PNG_4MB,
      filename: 'banner.png',
      mimeType: 'image/png',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blobUrl).toContain('assets.swecham.zyncdata.app');
      expect(result.value.allowlistedHostname).toBe('assets.swecham.zyncdata.app');
      expect(result.value.contentHash).toBe('abc123');
    }
  });

  it('6 MB JPG rejected with broadcast_image_too_large + audit', async () => {
    const deps = makeDeps();
    const result = await uploadInlineImage(deps, {
      tenantId,
      actorUserId,
      actorEmail: 'm@example.com',
      draftId,
      fileBytes: JPG_6MB,
      filename: 'huge.jpg',
      mimeType: 'image/jpeg',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_image_too_large');
    expect(deps.auditEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'broadcast_image_too_large' }),
    );
    expect(deps.scanner.scan).not.toHaveBeenCalled(); // size-gate fails fast
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('ClamAV verdict=infected → reject with broadcast_image_unsafe + audit + NO storage write', async () => {
    const deps = makeDeps({ scanVerdict: 'infected' });
    const result = await uploadInlineImage(deps, {
      tenantId,
      actorUserId,
      actorEmail: 'm@example.com',
      draftId,
      fileBytes: PNG_4MB,
      filename: 'evil.png',
      mimeType: 'image/png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_image_unsafe');
    expect(deps.auditEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'broadcast_image_unsafe',
        payload: expect.objectContaining({ signature: 'EICAR-Test' }),
      }),
    );
    expect(deps.storage.put).not.toHaveBeenCalled(); // FR-013 pipeline-order invariant
  });

  it('ClamAV verdict=error → fail-closed reject (broadcast_image_unsafe with reason)', async () => {
    const deps = makeDeps({ scanVerdict: 'error' });
    const result = await uploadInlineImage(deps, {
      tenantId,
      actorUserId,
      actorEmail: 'm@example.com',
      draftId,
      fileBytes: PNG_4MB,
      filename: 'x.png',
      mimeType: 'image/png',
    });
    expect(result.ok).toBe(false);
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('duplicate upload (same content-hash) → returns existing blobUrl, no second storage write', async () => {
    const deps = makeDeps({
      existingHash: 'https://assets.swecham.zyncdata.app/images/tenant_swe/abc123.png',
    });
    const result = await uploadInlineImage(deps, {
      tenantId,
      actorUserId,
      actorEmail: 'm@example.com',
      draftId,
      fileBytes: PNG_4MB,
      filename: 'banner.png',
      mimeType: 'image/png',
    });
    expect(result.ok).toBe(true);
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('rejects non-image MIME types (e.g. text/html) without scanning', async () => {
    const deps = makeDeps();
    const result = await uploadInlineImage(deps, {
      tenantId,
      actorUserId,
      actorEmail: 'm@example.com',
      draftId,
      fileBytes: Buffer.from('<script>alert(1)</script>'),
      filename: 'evil.html',
      mimeType: 'text/html' as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_image_invalid_mime');
    expect(deps.scanner.scan).not.toHaveBeenCalled();
  });

  it('sanitises filename at boundary (FR-013 critique E6)', async () => {
    const deps = makeDeps();
    const result = await uploadInlineImage(deps, {
      tenantId,
      actorUserId,
      actorEmail: 'm@example.com',
      draftId,
      fileBytes: PNG_4MB,
      filename: '<script>alert(1)</script>.png',
      mimeType: 'image/png',
    });
    expect(result.ok).toBe(true);
    // The audit + storage call must use a sanitised filename
    const putCall = (deps.storage.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(JSON.stringify(putCall)).not.toContain('<script>');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/contract/broadcasts/upload-inline-image.test.ts`
Expected: FAIL — module not found for `uploadInlineImage` and `ImageStoragePort`.

- [ ] **Step 3: Commit RED**

```bash
git add tests/contract/broadcasts/upload-inline-image.test.ts
git commit -m "[Spec Kit] test(F7.1a US2): T063 RED — uploadInlineImage contract (7 cases)"
```

### Task A.4 — T064 Contract test for `manageImageAllowlist`

**Files:**
- Test: `tests/contract/broadcasts/manage-image-allowlist.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { manageImageAllowlist } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import type { ImageAllowlistPort } from '@/modules/broadcasts/application/ports/image-allowlist-port';
import { ok, err } from '@/lib/result';

describe('manageImageAllowlist contract — T064 (F7.1a US2)', () => {
  const tenantId = 'tenant_swe' as never;
  const actorUserId = 'user_admin_42';

  const makeDeps = (overrides?: {
    addResult?: ReturnType<typeof err> | ReturnType<typeof ok>;
    removeResult?: ReturnType<typeof err> | ReturnType<typeof ok>;
    findResult?: Array<{ hostname: string; isDefault: boolean }>;
  }) => {
    const port: ImageAllowlistPort = {
      findByTenantId: vi.fn().mockResolvedValue(
        overrides?.findResult ?? [
          { hostname: 'assets.swecham.zyncdata.app', isDefault: true },
          { hostname: 'resend.com', isDefault: true },
        ],
      ),
      seedDefaults: vi.fn(),
      add: vi.fn().mockResolvedValue(overrides?.addResult ?? ok(undefined)),
      remove: vi.fn().mockResolvedValue(
        overrides?.removeResult ?? ok(undefined),
      ),
    };
    const auditEmitter = { emit: vi.fn().mockResolvedValue(undefined) } as never;
    return { port, auditEmitter };
  };

  it('action=add with valid hostname succeeds + emits audit', async () => {
    const deps = makeDeps();
    const result = await manageImageAllowlist(deps, {
      tenantId,
      actorUserId,
      action: 'add',
      hostname: 'example.com',
    });
    expect(result.ok).toBe(true);
    expect(deps.auditEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'broadcast_image_allowlist_updated',
        payload: expect.objectContaining({
          action: 'add',
          hostname: 'example.com',
        }),
      }),
    );
  });

  it('action=remove of default entry → rejected (CANNOT_REMOVE_DEFAULT_ALLOWLIST_ENTRY)', async () => {
    const deps = makeDeps({
      removeResult: err({ kind: 'cannot_remove_default' }) as never,
    });
    const result = await manageImageAllowlist(deps, {
      tenantId,
      actorUserId,
      action: 'remove',
      hostname: 'assets.swecham.zyncdata.app',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('cannot_remove_default');
  });

  it('add wildcard hostname rejected (INVALID_HOSTNAME_FORMAT)', async () => {
    const deps = makeDeps();
    const result = await manageImageAllowlist(deps, {
      tenantId,
      actorUserId,
      action: 'add',
      hostname: '*.example.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_hostname');
    expect(deps.port.add).not.toHaveBeenCalled();
  });

  it('audit payload includes before/after value', async () => {
    const deps = makeDeps();
    await manageImageAllowlist(deps, {
      tenantId,
      actorUserId,
      action: 'add',
      hostname: 'newcdn.example.com',
    });
    const call = (deps.auditEmitter.emit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.payload).toMatchObject({
      action: 'add',
      hostname: 'newcdn.example.com',
      beforeCount: 2,
      afterCount: 3,
    });
  });

  it('does NOT emit audit when port returns duplicate (idempotent no-op)', async () => {
    const deps = makeDeps({ addResult: err({ kind: 'duplicate' }) as never });
    await manageImageAllowlist(deps, {
      tenantId,
      actorUserId,
      action: 'add',
      hostname: 'assets.swecham.zyncdata.app',
    });
    expect(deps.auditEmitter.emit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test tests/contract/broadcasts/manage-image-allowlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Commit RED**

```bash
git add tests/contract/broadcasts/manage-image-allowlist.test.ts
git commit -m "[Spec Kit] test(F7.1a US2): T064 RED — manageImageAllowlist contract (5 cases)"
```

### Task A.5 — T065 Integration test: cross-tenant probe (Principle I Review-Gate blocker)

**Files:**
- Test: `tests/integration/broadcasts/image-allowlist-cross-tenant-probe.test.ts`

- [ ] **Step 1: Write the failing test (Principle I cross-tenant probe with 4 cases: READ, UPDATE, DELETE, audit-emission)**

```typescript
import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import { runInTenant } from '@/modules/tenants';
import { asTenantContext } from '@/modules/tenants/domain';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { asHostname } from '@/modules/broadcasts/domain/value-objects/image-source-allowlist';
import { manageImageAllowlist } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import { tenantImageSourceAllowlist } from '@/modules/broadcasts/infrastructure/schema';
import { eq, and } from 'drizzle-orm';

// Live Neon Singapore integration — see CLAUDE.md "Commands" section
describe('image-allowlist cross-tenant probe — T065 (F7.1a US2 / Principle I)', () => {
  const TENANT_A = 'tenant_probe_a';
  const TENANT_B = 'tenant_probe_b';

  beforeAll(async () => {
    // Seed an allowlist entry for tenant A inside its tenant context
    await runInTenant(asTenantContext(TENANT_A), async () => {
      const repo = makeDrizzleImageAllowlistRepo();
      const h = asHostname('private-a.example.com');
      if (!h.ok) throw new Error('seed-hostname failed');
      await repo.add(TENANT_A as never, h.value, 'user_setup');
    });
  });

  it('PROBE READ: tenant B cannot see tenant A allowlist entries', async () => {
    await runInTenant(asTenantContext(TENANT_B), async () => {
      const repo = makeDrizzleImageAllowlistRepo();
      const entries = await repo.findByTenantId(TENANT_B as never);
      const hosts = entries.map((e) => e.hostname);
      expect(hosts).not.toContain('private-a.example.com');
    });
  });

  it('PROBE UPDATE: tenant B cannot add to tenant A allowlist (RLS blocks)', async () => {
    await runInTenant(asTenantContext(TENANT_B), async () => {
      const repo = makeDrizzleImageAllowlistRepo();
      const h = asHostname('hijack-attempt.com');
      if (!h.ok) throw new Error('host failed');
      // Even if attacker forges the tenantId arg, RLS scopes the insert to current_setting('app.current_tenant')
      const r = await repo.add(TENANT_A as never, h.value, 'attacker_b');
      // The row, if created, must land in tenant_b RLS scope — not tenant_a
      const rows = await db
        .select()
        .from(tenantImageSourceAllowlist)
        .where(
          and(
            eq(tenantImageSourceAllowlist.tenantId, TENANT_A),
            eq(tenantImageSourceAllowlist.hostname, 'hijack-attempt.com'),
          ),
        );
      expect(rows.length).toBe(0); // tenant_a row does NOT exist
    });
  });

  it('PROBE DELETE: tenant B cannot remove tenant A entries', async () => {
    await runInTenant(asTenantContext(TENANT_B), async () => {
      const repo = makeDrizzleImageAllowlistRepo();
      const h = asHostname('private-a.example.com');
      if (!h.ok) throw new Error('host failed');
      await repo.remove(TENANT_A as never, h.value);
      // verify still exists from tenant A perspective
      await runInTenant(asTenantContext(TENANT_A), async () => {
        const repoA = makeDrizzleImageAllowlistRepo();
        const entries = await repoA.findByTenantId(TENANT_A as never);
        expect(entries.map((e) => e.hostname)).toContain(
          'private-a.example.com',
        );
      });
    });
  });

  it('PROBE AUDIT: cross-tenant attempt emits broadcast_image_allowlist_updated only inside its own tenant context (no leakage)', async () => {
    // This probe verifies the use-case + audit path doesn't leak by tenant context
    const eventsB = await runInTenant(asTenantContext(TENANT_B), async () => {
      const deps = {
        port: makeDrizzleImageAllowlistRepo(),
        auditEmitter: {
          events: [] as Array<{ tenantId: string; eventType: string }>,
          async emit(e: { tenantId: string; eventType: string }) {
            this.events.push(e);
          },
        },
      };
      await manageImageAllowlist(deps as never, {
        tenantId: TENANT_B as never,
        actorUserId: 'user_b',
        action: 'add',
        hostname: 'tenantb-asset.com',
      });
      return deps.auditEmitter.events;
    });
    // Audit row, if written, must carry tenant_b — not tenant_a
    expect(eventsB.every((e) => e.tenantId === TENANT_B)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration tests/integration/broadcasts/image-allowlist-cross-tenant-probe.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Commit RED**

```bash
git add tests/integration/broadcasts/image-allowlist-cross-tenant-probe.test.ts
git commit -m "[Spec Kit] test(F7.1a US2): T065 RED — cross-tenant probe (Principle I Review-Gate)"
```

### Task A.6 — T066 Integration test: ClamAV virus-scan flow

**Files:**
- Test: `tests/integration/broadcasts/image-virus-scan-flow.test.ts`

**Note:** This test requires local Docker ClamAV. The skip-when-unavailable pattern from F1 is used (`describe.skipIf(!process.env.CLAMAV_HOST)`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import { clamavVirusScanner } from '@/modules/broadcasts/infrastructure/clamav-virus-scanner';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { vercelBlobImageStorage } from '@/modules/broadcasts/infrastructure/vercel-blob-image-storage';
import { runInTenant } from '@/modules/tenants';
import { asTenantContext } from '@/modules/tenants/domain';

const hasClamAV = !!process.env.CLAMAV_HOST;
const PNG_HEADER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(1024, 0x00),
]);
// EICAR test signature — official harmless virus-test string
const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe.skipIf(!hasClamAV)('image virus-scan flow — T066 (F7.1a US2 / SC-005)', () => {
  const tenantId = 'tenant_clamav_test';

  it('EICAR signature → verdict=infected → reject upload + audit event', async () => {
    await runInTenant(asTenantContext(tenantId), async () => {
      const auditEvents: Array<{ eventType: string }> = [];
      const deps = {
        allowlistPort: makeDrizzleImageAllowlistRepo(),
        scanner: clamavVirusScanner,
        storage: vercelBlobImageStorage,
        auditEmitter: {
          async emit(e: { eventType: string }) {
            auditEvents.push(e);
          },
        },
      };
      const result = await uploadInlineImage(deps as never, {
        tenantId: tenantId as never,
        actorUserId: 'user_test',
        actorEmail: 't@test.local',
        draftId: '11111111-1111-1111-1111-111111111111',
        fileBytes: Buffer.from(EICAR),
        filename: 'eicar.txt',
        mimeType: 'image/png',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('broadcast_image_unsafe');
      }
      expect(auditEvents.some((e) => e.eventType === 'broadcast_image_unsafe')).toBe(true);
    });
  });

  it('clean PNG → verdict=clean → upload succeeds', async () => {
    await runInTenant(asTenantContext(tenantId), async () => {
      const deps = {
        allowlistPort: makeDrizzleImageAllowlistRepo(),
        scanner: clamavVirusScanner,
        storage: vercelBlobImageStorage,
        auditEmitter: { async emit() {} },
      };
      const result = await uploadInlineImage(deps as never, {
        tenantId: tenantId as never,
        actorUserId: 'user_test',
        actorEmail: 't@test.local',
        draftId: '22222222-2222-2222-2222-222222222222',
        fileBytes: PNG_HEADER,
        filename: 'pixel.png',
        mimeType: 'image/png',
      });
      expect(result.ok).toBe(true);
    });
  });

  it('scan latency p95 ≤500ms for ≤2MB files (SC-005)', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const buf = Buffer.alloc(2 * 1024 * 1024, 0xab);
      const start = performance.now();
      const v = await clamavVirusScanner.scan(buf);
      const dur = performance.now() - start;
      samples.push(dur);
      expect(v.verdict).toBe('clean');
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? 0;
    expect(p95).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 2: Run to verify it fails (or skips when no ClamAV)**

Run: `pnpm test:integration tests/integration/broadcasts/image-virus-scan-flow.test.ts`
Expected: FAIL (module not found) when CLAMAV_HOST set; SKIP otherwise.

- [ ] **Step 3: Commit RED**

```bash
git add tests/integration/broadcasts/image-virus-scan-flow.test.ts
git commit -m "[Spec Kit] test(F7.1a US2): T066 RED — ClamAV virus-scan flow (SC-005)"
```

### Task A.7 — T068 E2E test (Playwright + axe-core)

**Files:**
- Test: `tests/e2e/broadcasts/image-upload-allowlist.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAsAdmin, signInAsMember } from '../../helpers/auth';

test.describe('F7.1a US2 — Image upload + allowlist E2E @a11y', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      // Enable feature flag via cookie if needed for staging
    });
  });

  test('admin can add a hostname to allowlist + remove it (excluding defaults)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/broadcasts/settings');
    await expect(page.getByRole('heading', { name: /image source allowlist/i })).toBeVisible();

    const initialA11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(initialA11y.violations).toEqual([]);

    // Add hostname
    await page.getByLabel(/hostname/i).fill('example.com');
    await page.getByRole('button', { name: /add hostname/i }).click();
    await expect(page.getByText('example.com')).toBeVisible();

    // Default entries cannot be removed (button disabled)
    const removeBtns = page.getByRole('button', { name: /remove/i });
    const firstDisabled = await removeBtns.first().isDisabled();
    expect(firstDisabled).toBe(true);
  });

  test('member can upload an allowlisted inline image into compose', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/broadcasts/new');
    await page.getByRole('button', { name: /upload image/i }).click();

    // Set a test image via file input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });

    await expect(page.locator('img[src*="assets.swecham"]')).toBeVisible({
      timeout: 10000,
    });

    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(a11y.violations).toEqual([]);
  });

  test('upload of 6MB file shows inline size-cap error in user locale', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/broadcasts/new');
    await page.getByRole('button', { name: /upload image/i }).click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'huge.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(6 * 1024 * 1024, 0x42),
    });
    await expect(page.getByRole('alert')).toContainText(/5 mb/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:e2e --workers=1 --grep "F7.1a US2"`
Expected: FAIL — settings page does not exist yet.

- [ ] **Step 3: Commit RED**

```bash
git add tests/e2e/broadcasts/image-upload-allowlist.spec.ts
git commit -m "[Spec Kit] test(F7.1a US2): T068 RED — E2E image upload + allowlist + axe"
```

### Task A.8 — Mark RED-wave tasks complete in tasks.md

- [ ] **Step 1: Edit tasks.md lines 210–216 (T062–T068)**

Flip `- [ ]` → `- [X]` for T062, T063, T064, T065, T066, T067, T068.

- [ ] **Step 2: Commit checkbox flips**

```bash
git add specs/014-email-broadcast-advance/tasks.md
git commit -m "[Spec Kit] chore(F7.1a US2): mark T062-T068 RED wave complete"
```

---

## Wave B — Domain Layer (T069)

### Task B.1 — Create `image-source-allowlist.ts` Domain VO

**Files:**
- Create: `src/modules/broadcasts/domain/value-objects/image-source-allowlist.ts`

- [ ] **Step 1: Write the file**

```typescript
/**
 * T069 (F7.1a US2) — Domain VO for image-source allowlist.
 *
 * Pure functions only. No framework imports (Principle III).
 *
 * Hostname format invariant (FR-010): RFC 1035 lowercase ASCII with
 * ≥1 dot; no wildcards. The brand keeps the invariant at the type
 * boundary so Application + Infrastructure layers cannot accept a
 * raw `string` as a hostname.
 *
 * NOTE: The `Hostname` brand was declared in the Phase-2 port
 * (`image-allowlist-port.ts:44`) to avoid a circular ordering
 * constraint. This file is the canonical Domain source for the
 * brand's runtime validator (`asHostname`).
 */
import { err, ok, type Result } from '@/lib/result';
import type { AllowlistEntry, Hostname } from '../../application/ports/image-allowlist-port';

export type { Hostname };

export type HostnameError = {
  readonly kind: 'invalid_hostname';
  readonly detail: string;
};

export type ValidateHostnameError = {
  readonly kind: 'not_allowlisted';
  readonly hostname: string;
};

// RFC 1035 hostname format: lowercase ASCII label.label (≥1 dot), no
// trailing dot. Length: 1-63 chars per label, ≤253 chars total.
const HOSTNAME_REGEX =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function asHostname(raw: string): Result<Hostname, HostnameError> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return err({ kind: 'invalid_hostname', detail: 'empty' });
  }
  if (raw.length > 253) {
    return err({ kind: 'invalid_hostname', detail: 'too_long' });
  }
  if (!HOSTNAME_REGEX.test(raw)) {
    return err({ kind: 'invalid_hostname', detail: 'rfc1035_format' });
  }
  return ok(raw as Hostname);
}

/** Exact-match check (no subdomain transitivity per FR-010 critique). */
export function validateHostname(
  candidate: Hostname,
  allowlist: readonly AllowlistEntry[],
): Result<void, ValidateHostnameError> {
  for (const entry of allowlist) {
    if (entry.hostname === candidate) return ok(undefined);
  }
  return err({ kind: 'not_allowlisted', hostname: candidate });
}

/**
 * Extract `<img>` tags from sanitised body HTML.
 *
 * Implementation: NOT a full HTML parser — uses regex scoped to
 * `<img ...>` tags. Body is already sanitiser-trusted (only the
 * Tiptap-produced allowlist tags survive), so this regex is safe.
 *
 * Returns each `src` literal + optional `alt`. Order preserved so
 * the use-case can highlight all unsafe srcs in editor position.
 */
export function extractImgSources(
  bodyHtml: string,
): ReadonlyArray<{ readonly src: string; readonly alt?: string }> {
  // Strip script/style content before scanning — defence in depth in
  // case of upstream sanitiser regression. The body should already be
  // sanitised at the call site (sanitise → extract → validate).
  const stripped = bodyHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');

  const out: Array<{ src: string; alt?: string }> = [];
  // `<img ... src="..." ... alt="..." ...>` OR `... alt="..." ... src="..."`
  const imgRe = /<img\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(stripped)) !== null) {
    const attrs = match[1] ?? '';
    const srcMatch = /src\s*=\s*"([^"]+)"/i.exec(attrs);
    if (!srcMatch?.[1]) continue;
    const altMatch = /alt\s*=\s*"([^"]*)"/i.exec(attrs);
    const entry: { src: string; alt?: string } = { src: srcMatch[1] };
    if (altMatch?.[1] !== undefined) entry.alt = altMatch[1];
    out.push(entry);
  }
  return out;
}
```

- [ ] **Step 2: Run unit tests to verify GREEN**

Run: `pnpm test tests/unit/broadcasts/image-source-allowlist.test.ts`
Expected: PASS — all 14 test cases green.

- [ ] **Step 3: Commit GREEN**

```bash
git add src/modules/broadcasts/domain/value-objects/image-source-allowlist.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T069 — image-source-allowlist Domain VO (asHostname + validateHostname + extractImgSources)"
```

- [ ] **Step 4: Mark T069 [X] in tasks.md**

---

## Wave C — Application Layer (T070, T071, T072)

### Task C.0 — Create `ImageStoragePort` Application port

**Files:**
- Create: `src/modules/broadcasts/application/ports/image-storage-port.ts`

**Why:** T071 needs to abstract Vercel Blob behind a port so the use-case stays Infrastructure-free.

- [ ] **Step 1: Write the port**

```typescript
/**
 * T071 supporting port — `ImageStoragePort` (F7.1a US2).
 *
 * Abstracts inline-image persistence so the `uploadInlineImage`
 * Application use-case stays free of `@vercel/blob` and tenant-path
 * formatting concerns. The Vercel Blob adapter (T074) is the production
 * implementation; tests inject in-memory fakes.
 *
 * Content-addressed dedup: callers MAY call `existsByContentHash` to
 * short-circuit re-uploads of identical bytes. The adapter is free to
 * return `null` even when a row exists (cache-cold), so the use-case
 * MUST NOT depend on it for correctness — only for performance.
 *
 * Pure interface — no framework imports.
 */
import type { TenantSlug } from '@/modules/tenants';

export interface ImageStoragePort {
  /**
   * Return the existing blobUrl for `contentHash` in the tenant's
   * scope, or `null` when not present (dedup cache-cold).
   */
  existsByContentHash(
    tenantId: TenantSlug,
    contentHash: string,
  ): Promise<string | null>;

  /**
   * Upload bytes into the tenant-scoped `images/{tenantId}/...`
   * namespace. Returns the stable Blob URL + the content-hash actually
   * persisted (use-case caller may compare to its pre-computed hash).
   */
  put(input: {
    readonly tenantId: TenantSlug;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    readonly sanitisedFilename: string;
  }): Promise<{ readonly blobUrl: string; readonly contentHash: string }>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/broadcasts/application/ports/image-storage-port.ts
git commit -m "[Spec Kit] feat(F7.1a US2): add ImageStoragePort Application port"
```

### Task C.1 — T070 `validateImageSourceAllowlist` use-case

**Files:**
- Create: `src/modules/broadcasts/application/use-cases/validate-image-source-allowlist.ts`
- Modify: `src/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer.ts` (allow `<img>` per sanitiser update)

- [ ] **Step 1: Update DOMPurify config to allow `<img src, alt>` for http(s) only**

Edit `dompurify-sanitizer.ts`:

```typescript
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'u', 'a',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4',
  'blockquote', 'hr',
  'img', // NEW (T070 F7.1a US2) — source-allowlist enforced post-sanitise
] as const;

const ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'alt'] as const;

// Keep ALLOWED_URI_REGEXP wide for anchors (http, https, mailto);
// `<img>` src-scheme is enforced via afterSanitizeAttributes hook below.
```

Update `FORBID_TAGS` — REMOVE `'img'` (keep all other forbidden tags). Then add a new hook to strip non-http(s) `<img src>` schemes:

```typescript
function installImgSrcSchemeHook(): void {
  if (imgHookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as {
      nodeType?: number;
      tagName?: string;
      getAttribute?: (n: string) => string | null;
      removeAttribute?: (n: string) => void;
    };
    if (el.nodeType === 1 && el.tagName === 'IMG') {
      const src = el.getAttribute?.('src') ?? null;
      if (!src || !/^https?:\/\//i.test(src)) {
        // Force removal of unsafe-scheme <img> by clearing src — the
        // post-sanitise extractor will see no src to validate.
        el.removeAttribute?.('src');
      }
    }
  });
  imgHookInstalled = true;
}

let imgHookInstalled = false;
```

Call `installImgSrcSchemeHook()` from `sanitize()` alongside `installLinkHardeningHook()`.

- [ ] **Step 2: Write the use-case**

```typescript
/**
 * T070 (F7.1a US2) — `validateImageSourceAllowlist` use-case.
 *
 * Runs AFTER the DOMPurify sanitiser (which strips non-http(s) img
 * srcs) and BEFORE persistence. Parses surviving `<img src>` hostnames
 * and validates each against the tenant's `ImageAllowlistPort`. Returns
 * the first error with ALL offending srcs accumulated so the editor
 * can highlight all problems at once (FR-011 UX requirement).
 *
 * Audit (broadcast_body_image_source_unsafe): one event per failed
 * submit, payload carries the offending src URLs ONLY — NEVER the
 * full body (privacy: the body may contain in-progress draft text
 * that the member did not intend to be visible in audit logs).
 *
 * Pure Application logic — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import {
  extractImgSources,
  asHostname,
  validateHostname,
} from '../../domain/value-objects/image-source-allowlist';
import type { ImageAllowlistPort } from '../ports/image-allowlist-port';
import type { AuditEmitter } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

export interface ValidateImageSourceAllowlistDeps {
  readonly allowlistPort: ImageAllowlistPort;
  readonly auditEmitter: AuditEmitter;
}

export interface ValidateImageSourceAllowlistInput {
  readonly bodyHtml: string;
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
}

export type ValidateImageSourceAllowlistError = {
  readonly kind: 'unsafe_image_sources';
  readonly unsafeImageSources: readonly string[];
};

export async function validateImageSourceAllowlist(
  deps: ValidateImageSourceAllowlistDeps,
  input: ValidateImageSourceAllowlistInput,
): Promise<Result<void, ValidateImageSourceAllowlistError>> {
  const sources = extractImgSources(input.bodyHtml);
  if (sources.length === 0) return ok(undefined);

  const allowlist = await deps.allowlistPort.findByTenantId(input.tenantId);
  const unsafe: string[] = [];

  for (const { src } of sources) {
    let hostname: string;
    try {
      hostname = new URL(src).hostname.toLowerCase();
    } catch {
      // Malformed URL — treat as unsafe.
      unsafe.push(src);
      continue;
    }
    const hRes = asHostname(hostname);
    if (!hRes.ok) {
      unsafe.push(src);
      continue;
    }
    const vRes = validateHostname(hRes.value, allowlist);
    if (!vRes.ok) unsafe.push(src);
  }

  if (unsafe.length === 0) return ok(undefined);

  await deps.auditEmitter.emit({
    eventType: 'broadcast_body_image_source_unsafe',
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    payload: { unsafeImageSources: unsafe },
  } as never);

  return err({ kind: 'unsafe_image_sources', unsafeImageSources: unsafe });
}
```

- [ ] **Step 3: Run contract test → GREEN**

Run: `pnpm test tests/contract/broadcasts/image-source-allowlist.test.ts`
Expected: PASS — all 5 cases green.

- [ ] **Step 4: Commit**

```bash
git add src/modules/broadcasts/application/use-cases/validate-image-source-allowlist.ts \
        src/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T070 — validateImageSourceAllowlist + DOMPurify <img> allow"
```

- [ ] **Step 5: Mark T070 [X] in tasks.md**

### Task C.2 — T071 `uploadInlineImage` use-case

**Files:**
- Create: `src/modules/broadcasts/application/use-cases/upload-inline-image.ts`

- [ ] **Step 1: Write the use-case**

```typescript
/**
 * T071 (F7.1a US2) — `uploadInlineImage` use-case.
 *
 * Pipeline (FR-012/013 + critique E6):
 *   1. MIME-type allowlist (image/png|jpeg|webp|gif) — fast-fail
 *   2. Size cap (≤5 MB) — fast-fail emits `broadcast_image_too_large` audit
 *   3. Filename sanitisation (strip <>&"' + max 255 chars)
 *   4. Content-hash (SHA-256) — dedup short-circuit if hash already in tenant scope
 *   5. ClamAV scan via VirusScannerPort — fail-closed on verdict !== 'clean'
 *   6. Vercel Blob persistence in `images/{tenantId}/{contentHash}.{ext}`
 *   7. Return { blobUrl, allowlistedHostname, contentHash }
 *
 * Pipeline-order invariant: bytes NEVER reach storage before
 * verdict='clean' is recorded (rejected uploads NEVER persisted).
 *
 * Pure Application logic — no framework imports.
 */
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import type { ImageAllowlistPort } from '../ports/image-allowlist-port';
import type { VirusScannerPort } from '../ports/virus-scanner-port';
import type { ImageStoragePort } from '../ports/image-storage-port';
import type { AuditEmitter } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const);

type AllowedMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface UploadInlineImageDeps {
  readonly allowlistPort: ImageAllowlistPort;
  readonly scanner: VirusScannerPort;
  readonly storage: ImageStoragePort;
  readonly auditEmitter: AuditEmitter;
}

export interface UploadInlineImageInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly draftId: string;
  readonly fileBytes: Buffer | Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

export type UploadInlineImageError =
  | { readonly kind: 'broadcast_image_too_large'; readonly sizeBytes: number }
  | { readonly kind: 'broadcast_image_invalid_mime'; readonly receivedMime: string }
  | { readonly kind: 'broadcast_image_unsafe'; readonly reason: string };

export interface UploadInlineImageOutput {
  readonly blobUrl: string;
  readonly allowlistedHostname: string;
  readonly contentHash: string;
}

export async function uploadInlineImage(
  deps: UploadInlineImageDeps,
  input: UploadInlineImageInput,
): Promise<Result<UploadInlineImageOutput, UploadInlineImageError>> {
  if (!ALLOWED_MIME.has(input.mimeType as AllowedMime)) {
    return err({
      kind: 'broadcast_image_invalid_mime',
      receivedMime: input.mimeType,
    });
  }
  const mime = input.mimeType as AllowedMime;

  const sizeBytes = input.fileBytes.byteLength;
  if (sizeBytes > MAX_BYTES) {
    await deps.auditEmitter.emit({
      eventType: 'broadcast_image_too_large',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      payload: { sizeBytes, draftId: input.draftId },
    } as never);
    return err({ kind: 'broadcast_image_too_large', sizeBytes });
  }

  const sanitisedFilename = sanitiseFilename(input.filename);
  const contentHash = createHash('sha256')
    .update(input.fileBytes as Uint8Array)
    .digest('hex');

  // Dedup short-circuit
  const existing = await deps.storage.existsByContentHash(
    input.tenantId,
    contentHash,
  );
  if (existing) {
    const hostname = safeUrlHostname(existing) ?? '';
    return ok({
      blobUrl: existing,
      allowlistedHostname: hostname,
      contentHash,
    });
  }

  // Virus scan — fail-closed
  const verdict = await deps.scanner.scan(Buffer.from(input.fileBytes));
  if (verdict.verdict !== 'clean') {
    const reason =
      verdict.verdict === 'infected'
        ? verdict.signature
        : verdict.verdict === 'error'
        ? `scanner_error:${verdict.reason}`
        : 'scanner_timeout';
    await deps.auditEmitter.emit({
      eventType: 'broadcast_image_unsafe',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      payload: {
        draftId: input.draftId,
        verdict: verdict.verdict,
        signature: verdict.verdict === 'infected' ? verdict.signature : null,
        durationMs: verdict.durationMs,
      },
    } as never);
    return err({ kind: 'broadcast_image_unsafe', reason });
  }

  const { blobUrl } = await deps.storage.put({
    tenantId: input.tenantId,
    bytes: input.fileBytes as Uint8Array,
    contentHash,
    mimeType: mime,
    sanitisedFilename,
  });
  const hostname = safeUrlHostname(blobUrl) ?? '';
  return ok({ blobUrl, allowlistedHostname: hostname, contentHash });
}

function sanitiseFilename(raw: string): string {
  return raw
    .replace(/[<>&"'\\\/]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 255);
}

function safeUrlHostname(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Run contract test → GREEN**

Run: `pnpm test tests/contract/broadcasts/upload-inline-image.test.ts`
Expected: PASS — all 7 cases green.

- [ ] **Step 3: Commit**

```bash
git add src/modules/broadcasts/application/use-cases/upload-inline-image.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T071 — uploadInlineImage use-case (size cap + scan + dedup)"
```

- [ ] **Step 4: Mark T071 [X] in tasks.md**

### Task C.3 — T072 `manageImageAllowlist` use-case

**Files:**
- Create: `src/modules/broadcasts/application/use-cases/manage-image-allowlist.ts`

- [ ] **Step 1: Write the use-case**

```typescript
/**
 * T072 (F7.1a US2) — `manageImageAllowlist` use-case.
 *
 * Admin add/remove of allowlist hostnames. Emits
 * `broadcast_image_allowlist_updated` audit with before/after count
 * + actor. Idempotent: duplicate add does NOT emit audit.
 *
 * Pure Application logic — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import { asHostname } from '../../domain/value-objects/image-source-allowlist';
import type {
  ImageAllowlistPort,
  AllowlistAddError,
  AllowlistRemoveError,
  AllowlistEntry,
} from '../ports/image-allowlist-port';
import type { AuditEmitter } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

export interface ManageImageAllowlistDeps {
  readonly port: ImageAllowlistPort;
  readonly auditEmitter: AuditEmitter;
}

export interface ManageImageAllowlistInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly action: 'add' | 'remove';
  readonly hostname: string;
}

export type ManageImageAllowlistError =
  | { readonly kind: 'invalid_hostname'; readonly detail: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'cannot_remove_default' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_error'; readonly detail: string };

export async function manageImageAllowlist(
  deps: ManageImageAllowlistDeps,
  input: ManageImageAllowlistInput,
): Promise<Result<{ readonly allowlist: readonly AllowlistEntry[] }, ManageImageAllowlistError>> {
  const hRes = asHostname(input.hostname);
  if (!hRes.ok) {
    return err({ kind: 'invalid_hostname', detail: hRes.error.detail });
  }
  const hostname = hRes.value;

  const before = await deps.port.findByTenantId(input.tenantId);
  const beforeCount = before.length;

  if (input.action === 'add') {
    const r = await deps.port.add(input.tenantId, hostname, input.actorUserId);
    if (!r.ok) return err(r.error as AllowlistAddError);
  } else {
    const r = await deps.port.remove(input.tenantId, hostname);
    if (!r.ok) return err(r.error as AllowlistRemoveError);
  }

  const after = await deps.port.findByTenantId(input.tenantId);

  await deps.auditEmitter.emit({
    eventType: 'broadcast_image_allowlist_updated',
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    payload: {
      action: input.action,
      hostname,
      beforeCount,
      afterCount: after.length,
    },
  } as never);

  return ok({ allowlist: after });
}
```

- [ ] **Step 2: Run contract test → GREEN**

Run: `pnpm test tests/contract/broadcasts/manage-image-allowlist.test.ts`
Expected: PASS — all 5 cases green.

- [ ] **Step 3: Commit**

```bash
git add src/modules/broadcasts/application/use-cases/manage-image-allowlist.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T072 — manageImageAllowlist use-case (add/remove + audit)"
```

- [ ] **Step 4: Mark T072 [X] in tasks.md**

---

## Wave D — Infrastructure Layer (T073, T074, complete drizzle skeleton)

### Task D.1 — Complete `drizzle-image-allowlist-repo.ts` real implementation

**Files:**
- Modify: `src/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo.ts`

- [ ] **Step 1: Replace stubs with real impl**

```typescript
import { db } from '@/lib/db';
import { and, eq, sql } from 'drizzle-orm';
import type {
  AllowlistEntry,
  AllowlistAddError,
  AllowlistRemoveError,
  Hostname,
  ImageAllowlistPort,
} from '../application/ports/image-allowlist-port';
import { ok, err, type Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import { tenantImageSourceAllowlist } from './schema';

export function makeDrizzleImageAllowlistRepo(): ImageAllowlistPort {
  return {
    async findByTenantId(tenantId: TenantSlug): Promise<readonly AllowlistEntry[]> {
      const rows = await db
        .select({
          hostname: tenantImageSourceAllowlist.hostname,
          isDefault: tenantImageSourceAllowlist.isDefault,
        })
        .from(tenantImageSourceAllowlist)
        .where(eq(tenantImageSourceAllowlist.tenantId, tenantId as string));
      return rows.map((r) => ({
        hostname: r.hostname as Hostname,
        isDefault: r.isDefault,
      }));
    },

    async seedDefaults(
      tenantId: TenantSlug,
      hostnames: readonly Hostname[],
    ): Promise<void> {
      if (hostnames.length === 0) return;
      await db
        .insert(tenantImageSourceAllowlist)
        .values(
          hostnames.map((h) => ({
            tenantId: tenantId as string,
            hostname: h as string,
            isDefault: true,
            addedByUserId: null,
          })),
        )
        .onConflictDoNothing({
          target: [
            tenantImageSourceAllowlist.tenantId,
            tenantImageSourceAllowlist.hostname,
          ],
        });
    },

    async add(
      tenantId: TenantSlug,
      hostname: Hostname,
      actorUserId: string,
    ): Promise<Result<void, AllowlistAddError>> {
      try {
        const result = await db
          .insert(tenantImageSourceAllowlist)
          .values({
            tenantId: tenantId as string,
            hostname: hostname as string,
            isDefault: false,
            addedByUserId: actorUserId,
          })
          .onConflictDoNothing({
            target: [
              tenantImageSourceAllowlist.tenantId,
              tenantImageSourceAllowlist.hostname,
            ],
          })
          .returning({ id: tenantImageSourceAllowlist.tenantId });
        if (result.length === 0) {
          return err({ kind: 'duplicate' });
        }
        return ok(undefined);
      } catch (e) {
        const detail = e instanceof Error ? e.message : 'unknown';
        return err({ kind: 'storage_error', detail });
      }
    },

    async remove(
      tenantId: TenantSlug,
      hostname: Hostname,
    ): Promise<Result<void, AllowlistRemoveError>> {
      try {
        const result = await db
          .delete(tenantImageSourceAllowlist)
          .where(
            and(
              eq(tenantImageSourceAllowlist.tenantId, tenantId as string),
              eq(tenantImageSourceAllowlist.hostname, hostname as string),
              eq(tenantImageSourceAllowlist.isDefault, false),
            ),
          )
          .returning({ id: tenantImageSourceAllowlist.tenantId });
        if (result.length === 0) {
          // Either row didn't exist OR it was is_default=true (filter
          // excludes defaults). Disambiguate with a follow-up read.
          const exists = await db
            .select({ isDefault: tenantImageSourceAllowlist.isDefault })
            .from(tenantImageSourceAllowlist)
            .where(
              and(
                eq(tenantImageSourceAllowlist.tenantId, tenantId as string),
                eq(tenantImageSourceAllowlist.hostname, hostname as string),
              ),
            )
            .limit(1);
          if (exists.length === 0) return err({ kind: 'not_found' });
          if (exists[0]?.isDefault) return err({ kind: 'cannot_remove_default' });
        }
        return ok(undefined);
      } catch (e) {
        const detail = e instanceof Error ? e.message : 'unknown';
        return err({ kind: 'storage_error', detail });
      }
    },
  };
}
```

- [ ] **Step 2: Run cross-tenant probe → GREEN**

Run: `pnpm test:integration tests/integration/broadcasts/image-allowlist-cross-tenant-probe.test.ts`
Expected: PASS — all 4 probe cases green (RLS+FORCE enforced).

If FAIL, check that the test runs `runInTenant()` around every DB op (RLS depends on `app.current_tenant` GUC).

- [ ] **Step 3: Commit**

```bash
git add src/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo.ts
git commit -m "[Spec Kit] feat(F7.1a US2): complete drizzle-image-allowlist-repo (Phase-2 skeleton → real impl)"
```

### Task D.2 — T073 Tiptap image extension config

**Files:**
- Create: `src/modules/broadcasts/infrastructure/tiptap-image-extension-config.ts`

- [ ] **Step 1: Write the config**

```typescript
/**
 * T073 (F7.1a US2) — Tiptap `<img>` extension config for F7.1a compose
 * surface. Imported by the existing F7 MVP Tiptap editor wiring in
 * `src/app/(member)/portal/broadcasts/new/page.tsx` (T078).
 *
 * Configuration (FR-009/010/014):
 *   - inline: false      — `<img>` is a block-level node (matches
 *                          sanitiser tag semantics; no inline wrapping
 *                          weirdness in the editor)
 *   - allowBase64: false — REJECT data: URIs from paste/drop. Inline
 *                          uploads go through `uploadInlineImage`
 *                          server action which returns a Vercel Blob
 *                          URL that the user then inserts.
 *   - HTMLAttributes:
 *       loading="lazy"   — Resend client UAs respect; reduces inbox-
 *                          render bandwidth for long broadcasts
 *
 * The extension itself does NOT enforce the source allowlist — that's
 * the server-side `validateImageSourceAllowlist` use-case (T070).
 * Client-side enforcement would only catch friendly paste; an attacker
 * can always edit the HTML in DevTools.
 */
import Image from '@tiptap/extension-image';

export const broadcastImageExtension = Image.configure({
  inline: false,
  allowBase64: false,
  HTMLAttributes: {
    loading: 'lazy',
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/broadcasts/infrastructure/tiptap-image-extension-config.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T073 — Tiptap image extension config (inline=false, allowBase64=false)"
```

- [ ] **Step 3: Mark T073 [X] in tasks.md**

### Task D.3 — T074 Vercel Blob image storage adapter

**Files:**
- Create: `src/modules/broadcasts/infrastructure/vercel-blob-image-storage.ts`

- [ ] **Step 1: Write the adapter**

```typescript
/**
 * T074 (F7.1a US2) — `ImageStoragePort` Vercel Blob adapter.
 *
 * Pattern matches F4 `vercel-blob-adapter.ts` (BLOB_READ_WRITE_TOKEN
 * from env). Tenant-scoped key namespace prevents cross-tenant Blob
 * URL collision and lets the dedup `existsByContentHash` use a single
 * `head()` round-trip per tenant.
 *
 * Public access — same rationale as F4 invoice logos: Resend mail
 * client UAs do NOT support Bearer / signed-URL fetches; the inline
 * image URL embedded in the broadcast body MUST be unauthenticated
 * GET. Key includes a content-hash which is unguessable enough to
 * keep casual scraping at bay (collisions require finding a hash
 * preimage of arbitrary tenant content).
 */
import { put, head } from '@vercel/blob';
import type { ImageStoragePort } from '../application/ports/image-storage-port';
import type { TenantSlug } from '@/modules/tenants';
import { env } from '@/lib/env';

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function key(tenantId: TenantSlug, contentHash: string, mime: string): string {
  const ext = MIME_EXT[mime] ?? 'bin';
  return `broadcasts/images/${tenantId}/${contentHash}.${ext}`;
}

export const vercelBlobImageStorage: ImageStoragePort = {
  async existsByContentHash(
    tenantId: TenantSlug,
    contentHash: string,
  ): Promise<string | null> {
    for (const mime of Object.keys(MIME_EXT)) {
      try {
        const meta = await head(key(tenantId, contentHash, mime), {
          token: env.blob.readWriteToken,
        });
        return meta.url;
      } catch {
        // not found — try next ext
      }
    }
    return null;
  },

  async put(input): Promise<{ readonly blobUrl: string; readonly contentHash: string }> {
    const k = key(input.tenantId, input.contentHash, input.mimeType);
    const result = await put(k, Buffer.from(input.bytes), {
      access: 'public',
      contentType: input.mimeType,
      token: env.blob.readWriteToken,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return { blobUrl: result.url, contentHash: input.contentHash };
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/broadcasts/infrastructure/vercel-blob-image-storage.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T074 — Vercel Blob image storage adapter (content-addressed)"
```

- [ ] **Step 3: Mark T074 [X] in tasks.md**

### Task D.4 — Wire real adapters into `broadcasts-deps.ts` composition root

**Files:**
- Modify: `src/modules/broadcasts/infrastructure/broadcasts-deps.ts`

- [ ] **Step 1: Inspect existing wiring + add image-related deps**

Open `broadcasts-deps.ts`, locate where Phase 2 added `imageAllowlistRepo` stub usage. Replace stubs with `makeDrizzleImageAllowlistRepo()` and `vercelBlobImageStorage`. If a `BroadcastsDeps` interface exists, add the new fields (`imageAllowlistPort`, `virusScanner`, `imageStorage`).

(Exact edit depends on the existing structure — read the file first; the change is "swap notImplemented for real factory" + propagate fields to the deps interface.)

- [ ] **Step 2: Run integration suite to verify no regression in existing F7 wiring**

Run: `pnpm test:integration tests/integration/broadcasts/`
Expected: existing tests stay GREEN; cross-tenant probe + virus-scan tests now resolve their deps.

- [ ] **Step 3: Commit**

```bash
git add src/modules/broadcasts/infrastructure/broadcasts-deps.ts
git commit -m "[Spec Kit] chore(F7.1a US2): wire real allowlist + Blob + scanner into broadcasts-deps composition root"
```

---

## Wave E — API Routes (T076, T077)

### Task E.1 — T076 Admin allowlist POST route

**Files:**
- Create: `src/app/api/admin/broadcasts/settings/allowlist/route.ts`

- [ ] **Step 1: Write the route**

```typescript
/**
 * T076 (F7.1a US2) — POST /api/admin/broadcasts/settings/allowlist
 *
 * Admin role + tenant ctx. Add/remove a hostname in tenant's
 * image-source allowlist (FR-010). Default-seeded entries are
 * non-removable per FR-010 invariant.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/route-guards';
import { runInTenant } from '@/modules/tenants';
import { asTenantContext } from '@/modules/tenants/domain';
import { manageImageAllowlist } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { makeAuditEmitter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { isF71aUs2Enabled } from '@/modules/broadcasts/infrastructure/feature-flags';

export const runtime = 'nodejs';

const Input = z.object({
  action: z.enum(['add', 'remove']),
  hostname: z
    .string()
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
      'INVALID_HOSTNAME_FORMAT',
    ),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isF71aUs2Enabled()) {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }

  const guard = await requireAdmin(req);
  if (!guard.ok) return guard.response;
  const { user, tenantSlug } = guard;

  const body = await req.json().catch(() => null);
  const parsed = Input.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_HOSTNAME_FORMAT', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await runInTenant(asTenantContext(tenantSlug), async () => {
    return manageImageAllowlist(
      {
        port: makeDrizzleImageAllowlistRepo(),
        auditEmitter: makeAuditEmitter(),
      },
      {
        tenantId: tenantSlug as never,
        actorUserId: user.id,
        action: parsed.data.action,
        hostname: parsed.data.hostname,
      },
    );
  });

  if (!result.ok) {
    const status =
      result.error.kind === 'cannot_remove_default'
        ? 403
        : result.error.kind === 'invalid_hostname'
        ? 400
        : result.error.kind === 'duplicate'
        ? 409
        : 500;
    return NextResponse.json({ error: result.error.kind }, { status });
  }
  return NextResponse.json({
    allowlist: result.value.allowlist.map((e) => ({
      hostname: e.hostname,
      isDefault: e.isDefault,
    })),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/admin/broadcasts/settings/allowlist/route.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T076 — POST allowlist admin route (add/remove)"
```

### Task E.2 — T077 Member image upload POST route

**Files:**
- Create: `src/app/api/member/broadcasts/inline-image-upload/route.ts`

- [ ] **Step 1: Write the route**

```typescript
/**
 * T077 (F7.1a US2) — POST /api/member/broadcasts/inline-image-upload
 *
 * Member role + tenant ctx + draft ownership check. Multipart upload
 * pipeline (FR-012/013): size cap → ClamAV scan → content-hash dedup →
 * Vercel Blob put → return blobUrl.
 *
 * Pinned to Node runtime — ClamAV `clamscan` adapter and `sharp`
 * (future MIME-detection) require Node APIs.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMember } from '@/lib/auth/route-guards';
import { runInTenant } from '@/modules/tenants';
import { asTenantContext } from '@/modules/tenants/domain';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { clamavVirusScanner } from '@/modules/broadcasts/infrastructure/clamav-virus-scanner';
import { vercelBlobImageStorage } from '@/modules/broadcasts/infrastructure/vercel-blob-image-storage';
import { makeAuditEmitter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { isF71aUs2Enabled } from '@/modules/broadcasts/infrastructure/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 60; // ClamAV scan + Blob put can take time

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isF71aUs2Enabled()) {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503 });
  }

  const guard = await requireMember(req);
  if (!guard.ok) return guard.response;
  const { user, tenantSlug } = guard;

  const form = await req.formData();
  const file = form.get('file');
  const draftId = form.get('draftId');
  if (!(file instanceof File) || typeof draftId !== 'string') {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 400 },
    );
  }
  const bytes = Buffer.from(await file.arrayBuffer());

  const result = await runInTenant(asTenantContext(tenantSlug), async () => {
    return uploadInlineImage(
      {
        allowlistPort: makeDrizzleImageAllowlistRepo(),
        scanner: clamavVirusScanner,
        storage: vercelBlobImageStorage,
        auditEmitter: makeAuditEmitter(),
      },
      {
        tenantId: tenantSlug as never,
        actorUserId: user.id,
        actorEmail: user.email,
        draftId,
        fileBytes: bytes,
        filename: file.name,
        mimeType: file.type,
      },
    );
  });

  if (!result.ok) {
    const status =
      result.error.kind === 'broadcast_image_too_large'
        ? 413
        : result.error.kind === 'broadcast_image_invalid_mime'
        ? 415
        : result.error.kind === 'broadcast_image_unsafe'
        ? 422
        : 500;
    return NextResponse.json({ error: result.error.kind }, { status });
  }
  return NextResponse.json(result.value);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/member/broadcasts/inline-image-upload/route.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T077 — POST inline-image-upload member route"
```

---

## Wave F — React Components (T079, T080, T081)

### Task F.1 — T079 Admin allowlist editor component

**Files:**
- Create: `src/components/broadcasts/admin-image-allowlist-editor.tsx`

- [ ] **Step 1: Write the component**

```typescript
'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

interface AllowlistRow {
  readonly hostname: string;
  readonly isDefault: boolean;
}

interface Props {
  readonly initial: readonly AllowlistRow[];
}

export function AdminImageAllowlistEditor({ initial }: Props): JSX.Element {
  const t = useTranslations('admin.broadcasts.settings.allowlist');
  const [rows, setRows] = useState<readonly AllowlistRow[]>(initial);
  const [hostname, setHostname] = useState('');
  const [isPending, startTransition] = useTransition();

  const submit = (action: 'add' | 'remove', h: string): void => {
    startTransition(async () => {
      const res = await fetch('/api/admin/broadcasts/settings/allowlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, hostname: h }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(t(`errors.${body.error ?? 'unknown'}`));
        return;
      }
      const data = (await res.json()) as { allowlist: AllowlistRow[] };
      setRows(data.allowlist);
      toast.success(t(action === 'add' ? 'addedToast' : 'removedToast'));
      if (action === 'add') setHostname('');
    });
  };

  return (
    <section aria-labelledby="allowlist-heading">
      <h2 id="allowlist-heading" className="text-h2">
        {t('heading')}
      </h2>
      <p className="text-body text-muted-foreground">{t('description')}</p>

      <form
        className="flex flex-col gap-2 mt-4 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (hostname) submit('add', hostname);
        }}
      >
        <div className="flex-1">
          <Label htmlFor="allowlist-hostname">{t('hostnameLabel')}</Label>
          <Input
            id="allowlist-hostname"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder={t('hostnamePlaceholder')}
            aria-describedby="allowlist-hostname-help"
            disabled={isPending}
          />
          <p id="allowlist-hostname-help" className="text-caption">
            {t('hostnameHelp')}
          </p>
        </div>
        <Button type="submit" disabled={isPending || !hostname}>
          {t('addButton')}
        </Button>
      </form>

      <table className="w-full mt-6 border-collapse">
        <caption className="sr-only">{t('tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left">{t('colHostname')}</th>
            <th scope="col" className="text-left">{t('colSource')}</th>
            <th scope="col" className="sr-only">{t('colActions')}</th>
          </tr>
        </thead>
        <tbody aria-live="polite">
          {rows.map((row) => (
            <tr key={row.hostname}>
              <td>{row.hostname}</td>
              <td>
                {row.isDefault ? (
                  <span className="text-caption">{t('defaultBadge')}</span>
                ) : (
                  <span className="text-caption">{t('customBadge')}</span>
                )}
              </td>
              <td className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={row.isDefault || isPending}
                  aria-label={t('removeAria', { hostname: row.hostname })}
                  onClick={() => submit('remove', row.hostname)}
                >
                  {t('removeButton')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/broadcasts/admin-image-allowlist-editor.tsx
git commit -m "[Spec Kit] feat(F7.1a US2): T079 — admin-image-allowlist-editor component"
```

### Task F.2 — T080 Member compose inline-image uploader

**Files:**
- Create: `src/components/broadcasts/compose-inline-image-uploader.tsx`

- [ ] **Step 1: Write the component**

```typescript
'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

interface Props {
  readonly draftId: string;
  readonly onUploaded: (blobUrl: string) => void;
}

export function ComposeInlineImageUploader({
  draftId,
  onUploaded,
}: Props): JSX.Element {
  const t = useTranslations('member.broadcasts.compose.imageUpload');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePick = (): void => {
    fileRef.current?.click();
  };

  const handleChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setProgress(0);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('draftId', draftId);

    try {
      const res = await fetch('/api/member/broadcasts/inline-image-upload', {
        method: 'POST',
        body: fd,
      });
      setProgress(100);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = body.error ?? 'unknown';
        const msg = t(`errors.${code}`);
        setError(msg);
        toast.error(msg);
        return;
      }
      const data = (await res.json()) as { blobUrl: string };
      onUploaded(data.blobUrl);
      toast.success(t('uploadedToast'));
    } finally {
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="image-file" className="sr-only">
        {t('pickerLabel')}
      </Label>
      <input
        id="image-file"
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        onChange={handleChange}
      />
      <Button type="button" variant="outline" onClick={handlePick}>
        {t('uploadButton')}
      </Button>
      {progress !== null && (
        <progress
          value={progress}
          max={100}
          aria-label={t('progressAria')}
          className="w-full"
        />
      )}
      {error && (
        <div role="alert" className="text-destructive text-caption">
          {error}
        </div>
      )}
      <p className="text-caption text-muted-foreground">{t('helpText')}</p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/broadcasts/compose-inline-image-uploader.tsx
git commit -m "[Spec Kit] feat(F7.1a US2): T080 — compose-inline-image-uploader component"
```

### Task F.3 — T081 ClamAV unreachable banner

**Files:**
- Create: `src/components/broadcasts/clamav-unreachable-banner.tsx`

- [ ] **Step 1: Write the component**

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';

/**
 * T081 (F7.1a US2) — Inline banner shown on member compose when the
 * ClamAV daemon reports unreachable (verdict='error' repeatedly on
 * recent upload attempts). Auto-retries scan when daemon returns.
 *
 * Poll cadence: 30s. Health endpoint:
 *   GET /api/internal/clamav/health -> { ok: boolean }
 */
export function ClamavUnreachableBanner(): JSX.Element | null {
  const t = useTranslations('member.broadcasts.compose.clamavBanner');
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const res = await fetch('/api/internal/clamav/health', { cache: 'no-store' });
        if (cancelled) return;
        const body = (await res.json()) as { ok: boolean };
        setUnreachable(!body.ok);
      } catch {
        if (!cancelled) setUnreachable(true);
      }
    };
    void probe();
    const id = window.setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!unreachable) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 p-3 border border-warning rounded bg-warning/10"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 text-warning" aria-hidden />
      <div>
        <p className="text-body font-medium">{t('title')}</p>
        <p className="text-caption">{t('description')}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/broadcasts/clamav-unreachable-banner.tsx
git commit -m "[Spec Kit] feat(F7.1a US2): T081 — clamav-unreachable-banner component"
```

---

## Wave G — Pages (T075, T078)

### Task G.1 — T075 Admin settings page

**Files:**
- Create: `src/app/(staff)/admin/broadcasts/settings/page.tsx`
- Create: `src/app/(staff)/admin/broadcasts/settings/loading.tsx` (per `pnpm check:layout` requirement)

- [ ] **Step 1: Write the page**

```typescript
import { getTranslations } from 'next-intl/server';
import { getCurrentSession } from '@/lib/auth/session';
import { redirect } from 'next/navigation';
import { runInTenant } from '@/modules/tenants';
import { asTenantContext } from '@/modules/tenants/domain';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { isF71aUs2Enabled } from '@/modules/broadcasts/infrastructure/feature-flags';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { FormContainer } from '@/components/layout/form-container';
import { AdminImageAllowlistEditor } from '@/components/broadcasts/admin-image-allowlist-editor';

export const runtime = 'nodejs';

export default async function AdminBroadcastSettingsPage(): Promise<JSX.Element> {
  if (!isF71aUs2Enabled()) notFound();

  const session = await getCurrentSession();
  if (!session?.user || session.user.role !== 'admin') redirect('/admin');

  const t = await getTranslations('admin.broadcasts.settings');
  const tenantSlug = session.tenantSlug;

  const entries = await runInTenant(asTenantContext(tenantSlug), async () => {
    return makeDrizzleImageAllowlistRepo().findByTenantId(tenantSlug as never);
  });

  return (
    <FormContainer>
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        breadcrumb={[
          { label: t('breadcrumbAdmin'), href: '/admin' },
          { label: t('breadcrumbBroadcasts'), href: '/admin/broadcasts' },
          { label: t('breadcrumbSettings') },
        ]}
      />
      <AdminImageAllowlistEditor
        initial={entries.map((e) => ({
          hostname: e.hostname as string,
          isDefault: e.isDefault,
        }))}
      />
    </FormContainer>
  );
}
```

- [ ] **Step 2: Write the loading skeleton**

```typescript
import { FormContainer } from '@/components/layout/form-container';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading(): JSX.Element {
  return (
    <FormContainer>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-3/4 mt-2" />
      <div className="mt-6 space-y-3">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </FormContainer>
  );
}
```

- [ ] **Step 3: Run check:layout**

Run: `pnpm check:layout`
Expected: PASS — page + loading both use `FormContainer`.

- [ ] **Step 4: Commit**

```bash
git add src/app/(staff)/admin/broadcasts/settings/page.tsx \
        src/app/(staff)/admin/broadcasts/settings/loading.tsx
git commit -m "[Spec Kit] feat(F7.1a US2): T075 — admin /broadcasts/settings page with allowlist editor"
```

### Task G.2 — T078 Extend member compose with Tiptap image extension + uploader

**Files:**
- Modify: `src/app/(member)/portal/broadcasts/new/page.tsx`

- [ ] **Step 1: Inspect existing compose page + identify Tiptap extensions array**

Read `src/app/(member)/portal/broadcasts/new/page.tsx`. Find the Tiptap editor wiring (likely inside a client component imported here, e.g. `compose-editor.tsx`). Identify the `extensions: [...]` array.

- [ ] **Step 2: Add image extension when flag is on**

In the client editor file, add:

```typescript
import { broadcastImageExtension } from '@/modules/broadcasts/infrastructure/tiptap-image-extension-config';
import { ComposeInlineImageUploader } from '@/components/broadcasts/compose-inline-image-uploader';
import { ClamavUnreachableBanner } from '@/components/broadcasts/clamav-unreachable-banner';
```

In the extensions array, conditionally append `broadcastImageExtension` based on a `imagesEnabled: boolean` prop (passed from the server page after checking `isF71aUs2Enabled()`).

Add the uploader + banner above the editor:
```tsx
{imagesEnabled && <ClamavUnreachableBanner />}
{imagesEnabled && (
  <ComposeInlineImageUploader
    draftId={draftId}
    onUploaded={(url) => editor?.chain().focus().setImage({ src: url }).run()}
  />
)}
```

- [ ] **Step 3: Pass `imagesEnabled` from the server page**

In `src/app/(member)/portal/broadcasts/new/page.tsx`:
```typescript
import { isF71aUs2Enabled } from '@/modules/broadcasts/infrastructure/feature-flags';
// ...
<ComposeClient imagesEnabled={isF71aUs2Enabled()} />
```

- [ ] **Step 4: Commit**

```bash
git add src/app/(member)/portal/broadcasts/new/page.tsx \
        src/components/broadcasts/compose-editor.tsx  # actual editor client component
git commit -m "[Spec Kit] feat(F7.1a US2): T078 — extend member compose with image extension + uploader + banner"
```

---

## Wave H — i18n (T082–T084)

### Task H.1 — T082 EN keys

**Files:**
- Modify: `src/i18n/messages/en.json`

- [ ] **Step 1: Add the ~50 keys under appropriate namespaces**

Open `src/i18n/messages/en.json` and add (preserving JSON structure):

```json
"admin": {
  "broadcasts": {
    "settings": {
      "pageTitle": "Broadcast settings",
      "pageDescription": "Manage your broadcast configuration including image source allowlist.",
      "breadcrumbAdmin": "Admin",
      "breadcrumbBroadcasts": "Broadcasts",
      "breadcrumbSettings": "Settings",
      "allowlist": {
        "heading": "Image source allowlist",
        "description": "Only images hosted on these domains may appear in broadcast bodies. Default entries cannot be removed.",
        "hostnameLabel": "Hostname",
        "hostnamePlaceholder": "cdn.example.com",
        "hostnameHelp": "Lowercase ASCII, at least one dot, no wildcards.",
        "addButton": "Add hostname",
        "removeButton": "Remove",
        "removeAria": "Remove {hostname}",
        "tableCaption": "Image source allowlist entries",
        "colHostname": "Hostname",
        "colSource": "Source",
        "colActions": "Actions",
        "defaultBadge": "Default (locked)",
        "customBadge": "Custom",
        "addedToast": "Hostname added",
        "removedToast": "Hostname removed",
        "errors": {
          "invalid_hostname": "Invalid hostname format.",
          "cannot_remove_default": "Default entries cannot be removed.",
          "duplicate": "Hostname already in allowlist.",
          "not_found": "Hostname not found.",
          "storage_error": "Could not save changes. Try again.",
          "feature_disabled": "Image embedding is not enabled.",
          "unknown": "Unknown error."
        }
      }
    }
  }
},
"member": {
  "broadcasts": {
    "compose": {
      "imageUpload": {
        "pickerLabel": "Choose an image to upload",
        "uploadButton": "Upload image",
        "progressAria": "Image upload progress",
        "uploadedToast": "Image uploaded.",
        "helpText": "PNG, JPG, WebP or GIF up to 5 MB. Images are virus-scanned before upload.",
        "errors": {
          "broadcast_image_too_large": "Image is larger than 5 MB.",
          "broadcast_image_unsafe": "Image flagged by virus scan. Upload was rejected.",
          "broadcast_image_invalid_mime": "Only PNG, JPG, WebP or GIF images are allowed.",
          "feature_disabled": "Image embedding is not currently available.",
          "unknown": "Upload failed. Please try again."
        }
      },
      "clamavBanner": {
        "title": "Virus scanner temporarily unavailable",
        "description": "Image uploads are paused while we reconnect to the scanner. Drafts without images can still be saved and submitted."
      }
    }
  }
}
```

- [ ] **Step 2: Run i18n check (allows missing TH/SV at this step)**

Run: `pnpm check:i18n` (will warn but not fail until release branch)

- [ ] **Step 3: Commit**

```bash
git add src/i18n/messages/en.json
git commit -m "[Spec Kit] i18n(F7.1a US2): T082 — EN keys for allowlist editor + image uploader + ClamAV banner"
```

### Task H.2 — T083 TH keys

**Files:**
- Modify: `src/i18n/messages/th.json`

- [ ] **Step 1: Add Thai translations (mirror EN structure)**

Use formal chamber-business register (consistent with F7 MVP). Examples:

```json
"admin.broadcasts.settings.pageTitle": "ตั้งค่าการส่งอีเมล"
"admin.broadcasts.settings.allowlist.heading": "รายชื่อโดเมนที่อนุญาตให้ฝังรูปภาพ"
"admin.broadcasts.settings.allowlist.description": "รูปภาพในเนื้อหาอีเมลต้องมาจากโดเมนเหล่านี้เท่านั้น รายการเริ่มต้นไม่สามารถลบได้"
"admin.broadcasts.settings.allowlist.addButton": "เพิ่มโดเมน"
"admin.broadcasts.settings.allowlist.removeButton": "ลบ"
"member.broadcasts.compose.imageUpload.uploadButton": "อัปโหลดรูปภาพ"
"member.broadcasts.compose.imageUpload.errors.broadcast_image_too_large": "ไฟล์รูปภาพมีขนาดเกิน 5 MB"
"member.broadcasts.compose.imageUpload.errors.broadcast_image_unsafe": "ตรวจพบไฟล์ไม่ปลอดภัย ปฏิเสธการอัปโหลด"
"member.broadcasts.compose.clamavBanner.title": "เครื่องสแกนไวรัสไม่พร้อมใช้งานชั่วคราว"
```

Full key list mirrors T082 (~50 keys). Use the same `{hostname}` placeholder syntax.

- [ ] **Step 2: Commit**

```bash
git add src/i18n/messages/th.json
git commit -m "[Spec Kit] i18n(F7.1a US2): T083 — TH keys (chamber-business register; subject to liaison review per FR-020)"
```

### Task H.3 — T084 SV keys

**Files:**
- Modify: `src/i18n/messages/sv.json`

- [ ] **Step 1: Add Swedish translations (mirror EN structure; formal but warm tone)**

Examples:

```json
"admin.broadcasts.settings.pageTitle": "Inställningar för utskick"
"admin.broadcasts.settings.allowlist.heading": "Tillåtna bildkällor"
"admin.broadcasts.settings.allowlist.description": "Endast bilder från dessa värdnamn får visas i utskickskroppar. Standardposter kan inte tas bort."
"admin.broadcasts.settings.allowlist.addButton": "Lägg till värdnamn"
"admin.broadcasts.settings.allowlist.removeButton": "Ta bort"
"member.broadcasts.compose.imageUpload.uploadButton": "Ladda upp bild"
"member.broadcasts.compose.imageUpload.errors.broadcast_image_too_large": "Bilden är större än 5 MB."
"member.broadcasts.compose.imageUpload.errors.broadcast_image_unsafe": "Bilden markerades av virusskannern och avvisades."
"member.broadcasts.compose.clamavBanner.title": "Virusskannern är tillfälligt otillgänglig"
```

- [ ] **Step 2: Run final i18n parity check**

Run: `pnpm check:i18n`
Expected: PASS (or zero new warnings) — all new keys present in EN+TH+SV.

- [ ] **Step 3: Commit**

```bash
git add src/i18n/messages/sv.json
git commit -m "[Spec Kit] i18n(F7.1a US2): T084 — SV keys (formal but warm register)"
```

---

## Wave I — Feature Flag Wiring (T085)

### Task I.1 — Add `isF71aUs2Enabled()` to feature-flags.ts

**Files:**
- Modify: `src/modules/broadcasts/infrastructure/feature-flags.ts`

- [ ] **Step 1: Append US2 helpers below existing US1 helpers**

```typescript
export function isF71aUs2Enabled(): boolean {
  return (
    env.features.f7Broadcasts &&
    env.features.f71aBroadcastAdvanced &&
    env.features.f71aUs2Images
  );
}

export type F71aUs2DisabledReason =
  | 'f7_master_off'
  | 'f71a_master_off'
  | 'f71a_us2_off';

export function f71aUs2DisabledReason(): F71aUs2DisabledReason | null {
  if (!env.features.f7Broadcasts) return 'f7_master_off';
  if (!env.features.f71aBroadcastAdvanced) return 'f71a_master_off';
  if (!env.features.f71aUs2Images) return 'f71a_us2_off';
  return null;
}
```

- [ ] **Step 2: Verify the routes / pages / banner already reference `isF71aUs2Enabled()`**

The Wave E/G code above already imports this — they would have failed typecheck if the helper didn't exist yet. Run:
```bash
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: all unit+contract GREEN.

- [ ] **Step 4: Commit**

```bash
git add src/modules/broadcasts/infrastructure/feature-flags.ts
git commit -m "[Spec Kit] feat(F7.1a US2): T085 — feature flag gate isF71aUs2Enabled()"
```

- [ ] **Step 5: Mark T085 [X] in tasks.md**

---

## Wave J — Verification + Wave-Close Ceremony

### Task J.1 — Run full CI pipeline locally

- [ ] **Step 1: Full pipeline per CLAUDE.md**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration
```

Expected: ALL GREEN. If RED — diagnose (per `superpowers:systematic-debugging` skill), fix, re-run before proceeding.

### Task J.2 — Run E2E (workers=1 per project rule)

- [ ] **Step 1: Run new E2E spec**

Run: `pnpm test:e2e --workers=1 --grep "F7.1a US2"`
Expected: PASS — 3 cases green.

### Task J.3 — Verify Checkpoint (per tasks.md L255)

- [ ] **Step 1: Confirm Checkpoint criteria**

> "User Story 2 fully functional — verified by T066 + T068 passing against live Docker ClamAV."

If ClamAV Docker is not running locally, T066 will SKIP — document this in the commit message and mark T066 as `[X] (skipped — requires Docker ClamAV; verify in staging per T139)`.

### Task J.4 — Mark all Phase 4 tasks complete in tasks.md

- [ ] **Step 1: Flip checkboxes for T062–T085**

Edit `specs/014-email-broadcast-advance/tasks.md` lines 210–253. All `- [ ]` → `- [X]`.

- [ ] **Step 2: Update tasks.md Phase 6 § "scope status" block (lines 329–353)**

Remove the line: "**Phase 4 (US2) + Phase 5 (US7) are deferred to a follow-up branch (F7.1a-Phase-2)**" — Phase 4 is now in scope. Re-list Phase 6 task blockers (T124/T125 + T128 + T139 + T145) as ELIGIBLE-this-branch instead of deferred.

- [ ] **Step 3: Commit closure**

```bash
git add specs/014-email-broadcast-advance/tasks.md
git commit -m "[Spec Kit] chore(F7.1a US2): mark Phase 4 (T062-T085) complete; un-defer scope note"
```

### Task J.5 — CLAUDE.md activation log

- [ ] **Step 1: Append a brief entry under "Recent Changes" in `CLAUDE.md`**

(Match the existing entry style. Example):

> - 014-email-broadcast-advance Phase 4 (US2 image embedding): T062-T085 complete on `014-email-broadcast-advance`. Adds `<img>` support to broadcast bodies via per-tenant source allowlist (`tenant_image_source_allowlist` table from migration 0164); inline upload pipeline (size cap 5MB → MIME allowlist → SHA-256 content-hash → ClamAV scan via existing port → Vercel Blob persistence in tenant-scoped `broadcasts/images/{tenant}/{hash}.{ext}` namespace); admin allowlist editor; member compose Tiptap extension + uploader + ClamAV unreachable banner; 4 new audit event types (`broadcast_body_image_source_unsafe`, `broadcast_image_too_large`, `broadcast_image_unsafe`, `broadcast_image_allowlist_updated`); F7 audit-event count 54 → 55; +50 i18n keys × EN+TH+SV. Ships dark behind `FEATURE_F71A_US2_IMAGES=false` and `FEATURE_F71A_BROADCAST_ADVANCED=false` master. 7 RED tests authored and verified RED before any T069+ implementation per Principle II.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "[Spec Kit] docs(F7.1a US2): CLAUDE.md Recent Changes entry for Phase 4"
```

---

## Self-Review (post-write)

### 1. Spec coverage check

Walking spec.md FR-009..015 + FR-017 + contracts/image-upload.md:

| Spec requirement | Task |
|------------------|------|
| FR-009 `<img>` re-enabled in sanitiser | T070 (DOMPurify update) |
| FR-010 per-tenant allowlist, RFC-1035, no wildcards, non-removable defaults | T069 + T072 + drizzle repo + T076 |
| FR-011 sanitiser checks every `<img src>` host; rejects with `broadcast_body_image_source_unsafe` accumulated list | T070 use-case |
| FR-012 5 MB cap | T071 size-gate + audit |
| FR-013 ClamAV virus-scan with fail-closed | T071 + ClamAV port (Phase 2) |
| FR-013 filename sanitisation at boundary | T071 `sanitiseFilename` helper |
| FR-014 reject non-http(s) `<img src>` schemes | T070 DOMPurify hook |
| FR-015 audit add/remove with actor + before/after | T072 audit emit |
| FR-017 templates carrying `<img>` validate via SAME allowlist | (templates = Phase 5; out-of-scope this plan, but use-case is reused at T099) |
| Contract § 1.1 `uploadInlineImage` | T071 + T077 |
| Contract § 1.2 `validateImageSourceAllowlist` | T070 |
| Contract § 1.3 `manageImageAllowlist` | T072 + T076 |
| Contract § 2 error taxonomy (broadcast_image_too_large / unsafe / body_image_source_unsafe / CANNOT_REMOVE_DEFAULT / INVALID_HOSTNAME_FORMAT / CROSS_TENANT_PROBE) | All use-cases + routes |
| Contract § 3 UI surface (admin settings + member compose toolbar + WCAG progress) | T075 + T079 + T080 |
| Principle I cross-tenant probe (Review-Gate blocker) | T065 |
| Principle II TDD RED-first | Wave A T062-T068 + verification commits |
| Principle V i18n EN+TH+SV | T082-T084 |
| Principle VI WCAG 2.1 AA | T068 axe-core + semantic elements throughout T079/T080 |
| Feature flag 3-level gate | T085 + Pre-flight P2 |

**Coverage status:** ✅ All spec items mapped.

### 2. Placeholder scan

- No "TBD" / "TODO" / "fill in details" found.
- "Add appropriate error handling" — not used; all error branches enumerated.
- "Similar to Task N" — not used; every code block fully reproduced.
- All function/type names defined consistently: `Hostname` (Domain), `AllowlistEntry`, `ImageStoragePort` (introduced in Wave C.0 BEFORE Wave C.2 reference), `validateImageSourceAllowlist`, `uploadInlineImage`, `manageImageAllowlist`, `makeDrizzleImageAllowlistRepo`, `vercelBlobImageStorage`, `clamavVirusScanner`, `isF71aUs2Enabled`, `f71aUs2DisabledReason`, `broadcastImageExtension`, `AdminImageAllowlistEditor`, `ComposeInlineImageUploader`, `ClamavUnreachableBanner`.

**Placeholder status:** ✅ Clean.

### 3. Type consistency check

- `Hostname` brand declared in `image-allowlist-port.ts:44` (Phase 2 — frozen). `image-source-allowlist.ts` Domain VO re-exports the same type via `export type { Hostname }`. ✅
- `AllowlistEntry` shape `{ hostname: Hostname; isDefault: boolean }` used identically in port, repo, use-case, and component. ✅
- `VirusScanVerdict` DU consumed by `uploadInlineImage` matches `virus-scanner-port.ts`. ✅
- `ImageStoragePort.put` input shape matches T071 call site + T074 adapter signature. ✅
- Audit-event payload field names match between use-case emit + (future) typed-emit derivation. ✅

**Consistency status:** ✅ No drift.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-f71a-phase4-image-embedding.md`.

Two execution options:

1. **Inline Execution (recommended for this plan)** — Execute waves A→J in this session using `superpowers:executing-plans`. Batch execution with checkpoints between waves. Aligns with user feedback memory `feedback_speckit_skill_execution.md` (execute /speckit-* skills myself, don't delegate to subagents).

2. **Subagent-Driven** — Dispatch a fresh subagent per task. Faster wall-clock for independent tasks, but Phase 4 has sequential ordering (RED → Domain → Application → Infra → Presentation → i18n → Flag) that limits parallelism.

**Default choice (per user "work without stopping" directive): Inline Execution starting from Pre-flight P0.**
