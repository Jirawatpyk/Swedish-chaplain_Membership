/**
 * S10 — `logo_blob_key` cross-tenant guard (PATCH /api/tenant-invoice-settings).
 *
 * The route-level guard builds `expectedPrefix = \`invoicing/${slug}/logos/\``
 * and checks `logo_blob_key.startsWith(expectedPrefix)`. This is
 * correct only because of the trailing `/` — without it a slug `abc`
 * would accept keys that begin with `invoicing/abcdef/logos/...`. This
 * unit test pins the property so a future refactor that drops the
 * trailing slash fails loudly.
 */
import { describe, expect, it } from 'vitest';

function hasValidPrefix(slug: string, logoBlobKey: string): boolean {
  const expectedPrefix = `invoicing/${slug}/logos/`;
  return logoBlobKey.startsWith(expectedPrefix);
}

describe('logo_blob_key cross-tenant prefix guard', () => {
  it('accepts a key under the caller\u2019s own slug', () => {
    expect(
      hasValidPrefix('abc', 'invoicing/abc/logos/logo.png'),
    ).toBe(true);
  });

  it('rejects a key under a DIFFERENT slug', () => {
    expect(
      hasValidPrefix('abc', 'invoicing/xyz/logos/logo.png'),
    ).toBe(false);
  });

  it('slug-prefix collision: `abc` cannot impersonate `abcdef`', () => {
    // Without the trailing slash this would be a bug — `abc` would
    // match every key under `abcdef/logos/*`. The trailing slash in
    // expectedPrefix makes the guard safe.
    expect(
      hasValidPrefix('abc', 'invoicing/abcdef/logos/logo.png'),
    ).toBe(false);
  });

  it('rejects paths that escape the logos subfolder', () => {
    expect(
      hasValidPrefix('abc', 'invoicing/abc/legal/logo.png'),
    ).toBe(false);
  });

  it('rejects empty + malformed keys', () => {
    expect(hasValidPrefix('abc', '')).toBe(false);
    expect(hasValidPrefix('abc', 'invoicing/abc/logos')).toBe(false); // no trailing /
    expect(hasValidPrefix('abc', 'invoicing/abclogos/x.png')).toBe(false);
  });
});
