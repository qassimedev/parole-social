// ============================================================
// PAROLE - Suite de tests de sécurité (Phase 1 + Phase 3 + Phase 4)
// Exécution : npm run test:rules
//   -> firebase emulators:exec --only firestore,storage "node scripts/test-rules.mjs"
//
// Couvre : utilisateur non authentifié, utilisateur authentifié,
// propriétaire, autre utilisateur, modérateur, administrateur,
// manipulations de role/banned/reportCount/likeCount/commentCount/
// status de modération/auditLogs, et les scénarios explicites de
// la Phase 1 (aucune suppression automatique par signalement).
// Phase 3 : bloc G (likes) — déduplication par identifiant
// déterministe, visibilité du post cible, immuabilité, like/retrait
// par le propriétaire, requête « mes likes ».
// Phase 4 : bloc H (follows) — déduplication par identifiant
// déterministe, self-follow interdit, cible requise et non bannie,
// immuabilité, visibilité limitée, compteurs jamais modifiables par
// un client, requêtes « mes suivis » / « mes abonnés ».
// ============================================================

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { setDoc, doc, getDoc, updateDoc, deleteDoc, getDocs, query, where, collection } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

const projectId = 'parole-social';
const RULES_DIR = new URL('..', import.meta.url);

const testEnv = await initializeTestEnvironment({
  projectId,
  firestore: { rules: readFileSync(new URL('firestore.rules', RULES_DIR), 'utf8') },
  storage: { rules: readFileSync(new URL('storage.rules', RULES_DIR), 'utf8') },
});

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

// ------------------------------------------------------------
// Harness
// ------------------------------------------------------------
async function expectDenied(promise) {
  try {
    await promise;
    throw new Error('Attendu un refus (permission-denied), mais l’opération a réussi.');
  } catch (err) {
    const code = err?.code ?? '';
    if (code !== 'permission-denied' && code !== 'storage/unauthorized') {
      throw new Error(`Attendu permission-denied, obtenu ${code || err?.message}`);
    }
  }
}

async function expectAllowed(promise) {
  try {
    await promise;
  } catch (err) {
    throw new Error(`Attendu succès, mais refusé : ${err?.code ?? err?.message}`);
  }
}

// ------------------------------------------------------------
// Données de base
// ------------------------------------------------------------
const T = { createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z') };

function user(uid, role = 'user', extra = {}) {
  return {
    uid,
    displayName: uid,
    bio: '',
    avatarPath: '',
    createdAt: T.createdAt,
    updatedAt: T.updatedAt,
    role,
    banned: false,
    moderationStatus: 'none',
    postCount: 0,
    reportCount: 0,
    likeCount: 0,
    followerCount: 0,
    followingCount: 0,
    ...extra,
  };
}

function post(authorId, authorName, visibility, moderationStatus = 'visible', extra = {}) {
  return {
    authorId,
    authorName,
    content: 'Contenu du post',
    type: 'text',
    visibility,
    mediaPaths: [],
    createdAt: T.createdAt,
    updatedAt: T.updatedAt,
    likeCount: 0,
    commentCount: 0,
    reportCount: 0,
    shareCount: 0,
    moderationStatus,
    ...extra,
  };
}

function report(reporterId, targetType, targetId, reason = 'harassment', status = 'pending') {
  const reportId = `${reporterId}_${targetType}_${targetId}`;
  return { reporterId, reportId, targetType, targetId, reason, details: '', status, createdAt: T.createdAt };
}

function like(userId, postId, extra = {}) {
  return { userId, postId, createdAt: T.createdAt, updatedAt: T.createdAt, ...extra };
}

function follow(followerId, followingId, extra = {}) {
  return { followerId, followingId, createdAt: T.createdAt, updatedAt: T.createdAt, ...extra };
}

const SEED_USERS = ['alice', 'bob', 'eve', 'charlie', 'dave', 'mod', 'admin'];
const SEED_POSTS = {
  post1: post('alice', 'Alice', 'public'),
  post2: post('alice', 'Alice', 'followers'),
  post3: post('alice', 'Alice', 'private'),
  post4: post('bob', 'Bob', 'public', 'hidden'),
  post5: post('bob', 'Bob', 'public'),
  post6: post('eve', 'Eve', 'public'),
};

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const uid of SEED_USERS) {
      const role = uid === 'mod' ? 'moderator' : uid === 'admin' ? 'admin' : 'user';
      await setDoc(doc(db, 'users', uid), user(uid, role));
    }
    for (const [postId, data] of Object.entries(SEED_POSTS)) {
      await setDoc(doc(db, 'posts', postId), data);
    }
    await setDoc(doc(db, 'reports', 'eve_post_post1'), report('eve', 'post', 'post1'));
    await setDoc(doc(db, 'moderationQueue', 'queue1'), {
      targetType: 'post',
      targetId: 'post4',
      status: 'pending',
      reportCount: 2,
      createdAt: T.createdAt,
      updatedAt: T.createdAt,
    });
    await setDoc(doc(db, 'auditLogs', 'log1'), {
      actorId: 'admin',
      actorRole: 'admin',
      action: 'user.ban',
      targetType: 'user',
      targetId: 'nobody',
      details: { reason: 'test' },
      createdAt: T.createdAt,
    });
    await setDoc(doc(db, 'notifications', 'n_eve'), {
      recipientId: 'eve',
      type: 'system',
      read: false,
      createdAt: T.createdAt,
    });
    await setDoc(doc(db, 'notifications', 'n_bob'), {
      recipientId: 'bob',
      type: 'system',
      read: false,
      createdAt: T.createdAt,
    });

    // Fichiers Storage de base.
    const storage = ctx.storage();
    const upload = (path, type, size) =>
      uploadBytes(ref(storage, path), new Blob([Buffer.alloc(size, 1)], { type }));
    await upload('media/bob/avatars/profile.png', 'image/png', 1024);
    await upload('media/alice/posts/post1/photo.png', 'image/png', 2048);
    await upload('media/bob/posts/post4/photo.png', 'image/png', 2048);
  });
}

// Contextes authentifiés
const alice = () => testEnv.authenticatedContext('alice');
const bob = () => testEnv.authenticatedContext('bob');
const eve = () => testEnv.authenticatedContext('eve');
const charlie = () => testEnv.authenticatedContext('charlie');
const dave = () => testEnv.authenticatedContext('dave');
const zoe = () => testEnv.authenticatedContext('zoe'); // profil non créé
const mod = () => testEnv.authenticatedContext('mod');
const admin = () => testEnv.authenticatedContext('admin');
const anon = () => testEnv.unauthenticatedContext();

// ============================================================
// A. Utilisateur non authentifié
// ============================================================
test('A1  Non-auth : lecture users refusée', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'users', 'alice')));
});
test('A2  Non-auth : lecture posts refusée', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'posts', 'post1')));
});
test('A3  Non-auth : création de post refusée', async () => {
  await expectDenied(setDoc(doc(anon().firestore(), 'posts', 'anonpost'), post('anon', 'anon', 'public')));
});
test('A4  Non-auth : lecture reports refusée', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'reports', 'eve_post_post1')));
});
test('A5  Non-auth : lecture auditLogs refusée', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'auditLogs', 'log1')));
});
test('A6  Non-auth : création de signalement refusée', async () => {
  await expectDenied(setDoc(doc(anon().firestore(), 'reports', 'anon_post_post1'), report('anon', 'post', 'post1')));
});
test('A7  Non-auth : lecture moderationQueue refusée', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'moderationQueue', 'queue1')));
});
test('A8  Non-auth : lecture Storage refusée', async () => {
  await expectDenied(getBytes(ref(anon().storage(), 'media/bob/avatars/profile.png')));
});
test('A9  Non-auth : upload Storage refusé', async () => {
  await expectDenied(uploadBytes(ref(anon().storage(), 'media/anon/avatars/a.png'), new Blob([Buffer.alloc(10)], { type: 'image/png' })));
});

// ============================================================
// B. Utilisateur authentifié
// ============================================================
test('B1  Création de son propre profil OK', async () => {
  await expectAllowed(setDoc(doc(zoe().firestore(), 'users', 'zoe'), user('zoe')));
});
test('B2  Création de profil avec role admin REFUS', async () => {
  await expectDenied(setDoc(doc(zoe().firestore(), 'users', 'zoe2'), user('zoe2', 'admin')));
});
test('B3  Création de profil banni REFUS', async () => {
  await expectDenied(setDoc(doc(zoe().firestore(), 'users', 'zoe3'), user('zoe3', 'user', { banned: true })));
});
test('B4  Création du profil d’un autre utilisateur REFUS', async () => {
  await expectDenied(setDoc(doc(zoe().firestore(), 'users', 'bob'), user('bob')));
});
test('B5  Lecture de son propre profil OK', async () => {
  await expectAllowed(getDoc(doc(eve().firestore(), 'users', 'eve')));
});
test('B6  Mise à jour de son displayName OK', async () => {
  await expectAllowed(updateDoc(doc(eve().firestore(), 'users', 'eve'), { displayName: 'Eve2', updatedAt: new Date() }));
});
test('B7  Modification de son propre role REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { role: 'admin' }));
});
test('B8  Modification de banned REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { banned: true }));
});
test('B9  Modification de moderationStatus REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { moderationStatus: 'suspended' }));
});
test('B10 Modification de postCount REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { postCount: 999 }));
});
test('B11 Modification du profil d’un autre utilisateur REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'bob'), { displayName: 'Hacked' }));
});
test('B12 Création de son propre post OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'posts', 'evetest1'), post('eve', 'Eve', 'public')));
});
test('B13 Création de post avec authorId tiers REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'evetest2'), post('bob', 'Bob', 'public')));
});
test('B14 Création de post avec moderationStatus masqué REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'evetest3'), post('eve', 'Eve', 'public', 'hidden')));
});
test('B15 Création de post avec likeCount prérempli REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'evetest4'), post('eve', 'Eve', 'public', 'visible', { likeCount: 10 })));
});
test('B16 Lecture d’un post public OK', async () => {
  await expectAllowed(getDoc(doc(eve().firestore(), 'posts', 'post1')));
});
test('B17 Lecture d’un post masqué REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'posts', 'post4')));
});
test('B18 Lecture d’un post followers (non suiveur) REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'posts', 'post2')));
});
test('B19 Lecture d’un post privé (autre utilisateur) REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'posts', 'post3')));
});
test('B20 L’auteur lit son propre post privé OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'posts', 'post3')));
});
test('B21 L’auteur modifie le contenu de son post OK', async () => {
  await expectAllowed(updateDoc(doc(eve().firestore(), 'posts', 'evetest1'), { content: 'Modifié', updatedAt: new Date() }));
});
test('B22 L’auteur modifie likeCount de son post REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'posts', 'evetest1'), { likeCount: 5 }));
});
test('B23 L’auteur modifie commentCount de son post REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'posts', 'evetest1'), { commentCount: 5 }));
});
test('B24 L’auteur modifie reportCount de son post REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'posts', 'evetest1'), { reportCount: 50 }));
});
test('B25 L’auteur modifie moderationStatus de son post REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'posts', 'evetest1'), { moderationStatus: 'hidden' }));
});
test('B26 L’auteur supprime son propre post OK', async () => {
  await expectAllowed(deleteDoc(doc(eve().firestore(), 'posts', 'evetest1')));
});
test('B27 Mise à jour du post d’un autre utilisateur REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'posts', 'post5'), { content: 'piraté' }));
});
test('B28 Suppression du post d’un autre utilisateur REFUS', async () => {
  await expectDenied(deleteDoc(doc(eve().firestore(), 'posts', 'post5')));
});
test('B29 Commentaire sur un post public OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'comments', 'c1'), {
    postId: 'post1', authorId: 'eve', content: 'Un commentaire', replyToId: '',
    createdAt: T.createdAt, updatedAt: T.updatedAt, moderationStatus: 'visible', deletedAt: null,
  }));
});
test('B30 Commentaire sur un post masqué REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'comments', 'c2'), {
    postId: 'post4', authorId: 'eve', content: 'Spam', replyToId: '',
    createdAt: T.createdAt, updatedAt: T.updatedAt, moderationStatus: 'visible', deletedAt: null,
  }));
});
test('B31 L’auteur modifie son commentaire OK', async () => {
  await expectAllowed(updateDoc(doc(eve().firestore(), 'comments', 'c1'), { content: 'édité', updatedAt: new Date() }));
});
test('B32 L’auteur modifie le moderationStatus de son commentaire REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'comments', 'c1'), { moderationStatus: 'hidden' }));
});
test('B33 Modification du commentaire d’un autre REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'comments', 'c1'), { authorId: 'bob' }));
});
test('B34 Création d’un signalement OK (id dédupliqué)', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'reports', 'charlie_post_post1'), report('charlie', 'post', 'post1')));
});
test('B35 Signalement avec id de document incohérent REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'reports', 'wrong_id_post_post1'), report('eve', 'post', 'post1')));
});
test('B36 Signalement avec reporterId tiers REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'reports', 'eve_post_post2'), report('bob', 'post', 'post2')));
});
test('B37 Signalement avec status prérempli REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'reports', 'eve_post_post3'), report('eve', 'post', 'post3', 'spam', 'resolved')));
});
test('B38 Signalement avec raison invalide REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'reports', 'eve_post_post5'), report('eve', 'post', 'post5', 'je_n_aime_pas')));
});
test('B39 Signalement sur un post inexistant REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'reports', 'eve_post_ghost'), report('eve', 'post', 'ghost')));
});
test('B40 Signalement dupliqué (même cible) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'reports', 'eve_post_post1'), report('eve', 'post', 'post1')));
});
test('B41 Modification de son propre signalement REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'reports', 'eve_post_post1'), { reason: 'spam' }));
});
test('B42 L’auteur du signalement le lit OK', async () => {
  await expectAllowed(getDoc(doc(eve().firestore(), 'reports', 'eve_post_post1')));
});
test('B43 Un autre utilisateur lit le signalement d’autrui REFUS', async () => {
  await expectDenied(getDoc(doc(bob().firestore(), 'reports', 'eve_post_post1')));
});
test('B44 Écriture dans moderationQueue REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'moderationQueue', 'x'), { targetType: 'post' }));
});
test('B45 Écriture dans auditLogs REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'auditLogs', 'x'), { action: 'fake' }));
});
test('B46 Création d’une notification pour autrui REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'notifications', 'n_fake'), { recipientId: 'bob', type: 'system' }));
});
test('B47 Lecture de la notification d’un autre REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'notifications', 'n_bob')));
});
test('B48 Marquer sa propre notification comme lue OK', async () => {
  await expectAllowed(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve'), { read: true, readAt: new Date() }));
});
test('B49 Lecture de sa propre notification OK', async () => {
  await expectAllowed(getDoc(doc(eve().firestore(), 'notifications', 'n_eve')));
});
test('B50 Utilisateur banni ne peut pas créer de post', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'banned1'), user('banned1', 'user', { banned: true }));
  });
  const banned = () => testEnv.authenticatedContext('banned1');
  await expectDenied(setDoc(doc(banned().firestore(), 'posts', 'bp1'), post('banned1', 'B', 'public')));
  await expectDenied(setDoc(doc(banned().firestore(), 'reports', 'banned1_post_post1'), report('banned1', 'post', 'post1')));
});

// ============================================================
// C. Modérateur
// ============================================================
test('C1  Lecture de la file de modération OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'moderationQueue', 'queue1')));
});
test('C2  Écriture dans moderationQueue REFUS (via Cloud Functions uniquement)', async () => {
  await expectDenied(setDoc(doc(mod().firestore(), 'moderationQueue', 'queue2'), { targetType: 'post' }));
});
test('C3  Résolution directe d’un signalement REFUS', async () => {
  await expectDenied(updateDoc(doc(mod().firestore(), 'reports', 'eve_post_post1'), { status: 'dismissed' }));
});
test('C4  Lecture de tous les signalements OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'reports', 'eve_post_post1')));
});
test('C5  Lecture d’un post masqué OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'posts', 'post4')));
});
test('C6  Écriture dans auditLogs REFUS', async () => {
  await expectDenied(setDoc(doc(mod().firestore(), 'auditLogs', 'x'), { action: 'fake' }));
});
test('C7  Lecture des auditLogs REFUS (réservée admin)', async () => {
  await expectDenied(getDoc(doc(mod().firestore(), 'auditLogs', 'log1')));
});
test('C8  Un modérateur modifie le role d’un utilisateur REFUS', async () => {
  await expectDenied(updateDoc(doc(mod().firestore(), 'users', 'bob'), { role: 'moderator' }));
});
test('C9  Un modérateur bannit un utilisateur REFUS', async () => {
  await expectDenied(updateDoc(doc(mod().firestore(), 'users', 'bob'), { banned: true }));
});
test('C10 Un modérateur supprime le post d’autrui REFUS', async () => {
  await expectDenied(deleteDoc(doc(mod().firestore(), 'posts', 'post5')));
});
test('C11 Un modérateur masque un post directement REFUS (via Cloud Functions uniquement)', async () => {
  await expectDenied(updateDoc(doc(mod().firestore(), 'posts', 'post5'), { moderationStatus: 'hidden' }));
});

// ============================================================
// D. Administrateur
// ============================================================
test('D1  Lecture des auditLogs OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'auditLogs', 'log1')));
});
test('D2  Lecture de la file de modération OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'moderationQueue', 'queue1')));
});
test('D3  Lecture d’un post masqué OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'posts', 'post4')));
});
test('D4  Lecture de tous les signalements OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'reports', 'eve_post_post1')));
});
test('D5  Écriture dans auditLogs REFUS (append-only via Functions)', async () => {
  await expectDenied(setDoc(doc(admin().firestore(), 'auditLogs', 'x'), { action: 'fake' }));
});
test('D6  Écriture dans moderationQueue REFUS', async () => {
  await expectDenied(setDoc(doc(admin().firestore(), 'moderationQueue', 'x'), { targetType: 'post' }));
});
test('D7  Un admin modifie directement le role REFUS (via Cloud Functions uniquement)', async () => {
  await expectDenied(updateDoc(doc(admin().firestore(), 'users', 'bob'), { role: 'moderator' }));
});
test('D8  Un admin modifie directement moderationStatus d’un post REFUS', async () => {
  await expectDenied(updateDoc(doc(admin().firestore(), 'posts', 'post5'), { moderationStatus: 'hidden' }));
});

// ============================================================
// E. Scénarios explicites
// ============================================================
test('E1  SCÉNARIO : post + 1 signalement -> toujours visible', async () => {
  // Nouveau signalement sur post1 (déjà signalé par eve à la seed).
  await expectAllowed(setDoc(doc(dave().firestore(), 'reports', 'dave_post_post1'), report('dave', 'post', 'post1')));
  // Le post reste lisible par n’importe quel utilisateur authentifié.
  await expectAllowed(getDoc(doc(eve().firestore(), 'posts', 'post1')));
  // Le post n’a pas été modifié par le signalement.
  const snap = await getDoc(doc(eve().firestore(), 'posts', 'post1'));
  const data = snap.data();
  if (data.moderationStatus !== 'visible') {
    throw new Error('Le post devrait rester visible après un signalement.');
  }
});
test('E2  SCÉNARIO : post + nombreux signalements -> aucune suppression auto', async () => {
  for (const reporter of ['eve', 'charlie', 'dave', 'alice', 'bob']) {
    const ctx = testEnv.authenticatedContext(reporter);
    await expectAllowed(setDoc(doc(ctx.firestore(), 'reports', `${reporter}_post_post5`), report(reporter, 'post', 'post5')));
  }
  // Le post reste visible.
  await expectAllowed(getDoc(doc(eve().firestore(), 'posts', 'post5')));
});
test('E3  SCÉNARIO : malveillant tente de modifier une décision de modération -> REFUS', async () => {
  // bob tente de "rétablir" son post masqué (post4).
  await expectDenied(updateDoc(doc(bob().firestore(), 'posts', 'post4'), { moderationStatus: 'visible' }));
  // eve tente de modifier le statut d’un signalement.
  await expectDenied(updateDoc(doc(eve().firestore(), 'reports', 'eve_post_post1'), { status: 'dismissed' }));
});
test('E4  SCÉNARIO : malveillant tente de modifier son rôle -> REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { role: 'admin' }));
});

// ============================================================
// F. Storage
// ============================================================
const MB = 1024 * 1024;
const file = (type, size) => new Blob([Buffer.alloc(size, 1)], { type });

test('F1  Storage : lecture d’avatar par utilisateur authentifié OK', async () => {
  await expectAllowed(getBytes(ref(eve().storage(), 'media/bob/avatars/profile.png')));
});
test('F2  Storage : upload avatar OK', async () => {
  await expectAllowed(uploadBytes(ref(eve().storage(), 'media/eve/avatars/test.png'), file('image/png', 1024)));
});
test('F3  Storage : upload avatar avec type interdit REFUS', async () => {
  await expectDenied(uploadBytes(ref(eve().storage(), 'media/eve/avatars/bad.html'), file('text/html', 10)));
});
test('F4  Storage : upload avatar > 5 Mo REFUS', async () => {
  await expectDenied(uploadBytes(ref(eve().storage(), 'media/eve/avatars/big.png'), file('image/png', 6 * MB)));
});
test('F5  Storage : upload dans le chemin d’un autre utilisateur REFUS', async () => {
  await expectDenied(uploadBytes(ref(eve().storage(), 'media/bob/avatars/eve.png'), file('image/png', 10)));
});
test('F6  Storage : upload média image sur son post OK', async () => {
  await expectAllowed(uploadBytes(ref(eve().storage(), 'media/eve/posts/post6/img.png'), file('image/png', 2048)));
});
test('F7  Storage : upload média avec type interdit REFUS', async () => {
  await expectDenied(uploadBytes(ref(eve().storage(), 'media/eve/posts/post6/bad.html'), file('text/html', 10)));
});
test('F8  Storage : upload image > 5 Mo sur post REFUS', async () => {
  await expectDenied(uploadBytes(ref(eve().storage(), 'media/eve/posts/post6/big.png'), file('image/png', 6 * MB)));
});
test('F9  Storage : upload vidéo sur son post OK', async () => {
  await expectAllowed(uploadBytes(ref(eve().storage(), 'media/eve/posts/post6/vid.mp4'), file('video/mp4', 1 * MB)));
});
test('F10 Storage : upload média sur le post d’un autre REFUS', async () => {
  await expectDenied(uploadBytes(ref(eve().storage(), 'media/eve/posts/post1/img.png'), file('image/png', 10)));
});
test('F11 Storage : lecture du média d’un post public OK', async () => {
  await expectAllowed(getBytes(ref(eve().storage(), 'media/alice/posts/post1/photo.png')));
});
test('F12 Storage : lecture du média d’un post masqué REFUS', async () => {
  await expectDenied(getBytes(ref(eve().storage(), 'media/bob/posts/post4/photo.png')));
});
test('F13 Storage : suppression de son avatar OK', async () => {
  await expectAllowed(deleteObject(ref(eve().storage(), 'media/eve/avatars/test.png')));
});
test('F14 Storage : suppression de l’avatar d’un autre REFUS', async () => {
  await expectDenied(deleteObject(ref(eve().storage(), 'media/bob/avatars/profile.png')));
});

// ============================================================
// G. Likes
// Déduplication par ID déterministe `${userId}_${postId}`.
// Compteurs maintenus par les Cloud Functions (jamais par un client).
// ============================================================
test('G1  Non-auth : création de like REFUS', async () => {
  await expectDenied(setDoc(doc(anon().firestore(), 'likes', 'anon_post6'), like('anon', 'post6')));
});
test('G2  Non-auth : lecture d’un like REFUS', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'likes', 'eve_post5')));
});
test('G3  Like sur un post public OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'likes', 'eve_post5'), like('eve', 'post5')));
});
test('G4  Like sur un post masqué REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'likes', 'eve_post4'), like('eve', 'post4')));
});
test('G5  Like sur un post followers (non suiveur) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'likes', 'eve_post2'), like('eve', 'post2')));
});
test('G6  Like sur un post privé d’autrui REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'likes', 'eve_post3'), like('eve', 'post3')));
});
test('G7  Like avec un ID de document incohérent REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'likes', 'wrong_post5'), like('eve', 'post5')));
});
test('G8  Like avec userId tiers REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'likes', 'bob_post5'), like('bob', 'post5')));
});
test('G9  Like sur un post inexistant REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'likes', 'eve_ghost'), like('eve', 'ghost')));
});
test('G10 Like dupliqué (même cible) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'likes', 'eve_post5'), like('eve', 'post5')));
});
test('G11 Modification d’un like REFUS (immuable)', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'likes', 'eve_post5'), { updatedAt: new Date() }));
});
test('G12 Un like est lisible par les autres utilisateurs connectés OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'likes', 'eve_post5')));
});
test('G13 Requête « mes likes » (where userId) OK', async () => {
  const snap = await getDocs(
    query(collection(eve().firestore(), 'likes'), where('userId', '==', 'eve'))
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('eve_post5')) {
    throw new Error(`La requête « mes likes » devrait contenir eve_post5 : ${ids.join(', ')}`);
  }
});
test('G14 Like avec un champ supplémentaire REFUS (hasOnly)', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'likes', 'eve_post1'), like('eve', 'post1', { extra: true })));
});
test('G15 L’auteur peut aimer son propre post privé OK', async () => {
  await expectAllowed(setDoc(doc(alice().firestore(), 'likes', 'alice_post3'), like('alice', 'post3')));
});
test('G16 Suppression du like d’un autre REFUS', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'likes', 'charlie_post6'), like('charlie', 'post6')));
  await expectDenied(deleteDoc(doc(eve().firestore(), 'likes', 'charlie_post6')));
});
test('G17 L’auteur supprime son propre like OK', async () => {
  await expectAllowed(deleteDoc(doc(eve().firestore(), 'likes', 'eve_post5')));
});
test('G18 Utilisateur banni ne peut pas liker', async () => {
  const banned = () => testEnv.authenticatedContext('banned1');
  await expectDenied(setDoc(doc(banned().firestore(), 'likes', 'banned1_post1'), like('banned1', 'post1')));
});

// ============================================================
// H. Abonnements (follows)
// Déduplication par ID déterministe `${followerId}_${followingId}`.
// Compteurs users.followingCount / users.followerCount maintenus par
// les Cloud Functions (jamais par un client). Self-follow interdit,
// cible requise et non bannie, immuabilité, visibilité limitée.
// ============================================================
test('H1  Non-auth : lecture d’un follow REFUS', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'follows', 'charlie_alice')));
});
test('H2  Non-auth : création d’un follow REFUS', async () => {
  await expectDenied(setDoc(doc(anon().firestore(), 'follows', 'anon_alice'), follow('anon', 'alice')));
});
test('H3  Follow valide (charlie → alice) OK', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'follows', 'charlie_alice'), follow('charlie', 'alice')));
});
test('H4  Self-follow REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'follows', 'charlie_charlie'), follow('charlie', 'charlie')));
});
test('H5  Follow avec un ID de document incohérent REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'follows', 'wrong_alice'), follow('charlie', 'alice')));
});
test('H6  Follow avec followerId tiers REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'follows', 'charlie_alice'), follow('bob', 'alice')));
});
test('H7  Follow d’un utilisateur inexistant REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'follows', 'charlie_ghost'), follow('charlie', 'ghost')));
});
test('H8  Follow d’un utilisateur banni REFUS', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'bannedTarget'), user('bannedTarget', 'user', { banned: true }));
  });
  await expectDenied(setDoc(doc(charlie().firestore(), 'follows', 'charlie_bannedTarget'), follow('charlie', 'bannedTarget')));
});
test('H9  Follow dupliqué (même cible) REFUS', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'follows', 'charlie_mod'), follow('charlie', 'mod')));
  await expectDenied(setDoc(doc(charlie().firestore(), 'follows', 'charlie_mod'), follow('charlie', 'mod')));
});
test('H10 Modification d’un follow REFUS (immuable)', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'follows', 'charlie_dave'), follow('charlie', 'dave')));
  await expectDenied(updateDoc(doc(charlie().firestore(), 'follows', 'charlie_dave'), { updatedAt: new Date() }));
});
test('H11 Follow avec un champ supplémentaire REFUS (hasOnly)', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'follows', 'charlie_bob'), follow('charlie', 'bob', { extra: true })));
});
test('H12 Lecture d’un follow par le follower OK', async () => {
  await expectAllowed(getDoc(doc(charlie().firestore(), 'follows', 'charlie_alice')));
});
test('H13 Lecture d’un follow par l’utilisateur suivi OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'follows', 'charlie_alice')));
});
test('H14 Lecture d’un follow par un tiers REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'follows', 'charlie_alice')));
});
test('H15 Requête « mes suivis » (where followerId) OK', async () => {
  const snap = await getDocs(
    query(collection(charlie().firestore(), 'follows'), where('followerId', '==', 'charlie'))
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('charlie_alice')) {
    throw new Error(`« Mes suivis » devrait contenir charlie_alice : ${ids.join(', ')}`);
  }
});
test('H16 Requête « mes abonnés » (where followingId) OK', async () => {
  const snap = await getDocs(
    query(collection(alice().firestore(), 'follows'), where('followingId', '==', 'alice'))
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('charlie_alice')) {
    throw new Error(`« Mes abonnés » devrait contenir charlie_alice : ${ids.join(', ')}`);
  }
});
test('H17 L’auteur du follow le supprime OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'follows', 'eve_dave'), follow('eve', 'dave')));
  await expectAllowed(deleteDoc(doc(eve().firestore(), 'follows', 'eve_dave')));
});
test('H18 Suppression du follow d’un autre REFUS', async () => {
  await expectAllowed(setDoc(doc(bob().firestore(), 'follows', 'bob_alice'), follow('bob', 'alice')));
  await expectDenied(deleteDoc(doc(charlie().firestore(), 'follows', 'bob_alice')));
});
test('H19 Utilisateur banni ne peut pas suivre', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'bannedfollower'), user('bannedfollower', 'user', { banned: true }));
  });
  const banned = () => testEnv.authenticatedContext('bannedfollower');
  await expectDenied(setDoc(doc(banned().firestore(), 'follows', 'bannedfollower_alice'), follow('bannedfollower', 'alice')));
});
test('H20 Un client ne peut pas modifier users.followerCount REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { followerCount: 999 }));
});
test('H21 Un client ne peut pas modifier users.followingCount REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { followingCount: 999 }));
});
test('H22 Un modérateur lit un follow quel qu’il soit OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'follows', 'bob_alice')));
});

// ============================================================
// Exécution
// ============================================================
await seed();

let passed = 0;
const failed = [];

console.log('=== PAROLE - Tests de sécurité (Phase 1) ===\n');

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

await testEnv.cleanup();

if (failed.length > 0) {
  console.error(`\n${failed.length} test(s) échoué(s) :`);
  for (const f of failed) {
    console.error(`  - ${f.name} : ${f.message}`);
  }
  process.exit(1);
}
console.log('Tous les tests de règles sont passés.');