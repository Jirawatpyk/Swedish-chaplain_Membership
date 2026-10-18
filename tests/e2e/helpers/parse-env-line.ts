/**
 * Parse one dotenv line for `playwright.config.ts` (no dotenv dependency).
 *
 * - Blank lines, `#` comment lines and anything that is not `KEY=VALUE` →
 *   `null`. An `export ` prefix is accepted.
 * - A value starting with `"` or `'` is the text up to the matching closing
 *   quote; whatever follows it (an inline `# comment`) is ignored.
 * - An unquoted value ends at the first `#` that has whitespace before it, so
 *   `COLOR=#fff` and `a#b` survive and `3310   # port` reads `3310`.
 *
 * CI's local env file is a copy of the example file, whose lines carry inline
 * comments; keeping them made `CLAMAV_TIMEOUT_MS` NaN and failed collection
 * (e2e-critical run 39096465335).
 */
export function parseEnvLine(rawLine: string): { key: string; value: string } | null {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!match) return null;
  const key = match[1]!;
  const rest = match[2] ?? '';

  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const close = rest.indexOf(quote, 1);
    if (close > 0) return { key, value: rest.slice(1, close) };
  }
  const comment = /\s#/.exec(rest);
  return { key, value: (comment === null ? rest : rest.slice(0, comment.index)).trim() };
}
