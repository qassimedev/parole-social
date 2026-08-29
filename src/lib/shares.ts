// ============================================================
// PAROLE - Partage / renvoi de publications (lib métier côté client)
//
// Conforme aux règles Firestore (firestore.rules) :
//  - ID DÉTERMINISTE `shareId = ${userId}_${postId}` (imposé par la
//    règle de création). Un second partage est un setDoc sur un
//    document existant -> UPDATE -> refusé.
//  - Champs strictement limités : userId, postId, createdAt,
//    updatedAt (hasOnly exact). Aucune donnée sensible.
//  - Lecture : tout utilisateur connecté. « Mes partages » = requête
//    simple sur userId (index mono-champ, aucun index composite).
//  - Le compteur (posts.shareCount) est maintenu par les Cloud
//    Functions (onShareCreated / onShareDeleted) — le client ne
//    l'écrit jamais. Aucun compteur users.shareCount.
//  - Retrait d'un partage : suppression réservée à son auteur.
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

export interface Share {
  id: string;
  userId: string;
  postId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

const db = getFirestoreInstance();

export function buildShareId(uid: string, postId: string): string {
  return `${uid}_${postId}`;
}

// L'utilisateur a-t-il partagé ce post ? (lecture directe).
export async function hasShared(uid: string, postId: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'shares', buildShareId(uid, postId)));
  return snap.exists();
}

// Les IDs des posts partagés par l'utilisateur. Une seule requête
// (where userId) pour pré-remplir l'état de tout le fil.
export async function fetchSharedPostIds(uid: string): Promise<Set<string>> {
  const shared = new Set<string>();
  if (!uid) return shared;
  const q = query(collection(db, 'shares'), where('userId', '==', uid));
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    const postId = docSnap.data().postId;
    if (typeof postId === 'string' && postId.length > 0) shared.add(postId);
  }
  return shared;
}

// Partage (setDoc déterministe) ou retire un partage (deleteDoc).
// Le compteur posts.shareCount est mis à jour par les Cloud Functions.
export async function toggleShare(uid: string, postId: string): Promise<void> {
  const ref = doc(db, 'shares', buildShareId(uid, postId));
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
