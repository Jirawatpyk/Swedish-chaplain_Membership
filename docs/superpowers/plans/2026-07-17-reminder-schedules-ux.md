# Reminder Schedules UX Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw-field reminder-step editor with a per-tier timeline overview + plain-language step cards, auto-composing `step_id`/`template_id` so they can never contradict `offset_days`, without changing the wire payload shape.

**Architecture:** `ScheduleEditor` stays the orchestrator (5 tier tabs, per-tier Save, wire round-trip unchanged). Each tab gains a read-only `ReminderTimeline` on top and swaps `StepRow` for a friendly `StepCard` (segmented channel control, before/after timing stepper, email preview). A pure `step-id-composer` builds the two identifiers in the exact formats the dispatch gateway parses; a contract test binds the composer to those parsers so they cannot drift. Existing stored identifiers are preserved verbatim on load and recomposed only when the admin edits timing/channel.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Base UI (Tabs, RadioGroup), lucide-react, next-intl (ICU), Vitest, Playwright + axe-core.

## Global Constraints

- Package manager: **pnpm** (not npm). Dev/start on **port 3100**.
- **No change to the PUT `/api/admin/renewals/settings/schedules/[tierBucket]` payload shape** — the wire object stays `{ steps: ScheduleStepWire[] }` with the same per-step keys.
- i18n: **EN canonical + TH + SV**; every new key in all three; `pnpm check:i18n` must pass. No hardcoded UI strings.
- Icons: **lucide-react only** — no emoji conveying meaning.
- Client bundle safety: client components import renewals types/constants **only** via `@/modules/renewals/client` — never deep-import `src/modules/renewals/infrastructure/**` (Turbopack barrel-walking + `check:bundle-budgets`).
- A11y: **WCAG 2.1 AA**; touch targets ≥ 44px; `prefers-reduced-motion` respected.
- Offset key format (verified against gateway `deriveOffsetFromStepId` / `deriveDaysFromOffset`): `` `t${days < 0 ? '-' : '+'}${Math.abs(days)}` `` — `0` → `t+0`.
- Valid offsets (gateway `RENEWAL_REMINDER_OFFSETS`): `t-120, t-90, t-60, t-30, t-14, t-7, t-3, t+0, t+7, t+14, t+30`.
- Per-tier email-copy offsets (from `copy.ts` matrix): thai_alumni `[t-30,t-14,t-3,t+7]`; start_up & regular `[t-60,t-30,t-14,t-7,t+0,t+7]`; premium `[t-90,t-60,t-30,t-14,t-7,t+0,t+14]`; partnership `[t-120,t-90,t-30,t-14,t+0,t+30]`.
- E2E always `--workers=1`.

---

### Task 1: Domain offset constants + per-tier availability + parity test

**Files:**
- Create: `src/modules/renewals/domain/value-objects/reminder-offsets.ts`
- Test: `tests/unit/renewals/reminder-offsets.test.ts`

**Interfaces:**
- Produces:
  - `RENEWAL_SCHEDULE_OFFSETS: readonly RenewalReminderOffset[]` (re-uses the `RenewalReminderOffset` type; the 11 valid keys).
  - `TIER_REMINDER_OFFSETS: Record<TierBucket, readonly RenewalReminderOffset[]>` (per-tier email offsets).
  - `offsetKeyFromDays(days: number): string` — arithmetic composer.
  - `daysFromOffsetKey(key: string): number` — inverse.
  - `isScheduleOffset(key: string): key is RenewalReminderOffset`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/renewals/reminder-offsets.test.ts
import { describe, it, expect } from 'vitest';
import {
  RENEWAL_SCHEDULE_OFFSETS,
  TIER_REMINDER_OFFSETS,
  offsetKeyFromDays,
  daysFromOffsetKey,
  isScheduleOffset,
} from '@/modules/renewals/domain/value-objects/reminder-offsets';
// Parity source of truth lives in infrastructure copy matrix (server-side import OK in a test).
import { RENEWAL_REMINDER_OFFSETS } from '@/modules/renewals/infrastructure/email/templates/copy';

describe('reminder-offsets', () => {
  it('offsetKeyFromDays matches the gateway grammar', () => {
    expect(offsetKeyFromDays(-30)).toBe('t-30');
    expect(offsetKeyFromDays(7)).toBe('t+7');
    expect(offsetKeyFromDays(0)).toBe('t+0');
  });

  it('daysFromOffsetKey is the inverse', () => {
    for (const k of RENEWAL_SCHEDULE_OFFSETS) {
      expect(offsetKeyFromDays(daysFromOffsetKey(k))).toBe(k);
    }
  });

  it('isScheduleOffset gates membership', () => {
    expect(isScheduleOffset('t-30')).toBe(true);
    expect(isScheduleOffset('t-45')).toBe(false);
  });

  it('RENEWAL_SCHEDULE_OFFSETS is exactly the gateway offset set (parity)', () => {
    expect([...RENEWAL_SCHEDULE_OFFSETS].sort()).toEqual(
      [...RENEWAL_REMINDER_OFFSETS].sort(),
    );
  });

  it('every per-tier offset is a valid schedule offset', () => {
    for (const offsets of Object.values(TIER_REMINDER_OFFSETS)) {
      for (const o of offsets) expect(isScheduleOffset(o)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/renewals/reminder-offsets.test.ts`
Expected: FAIL — module `reminder-offsets` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/renewals/domain/value-objects/reminder-offsets.ts
/**
 * Pure, client-bundle-safe reminder-offset grammar for the schedule editor.
 * Mirrors the gateway's `RENEWAL_REMINDER_OFFSETS` (infrastructure) — a parity
 * unit test guards against drift. Kept in domain so `@/modules/renewals/client`
 * can re-export it without dragging infrastructure into the client bundle.
 */
import type { RenewalReminderOffset } from '../../infrastructure/email/templates/copy';
import type { TierBucket } from './tier-bucket';

export type { RenewalReminderOffset };

export const RENEWAL_SCHEDULE_OFFSETS = [
  't-120', 't-90', 't-60', 't-30', 't-14', 't-7', 't-3', 't+0', 't+7', 't+14', 't+30',
] as const satisfies readonly RenewalReminderOffset[];

export const TIER_REMINDER_OFFSETS: Record<TierBucket, readonly RenewalReminderOffset[]> = {
  thai_alumni: ['t-30', 't-14', 't-3', 't+7'],
  start_up: ['t-60', 't-30', 't-14', 't-7', 't+0', 't+7'],
  regular: ['t-60', 't-30', 't-14', 't-7', 't+0', 't+7'],
  premium: ['t-90', 't-60', 't-30', 't-14', 't-7', 't+0', 't+14'],
  partnership: ['t-120', 't-90', 't-30', 't-14', 't+0', 't+30'],
};

export function offsetKeyFromDays(days: number): string {
  return `t${days < 0 ? '-' : '+'}${Math.abs(days)}`;
}

export function daysFromOffsetKey(key: string): number {
  const sign = key.charAt(1) === '-' ? -1 : 1;
  return sign * Number(key.slice(2));
}

export function isScheduleOffset(key: string): key is RenewalReminderOffset {
  return (RENEWAL_SCHEDULE_OFFSETS as readonly string[]).includes(key);
}
```

> NOTE: importing a `type` from `infrastructure/.../copy` is type-only and erased at build — it does not pull runtime infra code. The parity test imports the runtime value `RENEWAL_REMINDER_OFFSETS` but runs server-side (Vitest), never in the client bundle.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/renewals/reminder-offsets.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/renewals/domain/value-objects/reminder-offsets.ts tests/unit/renewals/reminder-offsets.test.ts
git commit -m "feat(renewals): client-safe reminder-offset grammar + per-tier availability"
```

---

### Task 2: Export gateway parsers for contract testing

**Files:**
- Modify: `src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx` (add `export` to `deriveOffsetFromStepId` and `deriveTierFromTemplateId`, lines ~102 and ~117)

**Interfaces:**
- Produces: `export function deriveOffsetFromStepId(stepId: string): RenewalReminderOffset | null` and `export function deriveTierFromTemplateId(templateId: string): RenewalReminderTier | null` (behaviour unchanged — only visibility).

- [ ] **Step 1: Add the exports**

Change `function deriveOffsetFromStepId(` → `export function deriveOffsetFromStepId(` and `function deriveTierFromTemplateId(` → `export function deriveTierFromTemplateId(`. No other change.

- [ ] **Step 2: Verify nothing broke**

Run: `pnpm typecheck`
Expected: PASS (no type errors; the functions are now exported but still used internally).

- [ ] **Step 3: Commit**

```bash
git add src/modules/renewals/infrastructure/resend-transactional-renewal-gateway.tsx
git commit -m "test(renewals): export step_id/template_id parsers for contract testing"
```

---

### Task 3: step-id / template-id composer + unit + CONTRACT test

**Files:**
- Create: `src/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer.ts`
- Test (unit): `tests/unit/renewals/step-id-composer.test.ts`
- Test (contract): `tests/contract/renewals/step-id-composer-gateway.contract.test.ts`

**Interfaces:**
- Consumes: `offsetKeyFromDays`, `TierBucket`.
- Produces:
  - `composeStepId(input: { offsetDays: number; channel: 'email' | 'task'; taskType?: string }): string`
  - `composeTemplateId(offsetDays: number, tier: TierBucket): string`

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/renewals/step-id-composer.test.ts
import { describe, it, expect } from 'vitest';
import { composeStepId, composeTemplateId } from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer';

describe('composeStepId', () => {
  it('email: offset-first, channel suffix', () => {
    expect(composeStepId({ offsetDays: -30, channel: 'email' })).toBe('t-30.email');
    expect(composeStepId({ offsetDays: 0, channel: 'email' })).toBe('t+0.email');
  });
  it('task: offset-first, task + taskType', () => {
    expect(composeStepId({ offsetDays: -60, channel: 'task', taskType: 'phone_call' }))
      .toBe('t-60.task.phone_call');
  });
});

describe('composeTemplateId', () => {
  it('renewal.<offset>.<tier> with underscore tier', () => {
    expect(composeTemplateId(-30, 'thai_alumni')).toBe('renewal.t-30.thai_alumni');
    expect(composeTemplateId(7, 'regular')).toBe('renewal.t+7.regular');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/renewals/step-id-composer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer.ts
import { offsetKeyFromDays } from '@/modules/renewals/client';
import type { TierBucket } from '@/modules/renewals/client';

/**
 * Compose the wire `step_id`. Offset token MUST be first (gateway
 * `deriveOffsetFromStepId` slices to the first dot). Natural key is
 * (offset, channel[, taskType]) — two steps may share an offset across channels.
 */
export function composeStepId(input: {
  offsetDays: number;
  channel: 'email' | 'task';
  taskType?: string;
}): string {
  const offset = offsetKeyFromDays(input.offsetDays);
  if (input.channel === 'email') return `${offset}.email`;
  return `${offset}.task.${input.taskType ?? 'phone_call'}`;
}

/**
 * Compose the wire `template_id`. Tier MUST be last (gateway
 * `deriveTierFromTemplateId` uses endsWith('.'+tier)). Underscore tier is accepted.
 */
export function composeTemplateId(offsetDays: number, tier: TierBucket): string {
  return `renewal.${offsetKeyFromDays(offsetDays)}.${tier}`;
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `pnpm vitest run tests/unit/renewals/step-id-composer.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the CONTRACT test (composer ↔ gateway parsers)**

```ts
// tests/contract/renewals/step-id-composer-gateway.contract.test.ts
import { describe, it, expect } from 'vitest';
import { composeStepId, composeTemplateId } from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer';
import { daysFromOffsetKey, TIER_REMINDER_OFFSETS } from '@/modules/renewals/domain/value-objects/reminder-offsets';
import { TIER_BUCKETS } from '@/modules/renewals/client';
import {
  deriveOffsetFromStepId,
  deriveTierFromTemplateId,
} from '@/modules/renewals/infrastructure/resend-transactional-renewal-gateway';

describe('composer output resolves through the dispatch gateway parsers', () => {
  it('every per-tier email offset round-trips to non-null offset + tier', () => {
    for (const tier of TIER_BUCKETS) {
      for (const offsetKey of TIER_REMINDER_OFFSETS[tier]) {
        const days = daysFromOffsetKey(offsetKey);
        const stepId = composeStepId({ offsetDays: days, channel: 'email' });
        const templateId = composeTemplateId(days, tier);

        expect(deriveOffsetFromStepId(stepId)).toBe(offsetKey);
        expect(deriveTierFromTemplateId(templateId)).toBe(tier);
      }
    }
  });
});
```

- [ ] **Step 6: Run contract test to verify it passes**

Run: `pnpm vitest run tests/contract/renewals/step-id-composer-gateway.contract.test.ts`
Expected: PASS — proves the composer never produces a silently-undeliverable identifier.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(staff)/admin/settings/renewals/schedules/_components/step-id-composer.ts" tests/unit/renewals/step-id-composer.test.ts tests/contract/renewals/step-id-composer-gateway.contract.test.ts
git commit -m "feat(renewals): step_id/template_id composer bound to gateway parsers by contract test"
```

---

### Task 4: Re-export offset grammar via client barrel

**Files:**
- Modify: `src/modules/renewals/client.ts`

**Interfaces:**
- Produces (client-safe): `RENEWAL_SCHEDULE_OFFSETS`, `TIER_REMINDER_OFFSETS`, `offsetKeyFromDays`, `daysFromOffsetKey`, `isScheduleOffset`, `type RenewalReminderOffset`.

- [ ] **Step 1: Add the re-export block**

```ts
// append to src/modules/renewals/client.ts
export {
  RENEWAL_SCHEDULE_OFFSETS,
  TIER_REMINDER_OFFSETS,
  offsetKeyFromDays,
  daysFromOffsetKey,
  isScheduleOffset,
  type RenewalReminderOffset,
} from './domain/value-objects/reminder-offsets';
```

- [ ] **Step 2: Verify build-safety**

Run: `pnpm typecheck`
Expected: PASS. (Task 3 already imports `offsetKeyFromDays` from the barrel — confirm it resolves.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/renewals/client.ts
git commit -m "feat(renewals): expose offset grammar on client-safe barrel"
```

---

### Task 5: i18n keys for the redesigned editor

**Files:**
- Modify: `src/i18n/messages/en.json`, `src/i18n/messages/th.json`, `src/i18n/messages/sv.json` (all under `admin.renewals.settings.schedules`)

**Interfaces:**
- Produces new keys used by Tasks 6–10. Reuse existing `stepCard.offsetDay.before/after/exact` for the timing sentence; add:
  - `timeline.dueLabel`, `timeline.legendEmail`, `timeline.legendTask`, `timeline.textAlt` (ICU: `{count} steps`), `timeline.emptyDue`
  - `stepCard.timing.beforeAfterLabel`, `stepCard.timing.before`, `stepCard.timing.after`, `stepCard.timing.daysLabel`
  - `stepCard.preview.heading`, `stepCard.preview.noCopyWarning`
  - `stepCard.advanced.toggle`, `stepCard.advanced.stepIdLabel`, `stepCard.advanced.templateIdLabel`
  - `stepCard.taskType.label`, `stepCard.taskType.phone_call`, `stepCard.taskType.admin_notify`

- [ ] **Step 1: Add keys to `en.json` (canonical)**

Add under `"admin" → "renewals" → "settings" → "schedules"` (merge, do not overwrite existing keys):

```json
"timeline": {
  "dueLabel": "Due date",
  "legendEmail": "Email",
  "legendTask": "Task",
  "textAlt": "{count, plural, one {# reminder} other {# reminders}} on this timeline",
  "emptyDue": "No reminders yet — only the due date is shown."
},
"stepCard": {
  "timing": {
    "beforeAfterLabel": "Send timing",
    "before": "before",
    "after": "after",
    "daysLabel": "Days"
  },
  "preview": {
    "heading": "Email that will be sent",
    "noCopyWarning": "No message exists for this timing — this email will not be sent. Pick a standard timing."
  },
  "advanced": {
    "toggle": "Advanced (raw identifiers)",
    "stepIdLabel": "Step ID",
    "templateIdLabel": "Template ID"
  },
  "taskType": {
    "label": "Task type",
    "phone_call": "Phone call",
    "admin_notify": "Notify admin"
  }
}
```

> If a `stepCard` object already exists, MERGE these children into it (keep `stepCard.channel`, `stepCard.offsetDay`, etc.). Do not duplicate the `stepCard` key.

- [ ] **Step 2: Mirror into `th.json` and `sv.json`**

Add the same structure with Thai and Swedish values. Thai example (timing): `"before": "ก่อน"`, `"after": "หลัง"`, `"daysLabel": "จำนวนวัน"`, `"beforeAfterLabel": "เวลาส่ง"`; preview heading `"อีเมลที่จะส่ง"`; `"noCopyWarning": "ไม่มีข้อความสำหรับเวลานี้ — อีเมลนี้จะไม่ถูกส่ง เลือกเวลามาตรฐาน"`. Swedish `"before": "före"`, `"after": "efter"`, `"daysLabel": "Dagar"`. (Use the `textAlt` ICU plural per locale; TH has one plural form.)

- [ ] **Step 3: Verify locale parity**

Run: `pnpm check:i18n`
Expected: PASS — no missing EN keys; TH/SV present.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json
git commit -m "feat(renewals): i18n keys for timeline + friendly step card"
```

---

### Task 6: ReminderTimeline component

**Files:**
- Create: `src/app/(staff)/admin/settings/renewals/schedules/_components/reminder-timeline.tsx`
- Test: `tests/unit/components/schedules/reminder-timeline.test.tsx`

**Interfaces:**
- Consumes: `ScheduleStepWire` (from `schedule-editor.tsx`), `TierBucket`.
- Produces: `<ReminderTimeline tierBucket={b} steps={steps} />` — read-only strip.

**Design contract (from spec §5.1):**
- Every DOM `id` inside MUST be prefixed with `tierBucket` (all 5 panels are mounted via Base UI `hidden`).
- Pins positioned by `offset_days` mapped onto an axis spanning `[min(-120), max(+30)]`; red "Due date" marker at day 0.
- lucide `Mail` (email, blue) / `ListTodo` (task, amber) legend; `aria-hidden` on icons.
- Visually-hidden ordered list (`sr-only`) = text alternative: one `<li>` per step "N days before/after · Email|Task", labelled by `timeline.textAlt`.
- Zero steps → render only the due marker + `timeline.emptyDue` copy.
- Motion: no animation required; if any, gate on `motion-safe:`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/schedules/reminder-timeline.test.tsx
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { ReminderTimeline } from '@/app/(staff)/admin/settings/renewals/schedules/_components/reminder-timeline';

function renderTL(steps: any[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReminderTimeline tierBucket="regular" steps={steps} />
    </NextIntlClientProvider>,
  );
}

it('renders a text-alternative list item per step', () => {
  renderTL([
    { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'renewal.t-30.regular' },
    { step_id: 't+7.task.phone_call', offset_days: 7, channel: 'task', task_type: 'phone_call', assignee_role: 'admin' },
  ]);
  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(2);
});

it('shows the empty-due copy when there are no steps', () => {
  renderTL([]);
  expect(screen.getByText(/only the due date is shown/i)).toBeInTheDocument();
});

it('prefixes ids with the tier bucket', () => {
  const { container } = renderTL([
    { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'renewal.t-30.regular' },
  ]);
  // every element with an id starts with "regular-"
  container.querySelectorAll('[id]').forEach((el) => {
    expect(el.id.startsWith('regular-')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/components/schedules/reminder-timeline.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reminder-timeline.tsx`**

Implement per the design contract. Skeleton:

```tsx
'use client';
import { useTranslations } from 'next-intl';
import { Mail, ListTodo } from 'lucide-react';
import type { ScheduleStepWire } from './schedule-editor';
import type { TierBucket } from '@/modules/renewals/client';

const AXIS_MIN = -120;
const AXIS_MAX = 30;
const pct = (day: number) => ((day - AXIS_MIN) / (AXIS_MAX - AXIS_MIN)) * 100;

export function ReminderTimeline({
  tierBucket, steps,
}: { readonly tierBucket: TierBucket; readonly steps: ReadonlyArray<ScheduleStepWire> }) {
  const t = useTranslations('admin.renewals.settings.schedules');
  const id = (s: string) => `${tierBucket}-tl-${s}`;
  const sorted = [...steps].sort((a, b) => a.offset_days - b.offset_days);
  return (
    <div className="rounded-md border bg-muted/30 p-4" role="group" aria-labelledby={id('cap')}>
      <p id={id('cap')} className="sr-only">{t('timeline.textAlt', { count: steps.length })}</p>
      {steps.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground">{t('timeline.emptyDue')}</p>
      ) : (
        <div className="relative mt-6 h-0.5 bg-border" aria-hidden="true">
          {/* due marker at day 0 */}
          <span className="absolute top-[-7px] h-4 w-0.5 bg-destructive" style={{ left: `${pct(0)}%` }} />
          {sorted.map((s) => (
            <span
              key={s.step_id}
              className={`absolute top-[-5px] h-3 w-3 -translate-x-1/2 rounded-full border-2 border-background ${s.channel === 'email' ? 'bg-[--chart-1]' : 'bg-[--chart-4]'}`}
              style={{ left: `${pct(s.offset_days)}%` }}
            />
          ))}
        </div>
      )}
      {/* text-alternative list (always present for SR) */}
      <ol className="sr-only">
        {sorted.map((s) => (
          <li key={s.step_id}>
            {s.offset_days === 0
              ? t('stepCard.offsetDay.exact')
              : s.offset_days < 0
                ? t('stepCard.offsetDay.before', { days: Math.abs(s.offset_days) })
                : t('stepCard.offsetDay.after', { days: s.offset_days })}
            {' · '}{t(`stepCard.channel.${s.channel}`)}
          </li>
        ))}
      </ol>
      <div className="mt-6 flex justify-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Mail aria-hidden className="h-3 w-3 text-[--chart-1]" />{t('timeline.legendEmail')}</span>
        <span className="flex items-center gap-1"><ListTodo aria-hidden className="h-3 w-3 text-[--chart-4]" />{t('timeline.legendTask')}</span>
      </div>
    </div>
  );
}
```

> Use existing chart color tokens (`--chart-1` blue, `--chart-4` amber) already defined in `globals.css` — do not hardcode hex (theme-aware, matches the 067 charts).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/components/schedules/reminder-timeline.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/settings/renewals/schedules/_components/reminder-timeline.tsx" tests/unit/components/schedules/reminder-timeline.test.tsx
git commit -m "feat(renewals): read-only reminder timeline with SR text alternative"
```

---

### Task 7: EmailPreview component (client-safe)

**Files:**
- Create: `src/app/(staff)/admin/settings/renewals/schedules/_components/email-preview.tsx`
- Test: `tests/unit/components/schedules/email-preview.test.tsx`

**Interfaces:**
- Consumes: `TierBucket`, `TIER_REMINDER_OFFSETS`, `isScheduleOffset`, `offsetKeyFromDays` (client barrel).
- Produces: `<EmailPreview tierBucket={b} offsetDays={n} />`.

**Design contract (spec §5.2, §5.5):**
- Client-safe: does **not** import `copy.ts`. Shows whether a message exists for `(tier, offset)` using `TIER_REMINDER_OFFSETS`. If the offset is NOT in the tier's set → render `stepCard.preview.noCopyWarning` (destructive style, `role="alert"`). If in set → render `stepCard.preview.heading` + a localized one-line summary (from the existing `stepCard.offsetDay.*` sentence). Full 3-locale copy body is out of scope (would need a server action — deferred per spec §9).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/schedules/email-preview.test.tsx
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { EmailPreview } from '@/app/(staff)/admin/settings/renewals/schedules/_components/email-preview';

const wrap = (ui: React.ReactNode) =>
  render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);

it('warns when the offset has no copy for the tier', () => {
  wrap(<EmailPreview tierBucket="regular" offsetDays={-45} />); // -45 not in regular set
  expect(screen.getByRole('alert')).toHaveTextContent(/will not be sent/i);
});

it('shows the preview heading when the offset is covered', () => {
  wrap(<EmailPreview tierBucket="regular" offsetDays={-30} />); // t-30 is in regular set
  expect(screen.getByText(/email that will be sent/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/components/schedules/email-preview.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
'use client';
import { useTranslations } from 'next-intl';
import { TIER_REMINDER_OFFSETS, offsetKeyFromDays } from '@/modules/renewals/client';
import type { TierBucket, RenewalReminderOffset } from '@/modules/renewals/client';

export function EmailPreview({
  tierBucket, offsetDays,
}: { readonly tierBucket: TierBucket; readonly offsetDays: number }) {
  const t = useTranslations('admin.renewals.settings.schedules');
  const key = offsetKeyFromDays(offsetDays);
  const covered = (TIER_REMINDER_OFFSETS[tierBucket] as readonly string[]).includes(key);
  if (!covered) {
    return (
      <p role="alert" className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {t('stepCard.preview.noCopyWarning')}
      </p>
    );
  }
  const sentence = offsetDays === 0
    ? t('stepCard.offsetDay.exact')
    : offsetDays < 0
      ? t('stepCard.offsetDay.before', { days: Math.abs(offsetDays) })
      : t('stepCard.offsetDay.after', { days: offsetDays });
  return (
    <div className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium">{t('stepCard.preview.heading')}:</span> {sentence}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/components/schedules/email-preview.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/settings/renewals/schedules/_components/email-preview.tsx" tests/unit/components/schedules/email-preview.test.tsx
git commit -m "feat(renewals): client-safe email preview / no-copy warning"
```

---

### Task 8: Friendly StepCard (replaces StepRow) + Advanced fields

**Files:**
- Create: `src/app/(staff)/admin/settings/renewals/schedules/_components/step-card.tsx`
- Test: `tests/unit/components/schedules/step-card.test.tsx`

**Interfaces:**
- Consumes: `ScheduleStepWire`, `TierBucket`, `composeStepId`, `composeTemplateId`, `daysFromOffsetKey`, `TIER_REMINDER_OFFSETS`, `EmailPreview`.
- Produces: `<StepCard tierBucket step index total readOnly onChange onRemove onMoveUp onMoveDown />` — same callback contract as the current `StepRow` (drop-in for `schedule-editor.tsx`).

**Design contract (spec §5.2, §5.3, §6.2):**
- Header sentence via existing `stepCard.offsetDay.*` (no DOM-fragment concatenation).
- Channel = Base UI `RadioGroup` segmented control (`Email` / `Task`), lucide icons `aria-hidden`, ≥44px segments, visible-selected focus ring = full-opacity `ring-ring`/`border-ring` (NOT `/50`).
- Timing = number stepper (`daysLabel`, ≥44px ± buttons) + separately-labelled before/after `RadioGroup` (`beforeAfterLabel`). On change → `offset_days = before ? -N : +N`, and **recompose** `step_id` (+ `template_id` for email) via the composer.
- On channel switch to `email` → set `template_id = composeTemplateId(offset, tier)`, drop task fields; to `task` → set `task_type` default `phone_call`, `assignee_role` default `admin`, drop `template_id`; recompose `step_id`.
- Email steps render `<EmailPreview>`.
- Task steps: `task_type` = friendly `Select` (`phone_call`, `admin_notify`) with raw editable under Advanced; `assignee_role` = existing Select.
- Advanced disclosure (Base UI `Collapsible` or a `<details>`): raw `step_id` / `template_id` inputs; editing overrides the auto-composed values. All ids prefixed with `${tierBucket}-${index}`.
- Reorder / remove buttons: reuse the current `StepRow` button block verbatim (move-up/down/remove with `aria-label`s from `actions.*`).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/schedules/step-card.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { StepCard } from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-card';

function renderCard(onChange = vi.fn()) {
  const step = { step_id: 't-30.email', offset_days: -30, channel: 'email' as const, template_id: 'renewal.t-30.regular' };
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StepCard tierBucket="regular" step={step} index={0} total={1} readOnly={false}
        onChange={onChange} onRemove={vi.fn()} onMoveUp={vi.fn()} onMoveDown={vi.fn()} />
    </NextIntlClientProvider>,
  );
  return { onChange };
}

it('recomposes step_id when timing changes to "after"', () => {
  const { onChange } = renderCard();
  // flip before/after to "after" (radio)
  fireEvent.click(screen.getByRole('radio', { name: /after/i }));
  const arg = onChange.mock.calls.at(-1)![0];
  expect(arg.offset_days).toBe(30);          // 30 days after
  expect(arg.step_id).toBe('t+30.email');    // recomposed, offset-first
  expect(arg.template_id).toBe('renewal.t+30.regular');
});

it('renders channel as a radiogroup', () => {
  renderCard();
  expect(screen.getByRole('radiogroup', { name: /channel/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/components/schedules/step-card.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `step-card.tsx`**

Build per the design contract. Key wiring (timing change handler):

```tsx
// inside StepCard, on before/after or N change:
const nextDays = before ? -Math.abs(n) : Math.abs(n);
const base = { ...step, offset_days: nextDays,
  step_id: composeStepId({ offsetDays: nextDays, channel: step.channel,
    taskType: step.channel === 'task' ? step.task_type : undefined }) };
onChange(step.channel === 'email'
  ? { ...base, template_id: composeTemplateId(nextDays, tierBucket) }
  : base);
```

Use `@/components/ui/radio-group` for both segmented controls; reuse the reorder/remove button block from the current `StepRow` (schedule-editor.tsx lines 178–216); render `<EmailPreview tierBucket={tierBucket} offsetDays={step.offset_days} />` for email steps; wrap raw ids in a Base UI `Collapsible` labelled `stepCard.advanced.toggle`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/components/schedules/step-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/settings/renewals/schedules/_components/step-card.tsx" tests/unit/components/schedules/step-card.test.tsx
git commit -m "feat(renewals): plain-language StepCard with auto-composed identifiers + advanced escape hatch"
```

---

### Task 9: Wire the editor — timeline + StepCard + verbatim-on-load

**Files:**
- Modify: `src/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor.tsx`

**Interfaces:**
- Consumes: `ReminderTimeline`, `StepCard`.
- Behaviour: replace the `StepRow` render with `<StepCard>`; render `<ReminderTimeline tierBucket={b} steps={steps} />` above the step list inside each `TabsContent`. **`emptyStep()` now composes valid identifiers.** Loaded policies keep their stored `step_id`/`template_id` verbatim (state init unchanged — `policiesByBucket(initialPolicies)`).

- [ ] **Step 1: Update `emptyStep()` to compose valid identifiers**

```ts
// replace the body of emptyStep() in schedule-editor.tsx
function emptyStep(tier: TierBucket): ScheduleStepWire {
  const offsetDays = -30;
  return {
    step_id: composeStepId({ offsetDays, channel: 'email' }), // 't-30.email'
    offset_days: offsetDays,
    channel: 'email',
    template_id: composeTemplateId(offsetDays, tier),          // 'renewal.t-30.<tier>'
  };
}
```

Update the two `emptyStep()` call sites to pass the active bucket: `replaceSteps(b, [emptyStep(b)])` and `replaceSteps(b, [...steps, emptyStep(b)])`.

- [ ] **Step 2: Swap `StepRow` → `StepCard` and add the timeline**

In the `TabsContent` map, add `<ReminderTimeline tierBucket={b} steps={steps} />` above the `steps.map(...)`, and replace `<StepRow ... />` with `<StepCard ... />` (identical prop list). Delete the now-unused `StepRow` + `formatOffset` if they move into `StepCard` (keep `isOfflineFetchError` — it is unit-tested).

- [ ] **Step 3: Typecheck + run the existing editor unit tests**

Run: `pnpm typecheck && pnpm vitest run tests/unit/components/schedules/`
Expected: PASS — including the pre-existing `isOfflineFetchError` test.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor.tsx"
git commit -m "feat(renewals): wire timeline + StepCard into the schedule editor; fix emptyStep identifiers"
```

---

### Task 10: Update the loading skeleton

**Files:**
- Modify: `src/app/(staff)/admin/settings/renewals/schedules/loading.tsx`

- [ ] **Step 1: Add a timeline-strip skeleton above the step-row placeholders**

Insert, right after the 5-tab placeholder block:

```tsx
{/* timeline strip placeholder */}
<Skeleton className="h-24 w-full rounded-md" />
```

Keep `FormContainer` (the reminder page is NOT widened — spec §4.1 only widens the invoice page).

- [ ] **Step 2: Verify layout gate**

Run: `pnpm check:layout`
Expected: PASS (page + loading both `FormContainer`).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/admin/settings/renewals/schedules/loading.tsx"
git commit -m "chore(renewals): match loading skeleton to timeline strip"
```

---

### Task 11: E2E + axe

**Files:**
- Create/Modify: `tests/e2e/renewals/schedule-editor.spec.ts`

**Design contract (spec §6.3):**
- Sign in as admin (`E2E_ADMIN_*` from `.env.local`), go to `/admin/settings/renewals/schedules`.
- Edit a step via the friendly controls (flip before/after, change N), Save the tier.
- **Oracle:** intercept the PUT and assert the persisted `step_id`/`template_id` are dispatch-resolvable (start with a valid offset token; `template_id` ends with the tier) — NOT "identical to the raw default".
- axe scan (`@a11y` tag) on the page with an expanded card.

- [ ] **Step 1: Write the E2E spec**

```ts
// tests/e2e/renewals/schedule-editor.spec.ts
import { test, expect } from '@playwright/test';
import { signInAsAdmin } from '../helpers/auth'; // existing helper

test('@a11y schedule editor: friendly edit persists a dispatch-resolvable step', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/settings/renewals/schedules');

  // capture the PUT payload
  const putPromise = page.waitForRequest((r) =>
    r.url().includes('/api/admin/renewals/settings/schedules/') && r.method() === 'PUT');

  // flip the first card's timing to "after" then Save
  await page.getByRole('radio', { name: /after/i }).first().click();
  await page.getByRole('button', { name: /^save$/i }).first().click();

  const req = await putPromise;
  const body = req.postDataJSON() as { steps: Array<{ step_id: string; template_id?: string }> };
  const edited = body.steps[0]!;
  expect(edited.step_id).toMatch(/^t[+-]\d+\./);           // offset-first
  if (edited.template_id) expect(edited.template_id).toMatch(/\.(thai_alumni|start_up|regular|premium|partnership)$/);
});
```

- [ ] **Step 2: Run E2E**

Run: `pnpm test:e2e --workers=1 --grep "schedule editor"`
Expected: PASS. (If Upstash rate-limit noise appears, re-run — global-setup clears it.)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/renewals/schedule-editor.spec.ts
git commit -m "test(renewals): e2e — friendly edit persists dispatch-resolvable identifiers + axe"
```

---

## Final verification (run before opening the PR)

```bash
pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:layout \
  && pnpm vitest run tests/unit/renewals tests/unit/components/schedules tests/contract/renewals \
  && pnpm test:e2e --workers=1 --grep "schedule editor"
```

All green → the reminder-schedules surface is ready. `step_id`/`template_id` are now impossible to set into a silently-undeliverable state (contract test proves it), and the wire shape is unchanged.
