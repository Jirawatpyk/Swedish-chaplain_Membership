/**
 * Client-safe public entry for the insights module.
 *
 * `'use client'` components (e.g. `DirectoryVisibilityForm`) need the pure
 * directory-listing constants/types but MUST NOT import them from the module's
 * index barrel (`@/modules/insights`) — the barrel re-exports infrastructure +
 * application code that transitively pulls server-only runtime (postgres → fs/
 * net, `@node-rs/argon2`, `pino` → worker_threads, `revalidateTag`) into the
 * browser bundle and 500s the page.
 *
 * This entry re-exports ONLY the dependency-free domain values, so any client
 * component can import them without dragging server code along. It is a
 * module-root entry (not a deep `domain/`·`application/`·`infrastructure/`
 * import), so it satisfies the Principle III barrel ESLint rule.
 */
export {
  DIRECTORY_FIELDS,
  DEFAULT_FIELD_VISIBILITY,
  MAX_DIRECTORY_DESCRIPTION_LENGTH,
  type DirectoryField,
  type FieldVisibility,
} from './domain/directory-listing';
