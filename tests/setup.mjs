import { setLanguage } from '../src/i18n/core.js';

// Les tests asservissent des messages d'erreur en clair (assertions regex) : la
// langue par défaut de src/i18n/core.js suit désormais la locale système (Intl),
// ce qui rend la suite non-déterministe selon la machine/le runner CI. On fige le
// français ici (langue de référence du projet) avant que le moindre test tourne.
setLanguage('fr');
