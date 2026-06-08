/**
 * Unit test for src/i18n/request.ts — asserts that `formats: buildFormats(locale)`
 * is actually wired into the getRequestConfig return value.
 *
 * 061-date-standardization — covers the I2 gap: a future edit that silently
 * drops `formats: buildFormats(locale)` from the return object would revert
 * all 11 call sites to ICU-default date formatting, breaking Buddhist-Era
 * year display for `th-TH` users. This test would catch that regression.
 *
 * Implementation note:
 * `getRequestConfig` from next-intl/server is an identity wrapper — it returns
 * the callback argument unchanged (verified by reading the source at
 * node_modules/next-intl/dist/esm/development/server/react-server/getRequestConfig.js).
 * Therefore the module's default export IS the async callback and can be
 * invoked directly with `{ requestLocale: Promise.resolve(locale) }`.
 *
 * Vitest runs in jsdom which resolves `next-intl/server` to the "react-client"
 * bundle — that bundle's `getRequestConfig` throws "not supported in Client
 * Components". We mock the module to provide the identity-wrapper implementation
 * so the test can reach the actual callback body in request.ts.
 *
 * `next/headers` is mocked to return an empty cookie store (no NEXT_LOCALE
 * cookie) so the locale falls through to the `requestLocale` parameter.
 * The dynamic `import('./messages/${locale}.json')` resolves normally via
 * Vitest's module resolution because the files exist on disk.
 */
import { describe, it, expect, vi } from 'vitest';

// next-intl/server resolves to the "react-client" bundle in jsdom, which
// throws on getRequestConfig. Provide the identity-wrapper implementation
// that the react-server bundle uses so the test can invoke the callback body.
vi.mock('next-intl/server', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    // Identity wrapper — exactly what the react-server build does.
    getRequestConfig: (cb: unknown) => cb,
  };
});

// Mock next/headers so cookies() resolves without a running Next.js runtime.
// No NEXT_LOCALE cookie → locale resolves from requestLocale param.
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: () => undefined,
  })),
}));

describe('i18n/request.ts — getRequestConfig formats wiring', () => {
  it('th locale: formats.dateTime.dateLong carries calendar: "buddhist"', async () => {
    const { default: requestConfig } = await import('@/i18n/request');

    // getRequestConfig is an identity wrapper, so the default export is
    // the async callback. Call it with requestLocale resolving to 'th'.
    const result = await (requestConfig as unknown as (params: { requestLocale: Promise<string> }) => Promise<{
      locale: string;
      formats: { dateTime: Record<string, { calendar?: string }> };
    }>)({ requestLocale: Promise.resolve('th') });

    expect(result.locale).toBe('th');
    const dateLong = result.formats.dateTime['dateLong'];
    expect(dateLong).toBeDefined();
    expect(dateLong!.calendar).toBe('buddhist');
  });

  it('en locale: formats.dateTime.dateLong does NOT carry a calendar override', async () => {
    // Re-import in a fresh context so the locale re-resolves.
    const { default: requestConfig } = await import('@/i18n/request');

    const result = await (requestConfig as unknown as (params: { requestLocale: Promise<string> }) => Promise<{
      locale: string;
      formats: { dateTime: Record<string, { calendar?: string }> };
    }>)({ requestLocale: Promise.resolve('en') });

    expect(result.locale).toBe('en');
    const dateLong = result.formats.dateTime['dateLong'];
    expect(dateLong).toBeDefined();
    expect(dateLong!.calendar).toBeUndefined();
  });

  it('th locale: timeZone is Asia/Bangkok', async () => {
    const { default: requestConfig } = await import('@/i18n/request');

    const result = await (requestConfig as unknown as (params: { requestLocale: Promise<string> }) => Promise<{
      timeZone: string;
      formats: { dateTime: Record<string, object> };
    }>)({ requestLocale: Promise.resolve('th') });

    expect(result.timeZone).toBe('Asia/Bangkok');
  });
});
