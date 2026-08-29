// ============================================================
// PAROLE - Abonnements (lib métier côté client)
//
// Conforme aux règles Firestore (firestore.rules) :
//  - ID DÉTERMINISTE `followId = ${followerId}_${followingId}`
//    (imposé par la règle de création). Un second follow est un
//    setDoc sur un document existant -> UPDATE -> refusé.
//  - Champs strictement limités : followerId, followingId, createdAt,
//    updatedAt (hasOnly exact). Aucune donnée sensible.
//  - Self-follow interdit par les règles ; cible requise et non
//    bannie ; un utilisateur banni ne peut pas suivre (canAct()).
//  - Lecture : le follower, le suivi, ou modérateur/admin.
//    « Mes suivis » = where followerId == moi ; « mes abonnés » =
//    where followingId == moi (requêtes mono-champ, aucun index
//    composite requis).
//  - Les compteurs (users.followingCount / users.followerCount) sont
//    maintenus par les Cloud Functions (onFollowCreated /
//    onFollowDeleted) — le client ne les écrit jamais.
//  - Retrait d'un follow : suppression réservée au follower.
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

export interface Follow {
  id: string;
  followerId: string;
  followingId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

const db = getFirestoreInstance();

export function buildFollowId(followerId: string, followingId: string): string {
  return `${followerId}_${followingId}`;
}

// Le suiveur suit-il déjà cette personne ? (lecture via l'ID
// déterministe — règle de lecture satisfaite car requérant ==
// followerId.)
export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'follows', buildFollowId(followerId, followingId)));
  return snap.exists();
}

// Les profils suivis par `followerId` (where followerId == moi).
export async function fetchFollowingIds(followerId: string): Promise<Set<string>> {
  const following = new Set<string>();
  if (!followerId) return following;
  const q = query(collection(db, 'follows'), where('followerId', '==', followerId));
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    const followingId = docSnap.data().followingId;
    if (typeof followingId === 'string' && followingId.length > 0) following.add(followingId);
  }
  return following;
}

// Les profils qui suivent `followingId` (where followingId == moi).
export async function fetchFollowerIds(followingId: string): Promise<Set<string>> {
  const followers = new Set<string>();
  if (!followingId) return followers;
  const q = query(collection(db, 'follows'), where('followingId', '==', followingId));
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    const followerId = docSnap.data().followerId;
    if (typeof followerId === 'string' && followerId.length > 0) followers.add(followerId);
  }
  return followers;
}

// Suivre (setDoc déterministe) ou retirer un follow (deleteDoc).
// Les compteurs sont mis à jour par les Cloud Functions.
export async function toggleFollow(followerId: string, followingId: string): Promise<void> {
  if (followerId === followingId) {
    throw new Error('Impossible de se suivre soi-même.');
  }
  const ref = doc(db, 'follows', buildFollowId(followerId, followingId));
  const snap = await getDoc(ref);
  if (snap.exists()) {
    await deleteDoc(ref);
  } else {
    await setDoc(ref, {
      followerId,
      followingId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}