// Cœur i18n partagé (main Electron, renderer, intégrations) — inspiré du système de
// l'app Klixa (admin/js/core/i18n.js) : dictionnaires JS plats, pas de dépendance
// externe, aucune étape de build. Ce module est un fichier ESM pur (aucune API
// Electron/Node/DOM) : il est importé tel quel depuis le process main (desktop/main.js),
// le renderer (desktop/renderer/renderer.js, chargé en <script type="module">) et les
// intégrations (src/integrations/*.js), qui partagent ainsi les mêmes traductions sans
// duplication.
//
// Chaque process JS (main Electron, renderer, CLI `node src/index.js`) obtient sa PROPRE
// instance de ce module (réalités d'exécution distinctes même si le fichier sur disque
// est identique) : la langue courante (`currentLanguage`) est donc un état par process,
// à initialiser une fois via setLanguage() (cf. desktop/main.js et
// desktop/renderer/renderer.js). Par défaut, avant tout appel à setLanguage(), la langue
// système est utilisée (détection via Intl, universelle Node/Chromium).
import fr from './fr.js';
import en from './en.js';

const DICTIONARIES = { fr, en };

function detectSystemLanguage() {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    return locale.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}

// `configured` est le réglage LANGUAGE persisté (config.json côté desktop) :
// 'fr'/'en' explicite prime, 'system'/absent retombe sur la langue système.
export function resolveLanguage(configured) {
  if (configured === 'fr' || configured === 'en') return configured;
  return detectSystemLanguage();
}

let currentLanguage = detectSystemLanguage();

export function setLanguage(lang) {
  currentLanguage = lang === 'fr' ? 'fr' : 'en';
}

export function getLanguage() {
  return currentLanguage;
}

function resolvePath(dict, key) {
  return key.split('.').reduce((node, part) => (
    node && typeof node === 'object' ? node[part] : undefined
  ), dict);
}

/**
 * Traduit `key` (chemin en points, ex. 'settings.language') dans la langue courante,
 * avec repli sur le FR si la clé manque en EN. `params.count`, quand fourni, choisit
 * one/other si la valeur résolue est un objet `{ one, other }` (pluriel simple :
 * singulier pour |count| <= 1). `%nom%` dans la chaîne est remplacé par params.nom.
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function t(key, params = {}) {
  let value = resolvePath(DICTIONARIES[currentLanguage], key) ?? resolvePath(DICTIONARIES.fr, key) ?? key;

  if (value && typeof value === 'object') {
    const count = Number(params.count);
    value = (Number.isFinite(count) && Math.abs(count) > 1) ? value.other : value.one;
  }

  return String(value ?? key).replace(/%(\w+)%/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}
