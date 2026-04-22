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

  // S8 — explicit percent-encoded CR/LF variants. The filename* form
  // percent-encodes CR/LF to %0D%0A (or %0d%0a); both cases must be
  // present verbatim in the extended-form value because that side
  // carries the raw bytes. The ASCII fallback side must NOT contain
  // literal CR/LF regardless of attacker case.
  it.each([
    ['lowercase %0a', 'evil\npdf'],
    ['lowercase %0d', 'evil\rpdf'],
    ['uppercase CR+LF', 'evil\r\npdf'],
    ['dual uppercase', 'evil\r\nX-Injected: 1\r\n\r\nevil'],
  ])(
    'CRLF variant [%s] never leaks into the ASCII filename fallback',
    (_label, raw) => {
      const h = buildAttachmentContentDisposition(raw);
      const asciiFallback = h.match(/filename="([^"]+)"/)?.[1] ?? '';
      expect(asciiFallback).not.toContain('\r');
      expect(asciiFallback).not.toContain('\n');
      // Full header line must only have the ONE CRLF-less value: no
      // `\r` or `\n` bytes exist anywhere in the produced string.
      expect(h.includes('\r')).toBe(false);
      expect(h.includes('\n')).toBe(false);
    },
  );

  it('literal percent-CR/LF sequences in raw are treated as opaque chars (not decoded)', () => {
    // If an attacker tries to pre-encode CR/LF as literal `%0D%0A`,
    // those are plain ASCII chars `%`, `0`, `D`, `%`, `0`, `A` —
    // already in the allowed set. The important property is that
    // `encodeURIComponent` on the raw re-encodes the `%` to `%25`
    // so the resulting `filename*=UTF-8''` cannot be decoded by a
    // browser into CR/LF bytes.
    const raw = 'evil%0D%0Apdf';
    const h = buildAttachmentContentDisposition(raw);
    const utf8 = h.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? '';
    // The % sign is re-encoded as %25 — decoded result round-trips to
    // the literal string, not to an interpreted CR/LF.
    expect(decodeURIComponent(utf8)).toBe(raw);
  });

  it('slug-prefix collision — helper output is purely about filename, logo-blob prefix guard is route-level', () => {
    // Property-level guard: the helper must not accidentally grow any
    // role in tenant-isolation. The `raw` is echoed byte-for-byte into
    // the UTF-8 form and strip-sanitised into the ASCII form — no
    // tenant-ish parsing happens here. This is a contract test, not a
    // behavioral one.
    const h = buildAttachmentContentDisposition('invoicing/abcdef/logos/x.pdf');
    expect(h).toContain('filename="invoicing/abcdef/logos/x.pdf"');
  });

  it('invokes optional logger warn when strip occurs', () => {
    const logs: Array<{ obj: Record<string, unknown>; msg: string | undefined }> = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg?: string) => {
        logs.push({ obj, msg });
      },
    };
    buildAttachmentContentDisposition('evil\r\npdf', { logger, context: 'test' });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.obj.context).toBe('test');
  });

  it('does NOT invoke logger when input is clean', () => {
    const logs: unknown[] = [];
    const logger = { warn: (o: Record<string, unknown>) => void logs.push(o) };
    buildAttachmentContentDisposition('INV-2026-000001.pdf', { logger });
    expect(logs).toHaveLength(0);
  });
});
