/**
 * Reserved-domain check for dev seeders that write addresses a mailer will
 * later try to deliver to.
 *
 * **Why this is not a nicety.** Dev shares production's
 * `RESEND_BROADCASTS_API_KEY` and `BROADCASTS_FROM_EMAIL`, so a dev dispatch
 * pushes whatever is seeded into the SHARED Resend audience and any bounce
 * lands on the production domain's reputation and its shared suppression list.
 * A suppressed address stops receiving real mail from the chamber.
 *
 * **Round 3 finding 3-14 — the predicate this replaces let through exactly the
 * addresses it existed to block.** It was:
 *
 *     /@(example\.(com|org|net)|test|localhost|invalid)$/
 *
 * `example\.` is anchored immediately after the `@`, so any subdomain slipped:
 * `qa@sub.example.com` passed. And the bare `test` / `localhost` / `invalid`
 * alternatives were unreachable, because the caller's format check already
 * requires a dot in the domain — so `.test` and `.invalid` names passed too.
 * Verified by running it: `qa@mail.invalid`, `qa@foo.test` and
 * `qa@sub.example.com` were all UNBLOCKED.
 *
 * The rule is about the DOMAIN, so this parses the domain out and tests it,
 * rather than pattern-matching the whole address — which is what let the anchor
 * bug hide. Reserved names are RFC 2606 § 2 and § 3 plus RFC 6761:
 *
 *   - TLDs `.test`, `.example`, `.invalid`, `.localhost` (and the bare labels);
 *   - the second-level names `example.com`, `example.net`, `example.org`,
 *     including any subdomain of them.
 */

const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'] as const;
const RESERVED_SLDS = ['example.com', 'example.net', 'example.org'] as const;

/** The domain part, lower-cased; `null` when there is not exactly one `@`. */
export function emailDomain(address: string): string | null {
  const parts = address.trim().toLowerCase().split('@');
  if (parts.length !== 2) return null;
  const domain = parts[1];
  return domain === undefined || domain === '' ? null : domain;
}

/**
 * Is this address in a domain reserved for documentation and testing, i.e. one
 * no mail can ever be delivered to?
 *
 * An unparseable address answers `true`: a seeder must refuse what it cannot
 * classify, not wave it through. (The caller validates format first, so this is
 * a second line rather than the only one.)
 */
export function isUnroutableEmail(address: string): boolean {
  const domain = emailDomain(address);
  if (domain === null) return true;

  // Strip a trailing dot (`foo.test.` is the same name, fully qualified).
  const name = domain.endsWith('.') ? domain.slice(0, -1) : domain;

  for (const tld of RESERVED_TLDS) {
    if (name === tld || name.endsWith(`.${tld}`)) return true;
  }
  for (const sld of RESERVED_SLDS) {
    if (name === sld || name.endsWith(`.${sld}`)) return true;
  }
  return false;
}
