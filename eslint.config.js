import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Build output and generated files.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      '**/*.d.mts',
      '.weave-dev/**',
      '.claude/**',
    ],
  },

  js.configs.recommended,

  // Type-aware linting. `projectService` finds the nearest tsconfig per file.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config and build scripts that belong to no workspace's program.
          allowDefaultProject: [
            'bump.config.ts',
            'apps/*/vite.config.ts',
            'packages/cli/build.ts',
            'packages/cli/pay/walletconnect.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A switch over a union handles every member, so a new member is a compile error.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      // Adapters implement Promise-returning interfaces; `async` keeps a throw a rejection.
      '@typescript-eslint/require-await': 'off',
    },
  },

  // No `any`, no casts, no enums.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // `unknown` and a type guard instead.
      '@typescript-eslint/no-explicit-any': 'error',
      // `satisfies` or a guard instead of `as Foo`; `as const` is still allowed.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      // `const X = [...] as const` and `(typeof X)[number]` instead.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Avoid `enum`. Use `const X = [...] as const` and derive `type X = (typeof X)[number]`.',
        },
      ],
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Tests run under `node:test`, which awaits the promise `test()` returns itself.
  {
    files: ['**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  {
    files: ['**/*.{jsx,tsx}'],
    ...react.configs.flat.recommended,
    ...react.configs.flat['jsx-runtime'],
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },

  // Plain JS gets no TypeScript program.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Last: turn off every rule that conflicts with Prettier.
  prettier,
);
