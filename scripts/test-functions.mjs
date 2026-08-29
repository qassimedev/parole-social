// ============================================================
// PAROLE - Suite de tests des Cloud Functions (Phase 1 + Phase 2)
// Exécution : npm run test:functions
//   -> firebase emulators:exec --only auth,firestore,functions "node scripts/test-functions.mjs"
//
// Couvre :
//   - Déclencheur onReportCreated : incrément de post.reportCount
//     + création/alimentation de la moderationQueue.
//   - Déclencheurs onCommentCreated / onCommentDeleted : maintien
//     de post.commentCount.
//   - Déclencheurs onLikeCreated / onLikeDeleted (Phase 3) :
//     maintien de posts.likeCount et users.likeCount (likes reçus).
//   - Callable moderatePost : masquer/rétablir/maintenir/retirer un
//     post, résoudre les signalements, tracer dans auditLogs.
//   - Callable sanctionUser : warn/ban/unban/setRole + auditLogs.
//   - Refus d'accès pour les utilisateurs sans le rôle requis.
//   - Callable registerUser (Phase 2) : inscription valide,
//     refus d'un mot de passe faible, refus d'un email déjà
//     utilisé, profil Firestore conforme au schéma attendu.
// ============================================================

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { initializeApp as initAdmin } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const projectId = 'parole-social';

const app = initializeApp({
  projectId,
  apiKey: 'test-key',
  authDomain: `${projectId}.firebaseapp.com`,
});

const auth = getAuth(app);
connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });

const functions = getFunctions(app);
connectFunctionsEmulator(functions, 'localhost', 5001);

initAdmin({ projectId });
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
const adminAuth = getAdminAuth();

const T = { createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z') };

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 30000, intervalMs = 500) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition non satisfaite après ${timeoutMs} ms${lastError ? ` (${lastError.message})` : ''}`);
}

async function createAuthUser(email) {
  const credential = await createUserWithEmailAndPassword(auth, email, 'password123');
  return credential.user.uid;
}

async function seedProfile(uid, role) {
  await db.doc(`users/${uid}`).set({
    uid,
    displayName: uid,
    role,
    banned: false,
    moderationStatus: 'none',
    postCount: 0,
    reportCount: 0,
    likeCount: 0,
    createdAt: T.createdAt,
    updatedAt: T.updatedAt,
  });
}

function seedPost(authorId, overrides = {}) {
  return db.collection('posts').add({
    authorId,
    authorName: authorId,
    content: 'Post de test',
    type: 'text',
    visibility: 'public',
    mediaPaths: [],
    moderationStatus: 'visible',
    likeCount: 0,
    commentCount: 0,
    reportCount: 0,
    shareCount: 0,
    createdAt: T.createdAt,
    updatedAt: T.updatedAt,
    ...overrides,
  });
}

async function expectCallableError(promise, code) {
  try {
    await promise;
    throw new Error(`Attendu une erreur ${code}, mais la fonction a réussi.`);
  } catch (err) {
    const got = (err?.code ?? '').replace(/^functions\//, '');
    if (got !== code) {
      throw new Error(`Attendu code ${code}, obtenu ${err?.code ?? err?.message}`);
    }
  }
}

// Les callables passent par le runtime émulé qui peut parfois
// recharger le module (défaut transitoire). On réessaie en cas de
// deadline-exceeded.
async function callWithRetry(callable, args, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await callable(args);
    } catch (err) {
      lastError = err;
      if (err?.code !== 'functions/deadline-exceeded') {
        throw err;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

// ------------------------------------------------------------
// Réchauffement du runtime des fonctions (le premier déclencheur
// froid peut prendre plusieurs dizaines de secondes).
// ------------------------------------------------------------
await fetch('http://localhost:5001/parole-social/us-central1/healthcheck')
  .then((res) => res.json())
  .then((data) => {
    if (data.status !== 'ok') throw new Error(`healthcheck inattendu : ${JSON.stringify(data)}`);
  });
await sleep(1000);

// ------------------------------------------------------------
// Déclencheurs
// ------------------------------------------------------------
test('T1  onReportCreated : reportCount incrémenté + file alimentée', async () => {
  const postRef = await seedPost('alice');
  const postId = postRef.id;

  await db.collection('reports').doc(`eve_post_${postId}`).set({
    reporterId: 'eve',
    reportId: `eve_post_${postId}`,
    targetType: 'post',
    targetId: postId,
    reason: 'harassment',
    details: '',
    status: 'pending',
    createdAt: T.createdAt,
  });

  const post = await waitFor(async () => {
    const snap = await postRef.get();
    if (snap.data()?.reportCount !== 1) return null;
    const queueSnap = await db.doc(`moderationQueue/post_${postId}`).get();
    if (!queueSnap.exists) return null;
    return { post: snap.data(), queue: queueSnap.data() };
  });
  if (post.post.reportCount !== 1) {
    throw new Error(`reportCount attendu = 1, obtenu ${post.post.reportCount}`);
  }
  const queue = post.queue;
  if (queue.status !== 'pending' || queue.reportCount !== 1 || queue.targetId !== postId) {
    throw new Error(`File de modération incohérente : ${JSON.stringify(queue)}`);
  }

  // Un second signalement (autre utilisateur) incrémente sans dupliquer l'entrée.
  await db.collection('reports').doc(`dave_post_${postId}`).set({
    reporterId: 'dave',
    reportId: `dave_post_${postId}`,
    targetType: 'post',
    targetId: postId,
    reason: 'spam',
    details: '',
    status: 'pending',
    createdAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await db.doc(`moderationQueue/post_${postId}`).get();
    return snap.data()?.reportCount === 2;
  });
});

test('T2  onCommentCreated : commentCount incrémenté', async () => {
  const postRef = await seedPost('alice');
  const postId = postRef.id;

  await db.collection('comments').add({
    postId,
    authorId: 'eve',
    content: 'Un commentaire',
    replyToId: '',
    moderationStatus: 'visible',
    deletedAt: null,
    createdAt: T.createdAt,
    updatedAt: T.updatedAt,
  });

  const post = await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.commentCount === 1 ? snap.data() : null;
  });
  if (post.commentCount !== 1) {
    throw new Error(`commentCount attendu = 1, obtenu ${post.commentCount}`);
  }
});

test('T3  onCommentDeleted : commentCount décrémenté', async () => {
  const postRef = await seedPost('alice');
  const postId = postRef.id;
  const commentRef = await db.collection('comments').add({
    postId,
    authorId: 'eve',
    content: 'À supprimer',
    replyToId: '',
    moderationStatus: 'visible',
    deletedAt: null,
    createdAt: T.createdAt,
    updatedAt: T.updatedAt,
  });

  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.commentCount === 1;
  });

  await commentRef.delete();

  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.commentCount === 0;
  });
});

// ------------------------------------------------------------
// Likes (Phase 3)
// ------------------------------------------------------------
test('T4  onLikeCreated : posts.likeCount + users.likeCount (likes reçus) incrémentés', async () => {
  await seedProfile('liker', 'user');
  await seedProfile('author1', 'user');

  const postRef = await seedPost('author1');
  const postId = postRef.id;

  await db.collection('likes').doc(`liker_${postId}`).set({
    userId: 'liker',
    postId,
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });

  const post = await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.likeCount === 1 ? snap.data() : null;
  });
  if (post.likeCount !== 1) {
    throw new Error(`posts.likeCount attendu = 1, obtenu ${post.likeCount}`);
  }

  await waitFor(async () => {
    const snap = await db.doc('users/author1').get();
    return snap.data()?.likeCount === 1;
  });
});

test('T5  onLikeDeleted : posts.likeCount + users.likeCount décrémentés', async () => {
  await seedProfile('unliker', 'user');
  await seedProfile('author2', 'user');

  const postRef = await seedPost('author2');
  const postId = postRef.id;
  const likeRef = db.collection('likes').doc(`unliker_${postId}`);

  await likeRef.set({
    userId: 'unliker',
    postId,
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.likeCount === 1;
  });
  await waitFor(async () => {
    const snap = await db.doc('users/author2').get();
    return snap.data()?.likeCount === 1;
  });

  await likeRef.delete();

  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.likeCount === 0;
  });
  await waitFor(async () => {
    const snap = await db.doc('users/author2').get();
    return snap.data()?.likeCount === 0;
  });
});

// ------------------------------------------------------------
// Callables
// ------------------------------------------------------------
test('C1  moderatePost (modérateur) : masquer un post + tracer', async () => {
  const modUid = await createAuthUser('moderator@parole.test');
  await seedProfile(modUid, 'moderator');

  const postRef = await seedPost('alice');
  const postId = postRef.id;

  // Un signalement pendant existant.
  await db.collection('reports').doc(`eve_post_${postId}`).set({
    reporterId: 'eve',
    reportId: `eve_post_${postId}`,
    targetType: 'post',
    targetId: postId,
    reason: 'illegal',
    details: '',
    status: 'pending',
    createdAt: T.createdAt,
  });

  const moderatePost = httpsCallable(functions, 'moderatePost');
  const res = await callWithRetry(moderatePost, { postId, action: 'mask', reason: 'Contenu illégal' });
  if (res.data.ok !== true || res.data.moderationStatus !== 'hidden') {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }

  const post = await postRef.get();
  const data = post.data();
  if (data.moderationStatus !== 'hidden') {
    throw new Error('Le post devrait être masqué (hidden).');
  }
  if (data.moderatorId !== modUid) {
    throw new Error('moderatorId devrait être celui du modérateur.');
  }

  // Le signalement pendant est résolu.
  const report = await db.doc(`reports/eve_post_${postId}`).get();
  if (report.data()?.status !== 'resolved') {
    throw new Error('Le signalement devrait être résolu après la décision.');
  }

  // Trace dans auditLogs.
  await waitFor(async () => {
    const snap = await db
      .collection('auditLogs')
      .where('targetId', '==', postId)
      .where('action', '==', 'post.mask')
      .get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('C2  moderatePost (utilisateur simple) : REFUS', async () => {
  const userUid = await createAuthUser('user@parole.test');
  await seedProfile(userUid, 'user');

  const postRef = await seedPost('alice');
  const postId = postRef.id;

  const moderatePost = httpsCallable(functions, 'moderatePost');
  await expectCallableError(moderatePost({ postId, action: 'mask', reason: 'x' }), 'permission-denied');

  // Le post n'a pas été modifié.
  const data = (await postRef.get()).data();
  if (data.moderationStatus !== 'visible') {
    throw new Error('Le post ne devrait pas être modifié par un utilisateur simple.');
  }

  await signOut(auth);
});

test('C3  moderatePost : action inconnue REFUS', async () => {
  const modUid = await createAuthUser('moderator2@parole.test');
  await seedProfile(modUid, 'moderator');

  const postRef = await seedPost('alice');
  const postId = postRef.id;

  const moderatePost = httpsCallable(functions, 'moderatePost');
  await expectCallableError(moderatePost({ postId, action: 'nuke', reason: 'x' }), 'invalid-argument');

  await signOut(auth);
});

test('C4  sanctionUser (admin) : bannir un utilisateur + tracer', async () => {
  const adminUid = await createAuthUser('admin@parole.test');
  await seedProfile(adminUid, 'admin');
  await seedProfile('targetuser', 'user');

  const sanctionUser = httpsCallable(functions, 'sanctionUser');
  const res = await callWithRetry(sanctionUser, { userId: 'targetuser', action: 'ban', reason: 'Harcèlement grave' });
  if (res.data.ok !== true) {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }

  const user = await db.doc('users/targetuser').get();
  if (user.data()?.banned !== true || user.data()?.moderationStatus !== 'suspended') {
    throw new Error('L’utilisateur devrait être banni (banned + suspended).');
  }

  await waitFor(async () => {
    const snap = await db
      .collection('auditLogs')
      .where('targetId', '==', 'targetuser')
      .where('action', '==', 'user.ban')
      .get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('C5  sanctionUser (admin) : changer le rôle + tracer', async () => {
  const adminUid = await createAuthUser('admin2@parole.test');
  await seedProfile(adminUid, 'admin');
  await seedProfile('newmod', 'user');

  const sanctionUser = httpsCallable(functions, 'sanctionUser');
  await callWithRetry(sanctionUser, { userId: 'newmod', action: 'setRole', role: 'moderator', reason: 'Promotion' });

  const user = await db.doc('users/newmod').get();
  if (user.data()?.role !== 'moderator') {
    throw new Error('Le rôle devrait être passé à moderator.');
  }

  await waitFor(async () => {
    const snap = await db
      .collection('auditLogs')
      .where('targetId', '==', 'newmod')
      .where('action', '==', 'user.setRole')
      .get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('C6  sanctionUser (modérateur) : ban REFUS, warn OK', async () => {
  const modUid = await createAuthUser('moderator3@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('warneduser', 'user');

  const sanctionUser = httpsCallable(functions, 'sanctionUser');

  // Un modérateur ne peut pas bannir.
  await expectCallableError(sanctionUser({ userId: 'warneduser', action: 'ban', reason: 'x' }), 'permission-denied');

  // Un modérateur peut avertir.
  await callWithRetry(sanctionUser, { userId: 'warneduser', action: 'warn', reason: 'Avertissement' });
  const user = await db.doc('users/warneduser').get();
  if (user.data()?.moderationStatus !== 'warned') {
    throw new Error('Le statut de modération devrait être warned.');
  }

  await signOut(auth);
});

// ------------------------------------------------------------
// Inscription (Phase 2)
// ------------------------------------------------------------
test('C7  registerUser : inscription valide + profil Firestore conforme', async () => {
  const email = 'register@parole.test';
  const registerUser = httpsCallable(functions, 'registerUser');
  const res = await callWithRetry(registerUser, {
    email,
    password: 'password123',
    displayName: '  Test Register  ',
  });
  if (!res.data.uid || res.data.email !== email) {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }

  // L'utilisateur Auth a bien été créé et peut se connecter.
  await signInWithEmailAndPassword(auth, email, 'password123');
  await signOut(auth);

  // Profil Firestore strictement conforme au schéma attendu.
  const profile = await db.doc(`users/${res.data.uid}`).get();
  if (!profile.exists) {
    throw new Error('Le profil Firestore devrait être créé par registerUser.');
  }
  const data = profile.data();
  const expectedKeys = [
    'uid',
    'displayName',
    'bio',
    'avatarPath',
    'role',
    'banned',
    'moderationStatus',
    'postCount',
    'reportCount',
    'likeCount',
    'createdAt',
    'updatedAt',
  ].sort();
  const actualKeys = Object.keys(data).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Champs du profil inattendus : ${actualKeys.join(', ')}`);
  }
  if (data.uid !== res.data.uid || data.displayName !== 'Test Register') {
    throw new Error(`Identité du profil incorrecte : ${JSON.stringify({ uid: data.uid, displayName: data.displayName })}`);
  }
  if (data.bio !== '' || data.avatarPath !== '') {
    throw new Error('bio/avatarPath devraient être initialisés vides.');
  }
  if (data.role !== 'user' || data.banned !== false || data.moderationStatus !== 'none') {
    throw new Error('Champs système incorrects (role/banned/moderationStatus).');
  }
  if (data.postCount !== 0 || data.reportCount !== 0 || data.likeCount !== 0) {
    throw new Error('Les compteurs devraient être initialisés à zéro.');
  }
  if (!data.createdAt || !data.updatedAt) {
    throw new Error('createdAt/updatedAt devraient être renseignés.');
  }
});

test('C8  registerUser : mot de passe faible REFUS', async () => {
  const email = 'weakpw@parole.test';
  const registerUser = httpsCallable(functions, 'registerUser');
  await expectCallableError(
    callWithRetry(registerUser, { email, password: 'abc1', displayName: 'Faible' }),
    'invalid-argument'
  );

  // Aucun compte Auth ni profil Firestore ne doit avoir été créé.
  let accountExists = false;
  try {
    await adminAuth.getUserByEmail(email);
    accountExists = true;
  } catch {
    accountExists = false;
  }
  if (accountExists) {
    throw new Error('Aucun compte Auth ne devrait exister pour un mot de passe faible.');
  }
});

test('C9  registerUser : email déjà utilisé REFUS', async () => {
  const registerUser = httpsCallable(functions, 'registerUser');
  await expectCallableError(
    callWithRetry(registerUser, {
      email: 'register@parole.test',
      password: 'password123',
      displayName: 'Doublon',
    }),
    'already-exists'
  );
});

// ------------------------------------------------------------
// Exécution
// ------------------------------------------------------------
let passed = 0;
const failed = [];

console.log('=== PAROLE - Tests des Cloud Functions (Phase 1 + Phase 2) ===\n');

for (const t of results) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ✔  ${t.name}`);
  } catch (err) {
    failed.push({ name: t.name, message: err?.message ?? String(err) });
    console.error(`  ✖  ${t.name}`);
    console.error(`       → ${failed[failed.length - 1].message}`);
  }
}

console.log(`\nRésultat : ${passed}/${results.length} tests réussis.`);

if (failed.length > 0) {
  console.error(`\n${failed.length} test(s) échoué(s) :`);
  for (const f of failed) {
    console.error(`  - ${f.name} : ${f.message}`);
  }
  process.exit(1);
}
console.log('Tous les tests de fonctions sont passés.');