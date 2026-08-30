// ============================================================
// PAROLE - Recours contre les sanctions (lib métier côté client) — Phase 9 Lot 4
//
// Conforme aux règles Firestore (firestore.rules) :
//  - Création : `setDoc` avec un identifiant DÉTERMINISTE
//    `appealId = ${appellantId}_${targetType}_${targetId}` (imposé
//    par la règle : `appealId == request.auth.uid + '_' + targetType +
//    '_' + targetId`). Un doublon est un `setDoc` sur un document
//    existant -> UPDATE -> refusé.
//  - Champs : UNIQUEMENT appealId, appellantId, targetType,
//    targetId, sanctionType, reason, status ('pending'), createdAt.
//  - La cible doit APPARTENIR à l'appelant ET être RÉELLEMENT
//    sanctionnée au dépôt (post/comment : moderationStatus
//    'hidden'/'removed' ; user : 'warned' ou banni + 'suspended'),
//    avec sanctionType cohérent — les règles restent l'autorité :
//    un client ne peut pas contester une cible non sanctionnée, ni
//    inventorier une sanction fictive. Un utilisateur banni ne peut
//    pas déposer de recours (canAct).
//  - Lecture : l'appelant concerné ou un modérateur/admin.
//  - Document IMMUABLE côté client : la décision passe exclusivement
//    par la Cloud Function `reviewAppeal` (restauration de la cible,
//    clôture du recours, audit log, notification à l'appelant).
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { fetchComment } from './comments';
import { fetchPost } from './posts';

export type AppealTargetType = 'post' | 'comment' | 'user';

export type AppealStatus = 'pending' | 'accepted' | 'rejected';

export const APPEAL_TARGET_LABELS: Record<AppealTargetType, string> = {
  post: 'Publication',
  comment: 'Commentaire',
  user: 'Compte',
};

export const APPEAL_STATUS_LABELS: Record<AppealStatus, string> = {
  pending: 'En attente',
  accepted: 'Accepté',
  rejected: 'Rejeté',
};

// Types de sanction acceptés par cible. Les valeurs correspondent à
// l'état réel stocké dans Firestore (moderationStatus des contenus,
// moderationStatus/banned des comptes) — la règle de création vérifie
// que la valeur déclarée coïncide EXACTEMENT avec l'état de la cible.
export const APPEAL_TARGET_SANCTION_TYPES: Record<AppealTargetType, readonly string[]> = {
  post: ['hidden', 'removed'],
  comment: ['hidden', 'removed'],
  user: ['warned', 'suspended'],
};

export const SANCTION_TYPE_LABELS: Record<string, string> = {
  hidden: 'Masquée',
  removed: 'Retirée',
  warned: 'Avertissement',
  suspended: 'Suspension / bannissement',
};

export interface Appeal {
  id: string;
  appealId: string;
  appellantId: string;
  targetType: AppealTargetType;
  targetId: string;
  sanctionType: string;
  reason: string;
  status: AppealStatus;
  createdAt: Date | null;
  reviewedBy?: string;
  reviewedAt?: Date | null;
}

const db = getFirestoreInstance();

function snapshotToAppeal(snap: QueryDocumentSnapshot): Appeal {
  const data = snap.data();
  return {
    id: snap.id,
    appealId: typeof data.appealId === 'string' ? data.appealId : snap.id,
    appellantId: typeof data.appellantId === 'string' ? data.appellantId : '',
    targetType: (['post', 'comment', 'user'] as const).includes(data.targetType)
      ? data.targetType
      : 'post',
    targetId: typeof data.targetId === 'string' ? data.targetId : '',
    sanctionType: typeof data.sanctionType === 'string' ? data.sanctionType : '',
    reason: typeof data.reason === 'string' ? data.reason : '',
    status: (['pending', 'accepted', 'rejected'] as const).includes(data.status)
      ? data.status
      : 'pending',
    createdAt: data.createdAt?.toDate?.() ?? null,
    reviewedBy: typeof data.reviewedBy === 'string' ? data.reviewedBy : undefined,
    reviewedAt: data.reviewedAt?.toDate?.() ?? undefined,
  };
}

export function buildAppealId(uid: string, targetType: AppealTargetType, targetId: string): string {
  return `${uid}_${targetType}_${targetId}`;
}

// L'appelant peut lire ses propres recours (règle de lecture) : on
// vérifie l'existence via getDoc.
export async function hasAppealed(
  uid: string,
  targetType: AppealTargetType,
  targetId: string
): Promise<boolean> {
  const id = buildAppealId(uid, targetType, targetId);
  const snap = await getDoc(doc(db, 'appeals', id));
  return snap.exists();
}

// Lit l'état réel d'une cible (lecture défensive) et en déduit le
// type de sanction applicable. Retourne null si la cible n'est pas
// sanctionnée, absente ou non lisible (ex. commentaire masqué).
// Utile pour pré-remplir le formulaire client ; la règle reste l'autorité.
export async function readTargetSanctionType(
  targetType: AppealTargetType,
  targetId: string,
  uid?: string
): Promise<string | null> {
  try {
    if (targetType === 'post') {
      const post = await fetchPost(targetId);
      return post ? deriveSanctionType('post', { moderationStatus: post.moderationStatus }) : null;
    }
    if (targetType === 'comment') {
      const comment = await fetchComment(targetId);
      return comment ? deriveSanctionType('comment', { moderationStatus: comment.moderationStatus }) : null;
    }
    if (!uid) return null;
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? deriveSanctionType('user', snap.data()) : null;
  } catch {
    return null;
  }
}

// Type de sanction découlant de l'état RÉEL d'une cible (jamais
// inventé côté client). Retourne null si la cible n'est pas
// sanctionnée (ou n'a pas de sanction reconnue).
function deriveSanctionType(targetType: AppealTargetType, data: DocumentData | undefined): string | null {
  if (!data) return null;
  if (targetType === 'post' || targetType === 'comment') {
    const status = data.moderationStatus;
    return status === 'hidden' || status === 'removed' ? status : null;
  }
  if (data.banned === true && data.moderationStatus === 'suspended') return 'suspended';
  if (data.moderationStatus === 'warned') return 'warned';
  return null;
}

// Dépose un recours avec EXACTEMENT les champs autorisés par la règle
// de création. `status` est forcé à 'pending'. `sanctionTypeOverride`
// permet d'indiquer la sanction quand la cible n'est pas lisible
// (commentaire masqué). LA RÈGLE reste l'autorité : une sanction
// déclarée incohérente avec l'état réel est refusée au niveau du
// serveur. Retourne l'appealId déterministe.
export async function submitAppeal(
  uid: string,
  targetType: AppealTargetType,
  targetId: string,
  reason: string,
  sanctionTypeOverride?: string
): Promise<string> {
  const trimmedReason = reason.trim();
  if (!targetId.trim()) throw new Error('Identifiant de la cible requis.');
  if (targetId.length > 200) throw new Error('200 caractères maximum pour l’identifiant de la cible.');
  if (trimmedReason.length === 0) throw new Error('Justification requise.');
  if (trimmedReason.length > 2000) throw new Error('2000 caractères maximum pour la justification.');

  const allowed = APPEAL_TARGET_SANCTION_TYPES[targetType];
  let sanctionType: string | null = null;

  if (sanctionTypeOverride && allowed.includes(sanctionTypeOverride)) {
    sanctionType = sanctionTypeOverride;
  } else {
    // Dérivation depuis l'état réel de la cible (lecture défensive) :
    // post -> l'auteur lit son propre post ; comment -> l'auteur ne
    // lit PAS un commentaire masqué (règles) ; user -> son profil.
    let data: DocumentData | null = null;
    if (targetType === 'post') {
      const post = await fetchPost(targetId);
      data = post
        ? {
            moderationStatus: post.moderationStatus,
          }
        : null;
    } else if (targetType === 'comment') {
      const comment = await fetchComment(targetId);
      data = comment
        ? {
            moderationStatus: comment.moderationStatus,
          }
        : null;
    } else {
      try {
        const snap = await getDoc(doc(db, 'users', uid));
        data = snap.exists() ? snap.data() : null;
      } catch {
        data = null;
      }
    }
    sanctionType = deriveSanctionType(targetType, data ?? undefined);
  }

  if (!sanctionType || !allowed.includes(sanctionType)) {
    throw new Error(
      targetType === 'comment' && !sanctionTypeOverride
        ? 'Cible non lisible : sélectionnez manuellement le type de sanction.'
        : 'Cette cible n’est pas sanctionnée, ou le type de sanction est incohérent.'
    );
  }

  const appealId = buildAppealId(uid, targetType, targetId);
  await setDoc(doc(db, 'appeals', appealId), {
    appealId,
    appellantId: uid,
    targetType,
    targetId,
    sanctionType,
    reason: trimmedReason,
    status: 'pending',
    createdAt: serverTimestamp(),
  });
  return appealId;
}

// Récupère un recours par son id (l'appelant ou un modérateur).
// Lecture défensive : null si absent ou non lisible.
export async function fetchAppeal(appealId: string): Promise<Appeal | null> {
  if (!appealId) return null;
  try {
    const snap = await getDoc(doc(db, 'appeals', appealId));
    return snap.exists() ? snapshotToAppeal(snap) : null;
  } catch {
    return null;
  }
}

// Les recours du user courant (« mes recours »), de la plus récente à
// la plus ancienne. Requête bornée sur appellantId (règle de lecture).
export async function fetchMyAppeals(uid: string): Promise<Appeal[]> {
  if (!uid) return [];
  const q = query(collection(db, 'appeals'), where('appellantId', '==', uid));
  const snap = await getDocs(q);
  return snap.docs
    .map(snapshotToAppeal)
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

// Les recours en attente (« à traiter »), réservés à la modération.
// Requête bornée sur status (règle de lecture : modérateur/admin).
export async function fetchPendingAppeals(): Promise<Appeal[]> {
  const q = query(collection(db, 'appeals'), where('status', '==', 'pending'));
  const snap = await getDocs(q);
  return snap.docs
    .map(snapshotToAppeal)
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}