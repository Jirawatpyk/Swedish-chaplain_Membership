export type MissingKeyRef = { readonly key: string; readonly line: number };

export function findMissingKeyRefs(
  _source: string,
  _enKeys: ReadonlySet<string>,
): MissingKeyRef[] {
  return [];
}
