# Docteur Python

Application web pour apprendre Python de zéro : 27 consultations sur 6 niveaux (dont un niveau « Python pour la cyber »), quiz, exercices corrigés automatiquement, révision espacée, défi du jour, exercices « remettre dans l'ordre », « chasse au bug » et « code à trous », un labo qui exécute Python dans le navigateur (Pyodide), une Radiographie pas à pas et un diagnostic des erreurs en français. Installable sur téléphone et utilisable hors ligne.

## Structure

- `index.html` : toute l'application (HTML, CSS, JavaScript)
- `py-worker.js` : le moteur Python, exécuté dans un Web Worker
- `pyodide/` : Python 3.12 compilé pour le navigateur (Pyodide 0.27.8)
- `sw.js` et `manifest.webmanifest` : installation et mode hors ligne
- `icons/` : icônes de l'application
- `vercel.json` : en-têtes de cache et type des fichiers .wasm

Site 100 % statique : aucun serveur, aucune base de données. La progression est enregistrée dans le navigateur de chaque visiteur.

## Mettre en ligne sur Vercel

1. Pousse ce dossier dans un dépôt GitHub.
2. Sur vercel.com, « Add New… » puis « Project », importe le dépôt.
3. Framework Preset : **Other**. Pas de commande de build, dossier de sortie : la racine.
4. Clique sur Deploy.

## Tester en local

```bash
python3 -m http.server 8000
```
puis ouvre http://localhost:8000
