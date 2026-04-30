Here is a draft plan to refine:

# Plan: F7 Phase 3 US1 Implementation — Member Composes & Submits E-Blast (T057–T092, "ultraplan")

> Supersedes: prior Batch C+D plan content.
> User confirmed: "ultraplan" — enhanced plan mode with parallel Explore + comprehensive architectural decision documentation.

---

## Context

**Why now**: Phase 2 Foundational COMPLETE (T001–T035 GREEN; commits landed). Phase 3 US1 RED tests landed (T036–T056 GREEN as RED skeletons; 32+12+15+13 Domain unit tests already authored). MVP slice = US1 + US2; this plan delivers **US1 (member compose+submit half of MVP)**.

**Goal**: Turn the 21 RED tests for US1 GREEN by shipping ~38 files / ~3000 LOC across 4 Clean-Architecture layers:

- **Domain (T057)** — `Broadcast` aggregate root with state machine + immutable-after-submit invariants
- **Infrastructure (T058–T063)** — DOMPurify sanitiser, RFC-5321 email-validator, F3+F2 bridge adapters, F6 EventAttendees stub, Drizzle repos, composition root
- **Application (T064–T072)** — 6 use-cases (sanitize-html, validate-custom-recipients, resolve-segment-recipients, compute-quota-counter, save-draft, submit-broadcast) + tenant-context enforcer + RBAC extension + Upstash rate-limiter
- **Presentation (T073–T092)** — 6 API routes + 13 UI components + ~30 i18n keys × 3 locales

**Acceptance**: All 21 US1 RED tests GREEN. `pnpm typecheck && pnpm lint && pnpm test:integration && pnpm test:e2e --grep "broadcast" --workers=1` clean. AS1–AS5 from spec.md walked end-to-end.

---

## Architectural decisions (resolved from 3-agent exploration)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| AD1 | Sanitiser placement | **Application port** (`HtmlSanitizerPort`) + DOMPurify Infrastructure adapter | Constitution III + FR-002a; raw body MUST never reach Domain or DB |
| AD2 | Segment resolver pagination | **Single query, hard-cap 5,000 in SQL** (`LIMIT 5001` overflow detect) | FR-016a; pagination across audiences deferred to F7.1 |
| AD3 | Tiptap extensions | **StarterKit minus `Image` + custom paste-handler that re-runs sanitiser** | R2-NEW-1 + R2-NEW-2; matches FR-002a allowlist (no `<img>`) |
| AD4 | API route structure | **REST `route.ts` only** (no Server Actions) | Mirrors F4/F5 100%; Agent B confirmed zero `'use server'` in repo |
| AD5 | State-machine guard placement | **Domain (canonical) + Application repo wrap (defence-in-depth) + DB trigger (already in 0064)** | Triple-layer; Domain returns Result, Application asserts pre-write, DB raises if mutation slips through |
| AD6 | Auth+RBAC wiring | **`requireMemberContext()` for portal routes** | Mirrors F5 portal routes; RBAC table extended in T071 |
| AD7 | Save-draft idempotency | **Upsert by partial unique `(tenant_id, requested_by_member_id) WHERE status='draft'`** — single mutable draft per member | Simpler than client draftId; FR-001 says "drafts are user-controlled scratch" |
| AD8 | Compose form state | **react-hook-form + zod resolver** + `useDeferredValue(bodyHtml)` for preview | Matches F3 member-form + F4 invoice-form |
| AD9 | Audit emission ordering | **In-tx audit insert AFTER state insert; cross-tenant probes use separate tx** | Mirrors F4 `archive-member`; failure rolls back state change |

---

## Critical files (~38 files)

### Layer 1 — Domain (T057)

| File | Action | LOC |
|------|--------|-----|
| `src/modules/broadcasts/domain/broadcast.ts` | Replace minimal stub with aggregate root: `createDraftBroadcast()` factory + `transition(broadcast, target, actor)` calling `broadcast-status-transitions.ts` policy + `assertImmutableAfterSubmit()` invariant + dual-actor (`requested_by_member_id` + `submitted_by_user_id` + `actor_role`) field validation per Q12 | ~200 |

### Layer 2 — Infrastructure (T058–T063 + composition root)

| File | Purpose | LOC |
|------|---------|-----|
| `src/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer.ts` | Wraps `isomorphic-dompurify` with explicit `ALLOWED_TAGS`/`ALLOWED_ATTR`/`ALLOWED_URI_REGEXP=/^(https?\|mailto):/i`/`FORBID_TAGS=['img','script','style','iframe','form','link','meta','base','object','embed','svg']`/`FORBID_ATTR=[/^on/, 'style']`. Pure function. | ~60 |
| `src/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator.ts` | Wraps `email-validator` package + lowercase+trim. Returns `Result<EmailLower, EmailFormatError>`. | ~30 |
| `src/modules/broadcasts/infrastructure/members-bridge.ts` | Implements `MembersBridgePort` calling F3 barrel exports from T029. | ~120 |
| `src/modules/broadcasts/infrastructure/plans-bridge.ts` | Implements `PlansBridgePort` calling F2 barrel `getPlanForMember` from T030. Returns `{eblastPerYear, planCode}`. | ~40 |
| `src/modules/broadcasts/infrastructure/event-attendees-stub.ts` | Implements `EventAttendeesRepository.findRecentAttendeeEmails(_window) → []`. F6 swap pattern documented inline. | ~25 |
| `src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts` | `BroadcastsRepo` impl: saveDraft, insertSubmitted, findByIdAndMember, countReservedForMember, countSentForMemberInQuotaYear, findOpenDraftForMember. All via `runInTenant`. | ~250 |
| `src/modules/broadcasts/infrastructure/db/drizzle-broadcast-segment-definitions-repo.ts` | Read-only adapter for seeded segment defs table. | ~40 |
| `src/modules/broadcasts/application/broadcasts-deps.ts` | Composition root: `makeSaveDraftDeps`, `makeSubmitBroadcastDeps`, `makeComputeQuotaDeps`, `makeGetBroadcastDeps`. Mirrors `invoicing-deps.ts` shape exactly. | ~150 |

### Layer 3 — Application (T064–T072)

| File | Purpose | LOC |
|------|---------|-----|
| `src/modules/broadcasts/application/use-cases/sanitize-html.ts` | Wraps `HtmlSanitizerPort` + 200 KB cap (`broadcast_body_too_large`). | ~40 |
| `src/modules/broadcasts/application/use-cases/validate-custom-recipients.ts` | 3-source resolution (members.primary_contact_email → contacts.email → event_attendees stub) + RFC-5321 reject + 100-entry cap + lowercase+trim + empty reject. Returns each unresolved address in error. | ~120 |
| `src/modules/broadcasts/application/use-cases/resolve-segment-recipients.ts` | Switch on `RecipientSegment.type`: all_members / tier:X / event_attendees_last_90d (stub `[]`) / custom. Suppression filter. Excludes halted members. Excludes self (Q16). LIMIT 5001 overflow detect. Emits `member_missing_primary_contact` per orphan. | ~180 |
| `src/modules/broadcasts/application/use-cases/compute-quota-counter.ts` | Derives `{used, reserved, remaining, cap}`. Used=`COUNT(status='sent' AND quota_year_consumed=$Y)`; reserved=`COUNT(status IN ('submitted','approved'))`; cap from `eblast_per_year`. Asia/Bangkok via js-joda. Cap=0 → zeroQuota. | ~100 |
| `src/modules/broadcasts/application/use-cases/save-draft.ts` | Upsert by partial unique `(tenant_id, requested_by_member_id) WHERE status='draft'`. Sanitiser at boundary; raw body never persisted. Audit `broadcast_drafted` on first create only (FR-004). | ~140 |
| `src/modules/broadcasts/application/use-cases/submit-broadcast.ts` | Orchestrates 11 preconditions a–k → sanitiser → segment resolver → reservation insert (status='submitted') → audit `broadcast_submitted` (with `actor_role`+member_id+segment+estimated_count) → enqueue admin notification via `EmailTransactionalPort`. **100% branch coverage required.** | ~280 |
| `src/modules/broadcasts/application/use-cases/enforce-tenant-context.ts` | Helper throws `BroadcastCrossTenantProbeError` + emits `broadcast_cross_member_probe` (separate tx). | ~50 |
| `src/modules/auth/rbac/policies.ts` (extend) | Add `broadcast` resource: actions `create_draft`/`submit`/`read_own`/`read_all`/`approve`/`reject`. Member: create_draft+submit+read_own. Admin: all. Manager: deny. | +30 |
| `src/modules/broadcasts/application/rate-limit/submit-rate-limiter.ts` | `rateLimiter.check('broadcasts.submit:${tenantId}:${memberId}', 10, 86400)` per Spec § Assumptions. | ~25 |
| `src/modules/broadcasts/index.ts` (extend barrel) | Export use-case **functions** + Input/Output types + composition factories. NOT ports / Drizzle Rows. | +60 |

### Layer 4 — Presentation: API routes (T073–T078)

All under `src/app/api/broadcasts/**`. Thin handler pattern: extract params → `requireMemberContext()` → `resolveTenantFromRequest` → kill-switch via proxy.ts entry → zod parse body → `rateLimiter.check` (where applicable) → `makeXyzDeps(tenantCtx.slug)` → use-case → Result → HTTP via shared `errorResponse`. Bilingual error messages + correlationId envelope per F5 convention.

| File | Route | Use-case | Tests GREEN |
|------|-------|----------|-------------|
| `src/app/api/broadcasts/draft/route.ts` | `POST` (create) + `PUT` (update) | save-draft.ts | T036 |
| `src/app/api/broadcasts/draft/[id]/route.ts` | `DELETE` (no audit per FR-001) | repo direct | T036 |
| `src/app/api/broadcasts/submit/route.ts` | `POST` | submit-broadcast.ts | T037+T045+T047–T056 |
| `src/app/api/broadcasts/[id]/route.ts` | `GET` | getBroadcastForMember (~40 LOC new) + enforce-tenant-context | (US1 polish) |
| `src/app/api/broadcasts/quota/route.ts` | `GET` | compute-quota-counter.ts | (T046 caller) |

Shared helpers:

| File | Purpose | LOC |
|------|---------|-----|
| `src/lib/broadcasts-route-helpers.ts` | `errorResponse(status, code, correlationId, extra?)` + `httpStatusForBroadcastError(code)` switch + bilingual `F7_ERROR_MESSAGES` const for 11 precondition codes a–k + audience-too-large + custom-recipient-unknown + member-halted-pending-review + immutable-after-submit + quota-blocked + rate-limited + internal-error. | ~80 |
| `src/proxy.ts` (extend) | Add F7 kill-switch guard for `/api/broadcasts/**` — 503 `feature_disabled` when `env.features.f7Broadcasts === false`. | +30 |

### Layer 4 — Presentation: UI (T079–T092)

#### Pages

| File | Container | Pattern |
|------|-----------|---------|
| `src/app/(member)/portal/broadcasts/new/page.tsx` | FormContainer | Server component — fetches tenant config + saved draft via `compute-quota-counter` + `findOpenDraftForMember`. Passes to client form. |
| `src/app/(member)/portal/broadcasts/new/loading.tsx` | FormContainer | Shimmer skeleton: PageHeader + 6-field form-skeleton (subject, segment selector, editor `min-h-[300px]`, schedule, preview, submit row). |
| `src/app/(member)/portal/benefits/e-blasts/page.tsx` | TableContainer | Server component — broadcasts table + `<QuotaDisplay />` card. Used by T053. |
| `src/app/(member)/portal/benefits/e-blasts/loading.tsx` | TableContainer | Skeleton |

#### Components (under `src/components/broadcast/`)

| File | Lib | LOC |
|------|-----|-----|
| `compose-form.tsx` (T081) | react-hook-form + zod resolver. Owns form state. Wraps Tiptap + segment-picker + custom-list-input + schedule-picker + preview-pane + submit-button + quota-display. `useDeferredValue(bodyHtml)` for preview. Submit: POST `/api/broadcasts/submit` → 200 redirect → 4xx branch (toast or modal per F3). | ~280 |
| `tiptap-editor.tsx` (T082) | `'use client'`. Direct `@tiptap/react`. `extensions: [StarterKit.configure({ image: false })]` (R2-NEW-1). Paste handler runs sanitiser + emits sanitiser-strip-warn toast (R2-NEW-2). ARIA-live region (CHK029). | ~140 |
| `tiptap-editor-loader.tsx` (uses T035) | `next/dynamic({ssr:false})` wrapper + shimmer fallback via editor-skeleton. | ~25 |
| `tiptap-toolbar.tsx` (T083) | Bold/Italic/Underline/Lists/Link. Ctrl+B/I/U with `event.isComposing` IME guard (CHK059). Bilingual aria-labels via `useTranslations`. | ~120 |
| `editor-skeleton.tsx` (T084) | Shimmer matching editor min-height. | ~20 |
| `segment-picker.tsx` (T085) | Radio group (all_members / tier:X / event_attendees_last_90d / custom). `aria-describedby` for empty-segment + cap-exceeded. | ~100 |
| `custom-list-input.tsx` (T086) | Textarea with per-line lowercase+trim preview. 100-entry counter. Per-line validation feedback on blur. | ~120 |
| `schedule-picker.tsx` (T087) | Optional future-send date+time. TH locale uses Buddhist Era display via js-joda formatter + i18n. | ~100 |
| `preview-pane.tsx` (T088) | Split-pane: shows sanitised body via `dangerouslySetInnerHTML` (re-sanitised client-side via DOMPurify defence-in-depth). Re-renders on `useDeferredValue` body change. | ~80 |
| `quota-display.tsx` (T089) | 4 counters: used/reserved/remaining/cap. Progress bar (destructive when remaining=0). Fetches `GET /api/broadcasts/quota`. | ~100 |
| `submit-button.tsx` (T090) | Disabled-state derivation per FR-002 preconditions a–k. 8s spinner timeout → "Taking longer than expected" toast (CHK053). | ~80 |
| `marketing-acknowledgement-banner.tsx` (T091) | Server component at `src/app/(member)/portal/_components/`. Renders if member role + tenant has F7 + `broadcasts_acknowledged_at IS NULL` + `eblast_per_year > 0 OR is_active`. CTA emits `member_acknowledged_broadcasts_terms` audit (Q15). Banner-dismissal focus return (CHK042). | ~80 |

#### i18n (T092 — ~30 keys × 3 locales)

`src/i18n/messages/{en,th,sv}.json`:
- `portal.broadcasts.compose.{title,subtitle,fields.{subject,recipientSegment,customList,body,schedule,previewText}}`
- `portal.broadcasts.compose.editor.aria.*` (CHK029 SR announcements)
- `portal.broadcasts.compose.editor.announcements.*`
- `portal.broadcasts.errors.*` (11 precondition codes a–k)
- `portal.broadcasts.banner.acknowledgement.{title,body,acknowledge,remindLater}`
- `portal.broadcasts.empty.*`
- `portal.broadcasts.toast.{drafted,submitted,quotaBlocked,rateLimited}`
- `portal.broadcasts.quota.{used,reserved,remaining,cap}`

TH/SV may use placeholder strings flagged `[F7-TH-REVIEW]` / `[F7-SV-REVIEW]` (chamber liaison reviews at /speckit.ship per i18n.md CHK041).

---

## Step-by-step execution order (5 waves)

### Wave 1 — Domain (~2h, ~200 LOC)

1. **T057** — `Broadcast` aggregate root in `src/modules/broadcasts/domain/broadcast.ts`. Replace stub with: factory `createDraftBroadcast(input) → Result<Broadcast, ValidationError>`, `transition(broadcast, target, actor)`, `assertImmutableAfterSubmit(current, next)`, dual-actor field validation (Q12).
2. Verify T038 + T041 GREEN: `pnpm test tests/unit/broadcasts/domain/`.

### Wave 2 — Infrastructure (~3h, ~715 LOC)

3. **T058** dompurify-sanitizer (60) — T042 GREEN.
4. **T059** rfc5321-email-validator (30).
5. **T060** members-bridge (120).
6. **T061** plans-bridge (40).
7. **T062** event-attendees-stub (25) — T050 GREEN.
8. **T063** drizzle-broadcasts-repo + drizzle-segment-defs-repo (290).
9. Composition root broadcasts-deps.ts (150).

### Wave 3 — Application (~4h, ~935 LOC)

10. **T064** sanitize-html (40) — T042 GREEN.
11. **T065** validate-custom-recipients (120) — T043 + T048 GREEN.
12. **T066** resolve-segment-recipients (180) — T044 + T049 + T050 GREEN.
13. **T067** compute-quota-counter (100) — T046 GREEN.
14. **T068** save-draft (140).
15. **T069** submit-broadcast (280) — T045 + T051 GREEN. **100% branch coverage.**
16. **T070** enforce-tenant-context (50).
17. **T071** RBAC extension (30).
18. **T072** rate-limiter wrap (25) — T056 GREEN at API-route.
19. Extend barrel.
20. Verify: `pnpm test tests/unit/broadcasts/ tests/integration/broadcasts/` GREEN.

### Wave 4 — API routes (~2h, ~600 LOC)

21. broadcasts-route-helpers.ts shared error mapper + bilingual messages (80).
22. **T073 + T074** POST/PUT `/api/broadcasts/draft` (100) — T036 GREEN.
23. **T075** DELETE `/api/broadcasts/draft/[id]` (40).
24. **T076** POST `/api/broadcasts/submit` (180) — T037 + T045 + T047–T056 GREEN.
25. **T077** GET `/api/broadcasts/[id]` (80).
26. **T078** GET `/api/broadcasts/quota` (60).
27. Extend src/proxy.ts with F7 kill-switch guard (30).
28. Verify: `pnpm test:integration tests/contract/broadcasts/ tests/integration/broadcasts/` GREEN.

### Wave 5 — UI + i18n (~5h, ~1450 LOC)

29. **T079 + T080** compose page + loading skeleton (~80).
30. **T084** editor-skeleton (20).
31. **T082** tiptap-editor (140) — depends on T035 tiptap-loader from Phase 2 Batch D.
32. **T083** tiptap-toolbar (120).
33. tiptap-editor-loader wrapper (25).
34. **T085** segment-picker (100).
35. **T086** custom-list-input (120).
36. **T087** schedule-picker (100).
37. **T088** preview-pane (80).
38. **T089** quota-display (100).
39. **T090** submit-button (80).
40. **T081** compose-form orchestrator (280) — wires above + react-hook-form + zod + submit handler.
41. **T091** marketing-acknowledgement-banner (80) at `src/app/(member)/portal/_components/`.
42. **T092** i18n keys × 3 locales.
43. `pnpm check:i18n` GREEN.
44. Final verification (§ Verification).

---

## Reused F4/F5 patterns (avoid re-inventing)

- **Composition root** — copy `src/modules/invoicing/application/invoicing-deps.ts` shape (Agent A confirmed)
- **Auth helpers** — `requireMemberContext()` from `src/lib/member-context.ts` (Agent B)
- **Tenant resolution** — `resolveTenantFromRequest()` from `src/lib/tenant-context.ts`
- **runInTenant** — `runInTenant(ctx, async (tx) => {...})` from `src/lib/db.ts`
- **Error mapper shape** — copy `src/lib/payments-route-helpers.ts` (F5 bilingual + correlationId envelope)
- **Form pattern** — react-hook-form + zod + per-field `<Controller>` from `src/components/members/member-form.tsx`
- **Skeletons** — `SkeletonBlock` + `.skeleton-shimmer` from `src/components/shell/page-skeletons.tsx`
- **Confirmation dialog** — `src/components/shell/confirmation-dialog.tsx`
- **Toast** — `sonner` `toast.success` / `toast.error({description, action})`
- **Container** — `FormContainer` (42rem) compose; `TableContainer` (96rem) e-blasts list
- **PageHeader + BreadcrumbNav** — established F4 pattern

## Pitfalls flagged by exploration

- **Drizzle enum narrowing** — `inArray` on enum fails TS. Use raw SQL `${field}::text = ANY(ARRAY[...]::text[])` (learnt in Batch C).
- **Tiptap requires browser DOM** — MUST use `next/dynamic({ssr:false})`. Direct import in server component breaks build.
- **DOMPurify SSR** — `isomorphic-dompurify` works in Node; safe in Application sanitiser. Client preview-pane runs second pass (defence-in-depth).
- **Body 200 KB cap** — measure rendered HTML AFTER sanitiser, reject `broadcast_body_too_large` before persist.
- **Cross-tenant probe audit `tx=null`** — separate tx (the violating tx is rolled back). Mirrors F4 archive-member.
- **Quota year boundary** — Asia/Bangkok via js-joda/timezone. Mixing system tz = off-by-12-hours bug.
- **Self-exclusion (Q16)** — segment resolver MUST exclude `requested_by_member_id`'s primary contact email. Easy to miss.
- **Halt-flag precondition `k`** — submit must reject with `broadcast_member_halted_pending_review` BEFORE running sanitiser/segment-resolver (cheap rejection first per F5 ordering).
- **Audit emit ordering** — emit AFTER state insert in same tx; failure rolls back. Don't emit-then-insert.

---

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Sanitiser strips legitimate content (false positives) | Medium | Medium | T047 RED has 30+ payloads exercising every allowed tag; sanitiser-strip-warn toast (R2-NEW-2) |
| 11-precondition ordering bug → wrong error code | Medium | High | T045 RED has 100% branch coverage; ordering matches FR-002 literally; reviewer diffs against spec |
| Quota counter race (concurrent submits) | Low | High | All in `runInTenant` tx; reservation insert + audit emit atomic. Verify with concurrent E2E. |
| F2→F3 dependency direction | Low | Medium | Already resolved via `MemberPlanIdentityLookup` port in Batch C |
| RLS leak via members-bridge SQL | Low | CRITICAL | All bridge calls via `runInTenant` + tenant-scoped repos; verify with `pnpm test:integration tests/integration/rls-coverage.test.ts` after Wave 2 |
| Tiptap bundle bloat (~120 KB gzipped) | Medium | Low | Dynamic import via T035 keeps it out of initial bundle |
| TH/SV translations break i18n build | High | Medium | Placeholder strings flagged `[F7-TH-REVIEW]`; check:i18n warns (does not block) on TH/SV until release branch |
| Send-now triggers premature dispatch (US1 should NOT dispatch — only reserve) | Medium | High | submit-broadcast.ts MUST end at status='submitted'; dispatch is US3 (cron) or US2 (admin). T045 enforces. |
| Audit type drift between F3 and F7 | Low | Medium | F3 (Batch C) does NOT emit F7 events — F7 members-bridge (T060) calls F3 use-case + F7 emits F7-owned audit. Documented in plan.md § Complexity Tracking. |

---

## Verification

```bash
# Wave 1 (Domain)
pnpm test tests/unit/broadcasts/domain/                            # 72 tests GREEN

# Wave 2 (Infrastructure)
pnpm typecheck && pnpm lint                                         # GREEN
pnpm test:integration tests/integration/rls-coverage.test.ts        # GREEN (no leak)

# Wave 3 (Application)
pnpm test tests/unit/broadcasts/application/                        # all GREEN incl. 100% branch on submit-broadcast
pnpm test:integration tests/integration/broadcasts/                 # T047–T051 GREEN
pnpm test:coverage --grep "submit-broadcast"                        # 100% branch verified

# Wave 4 (API routes)
pnpm test tests/contract/broadcasts/                                # T036 + T037 GREEN

# Wave 5 (UI + i18n)
pnpm check:i18n                                                     # EN GREEN; TH/SV warn-only OK
pnpm check:layout                                                   # FormContainer pair on compose page GREEN
pnpm test:e2e --grep "broadcast" --workers=1                        # T052–T056 GREEN (5 specs)
pnpm dev                                                            # manual smoke

# Final
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1
```

Manual smoke:
1. Sign in as member with quota
2. Open `/portal/broadcasts/new` → form renders + quota card
3. Type subject + Tiptap body + select "All members" → preview pane sanitised
4. Submit → toast "Submitted" + redirect to detail
5. Quota counter: reserved +1
6. Audit: `broadcast_drafted` (first save) + `broadcast_submitted` rows present, `actor_role='member_self_service'`
7. Paste `<script>alert(1)</script>` → sanitiser strips + warn toast
8. Member with used=cap → submit-button disabled + bilingual explainer

---

## Out of scope

- US2 (T093+) admin review — Phase 4
- US3 (T136+) scheduled-send cron + dispatch worker — Phase 5
- US4 webhooks — Phase 6
- US5 unsubscribe page — Phase 7
- US6 admin proxy compose UI — Phase 8 (reuses compose-form with admin-context wrapper)
- F6 EventAttendees real impl — F6 ships in same Phase 2 batch; stub returns `[]` until F6 plugs in
- Per-broadcast 5% complaint-rate auto-halt — webhook-driven, US4
- Image embedding `<img>` allowlist + source verification — F7.1
- Per-secondary-contact opt-in — F7.1
- Pagination across multiple Resend audiences for >5,000 — F7.1

---

## Commit strategy (5 commits, one per wave)

1. `[Spec Kit] F7 Phase 3 US1 W1 — Domain Broadcast aggregate (T057)`
2. `[Spec Kit] F7 Phase 3 US1 W2 — Infrastructure adapters + composition root (T058–T063)`
3. `[Spec Kit] F7 Phase 3 US1 W3 — Application use-cases + RBAC + rate-limiter (T064–T072)`
4. `[Spec Kit] F7 Phase 3 US1 W4 — API routes + kill-switch guard (T073–T078)`
5. `[Spec Kit] F7 Phase 3 US1 W5 — UI components + i18n (T079–T092)`

Each body lists tasks GREEN-turned + tests GREEN-turned + LOC delta. After all 5: `tasks.md` marks T057–T092 `[X]`. Phase 3 US1 COMPLETE → Phase 4 (US2) clear to start.

I have enough context. The draft plan is largely sound but has some inaccuracies I need to correct: the multi-draft model (not single-mutable), the existing Domain interface (T057 extends, not rewrites), and the RED tests being mostly it.todo() skeletons that must be written with the implementation. Let me write the final plan.