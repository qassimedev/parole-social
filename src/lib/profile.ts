import { getFirestoreInstance, getStorageInstance } from './firebase';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import type { UserProfile } from './store';

const db = getFirestoreInstance();
const storage = getStorageInstance();

export type { UserProfile };

export async function updateProfile(uid: string, data: Partial<Pick<UserProfile, 'displayName' | 'bio' | 'avatarPath'>>): Promise<void> {
  const userRef = doc(db, 'users', uid);
  await updateDoc(userRef, {
    ...data,
    updatedAt: serverTimestamp(),
  });
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