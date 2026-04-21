/**
 * T121 unit tests — Content-Disposition sanitiser.
 *
 * Proves the 3 defense layers fire on known-bad inputs:
 *   - CR/LF header-injection probe
 *   - `"` and `\` filename-quoting break
 *   - Non-ASCII bytes → ASCII fallback strips; UTF-8 form preserves
 */
import { describe, expect, it } from 'vitest';
import {
  buildAttachmentContentDisposition,
  _asciiSafeForTest,
} from '@/lib/content-disposition';

describe('asciiSafe', () => {
  it('strips CR + LF (header-injection defense)', () => {
    expect(_asciiSafeForTest('INV\r\n-000001')).toBe('INV__-000001');
    expect(_asciiSafeForTest('a\rb')).toBe('a_b');
    expect(_asciiSafeForTest('a\nb')).toBe('a_b');
  });

  it('strips double-quote + backslash (filename quoting defense)', () => {
    expect(_asciiSafeForTest('INV"-001')).toBe('INV_-001');
    expect(_asciiSafeForTest('INV\\-001')).toBe('INV_-001');
  });

  it('strips non-printable + non-ASCII bytes', () => {
    expect(_asciiSafeForTest('\x00abc\x7F')).toBe('_abc_');
    expect(_asciiSafeForTest('ใบแจ้งหนี้')).toBe('__________'); // 10 Thai chars → 10 underscores
  });

  it('passes clean ASCII through unchanged', () => {
    expect(_asciiSafeForTest('INV-2026-000001.pdf')).toBe('INV-2026-000001.pdf');
  });
});

describe('buildAttachmentContentDisposition', () => {
  it('emits both filename fallback + UTF-8 extended form for clean ASCII', () => {
    const h = buildAttachmentContentDisposition('INV-2026-000001.pdf');
    expect(h).toBe(
      `attachment; filename="INV-2026-000001.pdf"; filename*=UTF-8''INV-2026-000001.pdf`,
    );
  });

  it('CRLF in raw cannot split the header (regression guard)', () => {
    // Attacker supplies a raw with injected CRLF + forged header.
    const attacker = 'evil.pdf\r\nX-Injected: yes';
    const h = buildAttachmentContentDisposition(attacker);
    // Header string contains NO CR/LF outside the percent-encoded form
    // used by filename*. The ASCII fallback has them replaced with `_`.
    const asciiFallback = h.match(/filename="([^"]+)"/)?.[1] ?? '';
    expect(asciiFallback).not.toContain('\r');
    expect(asciiFallback).not.toContain('\n');
    // filename*= gets %-encoded, so CR/LF become %0D%0A and are inert.
    expect(h).toContain("filename*=UTF-8''");
  });

  it('UTF-8 form preserves the original bytes for non-ASCII filenames', () => {
    const raw = 'ใบแจ้งหนี้.pdf';
    const h = buildAttachmentContentDisposition(raw);
    const utf8 = h.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? '';
    expect(decodeURIComponent(utf8)).toBe(raw);
  });
});
