/**
 * CSV field serialisation with RFC-4180 escaping + spreadsheet formula-injection
 * neutralisation.
 *
 * A CSV cell whose first character is `= + - @` (or a leading tab/CR) is
 * executed as a FORMULA by Excel / Google Sheets / LibreOffice when the file is
 * opened — so a user-controlled value like `=HYPERLINK(...)` or `=cmd|...` runs
 * on the analyst's machine. Any export that contains user-controlled strings
 * (names, free-text summaries, serialized payloads) must defang by prefixing a
 * single quote. Mirrors the F6 CSV-import sanitiser on the read side.
 */

/** True if `value` would be parsed as a formula by a spreadsheet app. */
export function isCsvFormulaInjection(value: string): boolean {
  return /^[=+\-@\t\r]/.test(value);
}

/**
 * Escape a single CSV field: neutralise a leading formula trigger (prefix `'`),
 * then always-quote + double any embedded quotes (RFC-4180).
 */
export function toCsvField(value: string): string {
  const neutralised = isCsvFormulaInjection(value) ? `'${value}` : value;
  return `"${neutralised.replace(/"/g, '""')}"`;
}
