/**
 * 016 T059 — role labels exist in every locale for every assignable role.
 *
 * `check:i18n` compares the three locale files against EACH OTHER: it catches a
 * key present in `en` but missing from `th`. It cannot catch a key missing from
 * ALL THREE, which is exactly what happens when a role is added to
 * `ASSIGNABLE_ROLES` and nobody writes its labels. next-intl does not throw on a
 * missing key either — it renders the raw dotted path — so the failure ships as
 * a picker option literally labelled `admin.users.invite.roles.marketing`.
 *
 * This closes that gap by driving the expectation from the Domain enum rather
 * than from the message files, so the enum is the thing that has to move first.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';
import { ROLES } from '@/modules/auth/domain/role';
import { ROLE_LABELS as EMAIL_ROLE_LABELS } from '@/modules/auth/infrastructure/email/invitation-email';

const LOCALES = { en, th, sv } as const;

/** Every namespace that renders a role name in a user-facing control. */
const NAMESPACES = [
  {
    // The header badge — the role name every staff user sees on EVERY page
    // (user-menu.tsx) and on both account pages. It was omitted while this
    // file's own docblock described exactly the failure that omission allows:
    // `check:i18n` compares locales against each other, so a key missing from
    // all three at once is invisible to it, and this test is the backstop.
    label: 'shell.roleBadge',
    expected: ROLES,
    read: (m: typeof en) => m.shell.roleBadge as Record<string, unknown>,
  },
  {
    label: 'admin.users.filters.role',
    // The filter dropdown lists every role that can EXIST on a row, which is
    // all of them — a member row must still render "Member" in the filter.
    expected: ROLES,
    read: (m: typeof en) => m.admin.users.filters.role as Record<string, unknown>,
  },
  {
    // One-line summary of what a role grants. Shared by BOTH pickers since the
    // UX review — it used to live at `admin.users.invite.roles` as
    // "Name — description", which meant change-role showed a bare role name
    // with no statement of consequences, and the invite trigger hard-cut the
    // description mid-sentence. `ROLES`, not `ASSIGNABLE_ROLES`: change-role
    // renders it for a row's CURRENT role too.
    label: 'admin.users.roleSummary',
    expected: ROLES,
    read: (m: typeof en) => m.admin.users.roleSummary as Record<string, unknown>,
  },
] as const;

describe('role label parity across en/th/sv', () => {
  for (const ns of NAMESPACES) {
    for (const [locale, messages] of Object.entries(LOCALES)) {
      it(`${locale}: ${ns.label} covers every expected role`, () => {
        const block = ns.read(messages as typeof en);
        const missing = ns.expected.filter(
          (role) => typeof block[role] !== 'string' || (block[role] as string).trim() === '',
        );
        expect(
          missing,
          `${locale}.json is missing a label for these roles under ${ns.label}. ` +
            'next-intl renders the raw key instead of throwing, so this ships as a ' +
            'control labelled with a dotted path.',
        ).toEqual([]);
      });
    }
  }

  it('no locale carries a role label for a role that does not exist', () => {
    // The other direction: a leftover label after a role is removed is dead
    // weight that reads as if the role were still supported.
    const orphans: string[] = [];
    for (const ns of NAMESPACES) {
      for (const [locale, messages] of Object.entries(LOCALES)) {
        for (const key of Object.keys(ns.read(messages as typeof en))) {
          // `label`/`all` are the dropdown's own chrome, not role names.
          if (key === 'label' || key === 'all') continue;
          if (!(ROLES as readonly string[]).includes(key)) {
            orphans.push(`${locale}: ${ns.label}.${key}`);
          }
        }
      }
    }
    expect(orphans).toEqual([]);
  });
});

/**
 * ONE role, ONE word — per locale, across every surface that names a role.
 *
 * The coverage loop above proves a label EXISTS. It cannot see the failure that
 * actually happened: the same role called two different things on two screens.
 * `shell.roleBadge.manager` moved from "Chef" to "Manager" while the renewal
 * assignee lists kept "Chef", so one person read as "Manager" on /admin/users
 * and "Chef" in the escalation queue — and `check:i18n`, which compares locales
 * against each other rather than namespaces against each other, is blind to it.
 *
 * `ROLE_LABELS` in `invitation-email.ts` is included because emails render
 * outside next-intl and so keep their own copy — the one that drifted furthest
 * (it still said "Administrator" and "Chef" after the app had moved on).
 */
describe('one role, one word — per locale, across namespaces', () => {
  const SURFACES = [
    { label: 'shell.roleBadge', read: (m: typeof en) => m.shell.roleBadge },
    { label: 'admin.users.filters.role', read: (m: typeof en) => m.admin.users.filters.role },
    {
      label: 'admin.renewals.tasks.assigneeRole',
      read: (m: typeof en) => m.admin.renewals.tasks.assigneeRole,
    },
    {
      label: 'admin.renewals.…stepCard.assigneeRole',
      read: (m: typeof en) => m.admin.renewals.settings.schedules.stepCard.assigneeRole,
    },
  ] as const;

  for (const [locale, messages] of Object.entries(LOCALES)) {
    it(`${locale}: every namespace agrees on each role's name`, () => {
      const disagreements: string[] = [];
      for (const role of ROLES) {
        const seen = new Map<string, string[]>();
        for (const surface of SURFACES) {
          const block = surface.read(messages as typeof en) as Record<string, unknown>;
          const value = block[role];
          if (typeof value !== 'string') continue; // partial namespace — fine
          seen.set(value, [...(seen.get(value) ?? []), surface.label]);
        }
        // The email copy is the fifth surface and lives in TypeScript.
        const emailValue = EMAIL_ROLE_LABELS[locale as keyof typeof EMAIL_ROLE_LABELS]?.[role];
        if (typeof emailValue === 'string') {
          seen.set(emailValue, [...(seen.get(emailValue) ?? []), 'invitation-email ROLE_LABELS']);
        }
        if (seen.size > 1) {
          disagreements.push(
            `${role}: ` +
              [...seen.entries()].map(([v, where]) => `"${v}" (${where.join(', ')})`).join(' vs '),
          );
        }
      }
      expect(disagreements, `${locale} names the same role differently`).toEqual([]);
    });
  }
});
