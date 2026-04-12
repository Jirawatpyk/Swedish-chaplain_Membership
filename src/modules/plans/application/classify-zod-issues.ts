/**
 * Shared Zod issue classifier for plan create + update use cases.
 *
 * Heuristic: issues whose path touches the corporate ↔ partnership
 * integrity rules fall into the 422 `partnership_corporate_mismatch`
 * bucket; everything else is a shape fault → 400 `invalid_body`.
 */

const INTEGRITY_PATHS = new Set<string>([
  'includes_corporate_plan_id',
  'benefit_matrix.partnership',
]);

export function classifyZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
):
  | {
      readonly kind: 'shape';
      readonly details: ReadonlyArray<{ path: string; message: string }>;
    }
  | {
      readonly kind: 'integrity';
      readonly details: ReadonlyArray<string>;
    } {
  const shape: Array<{ path: string; message: string }> = [];
  const integrity: string[] = [];
  for (const issue of issues) {
    const path = issue.path.join('.');
    if (INTEGRITY_PATHS.has(path)) {
      integrity.push(issue.message);
    } else {
      shape.push({ path, message: issue.message });
    }
  }
  if (shape.length === 0 && integrity.length > 0) {
    return { kind: 'integrity', details: integrity };
  }
  return { kind: 'shape', details: shape };
}
