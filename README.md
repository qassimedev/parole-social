# PAROLE

**Ta voix. Ton espace. Tes droits.**

Plateforme sociale centrée sur la liberté d'expression responsable.

## Principe fondamental

> Les utilisateurs peuvent signaler. Ils ne peuvent pas censurer.

Un nombre élevé de signalements ne déclenche **jamais** automatiquement la
suppression d'une publication. Les signalements alimentent une file de
modération traitée par des humains. Seuls les contenus manifestement illégaux
ou dangereux (CSAM, menaces crédibles, incitation à la violence, doxxing,
fraude, usurpation, harcèlement grave) peuvent être masqués par un modérateur,
avec une décision traçable et susceptible d'appel.

## État du projet

- **Phase 0** (validée) : squelette du projet, émulateurs, deny-by-default de base.
- **Phase 1** (validée) : architecture des données, règles de sécurité Firestore
  et Storage, file de modération, audit logs, Cloud Functions de modération,
  suite de tests de sécurité.
- **Phase 2** (validée) : inscription via `registerUser` (validation serveur,
  limitation de débit), connexion/déconnexion, vérification email,
  réinitialisation et changement de mot de passe, profils utilisateur
  (nom affiché, bio, photo), interface SPA complète pour ces parcours
  (accueil, connexion, inscription, vérification email, mot de passe oublié,
  profil, paramètres).
- **Phase 3** (validée) : likes — déduplication par identifiant déterministe
  (`likeId = ${userId}_${postId}`), compteurs `posts.likeCount` et
  `users.likeCount` (likes reçus) maintenus par les Cloud Functions, bouton
  j'aime avec état actif et mise à jour optimiste dans le fil.

---

## Stack

- Frontend : SPA Vanilla TypeScript + Vite
- Backend : Firebase Authentication, Firestore, Firebase Storage, Cloud Functions, Cloud Messaging
- Déploiement : Firebase Hosting
- Tests locaux : Firebase Emulator Suite

## Architecture (Phase 1)

```
┌─────────────────────────────────────────────────────────────┐
│  Client (web) — Vite/TS                                      │
│  Écrit UNIQUEMENT ses propres données (profil, posts,        │
│  commentaires, signalements). Jamais les champs système.     │
└──────────────┬──────────────────────────────┬────────────────┘
               │                              │
               │ Firestore rules (DENY)       │ HTTPS callable
               ▼                              ▼
┌─────────────────────────────┐   ┌─────────────────────────────┐
│ Firestore                   │   │ Cloud Functions (Admin SDK) │
│ • users, posts, comments    │──▶│ • moderatePost              │
│ • likes (dédupliqués)       │   │ • sanctionUser              │
│ • reports (dédupliqués)     │   │ • onReportCreated (cnt)     │
│ • moderationQueue           │   │ • onCommentCreated/Deleted  │
│ • notifications, auditLogs  │   │ • onLikeCreated/Deleted(cnt)│
│ Index composites minimaux   │   │ Écrit auditLogs (traçable)  │
└─────────────────────────────┘   └─────────────────────────────┘
        │ accès authentifié
        ▼
┌─────────────────────────────┐
│ Storage (privé)             │
│ /media/{uid}/avatars|posts  │
│ Types & tailles contrôlés   │
└─────────────────────────────┘
```

**Principe d'écriture** : toute mutation sensible (rôle, bannissement, statut
de modération, résolution de signalement, compteurs système, auditLogs) passe
**exclusivement** par les Cloud Functions, qui tracent chaque action dans
`auditLogs`. Aucun client — y compris un administrateur — ne peut écrire
directement ces données.

## Collections Firestore

### users/{userId}
| Champ | Type | Qui écrit |
|---|---|---|
| uid, displayName, bio, avatarPath | string | propriétaire |
| role (`user`/`moderator`/`admin`) | string | **jamais un client** (Functions) |
| banned, bannedUntil, moderationStatus | bool/timestamp/string | **jamais un client** (Functions) |
| postCount, reportCount, likeCount | number | **jamais un client** (compteurs système) |

Lecture : tout utilisateur authentifié. Création : son propre profil uniquement
(rôle forcé à `user`). Mise à jour : champs de profil uniquement
(`hasOnly(['displayName','bio','avatarPath','updatedAt'])`).

### posts/{postId}
| Champ | Type | Qui écrit |
|---|---|---|
| authorId, content, type, visibility | string | auteur (création) |
| visibility, content, mediaPaths | — | auteur (mise à jour) |
| likeCount, commentCount, reportCount, shareCount | number | **jamais un client** (compteurs) |
| moderationStatus, moderationReason, moderatorId, moderatedAt | — | **jamais un client** (Functions) |

Lecture : visibilité (`public`/`followers`/`private`) + `moderationStatus == 'visible'`.
Un post masqué n'est lisible que par son auteur et les modérateurs.
Suppression : uniquement l'auteur (hard delete). Les modérateurs masquent via
Functions (`moderatePost`).

### comments/{commentId}
Comme les posts : lecture conditionnée à la lisibilité du post parent,
création si le post est lisible, modification du contenu par l'auteur,
suppression par l'auteur. `postId`/`authorId`/`moderationStatus` immuables côté client.

### likes/{likeId}
- **Déduplication** : `likeId = ${userId}_${postId}` — un utilisateur ne peut
  aimer un post qu'une seule fois (un second `setDoc` devient un `update`,
  refusé). Un like est **immuable** (pas de modification).
- Champs : `userId`, `postId`, `createdAt`, `updatedAt`. Aucune donnée sensible.
- Lecture : tout utilisateur connecté (permet la requête « mes likes » sur
  `userId`, index mono-champ — aucun index composite requis).
- Création : connecté, profil présent, non banni, et le post cible doit être
  lisible (`isPostReadable`). Retrait : suppression réservée à son auteur.
- Compteurs `posts.likeCount` et `users.likeCount` (likes reçus) : maintenus
  par `onLikeCreated` / `onLikeDeleted` — jamais écrits par un client.

### reports/{reportId}
- **Déduplication** : `reportId = ${reporterId}_${targetType}_${targetId}`.
  Un même utilisateur ne peut créer **qu'un seul** signalement par cible
  (un second `setDoc` devient un `update`, refusé).
- **Aucune suppression automatique** : un signalement ne modifie, ne masque ni
  ne supprime jamais un post. Il déclenche simplement `onReportCreated`
  (incrément de `reportCount` + alimentation de la file).
- Champs : `reporterId`, `targetType`, `targetId`, `reason` (enum),
  `status` (`pending` par défaut, forcé), `createdAt`.
- Un client ne peut **jamais** modifier un signalement après création
  (statut/résolution : réservé aux Functions).

### moderationQueue/{queueId}
États : `pending`, `reviewing`, `resolved`, `dismissed`.
- Créée/alimentée par `onReportCreated`.
- Mise à jour par `moderatePost`.
- **Aucun client ne peut écrire** (ni modérateur, ni admin) : lecture
  modérateur/admin, écriture Functions uniquement.

### notifications/{notificationId}
Créées par les Functions. Le destinataire ne peut que marquer comme lue
(`read`, `readAt`). Aucune création/suppression client.

### auditLogs/{logId}
Journal append-only des actions administratives et de modération.
- Écriture : **exclusivement les Cloud Functions** (Admin SDK).
- Lecture : **administrateurs uniquement**.

### Collections prévues pour les phases suivantes
`follows`, `appeals`, `messages`, `hashtags`, `creatorStats` sont
déclarées en **deny-by-default** (aucun accès) jusqu'à leur implémentation.

## Rôles et permissions

| Capacité | user | moderator | admin |
|---|---|---|---|
| Créer son profil / posts / commentaires / signalements | ✔ | ✔ | ✔ |
| Liker / retirer son like | ✔ | ✔ | ✔ |
| Modifier/supprimer ses propres contenus | ✔ | ✔ | ✔ |
| Lire les posts publics | ✔ | ✔ | ✔ |
| Lire les posts masqués | ✖ (sauf auteur) | ✔ | ✔ |
| Lire les signalements de tous | ✖ (ses propres) | ✔ | ✔ |
| Lire la file de modération | ✖ | ✔ | ✔ |
| Lire les auditLogs | ✖ | ✖ | ✔ |
| Écrire auditLogs | ✖ | ✖ | ✖ (Functions) |
| Modifier un rôle / bannir | ✖ | ✖ (warn via Functions) | ✔ (via Functions) |
| Masquer/rétablir/retirer un post | ✖ | ✔ (via Functions) | ✔ (via Functions) |

**Sécurité des données sensibles** : un utilisateur ne peut **jamais**
modifier lui-même son `role`, son statut administrateur, son statut de
modération, les compteurs système, les décisions de modération, les
`auditLogs`, ni les données d'un autre utilisateur.

## Storage (règles sécurisées)

- Accès **authentifié obligatoire** ; aucun accès public brut.
- Chemins contrôlés : `/media/{uid}/...` — l'utilisateur n'écrit que sous son uid.
- **Avatars** : image uniquement, ≤ 5 Mo.
- **Médias de posts** : image ≤ 5 Mo, vidéo ≤ 100 Mo, audio ≤ 20 Mo ;
  le post cible doit exister et appartenir à l'auteur.
- Lecture des médias de posts conditionnée à la visibilité du post Firestore
  (`firestore.get` / `firestore.exists`) : un post masqué = médias illisibles.

## Cloud Functions (Phase 1 + Phase 2)

| Fonction | Type | Rôle requis | Effet |
|---|---|---|---|
| `registerUser` | callable | — (public) | création de compte : validation email/mot de passe/nom affiché, limitation de débit, utilisateur Auth + profil Firestore conforme aux règles (rôle `user`, non banni, compteurs à zéro) |
| `moderatePost` | callable | moderator/admin | mask/restore/maintain/remove d'un post, résout les signalements pendants, met à jour la file, écrit `auditLogs` |
| `sanctionUser` | callable | moderator (warn) / admin (ban, unban, setRole) | warn/ban/unban/changement de rôle, écrit `auditLogs` |
| `onReportCreated` | trigger | — | incrémente `post.reportCount`, crée/met à jour la file de modération |
| `onCommentCreated` | trigger | — | incrémente `post.commentCount` |
| `onCommentDeleted` | trigger | — | décrémente `post.commentCount` |
| `onLikeCreated` (Phase 3) | trigger | — | incrémente `post.likeCount` et `users.likeCount` (likes reçus) |
| `onLikeDeleted` (Phase 3) | trigger | — | décrémente `post.likeCount` et `users.likeCount` (likes reçus) |
| `healthcheck` | HTTP | — | état du service |

## Index Firestore

Index composites minimaux (Phase 1), uniquement ceux réellement utilisés :

| Collection | Champs | Justification |
|---|---|---|
| `reports` | `targetId` ASC, `status` ASC | `moderatePost` : signalements pendants d'un post |
| `moderationQueue` | `status` ASC, `createdAt` DESC | file de modération par état (Phase 2/UI) |

Les index nécessaires aux phases suivantes (flux, notifications, etc.) seront
ajoutés au fil de l'eau — pas par anticipation.

## Commandes

### Démarrage en développement

```bash
npm install
npm run dev            # frontend (Vite sur http://localhost:5173)
npm run build:functions
npm run emulators      # émulateurs Firebase (Auth, Firestore, Storage, Functions, UI)
```

Ouvrir l'UI des émulateurs : http://localhost:4000

### Tests

```bash
npm run typecheck      # vérification TypeScript (frontend)
npm run build          # build frontend
npm run build:functions
npm run test:rules     # tests de sécurité Firestore + Storage (114 tests, émulateurs)
npm run test:functions # tests des Cloud Functions (14 tests, émulateurs)
npm run test:all       # tout
```

> Note : les scripts de test démarrent leurs propres émulateurs
> (`firebase emulators:exec`) — inutile de lancer `npm run emulators` au préalable.

### Émulateurs

```bash
npm run emulators        # démarre Auth (9099), Firestore (8080), Storage (9199),
                         # Functions (5001), UI (4000) — singleProjectMode
npm run emulators:export # exporte l'état dans ./emulator-data
```

## Structure

```
public/               # Frontend statique (build Vite)
src/                  # Code source frontend TypeScript
functions/            # Cloud Functions (modération, compteurs, audit)
scripts/
  test-rules.mjs      # Suite de tests de sécurité Firestore + Storage
  test-functions.mjs  # Suite de tests des Cloud Functions
firestore.rules       # Règles Firestore (deny by default)
storage.rules         # Règles Storage (privé, types/tailles contrôlés)
firestore.indexes.json
firebase.json         # Configuration émulateurs / hosting
```

## Notes de sécurité

- La région du futur projet Firebase réel (ex. `europe-west1`) **n'est pas
  encore validée** et n'est gravée nulle part dans le code de production.
  Elle sera choisie avant la création du projet de production.
- Les compteurs (`reportCount`, `commentCount`, …) sont maintenus par des
  déclencheurs ; la cohérence ultime en production devra être renforcée par
  des transactions / tâches de réconciliation (phases ultérieures).

## Roadmap

La construction est progressive : architecture et sécurité (Phase 1), puis
authentification, base de données, interface, publications, interactions
(likes), signalements, modération, notifications, déploiement.