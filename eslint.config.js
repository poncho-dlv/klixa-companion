import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

// Sous-ensemble à fort signal de sonarjs/recommended (même approche que Klixa) :
// on ne prend que les règles qui pointent presque toujours un vrai bug, pas un
// choix de style, pour éviter le bruit du préset complet sur ce codebase.
const bugRiskRules = {
  'sonarjs/no-identical-functions': 'error',
  'sonarjs/no-invariant-returns': 'error',
  'sonarjs/no-extra-arguments': 'error',
  'sonarjs/slow-regex': 'error', // ReDoS
  'sonarjs/cognitive-complexity': ['warn', 35], // refactor hors scope d'un lint-fix
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-undef': 'error',
};

// XSS statique : bloque toute assignation innerHTML/outerHTML/insertAdjacentHTML
// avec une valeur non littérale, sauf via un helper d'échappement explicite.
const noUnsanitizedRules = {
  'no-unsanitized/property': ['error', { escape: { methods: ['escapeHtml', 'EscapeHTML'] } }],
  'no-unsanitized/method': ['error', { escape: { methods: ['escapeHtml', 'EscapeHTML'] } }],
};

export default [
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'release/**',
      'coverage/**',
      '.jscpd/**',
      'rpi/**',
      'protocol/**',
    ],
  },
  {
    // src/**, scripts/*.mjs, desktop/main.js, desktop/config-store.js : vrais
    // modules ES Node (type: module dans package.json), imports explicites,
    // no-undef est fiable ici.
    files: ['src/**/*.js', 'scripts/**/*.mjs', 'desktop/main.js', 'desktop/config-store.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { sonarjs },
    rules: bugRiskRules,
  },
  {
    // preload.cjs : contexte Electron isolé, forcé en CommonJS (extension .cjs).
    files: ['desktop/preload.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { sonarjs },
    rules: bugRiskRules,
  },
  {
    // renderer.js : chargé en <script> classique (pas de bundler) dans la
    // fenêtre Electron, contexte navigateur. window.klixa est le pont exposé
    // par preload.cjs via contextBridge.
    files: ['desktop/renderer/renderer.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    plugins: { sonarjs, 'no-unsanitized': noUnsanitized },
    rules: { ...bugRiskRules, ...noUnsanitizedRules },
  },
];
