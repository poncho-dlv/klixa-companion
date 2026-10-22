// Utilitaires purs partagés entre intégrations de lumières (Hue, et toute
// marque future) : validation de couleur hex, bornage de valeurs, normalisation de
// listes d'identifiants cibles, et exécution à concurrence bornée. Aucune dépendance
// à une marque précise — c'est le socle commun qui permet à Klixa de piloter
// plusieurs marques avec le même contrat de payload (`lightIds`, `color`, `brightness`, ...).

export function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeLightIds(raw) {
  let values;
  if (Array.isArray(raw)) values = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) values = parsed;
    } catch {
      // pas du JSON, donc liste séparée par virgules/retours ligne
    }
    if (!values) values = text.split(/[,\n\r]/);
  }
  if (!values) return [];
  return [...new Set(values
    .filter((id) => ['string', 'number'].includes(typeof id))
    .map((id) => String(id).trim())
    .filter((id) => id && id.length <= 128))];
}

export async function mapWithConcurrency(items, limit, mapper) {
  const concurrency = Math.max(1, Math.min(items.length || 1, Math.trunc(limit) || 1));
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// Plafond d'un maintien d'état (`holdMs`) : 24 h. Klixa borne déjà à 1 h côté règle, ce
// plafond ne sert qu'à ne jamais armer un timer aberrant si un payload arrive d'ailleurs.
export const MAX_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Registre des « maintiens » d'état d'une lampe : un état appliqué pour une durée
 * donnée (`holdMs`), puis restauré à l'état d'AVANT (snapshot pris au premier maintien).
 *
 * Règles (chaque piège a déjà mordu le blink d'alerte) :
 * - un second maintien sur une lampe déjà maintenue GARDE le snapshot d'origine et ne
 *   fait que ré-armer le timer — sinon la restauration du premier ramènerait la lampe à
 *   l'état du second, et celle du second à un état intermédiaire (lampe bloquée) ;
 * - un état PERMANENT (`cancel`) annule le maintien en cours : la restauration tardive ne
 *   doit jamais écraser ce que le streamer a demandé de garder ;
 * - le timer est `unref` : il ne retient jamais l'arrêt du process.
 * Pur (timers injectables) et testé.
 */
export function createHoldRegistry({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const holds = new Map();

  return {
    has: (id) => holds.has(id),
    snapshotOf: (id) => holds.get(id)?.snapshot,
    get size() { return holds.size; },

    /** Arme (ou ré-arme) la restauration de `id` dans `holdMs`. */
    arm(id, snapshot, holdMs, onExpire) {
      const previous = holds.get(id);
      if (previous) clearTimer(previous.timer);
      const origin = previous ? previous.snapshot : snapshot;
      const delay = Math.max(1, Math.min(MAX_HOLD_MS, Math.round(Number(holdMs) || 0)));
      const timer = setTimer(() => {
        holds.delete(id);
        Promise.resolve()
          .then(() => onExpire(origin))
          .catch(() => {});
      }, delay);
      timer?.unref?.();
      holds.set(id, { snapshot: origin, timer });
    },

    /** Annule les maintiens des lampes données (un état permanent les remplace). */
    cancel(ids) {
      for (const id of ids) {
        const hold = holds.get(id);
        if (!hold) continue;
        clearTimer(hold.timer);
        holds.delete(id);
      }
    },

    /** Annule tout (arrêt de l'intégration). */
    clear() {
      for (const hold of holds.values()) clearTimer(hold.timer);
      holds.clear();
    }
  };
}
