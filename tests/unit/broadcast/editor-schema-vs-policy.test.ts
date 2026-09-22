/**
 * F119 T088 / T013 (SC-011) — nothing typeable can produce a node the
 * sanitiser later removes.
 *
 * The editor's extension set and the server's DOMPurify allow-list are two
 * lists in two files that must agree. The docblock on `tiptap-editor.tsx` says
 * so ("Nothing typeable can produce a node the sanitiser later removes"), and
 * until this suite nothing checked it: a new extension — a table, a code
 * block, a `<figure>` wrapper — would be offered in the toolbar, survive the
 * preview, and vanish between the author's screen and the delivered email.
 * That is precisely the failure SC-011 forbids.
 *
 * Senior-tester review M2 derives both sides from the REAL artefacts:
 *   - the OUTPUT tags come from each node/mark's `toDOM`, which is what
 *     `editor.getHTML()` actually emits (`parseDOM` would over-report: the
 *     bold mark PARSES `<b>` and RENDERS `<strong>`);
 *   - the INPUT tags come from `parseDOM`, checked against the allow-list or
 *     against `INPUT_ONLY_ALIASES` — the tags the schema accepts on paste and
 *     normalises away on the way out.
 *
 * Positive control at the bottom: a fabricated extension registering
 * `<marquee>` MUST fail the same function. A check that cannot tell "nothing
 * to find" from "not looking" is not a check (CLAUDE.md § Gotchas).
 */
import { describe, expect, it } from 'vitest';
import { Editor, Node as TiptapNode } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { makeBroadcastEditorExtensions } from '@/components/broadcast/broadcast-editor-extensions';
import { makeBroadcastSanitizerConfig } from '@/lib/broadcast-content-policy';

/**
 * Tags the schema PARSES but never RENDERS — a paste of `<b>` becomes
 * `<strong>`, `<i>` becomes `<em>`. They are deliberately absent from the
 * sanitiser allow-list; listing them here is the statement that the
 * normalisation, not the allow-list, is what handles them.
 */
const INPUT_ONLY_ALIASES: Readonly<Record<string, string>> = {
  b: 'strong',
  i: 'em',
};

/** A sample attrs bag wide enough for every node the broadcast schema has. */
const SAMPLE_ATTRS = {
  level: 2,
  src: 'https://assets.example/x.png',
  alt: 'sample',
  href: 'https://example.test/go',
};

type DomOutputSpec = readonly unknown[] | { readonly dom: unknown };

function firstTag(spec: unknown): string | null {
  if (Array.isArray(spec) && typeof spec[0] === 'string') return spec[0];
  return null;
}

/** Every HTML tag `editor.getHTML()` can emit for this schema. */
export function outputTagsOf(schema: Schema): string[] {
  const tags = new Set<string>();
  for (const type of Object.values(schema.nodes)) {
    const toDOM = (type.spec as { toDOM?: (n: unknown) => DomOutputSpec }).toDOM;
    if (toDOM === undefined) continue; // doc, text — no DOM of their own
    const tag = firstTag(toDOM(type.createAndFill(SAMPLE_ATTRS)));
    if (tag !== null) tags.add(tag.toLowerCase());
  }
  for (const type of Object.values(schema.marks)) {
    const toDOM = (type.spec as { toDOM?: (m: unknown, inline: boolean) => DomOutputSpec })
      .toDOM;
    if (toDOM === undefined) continue;
    const tag = firstTag(toDOM(type.create(SAMPLE_ATTRS), true));
    if (tag !== null) tags.add(tag.toLowerCase());
  }
  return [...tags].sort();
}

/** Every HTML tag the schema will ACCEPT from a paste. */
export function inputTagsOf(schema: Schema): string[] {
  const tags = new Set<string>();
  const collect = (spec: { parseDOM?: readonly unknown[] | undefined }): void => {
    for (const rule of spec.parseDOM ?? []) {
      const tag = (rule as { tag?: string }).tag;
      if (typeof tag !== 'string') continue; // a `style` rule, not a tag
      // `img[src]:not([src^="data:"])` / `a[data-eb="cta"]` → the element name.
      const name = tag.split(/[[.:\s]/)[0] ?? '';
      if (name !== '') tags.add(name.toLowerCase());
    }
  };
  for (const type of Object.values(schema.nodes)) collect(type.spec);
  for (const type of Object.values(schema.marks)) collect(type.spec);
  return [...tags].sort();
}

function schemaOf(extraExtensions: ReadonlyArray<unknown> = []): Schema {
  const editor = new Editor({
    extensions: [
      ...makeBroadcastEditorExtensions({ images: true }),
      ...(extraExtensions as never[]),
    ],
    content: '<p>hello</p>',
  });
  const schema = editor.schema;
  editor.destroy();
  return schema;
}

const ALLOWED = makeBroadcastSanitizerConfig({ images: true }).ALLOWED_TAGS.map((t) =>
  t.toLowerCase(),
);

describe('M2 — the editor schema cannot produce what the sanitiser strips (SC-011)', () => {
  it('the derivation actually read a schema (an empty set must not read as a pass)', () => {
    const schema = schemaOf();
    const output = outputTagsOf(schema);
    expect(output.length).toBeGreaterThanOrEqual(10);
    // The ones the toolbar visibly offers, so a silently-emptied set fails.
    expect(output).toEqual(
      expect.arrayContaining(['p', 'strong', 'em', 'u', 'a', 'ul', 'ol', 'li', 'img']),
    );
    expect(ALLOWED.length).toBeGreaterThan(0);
  });

  it('every tag the editor can EMIT is in the sanitiser allow-list', () => {
    const emitted = outputTagsOf(schemaOf());
    const stripped = emitted.filter((tag) => !ALLOWED.includes(tag));
    expect(
      stripped,
      'the author would see these in the editor and the recipient would not — the exact SC-011 failure',
    ).toEqual([]);
  });

  it('every tag the editor can PARSE is allowed, or is a declared input-only alias', () => {
    const parsed = inputTagsOf(schemaOf());
    const unexplained = parsed.filter(
      (tag) => !ALLOWED.includes(tag) && INPUT_ONLY_ALIASES[tag] === undefined,
    );
    expect(
      unexplained,
      'a paste of this tag is accepted by the schema but has no allow-list entry and no declared normalisation',
    ).toEqual([]);
  });

  it('every declared input-only alias normalises to a tag that IS allowed (the map cannot rot)', () => {
    const parsed = inputTagsOf(schemaOf());
    for (const [alias, normalised] of Object.entries(INPUT_ONLY_ALIASES)) {
      expect(parsed, `${alias} is declared but the schema no longer parses it`).toContain(
        alias,
      );
      expect(ALLOWED).toContain(normalised);
    }
  });

  it('POSITIVE CONTROL — an extension registering <marquee> fails the same check', () => {
    const marquee = TiptapNode.create({
      name: 'marqueeBlock',
      group: 'block',
      content: 'inline*',
      parseHTML: () => [{ tag: 'marquee' }],
      renderHTML: () => ['marquee', 0],
    });
    const schema = schemaOf([marquee]);

    expect(outputTagsOf(schema)).toContain('marquee');
    expect(outputTagsOf(schema).filter((t) => !ALLOWED.includes(t))).toEqual(['marquee']);
    expect(
      inputTagsOf(schema).filter(
        (t) => !ALLOWED.includes(t) && INPUT_ONLY_ALIASES[t] === undefined,
      ),
    ).toEqual(['marquee']);
  });
});
