// @vitest-environment jsdom
/**
 * F119 T155 finding U8 — the dead `try/catch` around `t()`.
 *
 * **next-intl does not throw on a missing key.** It returns the key PATH. So
 * four sites that wrapped a dynamic `t(\`errors.${code}\`)` in a `catch` had an
 * unreachable fallback, and an unmapped server code rendered
 * `admin.broadcasts.settings.allowlist.errors.<code>` verbatim into a
 * `role="alert"` and into a toast. The repo already knew:
 * `compose-form.tsx:399-401` says so in a comment, and
 * `benefits/_components/broadcasts-panel.tsx` uses the correct `t.has()` form.
 *
 * Two halves:
 *   1. behavioural, on the site whose variant had NO fallback at all
 *      (`admin-image-allowlist-editor.tsx:71-72`) — an unknown code must
 *      produce the translated generic message, never a key path;
 *   2. a source scan of all four sites, with a positive control, so a future
 *      refactor cannot re-introduce the dead catch anywhere in the class.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { AdminImageAllowlistEditor } from '@/components/broadcast/admin-image-allowlist-editor';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  // userEvent schedules its inter-key delay on the shared setup's FAKE timers.
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('U8 — an unmapped server error code never reaches the user as a key path', () => {
  it('the allowlist editor falls back to the translated generic message', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        // A code the client has no key for — exactly what a future API
        // expansion produces.
        json: async () => ({ error: 'rate_limited_by_upstream' }),
      }),
    );

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AdminImageAllowlistEditor
          initial={[{ hostname: 'cdn.example.org', isDefault: true }]}
        />
      </NextIntlClientProvider>,
    );

    await user.type(screen.getByLabelText(/hostname/i), 'images.example.org');
    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(
      message,
      'a raw i18n key path is not a message a chamber administrator can act on',
    ).not.toMatch(/admin\.broadcasts\.settings\.allowlist/);
    expect(message).not.toContain('rate_limited_by_upstream');
    expect(message.length).toBeGreaterThan(0);
  });
});

// ── The class, across all four sites ───────────────────────────────────────

const SITES = [
  'src/components/broadcast/admin/template-form.tsx',
  'src/components/broadcast/compose-form.tsx',
  'src/components/broadcast/compose-inline-image-uploader.tsx',
  'src/components/broadcast/admin-image-allowlist-editor.tsx',
] as const;

/**
 * A `try { … }` block whose body calls a translator. next-intl cannot throw
 * there, so the `catch` is unreachable code that reads as a guard.
 */
export function findTranslatorTryBlocks(src: string): string[] {
  const hits: string[] = [];
  const TRY = /\btry\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = TRY.exec(src)) !== null) {
    // Balanced-brace scan, not a lazy `[\s\S]*?`: these try blocks NEST (a
    // network try wrapping the message lookup), and a lazy match stops at the
    // inner `} catch`, reporting the outer body and hiding the inner one.
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    const body = src.slice(start, i - 1);
    // A translator identifier — `t(`, `tErr(`, `tImage(` — and nothing
    // `await`ed or fetched, which really can throw. `toast(` and friends do
    // not match: the second character must be `(` or an upper-case letter.
    const callsTranslator = /\b(?:t|t[A-Z]\w*)\s*\(/.test(body);
    if (callsTranslator && !/\bawait\b|fetch\(/.test(body)) {
      hits.push(body.trim().slice(0, 120));
    }
  }
  return hits;
}

describe('U8 — no site wraps a translator call in try/catch', () => {
  it('the detector fires on the shape that shipped (positive control)', () => {
    const shipped = [
      'let msg: string;',
      'try {',
      "  msg = t(`errors.${code}`);",
      '} catch {',
      "  msg = t('errors.unknown');",
      '}',
    ].join('\n');
    expect(findTranslatorTryBlocks(shipped)).toHaveLength(1);
    // …and NOT on a try/catch that guards something which really can throw.
    expect(
      findTranslatorTryBlocks('try {\n  const r = await fetch(url);\n} catch {}'),
    ).toEqual([]);
  });

  it.each(SITES)('%s resolves unknown codes without a catch', (path) => {
    const src = readFileSync(resolve(process.cwd(), path), 'utf8');
    expect(
      findTranslatorTryBlocks(src),
      'next-intl returns the key path rather than throwing — guard with t.has().',
    ).toEqual([]);
  });

  it.each(SITES)('%s guards its dynamic lookup with t.has()', (path) => {
    const src = readFileSync(resolve(process.cwd(), path), 'utf8');
    expect(src, 'a dynamic `errors.${code}` lookup needs a has() check').toMatch(
      /\.has\(/,
    );
  });
});
