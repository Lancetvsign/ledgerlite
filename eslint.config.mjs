import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

/**
 * LedgerLite ESLint configuration.
 *
 * Rules here are chosen for CORRECTNESS and SECURITY, not style. We deliberately
 * do not add stylistic rules — formatting noise trains reviewers to skim, and this
 * codebase needs reviewers who read.
 *
 * Type-aware linting is enabled (`projectService`). It is the reason TypeScript is
 * pinned below 7.x — see docs/DECISIONS.md ADR-009.
 */
/**
 * no-restricted-syntax selectors for src/** — composed in ONE place because a
 * later flat-config block REPLACES this rule rather than merging it; two blocks
 * configuring it for overlapping files silently drop one set of selectors
 * (which is exactly how the dynamic-import fence shipped inert the first time).
 */
const RESTRICTED_SYNTAX = [
  {
    selector:
      "BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/^(OWNER|ADMIN|BOOKKEEPER|ACCOUNTANT|READ_ONLY)$/]",
    message:
      'Do not compare role names in business code. Ask about a capability instead: ' +
      "roleHasCapability(role, 'journal.post'). See src/server/rbac.",
  },
  {
    selector:
      "SwitchCase > Literal[value=/^(OWNER|ADMIN|BOOKKEEPER|ACCOUNTANT|READ_ONLY)$/]",
    message:
      'Do not switch on role names in business code. Ask about a capability instead. ' +
      'See src/server/rbac.',
  },
  {
    // The static no-restricted-imports fence misses dynamic import(); closed
    // after the Gate 1 security review flagged the gap.
    selector: 'ImportExpression > Literal[value=/internal/]',
    message:
      'Dynamic import of repository internals is fenced — use the authorized wrapper. See LL-014.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'next-env.d.ts',
      'drizzle/migrations/**',
    ],
  },

  ...nextCoreWebVitals,

  // Type-aware rules for our own TypeScript source.
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* --- Async correctness. ---------------------------------------------
         The highest-value rules in this file. An un-awaited transaction returns
         before the posting completes while the caller believes it succeeded —
         exactly the class of silent financial defect this project exists to
         prevent. These are errors, never warnings. */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      /* --- Type honesty. --------------------------------------------------
         `any` disables every other guarantee in this file. Where it is genuinely
         unavoidable, disable the rule inline WITH a reason on the line above. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
      ],

      /* --- Exhaustiveness. ------------------------------------------------
         Account types, entry statuses, and source types are unions. Adding a
         variant must break the build everywhere it is handled, not default
         silently to some fallback branch. */
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      /* --- Dead code. ----------------------------------------------------- */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      /* --- Import hygiene, paired with verbatimModuleSyntax. --------------- */
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
    },
  },

  /* --- ADR-001 boundary. -------------------------------------------------
     The Neon HTTP driver's `.transaction()` exists and typechecks, then throws
     at runtime. The type system cannot catch its misuse, so lint does.
     Financial write paths use `dbTx` (Pool) exclusively.

     This rule is active before src/server/ledger/ exists, so the boundary holds
     from the first line written there rather than being retrofitted. */
  {
    files: ['src/server/ledger/**/*.ts', 'src/server/ledger/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'drizzle-orm/neon-http',
              message:
                'Financial write paths must use the Pool client (drizzle-orm/neon-serverless). ' +
                'The HTTP driver does not support interactive transactions — it throws at ' +
                'runtime, not compile time. See docs/DECISIONS.md ADR-001.',
            },
          ],
          patterns: [
            {
              group: ['**/db/http', '**/db/http.*'],
              message:
                'Import { dbTx } from the database module, not the HTTP client. See ADR-001.',
            },
          ],
        },
      ],
    },
  },

  /* --- LL-014 fence. ------------------------------------------------------
     Raw repository operations (…/internal.ts) are unauthorized by default —
     the adversarial pass showed insertMembership is a cross-tenant takeover if
     a route ever reaches it. Routes and pages cannot import them. */
  {
    files: ['src/app/**/*.ts', 'src/app/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/*/internal', '**/server/*/internal'],
              message:
                'Unauthorized repository internals cannot be used from routes or pages. ' +
                'Call the authorized wrapper in the module root instead. See LL-014.',
            },
          ],
        },
      ],
      // The static rule above misses dynamic import(). Closed after the Gate 1
      // security review flagged the gap.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportExpression > Literal[value=/server\u002f[^\u002f]+\u002finternal/]",
          message:
            'Dynamic import of repository internals from routes/pages is fenced. See LL-014.',
        },
      ],
    },
  },

  /* --- LL-012 boundary. ---------------------------------------------------
     Business code asks about CAPABILITIES, never role names. A role-name
     comparison outside the rbac module is a permission decision hiding where
     nobody will find it. Assignments (role: 'OWNER') stay legal — creating a
     membership needs the name; BRANCHING on it is what scatters policy. */
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
    },
  },
  {
    // The two places role names legitimately live: the model that defines what
    // they mean, and the schema that stores them.
    files: ['src/server/rbac/**', 'src/db/schema/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  /* Config files run in Node and are not part of the app's type program. */
  {
    files: ['*.mjs', '*.js', '*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
