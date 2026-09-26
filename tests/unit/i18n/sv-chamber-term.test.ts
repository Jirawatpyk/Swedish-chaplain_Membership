/**
 * SV addresses the tenant as "din handelskammare" (#416 changed the compose
 * subtitle and consent banner). "din kammare(s)" on its own reads as a
 * chamber in the parliamentary / household sense, so no SV string may use it.
 */
import { describe, expect, it } from 'vitest';
import sv from '@/i18n/messages/sv.json';

type Tree = Record<string, unknown>;

function* strings(tree: Tree, prefix = ''): Generator<[string, string]> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') yield [path, value];
    else if (value && typeof value === 'object') yield* strings(value as Tree, path);
  }
}

describe('SV chamber term', () => {
  it('never says "din kammare" / "din kammares"', () => {
    const offenders = [...strings(sv as Tree)]
      .filter(([, value]) => /\bdin kammares?\b/i.test(value))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
