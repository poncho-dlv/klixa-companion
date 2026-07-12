# Icônes de build

electron-builder lit automatiquement les icônes dans ce dossier (`build/`) — c'est son emplacement par défaut, aucune config supplémentaire n'est nécessaire dans `package.json`.

Colle ici :

- `icon.ico` — icône Windows (utilisée pour l'exe, le raccourci et l'installeur NSIS). Idéalement un `.ico` multi-résolutions incluant au moins 256x256.
- `icon.icns` — icône macOS (si un jour un build Mac est ajouté).
- `icon.png` — icône Linux, 512x512 recommandé (si un jour un build Linux est ajouté).

Pour l'instant, seul `icon.ico` est nécessaire puisque le build cible Windows (`dist:win`).
