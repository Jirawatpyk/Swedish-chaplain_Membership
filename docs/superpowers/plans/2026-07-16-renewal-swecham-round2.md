# Renewal SweCham Alignment Round 2 (F-4 / F-5 / S3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Due-anchored pre-termination warnings + a permanent "never terminate unwarned" guard (F-4), gate every Chamber-OS payment rail against charging a terminated member + make residual leaks admin-visible (F-5), and surface the termination basis on the admin cycle detail (S3).

**Architecture:** F-4 adds a tier-less, code-constant "due track" (`due+7.email` / `due+30.email`) anchored on the member's oldest-due unpaid membership bill, fed by a **second candidate arm** with no `expires_at` pre-filter, and a dormancy guard at the `due_plus_60` terminate boundary. F-5 gates the F4 `recordPayment` admin-manual rail via a new invoicing-owned membership-access port (4th copy of the consumer-owns-port pattern) and instruments **both** post-termination payment exits with an audit event + metric + idempotent escalation task. S3 reads `termination_basis`/`due_date` off the `renewal_lapsed` audit row.

**Tech Stack:** Next.js 16 App Router, TypeScript 5.7 strict, Drizzle ORM + Neon Postgres (RLS), Vitest (+ live-Neon integration), next-intl (messages) / `copy.test.ts` (email copy).

**Spec:** `docs/superpowers/specs/2026-07-16-renewal-swecham-round2-design.md` (rev 2 — read it once before starting; §3/§4/§5 are the requirements, §9 records why each mechanism is shaped this way).

## Global Constraints

- Worktree: `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\.claude\worktrees\membership-suspension`, branch `066-renewal-swecham-round2` (based on `origin/main` @ `c6d3453a5`).
- **pnpm only** (never npm). Dev server :3100 belongs to the user — never start/kill it.
- **Integration tests:** `pnpm test:integration <file-path>` — pass the file **path positionally**; `-- <pattern>` runs the whole ~40-min suite.
- **Migration discipline:** apply the migration (`pnpm db:migrate`, hits the dev Neon branch) + run the touched integration file(s) **before** committing schema changes. Re-verify the migration number is the next free one against `main` at execution time.
- **Never `git add -A` / `git add .`** (PII workbooks live in the tree). Stage explicit paths only.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Conventional Commits; header ≤ 100 chars.
- `pnpm typecheck` is the **final** gate after the last edit of every task (untrustworthy while a dev server runs — if it fails on `.next/dev/types`, use `pnpm tsc --noEmit -p tsconfig.tsccheck.json` if present, else re-run with dev server stopped — do NOT delete `.next` artifacts).
- Email copy parity is pinned by `tests/unit/renewals/copy.test.ts` (NOT `check:i18n`); messages-file keys (portal/admin/audit labels) ARE `check:i18n` scope and must land in `en.json` + `th.json` + `sv.json` together.
- Timestamps ISO-8601 UTC; Buddhist-Era is display-only.
- Tenant-scoped repo methods must thread `tx` from `runInTenant` — never the global `db`.
- F-5 touches money surfaces → the branch needs ≥2 reviewers at PR time (operator gate; not a task in this plan).
- Constants fixed by the spec: `MIN_WARNING_NOTICE_DAYS = 14`; due-track steps exactly `due+7.email` and `due+30.email`; audit event name exactly `payment_on_terminated_member` (retention 10y); defer reason exactly `no_prior_warning`.

---

## File structure (locked decisions)

| File | Responsibility |
|---|---|
| `src/modules/renewals/domain/due-track.ts` (NEW) | Pure due-track model: step consts, due-step date math (no 7-day staleness), statutory-warning acceptance predicate, min-notice predicate |
| `src/modules/renewals/infrastructure/email/templates/copy.ts` | + `DUE_TRACK_COPY` per-locale const + `resolveDueTrackCopy` |
| `src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx` | + due-track branch (bypasses `deriveOffsetFromStepId` tier/offset parsing) |
| `src/modules/renewals/application/ports/dispatch-candidate-repo.ts` | + `DueTrackCandidate` + `listDueTrackCandidates` |
| `src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts` | + second candidate arm (awaiting_payment ⋈ oldest unpaid membership bill, **no expires_at filter**) |
| `src/modules/renewals/application/use-cases/_lib/dispatch-due-track.ts` (NEW) | Per-cycle due-track dispatch (gates + insertIfAbsent + send + audit) |
| `src/modules/renewals/application/use-cases/dispatch-renewal-cycle.ts` | + due-track pass (before main pass) + `dueTrackCycleIds` suppression set |
| `src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts` | + t+N **email**-step suppression for due-track cycles |
| `src/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry.ts` | + dormancy guard (`due_plus_60` only) + `deferred_no_prior_warning` counter + deferred detail rows |
| `src/app/api/cron/renewals/lapse-cycles-on-grace-expiry/[tenantId]/route.ts` + coordinator | + counter in JSON + escalation-task creation for deferred rows |
| `src/lib/metrics.ts` | + `no_prior_warning` reason label + `paymentOnTerminatedMember` counter |
| `drizzle/migrations/0249_*.sql` (NEW — renumber if taken) | `ALTER TYPE audit_event_type ADD VALUE payment_on_terminated_member` |
| `src/modules/renewals/application/ports/renewal-audit-emitter.ts` | + event type (69→70) + payload shape + 10y retention override hook |
| `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts` | + `F8_ENUM_SHIPPED_TUPLE` entry + per-event retention override |
| `src/modules/auth/infrastructure/db/schema.ts` | + `DB_ONLY_AUDIT_EVENT_TYPES` entry |
| `src/modules/invoicing/application/ports/membership-access-port.ts` (NEW) | Invoicing-owned membership-access port (4th copy) |
| `src/modules/invoicing/infrastructure/membership-access-bridge.ts` (NEW) | Bridge → renewals `deriveMembershipAccess` + leaf repo factory |
| `src/modules/invoicing/application/use-cases/record-payment.ts` | + `membership_terminated` gate (admin-manual, membership subject only) |
| `src/app/(staff)/admin/invoices/_components/record-payment-error-routing.ts` | + dedicated message code |
| `src/modules/renewals/application/use-cases/resolve-unlinked-membership-payment.ts` | terminal_only branch: audit + metric + escalation (replaces silent warn) |
| `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts` | terminal skip branch: same net |
| `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/use-initiate-payment.ts` | + 403 body-code mapping |
| `src/app/(staff)/admin/renewals/[cycleId]/page.tsx` | + terminated callout + termination-basis field |
| `src/modules/renewals/application/ports/reminder-audit-query-repo.ts` + drizzle impl | + `findRenewalLapsedForCycle` |
| `src/modules/renewals/application/use-cases/load-cycle-detail.ts` | + `lapseInfo` |
| `src/i18n/messages/{en,th,sv}.json` | + portal notice, record-payment error, callout, basis labels, audit label |

Execution order: Tasks 1→12. Tasks 1–5 (F-4) and 6–10 (F-5) are independent groups; S3 (Task 11) is independent of both. Do not parallelize file-mutating tasks.

---

### Task 1: F-4 domain — `due-track.ts` (pure)

**Files:**
- Create: `src/modules/renewals/domain/due-track.ts`
- Test: `tests/unit/renewals/due-track.test.ts`

**Interfaces (Produces):**
```ts
export const DUE_TRACK_STEP_IDS = ['due+7.email', 'due+30.email'] as const;
export type DueTrackStepId = (typeof DUE_TRACK_STEP_IDS)[number];
export interface DueTrackStep { readonly stepId: DueTrackStepId; readonly offsetDays: 7 | 30; }
export const DUE_TRACK_STEPS: readonly DueTrackStep[];
export const MIN_WARNING_NOTICE_DAYS = 14;
export function findDueTrackStepsDue(billDueDate: string /* 'YYYY-MM-DD' Bangkok */, nowIso: string): readonly DueTrackStep[];
export function isStatutoryWarningStepId(stepId: string): boolean;
export function hasSatisfiedWarningRequirement(
  events: ReadonlyArray<{ readonly stepId: string; readonly status: string; readonly channel: string; readonly dispatchedAt: string | null }>,
  nowIso: string,
): boolean;
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/renewals/due-track.test.ts
/**
 * 066 Round-2 §3.2 — pure due-track model.
 * - findDueTrackStepsDue: a step is due from (dueDate + offset) onward with
 *   NO staleness cutoff (spec: exempt from the 7-day catch-up lookback —
 *   fireable until sent; idempotency rows prevent re-sends).
 * - hasSatisfiedWarningRequirement: sent statutory email (due+30.email or a
 *   post-expiry t+N ≥ +7 email step) dispatched ≥ MIN_WARNING_NOTICE_DAYS ago.
 */
import { describe, it, expect } from 'vitest';
import {
  DUE_TRACK_STEPS,
  MIN_WARNING_NOTICE_DAYS,
  findDueTrackStepsDue,
  isStatutoryWarningStepId,
  hasSatisfiedWarningRequirement,
} from '@/modules/renewals/domain/due-track';

const NOW = '2026-08-15T09:00:00.000Z';

describe('findDueTrackStepsDue', () => {
  it('returns nothing before due+7', () => {
    expect(findDueTrackStepsDue('2026-08-10', NOW)).toEqual([]);
  });
  it('returns due+7 from day 7, due+30 joins from day 30', () => {
    expect(findDueTrackStepsDue('2026-08-08', NOW).map((s) => s.stepId)).toEqual(['due+7.email']);
    expect(findDueTrackStepsDue('2026-07-01', NOW).map((s) => s.stepId)).toEqual([
      'due+7.email',
      'due+30.email',
    ]);
  });
  it('has NO staleness cutoff — a bill due 300 days ago still yields both steps', () => {
    expect(findDueTrackStepsDue('2025-10-01', NOW)).toHaveLength(2);
  });
});

describe('isStatutoryWarningStepId', () => {
  it.each(['due+30.email', 't+7.email', 't+14.email', 't+30.email'])('accepts %s', (id) => {
    expect(isStatutoryWarningStepId(id)).toBe(true);
  });
  it.each(['due+7.email', 't+0.email', 't-30.email', 't+7.task.admin_notify', 'junk'])(
    'rejects %s',
    (id) => {
      expect(isStatutoryWarningStepId(id)).toBe(false);
    },
  );
});

describe('hasSatisfiedWarningRequirement', () => {
  const sent = (stepId: string, dispatchedAt: string, channel = 'email', status = 'sent') => ({
    stepId,
    status,
    channel,
    dispatchedAt,
  });
  it('satisfied by due+30.email sent 14+ days ago', () => {
    expect(
      hasSatisfiedWarningRequirement([sent('due+30.email', '2026-08-01T00:00:00.000Z')], NOW),
    ).toBe(true);
  });
  it('satisfied by a ladder t+7.email sent 14+ days ago', () => {
    expect(
      hasSatisfiedWarningRequirement([sent('t+7.email', '2026-07-01T00:00:00.000Z')], NOW),
    ).toBe(true);
  });
  it('NOT satisfied when sent < MIN_WARNING_NOTICE_DAYS ago (min-notice)', () => {
    expect(
      hasSatisfiedWarningRequirement([sent('due+30.email', '2026-08-10T00:00:00.000Z')], NOW),
    ).toBe(false);
  });
  it('NOT satisfied by failed/pending status, task channel, or non-warning steps', () => {
    expect(
      hasSatisfiedWarningRequirement(
        [
          sent('due+30.email', '2026-07-01T00:00:00.000Z', 'email', 'failed'),
          sent('t+30.task.board_escalation', '2026-07-01T00:00:00.000Z', 'task'),
          sent('due+7.email', '2026-07-01T00:00:00.000Z'),
        ],
        NOW,
      ),
    ).toBe(false);
  });
  it('NOT satisfied by a sent event with null dispatchedAt', () => {
    expect(
      hasSatisfiedWarningRequirement([{ stepId: 'due+30.email', status: 'sent', channel: 'email', dispatchedAt: null }], NOW),
    ).toBe(false);
  });
  it('sanity: DUE_TRACK_STEPS is the exact spec pair', () => {
    expect(DUE_TRACK_STEPS.map((s) => s.stepId)).toEqual(['due+7.email', 'due+30.email']);
    expect(MIN_WARNING_NOTICE_DAYS).toBe(14);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/renewals/due-track.test.ts`
Expected: FAIL — `Cannot find module '@/modules/renewals/domain/due-track'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/renewals/domain/due-track.ts
/**
 * 066 Round-2 §3.2 — the DUE-ANCHORED warning track (pure model).
 *
 * Two tier-less, CODE-DEFINED steps anchored on the member's oldest-due
 * unpaid membership bill (design §3.2(2)):
 *   due+7.email  — gentle overdue reminder
 *   due+30.email — firm warning carrying the bylaw termination sentence
 *
 * Deliberately NOT rows in `tenant_renewal_schedule_policies.steps_jsonb`:
 * policy steps are expires_at-anchored, per-tier, and admin-editable — a
 * tenant deleting a step must never be able to freeze terminations (the
 * §3.2(3) dormancy guard depends on these steps existing).
 *
 * NO staleness cutoff (unlike `findDueStepsForDate`'s 7-day
 * REMINDER_CATCH_UP_LOOKBACK_DAYS): a due step stays fireable until sent —
 * safe because (a) the (tenant, cycle, step_id, year_in_cycle) unique index
 * makes sends once-only and (b) the dormancy guard blocks termination until
 * the warning exists, so a late warning is still a pre-termination warning.
 */

export const DUE_TRACK_STEP_IDS = ['due+7.email', 'due+30.email'] as const;
export type DueTrackStepId = (typeof DUE_TRACK_STEP_IDS)[number];

export interface DueTrackStep {
  readonly stepId: DueTrackStepId;
  readonly offsetDays: 7 | 30;
}

export const DUE_TRACK_STEPS: readonly DueTrackStep[] = [
  { stepId: 'due+7.email', offsetDays: 7 },
  { stepId: 'due+30.email', offsetDays: 30 },
];

/**
 * §3.2(3) minimum notice: a due_plus_60 termination may only fire when the
 * qualifying warning was dispatched at least this many days earlier. In the
 * normal path (warning at due+30, termination after due+60) this changes
 * nothing; it only extends runway when a warning fired late.
 */
export const MIN_WARNING_NOTICE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/**
 * Steps due as of `nowIso` for a bill due on `billDueDate` (Bangkok
 * 'YYYY-MM-DD', same convention as the invoice-due-bridge). A step is due
 * from (dueDate + offset) onward — no upper bound (see staleness note).
 */
export function findDueTrackStepsDue(
  billDueDate: string,
  nowIso: string,
): readonly DueTrackStep[] {
  const dueMs = Date.parse(`${billDueDate}T00:00:00.000Z`);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(dueMs) || !Number.isFinite(nowMs)) return [];
  return DUE_TRACK_STEPS.filter(
    (s) => nowMs >= dueMs + s.offsetDays * MS_PER_DAY,
  );
}

/**
 * §3.2(3) guard acceptance set: the due-track firm warning, or any
 * post-expiry ladder EMAIL step at t+7 or later — all of those bodies carry
 * the bylaw termination warning (§5.5 / copy.ts POST-EXPIRY set). t+0 and
 * pre-due steps deliberately do NOT count (they carry no warning).
 */
export function isStatutoryWarningStepId(stepId: string): boolean {
  if (stepId === 'due+30.email') return true;
  const m = /^t\+(\d+)\.email$/.exec(stepId);
  if (!m) return false;
  const days = Number(m[1]);
  return Number.isFinite(days) && days >= 7;
}

/**
 * The dormancy-guard predicate (§3.2(3)): true iff some reminder event is a
 * SENT statutory-warning EMAIL dispatched ≥ MIN_WARNING_NOTICE_DAYS before
 * `nowIso`. Shapes match `ReminderEvent` structurally so the caller can pass
 * `reminderEventRepo.listForCycle(...)` rows straight in.
 */
export function hasSatisfiedWarningRequirement(
  events: ReadonlyArray<{
    readonly stepId: string;
    readonly status: string;
    readonly channel: string;
    readonly dispatchedAt: string | null;
  }>,
  nowIso: string,
): boolean {
  const cutoffMs = Date.parse(nowIso) - MIN_WARNING_NOTICE_DAYS * MS_PER_DAY;
  return events.some((e) => {
    if (e.status !== 'sent' || e.channel !== 'email') return false;
    if (!isStatutoryWarningStepId(e.stepId)) return false;
    if (e.dispatchedAt === null) return false;
    const sentMs = Date.parse(e.dispatchedAt);
    return Number.isFinite(sentMs) && sentMs <= cutoffMs;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/renewals/due-track.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/modules/renewals/domain/due-track.ts tests/unit/renewals/due-track.test.ts
git commit -m "feat(renewals): due-track domain model — steps, min-notice, warning predicate"
```

---

### Task 2: F-4 copy + email-gateway due-track branch

**Files:**
- Modify: `src/modules/renewals/infrastructure/email/templates/copy.ts` (add `DUE_TRACK_COPY` + `resolveDueTrackCopy`; `STATUTORY_TERMINATION_WARNING` const is at ~L142)
- Modify: `src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx` (due-track branch before the `deriveOffsetFromStepId` null-failure at ~L249-259)
- Test: `tests/unit/renewals/due-track-copy.test.ts`

**Interfaces:**
- Consumes: `DueTrackStepId` from Task 1; existing `STATUTORY_TERMINATION_WARNING: Record<RenewalEmailLocale, string>`, `RenewalEmailLocale = 'en'|'th'|'sv'`, `ReminderEmailCopy { subject; body; cta }`, `interpolateCopy`.
- Produces: `DUE_TRACK_COPY: Record<RenewalEmailLocale, Record<DueTrackStepId, ReminderEmailCopy>>`; `resolveDueTrackCopy(stepId: DueTrackStepId, locale: RenewalEmailLocale): ReminderEmailCopy`; gateway renders due-track steps without `template_variables_missing`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/renewals/due-track-copy.test.ts
/**
 * 066 Round-2 §3.2(2) — due-track copy parity + content invariants.
 * Email copy is outside check:i18n scope; this test IS the parity gate
 * (same convention as copy.test.ts / reminder-statutory-copy.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  DUE_TRACK_COPY,
  resolveDueTrackCopy,
  STATUTORY_TERMINATION_WARNING,
} from '@/modules/renewals/infrastructure/email/templates/copy';
import { DUE_TRACK_STEP_IDS } from '@/modules/renewals/domain/due-track';

const LOCALES = ['en', 'th', 'sv'] as const;

describe('DUE_TRACK_COPY', () => {
  it('has every step in every locale with non-empty subject/body/cta', () => {
    for (const locale of LOCALES) {
      for (const stepId of DUE_TRACK_STEP_IDS) {
        const c = DUE_TRACK_COPY[locale][stepId];
        expect(c.subject.length, `${locale}/${stepId} subject`).toBeGreaterThan(0);
        expect(c.body.length, `${locale}/${stepId} body`).toBeGreaterThan(0);
        expect(c.cta.length, `${locale}/${stepId} cta`).toBeGreaterThan(0);
      }
    }
  });
  it('due+30 embeds the bylaw termination warning verbatim in each locale', () => {
    for (const locale of LOCALES) {
      expect(DUE_TRACK_COPY[locale]['due+30.email'].body).toContain(
        STATUTORY_TERMINATION_WARNING[locale],
      );
    }
  });
  it('due+7 carries NO termination warning (gentle rung)', () => {
    for (const locale of LOCALES) {
      expect(DUE_TRACK_COPY[locale]['due+7.email'].body).not.toMatch(
        /bylaws|ข้อบังคับ|stadgar/i,
      );
    }
  });
  it('no body claims the membership already EXPIRED (born-awaiting expiry is ~12mo out)', () => {
    for (const locale of LOCALES) {
      for (const stepId of DUE_TRACK_STEP_IDS) {
        expect(DUE_TRACK_COPY[locale][stepId].body).not.toMatch(/expired on|หมดอายุเมื่อ|gick ut den/i);
      }
    }
  });
  it('resolveDueTrackCopy returns the locale entry (en fallback never needed — all present)', () => {
    expect(resolveDueTrackCopy('due+7.email', 'th')).toBe(DUE_TRACK_COPY.th['due+7.email']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run tests/unit/renewals/due-track-copy.test.ts` → FAIL (`DUE_TRACK_COPY` not exported).

- [ ] **Step 3: Add the copy const to `copy.ts`**

Append after the `RENEWAL_COPY` export (keep `STATUTORY_TERMINATION_WARNING` exported — export it if it is currently module-private):

```ts
// --- 066 Round-2 §3.2(2): tier-less DUE-ANCHORED overdue-invoice track ---
// NOT part of the tier×offset RENEWAL_COPY matrix: these are statutory-style
// dunning notices anchored on the BILL due date, not the cycle expiry, so the
// "expired on {expiresAt}" framing of the post-expiry bodies is wrong here
// (a born-awaiting member's expiry is ~12 months in the future).
// Parity gate: tests/unit/renewals/due-track-copy.test.ts (NOT check:i18n).
import type { DueTrackStepId } from '@/modules/renewals/domain/due-track';

export const DUE_TRACK_COPY: Record<
  RenewalEmailLocale,
  Record<DueTrackStepId, ReminderEmailCopy>
> = {
  en: {
    'due+7.email': {
      subject: 'Reminder: your SweCham membership invoice is past due',
      body: 'Hi {firstName}, our records show the membership invoice for {companyName} was due 7 days ago and remains unpaid. If you have already arranged payment, thank you — it may still be on its way to us. Otherwise, please settle the invoice at your earliest convenience to activate your membership benefits.',
      cta: 'View and pay the invoice',
    },
    'due+30.email': {
      subject: 'Important: unpaid membership invoice for {companyName}',
      body: `Hi {firstName}, the membership invoice for {companyName} is now 30 days past due and remains unpaid. ${STATUTORY_TERMINATION_WARNING.en} Please settle the invoice, or contact the chamber if you need assistance.`,
      cta: 'Pay the invoice now',
    },
  },
  th: {
    'due+7.email': {
      subject: 'แจ้งเตือน: ใบแจ้งหนี้ค่าสมาชิก SweCham เลยกำหนดชำระแล้ว',
      body: 'เรียนคุณ {firstName} ใบแจ้งหนี้ค่าสมาชิกของ {companyName} เลยกำหนดชำระมาแล้ว 7 วันและยังไม่ได้รับการชำระ หากท่านดำเนินการชำระแล้ว ขอขอบคุณ — ยอดอาจอยู่ระหว่างทาง มิฉะนั้นกรุณาชำระโดยเร็วเพื่อเปิดใช้สิทธิประโยชน์สมาชิกของท่าน',
      cta: 'ดูและชำระใบแจ้งหนี้',
    },
    'due+30.email': {
      subject: 'สำคัญ: ใบแจ้งหนี้ค่าสมาชิกของ {companyName} ค้างชำระ',
      body: `เรียนคุณ {firstName} ใบแจ้งหนี้ค่าสมาชิกของ {companyName} ค้างชำระเกินกำหนด 30 วันแล้ว ${STATUTORY_TERMINATION_WARNING.th} กรุณาชำระใบแจ้งหนี้ หรือติดต่อหอการค้าหากต้องการความช่วยเหลือ`,
      cta: 'ชำระใบแจ้งหนี้ตอนนี้',
    },
  },
  sv: {
    'due+7.email': {
      subject: 'Påminnelse: din SweCham-medlemsfaktura har förfallit',
      body: 'Hej {firstName}, medlemsfakturan för {companyName} förföll för 7 dagar sedan och är fortfarande obetald. Om du redan har ordnat betalningen — tack, den kan vara på väg. Annars ber vi dig betala fakturan snarast för att aktivera ditt medlemskaps förmåner.',
      cta: 'Visa och betala fakturan',
    },
    'due+30.email': {
      subject: 'Viktigt: obetald medlemsfaktura för {companyName}',
      body: `Hej {firstName}, medlemsfakturan för {companyName} är nu 30 dagar försenad och fortfarande obetald. ${STATUTORY_TERMINATION_WARNING.sv} Vänligen betala fakturan, eller kontakta kammaren om du behöver hjälp.`,
      cta: 'Betala fakturan nu',
    },
  },
};

/** Locale-resolved due-track copy (all locales fully populated — no fallback path). */
export function resolveDueTrackCopy(
  stepId: DueTrackStepId,
  locale: RenewalEmailLocale,
): ReminderEmailCopy {
  return DUE_TRACK_COPY[locale][stepId];
}
```

(If `STATUTORY_TERMINATION_WARNING` is not exported today, add `export` to its declaration — the reminder-statutory-copy test imports RENEWAL_COPY only, so this is additive.)

- [ ] **Step 4: Run the copy test** — `pnpm vitest run tests/unit/renewals/due-track-copy.test.ts` → PASS. Also run `pnpm vitest run tests/unit/renewals/copy.test.ts tests/unit/renewals/reminder-statutory-copy.test.ts` → PASS (no regression).

- [ ] **Step 5: Gateway branch — write the failing test**

Find the existing gateway unit test (`ls tests/unit/renewals | grep -i gateway` — e.g. `resend-transactional-renewal-gateway.test.ts`) and add:

```ts
it('renders a due-track step (due+30.email) instead of failing template_variables_missing', async () => {
  // Arrange exactly like the nearest existing sendRenewalEmail success case in
  // this file (same fake Resend client + same input fixture), but with:
  //   stepId: 'due+30.email', templateId: null
  const result = await gateway.sendRenewalEmail({
    ...baseInput,
    stepId: 'due+30.email',
    templateId: null,
  });
  expect(result.ok).toBe(true);
  const sent = fakeResend.lastSentPayload();
  expect(sent.subject).toContain('unpaid membership invoice'); // EN due+30 subject
  expect(sent.htmlOrText).toContain('bylaws'); // statutory sentence embedded
});
```

Run: FAIL with `template_variables_missing` (the `deriveOffsetFromStepId` null path at ~L249-259).

- [ ] **Step 6: Implement the gateway branch**

In `resend-transactional-renewal-gateway.tsx`, immediately **before** the `const offset = deriveOffsetFromStepId(input.stepId);` line (~L249), add:

```tsx
// 066 Round-2 §3.2(2) — DUE-TRACK branch. Due-anchored steps are tier-less
// and keyed by stepId alone; they bypass the tier×offset RENEWAL_COPY
// resolution entirely (deriveOffsetFromStepId would reject 'due+30' and
// permanently fail the send as template_variables_missing).
if (input.stepId === 'due+7.email' || input.stepId === 'due+30.email') {
  const dueCopy = resolveDueTrackCopy(input.stepId, locale);
  return sendWithCopy(dueCopy);
}
```

Where `locale` and the send mechanics reuse the function's existing locals: extract the existing "resolved copy → interpolate `{firstName}`/`{companyName}` → render `renewal-reminder-email` → Resend send → ok/err" tail into a local `sendWithCopy(copy: ReminderEmailCopy)` helper **within the same function** (pure extract-function refactor — behaviour identical for the tier path, which then also calls `sendWithCopy(existingResolvedCopy)`). Import `resolveDueTrackCopy` from the copy module. Do not touch `deriveOffsetFromStepId` / `deriveTierFromTemplateId`.

- [ ] **Step 7: Run gateway tests** — `pnpm vitest run tests/unit/renewals/<gateway-test-file>.ts` → PASS (new + all pre-existing cases).

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm typecheck
git add src/modules/renewals/infrastructure/email/templates/copy.ts src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx tests/unit/renewals/due-track-copy.test.ts tests/unit/renewals/<gateway-test-file>.ts
git commit -m "feat(renewals): due-track copy (EN/TH/SV) + tier-less email-gateway branch"
```

---

### Task 3: F-4 candidate second arm — `listDueTrackCandidates`

**Files:**
- Modify: `src/modules/renewals/application/ports/dispatch-candidate-repo.ts`
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts`
- Test: `tests/integration/renewals/due-track-candidates.integration.test.ts`

**Interfaces:**
- Consumes: existing `DispatchCandidate { cycle; member; primaryContact; schedulePolicy }`, `DispatchCandidatePage`, the F4 `invoices` table (`invoice_subject`, `status`, `due_date`, `member_id`), `MAX_INVOICE_ISSUANCE_LEAD_DAYS = 60` semantics from `lapse-cycles-on-grace-expiry.ts`.
- Produces:
```ts
export interface DueTrackCandidate extends DispatchCandidate {
  /** Oldest-due unpaid membership bill for the member, Bangkok 'YYYY-MM-DD'. */
  readonly billDueDate: string;
}
export interface DueTrackCandidatePage {
  readonly items: ReadonlyArray<DueTrackCandidate>;
  readonly nextCursor: string | null;
}
// on DispatchCandidateRepo:
listDueTrackCandidates(tenantId: string, args: { readonly pageSize: number; readonly cursor: string | null }): Promise<DueTrackCandidatePage>;
```

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/renewals/due-track-candidates.integration.test.ts
/**
 * 066 Round-2 §3.2(1) — the SECOND candidate arm (review C1).
 *
 * THE LOAD-BEARING GEOMETRY: the born-awaiting cycle's expires_at MUST be
 * set > 120 days in the future. The main dispatch arm's ±maxOffsetDays(120)
 * expires_at window hides exactly this cohort — a test with near-expiry
 * geometry would pass even if this arm were wired to the wrong query.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Use this suite's standard integration harness: copy the setup/teardown +
// row-builder helpers from tests/integration/renewals/lapse-cycles-on-grace-expiry.integration.test.ts
// (tenant fixture, member factory, cycle factory, invoice factory, cleanup).

describe('listDueTrackCandidates (live Neon)', () => {
  it('returns a born-awaiting cycle with expires_at ~12 months out + its oldest unpaid membership bill due_date', async () => {
    // Arrange: member + awaiting_payment cycle with expiresAt = now + 360d
    //          + membership invoice status='issued', due_date = today - 40d.
    // Act:     repo.listDueTrackCandidates(tenantId, { pageSize: 100, cursor: null })
    // Assert:  the cycle is in items; item.billDueDate === the invoice due_date.
  });
  it('floors: an invoice due before period_from - 60d is ignored (falls out of the arm)', async () => {
    // Arrange: awaiting cycle periodFrom = 2026-01-01; sole membership invoice
    //          due_date = 2025-09-01 (< periodFrom - 60d).
    // Assert:  cycle NOT in items (no anchorable bill — backstop cohort).
  });
  it('excludes: paid invoices, event-subject invoices, non-awaiting cycles, erased members', async () => {
    // Four arrange/assert legs, one per exclusion.
  });
  it('oldest-due wins when the member holds two unpaid membership bills', async () => {
    // due_dates D1 < D2 → billDueDate === D1.
  });
});
```

Fill the bodies concretely by mirroring the row-builder helpers already used in `tests/integration/renewals/lapse-cycles-on-grace-expiry.integration.test.ts` (same tenant fixture + factories — read that file first; it contains member/cycle/invoice creation for exactly these shapes).

- [ ] **Step 2: Run to verify it fails** — `pnpm test:integration tests/integration/renewals/due-track-candidates.integration.test.ts` → FAIL (`listDueTrackCandidates is not a function`).

- [ ] **Step 3: Add the port method** (in `dispatch-candidate-repo.ts`, after the existing `findOne`):

```ts
/**
 * 066 Round-2 §3.2(1) — SECOND candidate arm (review C1).
 *
 * Selects awaiting_payment cycles that have an unpaid (status='issued')
 * membership-subject invoice for the same member, WITH NO expires_at
 * pre-filter — a §5.3 born-awaiting cycle's expires_at is ~12 months out
 * and must not be hidden (mirror of listCyclesEligibleForLapse's
 * documented no-pre-filter precedent). The oldest-due bill's due_date is
 * threaded onto the row (batched in the query — never a per-candidate
 * bridge round-trip; the FIX-6 lesson).
 *
 * Floor: only invoices with due_date >= (period_from - 60d) anchor the
 * track — the SAME floor as the §5.2 termination clock
 * (MAX_INVOICE_ISSUANCE_LEAD_DAYS), so warning and clock can never anchor
 * on different invoices. Erased members excluded (COMP-1 H4).
 */
listDueTrackCandidates(
  tenantId: string,
  args: { readonly pageSize: number; readonly cursor: string | null },
): Promise<DueTrackCandidatePage>;
```

with the `DueTrackCandidate` / `DueTrackCandidatePage` types from the Interfaces block above.

- [ ] **Step 4: Implement in the drizzle repo**

In `drizzle-dispatch-candidate-repo.ts`, add to the returned object a `listDueTrackCandidates` sibling of `list`. Reuse `mapRow` (the projection→`DispatchCandidate` mapper) and the same JOIN set, changing only filters + one LATERAL:

```ts
async listDueTrackCandidates(
  _tenantId: string,
  args: { readonly pageSize: number; readonly cursor: string | null },
): Promise<DueTrackCandidatePage> {
  return runInTenant(tenant, async (tx) => {
    // Keyset cursor on (cycle_id) alone — this arm has no expires_at sort
    // dimension; cycle_id is unique and stable.
    const filters: SQL[] = [
      sql`${renewalCycles.status} = 'awaiting_payment'`,
      sql`${members.erasedAt} IS NULL`,
    ];
    if (args.cursor) {
      filters.push(sql`${renewalCycles.cycleId} > ${args.cursor}`);
    }
    // LATERAL: oldest-due unpaid membership bill, floored at
    // period_from - 60 days (MAX_INVOICE_ISSUANCE_LEAD_DAYS — keep the
    // literal in ONE place: import the constant if exported, else define a
    // local const with a comment pointing at lapse-cycles-on-grace-expiry).
    const oldestBill = sql<string>`
      (SELECT MIN(inv.due_date)
         FROM invoices inv
        WHERE inv.tenant_id = ${renewalCycles.tenantId}
          AND inv.member_id = ${renewalCycles.memberId}
          AND inv.invoice_subject = 'membership'
          AND inv.status = 'issued'
          AND inv.due_date >= (${renewalCycles.periodFrom}::date - INTERVAL '60 days'))`;
    const rows = await tx
      .select({ ...dispatchCandidateProjection, billDueDate: oldestBill.as('bill_due_date') })
      .from(renewalCycles)
      /* same INNER JOIN members + LEFT JOIN primary-contact LATERAL +
         LEFT JOIN schedule-policy chain as list() — copy it verbatim */
      .where(and(...filters))
      .orderBy(renewalCycles.cycleId)
      .limit(args.pageSize + 1);
    const page = rows.slice(0, args.pageSize);
    const items = page
      .filter((r) => r.billDueDate !== null) // no anchorable bill → backstop cohort, not this arm
      .map((r) => ({ ...mapRow(r), billDueDate: String(r.billDueDate) }));
    return {
      items,
      nextCursor: rows.length > args.pageSize ? String(page[page.length - 1]!.cycleId) : null,
    };
  });
}
```

Adapt identifier names to the file's actual local names (`dispatchCandidateProjection`, `mapRow`, table objects) — they exist per the current file; keep the WHERE-filtering semantics exactly as above. If the `invoices` drizzle table object isn't imported in this file yet, import it from the F4 schema module the invoice-due-bridge adapter uses (`src/modules/renewals/infrastructure/ports-adapters/invoice-due-bridge-drizzle.ts` shows the import path).

- [ ] **Step 5: Run the integration test** — `pnpm test:integration tests/integration/renewals/due-track-candidates.integration.test.ts` → PASS (all 4 cases).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/modules/renewals/application/ports/dispatch-candidate-repo.ts src/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo.ts tests/integration/renewals/due-track-candidates.integration.test.ts
git commit -m "feat(renewals): due-track candidate arm — no expires_at pre-filter, batched bill due_date"
```

---

### Task 4: F-4 due-track dispatch pass + t+N suppression

**Files:**
- Create: `src/modules/renewals/application/use-cases/_lib/dispatch-due-track.ts`
- Modify: `src/modules/renewals/application/use-cases/dispatch-renewal-cycle.ts` (due-track pass before the main pass; summary counters)
- Modify: `src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts` (suppression: `DispatchContext` gains `dueTrackCycleIds: ReadonlySet<string>`; the V12 windowSteps arm filters out **email**-channel steps for cycles in that set)
- Test: `tests/integration/renewals/due-track-dispatch.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 (`findDueTrackStepsDue`), Task 2 (gateway renders due steps), Task 3 (`listDueTrackCandidates` / `DueTrackCandidate`); existing `reminderEventRepo.insertIfAbsent` + `transitionStatus`, `renewalGateway.sendRenewalEmail`, `auditEmitter`, `computeYearInCycle`, skip-reason vocabulary from `dispatch-one-cycle.ts`.
- Produces: `dispatchDueTrackCycle(deps, candidate: DueTrackCandidate, ctx): Promise<DispatchOneCycleOutcome>`; `DispatchContext.dueTrackCycleIds`; summary fields `dueTrackEmailsSent: number`, due-track skips folded into the existing `skipped: Record<SkipReason, number>`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/renewals/due-track-dispatch.integration.test.ts
/**
 * 066 Round-2 §3.2(2) — due-track dispatch invariants (live Neon).
 * Geometry rule: every born-awaiting cycle here uses expiresAt > 120d out.
 */
describe('due-track dispatch (live Neon)', () => {
  it('born-awaiting cycle past due+7: sends due+7.email once (idempotent on second run)', async () => {
    // Arrange candidate (expiresAt = +360d; bill due = today-10d).
    // Run dispatchRenewalCycle twice.
    // Assert: exactly ONE renewal_reminder_events row (step_id='due+7.email',
    //         status='sent'); second run outcome counts skipped.already_sent.
  });
  it('past due+30: both steps recorded; due+30 body carried the statutory copy', async () => {
    // bill due = today-35d → due+7.email + due+30.email rows both sent.
  });
  it('opt-out member STILL gets due-track warnings (contractual-notice bypass)', async () => {
    // member.renewalRemindersOptedOut = true → due+7.email still sent.
  });
  it('email_unverified member is skipped (no send, no sent row)', async () => {});
  it('suppression: an awaiting cycle WITH a bill gets NO t+N ladder emails from the main pass', async () => {
    // Arrange a renewer-shaped cycle inside the ±120d window (expiresAt =
    // today-7d) WITH an unpaid bill due ≈ expiry → main-pass t+7.email must
    // NOT fire; due-track fires instead. Task-channel steps still allowed.
  });
  it('no-bill awaiting cycle keeps the existing t+N ladder (backstop cohort unchanged)', async () => {});
  it('year-boundary: cycle stuck awaiting >365d mints no duplicate warnings', async () => {
    // periodFrom = now-400d; bill due = now-380d. Run dispatch twice →
    // still exactly one row per step (year_in_cycle computed from the
    // step's due-day, not the run date).
  });
});
```

Flesh out with the same harness/factories as Task 3's test file.

- [ ] **Step 2: Run to verify it fails** — `pnpm test:integration tests/integration/renewals/due-track-dispatch.integration.test.ts` → FAIL (no due-track pass exists).

- [ ] **Step 3: Implement `dispatch-due-track.ts`**

```ts
// src/modules/renewals/application/use-cases/_lib/dispatch-due-track.ts
/**
 * 066 Round-2 §3.2(2) — per-cycle DUE-TRACK dispatch.
 *
 * A deliberately thin sibling of dispatchOneCycle for the two code-const
 * due-anchored steps. Reuses the same primitives (insertIfAbsent →
 * gateway send → transitionStatus → audit) and the same idempotency index.
 *
 * Gate differences vs the ladder (each is a spec decision, §3.2(2)):
 *  - renewalRemindersOptedOut is BYPASSED — these are contractual/bylaw
 *    dunning notices, not marketing (FR-016 scope).
 *  - NO staleness window — steps stay fireable until sent.
 *  - Tier-less copy via the gateway's due-track branch (templateId null).
 * Gates kept: feature flag / read-only (checked by the caller once per
 * run), cycle re-check (status must still be awaiting_payment),
 * member archived, email_unverified, no_primary_contact.
 */
import { findDueTrackStepsDue } from '@/modules/renewals/domain/due-track';
import { computeYearInCycle } from /* same module dispatch-one-cycle imports it from */;

export async function dispatchDueTrackCycle(
  deps: RenewalsDeps,
  candidate: DueTrackCandidate,
  ctx: DispatchContext,
): Promise<readonly DispatchOneCycleOutcome[]> {
  const { cycle, member, primaryContact } = candidate;
  if (cycle.status !== 'awaiting_payment') return [{ kind: 'skipped', reason: 'cycle_terminal' }];
  if (member.status === 'archived') return [{ kind: 'skipped', reason: 'member_archived' }];
  if (member.emailUnverified) return [{ kind: 'skipped', reason: 'email_unverified' }];
  if (!primaryContact) return [{ kind: 'skipped', reason: 'no_primary_contact' }];
  // NOTE deliberately NO member.renewalRemindersOptedOut check (see docblock).

  const dueSteps = findDueTrackStepsDue(candidate.billDueDate, ctx.nowIso);
  if (dueSteps.length === 0) return [{ kind: 'skipped', reason: 'not_due_today' }];

  const outcomes: DispatchOneCycleOutcome[] = [];
  for (const step of dueSteps) {
    // Idempotency year = the step's own due-day year (066 §3.2(2); the 063 #1
    // duplicate-send lesson) — stable across run dates and year boundaries.
    const stepDueIso = new Date(
      Date.parse(`${candidate.billDueDate}T00:00:00.000Z`) + step.offsetDays * 86_400_000,
    ).toISOString();
    const yearInCycle = computeYearInCycle(cycle.periodFrom, stepDueIso);
    const inserted = await deps.reminderEventRepo /* same tx/no-tx calling shape
      dispatchOneCycle uses for its Gate-12 insertIfAbsent — mirror it */
      .insertIfAbsent(/* … */ {
        tenantId: ctx.tenantId,
        cycleId: cycle.cycleId,
        stepId: step.stepId,
        channel: 'email',
        templateId: null,
        yearInCycle,
        actorUserId: ctx.actorUserId,
      });
    if (!inserted.created) {
      outcomes.push({ kind: 'skipped', reason: 'already_sent', metadata: { existing_reminder_event_id: inserted.row.reminderEventId } });
      continue;
    }
    const sendResult = await deps.renewalGateway.sendRenewalEmail({
      /* mirror dispatchOneCycle's email-send input assembly (recipient from
         primaryContact, locale from member.preferredLocale, cycle fields),
         with: stepId: step.stepId, templateId: null */
    });
    // transition sent/failed + audit renewal_reminder_sent — mirror
    // dispatchOneCycle's post-send block verbatim (same repo transition +
    // same audit event/payload shape, stepId being the only difference).
    outcomes.push(/* 'sent' | 'failed_transient' outcome mirroring that block */);
  }
  return outcomes;
}
```

The `/* mirror … */` blocks are **explicit instructions to copy the exact corresponding block from `dispatch-one-cycle.ts`** (Gate 12 insert call shape ~L999-1021; the email-send input assembly ~L1213; the post-send transition+audit tail) — same collaborators, same payloads, only `stepId`/`templateId` differ. Do not invent new shapes.

- [ ] **Step 4: Wire the pass into `dispatch-renewal-cycle.ts`**

Before the existing main `dispatchCandidateRepo.list` paging loop:

```ts
// 066 §3.2 — DUE-TRACK pass (runs FIRST so the suppression set exists
// before the main ladder pass).
const dueTrackCycleIds = new Set<string>();
let dueTrackEmailsSent = 0;
{
  let cursor: string | null = null;
  do {
    const page = await deps.dispatchCandidateRepo.listDueTrackCandidates(input.tenantId, {
      pageSize: 200,
      cursor,
    });
    for (const candidate of page.items) {
      dueTrackCycleIds.add(candidate.cycle.cycleId);
      const outcomes = await dispatchDueTrackCycle(deps, candidate, ctx);
      for (const o of outcomes) {
        if (o.kind === 'sent') dueTrackEmailsSent += 1;
        else if (o.kind === 'skipped') summary.skipped[o.reason] = (summary.skipped[o.reason] ?? 0) + 1;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
}
const ctxWithDueTrack = { ...ctx, dueTrackCycleIds };
// …existing main pass, now passing ctxWithDueTrack to dispatchOneCycle…
```

Add `dueTrackEmailsSent` to the summary type + JSON. Match the chunked-concurrency style of the main loop if trivially applicable; sequential is acceptable at ~110 members.

- [ ] **Step 5: Suppression in `dispatch-one-cycle.ts`**

Add `readonly dueTrackCycleIds: ReadonlySet<string>;` to `DispatchContext` (~L113-137; update all constructors of the context — grep `unreconciledMemberIds` for every site). Then extend the V12 arm (~L533-536):

```ts
const windowSteps =
  cycle.status === 'awaiting_payment'
    ? allWindowSteps.filter(
        (s) =>
          s.offsetDays >= 0 &&
          // 066 §3.2(2) track precedence: a cycle on the due-anchored track
          // (has an unpaid membership bill) gets NO expires_at-anchored t+N
          // EMAILS — the due track is its dunning channel. Task-channel
          // steps (admin/ED escalations) still run.
          !(ctx.dueTrackCycleIds.has(cycle.cycleId) && s.channel === 'email'),
      )
    : allWindowSteps;
```

- [ ] **Step 6: Run the integration test** — `pnpm test:integration tests/integration/renewals/due-track-dispatch.integration.test.ts` → PASS (all 7). Also re-run the existing dispatch suite: `pnpm test:integration tests/integration/renewals/dispatch-renewal-cycle.integration.test.ts` (exact filename per `ls tests/integration/renewals`) → PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm typecheck
git add src/modules/renewals/application/use-cases/_lib/dispatch-due-track.ts src/modules/renewals/application/use-cases/dispatch-renewal-cycle.ts src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts tests/integration/renewals/due-track-dispatch.integration.test.ts
git commit -m "feat(renewals): due-track dispatch pass + t+N email suppression (066 §3.2)"
```

---

### Task 5: F-4 dormancy guard at the terminate boundary

**Files:**
- Modify: `src/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry.ts`
- Modify: `src/lib/metrics.ts` (extend `lapseDeferred` reason union at ~L2678-2696)
- Modify: `src/app/api/cron/renewals/lapse-cycles-on-grace-expiry/[tenantId]/route.ts` (JSON counter + escalation creation) and `.../lapse-cycles-on-grace-expiry-coordinator/route.ts` (`PerTenantResult` + `numFromJson`)
- Modify: the E2E sum-invariant spec that asserts the lapse-route JSON counters (grep `deferred_no_invoice_backstop` under `tests/e2e/` for the file)
- Test: `tests/integration/renewals/lapse-dormancy-guard.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `hasSatisfiedWarningRequirement`; existing `reminderEventRepo.listForCycle(tenantId, cycleId)`; `createEscalationTask` use-case; `ProcessOneOutcome` union + counter switch (~L331-357); `LapseCyclesOnGraceExpiryDeps` Pick (~L204-219).
- Produces: new outcome `'deferred_no_prior_warning'`; output fields `deferredNoPriorWarning: number` + `deferredNoPriorWarningCycles: ReadonlyArray<{ cycleId: string; memberId: string }>`; metric reason `'no_prior_warning'`; route JSON key `deferred_no_prior_warning`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/renewals/lapse-dormancy-guard.integration.test.ts
/**
 * 066 Round-2 §3.2(3) — "never terminate someone the system never warned"
 * (permanent invariant, due_plus_60 basis only).
 * Geometry: born-awaiting cycles use expiresAt > 120d out (review C1).
 */
describe('lapse dormancy guard (live Neon)', () => {
  it('DEFERS due_plus_60 termination when no statutory warning was ever sent', async () => {
    // awaiting cycle, bill due = today-70d, NO reminder events.
    // → outcome deferred; cycle still awaiting_payment;
    //   output.deferredNoPriorWarning === 1 and the cycle listed in
    //   output.deferredNoPriorWarningCycles.
  });
  it('TERMINATES once due+30.email was sent ≥14d ago and today > due+60', async () => {
    // seed a sent renewal_reminder_events row (step_id='due+30.email',
    // dispatched_at = today-20d) → cycle transitions to lapsed,
    // closed_reason grace_expired, audit renewal_lapsed carries
    // termination_basis 'due_plus_60'.
  });
  it('accepts a ladder t+7.email warning in lieu of due+30.email', async () => {});
  it('min-notice: due+30.email sent 5d ago → still deferred', async () => {});
  it('no_invoice_backstop basis is NOT guarded (terminates without due-track rows)', async () => {
    // never-invoiced awaiting cycle past expires_at+grace → lapses as today.
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm test:integration tests/integration/renewals/lapse-dormancy-guard.integration.test.ts` → the defer case FAILS (cycle gets terminated).

- [ ] **Step 3: Implement the guard**

In `lapse-cycles-on-grace-expiry.ts`:

1. Widen the deps Pick (~L204-219): `Pick<RenewalsDeps, 'tenant' | 'cyclesRepo' | 'auditEmitter' | 'tenantRenewalSettingsRepo' | 'reminderEventRepo'>` (the runtime object from `makeRenewalsDeps` already carries it).
2. Add `'deferred_no_prior_warning'` to `ProcessOneOutcome` (~L393-400) — the exhaustive counter `switch` (~L331-357) will force the new arm; also add the output fields and a `deferredNoPriorWarningCycles` accumulator array.
3. In the `due_plus_60` decision block (~L504-590), directly **after** the 059 shield check and **before** `terminationBasis = 'due_plus_60';`:

```ts
// 066 §3.2(3) DORMANCY GUARD — never terminate on due_plus_60 without a
// sent statutory warning + MIN_WARNING_NOTICE_DAYS of runway. Fail-safe
// direction only (defer = stays suspended). The no_invoice_backstop
// branch is deliberately unguarded: those cycles have no bill, and the
// expires_at t+N ladder warns them inside the candidate window before
// the backstop terminates.
const reminderEvents = await deps.reminderEventRepo.listForCycle(
  tenantId,
  cycle.cycleId,
);
if (!hasSatisfiedWarningRequirement(reminderEvents, clock.now.toISOString())) {
  renewalsMetrics.lapseDeferred.add(1, {
    tenant_id: tenantId,
    reason: 'no_prior_warning',
  });
  deferredNoPriorWarningCycles.push({ cycleId: cycle.cycleId, memberId: cycle.memberId });
  return 'deferred_no_prior_warning';
}
terminationBasis = 'due_plus_60';
```

(`hasSatisfiedWarningRequirement` import from `../../../domain/due-track` — adjust relative path; `ReminderEvent` rows structurally satisfy the predicate's parameter shape.)
4. `src/lib/metrics.ts` — extend the label union: `reason: 'invoice_not_due' | 'within_termination_window' | 'no_invoice_backstop' | 'no_prior_warning';`.

- [ ] **Step 4: Route + coordinator + escalation**

In the per-tenant route (`[tenantId]/route.ts`), add `deferred_no_prior_warning: output.deferredNoPriorWarning` to the success JSON (~L120-139), and after the use-case returns, create the admin-visible escalation (idempotent — the open-status unique index absorbs daily re-runs):

```ts
// 066 §3.2(3) — the structurally-unwarnable cohort must be ADMIN-visible,
// not just an SRE counter. createEscalationTask handles tx + audit; the
// (tenant, member, cycle, task_type) WHERE status='open' unique index makes
// this a no-op on every subsequent daily run.
for (const d of output.deferredNoPriorWarningCycles) {
  await createEscalationTask(deps, {
    tenantId,
    memberId: d.memberId,
    cycleId: d.cycleId,
    taskType: 'termination_warning_blocked',
    assignedToRole: 'admin',
    dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    triggerReason: 'scheduled_cron_step',
    actorUserId: null,
    actorRole: 'cron',
    correlationId,
    summary: 'due+60 termination deferred — member has never received a statutory warning (blocked warning channel)',
  });
}
```

(Use the existing `triggerReason: 'scheduled_cron_step'` enum value — no zod change needed. `taskType` is a free 1-100-char string; add the `admin.renewals.tasks.taskType.termination_warning_blocked` label to en/th/sv alongside the existing taskType labels, e.g. next to `manual_outreach_required` at en.json ~L3650.)
In the coordinator: add `deferred_no_prior_warning?: number` to `PerTenantResult` (~L38-56) + the `numFromJson` mapping (~L184-199).
In the E2E sum-invariant spec: add the new key to the asserted counter set.

- [ ] **Step 5: Run tests**

```bash
pnpm test:integration tests/integration/renewals/lapse-dormancy-guard.integration.test.ts   # PASS (5 cases)
pnpm test:integration tests/integration/renewals/lapse-cycles-on-grace-expiry.integration.test.ts  # PASS — no regression
pnpm vitest run tests/unit/renewals  # unit sweep for touched modules
```

Note: pre-existing lapse tests that terminate on `due_plus_60` must now seed a qualifying warning row (sent ≥14d ago) — update those arrange blocks; that is the invariant working, not a regression. Keep each updated test's intent identical.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry.ts src/lib/metrics.ts "src/app/api/cron/renewals/lapse-cycles-on-grace-expiry/[tenantId]/route.ts" src/app/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator/route.ts src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/integration/renewals/lapse-dormancy-guard.integration.test.ts <updated-e2e-spec> <updated-lapse-tests>
git commit -m "feat(renewals): dormancy guard — no due+60 termination without a sent statutory warning"
```

---

### Task 6: F-5 audit event `payment_on_terminated_member` (enum lockstep + 10y retention)

**Files:**
- Create: `drizzle/migrations/0249_payment_on_terminated_member.sql` (**verify next free number first**: `ls drizzle/migrations | sort | tail -3`; if `main` moved, renumber)
- Modify: `src/modules/renewals/application/ports/renewal-audit-emitter.ts` (tuple + count 69→70 + payload shape)
- Modify: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts` (`F8_ENUM_SHIPPED_TUPLE` + per-event retention override)
- Modify: `src/modules/auth/infrastructure/db/schema.ts` (`DB_ONLY_AUDIT_EVENT_TYPES`)
- Modify: `scripts/lib/enum-migration-guard.ts` (`REQUIRED_ENUM_VALUES` — per the 0246/0247 migration-header checklist)
- Modify: `src/i18n/messages/{en,th,sv}.json` (`audit.eventType.payment_on_terminated_member`)
- Modify tests: `tests/unit/renewals/application/ports.test.ts` (L63: 69→70), `tests/contract/renewals-audit-port.contract.test.ts` (L73: 69→70 + canonical-payload case)

- [ ] **Step 1: Migration file**

```sql
-- 066-renewal-swecham-round2 §4.4(2)/§6 — audit_event_type extension (1 value).
-- Lockstep registration (all updated in this commit):
--   renewal-audit-emitter.ts F8_AUDIT_EVENT_TYPES (69→70) + payload shape
--   drizzle-renewal-audit-emitter.ts F8_ENUM_SHIPPED_TUPLE + retention override (10y)
--   auth schema DB_ONLY_AUDIT_EVENT_TYPES
--   scripts/lib/enum-migration-guard.ts REQUIRED_ENUM_VALUES
--   audit.eventType label in en/th/sv (label-coverage guard parses this file)
--   ports.test.ts + renewals-audit-port.contract.test.ts counts
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'payment_on_terminated_member';
```

- [ ] **Step 2: Update both count tests to 70 first + run to verify they fail** — `pnpm vitest run tests/unit/renewals/application/ports.test.ts tests/contract/renewals-audit-port.contract.test.ts` → FAIL (tuple still 69). Add the contract file's canonical-payload case (mirror the `renewal_lapse_deferred_invoice_not_due` case at ~L225-237) with payload:

```ts
{
  invoice_id: 'inv-1', member_id: 'mem-1', cycle_id: null,
  amount_satang: '1070000', payment_method: 'stripe_card',
  triggered_by: 'webhook', paid_at: '2026-08-01T00:00:00.000Z',
  heal_site: 'terminal_only',
}
```

- [ ] **Step 3: Register the event**

1. `renewal-audit-emitter.ts`: add `'payment_on_terminated_member'` to `F8_AUDIT_EVENT_TYPES` (grouped with the other lapse/termination events); bump `_AssertF8AuditEventCount` 69→70 (+ its message); add to `F8AuditPayloadShapes`:

```ts
payment_on_terminated_member: {
  /** Real F4InvoicePaidEvent fields only — the event carries NO processor
   *  payment reference by design; payment_method + triggered_by
   *  distinguish the rails (design §4.4(2)). */
  readonly invoice_id: string;
  readonly member_id: string;
  /** Lapsed cycle id when the payment arrived on a LINKED invoice
   *  (mark-cycle-complete site); null on the unlinked terminal_only site. */
  readonly cycle_id: string | null;
  readonly amount_satang: string;
  readonly payment_method: string;
  readonly triggered_by: string;
  readonly paid_at: string;
  readonly heal_site: 'terminal_only' | 'linked_terminal_skip';
};
```

2. `drizzle-renewal-audit-emitter.ts`: add to `F8_ENUM_SHIPPED_TUPLE` (emit sites ship in Task 7-9 of this same branch). Retention override — `buildInsertValues` (~L376-393) currently writes no `retention_years` (DB default 5). Add:

```ts
// 066 §6 — tax-evidence class: this event is the explanatory trail for an
// anomalous §86/4 receipt (minted to a terminated member), same rationale
// as the 0039 F4 10-year backfill (Thai RD §87/3). All other F8 events
// stay on the 5y default.
const F8_RETENTION_OVERRIDES: Partial<Record<F8AuditEventType, 5 | 10>> = {
  payment_on_terminated_member: 10,
};
```

and in `buildInsertValues` add `retentionYears: F8_RETENTION_OVERRIDES[event.type] ?? undefined` mapped onto the insert row's `retention_years` column (omit/undefined → DB default; verify the drizzle column name in the audit_log schema).
3. Auth schema `DB_ONLY_AUDIT_EVENT_TYPES`: add the literal (alphabetical slot near the other renewals/membership entries at ~L399-416).
4. `scripts/lib/enum-migration-guard.ts` `REQUIRED_ENUM_VALUES`: add it.
5. i18n labels: `"payment_on_terminated_member": "Payment received on a terminated membership"` (EN); TH `"รับชำระเงินจากสมาชิกภาพที่ถูกยุติแล้ว"`; SV `"Betalning mottagen för avslutat medlemskap"` — in each file's `audit.eventType` map.

- [ ] **Step 4: Apply the migration + run gates (BEFORE committing — F4 R8 gotcha)**

```bash
pnpm db:migrate
pnpm vitest run tests/unit/renewals/application/ports.test.ts tests/contract/renewals-audit-port.contract.test.ts tests/unit/insights/audit-event-label-coverage.test.ts
pnpm check:i18n
```

Expected: all PASS. If an audit-parity integration test exists (`pnpm check:audit-events` / `check:audit-counts`), run those too.

- [ ] **Step 5: Commit**

```bash
git add drizzle/migrations/0249_payment_on_terminated_member.sql src/modules/renewals/application/ports/renewal-audit-emitter.ts src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts src/modules/auth/infrastructure/db/schema.ts scripts/lib/enum-migration-guard.ts src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/unit/renewals/application/ports.test.ts tests/contract/renewals-audit-port.contract.test.ts
git commit -m "feat(renewals): payment_on_terminated_member audit event — 4-places lockstep, 10y retention"
```

---

### Task 7: F-5 invoicing-owned membership-access port + bridge (4th copy)

**Files:**
- Create: `src/modules/invoicing/application/ports/membership-access-port.ts`
- Create: `src/modules/invoicing/infrastructure/membership-access-bridge.ts`
- Test: `tests/unit/invoicing/membership-access-bridge.test.ts` + `tests/integration/invoicing/membership-access-cross-tenant.integration.test.ts`

**Interfaces (Produces):** identical shape to the F3 exemplar —

```ts
export interface MembershipAccessSummary { readonly access: 'full' | 'suspended' | 'terminated'; readonly reason: MembershipAccessReason; }
export interface MembershipAccessLookupError { readonly kind: 'membership_access.lookup_error'; }
export interface MembershipAccessPort {
  getMembershipAccess(tenant: TenantContext, memberId: string): Promise<Result<MembershipAccessSummary, MembershipAccessLookupError>>;
}
export const membershipAccessBridge: MembershipAccessPort;
```

- [ ] **Step 1: Copy the F3 exemplar files** — port from `src/modules/members/application/ports/membership-access-port.ts`, bridge from `src/modules/members/infrastructure/membership-access-bridge.ts` (both verbatim, changing only the module-local import path of the port). Keep the bridge's docblock and **add** the invoicing-specific justification header:

```ts
/**
 * 066 Round-2 §4.4(1)/§7 — invoicing-owned membership-access bridge (4th
 * copy of the consumer-owns-port pattern; F3/F6/F7 precedents).
 *
 * Deep-imports the renewals LEAF repo factory (makeDrizzleRenewalCycleRepo)
 * rather than makeRenewalsDeps — the documented escape hatch every existing
 * bridge uses (avoids wiring ~20 adapters + an import cycle). Declared in
 * the plan's Constitution Check as the pre-approved Principle III deviation.
 *
 * FAIL-OPEN consumer note: recordPayment treats a lookup error as
 * access='full' (availability of the money path beats the gate; the
 * §4.4(2) heal-site audit net is the backstop) — the F6 events precedent,
 * NOT the F3/F7 fail-closed one. The fail-open decision lives in the
 * CONSUMER (record-payment.ts), not here: this bridge just reports err.
 */
```

- [ ] **Step 2: Unit test**

```ts
// tests/unit/invoicing/membership-access-bridge.test.ts
// Mock makeDrizzleRenewalCycleRepo (vi.mock the leaf module) →
//  - lapsed latest cycle  → { access: 'terminated', reason: 'grace_expired' }
//  - null latest cycle    → { access: 'full', reason: 'in_good_standing' }
//  - repo throws          → err({ kind: 'membership_access.lookup_error' })
```

Write the three cases with real asserts (mirror the F3 bridge's own unit test if one exists — `ls tests/unit/members | grep -i access` — else assemble from the mock shapes above). Run → PASS.

- [ ] **Step 3: Cross-tenant integration test (Principle I Review-Gate blocker)**

```ts
// tests/integration/invoicing/membership-access-cross-tenant.integration.test.ts
// Tenant A: member with a lapsed cycle. Tenant B context querying the SAME
// memberId must NOT see A's cycle (RLS) → derives null-cycle → access 'full'.
// Assert also that tenant A context sees 'terminated' (positive control).
```

Run: `pnpm test:integration tests/integration/invoicing/membership-access-cross-tenant.integration.test.ts` → PASS.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add src/modules/invoicing/application/ports/membership-access-port.ts src/modules/invoicing/infrastructure/membership-access-bridge.ts tests/unit/invoicing/membership-access-bridge.test.ts tests/integration/invoicing/membership-access-cross-tenant.integration.test.ts
git commit -m "feat(invoicing): membership-access port + bridge (4th consumer-owns-port copy)"
```

---

### Task 8: F-5 gate the F4 record-payment rail

**Files:**
- Modify: `src/modules/invoicing/application/use-cases/record-payment.ts` (error union ~L135; deps ~L195; gate after invoice load, before the tx)
- Modify: the composition root that builds `RecordPaymentDeps` (grep `makeRecordPaymentDeps`) — wire `membershipAccess: membershipAccessBridge`
- Modify: `src/app/api/invoices/[invoiceId]/pay/route.ts` (error→HTTP map: `membership_terminated` → 409)
- Modify: `src/app/(staff)/admin/invoices/_components/record-payment-error-routing.ts` (+ `DEDICATED_MESSAGE_CODES`)
- Modify: `src/i18n/messages/{en,th,sv}.json` (admin invoices `errors.membership_terminated`)
- Test: `tests/integration/invoicing/record-payment-terminated-gate.integration.test.ts` + extend the record-payment unit suite

**Interfaces:**
- Consumes: Task 7 `MembershipAccessPort` / `membershipAccessBridge`; existing `RecordPaymentError`, `RecordPaymentDeps`, `input.triggeredBy` (`'webhook' | 'admin_manual' | 'admin_offline_mark'`, defaulting `admin_manual` at ~L1155), the loaded invoice's `invoiceSubject` + `memberId`.
- Produces: `RecordPaymentError` arm `{ code: 'membership_terminated' }`; deps field `readonly membershipAccess: MembershipAccessPort;`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/invoicing/record-payment-terminated-gate.integration.test.ts
/**
 * 066 Round-2 §4.4(1) (review C3/C4) — the F4 record-payment rail gate.
 * Matrix (subject × trigger × access):
 *   membership + admin_manual + terminated  → err membership_terminated, NO §87 alloc, invoice stays issued
 *   membership + webhook       + terminated → PASSES (money already captured — never wedge the webhook)
 *   membership + admin_manual + suspended   → passes (awaiting_payment member)
 *   membership + admin_manual + no cycle    → passes (imported cohort)
 *   event      + admin_manual + terminated  → passes (subject out of scope)
 */
```

Arrange each leg with a real tenant/member/cycle/invoice via the F4 integration harness (mirror `tests/integration/invoicing/record-payment*.integration.test.ts` setup — read the nearest existing file for the factories + deps assembly; inject the real bridge for live legs). Run → FAIL (`membership_terminated` never returned).

- [ ] **Step 2: Implement the gate**

1. Error union (~L179, after `new_flow_bill_requires_flag_on`):

```ts
  /**
   * 066 Round-2 §4.4(1) — the member's membership is TERMINATED (latest
   * renewal cycle lapsed/expired-cancelled). Admin-manual membership-bill
   * payments are refused so no charge and no §86/4 receipt reaches a
   * non-member; comeback = Renew Lapsed Member → pay the NEW invoice →
   * void this bill. NEVER returned on the webhook path (money already
   * captured at Stripe — rejecting would wedge the retrying webhook; the
   * heal-site audit net is that rail's control).
   */
  | { code: 'membership_terminated' }
```

2. Deps (~L195): `readonly membershipAccess: MembershipAccessPort;` (+ import). Wire `membershipAccess: membershipAccessBridge` in `makeRecordPaymentDeps`.
3. Gate — place it where the loaded invoice (subject + memberId) is known and **before** the `withTx`/sequence allocation (the same pre-tx zone as the settings load; locate the point after the invoice load resolves `loaded`):

```ts
// 066 §4.4(1) — terminated-membership gate (admin-manual rails only).
const eventTrigger = input.triggeredBy ?? 'admin_manual';
if (
  loaded.invoiceSubject === 'membership' &&
  eventTrigger !== 'webhook' &&
  loaded.memberId !== null
) {
  const access = await deps.membershipAccess.getMembershipAccess(tenant, loaded.memberId);
  // FAIL-OPEN on lookup error: availability of the money path beats the
  // gate; the §4.4(2) heal-site net is the backstop (F6 precedent).
  if (access.ok && access.value.access === 'terminated') {
    return err({ code: 'membership_terminated' });
  }
  if (!access.ok) {
    logger.warn(
      { invoiceId, memberId: loaded.memberId },
      '[record-payment] membership-access lookup failed — failing OPEN (gate skipped)',
    );
  }
}
```

Adapt `tenant` to however the use-case reaches its `TenantContext` (the settings repo call in the same zone shows the pattern); reuse the file's `logger`. **Note the trigger predicate is `!== 'webhook'`** — it also covers `admin_offline_mark` (harmless double gate: mark-paid-offline already rejects lapsed cycles upstream).
4. Route map (`/api/invoices/[invoiceId]/pay/route.ts`): add `case 'membership_terminated': return 409` beside the existing 409 codes, surfacing `{ error: { code: 'membership_terminated' } }` in the body per the route's envelope.
5. `record-payment-error-routing.ts`: add `'membership_terminated'` to `DEDICATED_MESSAGE_CODES` (→ `messageKey: 'errors.membership_terminated'`).
6. i18n (admin invoices errors map — same namespace as `errors.legacy_invoice_needs_reissue`):
   - EN: `"membership_terminated": "This member's membership has been terminated — use Renew Lapsed Member to reactivate and re-invoice, then record the payment against the new invoice, and void this old bill."`
   - TH: `"membership_terminated": "สมาชิกภาพของสมาชิกรายนี้ถูกยุติแล้ว — ใช้เมนู Renew Lapsed Member เพื่อคืนสถานะและออกใบแจ้งหนี้ใหม่ จากนั้นบันทึกการชำระเงินกับใบแจ้งหนี้ใบใหม่ และยกเลิก (void) บิลเก่าใบนี้"`
   - SV: `"membership_terminated": "Medlemmens medlemskap har avslutats — använd Renew Lapsed Member för att återaktivera och fakturera på nytt, registrera sedan betalningen mot den nya fakturan och makulera denna gamla faktura."`

- [ ] **Step 3: Run tests**

```bash
pnpm test:integration tests/integration/invoicing/record-payment-terminated-gate.integration.test.ts  # PASS (5 legs)
pnpm vitest run tests/unit/invoicing  # record-payment unit suite — fix any deps-shape breakage by adding a stub membershipAccess: { getMembershipAccess: async () => ok({ access: 'full', reason: 'in_good_standing' }) } to test fixtures
pnpm check:i18n
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add src/modules/invoicing/application/use-cases/record-payment.ts <composition-root-file> "src/app/api/invoices/[invoiceId]/pay/route.ts" src/app/(staff)/admin/invoices/_components/record-payment-error-routing.ts src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/integration/invoicing/record-payment-terminated-gate.integration.test.ts <touched-unit-fixtures>
git commit -m "feat(invoicing): gate admin record-payment for terminated memberships (066 §4.4(1))"
```

---

### Task 9: F-5 audit net at BOTH terminal exits

**Files:**
- Modify: `src/modules/renewals/application/use-cases/resolve-unlinked-membership-payment.ts` (`not_applicable`/`terminal_only` branch, ~L239-264)
- Modify: `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts` (the `cycle.status !== 'awaiting_payment'` skip, ~L396-409)
- Modify: `src/lib/metrics.ts` (+ `paymentOnTerminatedMember` counter)
- Test: `tests/integration/renewals/payment-on-terminated-net.integration.test.ts`

**Interfaces:**
- Consumes: Task 6 event type + payload shape; existing `deps.auditEmitter.emitInTx(tx, event, ctx)`, `AUDIT_ACTOR = { actorUserId: null, actorRole: 'system' }`, `correlationId(evt)`, `escalationTaskRepo.insertIfAbsent(tx, NewEscalationTaskInput)`, `F4InvoicePaidEvent` fields.
- Produces: both heal sites emit `payment_on_terminated_member` + metric + one idempotent open escalation task; behaviour of the sites' RETURN values unchanged.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/renewals/payment-on-terminated-net.integration.test.ts
/**
 * 066 Round-2 §4.4(2) (review C2) — BOTH terminal exits are instrumented.
 */
describe('payment_on_terminated_member net (live Neon)', () => {
  it('UNLINKED site: paying a terminated member's unlinked membership invoice emits audit + escalation', async () => {
    // member with ONLY a lapsed cycle; membership invoice NOT linked to it;
    // fire the real f8 on-paid callback chain (mirror the existing
    // resolve-unlinked integration test's invocation shape).
    // Assert: audit_log has payment_on_terminated_member with
    //   heal_site='terminal_only', retention_years=10;
    //   ONE open escalation task (task_type='post_termination_payment_review');
    //   return kind unchanged ('skipped').
  });
  it('LINKED site (the C2 race): paying the lapsed cycle's OWN linked invoice emits the same net', async () => {
    // lapsed cycle whose linked_invoice_id = the paid invoice →
    // mark-cycle-complete's skip branch → audit heal_site='linked_terminal_skip',
    // cycle_id = the lapsed cycle id; return kind still 'cycle_not_payable'.
  });
  it('idempotent across webhook redelivery: two deliveries → 2 audit rows, ONE open task', async () => {});
  it('non-terminated skips unaffected: an upcoming-cycle skip emits NO such event', async () => {});
});
```

Run → FAIL (no audit rows).

- [ ] **Step 2: Implement — unlinked site**

Replace the body of the `not_applicable` case (keep the erased-handled comment; the return stays):

```ts
case 'not_applicable': {
  // Only reachable with reason='terminal_only' here ('erased' returned
  // above). 066 §4.4(2): a post-termination payment was CHARGED (and under
  // FEATURE_088 a §86/4 receipt minted) while membership stays terminated —
  // make it audit-visible + admin-visible, atomically in F4's payment tx.
  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'payment_on_terminated_member' as const,
      payload: {
        invoice_id: evt.invoiceId,
        member_id: evt.memberId,
        cycle_id: null,
        amount_satang: evt.amountSatang.toString(),
        payment_method: evt.paymentMethod,
        triggered_by: evt.triggeredBy,
        paid_at: evt.paidAt,
        heal_site: 'terminal_only' as const,
      },
    },
    { tenantId: evt.tenantId, ...AUDIT_ACTOR, correlationId: correlationId(evt) },
  );
  // Idempotent admin work-item — the (tenant, member, cycle, task_type)
  // WHERE status='open' unique index absorbs at-least-once webhook
  // redelivery. In-tx and NEVER swallowed: an infra throw rolls back the
  // payment tx and the webhook retry heals (the site's existing contract).
  await deps.escalationTaskRepo.insertIfAbsent(tx, {
    tenantId: evt.tenantId,
    taskId: crypto.randomUUID() as TaskId,
    memberId: evt.memberId,
    cycleId: null,
    taskType: 'post_termination_payment_review',
    assignedToRole: 'admin',
    dueAt: new Date(Date.parse(evt.paidAt) + 7 * 86_400_000).toISOString(),
  });
  renewalsMetrics.paymentOnTerminatedMember('terminal_only');
  renewalsMetrics.unlinkedPaymentResolved('skipped');
  return { kind: 'skipped', reason: classification.reason };
}
```

Widen this use-case's deps with `escalationTaskRepo` (Pick from `RenewalsDeps` — runtime wiring already passes the full object; if the deps type is a hand-built interface, add the field and thread it at the composition site where `resolveUnlinkedMembershipPaymentInTx` is constructed — grep its instantiation). Mirror the file's existing `TaskId` import/cast convention from `create-escalation-task.ts`.

- [ ] **Step 3: Implement — linked site**

In `mark-cycle-complete-from-invoice-paid.ts`, inside the `cycle.status !== 'awaiting_payment'` branch, **before** the return, gated on terminal status:

```ts
if (cycle.status === 'lapsed' || cycle.status === 'cancelled') {
  // 066 §4.4(2) review C2 — the LINKED post-termination payment (webhook
  // race: PI created pre-termination, confirmed post-termination) lands
  // here, not in resolve-unlinked. Same net, same tx.
  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'payment_on_terminated_member' as const,
      payload: {
        invoice_id: event.invoiceId,
        member_id: cycle.memberId,
        cycle_id: cycle.cycleId,
        amount_satang: event.amountSatang.toString(),
        payment_method: event.paymentMethod,
        triggered_by: event.triggeredBy,
        paid_at: event.paidAt,
        heal_site: 'linked_terminal_skip' as const,
      },
    },
    { tenantId: event.tenantId, actorUserId: null, actorRole: 'system', correlationId: `f4-paid:${event.invoiceId}` },
  );
  await deps.escalationTaskRepo.insertIfAbsent(tx, {
    tenantId: event.tenantId,
    taskId: crypto.randomUUID() as TaskId,
    memberId: cycle.memberId,
    cycleId: cycle.cycleId,
    taskType: 'post_termination_payment_review',
    assignedToRole: 'admin',
    dueAt: new Date(Date.parse(event.paidAt) + 7 * 86_400_000).toISOString(),
  });
  renewalsMetrics.paymentOnTerminatedMember('linked_terminal_skip');
}
```

(Non-terminal skips — e.g. an `upcoming` re-fire — keep the plain warn only.) Widen this deps Pick with `escalationTaskRepo` too.

- [ ] **Step 4: Metric** (`src/lib/metrics.ts`, beside `unlinkedPaymentResolved`):

```ts
/** 066 §4.4(2) — post-termination payment observed at a terminal heal site. */
paymentOnTerminatedMember(site: 'terminal_only' | 'linked_terminal_skip'): void {
  safeMetric(() => {
    counter(
      'renewals_payment_on_terminated_member_total',
      'Payments charged to a terminated membership, by heal site',
    ).add(1, { site });
  });
},
```

- [ ] **Step 5: i18n taskType label** — add `admin.renewals.tasks.taskType.post_termination_payment_review`: EN `"Post-termination payment — review"`, TH `"มีการชำระเงินหลังยุติสมาชิกภาพ — ตรวจสอบ"`, SV `"Betalning efter avslutat medlemskap — granska"` (en/th/sv).

- [ ] **Step 6: Run tests**

```bash
pnpm test:integration tests/integration/renewals/payment-on-terminated-net.integration.test.ts  # PASS (4)
pnpm test:integration tests/integration/renewals/resolve-unlinked-membership-payment.integration.test.ts  # exact filename via ls — PASS, no regression
pnpm check:i18n && pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/modules/renewals/application/use-cases/resolve-unlinked-membership-payment.ts src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts src/lib/metrics.ts src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/integration/renewals/payment-on-terminated-net.integration.test.ts <any-deps-threading-files>
git commit -m "feat(renewals): audit net at both post-termination payment exits (066 §4.4(2))"
```

---

### Task 10: F-5 member-facing 403 notice + admin lapsed-cycle callout

**Files:**
- Modify: `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/use-initiate-payment.ts` (~L192-213 error mapping)
- Modify: `src/app/(staff)/admin/renewals/[cycleId]/page.tsx` (callout on lapsed cycles, near the Period & timeline `<dl>` ~L657-690)
- Modify: `src/i18n/messages/{en,th,sv}.json`
- Test: extend the pay-sheet component test (grep `use-initiate-payment` / `pay-sheet` under `tests/`) + a page-render assertion if a cycle-detail RSC test exists (else rely on the E2E smoke at PR time)

- [ ] **Step 1: Client 403 body-code mapping**

In `use-initiate-payment.ts`, the failure branch currently keys off HTTP status only. Read the response body **before** the status switch and add the dedicated arm ahead of the generic 401/403 case:

```ts
let bodyCode: string | null = null;
try {
  const body = await response.json();
  bodyCode = body?.error?.code ?? null;
} catch {
  /* non-JSON body — fall through to status mapping */
}
if (response.status === 403 && bodyCode === 'membership_access_restricted') {
  // 066 §4.4(3) — terminated member clicked Pay Now: honest notice, not a
  // generic auth-retry message. The 059 route chokepoint is the gate; this
  // is presentation only.
  reason = t('retry.reasonMembershipTerminated');
} else if (response.status === 429) {
  /* …existing chain unchanged… */
```

(Verify the exact envelope key of the 403 — grep `membership_access_restricted` in `src/lib/member-context.ts` / the route helper to confirm `error.code` vs flat `code`, and match it.)
i18n `portal.payment.retry.reasonMembershipTerminated`:
- EN: `"Your membership has been terminated. Please contact the chamber to reactivate your membership before paying."`
- TH: `"สมาชิกภาพของท่านถูกยุติแล้ว กรุณาติดต่อหอการค้าเพื่อคืนสถานะสมาชิกก่อนชำระเงิน"`
- SV: `"Ditt medlemskap har avslutats. Kontakta kammaren för att återaktivera medlemskapet innan du betalar."`

- [ ] **Step 2: Admin callout on lapsed cycle detail**

In `page.tsx`, after the closedReason Field (~L684-689), render for lapsed cycles (reuse the page's existing alert/callout primitive — grep the file/siblings for an existing `Alert`/callout usage and match it):

```tsx
{c.status === 'lapsed' && (
  <div role="note" className={/* match the page's existing info-callout classes */}>
    <p className="font-medium">{t('terminatedCallout.title')}</p>
    <p>{t('terminatedCallout.body')}</p>
  </div>
)}
```

i18n under `admin.renewals.cycleDetail.terminatedCallout`:
- EN title `"This membership is terminated"`, body `"To accept a payment (including a bank transfer already received): use Renew Lapsed Member to reactivate and re-invoice, record the payment against the new invoice, then void the old open bill."`
- TH title `"สมาชิกภาพนี้ถูกยุติแล้ว"`, body `"หากต้องการรับชำระเงิน (รวมถึงเงินโอนที่ได้รับแล้ว): ใช้ Renew Lapsed Member เพื่อคืนสถานะและออกใบแจ้งหนี้ใหม่ บันทึกการชำระเงินกับใบแจ้งหนี้ใบใหม่ แล้วยกเลิก (void) บิลเก่าที่ค้างอยู่"`
- SV title `"Detta medlemskap är avslutat"`, body `"För att ta emot en betalning (inklusive en redan mottagen banköverföring): använd Renew Lapsed Member för att återaktivera och fakturera på nytt, registrera betalningen mot den nya fakturan och makulera sedan den gamla öppna fakturan."`

- [ ] **Step 3: Tests + gates**

```bash
pnpm vitest run <pay-sheet-test-file>   # extend with: 403 + membership_access_restricted → reasonMembershipTerminated key
pnpm check:i18n && pnpm typecheck && pnpm lint
```

- [ ] **Step 4: Commit**

```bash
git add "src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/use-initiate-payment.ts" "src/app/(staff)/admin/renewals/[cycleId]/page.tsx" src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json <touched-tests>
git commit -m "feat(renewals): terminated-member pay notice + admin reactivate-first callout (066 §4.4(3)(4))"
```

---

### Task 11: S3 — termination basis on the cycle detail

**Files:**
- Modify: `src/modules/renewals/application/ports/reminder-audit-query-repo.ts` (+ `findRenewalLapsedForCycle`)
- Modify: the drizzle impl `src/modules/renewals/infrastructure/drizzle/drizzle-reminder-audit-query-repo.ts`
- Modify: `src/modules/renewals/application/use-cases/load-cycle-detail.ts` (+ `lapseInfo`)
- Modify: `src/app/(staff)/admin/renewals/[cycleId]/page.tsx` (+ basis Field)
- Modify: `src/i18n/messages/{en,th,sv}.json`
- Test: `tests/integration/renewals/load-cycle-detail-lapse-info.integration.test.ts`

**Interfaces (Produces):**

```ts
export interface RenewalLapsedAuditInfo {
  readonly terminationBasis: 'due_plus_60' | 'no_invoice_backstop' | null;
  readonly dueDate: string | null;
}
// on ReminderAuditQueryPort:
findRenewalLapsedForCycle(tenantId: string, cycleId: string): Promise<RenewalLapsedAuditInfo | null>;
// on LoadCycleDetailOutput:
readonly lapseInfo: RenewalLapsedAuditInfo | null; // non-null only for lapsed cycles with a renewal_lapsed audit row
```

- [ ] **Step 1: Failing integration test** — arrange a cycle terminated through the real lapse use-case (reuse Task 5's terminate leg), then `loadCycleDetail` → expect `lapseInfo.terminationBasis === 'due_plus_60'` and `lapseInfo.dueDate` equal to the seeded bill due date; a non-lapsed cycle → `lapseInfo === null`. Run → FAIL.

- [ ] **Step 2: Implement** — port method doc: mirrors `findReminderAuditsForCycle`'s index rationale; drizzle impl selects the latest `audit_log` row `WHERE tenant_id=$1 AND event_type='renewal_lapsed' AND payload->>'cycle_id'=$2 ORDER BY created_at DESC LIMIT 1`, mapping `payload->>'termination_basis'` / `payload->>'due_date'` (null-safe: pre-066 rows may lack the keys). `loadCycleDetail`: call it only when `cycle.status === 'lapsed'`; thread through the output. Page: after the closedReason Field:

```tsx
{v.lapseInfo?.terminationBasis && (
  <Field
    label={t('fields.terminationBasis')}
    value={
      tBasis.has(v.lapseInfo.terminationBasis)
        ? tBasis(v.lapseInfo.terminationBasis) +
          (v.lapseInfo.dueDate ? ` (${t('fields.terminationBasisDue', { dueDate: v.lapseInfo.dueDate })})` : '')
        : `${v.lapseInfo.terminationBasis} (untranslated)`
    }
  />
)}
```

with `const tBasis = useTranslations('admin.renewals.terminationBasis');` (match the page's translator style — it may be `getTranslations`; mirror `tStatus`). i18n:
- `admin.renewals.cycleDetail.fields.terminationBasis`: EN `"Termination basis"` / TH `"เกณฑ์การยุติสมาชิกภาพ"` / SV `"Grund för avslut"`
- `admin.renewals.cycleDetail.fields.terminationBasisDue`: EN `"invoice due {dueDate}"` / TH `"ใบแจ้งหนี้ครบกำหนด {dueDate}"` / SV `"faktura förföll {dueDate}"`
- `admin.renewals.terminationBasis.due_plus_60`: EN `"Unpaid more than 60 days past the invoice due date"` / TH `"ค้างชำระเกิน 60 วันนับจากวันครบกำหนดในใบแจ้งหนี้"` / SV `"Obetald mer än 60 dagar efter fakturans förfallodag"`
- `admin.renewals.terminationBasis.no_invoice_backstop`: EN `"Never invoiced — expired past the grace period"` / TH `"ไม่เคยออกใบแจ้งหนี้ — พ้นช่วงผ่อนผันหลังหมดอายุ"` / SV `"Aldrig fakturerad — förfallen efter fristperioden"`

- [ ] **Step 3: Run + gates** — `pnpm test:integration tests/integration/renewals/load-cycle-detail-lapse-info.integration.test.ts` → PASS; `pnpm check:i18n && pnpm typecheck`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/renewals/application/ports/reminder-audit-query-repo.ts src/modules/renewals/infrastructure/drizzle/drizzle-reminder-audit-query-repo.ts src/modules/renewals/application/use-cases/load-cycle-detail.ts "src/app/(staff)/admin/renewals/[cycleId]/page.tsx" src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json tests/integration/renewals/load-cycle-detail-lapse-info.integration.test.ts
git commit -m "feat(renewals): surface termination basis + anchoring due date on cycle detail (S3)"
```

---

### Task 12: Full-gate sweep

- [ ] **Step 1: Run the full local gate set**

```bash
pnpm lint
pnpm typecheck
pnpm check:i18n
pnpm check:layout
pnpm check:fixme
pnpm check:audit-events
pnpm check:audit-counts
pnpm vitest run tests/unit/renewals tests/unit/invoicing tests/contract/renewals-audit-port.contract.test.ts
```

Expected: all green. Fix anything red before proceeding (a red gate here is a task-5-through-11 defect, not a new task).

- [ ] **Step 2: Run the touched integration files once more, in one pass**

```bash
pnpm test:integration tests/integration/renewals/due-track-candidates.integration.test.ts tests/integration/renewals/due-track-dispatch.integration.test.ts tests/integration/renewals/lapse-dormancy-guard.integration.test.ts tests/integration/renewals/payment-on-terminated-net.integration.test.ts tests/integration/invoicing/record-payment-terminated-gate.integration.test.ts tests/integration/invoicing/membership-access-cross-tenant.integration.test.ts tests/integration/renewals/load-cycle-detail-lapse-info.integration.test.ts
```

Expected: PASS. (Do NOT run the whole integration suite locally — ~40 min; CI/preview covers it.)

- [ ] **Step 3: Commit any straggler fixes**

```bash
git add <specific-paths-only>
git commit -m "test(renewals): round-2 gate-sweep fixes"
```

(Skip the commit if the tree is clean.)

---

## Plan self-review record

- **Spec coverage:** §3.2(1) candidate arm → Task 3; §3.2(2) steps/copy/gateway/precedence/opt-out/staleness/year → Tasks 1-2-4; §3.2(3) guard + min-notice + escalation + counters → Task 5 (+Task 1 predicate); §3.3 tests → Tasks 3/4/5 test lists (incl. the >120d geometry rule, corrected-invoice pin, year-boundary); §4.4(1) → Tasks 7-8; §4.4(2) both exits + 10y + idempotent task → Tasks 6+9; §4.4(3) → Task 10; §4.4(4) → Tasks 8 (error copy) + 10 (callout incl. void-old-bill); §4.6 cross-tenant blocker → Task 7; §5 S3 → Task 11; §6 lockstep → Task 6; §7 boundary/deviation → Task 7 header note.
- **Known intentional flexibility:** where a step says "mirror block X of file Y verbatim" (Task 4 send-tail, Task 3 JOIN chain, harness/factory reuse), that is a deliberate instruction to copy living code the plan must not fork — not a placeholder.
- **Type consistency check:** `DueTrackStepId`/`DUE_TRACK_STEPS`/`findDueTrackStepsDue`/`hasSatisfiedWarningRequirement` (T1) used in T2/T4/T5 with matching signatures; `DueTrackCandidate.billDueDate` (T3) consumed by T4; `membershipAccess` deps field name identical in T7 exemplar and T8 gate; audit payload keys identical in T6 shape, T9 emits, and T9 test.
