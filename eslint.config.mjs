import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'

// The monorepo's base rules, minus its React and local rules.
export default tseslint.config(
  { ignores: ['**/node_modules', '**/dist', 'python/**'] },
  tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      // underscore prefix = intentionally unused
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // scripts and tests: inferred return types are fine
    files: ['**/*.mjs', '**/test/**', '**/__tests__/**', '**/*.test.ts'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
)
