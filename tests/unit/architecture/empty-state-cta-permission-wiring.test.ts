/**
 * Architecture test — empty-state CTA ↔ target-page permission wiring.
 *
 * The empty-state components take their CTA gate as a boolean prop
 * (`canAddMember`, `canManageSchedules`, `canManageIntegration`), and their
 * component tests prove they hide the CTA when it is false. What those tests
 * cannot see is the KEY each page evaluates for the prop: a caller passing
 * `canPerform(role, 'members.read')` would render the CTA to a manager whose
 * click then 404s — the exact bug this gate was added for.
 *
 * So for each CTA this test derives both keys from source and pins them equal:
 *   1. the CTA's `href` must appear in the component;
 *   2. the target page is `src/app/(staff)` + href + `/page.tsx`, and its one
 *      literal `requirePagePermission('<key>')` is the required key
 *      (`check:staff-page-guard` already forces that call to be a literal);
 *   3. the caller must pass `<prop>={canPerform(…, '<key>')}` — or
 *      `<prop>={ident}` where `ident={canPerform(…, '<key>')}` in the same
 *      file (members threads it through `MembersDirectoryBody`'s `isAdmin`).
 *
 * Every extraction must match EXACTLY once. A parse that finds nothing fails
 * rather than passing vacuously (CLAUDE.md § Gotchas — a check that cannot
 * tell "nothing to find" from "not looking" is not a check). Patterns use
 * `\s`, so CRLF checkouts parse the same as LF.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');

interface CtaWiring {
  readonly name: string;
  /** File that renders the gated CTA. */
  readonly component: string;
  /** The CTA's link target (a staff page). */
  readonly href: string;
  /** Page that renders the component and evaluates the gate. */
  readonly caller: string;
  /** The boolean prop carrying the evaluated gate. */
  readonly prop: string;
}

const CTAS: readonly CtaWiring[] = [
  {
    name: 'members zero state → add member',
    component: 'src/components/members/empty-states.tsx',
    href: '/admin/members/new',
    caller: 'src/app/(staff)/admin/members/page.tsx',
    prop: 'canAddMember',
  },
  {
    name: 'renewals empty state → schedule settings',
    component: 'src/app/(staff)/admin/renewals/_components/empty-state.tsx',
    href: '/admin/settings/renewals/schedules',
    caller: 'src/app/(staff)/admin/renewals/page.tsx',
    prop: 'canManageSchedules',
  },
  {
    name: 'events empty state → EventCreate integration',
    component: 'src/app/(staff)/admin/events/_components/events-empty-state.tsx',
    href: '/admin/settings/integrations/eventcreate',
    caller: 'src/app/(staff)/admin/events/page.tsx',
    prop: 'canManageIntegration',
  },
];

function read(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), 'utf8');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The single capture group of a pattern that must match exactly once. */
function captureOnce(src: string, re: RegExp, what: string): string {
  const hits = [...src.matchAll(re)];
  expect(hits, `${what}: expected exactly 1 match, found ${hits.length}`).toHaveLength(1);
  return hits[0]![1]!;
}

/** `ident={canPerform(<anything>, '<key>')}` → key. */
function canPerformKeyFor(src: string, ident: string, what: string): string {
  return captureOnce(
    src,
    new RegExp(
      `\\b${escapeRe(ident)}=\\{\\s*canPerform\\(\\s*[^,()]+,\\s*'([^']+)',?\\s*\\)\\s*\\}`,
      'g',
    ),
    what,
  );
}

describe('empty-state CTA gate uses the target page permission', () => {
  it.each(CTAS)('$name', (cta) => {
    const component = read(cta.component);
    expect(
      component.includes(`href="${cta.href}"`),
      `${cta.component} no longer links to ${cta.href}`,
    ).toBe(true);

    const targetPage = `src/app/(staff)${cta.href}/page.tsx`;
    const requiredKey = captureOnce(
      read(targetPage),
      /requirePagePermission\(\s*'([^']+)'/g,
      `${targetPage} requirePagePermission`,
    );

    const caller = read(cta.caller);
    const propValue = captureOnce(
      caller,
      new RegExp(`\\b${escapeRe(cta.prop)}=\\{([\\s\\S]*?)\\}\\s*(?:/>|\\n)`, 'g'),
      `${cta.caller} ${cta.prop}={…}`,
    ).trim();

    const passedKey = /^[A-Za-z_$][\w$]*$/.test(propValue)
      ? // One hop: `prop={ident}` where `ident={canPerform(…)}` in this file.
        canPerformKeyFor(caller, propValue, `${cta.caller} ${propValue}={canPerform(…)}`)
      : canPerformKeyFor(caller, cta.prop, `${cta.caller} ${cta.prop}={canPerform(…)}`);

    expect(passedKey).toBe(requiredKey);
  });
});
