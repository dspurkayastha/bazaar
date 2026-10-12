import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // web/ is the frontend, with its own toolchain (pnpm --dir web lint).
  { ignores: ['dist/**', 'node_modules/**', 'drizzle/**', 'data/**', '.claude/**', 'web/**', 'ios/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
