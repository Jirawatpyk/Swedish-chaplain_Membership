/**
 * Shared zod schemas for plan API route handlers.
 *
 * `planPathSchema` — validates the `[year]/[planId]` dynamic segment
 * pair. Previously redeclared identically in 4 route files.
 */

import { z } from 'zod';

export const planPathSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  planId: z.string().regex(/^[a-z0-9-]{1,63}$/, 'plan slug must match [a-z0-9-]{1,63}'),
});
