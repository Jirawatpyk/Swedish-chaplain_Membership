/**
 * #805 — exported spans never carry a URL credential. Next's request span sets
 * `http.target = req.url` (path and query), and `@vercel/otel`'s fetch spans
 * carry the full URL in their name, `http.url` and `url.full`. Reset,
 * invitation, verification and unsubscribe tokens ride in the path; the GDPR
 * export bearer and the renewal redeem link ride in the query; a Blob URL and
 * a heartbeat URL are capabilities by path.
 */
import { describe, expect, it } from 'vitest';

import { redactErrorTextSpanProcessor, redactUrl } from '@/lib/otel-redact-span-processor';

const TOKEN = 'Zq3xT9pLm2Kd8vRw5sYb1nHc';
const UUID = '0c4f3b1e-8a2d-4c6e-9f10-2b3c4d5e6f70';

function span(name: string, attributes: Record<string, unknown>) {
  return { name, attributes, status: { code: 1 }, events: [] as { name: string }[] };
}

function end<T>(s: T): T {
  redactErrorTextSpanProcessor.onEnd(s as never);
  return s;
}

describe('redactUrl (#805)', () => {
  it('drops the query and the fragment', () => {
    expect(redactUrl(`/api/internal/exports/job1/download?token=${TOKEN}#x`)).toBe('/api/internal/exports/job1/download');
  });

  it('replaces a credential-looking path segment and a uuid with :id', () => {
    expect(redactUrl(`/reset-password/${TOKEN}`)).toBe('/reset-password/:id');
    expect(redactUrl(`https://hc-ping.com/${UUID}/fail`)).toBe('https://hc-ping.com/:id/fail');
  });

  it('keeps ordinary segments and the origin', () => {
    expect(redactUrl('https://api.resend.com/emails')).toBe('https://api.resend.com/emails');
    expect(redactUrl('/api/cron/renewals/dispatch/swecham')).toBe('/api/cron/renewals/dispatch/swecham');
  });

  it('a Blob file name holding a uuid is redacted', () => {
    expect(redactUrl(`https://abc.public.blob.vercel-storage.com/invoicing/swecham/2025/${UUID}_v12.pdf?download=1`)).toBe(
      'https://abc.public.blob.vercel-storage.com/invoicing/swecham/2025/:id',
    );
  });

  it('an unparseable value reads unknown', () => {
    expect(redactUrl('http://[::1')).toBe('unknown');
    expect(redactUrl(42)).toBe('unknown');
  });
});

describe('redactErrorTextSpanProcessor URL attributes (#805)', () => {
  it('a request span takes http.route in place of http.target', () => {
    const s = end(span('GET /reset-password/[token]', { 'http.target': `/reset-password/${TOKEN}`, 'http.route': '/reset-password/[token]' }));
    expect(s.attributes['http.target']).toBe('/reset-password/[token]');
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it('a request span with no route keeps a redacted path', () => {
    const s = end(span('GET', { 'http.target': `/portal/renewal/redeem-link?t=${TOKEN}` }));
    expect(s.attributes['http.target']).toBe('/portal/renewal/redeem-link');
  });

  it('a fetch span loses the credential from its name, http.url, url.full and resource.name', () => {
    const url = `https://abc.public.blob.vercel-storage.com/invoicing/swecham/2025/${UUID}_receipt_v12.pdf?token=${TOKEN}`;
    const s = end(
      span(`fetch GET ${url}`, {
        'http.url': url,
        'url.full': url,
        'url.query': `token=${TOKEN}`,
        'resource.name': url.split('?')[0],
      }),
    );
    expect(s.name).toBe('fetch GET https://abc.public.blob.vercel-storage.com/invoicing/swecham/2025/:id');
    expect('url.query' in s.attributes).toBe(false);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(JSON.stringify(s)).not.toContain(UUID);
  });

  it('a span that breaks the redaction loses its URL attributes too', () => {
    const s = span(`fetch GET https://x.test/a?token=${TOKEN}`, { 'http.target': `/invite/${TOKEN}`, 'http.url': `https://x.test/a?token=${TOKEN}` }) as unknown as { events: unknown };
    s.events = 'not an array';
    end(s);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it('an ordinary span name and other attributes are untouched', () => {
    const s = end(span('GET /admin/members', { 'http.route': '/admin/members', 'next.route': '/admin/members' }));
    expect(s).toEqual(span('GET /admin/members', { 'http.route': '/admin/members', 'next.route': '/admin/members' }));
  });
});
