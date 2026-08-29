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
//    ou authorId). Les posts 'followers' restent hors feed tant
//    que la collection `follows` n'existe pas (deny-by-default).
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
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

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
    createdAt: data.createdAt?.toDate?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.() ?? null,
    deletedAt: data.deletedAt?.toDate?.() ?? null,
  };
}

// ------------------------------------------------------------
// Feed : posts publics + mes propres posts, fusionnés et triés
// du plus récent au plus ancien. Les posts "supprimés" (deletedAt)
// sont exclus.
// ------------------------------------------------------------
export async function fetchFeed(uid: string): Promise<Post[]> {
  const publicQ = query(
    collection(db, 'posts'),
    where('visibility', '==', 'public'),
    where('moderationStatus', '==', 'visible')
  );
  const ownQ = query(collection(db, 'posts'), where('authorId', '==', uid));

  const [publicSnap, ownSnap] = await Promise.all([getDocs(publicQ), getDocs(ownQ)]);

  const byId = new Map<string, Post>();
  for (const snap of [...publicSnap.docs, ...ownSnap.docs]) {
    const post = snapshotToPost(snap);
    if (post.deletedAt) continue;
    if (!byId.has(post.id)) byId.set(post.id, post);
  }

  return [...byId.values()].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
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