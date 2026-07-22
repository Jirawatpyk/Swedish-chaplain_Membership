/**
 * WP6 — tier-upgrade action error-code normaliser + copy coverage (C-14).
 *
 * Pins the dual-envelope normaliser (nested F8 `{error:{code}}` + flat proxy
 * `{error:'read-only-mode'}`), and asserts every one of the 15 closed codes
 * resolves to real copy in all three locales (a missing key would surface a
 * raw code string to an admin).
 */
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import {
  TIER_UPGRADE_ACTION_ERROR_CODES,
  normalizeTierUpgradeErrorCode,
} from '@/app/(staff)/admin/renewals/tier-upgrades/_lib/tier-upgrade-error-codes';

describe('normalizeTierUpgradeErrorCode', () => {
  it('reads the nested F8 envelope', () => {
    expect(
      normalizeTierUpgradeErrorCode({ error: { code: 'suggestion_not_open' } }),
    ).toBe('suggestion_not_open');
    expect(
      normalizeTierUpgradeErrorCode({ error: { code: 'no_active_cycle' } }),
    ).toBe('no_active_cycle');
  });

  it('folds the flat hyphenated proxy envelope to snake_case', () => {
    expect(normalizeTierUpgradeErrorCode({ error: 'read-only-mode' })).toBe(
      'read_only_mode',
    );
    expect(normalizeTierUpgradeErrorCode({ error: 'csrf-rejected' })).toBe(
      'csrf_rejected',
    );
  });

  it('maps a null / bodyless response to http_error', () => {
    expect(normalizeTierUpgradeErrorCode(null)).toBe('http_error');
    expect(normalizeTierUpgradeErrorCode(undefined)).toBe('http_error');
    expect(normalizeTierUpgradeErrorCode('not-json')).toBe('http_error');
    expect(normalizeTierUpgradeErrorCode({})).toBe('http_error');
  });

  it('collapses an unrecognised code to unknown', () => {
    expect(
      normalizeTierUpgradeErrorCode({ error: { code: 'wibble' } }),
    ).toBe('unknown');
    expect(normalizeTierUpgradeErrorCode({ error: 'totally-made-up' })).toBe(
      'unknown',
    );
  });
});

describe('action_errors copy coverage', () => {
  const locales: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['en', enMessages],
    ['th', thMessages],
    ['sv', svMessages],
  ];

  for (const [locale, messages] of locales) {
    it(`resolves all ${TIER_UPGRADE_ACTION_ERROR_CODES.length} codes in ${locale}`, () => {
      const t = createTranslator({
        locale,
        messages,
        namespace: 'admin.renewals.tier_upgrades.action_errors',
      } as unknown as Parameters<typeof createTranslator>[0]) as unknown as (
        key: string,
      ) => string;
      for (const code of TIER_UPGRADE_ACTION_ERROR_CODES) {
        const copy = t(code);
        expect(copy, `${locale}.action_errors.${code}`).toBeTruthy();
        // A next-intl miss echoes the namespaced key back — assert we got copy.
        expect(copy).not.toContain('action_errors.');
      }
    });
  }
});
