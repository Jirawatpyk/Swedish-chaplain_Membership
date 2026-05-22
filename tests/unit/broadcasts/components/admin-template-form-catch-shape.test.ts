/**
 * R8.6 L-7 (R7 senior-tester) — lock the catch-block log shape on
 * `admin-template-form.tsx` so a future refactor that returns to
 * logging the raw `err` object (which can serialize request bodies
 * via `.cause`) is caught by the test suite.
 *
 * R6.5 L-8 constrained the shape to explicit `errName` / `errMessage`
 * / `errStack` fields. Pre-R6.5 used `{err, mode}` which would
 * serialise `err.cause` chains (request body, form data) into the
 * DevTools console — low-risk PII-leak vector.
 *
 * This test is a STATIC source-scan: it reads `template-form.tsx`
 * and asserts the `console.error('broadcasts.template.form.submit_failed', ...)`
 * payload references `errName` + `errMessage` + `errStack` literally.
 * Source-scan is robust against React 19 testing-library quirks
 * (component is server-side / behind useTransition) and doesn't
 * require booting jsdom + a fetch mock.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORM_PATH = join(
  process.cwd(),
  'src/components/broadcast/admin/template-form.tsx',
);

describe('admin-template-form catch-block log shape — R8.6 L-7', () => {
  const source = readFileSync(FORM_PATH, 'utf8');

  it('console.error submit_failed payload constrains to errName + errMessage + errStack (no raw err)', () => {
    // Find the submit_failed console.error block.
    const idx = source.indexOf('broadcasts.template.form.submit_failed');
    expect(idx).toBeGreaterThan(0);
    // Capture a window of ~600 chars around the log site — enough to
    // span the full payload object literal.
    const window = source.slice(idx, idx + 600);
    // Required explicit fields (R6.5 L-8 contract).
    expect(window).toMatch(/errName:/);
    expect(window).toMatch(/errMessage:/);
    expect(window).toMatch(/errStack:/);
    // Forbidden raw-err spread — the entire shape MUST NOT log
    // `err` as a top-level object property, which would serialize
    // `err.cause` chains.
    // The regex matches `{ err,` or `{ err }` or `err: err` etc.
    // The negation here is: the substring `err,` or `err }` should
    // NOT appear in the immediate payload literal context.
    const payloadStart = window.indexOf('{');
    const payloadEnd = window.indexOf('}', payloadStart);
    expect(payloadStart).toBeGreaterThan(-1);
    expect(payloadEnd).toBeGreaterThan(payloadStart);
    const payload = window.slice(payloadStart, payloadEnd + 1);
    // Block: `err,` or `err\s*}` (top-level raw-err spread).
    expect(payload).not.toMatch(/\berr\s*,/);
    expect(payload).not.toMatch(/\berr\s*}/);
  });

  it('error_body_parse_failed log (early in catch chain) — bounded payload', () => {
    // Sibling log site at lines ~118-130. The original R3.5 M-11
    // shape included `err.message` (not the raw err object), so the
    // PII-leak risk is bounded. Lock that shape too.
    const idx = source.indexOf('broadcasts.template.form.error_body_parse_failed');
    expect(idx).toBeGreaterThan(0);
    const window = source.slice(idx, idx + 600);
    // Existing shape: `err: parseErr instanceof Error ? parseErr.message : String(parseErr)`
    expect(window).toMatch(/parseErr instanceof Error/);
    expect(window).toMatch(/parseErr\.message/);
  });
});
