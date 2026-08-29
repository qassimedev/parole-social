// ============================================================
// PAROLE - Publications (lib métier côté client)
//
// Conforme aux règles Firestore (firestore.rules) :
//  - Création : uniquement les champs autorisés par `hasOnly`.
//    Les champs système (compteurs, moderationStatus) sont écrits
//    avec UNIQUEMENT leurs valeurs imposées par les règles (0 et
//    'visible') — le client ne choisit jamais ces valeurs.
//  - Feed : requêtes de collection contraintes sur les champs
//    exacts de la règle de lecture (visibility + moderationStatus,
//    ou authorId).
//  - Phase 7 : deux modes de fil.
//      * 'general'   : posts 'public' + mes propres posts.
//      * 'following' : posts 'public' + posts 'followers' des
//        personnes suivies + mes propres posts. La requête est
//        contrainte sur `authorId` (obligatoire pour la règle de
//        lecture des posts 'followers', qui appelle followsAuthor),
//        et la visibilité est TOUJOURS tranchée par les règles
//        Firestore : jamais de décision de visibilité côté client.
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { fetchFollowingIds } from './follows';

export type PostVisibility = 'public' | 'followers' | 'private';
export type PostType = 'text' | 'image' | 'video' | 'audio';

export interface Post {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  type: PostType;
  visibility: PostVisibility;
  mediaPaths: string[];
  moderationStatus: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

const db = getFirestoreInstance();

function snapshotToPost(snap: QueryDocumentSnapshot): Post {
  const data = snap.data();
  return {
    id: snap.id,
    authorId: data.authorId,
    authorName: data.authorName ?? '',
    content: data.content ?? '',
    type: data.type ?? 'text',
    visibility: data.visibility ?? 'public',
    mediaPaths: Array.isArray(data.mediaPaths) ? data.mediaPaths.map(String) : [],
    moderationStatus: data.moderationStatus ?? 'visible',
    likeCount: typeof data.likeCount === 'number' ? data.likeCount : 0,
    commentCount: typeof data.commentCount === 'number' ? data.commentCount : 0,
    shareCount: typeof data.shareCount === 'number' ? data.shareCount : 0,
    createdAt: data.createdAt?.toDate?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.() ?? null,
    deletedAt: data.deletedAt?.toDate?.() ?? null,
  };
}

// ------------------------------------------------------------
// Mode de fil : "general" (posts publics + mes posts) ou
// "following" (posts publics + posts 'followers' des personnes que
// je suis + mes posts). Les deux modes n'ajoutent AUCUN index
// composite : les requêtes sur visibility + moderationStatus sont
// couvertes par l'index existant [visibility ASC, moderationStatus
// ASC], et la requête « mes posts » est mono-champ (authorId).
// ------------------------------------------------------------
export type FeedMode = 'general' | 'following';

// ------------------------------------------------------------
// Feed : posts publics + mes propres posts, fusionnés et triés
// du plus récent au plus ancien. Les posts "supprimés" (deletedAt)
// sont exclus.
//
// Mode 'following' : posts 'public' + posts 'followers' des
// personnes suivies + mes propres posts, en réutilisant
// fetchFollowingIds(uid) pour borner le jeu à mes abonnements.
//
// IMPORTANT (règles Firestore) : la règle de lecture d'un post
// (`isPostDataReadable`) appelle `followsAuthor(data.authorId)` pour
// les posts 'followers' et déréférence aussi `data.moderationStatus`
// et `data.visibility`. Le moteur de règles exige qu'une requête de
// collection sur les posts soit contrainte sur CHAQUE champ
// déréférencé (authorId, moderationStatus, visibility). Le mode
// 'following' contraint donc la requête avec `authorId in [moi,
// ...suivis]` + `moderationStatus == 'visible'` + `visibility in
// ['public','followers']` — ce qui requiert l'index composite posts
// (authorId ASC, moderationStatus ASC, visibility ASC). Les règles
// filtrent ensuite chaque document (un post 'followers' d'un auteur
// non suivi, ou privé d'autrui, est invisible).
// ------------------------------------------------------------
export async function fetchFeed(uid: string, mode: FeedMode = 'general'): Promise<Post[]> {
  let followingIds: Set<string> = new Set();
  if (mode === 'following') {
    followingIds = await fetchFollowingIds(uid);
  }

  const [feedSnap, ownSnap] = await Promise.all([
    getDocs(buildFeedQuery(uid, mode, followingIds)),
    getDocs(query(collection(db, 'posts'), where('authorId', '==', uid))),
  ]);

  const byId = new Map<string, Post>();
  for (const docSnap of [...feedSnap.docs, ...ownSnap.docs]) {
    const post = snapshotToPost(docSnap);
    if (post.deletedAt) continue;

    // En mode 'following', on borne l'affichage : mes propres posts
    // (toutes visibilités), les posts 'public', et les posts
    // 'followers' des utilisateurs suivis. Les posts 'private' d'autrui
    // sont exclus (de toute façon invisibles via les règles). Strict :
    // ne restreint que ce que les règles autorisent, ne les contourne
    // jamais.
    if (mode === 'following') {
      if (post.authorId !== uid && post.visibility === 'private') continue;
      if (post.visibility === 'followers' && post.authorId !== uid && !followingIds.has(post.authorId)) {
        continue;
      }
    }

    if (!byId.has(post.id)) byId.set(post.id, post);
  }

  return [...byId.values()].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
  );
}

// Requête sous-jacente du fil publié. Le mode 'general' interroge les
// posts 'public' visibles (visibility + moderationStatus contraints,
// la règle court-circuite sur `visibility == 'public'`). Le mode
// 'following' interroge les posts 'public'/'followers' des personnes
// suivies et de moi-même : le moteur de règles exige que la requête
// de collection soit contrainte sur CHAQUE champ déréférencé par la
// règle de lecture (authorId via followsAuthor, moderationStatus,
// visibility) — d'où la contrainte complète authorId + visibility +
// moderationStatus. Cette requête compose trois champs et requiert
// l'index composite posts (authorId ASC, moderationStatus ASC,
// visibility ASC). Les règles restent l'autorité finale : chaque
// document est ensuite filtré par l'affichage défensif.
function buildFeedQuery(uid: string, mode: FeedMode, followingIds: Set<string>): Query {
  if (mode === 'following') {
    const scopes = new Set(followingIds);
    scopes.add(uid);
    return query(
      collection(db, 'posts'),
      where('authorId', 'in', [...scopes]),
      where('moderationStatus', '==', 'visible'),
      where('visibility', 'in', ['public', 'followers'])
    );
  }
  return query(
    collection(db, 'posts'),
    where('visibility', '==', 'public'),
    where('moderationStatus', '==', 'visible')
  );
}

// ------------------------------------------------------------
// Posts d'un auteur (lecture via authorId, mono-champ — la règle de
// lecture reste l'autorité : un post non lisible n'est pas renvoyé).
// Filtre côté client : supprimés exclus, masqués exclus (sauf pour
// les modérateurs qui les lisent — ici on n'affiche que les posts
// visibles, cohérent avec le fil).
// ------------------------------------------------------------
export async function fetchPostsByAuthor(authorId: string): Promise<Post[]> {
  const q = query(collection(db, 'posts'), where('authorId', '==', authorId));
  const snap = await getDocs(q);
  return snap.docs
    .map(snapshotToPost)
    .filter((p) => !p.deletedAt && p.moderationStatus === 'visible')
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

// ------------------------------------------------------------
// Un post (lecture directe). Les modérateurs peuvent lire tous les
// posts ; les autres ne peuvent lire que les posts qui leur sont
// lisibles (la règle décide). Renvoie null si introuvable.
// ------------------------------------------------------------
export async function fetchPost(postId: string): Promise<Post | null> {
  const snap = await getDoc(doc(db, 'posts', postId));
  if (!snap.exists()) return null;
  return snapshotToPost(snap);
}

// ------------------------------------------------------------
// Création d'un post texte par le client.
// Champs strictement limités à ceux autorisés par firestore.rules.
// ------------------------------------------------------------
export async function createTextPost(
  uid: string,
  authorName: string,
  content: string,
  visibility: PostVisibility
): Promise<string> {
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new Error('Le contenu ne peut pas être vide.');
  if (trimmed.length > 5000) throw new Error('5000 caractères maximum.');

  const ref = await addDoc(collection(db, 'posts'), {
    authorId: uid,
    authorName: authorName.trim() || uid,
    content: trimmed,
    type: 'text',
    visibility,
    mediaPaths: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    likeCount: 0,
    commentCount: 0,
    reportCount: 0,
    shareCount: 0,
    moderationStatus: 'visible',
  });
  return ref.id;
}