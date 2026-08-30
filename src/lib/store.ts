import { getAuthInstance } from './firebase';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { getFirestoreInstance } from './firebase';
import { doc, getDoc } from 'firebase/firestore';

export type UserRole = 'user' | 'moderator' | 'admin';

export interface UserProfile {
  uid: string;
  displayName: string;
  bio: string;
  avatarPath: string;
  role: UserRole;
  banned: boolean;
  bannedUntil: Date | null;
  moderationStatus: 'none' | 'warned' | 'suspended';
  postCount: number;
  reportCount: number;
  likeCount: number;
  followerCount: number;
  followingCount: number;
  notificationCount: number;
  messageCount: number;
  searchTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type SessionStatus = 'loading' | 'signed-in' | 'signed-out';

export interface Session {
  status: SessionStatus;
  uid?: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  profile?: UserProfile | null;
}

type Listener = (session: Session) => void;

const listeners: Listener[] = [];
let currentSession: Session = { status: 'loading' };

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(currentSession);
  }
}

async function loadProfile(uid: string): Promise<UserProfile | null> {
  try {
    const db = getFirestoreInstance();
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      uid: data.uid,
      displayName: data.displayName,
      bio: data.bio ?? '',
      avatarPath: data.avatarPath ?? '',
      role: data.role,
      banned: data.banned ?? false,
      bannedUntil: data.bannedUntil?.toDate() ?? null,
      moderationStatus: data.moderationStatus ?? 'none',
      postCount: data.postCount ?? 0,
      reportCount: data.reportCount ?? 0,
      likeCount: data.likeCount ?? 0,
      followerCount: data.followerCount ?? 0,
      followingCount: data.followingCount ?? 0,
      notificationCount: data.notificationCount ?? 0,
      messageCount: data.messageCount ?? 0,
      searchTokens: Array.isArray(data.searchTokens) ? data.searchTokens.map(String) : [],
      createdAt: data.createdAt?.toDate() ?? new Date(),
      updatedAt: data.updatedAt?.toDate() ?? new Date(),
    };
  } catch {
    return null;
  }
}

function updateSessionFromUser(user: User | null): void {
  if (user) {
    currentSession = {
      status: 'signed-in',
      uid: user.uid,
      email: user.email ?? undefined,
      emailVerified: user.emailVerified,
      displayName: user.displayName ?? undefined,
      profile: undefined,
    };
    notifyListeners();

    loadProfile(user.uid).then((profile) => {
      if (currentSession.uid === user.uid) {
        currentSession = { ...currentSession, profile };
        notifyListeners();
      }
    });
  } else {
    currentSession = { status: 'signed-out' };
    notifyListeners();
  }
}

const auth = getAuthInstance();
onAuthStateChanged(auth, updateSessionFromUser);

export const store = {
  get(): Session {
    return currentSession;
  },
  subscribe(listener: Listener): () => void {
    listeners.push(listener);
    listener(currentSession);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },
  // Met à jour UNIQUEMENT la copie en mémoire de users.notificationCount
  // (source de vérité côté serveur). Sans notifyListeners : la vue met
  // elle-même à jour le badge DOM, sans re-render complet de l'app.
  setNotificationCount(uid: string, count: number): void {
    if (currentSession.uid !== uid || !currentSession.profile) return;
    const profile = currentSession.profile;
    const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (profile.notificationCount === safeCount) return;
    currentSession = {
      ...currentSession,
      profile: { ...profile, notificationCount: safeCount },
    };
  },
  // Même principe pour users.messageCount (badge Messages de la nav) :
  // copie en mémoire rafraîchie après marquage de messages comme lus.
  setMessageCount(uid: string, count: number): void {
    if (currentSession.uid !== uid || !currentSession.profile) return;
    const profile = currentSession.profile;
    const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (profile.messageCount === safeCount) return;
    currentSession = {
      ...currentSession,
      profile: { ...profile, messageCount: safeCount },
    };
  },
};

export function sessionErrorMessage(prev: Session, next: Session): string | null {
  if (prev.status === 'loading' && next.status !== 'loading') return null;
  if (prev.status === 'signed-out' && next.status === 'signed-in') return null;
  if (prev.status === 'signed-in' && next.status === 'signed-out') return 'Vous avez été déconnecté.';
  if (prev.status === 'signed-in' && next.status === 'signed-in' && prev.uid !== next.uid) return 'Session changée.';
  return null;
}

export type { Session as SessionType };