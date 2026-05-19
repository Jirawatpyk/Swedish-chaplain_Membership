/**
 * Unit tests for `redactStack` (round-8 R8 review fix — closes the
 * I-2 critical gap: previously the module had zero tests, so the
 * round-6 W2 PII scrubber + round-7 R2-C container-path extension
 * could silently regress).
 *
 * Coverage:
 *   • All 12 prefix alternation segments (var/usr/home/opt/tmp/root/
 *     users/private/node_modules + R7-C additions: srv/data/run)
 *   • Windows drive-letter prefix (`C:\Users\...`)
 *   • `webpack-internal:///` URLs (Next.js dev bundler)
 *   • `file://` URLs (Node ESM imports)
 *   • STACK_CAP 4_000-char enforcement
 *   • `undefined` input → `undefined` (early-return invariant)
 *   • Multi-line stack with mixed prefixes — every line redacted
 */
import { describe, it, expect } from 'vitest';
import { redactStack } from '@/lib/redact-stack';

describe('redactStack — container path scrubbing', () => {
  it('redacts /var/ paths (Vercel sin1 default `/var/task/...`)', () => {
    const stack = `Error: boom\n    at fn (/var/task/app/route.js:42:7)`;
    const out = redactStack(stack);
    expect(out).toContain('[redacted-path]');
    expect(out).not.toContain('/var/task/app/route.js');
  });

  it.each([
    ['/usr/', 'at fn (/usr/lib/node/x.js:1:1)'],
    ['/home/', 'at fn (/home/jirawat/proj/src/x.js:1:1)'],
    ['/opt/', 'at fn (/opt/render/srv.js:1:1)'],
    ['/tmp/', 'at fn (/tmp/build-cache/x.js:1:1)'],
    ['/root/', 'at fn (/root/.npm/x.js:1:1)'],
    ['/users/', 'at fn (/users/dev/code/x.js:1:1)'],
    ['/private/', 'at fn (/private/var/folders/x.js:1:1)'],
    ['/node_modules/', 'at fn (/node_modules/pino/lib/x.js:1:1)'],
    // R7-C additions — Docker /srv/, K8s PVC /data/, systemd /run/
    ['/srv/', 'at fn (/srv/app/dist/x.js:1:1)'],
    ['/data/', 'at fn (/data/postgres/x.js:1:1)'],
    ['/run/', 'at fn (/run/secrets/x.js:1:1)'],
  ])('redacts %s prefix', (_prefix, line) => {
    const out = redactStack(line);
    expect(out).toContain('[redacted-path]');
    // R7-C regression guard — the literal raw path must not survive.
    const rawPath = line.split('(')[1]?.split(':')[0] ?? '';
    expect(out).not.toContain(rawPath);
  });

  it('redacts Windows drive-letter paths (`C:\\Users\\...`)', () => {
    const stack = `Error: x\n    at fn (C:\\Users\\Jirawat\\code\\src\\x.ts:1:1)`;
    const out = redactStack(stack);
    expect(out).toContain('[redacted-path]');
    expect(out).not.toContain('C:\\Users\\Jirawat');
  });

  it('redacts webpack-internal:/// URLs', () => {
    const stack = `Error: x\n    at fn (webpack-internal:///./src/x.ts:1:1)`;
    const out = redactStack(stack);
    expect(out).toContain('[redacted-webpack-internal]');
    expect(out).not.toContain('webpack-internal:///./src/x.ts');
  });

  it('redacts file:// URLs', () => {
    const stack = `Error: x\n    at fn (file:///path/to/x.js:1:1)`;
    const out = redactStack(stack);
    expect(out).toContain('[redacted-file-url]');
    expect(out).not.toContain('file:///path/to/x.js');
  });

  it('redacts every line of a multi-line mixed-prefix stack', () => {
    const stack = [
      'Error: boom',
      '    at fn1 (/var/task/x.js:1:1)',
      '    at fn2 (/private/var/folders/y.js:2:2)',
      '    at fn3 (/srv/app/z.js:3:3)',
      '    at fn4 (webpack-internal:///./src/w.ts:4:4)',
    ].join('\n');
    const out = redactStack(stack);
    expect(out).not.toContain('/var/task/x.js');
    expect(out).not.toContain('/private/var/folders/y.js');
    expect(out).not.toContain('/srv/app/z.js');
    expect(out).not.toContain('webpack-internal:///./src/w.ts');
    // The error header itself is preserved.
    expect(out).toContain('Error: boom');
  });
});

describe('redactStack — boundary conditions', () => {
  it('returns undefined when input is undefined (early-return invariant)', () => {
    expect(redactStack(undefined)).toBeUndefined();
  });

  it('returns an empty string unchanged', () => {
    expect(redactStack('')).toBe('');
  });

  it('returns a string with no redactable patterns unchanged (modulo cap)', () => {
    const stack = 'Error: x\n    at <anonymous>';
    expect(redactStack(stack)).toBe(stack);
  });

  it('caps output at STACK_CAP (4_000 chars)', () => {
    // Build a long stack that, after redaction, still exceeds 4000
    // chars. Use a non-redactable line to avoid all-redacted output.
    const filler = '    at noop\n'.repeat(500); // ~6000 chars
    const out = redactStack(`Error: x\n${filler}`);
    expect(out).toBeDefined();
    expect((out ?? '').length).toBeLessThanOrEqual(4_000);
  });
});
