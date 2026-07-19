// Utilitaires purs partagés entre intégrations de lumières (Hue, SmallRig, et toute
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
