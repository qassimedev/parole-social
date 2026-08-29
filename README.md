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
- **Phase 4** (validée) : follow / abonnements — déduplication par identifiant
  déterministe (`followId = ${followerId}_${followingId}`), compteurs
  `users.followingCount` (suiveur) et `users.followerCount` (suivi) maintenus
  par les Cloud Functions, self-follow interdit, cible requise et non bannie,
  follow immuable, profil public (`#/u/{userId}`) avec bouton Suivre / Ne plus
  suivre (état optimiste).
- **Phase 5** (validée) : notifications — collection `notifications`
  (likes/commentaires/follows) créée **exclusivement** côté Cloud Functions
  (jamais pour soi-même), compteur `users.notificationCount` (non lues)
  maintenu par les triggers `onNotificationCreated/Updated/Deleted` (décrément
  idempotent au passage non lue → lue), page `#/notifications`, badge dans la
  navigation alimenté exclusivement par `users.notificationCount`, marquage
  individuel ou global comme lu, règles strictes (lecture destinataire/admin,
  notification déjà lue immuable).
- **Phase 6** (validée) : partage / renvoi — collection `shares`
  (déduplication par identifiant déterministe `shareId = ${userId}_${postId}`,
  documents immuables), compteur `posts.shareCount` maintenu par les Cloud
  Functions (`onShareCreated` / `onShareDeleted`), **aucun compteur
  `users.shareCount`**, notification de type `share` au propriétaire du post
  partagé (jamais pour soi-même), bouton Partager / Partagé avec état optimiste
  dans le fil (miroir du like), compteur affiché sur les profils publics.
- **Phase 7** (en cours) : fil d'abonnés — deux modes de fil dans l'accueil :
  *Général* (posts publics + mes posts) et *Abonnés* (posts publics + posts
  `visibility='followers'` des utilisateurs suivis + mes posts). La visibilité
  des posts `followers` reste **exclusivement** tranchée par les règles
  Firestore (`followsAuthor` / `isPostDataReadable`). Le fil *Abonnés* interroge
  `where authorId in [moi, ...suivis]` + `moderationStatus == 'visible'` +
  `visibility in ['public','followers']` : la règle de lecture déréférence
  `authorId`, `moderationStatus` et `visibility`, donc le moteur de règles
  exige une requête de collection contrainte sur ces trois champs. Cette
  requête nécessite l'index composite `posts (authorId, moderationStatus,
  visibility)` (ajouté dans `firestore.indexes.json`). Aucune Cloud Function
  ajoutée ; `fetchFollowingIds` est réutilisé pour borner la requête.

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
│ • follows (dédupliqués)     │   │ • onReportCreated (cnt)     │
│ • shares (dédupliqués)     │   │ • onCommentCreated/Deleted  │
│ • reports (dédupliqués)     │   │ • onLikeCreated/Deleted(cnt)│
│ • moderationQueue           │   │ • onFollowCreated/Deleted   │
│ • notifications             │   │   (cnt abonnements)         │
│ • auditLogs                 │   │ • onShareCreated/Deleted    │
│ Index composites minimaux   │   │   (cnt `posts.shareCount`)  │
│                             │   │ • onLike/Comment/Follow →   │
│                             │   │   notification (Phase 5)    │
│                             │   │ • onShare → notification    │
│                             │   │   `share` (Phase 6)         │
│                             │   │ • onNotificationCreated/    │
│                             │   │   Updated/Deleted (cnt)     │
│                             │   │ Écrit auditLogs (traçable)  │
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
| postCount, reportCount, likeCount, followerCount, followingCount, notificationCount | number | **jamais un client** (compteurs système) |

Lecture : tout utilisateur authentifié. Création : son propre profil uniquement
(rôle forcé à `user`, `notificationCount` forcé à `0`). Mise à jour : champs de
profil uniquement
(`hasOnly(['displayName','bio','avatarPath','updatedAt'])`). Les compteurs —
dont `notificationCount` — sont épinglés lors des mises à jour client
(strictement identiques, jamais modifiables par un client).

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
- **Visibilité des commentaires modérés** : un utilisateur normal (y compris
  l'auteur du post parent) ne lit que les commentaires
  `moderationStatus == 'visible'`. La règle de lecture exige
  `isPostReadable(postId) && (isModerator() || moderationStatus == 'visible')` :
  seuls modérateurs/admins lisent un commentaire `hidden`/`removed`. La requête
  client `fetchComments` est filtrée sur `moderationStatus == 'visible'`, ce qui
  impose l'index composite `comments (postId ASC, moderationStatus ASC,
  createdAt ASC)` (ajouté dans `firestore.indexes.json`). Pas de suppression
  physique ni de `deletedAt` dans ce correctif : le `mask`/`remove` lève le
  commentaire de la lecture publique sans retrait physique.

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

### follows/{followId}
- **Déduplication** : `followId = ${followerId}_${followingId}` — un utilisateur
  ne peut suivre une personne qu'une seule fois (un second `setDoc` devient un
  `update`, refusé). Un follow est **immuable** (pas de modification).
- Champs : `followerId`, `followingId`, `createdAt`, `updatedAt`. Aucune donnée
  sensible.
- Lecture : le follower, le suivi, ou modérateur/admin (empêche d'énumérer les
  abonnements d'autrui). Les requêtes « mes suivis » (`followerId == moi`) et
  « mes abonnés » (`followingId == moi`) sont mono-champ — aucun index composite.
  La visibilité des posts `followers` ne dépend pas de ce droit de lecture :
  `exists()` reste autorisé dans les règles.
- Création : connecté, profil présent, non banni (`canAct()`), la cible doit
  **exister**, ne pas être **bannie**, et ne doit pas être **soi-même**.
- Retrait : suppression réservée au follower.
- Compteurs `users.followingCount` (suiveur) et `users.followerCount` (suivi) :
  maintenus par `onFollowCreated` / `onFollowDeleted` — jamais écrits par un
  client.

### shares/{shareId} (Phase 6)
- **Déduplication** : `shareId = ${userId}_${postId}` — un utilisateur ne peut
  partager un post qu'une seule fois (un second `setDoc` devient un `update`,
  refusé). Un partage est **immuable** (pas de modification).
- Champs : `userId`, `postId`, `createdAt`, `updatedAt`. Aucune donnée sensible.
- Lecture : tout utilisateur connecté (permet la requête « mes partages » sur
  `userId`, index mono-champ — aucun index composite requis).
- Création : connecté, profil présent, non banni (`canAct()`), `userId ==
  auth.uid`, et le post cible doit être lisible (`isPostReadable`). Retrait :
  suppression réservée à son auteur.
- Compteur `posts.shareCount` : maintenu **exclusivement** par `onShareCreated`
  (+1) / `onShareDeleted` (−1). **Aucun compteur `users.shareCount`** — un
  partage n'est pas un indicateur valorisé du profil (au contraire d'un like).
- Notification de type `share` au propriétaire du post partagé, jamais pour un
  self-share (géré par `createNotification`).

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
Notifications de likes, commentaires, abonnements et partages — **créées
uniquement par les Cloud Functions** (aucune création/suppression client).

| Champ | Type | Description |
|---|---|---|
| recipientId | string | destinataire |
| actorId | string | auteur de l'action |
| type | `like` / `comment` / `follow` / `share` | nature de la notification |
| postId | string | post concerné, `''` sinon |
| commentId | string | commentaire concerné, `''` sinon |
| read | boolean | `false` à la création |
| readAt | Timestamp \| null | `null` à la création |
| createdAt | Timestamp | horodatage serveur |

Schéma strict (`hasOnly`) : tous les champs sont présents à chaque création et
**immuables côté client** (`recipientId`, `actorId`, `type`, `postId`,
`commentId`, `createdAt` épinglés par les règles).

- **Lecture** : le destinataire (`recipientId == auth.uid`) ou un admin.
- **Création / suppression** : toujours refusées pour un client.
- **Mise à jour** : uniquement le destinataire, et uniquement le passage
  `read: false → true` avec `readAt` obligatoire de type timestamp
  (`hasOnly(['read','readAt'])`). Une notification **déjà lue est immuable** —
  ce qui rend le décrément de `users.notificationCount` **exactement unitaire**
  (idempotent, pas de double décrément).

`users.notificationCount` = nombre de notifications **non lues**. Initialisé à
`0` à la création du profil, maintenu **exclusivement** par les Cloud Functions,
jamais modifiable par un client.

Types de notifications (jamais pour soi-même) :
- `like` : quelqu'un a aimé votre publication → propriétaire du post.
- `comment` : quelqu'un a commenté votre publication → propriétaire du post.
- `follow` : quelqu'un vous suit → utilisateur suivi.
- `share` : quelqu'un a partagé votre publication → propriétaire du post.

Page `#/notifications` : liste (chargement / vide / erreur + Réessayer), état
lu/non lu, date, nom de l'acteur (lien `#/u/{actorId}`), bouton « Marquer comme
lu » par notification et « Tout marquer comme lu ». Le **badge Notifications**
de la navigation affiche exclusivement la valeur de `users.notificationCount`
(copie en mémoire rafraîchie dans le store après marquage) et disparaît à zéro.

### auditLogs/{logId}
Journal append-only des actions administratives et de modération.
- Écriture : **exclusivement les Cloud Functions** (Admin SDK).
- Lecture : **administrateurs uniquement**.

### Collections prévues pour les phases suivantes
`appeals`, `messages`, `hashtags`, `creatorStats` sont déclarées en
**deny-by-default** (aucun accès) jusqu'à leur implémentation.

## Rôles et permissions

| Capacité | user | moderator | admin |
|---|---|---|---|
| Créer son profil / posts / commentaires / signalements | ✔ | ✔ | ✔ |
| Liker / retirer son like | ✔ | ✔ | ✔ |
| Partager / retirer son partage (Phase 6) | ✔ | ✔ | ✔ |
| Suivre / ne plus suivre un utilisateur | ✔ | ✔ | ✔ |
| Lire / marquer ses notifications | ✔ | ✔ | ✔ (admin : lit toutes) |
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

## Cloud Functions (Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6)

| Fonction | Type | Rôle requis | Effet |
|---|---|---|---|
| `registerUser` | callable | — (public) | création de compte : validation email/mot de passe/nom affiché, limitation de débit, utilisateur Auth + profil Firestore conforme aux règles (rôle `user`, non banni, compteurs à zéro) |
| `moderatePost` | callable | moderator/admin | mask/restore/maintain/remove d'un post, résout les signalements pendants, met à jour la file, écrit `auditLogs` |
| `sanctionUser` | callable | moderator (warn) / admin (ban, unban, setRole) | warn/ban/unban/changement de rôle, écrit `auditLogs` |
| `onReportCreated` | trigger | — | incrémente `post.reportCount`, crée/met à jour la file de modération |
| `onCommentCreated` | trigger | — | incrémente `post.commentCount` + notification « comment » au propriétaire du post |
| `onCommentDeleted` | trigger | — | décrémente `post.commentCount` |
| `onLikeCreated` (Phase 3) | trigger | — | incrémente `post.likeCount` et `users.likeCount` (likes reçus) + notification « like » au propriétaire du post |
| `onLikeDeleted` (Phase 3) | trigger | — | décrémente `post.likeCount` et `users.likeCount` (likes reçus) |
| `onFollowCreated` (Phase 4) | trigger | — | incrémente `users.followingCount` (suiveur) et `users.followerCount` (suivi) + notification « follow » au suivi |
| `onFollowDeleted` (Phase 4) | trigger | — | décrémente `users.followingCount` (suiveur) et `users.followerCount` (suivi) |
| `onShareCreated` (Phase 6) | trigger | — | incrémente `post.shareCount` (+1) + notification « share » au propriétaire du post (jamais pour un self-share) |
| `onShareDeleted` (Phase 6) | trigger | — | décrémente `post.shareCount` (−1) |
| `onNotificationCreated` (Phase 5) | trigger | — | incrémente `users.notificationCount` (+1) pour une notification non lue |
| `onNotificationUpdated` (Phase 5) | trigger | — | décrémente `users.notificationCount` (−1) au passage **exact** non lue → lue (idempotent, borné à ≥ 0) |
| `onNotificationDeleted` (Phase 5) | trigger | — | décrément défensif (−1) si une notification **non lue** est supprimée (borné à ≥ 0) |
| `healthcheck` | HTTP | — | état du service |

Les notifications listent **uniquement** les champs du schéma (schema strict) :
`recipientId`, `actorId`, `type`, `postId`, `commentId`, `read`, `readAt`,
`createdAt`. `replyToId` reste `''` pour cette phase : pas encore d'UI de
réponse, donc pas de notification à l'auteur d'un commentaire parent.

## Index Firestore

Index composites minimaux (Phase 1), uniquement ceux réellement utilisés :

| Collection | Champs | Justification |
|---|---|---|
| `reports` | `targetId` ASC, `status` ASC | `moderatePost` : signalements pendants d'un post |
| `moderationQueue` | `status` ASC, `createdAt` DESC | file de modération par état (Phase 2/UI) |
| `notifications` | `recipientId` ASC, `createdAt` DESC | page `#/notifications` : notifications du user, plus récentes d'abord (Phase 5) |
| `comments` | `postId` ASC, `moderationStatus` ASC, `createdAt` ASC | `fetchComments` : commentaires visibles d'un post, tri chronologique (visibilité des commentaires modérés) |

La collection `shares` (Phase 6) n'ajoute **aucun index composite** : ses
requêtes (« mes partages ») sont des `where userId` mono-champ.

La Phase 7 (fil d'abonnés) ajoute **un** index composite, réellement requis :
`posts (authorId ASC, moderationStatus ASC, visibility ASC)`, pour la requête du
fil *Abonnés* (`authorId in [moi, ...suivis]` + `moderationStatus == 'visible'`
+ `visibility in ['public','followers']`) — contrainte exigée par le moteur de
règles (la règle de lecture déréférence ces trois champs). Le fil *Général*
repose toujours sur l'index existant `posts [visibility ASC, moderationStatus
ASC]`, et la requête « mes posts » est mono-champ (`authorId`).

Le correctif « visibilité des commentaires modérés » ajoute l'index composite
`comments (postId ASC, moderationStatus ASC, createdAt ASC)`, réellement requis
par la requête `fetchComments` (égalité `postId` + égalité `moderationStatus`
+ tri `createdAt`). Aucun autre index de la collection `comments` n'est ajouté.

Les index nécessaires aux phases suivantes seront ajoutés au fil de l'eau —
pas par anticipation.

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
npm run test:rules     # tests de sécurité Firestore + Storage (207 tests, émulateurs)
npm run test:functions # tests des Cloud Functions (41 tests, émulateurs)
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
(likes, partages, suivis), signalements, modération, notifications, déploiement.