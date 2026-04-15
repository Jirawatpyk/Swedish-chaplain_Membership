# F3 Members & Contacts — Developer Quickstart

**Branch**: `005-members-contacts` | **Date**: 2026-04-15

This guide gets a developer (or AI agent) productive on F3 in under 15 minutes. It assumes F1 + F2 are already shipped and your dev env is set up per [`specs/001-auth-rbac/quickstart.md`](../001-auth-rbac/quickstart.md) (Vercel link, Neon Singapore, Upstash, Resend, Playwright).

---

## 1. New dependencies

```bash
pnpm add @tanstack/react-table i18n-iso-countries
pnpm dlx shadcn@latest add checkbox combobox calendar
```

Pin verification:

```bash
pnpm view @tanstack/react-table@latest version
pnpm view i18n-iso-countries@latest version
```

---

## 2. Database setup

Two new migrations live in `drizzle/migrations/`:

```bash
# Generate from Drizzle schema (after editing src/modules/members/infrastructure/db/*)
pnpm drizzle-kit generate

# Apply to local Neon
pnpm drizzle-kit migrate
```

Migration `0008_members_contacts.sql` creates:
- `members` + `contacts` tables (see [`data-model.md`](./data-model.md))
- `pg_trgm` extension
- All indexes including the partial unique index for FR-003 primary-contact invariant
- RLS policies on both tables

Migration `0009_audit_log_f3_extension.sql` adds 17 new event types via top-level `ALTER TYPE audit_event_type ADD VALUE` statements (each outside any transaction block per Postgres rules — same pattern as F2 `0007`).

**Verify** (against live Neon Singapore):
```bash
psql "$DATABASE_URL" -c "SELECT enum_range(NULL::audit_event_type);"
psql "$DATABASE_URL" -c "\d+ members"  # confirm RLS enabled + FORCE
```

---

## 3. Tenant context — reuse F2 `runInTenant`

F3 does **not** introduce a new tenant resolver. Reuse F2's pattern unchanged:

```ts
import { runInTenant } from '@/lib/tenant-context';
import { resolveTenantContext } from '@/lib/tenant-context';

const ctx = await resolveTenantContext(request);
const result = await runInTenant(ctx, async (db) => {
  return await memberRepo.findById(ctx, memberId);
});
```

Set `DEBUG_RLS_STATE=1` in `.env.local` to get loud failures during dev when a query runs without `app.current_tenant` set.

---

## 4. Composition root

`src/modules/members/members-deps.ts` wires the use cases. Mirrors F2's `plans-deps.ts`:

```ts
export function buildMembersDeps(ctx: TenantContext) {
  const memberRepo = new DrizzleMemberRepo(ctx);
  const contactRepo = new DrizzleContactRepo(ctx);
  const auditPort = buildAuditPort(ctx);
  const emailPort = new ResendEmailPort();          // outbox-backed
  const sessionRevocationPort = buildAuthSessionRevocationPort();  // from @/modules/auth
  const planLookupPort = buildPlanLookupPort();     // from @/modules/plans
  return {
    createMember: makeCreateMember({ memberRepo, contactRepo, auditPort, planLookupPort, clock }),
    changeContactEmail: makeChangeContactEmail({ contactRepo, sessionRevocationPort, emailPort, auditPort }),
    // ...
  };
}
```

---

## 5. Tests

```bash
# Unit + Application
pnpm test src/modules/members

# Contract
pnpm test tests/contract/members

# Integration (live Neon Singapore)
pnpm test:integration tests/integration/members

# E2E + axe-core + i18n
pnpm test:e2e --grep "@f3"
```

**Critical tests** (Review-Gate blockers):
- `tests/integration/members/tenant-isolation.test.ts` — Constitution v1.4.0 Principle I clause 3
- `tests/integration/members/contact-email-change-atomic.test.ts` — FR-012a integrity

---

## 6. UI surfaces

| Path | Owner | Notes |
|---|---|---|
| `/admin/members` | admin + manager | Directory + inline edit + bulk actions (US2, US4) |
| `/admin/members/new` | admin | Create form (US1) |
| `/admin/members/[id]` | admin + manager | Detail (US2 deep link) |
| `/admin/members/[id]/edit` | admin | Edit + bundle-change dialog (US3) |
| `/admin/members/[id]/timeline` | admin + manager | Timeline (US6) |
| `/portal` | member | Self-service profile (US5 — replaces F1 placeholder) |
| `/portal/edit` | member | Whitelisted-field edit (US5) |
| `/portal/contacts/invite` | member (primary) | Colleague invite (US5 AS4) |

The F2 command palette is extended by `src/components/command-palette/members-group.tsx` — registered automatically when the route group loads.

---

## 7. i18n keys

~150 new keys under:
- `admin.members.*` (directory, form, dialogs, bulk actions)
- `admin.members.overrideReason.{board_approved|pending_renewal_grace|data_correction|other}` (FR-006a)
- `admin.members.bundleChangeWarning.*` (FR-010 — F2 D1 carry-over)
- `portal.profile.*` (US5)
- `audit.eventType.{member_*,contact_*,plan_bundle_changed,member_contact_email_changed,user_sessions_revoked,email_verification_sent}` (US6 timeline labels)

CI gate:
```bash
pnpm check:i18n   # fails on missing EN; warns on missing TH/SV (CI-blocks on release branches)
```

---

## 8. Local dev workflow

```bash
pnpm dev                          # http://localhost:3100
pnpm lint && pnpm typecheck       # before every commit
pnpm test:coverage                # respect Domain 100% / Application 80% / 100% branch on security-critical
```

Bootstrap a member for manual testing (after seeding F1 admin + F2 plans):

```bash
# 1. Sign in to /admin as the F1 bootstrap admin
# 2. Open Cmd+K → "Create new member"
# 3. Fill: Fogmaker AB, SE, plan = Premium Corporate 2026, primary contact anna@fogmaker.se
# 4. Confirm member appears at /admin/members
# 5. Click "Invite to portal" — verify email arrives via Resend test inbox
```

---

## 9. CI pipeline (reproduce locally before pushing)

```bash
pnpm lint && \
pnpm typecheck && \
pnpm test:coverage && \
pnpm check:i18n && \
pnpm test:integration && \
pnpm test:e2e
```

Coverage thresholds enforced in `vitest.config.ts`:
- Domain: 100% line
- Application: 80% line + 80% branch overall
- 100% branch on security-critical use cases (see plan § Constitution Check II)
