/**
 * 108 PR-D review cycle 14 (whole-branch MEDIUM-12) — ONE production-host
 * guard shared by the integration harness (`tests/integration-setup.ts`) and
 * the e2e seed client (`tests/e2e/helpers/open-seed-client.ts`), so the two
 * cannot drift: both fail CLOSED on a matching host fragment AND on an
 * unset / empty `TEST_DB_HOST_BLOCKLIST` (a guard with nothing to check is
 * not a guard).
 */
import { describe, expect, it } from 'vitest';
import { assertDbHostNotBlocklisted } from '../../helpers/db-host-guard';

const DEV = 'postgresql://u:p@ep-dev-xyz789.ap-southeast-1.aws.neon.tech/db';
const PROD = 'postgresql://u:p@ep-prod-abc123.ap-southeast-1.aws.neon.tech/db';

describe('assertDbHostNotBlocklisted', () => {
  it('passes for a host outside a populated list', () => {
    expect(() => assertDbHostNotBlocklisted(DEV, 'ep-prod-abc123, something-else', 'unit')).not.toThrow();
  });

  it('throws naming the matched fragment', () => {
    expect(() => assertDbHostNotBlocklisted(PROD, 'ep-prod-abc123', 'unit')).toThrow(/ep-prod-abc123/);
  });

  it.each([undefined, '', '   ', ',,', ' , '])('throws on an unset / empty list (%j) — fail closed', (raw) => {
    expect(() => assertDbHostNotBlocklisted(DEV, raw, 'unit')).toThrow(/TEST_DB_HOST_BLOCKLIST/);
  });

  it('the message carries the caller label so the operator knows which harness refused', () => {
    expect(() => assertDbHostNotBlocklisted(PROD, 'ep-prod-abc123', 'integration')).toThrow(/\[integration\]/);
  });
});
