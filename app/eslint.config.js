// Flat ESLint config for Glyphforge.
// The whole app is ESM (package.json "type": "module").

import js from '@eslint/js';
import react from 'eslint-plugin-react';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'src/data/**',
      'data/**',
      '*.min.js',
    ],
  },

  js.configs.recommended,

  // Node-side files (Express server, build configs).
  {
    files: ['server.js', 'auth-store.js', 'vite.config.js', 'eslint.config.js', 'lib/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // server.js intentionally rejects control characters in path validators.
      'no-control-regex': 'off',
    },
  },

  // Browser-side React app.
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
      },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
