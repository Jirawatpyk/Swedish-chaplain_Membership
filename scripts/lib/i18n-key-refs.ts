/**
 * Code → en.json key-reference scanner for `check:i18n`.
 *
 * The rest of `check:i18n` proves the three locales agree with EACH OTHER. It
 * never walked from a call site to the catalogue, so `t('key')` with no such key
 * in en.json passed every gate — next-intl's default `getMessageFallback` returns
 * the raw dotted path instead of throwing, so the miss only shows up as
 * `admin.invoices.void.successWithNumberNoNotice` in front of a user. #377
 * shipped exactly that on a money-path warning toast: the copy existed in all
 * three locales, just under `admin.creditNotes.new`.
 *
 * Why a scanner and not `AppConfig['Messages']`: typing next-intl's messages
 * against en.json was measured on this tree (2026-09-24) — 136 type errors,
 * including TS2589/TS2590 (instantiation too deep / union too complex), and
 * `tsc --noEmit` went to ~5m43s. The catalogue is too large for the type-level
 * route.
 *
 * What it resolves, per file, on COMMENT-STRIPPED source:
 *   - bindings `const|let <name> = [await] useTranslations|getTranslations(…)`
 *     with a literal namespace, no namespace (root), or `{ …, namespace: '…' }`;
 *     any other argument (a variable, a ternary) makes the binding DYNAMIC;
 *   - calls `<name>('literal' …)`, `<name>.rich(…)`, `<name>.markup(…)` and
 *     `<name>.raw(…)` where `<name>` is a bound translator. Each call resolves to
 *     the NEAREST PRECEDING binding of that name, so two components in one file
 *     each get their own `t`.
 *
 * Deliberately NOT checked (skipped, never guessed): dynamic keys (variables,
 * template interpolation, concatenation, ternaries), calls through a DYNAMIC
 * binding, calls with no preceding binding (a `t` received as a parameter),
 * destructured bindings (`const [a, t] = await Promise.all([…])`), and
 * `t.has(…)`, which is a presence probe that is allowed to miss. A skipped call
 * can hide a miss; a guessed namespace would fail CI on correct code.
 */
import { lineOfIndex, stripCommentsPreserveLines } from './source-scan';

export type MissingKeyRef = { readonly key: string; readonly line: number };

type Binding = {
  readonly name: string;
  readonly offset: number;
  /** `null` = dynamic namespace; `''` = root translator. */
  readonly namespace: string | null;
};

const IDENT = '[A-Za-z_$][\\w$]*';

// `const t = useTranslations(` / `let tNav = await getTranslations(` — the
// argument list is parsed separately by `namespaceOf`. An optional type
// annotation between the name and `=` is tolerated.
const BINDING_RE = new RegExp(
  `\\b(?:const|let)\\s+(${IDENT})\\s*(?::[^=;]+)?=\\s*(?:await\\s+)?(?:useTranslations|getTranslations)\\(`,
  'g',
);

// `<name>(` or `<name>.rich|markup|raw(` followed by a single literal argument
// that ENDS at `,` or `)`. The terminator is what keeps `t('prefix.' + code)`
// and `t(cond ? 'a' : 'b')` out: neither literal is the whole argument.
const CALL_RE = new RegExp(
  `(?<![\\w$.])(${IDENT})(?:\\.(rich|markup|raw))?\\(\\s*(?:'([^'\\\\\\n]*)'|"([^"\\\\\\n]*)"|\`([^\`\\\\$]*)\`)\\s*[,)]`,
  'g',
);

/** Text between the `(` at `open` and its matching `)` (strings skipped). */
function argumentText(code: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i]!;
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

const LITERAL_ARG_RE = /^\s*(?:'([^'\\]*)'|"([^"\\]*)")\s*$/;
const OBJECT_ARG_RE = /^\s*\{([\s\S]*)\}\s*$/;
const NAMESPACE_PROP_RE = /\bnamespace\s*:\s*(?:'([^'\\]*)'|"([^"\\]*)")/;
const ANY_NAMESPACE_PROP_RE = /\bnamespace\b/;

function namespaceOf(arg: string): string | null {
  if (arg.trim() === '') return '';
  const literal = LITERAL_ARG_RE.exec(arg);
  if (literal) return literal[1] ?? literal[2] ?? '';
  const object = OBJECT_ARG_RE.exec(arg);
  if (object) {
    const body = object[1]!;
    const ns = NAMESPACE_PROP_RE.exec(body);
    if (ns) return ns[1] ?? ns[2] ?? '';
    // `{ locale, namespace }` shorthand or `namespace: someVar` → dynamic.
    return ANY_NAMESPACE_PROP_RE.test(body) ? null : '';
  }
  return null;
}

// Any other declaration of a name — a non-translator `const t = props.t`, a
// destructure, a parameter — SHADOWS the translator binding above it. Without
// this, a helper declared below a component that takes `t` as a parameter
// resolves to the component's namespace: the first run over the live tree
// flagged seven correct keys that way (renewals/row-actions.tsx, a `t` typed
// for `admin.renewals.sendReminderNow.toast` below a `useTranslations(
// 'admin.renewals.table')`). A shadow is DYNAMIC, so its calls are skipped;
// over-shadowing costs coverage, never a false failure.
const PLAIN_DECL_RE = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;]+)?=`, 'g');
const DESTRUCTURE_RE = /\b(?:const|let|var)\s*([[{])/g;
const TYPED_PARAM_RE = new RegExp(`[(,]\\s*(?:readonly\\s+)?(${IDENT})\\s*\\??\\s*:`, 'g');
const ARROW_PARAMS_RE = /\(([^()]*)\)\s*(?::[^=;{]+)?=>/g;
const BARE_ARROW_PARAM_RE = new RegExp(`(?<![\\w$.])(${IDENT})\\s*=>`, 'g');
const FUNCTION_PARAMS_RE = /\bfunction\b\s*\*?\s*[\w$]*\s*(?:<[^>]*>)?\s*\(([^()]*)\)/g;
const IDENT_RE = new RegExp(IDENT, 'g');

/** Offset just past the bracket that closes the one at `open`. */
function closingBracket(code: string, open: number): number {
  const pairs: Record<string, string> = { '[': ']', '{': '}' };
  const close = pairs[code[open]!]!;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === code[open]) depth += 1;
    else if (code[i] === close && --depth === 0) return i + 1;
  }
  return code.length;
}

function collectBindings(code: string): Binding[] {
  const out: Binding[] = [];
  const translatorAt = new Set<number>();
  for (const m of code.matchAll(BINDING_RE)) {
    const open = m.index + m[0].length - 1;
    const arg = argumentText(code, open);
    translatorAt.add(m.index);
    out.push({
      name: m[1]!,
      offset: m.index,
      namespace: arg === null ? null : namespaceOf(arg),
    });
  }
  const names = new Set(out.map((b) => b.name));
  if (names.size === 0) return out;

  const shadow = (name: string, offset: number): void => {
    if (names.has(name)) out.push({ name, offset, namespace: null });
  };
  const shadowAll = (text: string, offset: number): void => {
    for (const id of text.matchAll(IDENT_RE)) shadow(id[0], offset);
  };

  for (const m of code.matchAll(PLAIN_DECL_RE)) {
    if (!translatorAt.has(m.index)) shadow(m[1]!, m.index);
  }
  for (const m of code.matchAll(DESTRUCTURE_RE)) {
    const open = m.index + m[0].length - 1;
    shadowAll(code.slice(open, closingBracket(code, open)), m.index);
  }
  for (const m of code.matchAll(TYPED_PARAM_RE)) shadow(m[1]!, m.index);
  for (const m of code.matchAll(ARROW_PARAMS_RE)) shadowAll(m[1]!, m.index);
  for (const m of code.matchAll(BARE_ARROW_PARAM_RE)) shadow(m[1]!, m.index);
  for (const m of code.matchAll(FUNCTION_PARAMS_RE)) shadowAll(m[1]!, m.index);

  return out.sort((a, b) => a.offset - b.offset);
}

function hasKeyOrSubtree(enKeys: ReadonlySet<string>, key: string): boolean {
  if (enKeys.has(key)) return true;
  const prefix = `${key}.`;
  for (const k of enKeys) if (k.startsWith(prefix)) return true;
  return false;
}

export type KeyRefScan = {
  /** Calls resolved to a namespace and checked against en.json. */
  readonly checked: number;
  readonly missing: readonly MissingKeyRef[];
  /** The full key of every checked call, present or not. */
  readonly resolved: readonly string[];
};

/**
 * Every statically resolvable translation call in `source`, checked against
 * `enKeys` (flattened dotted en.json keys). `t.raw` may name a subtree; every
 * other call must name a leaf message. `checked` feeds the gate's floor guard:
 * a scanner that silently resolves nothing would otherwise report OK.
 */
export function scanKeyRefs(source: string, enKeys: ReadonlySet<string>): KeyRefScan {
  const code = stripCommentsPreserveLines(source);
  const bindings = collectBindings(code);
  const names = new Set(bindings.filter((b) => b.namespace !== null).map((b) => b.name));
  if (names.size === 0) return { checked: 0, missing: [], resolved: [] };

  const resolved: string[] = [];
  const missing: MissingKeyRef[] = [];
  for (const m of code.matchAll(CALL_RE)) {
    const name = m[1]!;
    if (!names.has(name)) continue;
    let binding: Binding | undefined;
    for (const b of bindings) {
      if (b.offset >= m.index) break;
      if (b.name === name) binding = b;
    }
    if (!binding || binding.namespace === null) continue;

    const literal = m[3] ?? m[4] ?? m[5]!;
    const key = binding.namespace ? `${binding.namespace}.${literal}` : literal;
    const ok = m[2] === 'raw' ? hasKeyOrSubtree(enKeys, key) : enKeys.has(key);
    resolved.push(key);
    if (!ok) missing.push({ key, line: lineOfIndex(code, m.index) + 1 });
  }
  return { checked: resolved.length, missing, resolved };
}

/** The `missing` half of {@link scanKeyRefs}. */
export function findMissingKeyRefs(
  source: string,
  enKeys: ReadonlySet<string>,
): readonly MissingKeyRef[] {
  return scanKeyRefs(source, enKeys).missing;
}

// ---------------------------------------------------------------------------
// Orphan-key scan (`check:i18n --orphans`, advisory — never fails CI).
//
// It used to pool every file's namespaces and every file's `t('…')` literals
// into two repo-wide lists, so a namespace from one file plus a suffix from
// ANOTHER counted as a reference — which is how #377's misplaced
// `admin.creditNotes.new.successWithNumberNoNotice` looked used (the credit-note
// form declared the namespace, the void dialog called the suffix). Pairing is
// now per file, and every call `scanKeyRefs` resolves (a `tNav('home')`
// included, which the literal-`t` regex never saw) counts as a reference.
// ---------------------------------------------------------------------------

const ORPHAN_T_CALL_RE = /\bt\(\s*['"]([\w.\-]+)['"]/g;
const ORPHAN_NS_RE = /(?:getTranslations|useTranslations)\(\s*['"]([\w.\-]+)['"]/g;
// A dotted string literal anywhere else in the file: a namespace or key held as
// DATA (`dialogNamespace: 'admin.broadcasts.cancelDialog'`, a status → key map).
const DOTTED_LITERAL_RE = /['"`]([A-Za-z][\w-]*(?:\.[\w-]+)+)['"`]/g;

/** `a.b.c` → `a`, `a.b`. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf('.'); i !== -1; i = path.indexOf('.', i + 1)) {
    out.push(path.slice(0, i));
  }
  return out;
}

/**
 * en.json keys that no source file references, for the advisory
 * `check:i18n --orphans` report. `sources` is the text of every scanned file.
 *
 * A key counts as referenced when some path P was referenced and the key is P,
 * lies under P (a parent called for dynamic composition, `t('labels')` then
 * `` t(`labels.${s}`) ``), or is an ancestor of P. P comes from, per file:
 * every call `scanKeyRefs` resolves; every literal `t('x')` taken as a full
 * key; every literal `t('x')` joined to each namespace bound in THAT file; and
 * every other dotted string literal (a namespace or key held as data). The
 * `useTranslations`/`getTranslations` arguments themselves are NOT taken as
 * data — a bound namespace refers to its keys only through that file's calls,
 * which is the whole #377 fix.
 * Anything it cannot see (dynamic keys, a `t` passed across files) still
 * reads as a candidate, so the report stays advisory.
 */
export function findOrphanKeys(sources: readonly string[], enKeys: ReadonlySet<string>): string[] {
  const referenced = new Set<string>();
  for (const source of sources) {
    for (const key of scanKeyRefs(source, enKeys).resolved) referenced.add(key);
    const code = stripCommentsPreserveLines(source);
    const literals = [...code.matchAll(ORPHAN_T_CALL_RE)].map((m) => m[1]!);
    const namespaces = [...code.matchAll(ORPHAN_NS_RE)].map((m) => m[1]!);
    for (const literal of literals) {
      referenced.add(literal);
      for (const ns of namespaces) referenced.add(`${ns}.${literal}`);
    }
    for (const m of code.replace(ORPHAN_NS_RE, '').matchAll(DOTTED_LITERAL_RE)) {
      referenced.add(m[1]!);
    }
  }

  const referencedAncestors = new Set<string>();
  for (const path of referenced) for (const a of ancestors(path)) referencedAncestors.add(a);

  const orphans: string[] = [];
  for (const key of enKeys) {
    if (referenced.has(key) || referencedAncestors.has(key)) continue;
    if (ancestors(key).some((a) => referenced.has(a))) continue;
    orphans.push(key);
  }
  return orphans.sort();
}
