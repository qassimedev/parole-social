// ============================================================
// PAROLE - Messagerie privée 1-à-1 (lib métier côté client)
//
// Conforme aux règles Firestore (firestore.rules) :
//  - `conversations/{conversationId}` : ID DÉTERMINISTE
//    `buildConversationId` = participants TRIÉS séparés par '_'
//    (imposé par la règle de création). Une seule conversation par
//    paire. Le document est IMMUABLE côté client (seules les Cloud
//    Functions actualisent lastMessageAt / lastMessagePreview /
//    lastSenderId) — le client n'écrit que lors de la création
//    (participants, createdAt, derniers champs nuls/vides).
//  - `messages/{messageId}` : addDoc (ID auto), schéma strict
//    (conversationId, senderId, content, read, readAt,
//    moderationStatus, createdAt). Le contenu est IMMUABLE : la
//    seule mutation client est `markMessageRead` (read false -> true
//    + readAt) par le DESTINATAIRE non banni.
//  - Le blocage est BIDIRECTIONNEL dans les règles (exists() sur les
//    deux directions) : l'envoi vers un utilisateur bloqué / qui
//    vous a bloqué est refusé au niveau des règles, pas ici.
//  - users.messageCount (messages non lus REÇUS) est maintenu
//    UNIQUEMENT par les Cloud Functions ; le client lit la valeur
//    (session.profile.messageCount → badge Messages) et rafraîchit
//    sa copie en mémoire après marquage (store.setMessageCount).
//  - Pagination : fetchMessages(conversationId, options) avec
//    limit + startAfter, tri createdAt ASC.
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  type DocumentData,
  type DocumentReference,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

export interface Conversation {
  id: string;
  participants: string[];
  createdAt: Date | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string;
  lastSenderId: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  read: boolean;
  readAt: Date | null;
  moderationStatus: string;
  createdAt: Date | null;
}

export interface FetchMessagesOptions {
  limit?: number;
  startAfter?: QueryDocumentSnapshot;
}

const db = getFirestoreInstance();

// ------------------------------------------------------------
// ID DÉTERMINISTE d'une conversation : participants triés.
// ------------------------------------------------------------
export function buildConversationId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('_');
}

function toConversation(data: DocumentData): Omit<Conversation, 'id'> {
  const participants = Array.isArray(data.participants)
    ? data.participants.filter((p): p is string => typeof p === 'string')
    : [];
  return {
    participants: participants.length === 2 ? participants : [],
    createdAt: data.createdAt?.toDate?.() ?? null,
    lastMessageAt: data.lastMessageAt?.toDate?.() ?? null,
    lastMessagePreview: typeof data.lastMessagePreview === 'string' ? data.lastMessagePreview : '',
    lastSenderId: typeof data.lastSenderId === 'string' ? data.lastSenderId : '',
  };
}

function toMessage(snap: QueryDocumentSnapshot): Message {
  const data = snap.data();
  return {
    id: snap.id,
    conversationId: typeof data.conversationId === 'string' ? data.conversationId : '',
    senderId: typeof data.senderId === 'string' ? data.senderId : '',
    content: typeof data.content === 'string' ? data.content : '',
    read: data.read === true,
    readAt: data.readAt?.toDate?.() ?? null,
    moderationStatus: typeof data.moderationStatus === 'string' ? data.moderationStatus : 'visible',
    createdAt: data.createdAt?.toDate?.() ?? null,
  };
}

// Lecture DÉFENSIVE d'une conversation (pattern blocks.ts) : la
// lecture d'un document INEXISTANT est refusée par le moteur de
// règles (déréférence de resource sur null dans canReadConversation),
// ce qui revient à « conversation absente ». On ne distingue jamais
// une absence d'information de l'existence d'une conversation qu'on
// n'aurait pas le droit de lire.
async function readConversation(ref: DocumentReference): Promise<Conversation | null> {
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return { id: snap.id, ...toConversation(snap.data()) };
  } catch {
    return null;
  }
}

// Récupère une conversation existante par son id (lecture défensive,
// même sémantique que readConversation). Retourne null si la
// conversation n'existe pas ou n'est pas lisible.
export async function fetchConversation(conversationId: string): Promise<Conversation | null> {
  if (!conversationId) return null;
  return readConversation(doc(db, 'conversations', conversationId));
}

// Récupère la conversation (créée si absente). La création n'écrit
// QUE les champs autorisés par les règles (participants triés,
// createdAt serveur, état conversation vide). Les erreurs de
// création (règles refusées, course, …) sont propagées à la vue.
export async function fetchOrCreateConversation(
  uid: string,
  otherId: string
): Promise<Conversation | null> {
  if (!otherId || otherId === uid) {
    throw new Error('Conversation invalide.');
  }
  const conversationId = buildConversationId(uid, otherId);
  const ref = doc(db, 'conversations', conversationId);

  const existing = await readConversation(ref);
  if (existing) return existing;

  await setDocConversation(ref, [uid, otherId].sort());
  return readConversation(ref);
}

async function setDocConversation(ref: DocumentReference, participants: string[]): Promise<void> {
  await setDoc(ref, {
    participants,
    createdAt: serverTimestamp(),
    lastMessageAt: null,
    lastMessagePreview: '',
    lastSenderId: '',
  });
}

// Les conversations du user courant (« mes conversations »), triées
// de la plus récente vers la plus ancienne. La requête est bornée
// par `participants array-contains` (règle de lecture : participant
// non banni ou modérateur). Index composite dédié.
export async function fetchConversations(uid: string): Promise<Conversation[]> {
  if (!uid) return [];
  const q = query(
    collection(db, 'conversations'),
    where('participants', 'array-contains', uid),
    orderBy('lastMessageAt', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...toConversation(docSnap.data()) }));
}

// Messages d'une conversation, triés createdAt ASC, paginés
// (limit par défaut 50, startAfter pour la suite). La règle de
// lecture déréférence la conversation : la requête doit être bornée
// sur conversationId (index composite dédié).
export async function fetchMessages(
  conversationId: string,
  options: FetchMessagesOptions = {}
): Promise<Message[]> {
  if (!conversationId) return [];
  const pageSize = Math.max(1, Math.min(options.limit ?? 50, 100));
  let q = query(
    collection(db, 'messages'),
    where('conversationId', '==', conversationId),
    orderBy('createdAt', 'asc')
  );
  if (options.startAfter) {
    q = query(q, startAfter(options.startAfter));
  }
  q = query(q, limit(pageSize));
  const snap = await getDocs(q);
  return snap.docs.map(toMessage);
}

// Envoi d'un message : addDoc avec le schéma strict autorisé par les
// règles (read=false, readAt=null, moderationStatus='visible'). La
// validité réelle (participant, non banni, non bloqué dans aucune
// direction) reste portée par firestore.rules.
export async function sendMessage(uid: string, conversationId: string, content: string): Promise<string> {
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new Error('Le message ne peut pas être vide.');
  if (trimmed.length > 2000) throw new Error('2000 caractères maximum.');

  const ref = await addDoc(collection(db, 'messages'), {
    conversationId,
    senderId: uid,
    content: trimmed,
    read: false,
    readAt: null,
    moderationStatus: 'visible',
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// Marque un message comme lu : écrit UNIQUEMENT read/readAt (le
// reste est déjà immuable via affectedKeys). users.messageCount est
// décrémenté côté serveur (onMessageUpdated). Le message doit être
// destiné à `uid` et non lu — vérifié par la vue et par les règles
// (senderId != auth.uid, read false -> true).
export async function markMessageRead(messageId: string): Promise<void> {
  if (!messageId) return;
  await updateDoc(doc(db, 'messages', messageId), {
    read: true,
    readAt: serverTimestamp(),
  });
}