// ============================================================
// PAROLE - Blocage utilisateur (lib métier côté client)
//
// Conforme aux règles Firestore (firestore.rules) :
//  - ID DÉTERMINISTE `blockId = ${blockerId}_${blockedId}` (imposé
//    par la règle de création) : un même couple ne peut exister qu'en
//    un seul document, un second setDoc devient un UPDATE -> refusé.
//  - Champs strictement limités : blockerId, blockedId, createdAt
//    (hasOnly exact). Aucune donnée sensible.
//  - Directionnel au niveau du document (alice_bob = Alice bloque
//    Bob) ; effet de sécurité futur BIDIRECTIONNEL côté règles
//    `messages` via exists() sur les deux directions (Lot 3).
//  - Création : canAct(), blocage de soi-même interdit, cible
//    requise, existante et non bannie.
//  - Lecture : le blocker ou modérateur/admin (jamais le bloqué, ni
//    un tiers) ; « mes blocages » = where blockerId == moi (requête
//    mono-champ, aucun index composite requis).
//  - Le document est IMMUABLE : on bloque ou on débloque, jamais de
//    modification. Déblocage = suppression réservée au blocker.
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  collection,
  deleteDoc,
  doc,
  DocumentReference,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

export interface Block {
  id: string;
  blockerId: string;
  blockedId: string;
  createdAt: Date | null;
}

const db = getFirestoreInstance();

export function buildBlockId(blockerId: string, blockedId: string): string {
  return `${blockerId}_${blockedId}`;
}

// Le blocker a-t-il déjà bloqué cette personne ? (lecture via l'ID
// déterministe — règle de lecture satisfaite car requérant ==
// blockerId). Défensif : la lecture d'un document INEXISTANT est
// refusée par le moteur de règles (déréférence de resource sur null),
// ce qui revient à « non bloqué » — aucun affaiblissement des règles
// (un tiers ne peut toujours pas distinguer l'existence d'un blocage
// qu'il n'a pas le droit de lire).
export async function isUserBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'blocks', buildBlockId(blockerId, blockedId)));
    return snap.exists();
  } catch {
    return false;
  }
}

// Les IDs des utilisateurs bloqués par `uid` (where blockerId == moi).
// Requête mono-champ : aucun index composite. Les profils complets
// sont chargés par la vue (lecture users ouverte aux connectés).
export async function fetchBlockedIds(uid: string): Promise<Set<string>> {
  const blocked = new Set<string>();
  if (!uid) return blocked;
  const q = query(collection(db, 'blocks'), where('blockerId', '==', uid));
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    const blockedId = docSnap.data().blockedId;
    if (typeof blockedId === 'string' && blockedId.length > 0) blocked.add(blockedId);
  }
  return blocked;
}

// Bloquer un utilisateur (setDoc déterministe). Refus local si la
// cible est vide ou si c'est soi-même — la sécurité finale reste
// portée par firestore.rules (canAct, cible existante/non bannie).
export async function blockUser(uid: string, blockedId: string): Promise<void> {
  if (blockedId.length === 0) throw new Error('Utilisateur cible requis.');
  if (uid === blockedId) throw new Error('Impossible de se bloquer soi-même.');
  const ref = doc(db, 'blocks', buildBlockId(uid, blockedId));
  const alreadyBlocked = await blockDocExists(ref);
  if (alreadyBlocked) return;
  await setDoc(ref, {
    blockerId: uid,
    blockedId,
    createdAt: serverTimestamp(),
  });
}

// Débloquer un utilisateur (deleteDoc réservé au blocker). Ne rien
// faire si le blocage n'existe pas (idempotent).
export async function unblockUser(uid: string, blockedId: string): Promise<void> {
  const ref = doc(db, 'blocks', buildBlockId(uid, blockedId));
  const alreadyBlocked = await blockDocExists(ref);
  if (alreadyBlocked) {
    await deleteDoc(ref);
  }
}

// Lit un document `blocks` de façon défensive : pour le blocker
// (règle de lecture satisfaite), un document inexistant se traduit par
// un refus du moteur de règles (resource null) — interprété ici comme
// « pas de blocage ». On ne distingue jamais une absence d'information
// de l'existence d'un blocage que le requérant n'aurait pas le droit
// de lire (le document existe -> lecture réussie pour le blocker).
async function blockDocExists(ref: DocumentReference): Promise<boolean> {
  try {
    const snap = await getDoc(ref);
    return snap.exists();
  } catch {
    return false;
  }
}