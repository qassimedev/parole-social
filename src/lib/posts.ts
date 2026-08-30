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

// ------------------------------------------------------------
// Hashtags (Phase 9 — Lot 1)
// Convention DÉTERMINISTE, identique dans firestore.rules :
// un hashtag est une chaîne en MINUSCULES, SANS le caractère '#',
// composée uniquement de [0-9a-z_], de 1 à 32 caractères. Extraction
// et normalisation 100 % côté client ; les règles REFUSENT toute
// valeur non normalisée. Le champ posts.hashtags est OPTIONNEL et un
// tableau vide est accepté. Déduplication côté client (première
// occurrence conservée, dans l'ordre du texte).
// ------------------------------------------------------------
export const MAX_HASHTAGS = 10;
export const MAX_HASHTAG_LENGTH = 32;
const HASHTAG_SOURCE_RE = /#[0-9A-Za-z_]+/g;
const HASHTAG_VALID_RE = /^[0-9a-z_]{1,32}$/;

export interface Post {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  type: PostType;
  visibility: PostVisibility;
  mediaPaths: string[];
  hashtags: string[];
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
    hashtags: Array.isArray(data.hashtags)
      ? data.hashtags.map((t: unknown) => String(t)).filter((t) => normalizeHashtag(t) !== null)
      : [],
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
// Normalisation d'un hashtag : retire le '#' éventuel, met en
// minuscules, valide la forme [0-9a-z_]{1,32}. Renvoie la forme
// normalisée (sans '#') ou null si invalide. Les caractères hors
// [A-Za-z0-9_] (accents, espaces, emoji…) interrompent le mot : un
// tag tronqué reste un tag valide pris isolément (ex. `#légale`
// produit `l`). Les majuscules sont normalisées en minuscules.
// ------------------------------------------------------------
export function normalizeHashtag(raw: string): string | null {
  const t = raw.trim().replace(/^#/, '').toLowerCase();
  return HASHTAG_VALID_RE.test(t) ? t : null;
}

// ------------------------------------------------------------
// Extraction + normalisation + déduplication des hashtags depuis le
// texte d'un post. Au plus MAX_HASHTAGS tags, dans l'ordre
// d'apparition. Un texte sans hashtag renvoie [].
// ------------------------------------------------------------
export function extractHashtags(content: string): string[] {
  const tags: string[] = [];
  const matches = content.match(HASHTAG_SOURCE_RE);
  if (!matches) return tags;
  for (const match of matches) {
    const tag = normalizeHashtag(match);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_HASHTAGS) break;
  }
  return tags;
}

// ------------------------------------------------------------
// Relie les occurrences de `#tag` dans un contenu DÉJÀ eschappé
// (escapeHtml appliqué en amont) vers la page `#/hashtag/{tag}`.
// Le jeu de caractères [0-9A-Za-z_] est sans risque HTML, les seuls
// caractères insérés pour l'ancre sont des lettres/chiffres. Seuls les
// tags normalisables (≤ 32 caractères) sont reliés ; le texte original
// est conservé tel quel dans le libellé.
// ------------------------------------------------------------
export function linkifyHashtags(escapedContent: string): string {
  return escapedContent.replace(/#([0-9A-Za-z_]+)/g, (match, tag: string) => {
    const normalized = normalizeHashtag(tag);
    if (!normalized) return match;
    return `<a class="hashtag" href="#/hashtag/${normalized}">${match}</a>`;
  });
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
// Les hashtags sont extraits du contenu par défaut (paramètre
// optionnel pour un cas spécifique) — normalisés, dédupliqués,
// bornés à MAX_HASHTAGS, conformes à la forme imposée par les règles.
// ------------------------------------------------------------
export async function createTextPost(
  uid: string,
  authorName: string,
  content: string,
  visibility: PostVisibility,
  hashtags: string[] = extractHashtags(content)
): Promise<string> {
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new Error('Le contenu ne peut pas être vide.');
  if (trimmed.length > 5000) throw new Error('5000 caractères maximum.');
  if (hashtags.length > MAX_HASHTAGS) throw new Error(`${MAX_HASHTAGS} hashtags maximum.`);

  const ref = await addDoc(collection(db, 'posts'), {
    authorId: uid,
    authorName: authorName.trim() || uid,
    content: trimmed,
    type: 'text',
    visibility,
    mediaPaths: [],
    hashtags: [...new Set(hashtags.map((t) => normalizeHashtag(t)).filter((t): t is string => t !== null))],
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

// ------------------------------------------------------------
// Posts correspondant à un hashtag (Phase 9 — Lot 1).
// Page `#/hashtag/{tag}`. L'utilisateur est normalisé en amont.
// La requête reproduit EXACTEMENT la contrainte de la règle de
// lecture (`isPostDataReadable` déréférence visibility +
// moderationStatus) : `hashtags array-contains` + `visibility ==
// 'public'` + `moderationStatus == 'visible'` — même sémantique que
// le fil « Général » (les posts visibility non-public n'apparaissent
// pas dans une page hashtag publique). Cette requête requiert l'index
// composite posts (hashtags ASC, visibility ASC, moderationStatus
// ASC) défini dans firestore.indexes.json.
// ------------------------------------------------------------
export async function fetchPostsByHashtag(tag: string): Promise<Post[]> {
  const normalized = normalizeHashtag(tag);
  if (!normalized) throw new Error(`Hashtag invalide : « ${tag} ».`);
  const q = query(
    collection(db, 'posts'),
    where('hashtags', 'array-contains', normalized),
    where('visibility', '==', 'public'),
    where('moderationStatus', '==', 'visible')
  );
  const snap = await getDocs(q);
  return snap.docs
    .map(snapshotToPost)
    .filter((p) => !p.deletedAt && p.hashtags.includes(normalized))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}