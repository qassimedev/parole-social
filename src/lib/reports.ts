// ============================================================
// PAROLE - Signalements (lib métier côté client)
//
// Conforme aux règles Firestore (firestore.rules) :
//  - Création : `setDoc` avec un identifiant DÉTERMINISTE
//    `reportId = reporterId_targetType_targetId` (imposé par la
//    règle : `reportId == request.auth.uid + '_' + targetType +
//    '_' + targetId`). Un doublon est un `setDoc` sur un document
//    existant -> UPDATE -> refusé par la règle.
//  - Champs : UNIQUEMENT reporterId, reportId, targetType,
//    targetId, reason, details, status ('pending'), createdAt.
//  - reason : l'une des 9 valeurs autorisées par `validReason`.
//  - Lecture : le signalant et les modérateurs/admins.
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

export const REPORT_REASONS = [
  'illegal',
  'harassment',
  'spam',
  'hate',
  'sexual',
  'violence',
  'doxxing',
  'fraud',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  illegal: 'Contenu illégal',
  harassment: 'Harcèlement',
  spam: 'Spam',
  hate: 'Discours haineux',
  sexual: 'Contenu sexuel',
  violence: 'Violence',
  doxxing: 'Divulgation d’informations personnelles',
  fraud: 'Fraude',
  other: 'Autre',
};

export type ReportTargetType = 'post' | 'comment' | 'user';

export type ReportStatus = 'pending' | 'reviewing' | 'resolved' | 'dismissed';

export interface Report {
  id: string;
  reportId: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  createdAt: Date | null;
}

const db = getFirestoreInstance();

function snapshotToReport(snap: QueryDocumentSnapshot): Report {
  const data = snap.data();
  return {
    id: snap.id,
    reportId: typeof data.reportId === 'string' ? data.reportId : snap.id,
    reporterId: data.reporterId ?? '',
    targetType: (['post', 'comment', 'user'] as const).includes(data.targetType)
      ? data.targetType
      : 'post',
    targetId: data.targetId ?? '',
    reason: (REPORT_REASONS as readonly string[]).includes(data.reason) ? data.reason : 'other',
    details: typeof data.details === 'string' ? data.details : '',
    status: (['pending', 'reviewing', 'resolved', 'dismissed'] as const).includes(data.status)
      ? data.status
      : 'pending',
    createdAt: data.createdAt?.toDate?.() ?? null,
  };
}

export function buildReportId(uid: string, targetType: ReportTargetType, targetId: string): string {
  return `${uid}_${targetType}_${targetId}`;
}

// L'auteur d'un signalement peut lire ses propres signalements
// (règle de lecture) : on vérifie donc l'existence via getDoc.
export async function hasReported(
  uid: string,
  targetType: ReportTargetType,
  targetId: string
): Promise<boolean> {
  const id = buildReportId(uid, targetType, targetId);
  const snap = await getDoc(doc(db, 'reports', id));
  return snap.exists();
}

// Crée un signalement avec EXACTEMENT les champs autorisés par la
// règle de création. `status` est forcé à 'pending' (jamais choisi
// par le client). Retourne le reportId déterministe.
export async function createReport(
  uid: string,
  targetType: ReportTargetType,
  targetId: string,
  reason: ReportReason,
  details = ''
): Promise<string> {
  if (!REPORT_REASONS.includes(reason)) throw new Error('Motif de signalement invalide.');
  const trimmedDetails = details.trim();
  if (trimmedDetails.length > 1000) throw new Error('1000 caractères maximum pour les détails.');

  const reportId = buildReportId(uid, targetType, targetId);
  await setDoc(doc(db, 'reports', reportId), {
    reporterId: uid,
    reportId,
    targetType,
    targetId,
    reason,
    ...(trimmedDetails ? { details: trimmedDetails } : {}),
    status: 'pending',
    createdAt: serverTimestamp(),
  });
  return reportId;
}

// Signalements accessibles : les siens (lecture du signalant) et,
// pour les modérateurs/admins, tous les signalements.
export async function fetchReports(): Promise<Report[]> {
  const snap = await getDocs(collection(db, 'reports'));
  return snap.docs
    .map(snapshotToReport)
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}