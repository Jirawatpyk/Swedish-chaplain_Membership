/**
 * F119 security review F1-1 — the banner marker splice must not re-open the
 * sanitiser.
 *
 * `findBlockMarkers` locates a banner with `OPEN_TAG = /<(a|img)\b([^>]*)>/gi`
 * and takes the whole element as `m.index … m.index + m[0].length`. That is
 * only sound while no surviving attribute value can carry a raw `>`.
 *
 * It could: HTML attribute serialisation escapes `&`, NBSP and `"` only, and
 * `alt` sits in DOMPurify's default URI-safe set, so
 * `alt="x&gt;&lt;img src=q onerror=…&gt;"` came back out of the sanitiser as
 * `alt="x><img src=q onerror=…>"`. `[^>]*` then stopped at the `>` INSIDE the
 * attribute, the span ended there, and `applyDesignBlocks` re-emitted the tail
 * — `<img src=q onerror=…>` — as RAW MARKUP in the delivered email. The
 * rendered output is never re-sanitised (by design: Outlook needs the
 * platform's `bgcolor` / inline styles), so that tail reached the recipient.
 *
 * The fix is in `installBroadcastSanitizerHooks`: every surviving attribute
 * value is stripped of `<` and `>`, so `[^>]*` is structurally sound on the
 * editor and the server alike. This suite is the regression pin — it runs the
 * payload through the REAL adapter and the REAL renderer, end to end.
 */
import { describe, expect, it } from 'vitest';
import { applyDesignBlocks } from '@/modules/broadcasts/domain/design-blocks/render-blocks';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';

const BRAND = { primaryColor: null } as const;

function pipeline(rawHtml: string): string {
  return applyDesignBlocks(dompurifySanitizer.sanitize(rawHtml), BRAND);
}

/**
 * The assertions are STRUCTURAL, not substring-based: after the fix the
 * payload survives as inert text inside an attribute value (`alt="ximg src=q
 * onerror=alert(1)"`), which is harmless and must stay allowed. What must not
 * exist is a second ELEMENT or an event-handler ATTRIBUTE — so the delivered
 * markup is re-parsed and inspected as a DOM.
 */
function parsed(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function handlerAttributes(doc: Document): string[] {
  return [...doc.body.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('on')),
  );
}

describe('design-block splice — a marker attribute can never break out of its tag', () => {
  it('a banner whose alt carries an escaped `><img onerror=…>` emits no second image and no handler', () => {
    const raw =
      '<img data-eb="banner" ' +
      'alt="x&gt;&lt;img src=q onerror=alert(document.domain)&gt;" ' +
      'src="https://blob.example.com/a.png">';

    const out = pipeline(raw);
    const doc = parsed(out);

    expect(handlerAttributes(doc)).toEqual([]);
    expect(doc.querySelectorAll('img')).toHaveLength(1);
    // The banner still renders: platform table + the user's own src.
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://blob.example.com/a.png');
    expect(doc.querySelector('table')?.getAttribute('role')).toBe('presentation');
    // The description survives minus the angle brackets it never needed.
    expect(doc.querySelector('img')?.getAttribute('alt')).toBe('ximg src=q onerror=alert(document.domain)');
    expect(out).not.toMatch(/alt="[^"]*[<>]/);
  });

  it('the same payload with a raw (unescaped) `>` in alt is equally contained', () => {
    const raw =
      '<img data-eb="banner" alt=\'x><img src=q onerror=alert(1)>\' src="https://blob.example.com/a.png">';

    const out = pipeline(raw);
    const doc = parsed(out);

    expect(handlerAttributes(doc)).toEqual([]);
    expect(doc.querySelectorAll('img')).toHaveLength(1);
  });

  it('a CTA whose href carries an escaped quote + tag stays safe (the `</a>` arm must stay closed)', () => {
    const raw =
      '<a data-eb="cta" href="https://x.example/&quot;&gt;&lt;img src=q onerror=alert(1)&gt;">Join</a>';

    const out = pipeline(raw);
    const doc = parsed(out);

    expect(handlerAttributes(doc)).toEqual([]);
    expect(doc.querySelectorAll('img')).toHaveLength(0);
    expect(doc.querySelector('a')?.textContent).toBe('Join');
    expect(doc.querySelector('table')?.getAttribute('role')).toBe('presentation');
  });

  it('a CTA whose TEXT carries markup renders the text, never a tag', () => {
    const raw =
      '<a data-eb="cta" href="https://x.example/">Join &lt;img src=q onerror=alert(1)&gt;</a>';

    const out = pipeline(raw);
    const doc = parsed(out);

    // The payload survives as VISIBLE TEXT (entity-escaped by `escapeText` in
    // `render-blocks.ts`) — that is correct and safe; what must not exist is a
    // parsed element.
    expect(handlerAttributes(doc)).toEqual([]);
    expect(doc.querySelectorAll('img')).toHaveLength(0);
    expect(doc.querySelector('a')?.textContent).toBe('Join <img src=q onerror=alert(1)>');
  });

  /**
   * ROUND-2 T-1 (security sign-off). The CTA arm of `findBlockMarkers` spans
   * from the opening `<a …>` to the matching `</a>`, so the question is not
   * only whether an attribute can carry a raw `>` — it is whether a NESTED
   * element's attribute can close the anchor EARLY. An `alt` on an `<img>`
   * inside the CTA is the reachable place for that: it is user text, it is in
   * DOMPurify's URI-safe set, and it lives inside the span the splice rewrites.
   *
   * Mutation-sighted: temporarily removing the `<`/`>` strip from
   * `installBroadcastSanitizerHooks` makes this case fail. Pasted RED below.
   */
  it('a CTA whose nested img alt carries </a> cannot close the anchor early', () => {
    const raw =
      '<a data-eb="cta" href="https://x.example/">hi' +
      '<img alt="&lt;/a&gt;&lt;img src=q onerror=alert(1)&gt;" src="https://blob.example.com/a.png">' +
      '</a>';

    const out = pipeline(raw);
    const doc = parsed(out);

    expect(handlerAttributes(doc)).toEqual([]);
    // The CTA arm drops nested markup and renders its TEXT, so the inner image
    // does not survive at all — and neither does the injected one.
    expect(doc.querySelectorAll('img')).toHaveLength(0);
    // Nothing anywhere in the delivered markup carries an unescaped angle
    // bracket inside an attribute value.
    expect(out).not.toMatch(/(?:alt|href)="[^"]*[<>]/);
  });

  it('a plain (non-block) image with a hostile alt is left alone and still carries no raw tag', () => {
    const raw =
      '<img alt="x&gt;&lt;img src=q onerror=alert(1)&gt;" src="https://blob.example.com/a.png">';

    const out = pipeline(raw);
    const doc = parsed(out);

    expect(handlerAttributes(doc)).toEqual([]);
    expect(doc.querySelectorAll('img')).toHaveLength(1);
  });
});
