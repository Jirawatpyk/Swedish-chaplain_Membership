/**
 * T042 — Unit tests for `sanitize-html.ts` Application use-case.
 *
 * Authored ahead of T064 implementation per Constitution Principle II
 * TDD discipline. Initial state: 1 RED sanity test (use-case file
 * doesn't exist yet) + 30+ `it.todo(...)` placeholders documenting
 * the FR-002a allowlist behaviour the use-case MUST implement.
 *
 * Turns GREEN: T064 lands `src/modules/broadcasts/application/use-cases/sanitize-html.ts`
 * wrapping the `HtmlSanitizerPort` (DOMPurify adapter).
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/sanitize-html.ts',
);

describe('sanitize-html — RED skeleton (T042 — turns GREEN at T064)', () => {
  it('use-case module exists at application/use-cases/sanitize-html.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // FR-002a allowlist — passthrough cases (sanitiser must NOT strip)
  it.todo('passthrough <p>: paragraph tag preserved');
  it.todo('passthrough <br>: line break preserved');
  it.todo('passthrough <strong>, <em>, <u>: text-formatting tags preserved');
  it.todo('passthrough <a href="https://...">: link with allowed scheme');
  it.todo('passthrough <a href="mailto:...">: mailto scheme allowed');
  it.todo('passthrough <ul>, <ol>, <li>: list tags preserved');
  it.todo('passthrough <h1>–<h4>: heading levels preserved');
  it.todo('passthrough <blockquote>, <hr>: structural tags preserved');

  // FR-002a forbidden tags — sanitiser MUST strip
  it.todo('strips <script> tags entirely (XSS vector)');
  it.todo('strips <style> tags entirely (CSS injection)');
  it.todo('strips <iframe> tags entirely (frame-injection)');
  it.todo('strips <form> tags entirely (data exfiltration)');
  it.todo('strips <link>, <meta>, <base> tags entirely');
  it.todo('strips <object>, <embed>, <svg> tags entirely');
  it.todo('strips <img> tags entirely (Critique 2026-04-29 E9/X3 — tracking-pixel vector)');

  // FR-002a forbidden attributes — sanitiser MUST strip
  it.todo('strips on* event handlers (onclick, onerror, etc.)');
  it.todo('strips inline style="..." attributes');

  // URL scheme allowlist — sanitiser MUST reject non-allowed schemes
  it.todo('rejects javascript: URLs in <a href>');
  it.todo('rejects data: URLs in <a href>');
  it.todo('rejects file: URLs in <a href>');
  it.todo('rejects vbscript: URLs in <a href>');

  // Mixed payloads
  it.todo('strips <script> nested inside <p> while preserving the <p>');
  it.todo('strips comment-injected payloads (<!--<script>-->)');
  it.todo('handles deeply nested forbidden tags');
  it.todo('handles malformed HTML gracefully (DOMPurify default behaviour)');

  // Determinism (FR-002a determinism requirement)
  it.todo('determinism: same input produces identical output across runs');
  it.todo('determinism: idempotent — sanitise(sanitise(input)) === sanitise(input)');

  // Size cap (FR-002f — 200 KB body cap)
  it.todo('handles 200KB-sized HTML input within performance budget (<200ms)');

  // Empty / edge cases
  it.todo('returns empty string for empty input');
  it.todo('returns plain text unchanged when no HTML tags present');
});
