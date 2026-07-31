/**
 * F8 Phase 8 — `<ReassignTaskDropdown>` #5b tests.
 *
 * History: these were STRUCTURAL source-string pins
 * (`Component.toString().toContain(...)`); the whole-branch review (2026-07-31)
 * flagged them as near-tautological. This upgrades the **loading-state** pin
 * to a REAL render assertion — an open-render with a controllable (pending →
 * resolved) fetch drives the trigger's spinner + "Loading staff…" copy without
 * hitting the documented `waitFor` lockup (that was specific to the
 * network-failure → retry path). Real timers are used so the async
 * find-utilities are not starved by any global fake-timer config.
 *
 * The **role-label** assertion stays structural: rendering it for real needs
 * the assignee combobox OPEN, i.e. a base-ui `Popover` + `cmdk` `Command` list
 * mounted inside the base-ui `AlertDialog` portal — empirically confirmed
 * (2026-07-31) not to open under jsdom `fireEvent` (the popover never mounts
 * its content), the same brittleness that keeps the retry FLOW at E2E level.
 * The visible role label is exercised by `tests/e2e/escalation-task-queue.spec.ts`
 * and its i18n keys are guaranteed present by `check:i18n`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ReassignTaskDropdown } from '@/app/(staff)/admin/renewals/tasks/_components/reassign-task-dropdown';

const reassign = enMessages.admin.renewals.tasks.reassign_dialog;

/** A fetch mock whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const STAFF = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'a@x.io',
    display_name: 'Ada Admin',
    role: 'admin' as const,
  },
];

describe('<ReassignTaskDropdown> #5b', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('surfaces a loading spinner + "Loading staff…" copy on the trigger while the staff fetch is in flight (#5b, behavioural)', async () => {
    const d = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => d.promise),
    );

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ReassignTaskDropdown
          open
          onOpenChange={() => {}}
          currentAssigneeUserId={null}
          onSubmit={async () => {}}
        />
      </NextIntlClientProvider>,
    );

    // The lazy-load effect fires on open → the trigger shows the loading copy
    // (NOT a bare disabled control) while the fetch is pending. This fails if
    // `isLoadingUsers` is unwired from the trigger.
    expect(
      await screen.findByText(reassign.loading, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();

    // Resolving clears the loading copy back to the placeholder — proves the
    // spinner is bound to the in-flight state, not always-on.
    d.resolve({
      ok: true,
      json: async () => ({ users: STAFF }),
    } as unknown as Response);
    expect(
      await screen.findByText(reassign.placeholder, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(reassign.loading)).not.toBeInTheDocument();
  });

  it('routes the staff role through the shared assigneeRole i18n key, not the raw enum (#5b, structural — visible render is E2E-only, see header)', () => {
    const src = ReassignTaskDropdown.toString();
    // The role suffix must go through t(`assigneeRole.${u.role}`); a regression
    // to printing `u.role` directly would drop this token.
    expect(src).toContain('assigneeRole');
  });

  it('wires the retry-token counter into the lazy-load effect (structural pin; retry FLOW is E2E-only)', () => {
    const src = ReassignTaskDropdown.toString();
    expect(src.includes('retryToken')).toBe(true);
  });
});
