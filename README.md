# TOBIS native prototype (Expo)

Cette branche du dépôt est maintenant une vraie base d’application Android/iOS Expo inspirée des captures : identité bleu nuit/or marocaine, accueil chauffeur/passager, carte, formulaire chauffeur, lignes, préférences d’alerte et navigation native.

## Lancer l’aperçu Android

1. Installer Node.js LTS et Git.
2. Cloner le dépôt puis, à la racine :

```sh
npm install
npx expo start
```

3. Installer Expo Go sur le téléphone Android et scanner le QR code. La carte nécessite une connexion pour charger les tuiles OpenStreetMap via le fournisseur de carte natif. Pour tester un APK :

```sh
npm install -g eas-cli
eas login
eas build --platform android --profile preview
```

Expo SDK 51 est conservé pour correspondre au prototype initial; une mise à niveau SDK pourra être faite avant publication Play Store.

## Fonctionnalités fonctionnelles locales

- navigation Accueil / Carte / Parcours / Notifications / Réglages
- interface conducteur avec démarrage/arrêt du GPS et permission de localisation
- position du téléphone affichée localement sur la carte pendant la session
- véhicules et parcours d’exemple explicitement étiquetés comme démo
- préférences passager enregistrées localement avec AsyncStorage
- demande de permission et notification de test locale
- lien WhatsApp ouvrant un message prérempli (l’utilisateur doit appuyer sur Envoyer)

## Limite importante avant utilisation réelle

Le code ne synchronise pas encore le chauffeur et le passager entre appareils : Firebase et le backend WhatsApp ne sont pas connectés. L’ajout de coordonnées Firebase seules ne suffit pas. Il faut configurer une authentification chauffeur, règles Firestore vérifiées, écriture limitée aux chauffeurs, Cloud Functions côté serveur et WhatsApp Business API. Ne publiez pas des coordonnées GPS ou numéros de téléphone en accès public. Le suivi en arrière-plan varie selon Android/iOS et demande des tests sur les appareils ciblés.

Le JSON existant `data/tobis-l1-demo.json` indique que les itinéraires et arrêts OSM n’ont pas été récupérés/validés. Les noms d’arrêts présents dans l’interface sont des exemples seulement, pas les arrêts réels de la ligne L1.
