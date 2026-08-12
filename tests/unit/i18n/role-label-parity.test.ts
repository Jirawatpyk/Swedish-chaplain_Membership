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
import { ASSIGNABLE_ROLES, ROLES } from '@/modules/auth/domain/role';

const LOCALES = { en, th, sv } as const;

/** The two namespaces that render a role name in a user-facing control. */
const NAMESPACES = [
  {
    label: 'admin.users.filters.role',
    // The filter dropdown lists every role that can EXIST on a row, which is
    // all of them — a member row must still render "Member" in the filter.
    expected: ROLES,
    read: (m: typeof en) => m.admin.users.filters.role as Record<string, unknown>,
  },
  {
    label: 'admin.users.invite.roles',
    // The invite dialog offers only what may be ASSIGNED.
    expected: ASSIGNABLE_ROLES,
    read: (m: typeof en) => m.admin.users.invite.roles as Record<string, unknown>,
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
