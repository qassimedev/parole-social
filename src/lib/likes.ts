// ============================================================
// PAROLE - Likes (lib métier côté client)
//
// Conforme aux règles Firestore (firestore.rules) :
//  - ID DÉTERMINISTE `likeId = ${userId}_${postId}` (imposé par la
//    règle de création). Un second like est un setDoc sur un
//    document existant -> UPDATE -> refusé.
//  - Champs strictement limités : userId, postId, createdAt,
//    updatedAt (hasOnly exact). Aucune donnée sensible.
//  - Lecture : tout utilisateur connecté. « Mes likes » = requête
//    simple sur userId (index mono-champ, aucun index composite).
//  - Les compteurs (posts.likeCount et users.likeCount des likes
//    reçus) sont maintenus par les Cloud Functions
//    (onLikeCreated / onLikeDeleted) — le client ne les écrit jamais.
//  - Retrait d'un like : suppression réservée à son auteur.
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

export interface Like {
  id: string;
  userId: string;
  postId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

const db = getFirestoreInstance();

export function buildLikeId(uid: string, postId: string): string {
  return `${uid}_${postId}`;
}

// L'utilisateur a-t-il aimé ce post ? (lecture directe).
export async function hasLiked(uid: string, postId: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'likes', buildLikeId(uid, postId)));
  return snap.exists();
}

// Les IDs des posts aimés par l'utilisateur. Une seule requête
// (where userId) pour pré-remplir l'état de tout le fil.
export async function fetchLikedPostIds(uid: string): Promise<Set<string>> {
  const liked = new Set<string>();
  if (!uid) return liked;
  const q = query(collection(db, 'likes'), where('userId', '==', uid));
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    const postId = docSnap.data().postId;
    if (typeof postId === 'string' && postId.length > 0) liked.add(postId);
  }
  return liked;
}

// Aime (setDoc déterministe) ou retire un like (deleteDoc).
// Les compteurs sont mis à jour par les Cloud Functions.
export async function toggleLike(uid: string, postId: string): Promise<void> {
  const ref = doc(db, 'likes', buildLikeId(uid, postId));
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await deleteDoc(ref);
  } else {
    await setDoc(ref, {
      userId: uid,
      postId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}