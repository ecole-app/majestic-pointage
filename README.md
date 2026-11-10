# Pointage Majestic

PWA de pointage (GitHub Pages + Firebase Spark) + rapports e-mail via GitHub Actions.

## Mise en route
1. **Firebase** : nouveau projet → Authentication (Email/Mot de passe) → Firestore (mode production) → coller `firestore.rules` dans Règles.
2. Projet > Paramètres > Web app → copier la config dans `firebase-config.js`.
3. Authentication > Paramètres > Domaines autorisés : ajouter le domaine GitHub Pages.
4. Repo GitHub `ecole-app/pointage-majestic` → Pages (branche main, racine).
5. Ouvrir le site → « Première installation » → créer le gérant (prénom, mot de passe, e-mail des rapports).
6. Rapports : Firebase > Comptes de service > générer une clé JSON. Secrets du repo :
   `FIREBASE_SERVICE_ACCOUNT` (JSON entier), `SMTP_USER` (adresse Gmail), `SMTP_PASS` (mot de passe d'application Gmail).
7. Tester : Actions > Rapports pointage > Run workflow (mode `daily`).

## Règles
- Jour de service = 3h → 3h (un service passé minuit compte pour la veille). Réglable.
- Le salarié pointe arrivée/départ (heure serveur) et ne voit que ses pointages.
- Le gérant modifie/ajoute/supprime tout (journalisé dans `logs`), crée salariés et livreurs, saisit les courses.
- Mot de passe oublié d'un salarié : désactiver le compte et le recréer sous un autre prénom/initiale (limite du client-side).
