// ============================================================
// PAROLE - Notifications (lib métier côté client) — Phase 5
//
// Conforme aux règles Firestore (firestore.rules) :
//  - Création/suppression : UNIQUEMENT côté serveur (Cloud Functions
//    / Admin SDK). `create, delete: if false` pour le client.
//  - Lecture : le destinataire ou un admin. `fetchNotifications(uid)`
//    ne récupère que les notifications du user courant (where
//    recipientId), triées createdAt DESC (index composite
//    recipientId + createdAt).
//  - Update : ONLY le destinataire, et uniquement le passage
//    `read: false -> true` + `readAt` timestamp (schéma strict).
//    Les autres champs (recipientId, actorId, type, postId,
//    commentId, createdAt) sont épinglés par les règles et jamais
//    touchés ici. Une notification déjà lue est immuable.
//  - users.notificationCount est maintenu SOLEMENT par les Cloud
//    Functions ; le client se contente de lire la valeur (via
//    session.profile.notificationCount) et de rafraîchir sa copie en
//    mémoire après marquage (store.setNotificationCount).
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
  where,
  type DocumentData,
} from 'firebase/firestore';

export type NotificationType = 'like' | 'comment' | 'follow' | 'share' | 'reply' | 'message' | 'appeal';

export interface AppNotification {
  id: string;
  recipientId: string;
  actorId: string;
  type: NotificationType;
  postId: string;
  commentId: string;
  read: boolean;
  readAt: Date | null;
  createdAt: Date | null;
}

const db = getFirestoreInstance();

function toNotification(id: string, data: DocumentData): AppNotification {
  const type = data.type as NotificationType;
  return {
    id,
    recipientId: typeof data.recipientId === 'string' ? data.recipientId : '',
    actorId: typeof data.actorId === 'string' ? data.actorId : '',
    type: type === 'like' || type === 'comment' || type === 'follow' || type === 'share' || type === 'reply' || type === 'message' || type === 'appeal' ? type : 'like',
    postId: typeof data.postId === 'string' ? data.postId : '',
    commentId: typeof data.commentId === 'string' ? data.commentId : '',
    read: data.read === true,
    readAt: data.readAt?.toDate?.() ?? null,
    createdAt: data.createdAt?.toDate?.() ?? null,
  };
}

// Notifications du user courant, de la plus récente à la plus
// ancienne. Les règles Firestore restent l'autorité : un uid
// arbitraire ne permet de lire que ses propres notifications.
export async function fetchNotifications(uid: string): Promise<AppNotification[]> {
  if (!uid) return [];
  const q = query(
    collection(db, 'notifications'),
    where('recipientId', '==', uid),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => toNotification(docSnap.id, docSnap.data()));
}

// Marque une notification comme lue : écrit UNIQUEMENT read/readAt
// (le reste est épinglé par les règles puis refusé si modifié).
// users.notificationCount est décrémenté côté serveur.
export async function markNotificationRead(uid: string, id: string): Promise<void> {
  if (!uid || !id) return;
  await updateDoc(doc(db, 'notifications', id), {
    read: true,
    readAt: serverTimestamp(),
  });
}

// Marque toutes les notifications non lues du user comme lues via un
// writeBatch : chaque write est évalué individuellement par les règles
// (passage exact non lue -> lue + readAt timestamp), donc le batch est
// compatible. Retourne le nombre de notifications réellement marquées.
export async function markAllNotificationsRead(uid: string): Promise<number> {
  const unread = (await fetchNotifications(uid)).filter((n) => !n.read);
  if (unread.length === 0) return 0;
  const batch = writeBatch(db);
  for (const notification of unread) {
    batch.update(doc(db, 'notifications', notification.id), {
      read: true,
      readAt: serverTimestamp(),
    });
  }
  await batch.commit();
  return unread.length;
}