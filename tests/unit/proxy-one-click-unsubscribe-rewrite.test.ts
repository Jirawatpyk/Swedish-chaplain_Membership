/**
 * RFC 8058 one-click unsubscribe: mail clients POST to the SAME URL as the
 * `List-Unsubscribe` header (`/unsubscribe/<token>`). Next.js cannot host a
 * page and a route handler in one segment, so the proxy rewrites that POST
 * to `/api/unsubscribe/<token>`. GET keeps rendering the page.
 */
import { describe, expect, it } from 'vitest';
import { matchesF7KillSwitchPath, oneClickUnsubscribeRewriteTarget } from '@/proxy';

describe('oneClickUnsubscribeRewriteTarget', () => {
  it('rewrites POST /unsubscribe/<token> to the API handler', () => {
    expect(oneClickUnsubscribeRewriteTarget('POST', '/unsubscribe/v1.abc.def')).toBe(
      '/api/unsubscribe/v1.abc.def',
    );
  });

  it('leaves GET (the page) and every other path alone', () => {
    expect(oneClickUnsubscribeRewriteTarget('GET', '/unsubscribe/v1.abc.def')).toBeNull();
    expect(oneClickUnsubscribeRewriteTarget('HEAD', '/unsubscribe/v1.abc.def')).toBeNull();
    expect(oneClickUnsubscribeRewriteTarget('POST', '/unsubscribe')).toBeNull();
    expect(oneClickUnsubscribeRewriteTarget('POST', '/unsubscribe/a/b')).toBeNull();
    expect(oneClickUnsubscribeRewriteTarget('POST', '/api/unsubscribe/v1.abc.def')).toBeNull();
  });

  it('the API handler sits behind the F7 kill switch', () => {
    expect(matchesF7KillSwitchPath('/api/unsubscribe/v1.abc.def')).toBe(true);
  });
});
