/**
 * F119 T101 (FR-038) — content outside the shared policy is dropped AT PASTE
 * TIME and the author is told ONCE per editing session, in a non-blocking
 * notice.
 *
 * Two failure modes this pins:
 *
 *   - Repetition. The pre-F119 editor throttled the toast by 1.5 s, so a
 *     member pasting five paragraphs from Word got a stack of identical
 *     warnings. "Once per editing session" means once per mounted editor —
 *     a second paste in the same session is silent, and a NEW editor (a new
 *     draft, a remount) starts a new session.
 *   - False notices. The shared post-attribute hook ADDS `rel`/`target` to
 *     every surviving link, so "the output differs from the input" is not
 *     evidence that anything was removed. Telling an author their formatting
 *     was stripped when a perfectly-kept link was merely hardened teaches
 *     them to ignore the notice.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeBroadcastPasteTransform } from '@/components/broadcast/broadcast-paste-transform';

describe('T101 — a second paste in the same session shows no second notice', () => {
  it('notifies once and drops the unsupported content', () => {
    const notify = vi.fn();
    const transform = makeBroadcastPasteTransform({ images: false, notify });

    const first = transform('<p>Hi <span style="color:red">there</span></p>');
    expect(first).not.toContain('<span');
    expect(first).not.toContain('style=');
    expect(first).toContain('there');
    expect(notify).toHaveBeenCalledTimes(1);

    const second = transform('<div><script>alert(1)</script>More text</div>');
    expect(second).not.toContain('<script');
    expect(second).toContain('More text');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a NEW editor session notifies again', () => {
    const first = vi.fn();
    makeBroadcastPasteTransform({ images: false, notify: first })(
      '<p><font size="4">x</font></p>',
    );
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    makeBroadcastPasteTransform({ images: false, notify: second })(
      '<p><font size="4">x</font></p>',
    );
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('T101 — a paste the policy keeps is never announced as stripped', () => {
  it('says nothing for content entirely inside the policy', () => {
    const notify = vi.fn();
    const transform = makeBroadcastPasteTransform({ images: false, notify });
    const html = '<p><strong>Bold</strong> and <em>italic</em></p><ul><li>one</li></ul>';
    expect(transform(html)).toBe(html);
    expect(notify).not.toHaveBeenCalled();
  });

  it('says nothing when a kept link is merely hardened with rel/target', () => {
    const notify = vi.fn();
    const transform = makeBroadcastPasteTransform({ images: false, notify });
    const out = transform('<p><a href="https://swecham.example">Report</a></p>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('T101 — the image flag decides whether `<img>` is unsupported', () => {
  it('drops and announces an image when images are off', () => {
    const notify = vi.fn();
    const transform = makeBroadcastPasteTransform({ images: false, notify });
    expect(transform('<p><img src="https://x.example/a.png" alt="a"></p>')).not.toContain(
      '<img',
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps an http(s) image silently when images are on', () => {
    const notify = vi.fn();
    const transform = makeBroadcastPasteTransform({ images: true, notify });
    const out = transform('<img src="https://x.example/a.png" alt="a chart">');
    expect(out).toContain('<img');
    expect(out).toContain('alt="a chart"');
    expect(notify).not.toHaveBeenCalled();
  });
});
