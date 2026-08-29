import {
  getAuthInstance,
  getFunctionsInstance,
} from './firebase';
import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendEmailVerification,
  sendPasswordResetEmail,
  confirmPasswordReset,
  applyActionCode,
  updatePassword,
  type User,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';

const auth = getAuthInstance();
const functions = getFunctionsInstance();

export async function initAuth(): Promise<void> {
  // Auth state is observed in store.ts via onAuthStateChanged
}

export async function signIn(email: string, password: string): Promise<User> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function register(displayName: string, email: string, password: string): Promise<User> {
  const registerUser = httpsCallable<{ email: string; password: string; displayName: string }, { uid: string; email: string }>(
    functions,
    'registerUser'
  );
  await registerUser({ email, password, displayName });

  const userCredential = await signInWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(userCredential.user);

  return userCredential.user;
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

export async function sendVerificationEmail(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error('Utilisateur non connecté');
  await sendEmailVerification(user);
}

export async function resendVerificationEmail(): Promise<void> {
  await sendVerificationEmail();
}

export async function applyEmailVerificationCode(code: string): Promise<void> {
  await applyActionCode(auth, code);
}

export async function refreshEmailVerification(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error('Utilisateur non connecté');
  await user.reload();
}

export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

export async function resetPasswordWithCode(code: string, newPassword: string): Promise<void> {
  await confirmPasswordReset(auth, code, newPassword);
}

export async function handleEmailAction(params: URLSearchParams): Promise<void> {
  const mode = params.get('mode');
  const oobCode = params.get('oobCode');

  if (!oobCode) throw new Error('Code d\'action manquant');

  if (mode === 'verifyEmail') {
    await applyActionCode(auth, oobCode);
  } else if (mode === 'resetPassword') {
    // Le reset de mot de passe via lien est géré par resetPasswordWithCode côté client
    // Cette fonction est appelée pour verifyEmail uniquement
    await applyActionCode(auth, oobCode);
  }
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.email) throw new Error('Utilisateur non connecté');

  await signInWithEmailAndPassword(auth, user.email, currentPassword);
  await updatePassword(user, newPassword);
}

export async function getEmulatorOobCode(mode: 'verifyEmail' | 'resetPassword', email: string): Promise<string | null> {
  if (!import.meta.env.DEV) return null;

  try {
    const res = await fetch(`http://localhost:9099/emulator/v1/projects/parole-social/accounts/${encodeURIComponent(email)}/emulatorOobCodes`);
    if (!res.ok) return null;
    const data = await res.json();
    const codes = data.oobCodes?.[mode] ?? [];
    return codes[0] ?? null;
  } catch {
    return null;
  }
}

export { auth };