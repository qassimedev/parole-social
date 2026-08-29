import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator, type Functions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let storage: FirebaseStorage;
let functions: Functions;

export function getFirebaseApp(): FirebaseApp {
  if (!app) {
    app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  }
  return app;
}

export function getAuthInstance(): Auth {
  if (!auth) {
    auth = getAuth(getFirebaseApp());
  }
  return auth;
}

export function getFirestoreInstance(): Firestore {
  if (!db) {
    db = getFirestore(getFirebaseApp());
  }
  return db;
}

export function getStorageInstance(): FirebaseStorage {
  if (!storage) {
    storage = getStorage(getFirebaseApp());
  }
  return storage;
}

export function getFunctionsInstance(): Functions {
  if (!functions) {
    functions = getFunctions(getFirebaseApp());
  }
  return functions;
}

export function isEmulatorMode(): boolean {
  return import.meta.env.DEV && typeof window !== 'undefined' && window.location.hostname === 'localhost';
}

export function connectEmulatorsIfNeeded(): void {
  if (!isEmulatorMode()) return;

  const authInstance = getAuthInstance();
  const dbInstance = getFirestoreInstance();
  const storageInstance = getStorageInstance();
  const functionsInstance = getFunctionsInstance();

  connectAuthEmulator(authInstance, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(dbInstance, 'localhost', 8080);
  connectStorageEmulator(storageInstance, 'localhost', 9199);
  connectFunctionsEmulator(functionsInstance, 'localhost', 5001);
}

connectEmulatorsIfNeeded();

export { app, auth, db, storage, functions };