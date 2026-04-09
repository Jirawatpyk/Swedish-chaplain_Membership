/**
 * Conventional Commits enforcement per CLAUDE.md § Conventions.
 * Allows `[Spec Kit]` prefix for Spec Kit workflow commits
 * (e.g., "[Spec Kit] Add specification"), bypassing the type rule.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  ignores: [(commit) => commit.startsWith('[Spec Kit]')],
  rules: {
    'body-max-line-length': [1, 'always', 120],
    'footer-max-line-length': [1, 'always', 120],
    'subject-case': [0],
  },
};
