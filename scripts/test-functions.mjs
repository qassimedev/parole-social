// ============================================================
// PAROLE - Suite de tests des Cloud Functions (Phase 1 + Phase 2 + Phase 6)
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
//   - Déclencheurs onFollowCreated / onFollowDeleted (Phase 4) :
//     maintien de users.followingCount (suiveur) et
//     users.followerCount (suivi).
//   - Déclencheurs de notifications (Phase 5) : onLikeCreated /
//     onCommentCreated / onFollowCreated créent une notification au
//     propriétaire concerné (jamais pour soi-même) ; onNotification
//     Created/Updated/Deleted maintiennent users.notificationCount
//     (décrément idempotent au passage non lue -> lue).
//   - Déclencheurs de partage/renvoi (Phase 6) : onShareCreated /
//     onShareDeleted maintiennent posts.shareCount (+1/-1), sans
//     aucun compteur users.shareCount, et créent une notification
//     « share » au propriétaire du post (jamais pour un self-share).
//   - Déclencheurs de messagerie privée (Phase 9 - Lot 3) :
//     onMessageCreated actualise la conversation (lastMessageAt /
//     lastMessagePreview / lastSenderId, preview normalisée puis
//     tronquée à 80), incrémente users.messageCount du DESTINATAIRE
//     (+1, jamais l'expéditeur) et crée une notification « message » ;
//     onMessageUpdated décrémente EXACTEMENT un non-lu au passage
//     non lu -> lu, de façon idempotente et jamais en dessous de 0 ;
//     une conversation mal formée n'a aucun effet (défensif).
//   - Callable moderatePost : masquer/rétablir/maintenir/retirer un
//     post, résoudre les signalements, tracer dans auditLogs.
//   - Callable sanctionUser : warn/ban/unban/setRole + auditLogs.
//   - Callable reviewAppeal (Phase 9 - Lot 4) : un modérateur/admin
//     tranche un recours — 'accepted' restaure la cible (post/comment
//     -> 'visible', user -> dé-sanction), 'rejected' ne restaure rien ;
//     clôture traçable du recours (status + reviewedBy + reviewedAt),
//     auditLogs, notification 'appeal' à l'appelant (jamais pour soi-
//     même), idempotence (recours déjà résolu refusé), cible disparue
//     -> not-found sans clôture, accès réservé modérateur/admin.
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
    followerCount: 0,
    followingCount: 0,
    notificationCount: 0,
    messageCount: 0,
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
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

// Recours (Phase 9 - Lot 4) : doc écrit via Admin SDK (contourne les
// règles, prudent aux appels) avec l'ID DÉTERMINISTE
// `${appellantId}_${targetType}_${targetId}`. L'enforcement des règles
// de création est couvert par le bloc Q de test-rules.mjs.
async function seedAppeal(appellantId, targetType, targetId, sanctionType, reason = 'Je conteste cette sanction.') {
  const appealId = `${appellantId}_${targetType}_${targetId}`;
  await db.doc(`appeals/${appealId}`).set({
    appealId,
    appellantId,
    targetType,
    targetId,
    sanctionType,
    reason,
    status: 'pending',
    createdAt: T.createdAt,
  });
  return appealId;
}

async function seedComment(postId, authorId, content = 'Commentaire', overrides = {}) {
  const ref = await db.collection('comments').add({
    postId,
    authorId,
    content,
    replyToId: '',
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
    moderationStatus: 'visible',
    deletedAt: null,
    ...overrides,
  });
  return ref;
}

// Partage (Phase 6) : ID déterministe `{userId}_{postId}` — le champ
// posts.shareCount est maintenu par onShareCreated/onShareDeleted.
function shareDoc(userId, postId) {
  return {
    userId,
    postId,
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  };
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
// Abonnements (Phase 4)
// ------------------------------------------------------------
test('T6  onFollowCreated : followingCount + followerCount incrémentés', async () => {
  await seedProfile('follower01', 'user');
  await seedProfile('followed01', 'user');

  await db.collection('follows').doc('follower01_followed01').set({
    followerId: 'follower01',
    followingId: 'followed01',
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await db.doc('users/follower01').get();
    return snap.data()?.followingCount === 1;
  });
  await waitFor(async () => {
    const snap = await db.doc('users/followed01').get();
    return snap.data()?.followerCount === 1;
  });
});

test('T7  onFollowDeleted : followingCount + followerCount décrémentés', async () => {
  await seedProfile('unfollower', 'user');
  await seedProfile('followed02', 'user');
  const followRef = db.collection('follows').doc('unfollower_followed02');

  await followRef.set({
    followerId: 'unfollower',
    followingId: 'followed02',
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await db.doc('users/unfollower').get();
    return snap.data()?.followingCount === 1;
  });
  await waitFor(async () => {
    const snap = await db.doc('users/followed02').get();
    return snap.data()?.followerCount === 1;
  });

  await followRef.delete();

  await waitFor(async () => {
    const snap = await db.doc('users/unfollower').get();
    return snap.data()?.followingCount === 0;
  });
  await waitFor(async () => {
    const snap = await db.doc('users/followed02').get();
    return snap.data()?.followerCount === 0;
  });
});

// ------------------------------------------------------------
// Notifications (Phase 5)
// ------------------------------------------------------------
async function seedNotification(recipientId, actorId, type, overrides = {}) {
  return db.collection('notifications').add({
    recipientId,
    actorId,
    type,
    postId: '',
    commentId: '',
    read: false,
    readAt: null,
    createdAt: T.createdAt,
    ...overrides,
  });
}

test('T8  onLikeCreated : notification « like » créée pour le propriétaire du post', async () => {
  await seedProfile('liker8', 'user');
  await seedProfile('owner8', 'user');

  const postRef = await seedPost('owner8');
  const postId = postRef.id;

  await db.collection('likes').doc(`liker8_${postId}`).set({
    userId: 'liker8',
    postId,
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });

  const notifications = await waitFor(async () => {
    const snap = await db.collection('notifications').where('postId', '==', postId).get();
    return snap.size > 0 ? snap.docs : null;
  });
  const n = notifications[0].data();
  if (n.recipientId !== 'owner8' || n.actorId !== 'liker8' || n.type !== 'like') {
    throw new Error(`Notification like incohérente : ${JSON.stringify(n)}`);
  }
  if (n.postId !== postId || n.commentId !== '' || n.read !== false || n.readAt !== null) {
    throw new Error(`Schéma de notification incohérent : ${JSON.stringify(n)}`);
  }
  if (!n.createdAt) {
    throw new Error('createdAt devrait être renseigné.');
  }
});

test('T9  onLikeCreated : like sur son propre post → aucune notification', async () => {
  await seedProfile('owner9', 'user');

  const postRef = await seedPost('owner9');
  const postId = postRef.id;

  await db.collection('likes').doc(`owner9_${postId}`).set({
    userId: 'owner9',
    postId,
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });

  // Le likeCount est incrémenté à la fin de onLikeCreated : attendre
  // cette valeur garantit que le déclencheur s'est exécuté.
  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.likeCount === 1;
  });
  await sleep(1000);
  const snap = await db.collection('notifications').where('postId', '==', postId).get();
  if (snap.size > 0) {
    throw new Error('Aucune notification ne devrait exister pour un like sur son propre post.');
  }
});

test('T10 onCommentCreated : notification « comment » créée pour le propriétaire du post', async () => {
  await seedProfile('commenter10', 'user');
  await seedProfile('owner10', 'user');

  const postRef = await seedPost('owner10');
  const postId = postRef.id;

  const commentRef = await db.collection('comments').add({
    postId,
    authorId: 'commenter10',
    content: 'Un commentaire',
    replyToId: '',
    moderationStatus: 'visible',
    deletedAt: null,
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });
  const commentId = commentRef.id;

  const notifications = await waitFor(async () => {
    const snap = await db.collection('notifications').where('commentId', '==', commentId).get();
    return snap.size > 0 ? snap.docs : null;
  });
  const n = notifications[0].data();
  if (n.recipientId !== 'owner10' || n.actorId !== 'commenter10' || n.type !== 'comment') {
    throw new Error(`Notification comment incohérente : ${JSON.stringify(n)}`);
  }
  if (n.postId !== postId || n.commentId !== commentId || n.read !== false || n.readAt !== null) {
    throw new Error(`Schéma de notification incohérent : ${JSON.stringify(n)}`);
  }
});

test('T11 onCommentCreated : commentaire sur son propre post → aucune notification', async () => {
  await seedProfile('owner11', 'user');

  const postRef = await seedPost('owner11');
  const postId = postRef.id;

  await db.collection('comments').add({
    postId,
    authorId: 'owner11',
    content: 'Self-commentaire',
    replyToId: '',
    moderationStatus: 'visible',
    deletedAt: null,
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });

  // commentCount incrémenté à la fin du déclencheur : garantit son exécution.
  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.commentCount === 1;
  });
  await sleep(1000);
  const snap = await db.collection('notifications').where('postId', '==', postId).get();
  if (snap.size > 0) {
    throw new Error('Aucune notification ne devrait exister pour un commentaire sur son propre post.');
  }
});

test('T12 onFollowCreated : notification « follow » créée pour l’utilisateur suivi', async () => {
  await seedProfile('follower12', 'user');
  await seedProfile('followed12', 'user');

  await db.collection('follows').doc('follower12_followed12').set({
    followerId: 'follower12',
    followingId: 'followed12',
    createdAt: T.createdAt,
    updatedAt: T.createdAt,
  });

  const notifications = await waitFor(async () => {
    const snap = await db.collection('notifications').where('recipientId', '==', 'followed12').get();
    const followDocs = snap.docs.filter((d) => d.data().type === 'follow' && d.data().actorId === 'follower12');
    return followDocs.length > 0 ? followDocs : null;
  });
  const n = notifications[0].data();
  if (n.recipientId !== 'followed12' || n.actorId !== 'follower12' || n.type !== 'follow') {
    throw new Error(`Notification follow incohérente : ${JSON.stringify(n)}`);
  }
  if (n.postId !== '' || n.commentId !== '' || n.read !== false || n.readAt !== null) {
    throw new Error(`Schéma de notification incohérent : ${JSON.stringify(n)}`);
  }
});

test('T13 onNotificationCreated : notification non lue → notificationCount +1', async () => {
  await seedProfile('recipient13', 'user');
  if ((await db.doc('users/recipient13').get()).data()?.notificationCount !== 0) {
    throw new Error('notificationCount devrait démarrer à 0.');
  }

  await seedNotification('recipient13', 'someone', 'follow');

  await waitFor(async () => {
    const snap = await db.doc('users/recipient13').get();
    return snap.data()?.notificationCount === 1;
  });
});

test('T14 onNotificationUpdated : marquage lu → -1, et idempotence', async () => {
  await seedProfile('recipient14', 'user');
  const notifRef = await seedNotification('recipient14', 'someone', 'like');

  await waitFor(async () => {
    const snap = await db.doc('users/recipient14').get();
    return snap.data()?.notificationCount === 1;
  });

  // Marquage lu → décrément de 1.
  await notifRef.update({ read: true, readAt: T.createdAt });
  await waitFor(async () => {
    const snap = await db.doc('users/recipient14').get();
    return snap.data()?.notificationCount === 0;
  });

  // Idempotence : re-marquage d'une notification déjà lue → aucun
  // second décrément (le compteur ne passe jamais négatif).
  await notifRef.update({ read: true, readAt: new Date('2026-02-01T00:00:00Z') });
  await sleep(1500);
  const snap = await db.doc('users/recipient14').get();
  if (snap.data()?.notificationCount !== 0) {
    throw new Error(`notificationCount devrait rester 0 après re-marquage, obtenu ${snap.data()?.notificationCount}`);
  }
});

// ------------------------------------------------------------
// Partage / renvoi (Phase 6)
// posts.shareCount est maintenu par onShareCreated (+1) et
// onShareDeleted (-1). Aucun compteur users.shareCount. Une
// notification de type « share » est créée au propriétaire du post
// partagé, jamais pour un self-share.
// ------------------------------------------------------------
test('S1  onShareCreated : post.shareCount incrémenté', async () => {
  await seedProfile('sharer1', 'user');
  await seedProfile('ownerS1', 'user');

  const postRef = await seedPost('ownerS1');
  const postId = postRef.id;

  await db.collection('shares').doc(`sharer1_${postId}`).set(shareDoc('sharer1', postId));

  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.shareCount === 1;
  });
  // Aucun users.shareCount : seul posts.shareCount existe.
  const owner = await db.doc('users/ownerS1').get();
  if (owner.data()?.shareCount !== undefined) {
    throw new Error('users.shareCount ne doit pas exister.');
  }
});

test('S2  onShareDeleted : post.shareCount décrémenté', async () => {
  await seedProfile('unsharer', 'user');
  await seedProfile('ownerS2', 'user');

  const postRef = await seedPost('ownerS2');
  const postId = postRef.id;
  const shareRef = db.collection('shares').doc(`unsharer_${postId}`);

  await shareRef.set(shareDoc('unsharer', postId));
  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.shareCount === 1;
  });

  await shareRef.delete();
  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.shareCount === 0;
  });
});

test('S3  onShareCreated : notification « share » créée pour le propriétaire du post', async () => {
  await seedProfile('sharer3', 'user');
  await seedProfile('ownerS3', 'user');

  const postRef = await seedPost('ownerS3');
  const postId = postRef.id;

  await db.collection('shares').doc(`sharer3_${postId}`).set(shareDoc('sharer3', postId));

  const notifications = await waitFor(async () => {
    const snap = await db.collection('notifications').where('postId', '==', postId).get();
    const shareDocs = snap.docs.filter((d) => d.data().type === 'share' && d.data().actorId === 'sharer3');
    return shareDocs.length > 0 ? shareDocs : null;
  });
  const n = notifications[0].data();
  if (n.recipientId !== 'ownerS3' || n.actorId !== 'sharer3' || n.type !== 'share') {
    throw new Error(`Notification share incohérente : ${JSON.stringify(n)}`);
  }
  if (n.postId !== postId || n.commentId !== '' || n.read !== false || n.readAt !== null) {
    throw new Error(`Schéma de notification incohérent : ${JSON.stringify(n)}`);
  }
  if (!n.createdAt) {
    throw new Error('createdAt devrait être renseigné.');
  }
});

test('S4  onShareCreated : partage de son propre post → aucune notification', async () => {
  await seedProfile('ownerS4', 'user');

  const postRef = await seedPost('ownerS4');
  const postId = postRef.id;

  await db.collection('shares').doc(`ownerS4_${postId}`).set(shareDoc('ownerS4', postId));

  // shareCount incrémenté à la fin de onShareCreated : garantit son exécution.
  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.shareCount === 1;
  });
  await sleep(1000);
  const snap = await db.collection('notifications').where('postId', '==', postId).get();
  if (snap.size > 0) {
    throw new Error('Aucune notification ne devrait exister pour un partage de son propre post.');
  }
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
    'followerCount',
    'followingCount',
    'notificationCount',
    'messageCount',
    'searchTokens',
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
  if (data.followerCount !== 0 || data.followingCount !== 0) {
    throw new Error('Les compteurs d’abonnements devraient être initialisés à zéro.');
  }
  if (data.notificationCount !== 0) {
    throw new Error('notificationCount devrait être initialisé à zéro.');
  }
  if (!data.searchTokens || !Array.isArray(data.searchTokens)) {
    throw new Error('searchTokens devrait être un tableau initialisé par registerUser (Phase 9 - Lot 5).');
  }
  // Tokens dérivés du displayName trim 'Test Register' (même
  // convention que src/lib/search.ts) : préfixes 2..bornés de chaque
  // mot dédupliqués dans l'ordre, bornés à 12.
  const expectedTokens = ['te', 'tes', 'test', 're', 'reg', 'regi', 'regis', 'regist', 'registe', 'register'];
  if (JSON.stringify(data.searchTokens) !== JSON.stringify(expectedTokens)) {
    throw new Error(`searchTokens inattendus : ${data.searchTokens.join(', ')}`);
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
// Dette P3 — Notifications de réponse (type 'reply')
// Un commentaire avec replyToId non vide notifie l'auteur du
// commentaire parent (jamais pour un self-reply, jamais si c'est
// déjà l'auteur du post — pas de doublon). On vérifie aussi que le
// compteur users.notificationCount est bien incrémenté.
// ------------------------------------------------------------
test('R1 onCommentCreated : notification reply créée pour l’auteur du commentaire parent', async () => {
  await seedProfile('postownerR1', 'user');
  await seedProfile('rootcommentR1', 'user');
  await seedProfile('replierR1', 'user');

  const postRef = await seedPost('postownerR1');
  const postId = postRef.id;

  const rootRef = await db.collection('comments').add({
    postId, authorId: 'rootcommentR1', content: 'Commentaire racine', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const rootId = rootRef.id;

  const replyRef = await db.collection('comments').add({
    postId, authorId: 'replierR1', content: 'Une réponse', replyToId: rootId,
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const replyId = replyRef.id;

  const notifications = await waitFor(async () => {
    const snap = await db
      .collection('notifications')
      .where('actorId', '==', 'replierR1')
      .where('type', '==', 'reply')
      .get();
    return snap.size > 0 ? snap.docs : null;
  });
  const n = notifications[0].data();
  if (n.recipientId !== 'rootcommentR1' || n.type !== 'reply') {
    throw new Error(`Notification reply incohérente : ${JSON.stringify(n)}`);
  }
  if (n.postId !== postId || n.commentId !== replyId || n.read !== false || n.readAt !== null) {
    throw new Error(`Schéma de la notification reply incohérent : ${JSON.stringify(n)}`);
  }
});

test('R2 onCommentCreated : réponse à soi-même → aucune notification reply', async () => {
  await seedProfile('postownerR2', 'user');
  await seedProfile('selfR2', 'user');
  const postRef = await seedPost('postownerR2');
  const postId = postRef.id;

  const rootRef = await db.collection('comments').add({
    postId, authorId: 'selfR2', content: 'Racine', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const rootId = rootRef.id;

  await db.collection('comments').add({
    postId, authorId: 'selfR2', content: 'Self-reply', replyToId: rootId,
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.commentCount === 2;
  });
  await sleep(1000);
  const snap = await db
    .collection('notifications')
    .where('actorId', '==', 'selfR2')
    .where('type', '==', 'reply')
    .get();
  if (snap.size > 0) {
    throw new Error('Aucune notification reply ne devrait exister pour une réponse à soi-même.');
  }
});

test('R3 onCommentCreated : réponse à un commentaire de l’auteur du post → pas de doublon reply', async () => {
  await seedProfile('ownerR3', 'user');
  await seedProfile('replierR3', 'user');
  const postRef = await seedPost('ownerR3');
  const postId = postRef.id;

  const parentRef = await db.collection('comments').add({
    postId, authorId: 'ownerR3', content: 'Commentaire de l’auteur', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const parentId = parentRef.id;

  await db.collection('comments').add({
    postId, authorId: 'replierR3', content: 'Réponse', replyToId: parentId,
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.commentCount === 2;
  });
  await sleep(1000);
  const snap = await db
    .collection('notifications')
    .where('actorId', '==', 'replierR3')
    .where('type', '==', 'reply')
    .get();
  if (snap.size > 0) {
    throw new Error('Aucune notification reply ne devrait être créée quand le parent est l’auteur du post.');
  }
});

test('R4 onCommentCreated : réponse à un commentaire parent absent → pas de notification reply', async () => {
  await seedProfile('postownerR4', 'user');
  await seedProfile('replierR4', 'user');
  const postRef = await seedPost('postownerR4');
  const postId = postRef.id;

  await db.collection('comments').add({
    postId, authorId: 'replierR4', content: 'Réponse à un fantôme', replyToId: 'ghost_comment',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await postRef.get();
    return snap.data()?.commentCount === 1;
  });
  await sleep(1000);
  const snap = await db
    .collection('notifications')
    .where('actorId', '==', 'replierR4')
    .where('type', '==', 'reply')
    .get();
  if (snap.size > 0) {
    throw new Error('Aucune notification reply ne devrait exister pour un parent absent.');
  }
});

test('R5 onCommentCreated : notification reply → notificationCount de l’auteur du parent +1', async () => {
  await seedProfile('postownerR5', 'user');
  await seedProfile('rootcommentR5', 'user');
  await seedProfile('replierR5', 'user');
  const postRef = await seedPost('postownerR5');
  const postId = postRef.id;

  const rootRef = await db.collection('comments').add({
    postId, authorId: 'rootcommentR5', content: 'Racine', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const rootId = rootRef.id;

  await db.collection('comments').add({
    postId, authorId: 'replierR5', content: 'Réponse', replyToId: rootId,
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });

  // Le commentaire racine notifie uniquement le propriétaire du post ;
  // la réponse notifie l'auteur du parent (rootcommentR5) → +1.
  await waitFor(async () => {
    const snap = await db.doc('users/rootcommentR5').get();
    return snap.data()?.notificationCount === 1;
  });
});

// ------------------------------------------------------------
// Dette P3 — users.reportCount (compteur « signalements reçus »)
// Maintenu par les déclencheurs : +1 à la création d'un signalement
// de commentaire/utilisateur (sur l'auteur de la cible), -1 défensif
// à la suppression.
// ------------------------------------------------------------
test('RA1 onReportCreated : signalement de commentaire → users.reportCount de l’auteur +1', async () => {
  await seedProfile('ownerA1', 'user');
  await seedProfile('reporterA1', 'user');
  const postRef = await seedPost('ownerA1');
  const postId = postRef.id;

  const commentRef = await db.collection('comments').add({
    postId, authorId: 'ownerA1', content: 'Commentaire signalé', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const commentId = commentRef.id;

  await db.collection('reports').doc(`reporterA1_comment_${commentId}`).set({
    reporterId: 'reporterA1', reportId: `reporterA1_comment_${commentId}`,
    targetType: 'comment', targetId: commentId, reason: 'hate', details: '', status: 'pending',
    createdAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await db.doc('users/ownerA1').get();
    return snap.data()?.reportCount === 1;
  });
});

test('RA2 onReportCreated : signalement d’utilisateur → users.reportCount de la cible +1', async () => {
  await seedProfile('targetA2', 'user');
  await seedProfile('reporterA2', 'user');

  await db.collection('reports').doc('reporterA2_user_targetA2').set({
    reporterId: 'reporterA2', reportId: 'reporterA2_user_targetA2',
    targetType: 'user', targetId: 'targetA2', reason: 'harassment', details: '', status: 'pending',
    createdAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await db.doc('users/targetA2').get();
    return snap.data()?.reportCount === 1;
  });
});

test('RA3 onReportDeleted : suppression d’un signalement de commentaire → users.reportCount -1', async () => {
  await seedProfile('ownerA3', 'user');
  await seedProfile('reporterA3', 'user');
  const postRef = await seedPost('ownerA3');
  const postId = postRef.id;

  const commentRef = await db.collection('comments').add({
    postId, authorId: 'ownerA3', content: 'Cible', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const commentId = commentRef.id;

  await db.collection('reports').doc(`reporterA3_comment_${commentId}`).set({
    reporterId: 'reporterA3', reportId: `reporterA3_comment_${commentId}`,
    targetType: 'comment', targetId: commentId, reason: 'spam', details: '', status: 'pending',
    createdAt: T.createdAt,
  });

  await waitFor(async () => {
    const snap = await db.doc('users/ownerA3').get();
    return snap.data()?.reportCount === 1;
  });

  await db.collection('reports').doc(`reporterA3_comment_${commentId}`).delete();

  await waitFor(async () => {
    const snap = await db.doc('users/ownerA3').get();
    return snap.data()?.reportCount === 0;
  });
});

// ------------------------------------------------------------
// Dette P2 — moderation des commentaires (moderateComment)
// et résolution des signalements utilisateur à la sanction.
// ------------------------------------------------------------
test('D1 moderateComment (modérateur) : masquer un commentaire + résoudre les signalements + tracer', async () => {
  const modUid = await createAuthUser('moderatorD1@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('ownerD1', 'user');

  const postRef = await seedPost('ownerD1');
  const postId = postRef.id;
  const commentRef = await db.collection('comments').add({
    postId, authorId: 'ownerD1', content: 'Commentaire à masquer', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const commentId = commentRef.id;

  await db.collection('reports').doc(`eve_comment_${commentId}`).set({
    reporterId: 'eve', reportId: `eve_comment_${commentId}`,
    targetType: 'comment', targetId: commentId, reason: 'hate', details: '', status: 'pending',
    createdAt: T.createdAt,
  });

  const moderateComment = httpsCallable(functions, 'moderateComment');
  const res = await callWithRetry(moderateComment, { commentId, action: 'mask', reason: 'Haineux' });
  if (res.data.ok !== true || res.data.moderationStatus !== 'hidden') {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }

  const comment = await commentRef.get();
  if (comment.data()?.moderationStatus !== 'hidden') {
    throw new Error('Le commentaire devrait être masqué (hidden).');
  }

  const report = await db.doc(`reports/eve_comment_${commentId}`).get();
  if (report.data()?.status !== 'resolved') {
    throw new Error('Le signalement devrait être résolu après la décision.');
  }

  await waitFor(async () => {
    const snap = await db
      .collection('auditLogs')
      .where('targetId', '==', commentId)
      .where('action', '==', 'comment.mask')
      .get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('D1b moderateComment (modérateur) : action remove produit bien removed', async () => {
  const modUid = await createAuthUser('moderatorD1b@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('ownerD1b', 'user');

  const postRef = await seedPost('ownerD1b');
  const postId = postRef.id;
  const commentRef = await db.collection('comments').add({
    postId, authorId: 'ownerD1b', content: 'Commentaire à retirer', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const commentId = commentRef.id;

  const moderateComment = httpsCallable(functions, 'moderateComment');
  const res = await callWithRetry(moderateComment, { commentId, action: 'remove', reason: 'Haineux' });
  if (res.data.ok !== true || res.data.moderationStatus !== 'removed') {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }

  const comment = await commentRef.get();
  if (comment.data()?.moderationStatus !== 'removed') {
    throw new Error('Le commentaire devrait être retiré (removed).');
  }

  await waitFor(async () => {
    const snap = await db
      .collection('auditLogs')
      .where('targetId', '==', commentId)
      .where('action', '==', 'comment.remove')
      .get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('D2 moderateComment (utilisateur simple) : REFUS', async () => {
  const userUid = await createAuthUser('userD2@parole.test');
  await seedProfile(userUid, 'user');
  await seedProfile('ownerD2', 'user');
  const postRef = await seedPost('ownerD2');
  const postId = postRef.id;
  const commentRef = await db.collection('comments').add({
    postId, authorId: 'ownerD2', content: 'Commentaire', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const commentId = commentRef.id;

  const moderateComment = httpsCallable(functions, 'moderateComment');
  await expectCallableError(moderateComment({ commentId, action: 'mask', reason: 'x' }), 'permission-denied');

  const data = (await commentRef.get()).data();
  if (data.moderationStatus !== 'visible') {
    throw new Error('Le commentaire ne devrait pas être modifié par un utilisateur simple.');
  }
  await signOut(auth);
});

test('D3 moderateComment : action inconnue REFUS', async () => {
  const modUid = await createAuthUser('moderatorD3@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('ownerD3', 'user');
  const postRef = await seedPost('ownerD3');
  const postId = postRef.id;
  const commentRef = await db.collection('comments').add({
    postId, authorId: 'ownerD3', content: 'Commentaire', replyToId: '',
    moderationStatus: 'visible', deletedAt: null, createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  const commentId = commentRef.id;

  const moderateComment = httpsCallable(functions, 'moderateComment');
  await expectCallableError(moderateComment({ commentId, action: 'nuke', reason: 'x' }), 'invalid-argument');
  await signOut(auth);
});

test('D4 moderateComment : commentaire inexistant REFUS (not-found)', async () => {
  const modUid = await createAuthUser('moderatorD4@parole.test');
  await seedProfile(modUid, 'moderator');
  const moderateComment = httpsCallable(functions, 'moderateComment');
  await expectCallableError(moderateComment({ commentId: 'ghost_comment', action: 'mask', reason: 'x' }), 'not-found');
  await signOut(auth);
});

test('D5 sanctionUser (admin) : avertir un utilisateur résout ses signalements + clôt la file', async () => {
  const adminUid = await createAuthUser('adminD5@parole.test');
  await seedProfile(adminUid, 'admin');
  await seedProfile('targetD5', 'user');

  await db.collection('reports').doc('eve_user_targetD5').set({
    reporterId: 'eve', reportId: 'eve_user_targetD5',
    targetType: 'user', targetId: 'targetD5', reason: 'harassment', details: '', status: 'pending',
    createdAt: T.createdAt,
  });
  await db.doc('moderationQueue/user_targetD5').set({
    targetType: 'user', targetId: 'targetD5', status: 'pending', reportCount: 1,
    firstReporterId: 'eve', lastReporterId: 'eve', reason: 'harassment',
    createdAt: T.createdAt, updatedAt: T.createdAt,
  });
  // Garantir que onReportCreated a incrémenté users.reportCount.
  await waitFor(async () => {
    const snap = await db.doc('users/targetD5').get();
    return snap.data()?.reportCount >= 1;
  });

  const sanctionUser = httpsCallable(functions, 'sanctionUser');
  await callWithRetry(sanctionUser, { userId: 'targetD5', action: 'warn', reason: 'Harcèlement' });

  const report = await db.doc('reports/eve_user_targetD5').get();
  if (report.data()?.status !== 'resolved') {
    throw new Error('Le signalement utilisateur devrait être résolu après le warn.');
  }
  const queue = await db.doc('moderationQueue/user_targetD5').get();
  if (queue.data()?.status !== 'resolved') {
    throw new Error('La file de modération utilisateur devrait être résolue.');
  }
  await signOut(auth);
});

// ------------------------------------------------------------
// Messagerie privée (Phase 9 - Lot 3)
// users.messageCount (messages NON LUS reçus) est maintenu
// EXCLUSIVEMENT par onMessageCreated (incrément du destinataire +
// notification « message » + actualisation de la conversation) et
// onMessageUpdated (décrément EXACTEMENT unitaire et idempotent au
// passage non lu -> lu, borné à >= 0). Jamais pour l'expéditeur.
// ------------------------------------------------------------
async function seedConversation(a, b, overrides = {}) {
  const participants = [a, b].sort();
  const id = participants.join('_');
  await db.doc(`conversations/${id}`).set({
    participants,
    createdAt: T.createdAt,
    lastMessageAt: null,
    lastMessagePreview: '',
    lastSenderId: '',
    ...overrides,
  });
  return id;
}

async function seedMessage(conversationId, senderId, content, overrides = {}) {
  return db.collection('messages').add({
    conversationId,
    senderId,
    content,
    read: false,
    readAt: null,
    moderationStatus: 'visible',
    createdAt: T.createdAt,
    ...overrides,
  });
}

test('MSG1 onMessageCreated : conversation actualisée + messageCount du destinataire +1 (jamais l’expéditeur)', async () => {
  await seedProfile('msgAlice1', 'user');
  await seedProfile('msgBob1', 'user');
  const convId = await seedConversation('msgAlice1', 'msgBob1');

  await seedMessage(convId, 'msgAlice1', 'Bonjour Bob !');

  await waitFor(async () => {
    const snap = await db.doc('users/msgBob1').get();
    return snap.data()?.messageCount === 1;
  });
  const senderSnap = await db.doc('users/msgAlice1').get();
  if (senderSnap.data()?.messageCount !== 0) {
    throw new Error(`L'expéditeur ne devrait jamais recevoir de +1 : ${senderSnap.data()?.messageCount}`);
  }

  const conv = await db.doc(`conversations/${convId}`).get();
  if (conv.data()?.lastMessagePreview !== 'Bonjour Bob !' || conv.data()?.lastSenderId !== 'msgAlice1') {
    throw new Error(`Conversation non actualisée : ${JSON.stringify(conv.data())}`);
  }
  if (typeof conv.data()?.lastMessageAt?.toDate !== 'function') {
    throw new Error('lastMessageAt devrait être un serveur timestamp.');
  }

  const docs = await waitFor(async () => {
    const snap = await db.collection('notifications')
      .where('recipientId', '==', 'msgBob1')
      .where('type', '==', 'message')
      .get();
    const found = snap.docs.filter((d) => d.data().actorId === 'msgAlice1');
    return found.length > 0 ? found : null;
  });
  const n = docs[0].data();
  if (n.read !== false || n.readAt !== null || n.postId !== '' || n.commentId !== '') {
    throw new Error(`Notification message incohérente : ${JSON.stringify(n)}`);
  }
});

test('MSG2 onMessageCreated : preview normalisée (retours/espaces écrases) puis tronquée à 80', async () => {
  await seedProfile('msgAlice2', 'user');
  await seedProfile('msgBob2', 'user');
  const convId = await seedConversation('msgAlice2', 'msgBob2');

  const raw = `  Première ligne   \n  deuxième\tligne   ${'x'.repeat(100)}`;
  const expected = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
  await seedMessage(convId, 'msgAlice2', raw);

  await waitFor(async () => {
    const conv = await db.doc(`conversations/${convId}`).get();
    return conv.data()?.lastMessagePreview === expected;
  });
});

test('MSG3 onMessageUpdated : marquage lu → messageCount -1', async () => {
  await seedProfile('msgAlice3', 'user');
  await seedProfile('msgBob3', 'user');
  const convId = await seedConversation('msgAlice3', 'msgBob3');

  const msgRef = await seedMessage(convId, 'msgAlice3', 'Coucou Bob');
  await waitFor(async () => {
    const snap = await db.doc('users/msgBob3').get();
    return snap.data()?.messageCount === 1;
  });

  await msgRef.update({ read: true, readAt: T.createdAt });
  await waitFor(async () => {
    const snap = await db.doc('users/msgBob3').get();
    return snap.data()?.messageCount === 0;
  });
});

test('MSG4 onMessageUpdated : idempotent (re-marquage sans décrément) et jamais négatif', async () => {
  await seedProfile('msgAlice4', 'user');
  await seedProfile('msgBob4', 'user');
  const convId = await seedConversation('msgAlice4', 'msgBob4');

  const msgRef = await seedMessage(convId, 'msgAlice4', 'Encore un message');
  await waitFor(async () => {
    const snap = await db.doc('users/msgBob4').get();
    return snap.data()?.messageCount === 1;
  });

  await msgRef.update({ read: true, readAt: T.createdAt });
  await waitFor(async () => {
    const snap = await db.doc('users/msgBob4').get();
    return snap.data()?.messageCount === 0;
  });

  // Idempotence : re-marquage d'un message déjà lu → aucun second décrément.
  await msgRef.update({ read: true, readAt: new Date('2026-02-01T00:00:00Z') });
  await sleep(1500);
  let snap = await db.doc('users/msgBob4').get();
  if (snap.data()?.messageCount !== 0) {
    throw new Error(`messageCount devrait rester 0 après re-marquage : ${snap.data()?.messageCount}`);
  }

  // Borne >= 0 : compteur remis artificiellement à 0 puis passage
  // non lu -> lu → aucun décrément négatif.
  await db.doc('users/msgBob4').update({ messageCount: 0 });
  await msgRef.update({ read: false, readAt: null });
  await msgRef.update({ read: true, readAt: T.createdAt });
  await sleep(1500);
  snap = await db.doc('users/msgBob4').get();
  const count = snap.data()?.messageCount;
  if (typeof count !== 'number' || count < 0) {
    throw new Error(`messageCount ne devrait jamais être négatif : ${count}`);
  }
});

test('MSG5 onMessageCreated : conversation mal formée → aucun effet (défensif)', async () => {
  await seedProfile('msgAlone', 'user');
  // participants identiques : resolveMessageRecipient renvoie null.
  const convId = await seedConversation('msgAlone', 'msgAlone');

  await seedMessage(convId, 'msgAlone', 'Message perdu');

  await sleep(1500);
  const conv = await db.doc(`conversations/${convId}`).get();
  if (conv.data()?.lastMessageAt !== null || conv.data()?.lastMessagePreview !== '') {
    throw new Error(`La conversation mal formée ne devrait pas être actualisée : ${JSON.stringify(conv.data())}`);
  }
  const notifs = await db.collection('notifications')
    .where('recipientId', '==', 'msgAlone')
    .where('type', '==', 'message')
    .get();
  if (!notifs.empty) {
    throw new Error('Aucune notification ne devrait être créée pour une conversation invalide.');
  }
});

// ------------------------------------------------------------
// Phase 9 - Lot 4 : Recours (callable reviewAppeal) — bloc AP
// ------------------------------------------------------------
test('AP1  reviewAppeal (modérateur) : accepte un recours post → restauration + notification', async () => {
  const modUid = await createAuthUser('apmod1@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp1', 'user');

  const postRef = await seedPost('apApp1', { moderationStatus: 'hidden' });
  const postId = postRef.id;
  const appealId = await seedAppeal('apApp1', 'post', postId, 'hidden');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  const res = await callWithRetry(reviewAppeal, { appealId, decision: 'accepted' });
  if (res.data.ok !== true || res.data.decision !== 'accepted') {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }

  const post = (await postRef.get()).data();
  if (post.moderationStatus !== 'visible') {
    throw new Error(`Le post devrait être restauré (visible) : ${post.moderationStatus}`);
  }
  if (post.moderatorId !== modUid) {
    throw new Error('moderatorId devrait être celui du modérateur qui accepte le recours.');
  }

  const appeal = (await db.doc(`appeals/${appealId}`).get()).data();
  if (appeal.status !== 'accepted' || appeal.reviewedBy !== modUid || !appeal.reviewedAt) {
    throw new Error(`Clôture du recours incohérente : ${JSON.stringify(appeal)}`);
  }

  await waitFor(async () => {
    const snap = await db.collection('notifications').where('recipientId', '==', 'apApp1').where('type', '==', 'appeal').get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('AP2  reviewAppeal (admin) : accepte un recours commentaire → restauration + trace', async () => {
  const adminUid = await createAuthUser('apadmin2@parole.test');
  await seedProfile(adminUid, 'admin');
  await seedProfile('apApp2', 'user');

  const postRef = await seedPost('apApp2');
  const postId = postRef.id;
  const commentRef = await seedComment(postId, 'apApp2', 'Commentaire masqué', { moderationStatus: 'hidden' });
  const commentId = commentRef.id;
  const appealId = await seedAppeal('apApp2', 'comment', commentId, 'hidden');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  const res = await callWithRetry(reviewAppeal, { appealId, decision: 'accepted' });
  if (res.data.ok !== true || res.data.decision !== 'accepted') {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }

  const comment = (await commentRef.get()).data();
  if (comment.moderationStatus !== 'visible') {
    throw new Error(`Le commentaire devrait être restauré (visible) : ${comment.moderationStatus}`);
  }
  if (comment.moderatorId !== adminUid || !comment.moderatedAt || !comment.updatedAt) {
    throw new Error(`Trace de modération commentaire incohérente : ${JSON.stringify(comment)}`);
  }

  await waitFor(async () => {
    const snap = await db.collection('auditLogs').where('targetId', '==', commentId).where('action', '==', 'appeal.accepted').get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('AP3  reviewAppeal (utilisateur simple) : REFUS', async () => {
  const userUid = await createAuthUser('apuser3@parole.test');
  await seedProfile(userUid, 'user');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await expectCallableError(reviewAppeal({ appealId: 'any', decision: 'accepted' }), 'permission-denied');

  await signOut(auth);
});

test('AP4  reviewAppeal (non authentifié) : REFUS', async () => {
  await createAuthUser('apuser4@parole.test'); // session puis déconnexion
  await signOut(auth);

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await expectCallableError(reviewAppeal({ appealId: 'any', decision: 'accepted' }), 'unauthenticated');
});

test('AP5  reviewAppeal : appealId manquant REFUS', async () => {
  const modUid = await createAuthUser('apmod5@parole.test');
  await seedProfile(modUid, 'moderator');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await expectCallableError(reviewAppeal({ appealId: '', decision: 'accepted' }), 'invalid-argument');

  await signOut(auth);
});

test('AP6  reviewAppeal : decision invalide REFUS', async () => {
  const modUid = await createAuthUser('apmod6@parole.test');
  await seedProfile(modUid, 'moderator');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await expectCallableError(reviewAppeal({ appealId: 'x_post_y', decision: 'maybe' }), 'invalid-argument');

  await signOut(auth);
});

test('AP7  reviewAppeal : recours inexistant → not-found', async () => {
  const modUid = await createAuthUser('apmod7@parole.test');
  await seedProfile(modUid, 'moderator');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await expectCallableError(reviewAppeal({ appealId: 'ghost_post_ghost', decision: 'accepted' }), 'not-found');

  await signOut(auth);
});

test('AP8  reviewAppeal : recours déjà accepté → failed-precondition (aucune double résolution)', async () => {
  const modUid = await createAuthUser('apmod8@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp8', 'user');

  const postRef = await seedPost('apApp8', { moderationStatus: 'hidden' });
  const postId = postRef.id;
  const appealId = await seedAppeal('apApp8', 'post', postId, 'hidden');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await callWithRetry(reviewAppeal, { appealId, decision: 'accepted' });
  await expectCallableError(reviewAppeal({ appealId, decision: 'accepted' }), 'failed-precondition');
  await expectCallableError(reviewAppeal({ appealId, decision: 'rejected' }), 'failed-precondition');

  await signOut(auth);
});

test('AP9  reviewAppeal : rejet, puis nouvelle décision → failed-precondition', async () => {
  const modUid = await createAuthUser('apmod9@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp9', 'user');

  const postRef = await seedPost('apApp9', { moderationStatus: 'hidden' });
  const postId = postRef.id;
  const appealId = await seedAppeal('apApp9', 'post', postId, 'hidden');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  const res = await callWithRetry(reviewAppeal, { appealId, decision: 'rejected' });
  if (res.data.ok !== true || res.data.decision !== 'rejected') {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }
  await expectCallableError(reviewAppeal({ appealId, decision: 'accepted' }), 'failed-precondition');

  await signOut(auth);
});

test('AP10 reviewAppeal : cible disparue à l’acceptation → not-found, recours toujours pending', async () => {
  const modUid = await createAuthUser('apmod10@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp10', 'user');

  const postRef = await seedPost('apApp10', { moderationStatus: 'hidden' });
  const postId = postRef.id;
  const appealId = await seedAppeal('apApp10', 'post', postId, 'hidden');

  await postRef.delete();

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await expectCallableError(reviewAppeal({ appealId, decision: 'accepted' }), 'not-found');

  const appeal = (await db.doc(`appeals/${appealId}`).get()).data();
  if (appeal.status !== 'pending' || appeal.reviewedBy !== undefined) {
    throw new Error(`Le recours devrait rester pending : ${JSON.stringify(appeal)}`);
  }
  const audit = await db.collection('auditLogs').where('targetId', '==', postId).get();
  if (!audit.empty) {
    throw new Error('Aucun audit ne devrait exister si la décision est annulée.');
  }

  await signOut(auth);
});

test('AP11 reviewAppeal : rejet → aucune restauration de la cible', async () => {
  const modUid = await createAuthUser('apmod11@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp11', 'user');

  const postRef = await seedPost('apApp11', { moderationStatus: 'hidden' });
  const postId = postRef.id;
  const appealId = await seedAppeal('apApp11', 'post', postId, 'hidden');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await callWithRetry(reviewAppeal, { appealId, decision: 'rejected' });

  const post = (await postRef.get()).data();
  if (post.moderationStatus !== 'hidden') {
    throw new Error(`La cible ne devrait PAS être restaurée sur rejet : ${post.moderationStatus}`);
  }
  const appeal = (await db.doc(`appeals/${appealId}`).get()).data();
  if (appeal.status !== 'rejected' || appeal.reviewedBy !== modUid) {
    throw new Error(`Clôture du recours incohérente : ${JSON.stringify(appeal)}`);
  }

  await waitFor(async () => {
    const snap = await db.collection('auditLogs').where('targetId', '==', postId).where('action', '==', 'appeal.rejected').get();
    return snap.size > 0;
  });
  await waitFor(async () => {
    const snap = await db.collection('notifications').where('recipientId', '==', 'apApp11').where('type', '==', 'appeal').get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('AP12 reviewAppeal : accepte un recours de compte averti → dé-sanction warn', async () => {
  const modUid = await createAuthUser('apmod12@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp12', 'user');
  await db.doc('users/apApp12').update({ moderationStatus: 'warned' });

  const appealId = await seedAppeal('apApp12', 'user', 'apApp12', 'warned');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  const res = await callWithRetry(reviewAppeal, { appealId, decision: 'accepted' });
  if (res.data.ok !== true) {
    throw new Error(`Réponse inattendue : ${JSON.stringify(res.data)}`);
  }

  const target = (await db.doc('users/apApp12').get()).data();
  if (target.banned !== false || target.moderationStatus !== 'none' || target.bannedUntil !== null) {
    throw new Error(`Compte non dé-sanctionné : ${JSON.stringify({ banned: target.banned, moderationStatus: target.moderationStatus, bannedUntil: target.bannedUntil })}`);
  }

  await signOut(auth);
});

test('AP13 reviewAppeal : accepte un recours de compte banni/suspendu → unban', async () => {
  const modUid = await createAuthUser('apmod13@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp13', 'user');
  await db.doc('users/apApp13').update({ banned: true, bannedUntil: new Date('2030-01-01T00:00:00Z'), moderationStatus: 'suspended' });

  const appealId = await seedAppeal('apApp13', 'user', 'apApp13', 'suspended');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await callWithRetry(reviewAppeal, { appealId, decision: 'accepted' });

  const target = (await db.doc('users/apApp13').get()).data();
  if (target.banned !== false || target.bannedUntil !== null || target.moderationStatus !== 'none') {
    throw new Error(`Compte non débanni : ${JSON.stringify({ banned: target.banned, bannedUntil: target.bannedUntil, moderationStatus: target.moderationStatus })}`);
  }

  await waitFor(async () => {
    const snap = await db.collection('auditLogs').where('targetId', '==', 'apApp13').where('action', '==', 'appeal.accepted').get();
    return snap.size > 0;
  });

  await signOut(auth);
});

test('AP14 reviewAppeal : auditLogs détaillés pour accepted', async () => {
  const modUid = await createAuthUser('apmod14@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp14', 'user');

  const postRef = await seedPost('apApp14', { moderationStatus: 'removed' });
  const postId = postRef.id;
  const appealId = await seedAppeal('apApp14', 'post', postId, 'removed', 'Je conteste le retrait.');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await callWithRetry(reviewAppeal, { appealId, decision: 'accepted' });

  const audit = await waitFor(async () => {
    const snap = await db.collection('auditLogs').where('targetId', '==', postId).where('action', '==', 'appeal.accepted').get();
    return snap.size > 0 ? snap.docs : null;
  });
  const entry = audit[0].data();
  if (entry.actorId !== modUid || entry.actorRole !== 'moderator') {
    throw new Error(`Acteur de l’audit incohérent : ${JSON.stringify(entry)}`);
  }
  if (entry.targetType !== 'post' || entry.targetId !== postId) {
    throw new Error(`Cible de l’audit incohérente : ${JSON.stringify(entry)}`);
  }
  if (entry.details?.appealId !== appealId || entry.details?.decision !== 'accepted' || entry.details?.appellantId !== 'apApp14' || entry.details?.sanctionType !== 'removed') {
    throw new Error(`Détails de l’audit incohérents : ${JSON.stringify(entry.details)}`);
  }

  await signOut(auth);
});

test('AP15 reviewAppeal : jamais de notification pour soi-même (modérateur révisant son propre recours)', async () => {
  const modUid = await createAuthUser('apmod15@parole.test');
  await seedProfile(modUid, 'moderator');
  await db.doc(`users/${modUid}`).update({ moderationStatus: 'warned' });

  const appealId = await seedAppeal(modUid, 'user', modUid, 'warned');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await callWithRetry(reviewAppeal, { appealId, decision: 'accepted' });

  await sleep(1200);
  const snap = await db.collection('notifications').where('recipientId', '==', modUid).where('type', '==', 'appeal').get();
  if (snap.size > 0) {
    throw new Error('Aucune notification ne devrait exister pour une décision sur son propre recours.');
  }

  await signOut(auth);
});

test('AP16 reviewAppeal : paramètres malformés REFUS', async () => {
  const modUid = await createAuthUser('apmod16@parole.test');
  await seedProfile(modUid, 'moderator');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await expectCallableError(reviewAppeal({ appealId: 42, decision: 'accepted' }), 'invalid-argument');
  await expectCallableError(reviewAppeal({ decision: 'accepted' }), 'invalid-argument');
  await expectCallableError(reviewAppeal({ appealId: 'ok_id' }), 'invalid-argument');

  await signOut(auth);
});

test('AP17 reviewAppeal : idempotence et atomicité complètes', async () => {
  const modUid = await createAuthUser('apmod17@parole.test');
  await seedProfile(modUid, 'moderator');
  await seedProfile('apApp17', 'user');

  const postRef = await seedPost('apApp17', { moderationStatus: 'hidden' });
  const postId = postRef.id;
  const appealId = await seedAppeal('apApp17', 'post', postId, 'hidden');

  const reviewAppeal = httpsCallable(functions, 'reviewAppeal');
  await callWithRetry(reviewAppeal, { appealId, decision: 'accepted' });
  await expectCallableError(reviewAppeal({ appealId, decision: 'accepted' }), 'failed-precondition');

  const appeal = (await db.doc(`appeals/${appealId}`).get()).data();
  if (appeal.status !== 'accepted' || appeal.reviewedBy !== modUid || !appeal.reviewedAt) {
    throw new Error(`Recours incohérent : ${JSON.stringify(appeal)}`);
  }
  if (!appeal.appealId || appeal.appellantId !== 'apApp17' || appeal.targetType !== 'post' || appeal.reason !== 'Je conteste cette sanction.') {
    throw new Error(`Méta-données du recours altérées : ${JSON.stringify(appeal)}`);
  }

  const post = (await postRef.get()).data();
  if (post.moderationStatus !== 'visible' || post.moderatorId !== modUid) {
    throw new Error(`Restauration du post incohérente : ${JSON.stringify(post)}`);
  }

  await waitFor(async () => {
    const snap = await db.doc('users/apApp17').get();
    return snap.data()?.notificationCount === 1;
  });

  const notifs = await db.collection('notifications').where('recipientId', '==', 'apApp17').where('type', '==', 'appeal').get();
  if (notifs.size !== 1) {
    throw new Error(`Attendu exactement UNE notification de recours, obtenu ${notifs.size}`);
  }

  await signOut(auth);
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