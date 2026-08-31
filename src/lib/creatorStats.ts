// ============================================================
// PAROLE - Statistiques d'audience publiques (Phase 9 — Lot 6)
//
// `creatorStats/{userId}` est un document PUBLIC en LECTURE SEULE
// (utilisateurs connectés) contenant les statistiques d'audience d'un
// utilisateur : likeCount, followerCount, followingCount, commentCount,
// shareCount. Le postCount est volontairement EXCLU.
//
// Ces compteurs sont des données SYSTÈME : ils sont maintenus
// EXCLUSIVEMENT par les Cloud Functions (Admin SDK) à partir des
// événements réels (likes, follows, comments, shares). Le client ne
// peut JAMAIS les écrire, modifier ou supprimer — les règles Firestore
// autorisent uniquement la lecture. Ce module est donc strictement en
// LECTURE : aucune écriture n'est exposée.
//
// Un document absent (aucune activité d'audience pour le moment) est
// traité comme un profil à compteurs tous nuls, sans erreur.
// ============================================================

import { getFirestoreInstance } from './firebase';
import { doc, getDoc } from 'firebase/firestore';

export interface CreatorStats {
  likeCount: number;
  followerCount: number;
  followingCount: number;
  commentCount: number;
  shareCount: number;
}

const EMPTY_STATS: CreatorStats = {
  likeCount: 0,
  followerCount: 0,
  followingCount: 0,
  commentCount: 0,
  shareCount: 0,
};

// Lit les statistiques d'audience publiques d'un utilisateur.
// Retourne un objet à 5 compteurs (toujours >= 0) ; un document absent
// (ou dépourvu de certains champs) est complété par des zéros.
export async function fetchCreatorStats(userId: string): Promise<CreatorStats> {
  try {
    const snap = await getDoc(doc(getFirestoreInstance(), 'creatorStats', userId));
    if (!snap.exists()) {
      return { ...EMPTY_STATS };
    }
    const data = snap.data();
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
    return {
      likeCount: num(data.likeCount),
      followerCount: num(data.followerCount),
      followingCount: num(data.followingCount),
      commentCount: num(data.commentCount),
      shareCount: num(data.shareCount),
    };
  } catch {
    // Lecture impossible (réseau / droits) : on retombe sur des zéros
    // plutôt que de faire échouer tout le profil public.
    return { ...EMPTY_STATS };
  }
}
