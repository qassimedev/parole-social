import { getFirestoreInstance, getStorageInstance } from './firebase';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { buildSearchTokens } from './search';
import type { UserProfile } from './store';

const db = getFirestoreInstance();
const storage = getStorageInstance();

export type { UserProfile };

export async function updateProfile(uid: string, data: Partial<Pick<UserProfile, 'displayName' | 'bio' | 'avatarPath'>>): Promise<void> {
  const userRef = doc(db, 'users', uid);
  const payload: Record<string, unknown> = {
    ...data,
    updatedAt: serverTimestamp(),
  };
  // Les tokens de recherche sont DÉRIVÉS du displayName : un
  // changement de displayName re-normalise les tokens dans la même
  // écriture. Les règles imposent ce liage (searchTokens ne change
  // jamais sans displayName) : un profil mettant à jour autres
  // choses (bio/avatar) n'envoie PAS searchTokens.
  if (data.displayName !== undefined) {
    payload.searchTokens = buildSearchTokens(data.displayName);
  }
  await updateDoc(userRef, payload);
}

export async function uploadAvatar(uid: string, file: File): Promise<string> {
  const path = `media/${uid}/avatars/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  return path;
}

export async function getAvatarUrl(path: string): Promise<string> {
  const storageRef = ref(storage, path);
  return getDownloadURL(storageRef);
}

export async function deleteAvatar(path: string): Promise<void> {
  const storageRef = ref(storage, path);
  await deleteObject(storageRef);
}