/**
 * T047 — Integration test for HTML sanitiser at the Application boundary.
 *
 * Asserts the FR-002a strict-allowlist is enforced when broadcasts are
 * persisted: the raw editor output is NEVER stored — only the sanitised
 * version reaches `broadcasts.body_html`. Defence-in-depth pairs with
 * the body_html_size CHECK constraint from migration 0064.
 *
 * Turns GREEN: T058 (DOMPurify Infrastructure adapter) + T064
 * (sanitize-html.ts use-case) + T076 (POST /api/broadcasts/submit
 * route handler) all land.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const sanitiserAdapterPath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer.ts',
);
const useCasePath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/application/use-cases/sanitize-html.ts',
);

describe('html-sanitiser integration — RED skeleton (T047 — turns GREEN at T058 + T064 + T076)', () => {
  it('DOMPurify adapter exists at infrastructure/sanitizer/dompurify-sanitizer.ts', async () => {
    await expect(access(sanitiserAdapterPath)).resolves.toBeUndefined();
  });

  it('sanitize-html use-case exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // 30+ payload set per FR-002a (executed via real submit-broadcast use-case
  // against live Neon)
  it.todo('payload <p>OK</p> persists as <p>OK</p> (passthrough)');
  it.todo('payload <script>alert(1)</script>OK strips to OK (script removed)');
  it.todo('payload <img src=x onerror=alert(1)> strips to empty (img removed entirely per E9/X3)');
  it.todo('payload <a href="javascript:alert(1)">x</a> strips href + leaves <a>x</a> OR removes entirely');
  it.todo('payload <iframe src=...></iframe> strips entirely');
  it.todo('payload nested <script> inside <p> strips script + preserves <p>');
  it.todo('payload <a href="https://...">link</a> preserves intact');
  it.todo('payload <a href="mailto:...">link</a> preserves intact');
  it.todo('payload <style>.foo{}</style> strips entirely');
  it.todo('payload onclick attribute on <p onclick="...">x</p> strips on*');
  it.todo('payload inline style="..." attribute stripped');
  it.todo('payload data: URL in href stripped');
  it.todo('payload vbscript: URL in href stripped');
  it.todo('payload deeply-nested <script><script>...</script></script> strips both');
  it.todo('payload comment-injected <!--<script>--> strips');
  // Persistence assertion — DB-level
  it.todo('post-submit DB query SELECT body_html FROM broadcasts returns sanitised, NEVER raw');
  it.todo('body_source column retains the raw editor JSON (separate column)');
  // Determinism (FR-002a)
  it.todo('idempotent: sanitise(sanitise(x)) === sanitise(x)');
  it.todo('deterministic: same payload across 100 invocations produces same output');
  // Performance (SLO-F7-002 — submit p95 < 1.2s including sanitiser cost)
  it.todo('200KB body sanitised within 200ms (sanitiser portion of submit budget)');
});
