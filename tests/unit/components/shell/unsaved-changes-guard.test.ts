/**
 * F119 U27 — `guardedNavigationTarget`, the pure half of the in-app arm of
 * `<UnsavedChangesGuard>`: which anchors are an exit from THIS page in THIS
 * tab. The event half (modifier keys, non-primary button, a link inside the
 * editor) lives in the listener and is asserted through the real form in
 * `tests/unit/broadcast/compose-inapp-nav-guard.test.tsx`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { guardedNavigationTarget } from '@/components/shell/unsaved-changes-guard';

const CURRENT = '/portal/broadcasts/new?step=1';

function anchor(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  for (const [name, value] of Object.entries(attrs)) a.setAttribute(name, value);
  return a;
}

beforeEach(() => {
  window.history.replaceState(null, '', CURRENT);
});

describe('guardedNavigationTarget', () => {
  it.each([
    ['a same-origin path', anchor('/portal/dashboard'), '/portal/dashboard'],
    [
      'an absolute same-origin URL, keeping search and hash',
      anchor(`${window.location.origin}/portal/events?page=2#top`),
      '/portal/events?page=2#top',
    ],
    ['target="_self"', anchor('/portal/dashboard', { target: '_self' }), '/portal/dashboard'],
    ['an empty target', anchor('/portal/dashboard', { target: '' }), '/portal/dashboard'],
    [
      'the same path with a different query',
      anchor('/portal/broadcasts/new?step=2'),
      '/portal/broadcasts/new?step=2',
    ],
  ])('guards %s', (_label, a, expected) => {
    expect(guardedNavigationTarget(a)).toBe(expected);
  });

  it.each([
    ['another origin', anchor('https://example.com/portal/dashboard')],
    ['target="_blank"', anchor('/portal/dashboard', { target: '_blank' })],
    ['a named target', anchor('/portal/dashboard', { target: 'help' })],
    ['a download link', anchor('/portal/export.csv', { download: '' })],
    ['rel="external"', anchor('/portal/dashboard', { rel: 'noopener External' })],
    ['mailto:', anchor('mailto:office@swecham.example')],
    ['tel:', anchor('tel:+6620000000')],
    ['a hash-only link on this page (skip-to-content)', anchor('#main-content')],
    ['the page it is already on', anchor(CURRENT)],
    ['an empty href', anchor('')],
  ])('ignores %s', (_label, a) => {
    expect(guardedNavigationTarget(a)).toBeNull();
  });

  it('ignores an anchor with no href at all', () => {
    expect(guardedNavigationTarget(document.createElement('a'))).toBeNull();
  });
});
