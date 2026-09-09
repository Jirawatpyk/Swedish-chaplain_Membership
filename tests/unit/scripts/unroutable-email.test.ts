/**
 * Round 3 finding 3-14 — the seeder's "refusing to seed unroutable addresses"
 * guard was mis-anchored and passed the addresses it existed to block.
 *
 * The three cases in the first block are the ones the review VERIFIED as
 * unblocked by running the old regex
 * `/@(example\.(com|org|net)|test|localhost|invalid)$/`. They are pinned by
 * value, because the failure was not "the rule is wrong" — the rule was right —
 * but "the expression does not implement the rule", and only a case that names a
 * specific address can tell those two apart.
 *
 * Dev shares production's Resend key and sender domain, so each of these would
 * have bounced onto the production domain's reputation and its shared
 * suppression list.
 */
import { describe, expect, it } from 'vitest';
import { emailDomain, isUnroutableEmail } from '../../../scripts/lib/unroutable-email';

describe('isUnroutableEmail — the three the old regex let through', () => {
  for (const address of ['qa@mail.invalid', 'qa@foo.test', 'qa@sub.example.com']) {
    it(`blocks ${address}`, () => {
      expect(isUnroutableEmail(address)).toBe(true);
    });
  }
});

describe('isUnroutableEmail — reserved names (RFC 2606 / 6761)', () => {
  const blocked = [
    'a@example.com',
    'a@example.net',
    'a@example.org',
    'a@deep.sub.example.org',
    'a@anything.test',
    'a@anything.example',
    'a@anything.invalid',
    'a@anything.localhost',
    'a@localhost',
    'a@test',
    // Fully qualified with the trailing dot — the same name.
    'a@foo.test.',
  ];
  for (const address of blocked) {
    it(`blocks ${address}`, () => {
      expect(isUnroutableEmail(address)).toBe(true);
    });
  }

  /**
   * Positive controls. A guard that answered `true` for everything would satisfy
   * every case above and make the seeder useless — which is the failure mode a
   * blocklist tightened after an incident usually lands in.
   */
  const allowed = [
    'qa+secondary@swecham.com',
    'someone@gmail.com',
    // Contains a reserved label but is NOT under it — the substring trap the
    // old expression's anchoring was trying (and failing) to avoid.
    'a@testing.co.th',
    'a@example.company.com',
    'a@notexample.com',
    'a@invalidation.io',
    'a@localhost.example.co',
  ];
  for (const address of allowed) {
    it(`allows ${address}`, () => {
      expect(isUnroutableEmail(address)).toBe(false);
    });
  }
});

describe('isUnroutableEmail — fails closed on anything it cannot classify', () => {
  for (const bad of ['', 'no-at-sign', 'two@at@signs', 'trailing@']) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(isUnroutableEmail(bad)).toBe(true);
    });
  }

  it('emailDomain returns null for the same inputs, lower-cased otherwise', () => {
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('A@Example.COM')).toBe('example.com');
  });
});
