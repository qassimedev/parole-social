// ============================================================
// PAROLE - Commentaires (lib métier côté client)
//
// Conforme aux règles Firestore (firestore.rules) :
//  - Création : `hasOnly` exact — postId, authorId, content,
//    replyToId, createdAt, updatedAt, moderationStatus, deletedAt.
//    replyToId = '' pour un commentaire racine, sinon l'id du
//    commentaire parent (réponse/thread). Le rendu en arbre est
//    construit côté client (src/views/home.ts) ; aucune règle de
//    sécurité supplémentaire n'est nécessaire.
//    Le schéma commentaire ne dénormalise PAS authorName : le nom
//    d'auteur est résolu côté client via users/{authorId}
//    (lisible par tout utilisateur connecté).
//  - content : 1 à 2000 caractères (règle, vérifiée aussi côté
//    client).
//  - Lecture : requête de collection contrainte sur postId
//    (obligatoire : la règle utilise get()/exists() sur le post
//    parent) + tri createdAt croissant.
//  - canAct() (profil présent, non banni) et la lisibilité du post
//    parent sont appliqués par les règles — le client ne peut pas
//    les contourner.
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

export interface Comment {
  id: string;
  postId: string;
  authorId: string;
  content: string;
  replyToId: string;
  moderationStatus: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

const db = getFirestoreInstance();

function snapshotToComment(snap: QueryDocumentSnapshot): Comment {
  const data = snap.data();
  return {
    id: snap.id,
    postId: data.postId ?? '',
    authorId: data.authorId ?? '',
    content: data.content ?? '',
    replyToId: data.replyToId ?? '',
    moderationStatus: data.moderationStatus ?? 'visible',
    createdAt: data.createdAt?.toDate?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.() ?? null,
    deletedAt: data.deletedAt?.toDate?.() ?? null,
  };
}

// ------------------------------------------------------------
// Commentaires d'un post. La requête est limitée au champ postId
// (contrainte requise par la règle de lecture avec get()/exists()
// sur le post parent). Les documents de posts non lisibles sont
// rejetés par les règles.
// ------------------------------------------------------------
export async function fetchComments(postId: string): Promise<Comment[]> {
  const q = query(
    collection(db, 'comments'),
    where('postId', '==', postId),
    orderBy('createdAt', 'asc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(snapshotToComment);
}

// ------------------------------------------------------------
// Création d'un commentaire texte par le client.
// `commentId` = id du commentaire parent pour une réponse (thread),
// vide ('') pour un commentaire racine. Les champs sont strictement
// limités à ceux autorisés par firestore.rules.
// ------------------------------------------------------------
export async function createComment(
  postId: string,
  uid: string,
  content: string,
  commentId = ''
): Promise<string> {
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new Error('Le commentaire ne peut pas être vide.');
  if (trimmed.length > 2000) throw new Error('2000 caractères maximum.');

  const ref = await addDoc(collection(db, 'comments'), {
    postId,
    authorId: uid,
    content: trimmed,
    replyToId: commentId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    moderationStatus: 'visible',
    deletedAt: null,
  });
  return ref.id;
}

// ------------------------------------------------------------
// Noms d'auteurs : le document commentaire ne stocke que authorId
// (pas de authorName). users/{authorId} est lisible par tout
// utilisateur connecté ; nom affiché = displayName, sinon l'id.
// ------------------------------------------------------------
export async function fetchAuthorNames(authorIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(authorIds.filter((id) => id.length > 0))];
  const names = new Map<string, string>();
  await Promise.all(
    unique.map(async (id) => {
      try {
        const snap = await getDoc(doc(db, 'users', id));
        const displayName = snap.exists() ? (snap.data().displayName ?? '') : '';
        names.set(id, displayName.trim() || id);
      } catch {
        names.set(id, id);
      }
    })
  );
  return names;
}