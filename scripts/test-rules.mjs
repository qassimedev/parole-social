// ============================================================
// PAROLE - Suite de tests de sécurité (Phase 1 + Phase 3 à Phase 6)
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
// Phase 5 : bloc I (notifications) — création/suppression réservées
// aux Cloud Functions, lecture destinataire/admin uniquement, champ
// users.notificationCount verrouillé, marquage non lue -> lue strict
// et idempotent, notification déjà lue immuable.
// Phase 6 : bloc J (partage/renvoi) — déduplication par identifiant
// déterministe, cible lisible, immuabilité, retrait réservé au shareur,
// requête « mes partages », compteur posts.shareCount jamais modifiable
// par un client, aucun compteur users.shareCount.
// Phase 7 : bloc K (fil d'abonnés) — lecture des posts visibility='followers'
// par un abonné OK, non-abonné refusé, auteur/modérateur/admin OK, et
// requête collection followers sans fuite de données.
// Phase 9 : bloc N (Hashtags, Lot 1) — champ posts.hashtags optionnel,
// tableau normalisé [0-9a-z_] {1,32} × ≤ 10 accepté, valeurs
// invalides/non normalisées/champs parasites refusés, update hashtags
// valide/invalide, requête page hashtag conforme et sans fuite.
// Phase 9 : bloc O (Blocage utilisateur, Lot 2) — collection
// blocks/{blockerId}_{blockedId}, schéma strict (3 champs),
// auto-blocage interdit, cible existante/non bannie requise,
// ID déterministe imposé, document immuable (update refusé),
// lecture blocker/modérateur/admin uniquement (jamais le bloqué, ni
// un tiers — pas d'énumération), suppression réservée au blocker,
// pas de document inverse automatique, requête « mes blocages »
// bornée sur blockerId.
// Phase 9 : bloc P (Messagerie privée, Lot 3) — collection
// conversations/{id déterministe trié} (participants string[2]
// distincts triés, ID canonique imposé, document immuable côté
// client, lecture participant non banni OU modérateur/admin, créa
// tion canAct + participant + hasOnly strict, pas d'énumération) et
// collection messages/{id} (création canAct + conversation existante
// + participation + AUCUN blocage dans aucune direction (effet
// bidirectionnel) + contenu 1..2000 + read/readAt/moderationStatus
// verrouillés + hasOnly strict ; lecture participant non banni OU
// modérateur/admin ; historique lisible même avec un blocage ; mise
// à jour UNIQUEMENT read false->true + readAt par le DESTINATAIRE
// non banni, déjà-lu immuable, modérateur sans passe-droit, aucune
// suppression ni édition ; messageCount verrouillé à la création du
// profil).
// Phase 9 : bloc Q (Recours, Lot 4) — collection appeals/{appealId} à
// ID DÉTERMINISTE `${appellantId}_${targetType}_${targetId}`. Création :
// canAct + appellantId == auth.uid + cible APPARTENANT à l'appelant +
// cible RÉELLEMENT sanctionnée + sanctionType cohérent (évalué par
// lecture de l'état réel via exist()/get()) + reason 1..2000 +
// status == 'pending' + createdAt timestamp + hasOnly strict. Lecture :
// appelant concerné OU modérateur/admin — requêtes bornées « mes recours »
// (appellantId) et « recours à traiter » (status == 'pending'), aucune
// énumération. UPDATE/DELETE toujours refusés (y compris modérateur/admin) :
// le document est immuable côté client, la résolution passe exclusivement
// par la Cloud Function `reviewAppeal`.
// ============================================================

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { setDoc, doc, getDoc, updateDoc, deleteDoc, getDocs, query, where, orderBy, collection } from 'firebase/firestore';
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
    notificationCount: 0,
    messageCount: 0,
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

function share(userId, postId, extra = {}) {
  return { userId, postId, createdAt: T.createdAt, updatedAt: T.createdAt, ...extra };
}

function follow(followerId, followingId, extra = {}) {
  return { followerId, followingId, createdAt: T.createdAt, updatedAt: T.createdAt, ...extra };
}

// Commentaire au schéma complet. `replyToId` est l'id du parent
// ('' pour un commentaire racine). `moderationStatus` :
// visible / hidden / removed.
function comment(postId, authorId, content, moderationStatus = 'visible', replyToId = '', extra = {}) {
  return {
    postId,
    authorId,
    content,
    replyToId,
    createdAt: T.createdAt,
    updatedAt: T.updatedAt,
    moderationStatus,
    deletedAt: null,
    ...extra,
  };
}

// Notification au schéma complet (Phase 5) : tous les champs
// présents, postId/commentId = '' quand non concernés, read=false et
// readAt=null à la création. Les règles imposent ce schéma strict.
function notification(recipientId, actorId, type, extra = {}) {
  return {
    recipientId,
    actorId,
    type,
    postId: '',
    commentId: '',
    read: false,
    readAt: null,
    createdAt: T.createdAt,
    ...extra,
  };
}

const SEED_USERS = ['alice', 'bob', 'eve', 'charlie', 'dave', 'mod', 'admin'];
const SEED_POSTS = {
  post1: post('alice', 'Alice', 'public'),
  post2: post('alice', 'Alice', 'followers'),
  post3: post('alice', 'Alice', 'private'),
  post4: post('bob', 'Bob', 'public', 'hidden'),
  post5: post('bob', 'Bob', 'public'),
  post6: post('eve', 'Eve', 'public'),
  // Hashtags (Phase 9 - Lot 1) : post public, post 'followers' et post
  // 'private' portant le tag 'parole'. postHtag2/postHtag3 ne doivent
  // JAMAIS remonter dans la requête publique de la page hashtag.
  postHtag1: post('bob', 'Bob', 'public', 'visible', { hashtags: ['parole', 'liberte'] }),
  postHtag2: post('alice', 'Alice', 'followers', 'visible', { hashtags: ['parole'] }),
  postHtag3: post('alice', 'Alice', 'private', 'visible', { hashtags: ['parole'] }),
};

function blockDoc(blockerId, blockedId) {
  return { blockerId, blockedId, createdAt: T.createdAt };
}

// Conversation au schéma complet (Phase 9 - Lot 3). `participants`
// sont TRIÉS (ID canonique = [a, b].sort().join('_')). À la
// création, derniers champs vides — actualisés uniquement par les
// Cloud Functions.
function conversationDoc(a, b, extra = {}) {
  return {
    participants: [a, b].sort(),
    createdAt: T.createdAt,
    lastMessageAt: null,
    lastMessagePreview: '',
    lastSenderId: '',
    ...extra,
  };
}

// Message au schéma complet (read=false, readAt=null,
// moderationStatus='visible' à la création).
function messageDoc(conversationId, senderId, content, extra = {}) {
  return {
    conversationId,
    senderId,
    content,
    read: false,
    readAt: null,
    moderationStatus: 'visible',
    createdAt: T.createdAt,
    ...extra,
  };
}

// Recours au schéma strict (Phase 9 - Lot 4). `appealId` est
// DÉTERMINISTE : `${appellantId}_${targetType}_${targetId}` — la règle
// impose ce format ET la correspondance avec l'id du document. Un seul
// champ mis en `extra` suffit à faire échouer le hasOnly.
function appealDoc(appellantId, targetType, targetId, sanctionType, reason = 'Je conteste cette sanction.', extra = {}) {
  const appealId = `${appellantId}_${targetType}_${targetId}`;
  return {
    appealId,
    appellantId,
    targetType,
    targetId,
    sanctionType,
    reason,
    status: 'pending',
    createdAt: T.createdAt,
    ...extra,
  };
}

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
    // Notifications (Phase 5) au schéma complet.
    await setDoc(doc(db, 'notifications', 'n_eve'), notification('eve', 'alice', 'comment', { postId: 'post1', commentId: 'c_eve' }));
    await setDoc(doc(db, 'notifications', 'n_bob'), notification('bob', 'alice', 'like', { postId: 'post1' }));
    await setDoc(doc(db, 'notifications', 'n_eve2'), notification('eve', 'alice', 'like', { postId: 'post1' }));
    await setDoc(doc(db, 'notifications', 'n_bob2'), notification('bob', 'alice', 'follow'));
    await setDoc(doc(db, 'notifications', 'n_eve3'), notification('eve', 'charlie', 'comment', { postId: 'post1', commentId: 'c_eve3' }));
    await setDoc(doc(db, 'notifications', 'n_eve4'), notification('eve', 'dave', 'follow'));
    await setDoc(doc(db, 'notifications', 'n_eve5'), notification('eve', 'bob', 'like', { postId: 'post5' }));
    await setDoc(doc(db, 'notifications', 'n_read'), notification('eve', 'alice', 'like', { postId: 'post1', read: true, readAt: T.createdAt }));
    // Notification de type 'reply' (dette P3 : notifications de réponse)
    await setDoc(doc(db, 'notifications', 'n_reply'), notification('alice', 'bob', 'reply', { postId: 'post5', commentId: 'c_reply' }));

    // Commentaires « visibilité des commentaires modérés » : documents
    // seedés par la modération (statuts visibles/masqués/retirés) sur le
    // post public post1 (auteur alice, non-modérateur). Les tests
    // vérifient qu'un utilisateur normal n'en lit que les `visible`.
    await setDoc(doc(db, 'comments', 's_vis'), comment('post1', 'eve', 'Commentaire visible'));
    await setDoc(doc(db, 'comments', 's_hidden'), comment('post1', 'eve', 'Commentaire masqué', 'hidden'));
    await setDoc(doc(db, 'comments', 's_removed'), comment('post1', 'eve', 'Commentaire retiré', 'removed'));
    await setDoc(doc(db, 'comments', 's_reply_hidden'), comment('post1', 'eve', 'Réponse à un commentaire masqué', 'hidden', 's_hidden'));

    // Fichiers Storage de base.
    const storage = ctx.storage();
    const upload = (path, type, size) =>
      uploadBytes(ref(storage, path), new Blob([Buffer.alloc(size, 1)], { type }));
    await upload('media/bob/avatars/profile.png', 'image/png', 1024);
    await upload('media/alice/posts/post1/photo.png', 'image/png', 2048);
    await upload('media/bob/posts/post4/photo.png', 'image/png', 2048);

    // Blocages (Phase 9 - Lot 2) : alice bloque bob. Le document
    // inverse bob_alice n'existe PAS et ne doit jamais être créé
    // automatiquement.
    await setDoc(doc(db, 'blocks', 'alice_bob'), blockDoc('alice', 'bob'));

    // Messagerie (Phase 9 - Lot 3) : utilisateur banni, conversations
    // et messages de base. La conversation alice_bob Lie une paire
    // où alice BLOQUE bob (créée ci-dessus) : l'envoi de messages y
    // est refusé dans les DEUX directions, mais l'historique reste
    // lisible par les participants non bannis.
    await setDoc(doc(db, 'users', 'bannedP'), user('bannedP', 'user', { banned: true }));
    await setDoc(doc(db, 'conversations', 'alice_bob'), conversationDoc('alice', 'bob', {
      lastMessageAt: T.createdAt,
      lastMessagePreview: 'Salut !',
      lastSenderId: 'bob',
    }));
    await setDoc(doc(db, 'conversations', 'alice_eve'), conversationDoc('alice', 'eve'));
    await setDoc(doc(db, 'conversations', 'alice_zoe'), conversationDoc('alice', 'zoe'));
    await setDoc(doc(db, 'conversations', 'alice_ghost'), conversationDoc('alice', 'ghostP'));
    await setDoc(doc(db, 'conversations', 'alice_bannedP'), conversationDoc('alice', 'bannedP'));
    await setDoc(doc(db, 'messages', 'm1'), messageDoc('alice_bob', 'alice', 'Bonjour', {
      read: true,
      readAt: T.createdAt,
    }));
    await setDoc(doc(db, 'messages', 'm2'), messageDoc('alice_bob', 'bob', 'Hello Alice'));
    await setDoc(doc(db, 'messages', 'm3'), messageDoc('alice_bob', 'alice', 'Deuxieme message'));
    await setDoc(doc(db, 'messages', 'm4'), messageDoc('alice_eve', 'eve', 'Salut quantique'));
    await setDoc(doc(db, 'messages', 'm_orphan'), messageDoc('no_conv', 'alice', 'Orphelin'));

    // Recours (Phase 9 - Lot 4) : cibles RÉELLEMENT sanctionnées
    // appartenant à dave (post/commentaire masqués ou retirés), une
    // cible dave non sanctionnée, un utilisateur Averti (non banni) et
    // un utilisateur BANNI + suspendu (ne peut PAS déposer un recours,
    // canAct).
    await setDoc(doc(db, 'posts', 'postQHidden'), post('dave', 'Dave', 'public', 'hidden'));
    await setDoc(doc(db, 'posts', 'postQRemoved'), post('dave', 'Dave', 'public', 'removed'));
    await setDoc(doc(db, 'posts', 'postQVisible'), post('dave', 'Dave', 'public', 'visible'));
    await setDoc(doc(db, 'comments', 'cQHidden'), comment('post1', 'dave', 'Commentaire masqué', 'hidden'));
    await setDoc(doc(db, 'comments', 'cQRemoved'), comment('post1', 'dave', 'Commentaire retiré', 'removed'));
    await setDoc(doc(db, 'users', 'warnedQ'), user('warnedQ', 'user', { moderationStatus: 'warned' }));
    await setDoc(doc(db, 'users', 'bannedQ'), user('bannedQ', 'user', { banned: true, moderationStatus: 'suspended' }));

    // Statistiques d'audience publiques (Phase 9 - Lot 6) :
    // documents SCHÉMA STRICT écrits par les Cloud Functions avec les
    // 5 compteurs (le postCount est EXCLU). creatorStats/alice servira
    // aux lectures valides ; les documents mal formés sont créés par la
    // règle en dur sur les seuls tests qui doivent vérifier le rejet.
    await setDoc(doc(db, 'creatorStats', 'alice'), {
      likeCount: 3,
      followerCount: 2,
      followingCount: 1,
      commentCount: 4,
      shareCount: 5,
    });
  });
}

// Contextes authentifiés
const alice = () => testEnv.authenticatedContext('alice');
const bob = () => testEnv.authenticatedContext('bob');
const eve = () => testEnv.authenticatedContext('eve');
const charlie = () => testEnv.authenticatedContext('charlie');
const dave = () => testEnv.authenticatedContext('dave');
const warnedQ = () => testEnv.authenticatedContext('warnedQ');
const bannedQ = () => testEnv.authenticatedContext('bannedQ');
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
// I. Notifications (Phase 5)
// Créées/supprimées EXCLUSIVEMENT par les Cloud Functions ; lecture
// réservée au destinataire (ou admin) ; le client ne peut que marquer
// une notification NON LUE comme lue (read + readAt timestamp), tous
// les autres champs étant épinglés par les règles. Une notification
// déjà lue est immuable, ce qui rend le décrément de
// users.notificationCount exactement unitaire (idempotent).
// ============================================================
test('I1  Le destinataire lit ses propres notifications OK', async () => {
  await expectAllowed(getDoc(doc(eve().firestore(), 'notifications', 'n_eve2')));
});
test('I2  Un admin lit les notifications OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'notifications', 'n_bob2')));
});
test('I3  Un utilisateur non connecté ne peut pas lire REFUS', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'notifications', 'n_eve2')));
});
test('I4  Lecture des notifications d’un autre utilisateur REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'notifications', 'n_bob2')));
});
test('I5  Création d’une notification par le client REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'notifications', 'n_eve_new'), notification('eve', 'bob', 'like')));
});
test('I6  Suppression d’une notification par le client REFUS', async () => {
  await expectDenied(deleteDoc(doc(eve().firestore(), 'notifications', 'n_eve2')));
});
test('I7  Modification de recipientId REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve3'), { recipientId: 'bob' }));
});
test('I8  Modification de actorId REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve3'), { actorId: 'bob' }));
});
test('I9  Modification de type REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve3'), { type: 'follow' }));
});
test('I10 Modification de createdAt REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve3'), { createdAt: new Date('2025-01-01T00:00:00Z') }));
});
test('I11 Le destinataire marque sa notification comme lue OK', async () => {
  await expectAllowed(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve3'), { read: true, readAt: new Date() }));
});
test('I12 Un tiers ne peut pas marquer comme lue REFUS', async () => {
  await expectDenied(updateDoc(doc(bob().firestore(), 'notifications', 'n_eve4'), { read: true, readAt: new Date() }));
});
test('I13 Modification arbitraire (champ nouveau) REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve4'), { read: true, readAt: new Date(), content: 'x' }));
});
test('I14 Le client ne peut pas modifier users.notificationCount REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { notificationCount: 5 }));
});
test('I15 Schéma strict : postId/commentId modifiés REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve4'), { read: true, readAt: new Date(), postId: 'x' }));
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve4'), { read: true, readAt: new Date(), commentId: 'y' }));
});
test('I16 Une notification déjà lue est immuable REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_read'), { read: true, readAt: new Date() }));
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_read'), { read: false, readAt: null }));
});
test('I17 readAt non-timestamp REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve5'), { read: true, readAt: '2026-01-01' }));
});
test('I18 read=true sans readAt REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'notifications', 'n_eve5'), { read: true }));
});
test('I19 Création d’un profil avec notificationCount non nul REFUS', async () => {
  await expectDenied(setDoc(doc(zoe().firestore(), 'users', 'zoe9'), user('zoe9', 'user', { notificationCount: 5 })));
});

// ============================================================
// J. Partage / renvoi de publications (Phase 6)
// Collection `shares` : ID DÉTERMINISTE `shareId = ${userId}_${postId}`
// (imposé par la règle de création -> un second partage est un update
// -> refusé). Document IMMUABLE (pas d'update). Lecture : tout
// utilisateur connecté. Création : canAct() + userId == auth.uid +
// post cible lisible (isPostReadable). Suppression : réservée au
// shareur. Le compteur posts.shareCount est maintenu UNIQUEMENT par
// les Cloud Functions (onShareCreated / onShareDeleted) — jamais
// modifiable par un client. Aucun compteur users.shareCount.
// ============================================================
test('J1  Non-auth : création de partage REFUS', async () => {
  await expectDenied(setDoc(doc(anon().firestore(), 'shares', 'anon_post6'), share('anon', 'post6')));
});
test('J2  Non-auth : lecture d’un partage REFUS', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'shares', 'eve_post5')));
});
test('J3  Partage sur un post public OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'shares', 'eve_post5'), share('eve', 'post5')));
});
test('J4  Partage sur un post masqué REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'shares', 'eve_post4'), share('eve', 'post4')));
});
test('J5  Partage sur un post followers (non suiveur) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'shares', 'eve_post2'), share('eve', 'post2')));
});
test('J6  Partage sur un post privé d’autrui REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'shares', 'eve_post3'), share('eve', 'post3')));
});
test('J7  Partage avec un ID de document incohérent REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'shares', 'wrong_post5'), share('eve', 'post5')));
});
test('J8  Partage avec userId tiers REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'shares', 'bob_post5'), share('bob', 'post5')));
});
test('J9  Partage sur un post inexistant REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'shares', 'eve_ghost'), share('eve', 'ghost')));
});
test('J10 Partage dupliqué (même cible) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'shares', 'eve_post5'), share('eve', 'post5')));
});
test('J11 Modification d’un partage REFUS (immuable)', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'shares', 'eve_post5'), { updatedAt: new Date() }));
});
test('J12 Un partage est lisible par les autres utilisateurs connectés OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'shares', 'eve_post5')));
});
test('J13 Requête « mes partages » (where userId) OK', async () => {
  const snap = await getDocs(
    query(collection(eve().firestore(), 'shares'), where('userId', '==', 'eve'))
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('eve_post5')) {
    throw new Error(`La requête « mes partages » devrait contenir eve_post5 : ${ids.join(', ')}`);
  }
});
test('J14 Partage avec un champ supplémentaire REFUS (hasOnly)', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'shares', 'eve_post1'), share('eve', 'post1', { extra: true })));
});
test('J15 L’auteur peut partager son propre post privé OK', async () => {
  await expectAllowed(setDoc(doc(alice().firestore(), 'shares', 'alice_post3'), share('alice', 'post3')));
});
test('J16 Suppression du partage d’un autre REFUS', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'shares', 'charlie_post6'), share('charlie', 'post6')));
  await expectDenied(deleteDoc(doc(eve().firestore(), 'shares', 'charlie_post6')));
});
test('J17 L’auteur supprime son propre partage OK', async () => {
  await expectAllowed(deleteDoc(doc(eve().firestore(), 'shares', 'eve_post5')));
});
test('J18 Utilisateur sans profil ne peut pas partager', async () => {
  const nog = () => testEnv.authenticatedContext('nog');
  await expectDenied(setDoc(doc(nog().firestore(), 'shares', 'nog_post1'), share('nog', 'post1')));
});
test('J19 Un client ne peut pas modifier posts.shareCount REFUS', async () => {
  await expectDenied(updateDoc(doc(alice().firestore(), 'posts', 'post1'), { shareCount: 5 }));
});
test('J20 Un client ne peut pas modifier users.shareCount (champ inexistant) REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'users', 'eve'), { shareCount: 5 }));
});

// ============================================================
// K. Lecture des posts visibility='followers' (Phase 7 - fil d'abonnés)
// Le fil « Abonnés » repose sur la règle existsante followsAuthor()
// (firestore.rules) : un post 'followers' ne peut être lu que par un
// abonné à son auteur, par son auteur, ou par un modérateur/admin.
//
// IMPORTANT (contrainte du moteur de règles) : la règle de lecture
// d'un post (`isPostDataReadable`) déréférence `authorId` (via
// followsAuthor pour les posts 'followers'), `moderationStatus` et
// `visibility`. Pour une requête de collection à lecture non
// court-circuitée, le moteur exige que la requête soit contrainte sur
// CHACUN de ces champs (une requête `where visibility == 'followers'`
// seule est rejetée : « Property authorId is undefined » ; puis
// « Property moderationStatus is undefined »). L'application interroge
// donc `where authorId in [moi, ...suivis]` + `moderationStatus ==
// 'visible'` + `visibility in ['public','followers']` : requête valide
// (index composite posts authorId/moderationStatus/visibility), les
// règles filtrant ensuite chaque document.
//
// Ces tests reproduisent exactement cette requête de l'application
// (contrainte authorId + moderationStatus + visibility) et verrouillent
// l'absence de tout leak.
// Données exploitées : post2 = post 'followers' d'alice.
// ============================================================
test('K1  Lecture d’un post followers par un abonné OK', async () => {
  // dave suit alice (suivi créé via une règle, pas seed antérieur).
  await expectAllowed(setDoc(doc(dave().firestore(), 'follows', 'dave_alice'), follow('dave', 'alice')));
  await expectAllowed(getDoc(doc(dave().firestore(), 'posts', 'post2')));
});
test('K2  Lecture d’un post followers par un non-abonné REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'posts', 'post2')));
});
test('K3  L’auteur lit son propre post followers OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'posts', 'post2')));
});
test('K4  Un modérateur lit un post followers OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'posts', 'post2')));
});
test('K5  Un administrateur lit un post followers OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'posts', 'post2')));
});
test('K6  Requête « fil abonnés » d’un abonné (authorId in [suivi]) : post followers OK', async () => {
  // dave suit alice : il interroge exactement comme l'application
  // (authorId in [suivi] + moderationStatus + visibility). post2
  // (followers) doit remonter.
  const snap = await getDocs(
    query(
      collection(dave().firestore(), 'posts'),
      where('authorId', 'in', ['alice']),
      where('moderationStatus', '==', 'visible'),
      where('visibility', 'in', ['public', 'followers'])
    )
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('post2')) {
    throw new Error(`Un abonné devrait voir post2 dans sa requête de fil : ${ids.join(', ')}`);
  }
});
test('K7  Requête « fil abonnés » d’un non-abonné (authorId in [suivi]) : aucun leak', async () => {
  // eve ne suit pas alice. En sémantique Firestore de requête de
  // collection, la règle de lecture s'applique à CHAQUE document
  // renvoyé : le jeu candidat contient post2 (followers, illisible par
  // eve), donc la REQUÊTE ENTIÈRE est refusée — aucun document (même
  // post1, public) ne fuit.
  await expectDenied(
    getDocs(
      query(
        collection(eve().firestore(), 'posts'),
        where('authorId', 'in', ['alice']),
        where('moderationStatus', '==', 'visible'),
        where('visibility', 'in', ['public', 'followers'])
      )
    )
  );
});
test('K8  Base : requête posts publics (sans contrainte authorId) OK', async () => {
  const snap = await getDocs(
    query(collection(eve().firestore(), 'posts'), where('visibility', '==', 'public'), where('moderationStatus', '==', 'visible'))
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('post1')) {
    throw new Error(`La requête posts publics devrait contenir post1 : ${ids.join(', ')}`);
  }
});

// ============================================================
// L. Dette technique post-Phase 8 (P2/P3/P4)
//   - Commentaire créé avec moderationStatus autres que 'visible'
//     REFUS (durcissement de création, aligné sur les posts).
//   - Signalements de type 'comment' et 'user' : création autorisée
//     (les signalements de commentaires/utilisateurs doivent pouvoir
//     être créés — la modération s'appuie dessus).
//   - Notification de type 'reply' : lisible par le destinataire,
//     champs épinglés (immuable comme toute notification), jamais
//     modifiable par un client.
// ============================================================
test('L1  Créer un commentaire avec moderationStatus=hidden REFUS (durcissement)', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'comments', 'c_hidden'), {
    postId: 'post1', authorId: 'eve', content: 'Commentaire masqué à la création',
    replyToId: '', createdAt: T.createdAt, updatedAt: T.updatedAt,
    moderationStatus: 'hidden', deletedAt: null,
  }));
});
test('L2  Créer un commentaire avec moderationStatus=visible OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'comments', 'c_vis'), {
    postId: 'post1', authorId: 'eve', content: 'Commentaire visible à la création',
    replyToId: '', createdAt: T.createdAt, updatedAt: T.updatedAt,
    moderationStatus: 'visible', deletedAt: null,
  }));
});
test('L3  Créer un signalement de type comment OK', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'reports', 'charlie_comment_c_vis'),
    report('charlie', 'comment', 'c_vis')));
});
test('L4  Créer un signalement de type user OK', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'reports', 'charlie_user_alice'),
    report('charlie', 'user', 'alice')));
});
test('L5  Un signalement de type user avec statut non pending REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'reports', 'charlie_user_bob'),
    report('charlie', 'user', 'bob', 'harassment', 'resolved')));
});
test('L6  Signalement de type comment avec targetType invalide REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'reports', 'charlie_comment_post1'), {
    ...report('charlie', 'comment', 'post1'), targetType: 'channel',
  }));
});
test('L7  Notification de type reply : lisible par le destinataire OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'notifications', 'n_reply')));
});
test('L8  Notification de type reply : lisible par un admin OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'notifications', 'n_reply')));
});
test('L9  Notification de type reply : illisible par un tiers REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'notifications', 'n_reply')));
});
test('L10 Notification de type reply : un client ne modifie jamais le type REFUS', async () => {
  await expectDenied(updateDoc(doc(alice().firestore(), 'notifications', 'n_reply'), { type: 'like' }));
});
test('L11 Notification de type reply : un client ne modifie jamais recipientId REFUS', async () => {
  await expectDenied(updateDoc(doc(alice().firestore(), 'notifications', 'n_reply'), { recipientId: 'eve' }));
});
test('L12 Notification de type reply : un client ne peut pas la créer REFUS', async () => {
  await expectDenied(setDoc(doc(alice().firestore(), 'notifications', 'n_cli'),
    notification('alice', 'bob', 'reply', { postId: 'post5', commentId: 'c_x' })));
});
test('L13 Notification de type reply : marquage non lue -> lue OK', async () => {
  await expectAllowed(updateDoc(doc(alice().firestore(), 'notifications', 'n_reply'), {
    read: true, readAt: new Date(),
  }));
});

// ============================================================
// M. Correctif dédié : visibilité des commentaires modérés
//   Un utilisateur normal ne lit QUE les commentaires
//   moderationStatus == 'visible'. Un modérateur/admin lit également
//   les 'hidden' et 'removed'. Le fait d'être l'auteur du post parent
//   (non-modérateur) n'accorde PAS l'accès aux commentaires modérés.
//   Documents seedés sur post1 (auteur alice, user) : s_vis (visible),
//   s_hidden (hidden), s_removed (removed), s_reply_hidden (réponse
//   hidden d'un parent hidden).
// ============================================================
test('M1  Commentaire visible lisible par un utilisateur autorisé OK', async () => {
  await expectAllowed(getDoc(doc(eve().firestore(), 'comments', 's_vis')));
});
test('M2  Commentaire hidden illisible par un utilisateur normal REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'comments', 's_hidden')));
});
test('M3  Commentaire removed illisible par un utilisateur normal REFUS', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'comments', 's_removed')));
});
test('M4  Commentaire hidden lisible par un modérateur OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'comments', 's_hidden')));
});
test('M5  Commentaire removed lisible par un modérateur OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'comments', 's_removed')));
});
test('M6  Commentaire hidden lisible par un administrateur OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'comments', 's_hidden')));
});
test('M7  Requête filtrée postId + moderationStatus==visible OK (utilisateur normal)', async () => {
  const snap = await getDocs(
    query(
      collection(eve().firestore(), 'comments'),
      where('postId', '==', 'post1'),
      where('moderationStatus', '==', 'visible')
    )
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('s_vis')) {
    throw new Error(`La requête devrait contenir s_vis : ${ids.join(', ')}`);
  }
});
test('M8  Présence hidden/removed : aucune fuite dans la requête utilisateur normal', async () => {
  const snap = await getDocs(
    query(
      collection(eve().firestore(), 'comments'),
      where('postId', '==', 'post1'),
      where('moderationStatus', '==', 'visible')
    )
  );
  const ids = snap.docs.map((d) => d.id);
  const leaked = ids.filter((id) => id === 's_hidden' || id === 's_removed' || id === 's_reply_hidden');
  if (leaked.length > 0) {
    throw new Error(`Fuite de commentaires modérés dans la requête utilisateur : ${leaked.join(', ')}`);
  }
});
test('M9  Auteur du post (non-modérateur) ne lit pas les commentaires modérés REFUS', async () => {
  await expectDenied(getDoc(doc(alice().firestore(), 'comments', 's_hidden')));
});
test('M10 Auteur du post (non-modérateur) lit son commentaire visible OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'comments', 's_vis')));
});
test('M11 Un modérateur requête les commentaires totaux (postId seul) sans fuite/refus OK', async () => {
  const snap = await getDocs(
    query(collection(mod().firestore(), 'comments'), where('postId', '==', 'post1'))
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('s_hidden') || !ids.includes('s_removed')) {
    throw new Error(`Le modérateur devrait voir tous les statuts : ${ids.join(', ')}`);
  }
});

// ============================================================
// N. Hashtags (Phase 9 - Lot 1)
// Convention : posts.hashtags OPTIONNEL (compatibilité posts
// existants), tableau de chaînes normalisées — minuscules, sans '#',
// composé uniquement de [0-9a-z_], 1 à 32 caractères, au plus 10
// éléments (MAX_HASHTAGS). Un tableau vide est ACCEPTÉ.
// Les règles REFUSENT : un élément non string, une valeur non
// normalisée (majuscules, accents, espaces, '#' inclus), une longueur
// hors plage, plus de 10 éléments, un tableau absent-du-schéma (autre
// type), et tout champ parasite. La lecture n'est pas affectée par
// hashtags : la page hashtag interroge `hashtags array-contains` +
// `visibility == 'public'` + `moderationStatus == 'visible'` (index
// composite posts [hashtags, visibility, moderationStatus]) et ne
// laisse fuiter aucun post non lisible (followers/private).
// ============================================================
test('N1  Création d’un post sans hashtags OK (champ optionnel)', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'posts', 'ntest1'), post('eve', 'Eve', 'public')));
});
test('N2  Création avec hashtags valides OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'posts', 'ntest2'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: ['parole', 'liberte', 'voix_off'] })));
});
test('N3  Tableau vide autorisé OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'posts', 'ntest3'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: [] })));
});
test('N4  Trop de hashtags (11) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest4'),
    post('eve', 'Eve', 'public', 'visible', {
      hashtags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
    })));
});
test('N5  Élément non string (nombre) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest5'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: ['ok', 42] })));
});
test('N6  hashtags pas un tableau (string) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest6'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: 'parole' })));
});
test('N7  Hashtag invalide (espace/accent/trop long/vide) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest7a'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: ['avec espace'] })));
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest7b'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: ['accént'] })));
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest7c'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: ['a'.repeat(33)] })));
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest7d'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: [''] })));
});
test('N8  Format non normalisé (majuscules) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest8'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: ['Parole'] })));
});
test('N9  Champ parasite à la création REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'posts', 'ntest9'),
    post('eve', 'Eve', 'public', 'visible', { hashtags: ['ok'], hacked: 1 })));
});
test('N10 Mise à jour avec hashtags valides OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'posts', 'ntest10'), post('eve', 'Eve', 'public')));
  await expectAllowed(updateDoc(doc(eve().firestore(), 'posts', 'ntest10'),
    { hashtags: ['nouveau'], updatedAt: new Date() }));
});
test('N11 Mise à jour avec hashtags invalides REFUS', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'posts', 'ntest11'), post('eve', 'Eve', 'public')));
  await expectDenied(updateDoc(doc(eve().firestore(), 'posts', 'ntest11'),
    { hashtags: ['MAJUSCULE'], updatedAt: new Date() }));
  await expectDenied(updateDoc(doc(eve().firestore(), 'posts', 'ntest11'),
    { hashtags: ['a'.repeat(40)], updatedAt: new Date() }));
});
test('N12 Requête page hashtag conforme OK (postHtag1 présent)', async () => {
  const snap = await getDocs(
    query(
      collection(eve().firestore(), 'posts'),
      where('hashtags', 'array-contains', 'parole'),
      where('visibility', '==', 'public'),
      where('moderationStatus', '==', 'visible')
    )
  );
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('postHtag1')) {
    throw new Error(`La requête hashtag devrait contenir postHtag1 : ${ids.join(', ')}`);
  }
});
test('N13 Aucune fuite via la requête hashtag (posts followers/private exclus)', async () => {
  const snap = await getDocs(
    query(
      collection(eve().firestore(), 'posts'),
      where('hashtags', 'array-contains', 'parole'),
      where('visibility', '==', 'public'),
      where('moderationStatus', '==', 'visible')
    )
  );
  const ids = snap.docs.map((d) => d.id);
  const leaked = ids.filter((id) => id === 'postHtag2' || id === 'postHtag3');
  if (leaked.length > 0) {
    throw new Error(`Fuite de posts non lisibles par la page hashtag : ${leaked.join(', ')}`);
  }
});

// ============================================================
// O. Blocage utilisateur (Phase 9 - Lot 2)
// Convention : collection blocks/{blockerId}_{blockedId}, schéma
// STRICT à trois champs (blockerId, blockedId, createdAt — hasOnly
// exact), ID déterministe imposé par la règle. Le blocage est
// directionnel (alice_bob = Alice bloque Bob) ; son effet futur sur
// la messagerie sera bidirectionnel via exists() sur les deux
// directions. AUCUN document inverse automatique.
// Création : canAct(), blockerId == auth.uid, pas d'auto-blocage,
// cible existante et non bannie, createdAt timestamp obligatoire.
// Lecture : blocker ou modérateur/admin UNIQUEMENT — le bloqué et
// les tiers ne lisent pas (pas d'énumération). Le document est
// IMMUABLE (update refusé, même pour un modérateur). Suppression :
// uniquement le blocker (isOwner, aligné follow/like/share : un
// utilisateur banni peut débloquer mais ne peut pas créer de
// nouveau blocage).
// ============================================================
test('O01 Création d’un blocage d’un utilisateur existant OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'blocks', 'eve_bob'), blockDoc('eve', 'bob')));
});
test('O02 Auto-blocage REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_eve'), blockDoc('eve', 'eve')));
});
test('O03 blockerId différent de auth.uid REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'alice_bob'), blockDoc('alice', 'bob')));
});
test('O04 Cible inexistante REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_nouser'), blockDoc('eve', 'nouser')));
});
test('O05 Cible bannie REFUS', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'bannedTarget'), user('bannedTarget', 'user', { banned: true }));
  });
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_bannedTarget'), blockDoc('eve', 'bannedTarget')));
});
test('O06 Identifiant de document incohérent REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'wrong_bob'), blockDoc('eve', 'bob')));
});
test('O07 Champ parasite à la création REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_bob'), { ...blockDoc('eve', 'bob'), hacked: 1 }));
});
test('O08 Champ obligatoire absent (blockedId) REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_bob'), { blockerId: 'eve', createdAt: T.createdAt }));
});
test('O09 Types incorrects REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_bob'), blockDoc('eve', 42)));
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_bob'), { blockerId: 'eve', blockedId: 'bob', createdAt: 'not-a-date' }));
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_'), blockDoc('eve', '')));
});
test('O10 Utilisateur banni ne peut pas bloquer REFUS', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'bannedB'), user('bannedB', 'user', { banned: true }));
  });
  const banned = () => testEnv.authenticatedContext('bannedB');
  await expectDenied(setDoc(doc(banned().firestore(), 'blocks', 'bannedB_bob'), blockDoc('bannedB', 'bob')));
});
test('O11 Un même couple ne peut exister qu’en un seul document REFUS (double création = update)', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'blocks', 'eve_charlie'), blockDoc('eve', 'charlie')));
  await expectDenied(setDoc(doc(eve().firestore(), 'blocks', 'eve_charlie'), blockDoc('eve', 'charlie')));
});
test('O12 Le blocker lit son blocage OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'blocks', 'alice_bob')));
});
test('O13 Le bloqué ne lit pas le blocage REFUS', async () => {
  await expectDenied(getDoc(doc(bob().firestore(), 'blocks', 'alice_bob')));
});
test('O14 Un tiers ne lit pas le blocage REFUS', async () => {
  await expectDenied(getDoc(doc(charlie().firestore(), 'blocks', 'alice_bob')));
});
test('O15 Modérateur et admin lisent n’importe quel blocage OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'blocks', 'alice_bob')));
  await expectAllowed(getDoc(doc(admin().firestore(), 'blocks', 'alice_bob')));
});
test('O16 Le blocker ne peut pas modifier son blocage REFUS', async () => {
  await expectDenied(updateDoc(doc(alice().firestore(), 'blocks', 'alice_bob'), { blockedId: 'eve' }));
});
test('O17 Un tiers ne peut pas modifier le blocage REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'blocks', 'alice_bob'), { blockedId: 'alice' }));
});
test('O18 Un modérateur ne peut pas modifier le blocage REFUS', async () => {
  await expectDenied(updateDoc(doc(mod().firestore(), 'blocks', 'alice_bob'), { blockedId: 'mod' }));
});
test('O19 Le blocker supprime son blocage OK', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'blocks', 'eve_dave'), blockDoc('eve', 'dave')));
  await expectAllowed(deleteDoc(doc(eve().firestore(), 'blocks', 'eve_dave')));
});
test('O20 Le bloqué ne peut pas supprimer REFUS', async () => {
  await expectAllowed(setDoc(doc(bob().firestore(), 'blocks', 'bob_eve'), blockDoc('bob', 'eve')));
  await expectDenied(deleteDoc(doc(eve().firestore(), 'blocks', 'bob_eve')));
});
test('O21 Un tiers ne peut pas supprimer REFUS', async () => {
  await expectDenied(deleteDoc(doc(dave().firestore(), 'blocks', 'alice_bob')));
});
test('O22 Utilisateur banni peut supprimer son propre blocage OK (convention isOwner, alignée follow/like/share)', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'bannedD'), user('bannedD', 'user', { banned: true }));
    await setDoc(doc(ctx.firestore(), 'blocks', 'bannedD_alice'), blockDoc('bannedD', 'alice'));
  });
  const banned = () => testEnv.authenticatedContext('bannedD');
  await expectAllowed(deleteDoc(doc(banned().firestore(), 'blocks', 'bannedD_alice')));
});
test('O23 Requête « mes blocages » (where blockerId == moi) OK et bornée', async () => {
  const snap = await getDocs(query(collection(alice().firestore(), 'blocks'), where('blockerId', '==', 'alice')));
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('alice_bob')) {
    throw new Error(`La requête devrait contenir alice_bob : ${ids.join(', ')}`);
  }
  const leaked = snap.docs.filter((d) => d.data().blockerId !== 'alice');
  if (leaked.length > 0) {
    throw new Error(`Fuite de blocages d’autrui dans « mes blocages » : ${leaked.map((d) => d.id).join(', ')}`);
  }
});
test('O24 Un tiers ne peut pas énumérer tous les blocages REFUS', async () => {
  await expectDenied(getDocs(collection(charlie().firestore(), 'blocks')));
});
test('O25 Aucun document inverse automatique (bob_alice inexistant)', async () => {
  // La lecture d'un document INEXISTANT est refusée par le moteur de
  // règles (déréférence de resource sur null) pour un non-bloquer
  // comme pour le bloqué : on vérifie donc la vérité de la BASE via
  // avecRulesDisabled — le document inverse bob_alice ne doit jamais
  // avoir été créé par la création d'alice_bob (aucune double écriture).
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'blocks', 'bob_alice'));
    if (snap.exists()) {
      throw new Error('Le document inverse bob_alice ne devrait pas exister.');
    }
  });
});

// ============================================================
// Phase 9 - Lot 3 : Messagerie privée 1-à-1 (conversations)
// ============================================================
test('P01 Création d’une conversation par un participant OK (ID canonique trié)', async () => {
  await expectAllowed(setDoc(doc(charlie().firestore(), 'conversations', 'charlie_dave'), conversationDoc('charlie', 'dave')));
});
test('P02 ID du doc ≠ participants triés REFUS (déterminisme)', async () => {
  // Doc id non canonique : participants ['charlie','dave'] exigent
  // l'id 'charlie_dave', pas 'dave_charlie'.
  await expectDenied(setDoc(doc(charlie().firestore(), 'conversations', 'dave_charlie'), conversationDoc('charlie', 'dave')));
  // Doc id canonique mais participants stockés DANS LE DÉSORDRE.
  await expectDenied(setDoc(doc(charlie().firestore(), 'conversations', 'charlie_dave'),
    { ...conversationDoc('charlie', 'dave'), participants: ['dave', 'charlie'] }));
});
test('P03 Plus de 2 participants REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'conversations', 'charlie_dave2'),
    { ...conversationDoc('charlie', 'dave'), participants: ['charlie', 'dave', 'eve'] }));
});
test('P04 Conversation avec soi-même REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'conversations', 'eve_eve'), conversationDoc('eve', 'eve')));
});
test('P05 Création par un NON-participant REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'conversations', 'bob_eve'), conversationDoc('bob', 'eve')));
});
test('P06 Champ parasite à la création REFUS (hasOnly)', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'conversations', 'dave_charlie2'),
    { ...conversationDoc('dave', 'charlie'), hacked: 1 }));
});
test('P07 Champ obligatoire manquant (participants) REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'conversations', 'charlie_dave3'),
    { createdAt: T.createdAt, lastMessageAt: null, lastMessagePreview: '', lastSenderId: '' }));
});
test('P08 Types incorrects REFUS', async () => {
  // participants mélangés [string, nombre] : taille 2 mais types faux.
  await expectDenied(setDoc(doc(charlie().firestore(), 'conversations', 'charlie_dave4'),
    { ...conversationDoc('charlie', 'dave'), participants: ['charlie', 42] }));
});
test('P09 Utilisateur banni ne peut pas créer une conversation REFUS', async () => {
  const bannedP = () => testEnv.authenticatedContext('bannedP');
  await expectDenied(setDoc(doc(bannedP().firestore(), 'conversations', 'charlie_bannedP'), conversationDoc('charlie', 'bannedP')));
});
test('P10 Double création du même ID REFUS (double setDoc = update)', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'conversations', 'charlie_dave'), conversationDoc('charlie', 'dave')));
});
test('P11 Lecture par un participant OK (même avec un blocage en place)', async () => {
  // bob est bloqué par alice (seed alice_bob) : l'HISTORIQUE reste lisible.
  await expectAllowed(getDoc(doc(alice().firestore(), 'conversations', 'alice_bob')));
  await expectAllowed(getDoc(doc(bob().firestore(), 'conversations', 'alice_bob')));
});
test('P12 Lecture par un tiers REFUS', async () => {
  await expectDenied(getDoc(doc(charlie().firestore(), 'conversations', 'alice_bob')));
});
test('P13 Lecture par modérateur et admin OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'conversations', 'alice_bob')));
  await expectAllowed(getDoc(doc(admin().firestore(), 'conversations', 'alice_bob')));
});
test('P14 Lecture par un utilisateur banni REFUS', async () => {
  const bannedP = () => testEnv.authenticatedContext('bannedP');
  await expectDenied(getDoc(doc(bannedP().firestore(), 'conversations', 'alice_bannedP')));
});
test('P15 Modification par un participant REFUS (immuable côté client)', async () => {
  await expectDenied(updateDoc(doc(alice().firestore(), 'conversations', 'alice_bob'), { lastMessagePreview: 'hacké' }));
});
test('P16 Suppression par un participant REFUS', async () => {
  await expectDenied(deleteDoc(doc(alice().firestore(), 'conversations', 'alice_bob')));
});
test('P17 Un tiers ne peut pas énumérer toutes les conversations REFUS', async () => {
  await expectDenied(getDocs(collection(charlie().firestore(), 'conversations')));
});
test('P18 Requête « mes conversations » (array-contains moi) OK et sans fuite', async () => {
  const snap = await getDocs(query(
    collection(alice().firestore(), 'conversations'),
    where('participants', 'array-contains', 'alice'),
    orderBy('lastMessageAt', 'desc'),
  ));
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('alice_bob') || !ids.includes('alice_eve') || !ids.includes('alice_zoe')) {
    throw new Error(`La requête devrait contenir les conversations d'alice : ${ids.join(', ')}`);
  }
  if (ids.includes('charlie_dave')) {
    throw new Error(`Fuite d'une conversation d'autrui dans « mes conversations » : ${ids.join(', ')}`);
  }
  const leaked = snap.docs.filter((d) => !d.data().participants.includes('alice'));
  if (leaked.length > 0) {
    throw new Error(`Conversation sans alice dans « mes conversations » : ${leaked.map((d) => d.id).join(', ')}`);
  }
});

// ============================================================
// Phase 9 - Lot 3 : Messagerie privée 1-à-1 (messages)
// ============================================================
test('M01 Envoi d’un message dans une conversation existante OK (aucun blocage)', async () => {
  await expectAllowed(setDoc(doc(eve().firestore(), 'messages', 'm_eve1'), messageDoc('alice_eve', 'eve', 'Re bonjour')));
});
test('M02 Envoi par un NON-participant REFUS', async () => {
  await expectDenied(setDoc(doc(charlie().firestore(), 'messages', 'm_charlie1'), messageDoc('alice_bob', 'charlie', 'Intrusion')));
});
test('M03 Envoi bloqué dans la direction « je bloque » REFUS', async () => {
  await expectDenied(setDoc(doc(alice().firestore(), 'messages', 'm_bl_1'), messageDoc('alice_bob', 'alice', 'Coucou')));
});
test('M04 Envoi bloqué dans la direction « il me bloque » REFUS (effet bidirectionnel)', async () => {
  await expectDenied(setDoc(doc(bob().firestore(), 'messages', 'm_bl_2'), messageDoc('alice_bob', 'bob', 'Réponse impossible')));
});
test('M05 Envoi vers une conversation inexistante REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'messages', 'm_ghost'), messageDoc('no_conv_send', 'dave', 'Vers le néant')));
});
test('M06 senderId ≠ auth.uid REFUS (usurpation)', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_usurp'), messageDoc('alice_eve', 'alice', 'Faux alice')));
});
test('M07 Contenu vide REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_empty'), messageDoc('alice_eve', 'eve', '')));
});
test('M08 Contenu > 2000 caractères REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_long'), messageDoc('alice_eve', 'eve', 'x'.repeat(2001))));
});
test('M09 read=true à la création REFUS (lu au dépôt interdit)', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_read'), messageDoc('alice_eve', 'eve', 'Déjà lu', { read: true })));
});
test('M10 readAt non null à la création REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_readat'), messageDoc('alice_eve', 'eve', 'Daté', { readAt: T.createdAt })));
});
test('M11 moderationStatus ≠ visible à la création REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_mod'), messageDoc('alice_eve', 'eve', 'Masqué', { moderationStatus: 'hidden' })));
});
test('M12 Champ parasite à la création REFUS (hasOnly)', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_hack'), { ...messageDoc('alice_eve', 'eve', 'Bien'), hacked: 1 }));
});
test('M13 conversationId manquant REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_noconv'),
    { senderId: 'eve', content: 'Sans conversation', read: false, readAt: null, moderationStatus: 'visible', createdAt: T.createdAt }));
});
test('M14 content non-string REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'messages', 'm_num'), { ...messageDoc('alice_eve', 'eve', 'ok'), content: 42 }));
});
test('M15 Utilisateur banni ne peut pas envoyer REFUS', async () => {
  const bannedP = () => testEnv.authenticatedContext('bannedP');
  await expectDenied(setDoc(doc(bannedP().firestore(), 'messages', 'm_ban_send'), messageDoc('alice_bannedP', 'bannedP', 'Banni')));
});
test('M16 Utilisateur sans profil ne peut pas envoyer REFUS', async () => {
  // ghostP est participant de alice_ghost (seed) mais n'a AUCUN profil.
  const ghostP = () => testEnv.authenticatedContext('ghostP');
  await expectDenied(setDoc(doc(ghostP().firestore(), 'messages', 'm_ghostsend'), messageDoc('alice_ghost', 'ghostP', 'Sans profil')));
});
test('M17 Lecture par un participant OK', async () => {
  await expectAllowed(getDoc(doc(alice().firestore(), 'messages', 'm2')));
});
test('M18 Lecture de l’historique malgré un blocage OK', async () => {
  // bob EST le destinataire ET alice le bloque : l'historique reste lisible.
  await expectAllowed(getDoc(doc(bob().firestore(), 'messages', 'm1')));
});
test('M19 Lecture par un tiers REFUS', async () => {
  await expectDenied(getDoc(doc(charlie().firestore(), 'messages', 'm1')));
});
test('M20 Lecture par un modérateur OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'messages', 'm1')));
});
test('M21 Lecture par un utilisateur banni REFUS', async () => {
  const bannedP = () => testEnv.authenticatedContext('bannedP');
  await expectDenied(getDoc(doc(bannedP().firestore(), 'messages', 'm_banned')));
});
test('M22 Lecture d’un message d’une conversation inexistante REFUS', async () => {
  await expectDenied(getDoc(doc(alice().firestore(), 'messages', 'm_orphan')));
});
test('M23 Un participant ne peut pas énumérer tous les messages REFUS', async () => {
  await expectDenied(getDocs(collection(alice().firestore(), 'messages')));
});
test('M24 Requête bornée sur conversationId OK (ordre createdAt croissant, aucun message étranger)', async () => {
  const snap = await getDocs(query(
    collection(alice().firestore(), 'messages'),
    where('conversationId', '==', 'alice_bob'),
    orderBy('createdAt', 'asc'),
  ));
  const ids = snap.docs.map((d) => d.id).sort();
  if (ids.join(',') !== ['m1', 'm2', 'm3'].join(',')) {
    throw new Error(`Requête messages alice_bob inattendue : ${ids.join(', ')}`);
  }
  const leaked = snap.docs.filter((d) => d.data().conversationId !== 'alice_bob');
  if (leaked.length > 0) {
    throw new Error(`Message hors conversation dans la requête : ${leaked.map((d) => d.id).join(', ')}`);
  }
});
test('M25 Le DESTINATAIRE marque un message comme lu OK', async () => {
  // m2 : envoyé par bob → destinaire alice. Seule alice peut le marquer lu.
  await expectAllowed(updateDoc(doc(alice().firestore(), 'messages', 'm2'), { read: true, readAt: T.createdAt }));
});
test('M26 L’AUTEUR ne peut pas marquer son propre message comme lu REFUS', async () => {
  // bob est l'auteur de m2 : il ne peut pas se marquer lu à lui-même.
  await expectDenied(updateDoc(doc(bob().firestore(), 'messages', 'm2'), { read: true, readAt: T.createdAt }));
});
test('M27 read true→false REFUS (double sens de lecture interdit)', async () => {
  await expectDenied(updateDoc(doc(alice().firestore(), 'messages', 'm2'), { read: false }));
});
test('M28 Déjà-lu immuable REFUS (aucune ré-écriture)', async () => {
  // m1 a déjà read=true : toute nouvelle écriture (même read:true) est refusée.
  await expectDenied(updateDoc(doc(bob().firestore(), 'messages', 'm1'), { read: true, readAt: T.createdAt }));
});
test('M29 Un tiers ne peut pas marquer comme lu REFUS', async () => {
  await expectDenied(updateDoc(doc(charlie().firestore(), 'messages', 'm3'), { read: true, readAt: T.createdAt }));
});
test('M30 Un modérateur ne peut pas contourner la règle de lecture REFUS', async () => {
  await expectDenied(updateDoc(doc(mod().firestore(), 'messages', 'm3'), { read: true, readAt: T.createdAt }));
});
test('M31 Un utilisateur banni ne peut pas marquer comme lu REFUS', async () => {
  const bannedP = () => testEnv.authenticatedContext('bannedP');
  await expectDenied(updateDoc(doc(bannedP().firestore(), 'messages', 'm_banned'), { read: true, readAt: T.createdAt }));
});
test('M32 Édition du contenu REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'messages', 'm4'), { content: 'Corrigé' }));
});
test('M33 Suppression d’un message REFUS (immuable)', async () => {
  await expectDenied(deleteDoc(doc(eve().firestore(), 'messages', 'm4')));
  await expectDenied(deleteDoc(doc(alice().firestore(), 'messages', 'm2')));
});

// ============================================================
// Phase 9 - Lot 3 : Messagerie (messageCount du profil)
// ============================================================
test('U01 messageCount doit être 0 à la création du profil (absent ou pair REFUS)', async () => {
  // users.create exige messageCount == 0 (et le champ dans hasOnly).
  const ctx = () => testEnv.authenticatedContext('zoeNew');
  await expectDenied(setDoc(doc(ctx().firestore(), 'users', 'zoeNew'), { ...user('zoeNew'), messageCount: 1 }));
  const { messageCount: _unused, ...withoutCount } = user('zoeNew');
  await expectDenied(setDoc(doc(ctx().firestore(), 'users', 'zoeNew'), withoutCount));
});
test('U02 L’utilisateur ne peut pas modifier messageCount REFUS (épinglé)', async () => {
  await expectDenied(updateDoc(doc(alice().firestore(), 'users', 'alice'), { messageCount: 3 }));
});

// ============================================================
// Phase 9 - Lot 4 : Recours (bloc Q)
// ============================================================

// --- CRÉATION ---
test('Q01 Création valide : recours sur un post masqué (dave) OK', async () => {
  await expectAllowed(setDoc(doc(dave().firestore(), 'appeals', 'dave_post_postQHidden'), appealDoc('dave', 'post', 'postQHidden', 'hidden')));
});
test('Q02 Création valide : recours sur un post retiré (dave) OK', async () => {
  await expectAllowed(setDoc(doc(dave().firestore(), 'appeals', 'dave_post_postQRemoved'), appealDoc('dave', 'post', 'postQRemoved', 'removed')));
});
test('Q03 Création valide : recours sur un commentaire masqué (dave) OK', async () => {
  await expectAllowed(setDoc(doc(dave().firestore(), 'appeals', 'dave_comment_cQHidden'), appealDoc('dave', 'comment', 'cQHidden', 'hidden')));
});
test('Q04 Création valide : recours sur un commentaire retiré (dave) OK', async () => {
  await expectAllowed(setDoc(doc(dave().firestore(), 'appeals', 'dave_comment_cQRemoved'), appealDoc('dave', 'comment', 'cQRemoved', 'removed')));
});
test('Q05 Création valide : recours sur compte averti (warnedQ, lui-même) OK', async () => {
  await expectAllowed(setDoc(doc(warnedQ().firestore(), 'appeals', 'warnedQ_user_warnedQ'), appealDoc('warnedQ', 'user', 'warnedQ', 'warned')));
});
test('Q06 Non-auth : création d’un recours REFUS', async () => {
  await expectDenied(setDoc(doc(anon().firestore(), 'appeals', 'anon_post_postQHidden'), appealDoc('anon', 'post', 'postQHidden', 'hidden')));
});
test('Q07 Utilisateur non concerné : recours sur le post d’autrui REFUS', async () => {
  await expectDenied(setDoc(doc(bob().firestore(), 'appeals', 'bob_post_postQHidden'), appealDoc('bob', 'post', 'postQHidden', 'hidden')));
});
test('Q08 Cible non sanctionnée (post visible de l’appelant) REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave_post_postQVisible'), appealDoc('dave', 'post', 'postQVisible', 'hidden')));
});
test('Q09 Recours « user pour autrui » (targetId ≠ auth.uid) REFUS', async () => {
  await expectDenied(setDoc(doc(alice().firestore(), 'appeals', 'alice_user_bob'), appealDoc('alice', 'user', 'bob', 'warned')));
});
test('Q10 Utilisateur banni : dépôt de recours REFUS (canAct)', async () => {
  await expectDenied(setDoc(doc(bannedQ().firestore(), 'appeals', 'bannedQ_user_bannedQ'), appealDoc('bannedQ', 'user', 'bannedQ', 'suspended')));
});
test('Q11 ID de document non déterministe REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'wrong_id'), appealDoc('dave', 'post', 'postQHidden', 'hidden')));
});
test('Q12 Champ appealId incohérent avec l’id du document REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave_post_postQHidden'), { ...appealDoc('dave', 'post', 'postQHidden', 'hidden'), appealId: 'dave_post_OTHER' }));
});
test('Q13 sanctionType incohérent avec l’état réel (post hidden déclaré removed) REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave2_post_postQHidden'), appealDoc('dave', 'post', 'postQHidden', 'removed')));
});
test('Q14 sanctionType non autorisé pour le type de cible (post avec warned) REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave2_post_postQRemoved'), appealDoc('dave', 'post', 'postQRemoved', 'warned')));
});
test('Q15 Raison vide REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave3_post_postQHidden'), appealDoc('dave', 'post', 'postQHidden', 'hidden', '')));
});
test('Q16 Raison > 2000 caractères REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave3_post_postQRemoved'), appealDoc('dave', 'post', 'postQRemoved', 'removed', 'x'.repeat(2001))));
});
test('Q17 status ≠ pending à la création REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave4_post_postQHidden'), appealDoc('dave', 'post', 'postQHidden', 'hidden', 'Raison', { status: 'accepted' })));
});
test('Q18 createdAt non-timestamp REFUS', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave4_post_postQRemoved'), appealDoc('dave', 'post', 'postQRemoved', 'removed', 'Raison', { createdAt: 'hier' })));
});
test('Q19 Champ parasite à la création REFUS (hasOnly)', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave5_post_postQHidden'), appealDoc('dave', 'post', 'postQHidden', 'hidden', 'Raison', { reviewedBy: 'mod' })));
});
test('Q20 Champ obligatoire manquant (status) REFUS', async () => {
  const { status: _unused, ...withoutStatus } = appealDoc('dave', 'post', 'postQHidden', 'hidden');
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave5_post_postQRemoved'), withoutStatus));
});
test('Q21 Doublon du même recours REFUS (second setDoc = update)', async () => {
  await expectDenied(setDoc(doc(dave().firestore(), 'appeals', 'dave_post_postQHidden'), appealDoc('dave', 'post', 'postQHidden', 'hidden')));
});
test('Q22 Sans profil existant : dépôt de recours REFUS (canAct)', async () => {
  const noProfile = () => testEnv.authenticatedContext('noprofileQ');
  await expectDenied(setDoc(doc(noProfile().firestore(), 'appeals', 'noprofileQ_post_postQHidden'), appealDoc('noprofileQ', 'post', 'postQHidden', 'hidden')));
});

// --- LECTURE ---
test('Q23 L’appelant lit son propre recours OK', async () => {
  await expectAllowed(getDoc(doc(dave().firestore(), 'appeals', 'dave_post_postQHidden')));
});
test('Q24 Un tiers ne lit pas le recours REFUS (y compris un utilisateur banni)', async () => {
  await expectDenied(getDoc(doc(bob().firestore(), 'appeals', 'dave_post_postQHidden')));
  await expectDenied(getDoc(doc(bannedQ().firestore(), 'appeals', 'dave_post_postQHidden')));
});
test('Q25 Un modérateur lit le recours OK', async () => {
  await expectAllowed(getDoc(doc(mod().firestore(), 'appeals', 'dave_post_postQHidden')));
});
test('Q26 Un administrateur lit le recours OK', async () => {
  await expectAllowed(getDoc(doc(admin().firestore(), 'appeals', 'dave_post_postQHidden')));
});
test('Q27 Requête « mes recours » (where appellantId == dave) OK et bornée', async () => {
  const snap = await getDocs(query(collection(dave().firestore(), 'appeals'), where('appellantId', '==', 'dave')));
  if (snap.size < 2) throw new Error(`Attendu les recours de dave, obtenu ${snap.size}`);
  snap.forEach((d) => {
    if (d.data().appellantId !== 'dave') throw new Error('Fuite : recours d’un autre appelant.');
  });
});
test('Q28 Requête « recours à traiter » (where status == pending) : modérateur OK, utilisateur REFUS', async () => {
  const modSnap = await getDocs(query(collection(mod().firestore(), 'appeals'), where('status', '==', 'pending')));
  if (modSnap.size < 1) throw new Error('Attendu au moins un recours en attente.');
  await expectDenied(getDocs(query(collection(eve().firestore(), 'appeals'), where('status', '==', 'pending'))));
});
test('Q29 Énumération globale des recours par un utilisateur REFUS', async () => {
  await expectDenied(getDocs(collection(eve().firestore(), 'appeals')));
});

// --- MODIFICATION / SUPPRESSION (document IMMUABLE côté client) ---
test('Q30 Update direct par l’appelant REFUS (immuable)', async () => {
  await expectDenied(updateDoc(doc(dave().firestore(), 'appeals', 'dave_post_postQHidden'), { status: 'accepted' }));
});
test('Q31 Update direct par modérateur/admin REFUS (résolution exclusive via reviewAppeal)', async () => {
  await expectDenied(updateDoc(doc(mod().firestore(), 'appeals', 'dave_post_postQHidden'), { status: 'accepted' }));
  await expectDenied(updateDoc(doc(admin().firestore(), 'appeals', 'dave_post_postQHidden'), { status: 'rejected' }));
  await expectDenied(deleteDoc(doc(admin().firestore(), 'appeals', 'dave_post_postQHidden')));
});

// ============================================================
// Phase 9 - Lot 5 : Recherche (users.searchTokens)
// Champ OPTIONNEL, tableau borné (≤ 12 éléments), chaque token =
// string [0-9a-z_]{2,12} (majuscules/espaces/accents/ponctuation
// refusés). Liage au displayName sur update : searchTokens ne peut
// changer QUE lorsque displayName change. Lecture utilisée par la
// recherche : un unique array-contains mono-champ (aucun index
// composite). La requête `where('searchTokens','array-contains',t)`
// est autorisée par la règle de lecture users (isSignedIn).
// ============================================================
test('R01 Création de profil SANS searchTokens OK (champ optionnel)', async () => {
  const rnew = () => testEnv.authenticatedContext('rnew1');
  await expectAllowed(setDoc(doc(rnew().firestore(), 'users', 'rnew1'), user('rnew1')));
});
test('R02 Création de profil AVEC searchTokens valides OK (préfixes d’alice lambert)', async () => {
  const ralice = () => testEnv.authenticatedContext('ralice');
  await expectAllowed(setDoc(doc(ralice().firestore(), 'users', 'ralice'),
    user('ralice', 'user', { searchTokens: ['al', 'ali', 'alic', 'alice', 'la', 'lam', 'lamb', 'lambe', 'lamber', 'lambert'] })));
});
test('R03 searchTokens : tableau vide accepté', async () => {
  const rempty = () => testEnv.authenticatedContext('rempty1');
  await expectAllowed(setDoc(doc(rempty().firestore(), 'users', 'rempty1'),
    user('rempty1', 'user', { searchTokens: [] })));
});
test('R04 searchTokens : plus de 12 éléments REFUS', async () => {
  const r13 = () => testEnv.authenticatedContext('r13');
  await expectDenied(setDoc(doc(r13().firestore(), 'users', 'r13'),
    user('r13', 'user', { searchTokens: ['aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai', 'aj', 'ak', 'al', 'am'] })));
});
test('R05 searchTokens : non-tableau (chaîne) REFUS', async () => {
  const rstr = () => testEnv.authenticatedContext('rstr1');
  await expectDenied(setDoc(doc(rstr().firestore(), 'users', 'rstr1'),
    user('rstr1', 'user', { searchTokens: 'alice' })));
});
test('R06 searchTokens : élément non-chaîne (nombre) REFUS', async () => {
  const rnum = () => testEnv.authenticatedContext('rnum1');
  await expectDenied(setDoc(doc(rnum().firestore(), 'users', 'rnum1'),
    user('rnum1', 'user', { searchTokens: ['al', 42] })));
});
test('R07 searchTokens : token trop court (1 caractère) REFUS', async () => {
  const r1 = () => testEnv.authenticatedContext('r1');
  await expectDenied(setDoc(doc(r1().firestore(), 'users', 'r1'),
    user('r1', 'user', { searchTokens: ['a', 'al'] })));
});
test('R08 searchTokens : token trop long (13 caractères) REFUS', async () => {
  const rlng = () => testEnv.authenticatedContext('rlng1');
  await expectDenied(setDoc(doc(rlng().firestore(), 'users', 'rlng1'),
    user('rlng1', 'user', { searchTokens: ['alicewonderlah'] }))); // 13 caractères
});
test('R09 searchTokens : token en majuscules (non normalisé) REFUS', async () => {
  const rmaj = () => testEnv.authenticatedContext('rmaj1');
  await expectDenied(setDoc(doc(rmaj().firestore(), 'users', 'rmaj1'),
    user('rmaj1', 'user', { searchTokens: ['Alice'] })));
});
test('R10 searchTokens : token contenant un espace REFUS', async () => {
  const rsp = () => testEnv.authenticatedContext('rsp1');
  await expectDenied(setDoc(doc(rsp().firestore(), 'users', 'rsp1'),
    user('rsp1', 'user', { searchTokens: ['al ic'] })));
});
test('R11 searchTokens : token avec accent/ponctuation interdits REFUS', async () => {
  const racc = () => testEnv.authenticatedContext('racc1');
  await expectDenied(setDoc(doc(racc().firestore(), 'users', 'racc1'),
    user('racc1', 'user', { searchTokens: ['léo'] })));
  await expectDenied(setDoc(doc(racc().firestore(), 'users', 'racc2'),
    user('racc2', 'user', { searchTokens: ['leo-'] })));
});
test('R12 Champ parasite à la création AVEC searchTokens valides REFUS (hasOnly)', async () => {
  const rpar = () => testEnv.authenticatedContext('rpar1');
  await expectDenied(setDoc(doc(rpar().firestore(), 'users', 'rpar1'),
    { ...user('rpar1', 'user', { searchTokens: ['rp', 'rpa', 'rpar'] }), hacked: 1 }));
});
test('R13 Update : displayName SEUL (profil sans searchTokens) OK — non-régression', async () => {
  await expectAllowed(updateDoc(doc(eve().firestore(), 'users', 'eve'), { displayName: 'Eve Recherche', updatedAt: new Date() }));
});
test('R14 Update : displayName + searchTokens cohérents OK', async () => {
  const rup = () => testEnv.authenticatedContext('rup1');
  await expectAllowed(setDoc(doc(rup().firestore(), 'users', 'rup1'), user('rup1')));
  await expectAllowed(updateDoc(doc(rup().firestore(), 'users', 'rup1'),
    { displayName: 'Rup1 Deux', searchTokens: ['ru', 'rup', 'rup1', 'de', 'deu', 'deux'], updatedAt: new Date() }));
});
test('R15 Update : searchTokens SANS displayName REFUS (liage)', async () => {
  const rb1 = () => testEnv.authenticatedContext('rb1');
  await expectAllowed(setDoc(doc(rb1().firestore(), 'users', 'rb1'), user('rb1')));
  await expectDenied(updateDoc(doc(rb1().firestore(), 'users', 'rb1'),
    { searchTokens: ['xx', 'xy'], updatedAt: new Date() }));
});
test('R16 Update : displayName + searchTokens NON valides REFUS', async () => {
  const rb2 = () => testEnv.authenticatedContext('rb2');
  await expectAllowed(setDoc(doc(rb2().firestore(), 'users', 'rb2'), user('rb2')));
  await expectDenied(updateDoc(doc(rb2().firestore(), 'users', 'rb2'),
    { displayName: 'Rb2', searchTokens: ['BAD VALUE'], updatedAt: new Date() }));
});
test('R17 Update : searchTokens sur le profil d’un AUTRE utilisateur REFUS', async () => {
  await expectDenied(updateDoc(doc(bob().firestore(), 'users', 'eve'),
    { displayName: 'Piratée', searchTokens: ['hack'], updatedAt: new Date() }));
});
test('R18 Recherche users array-contains autorisée, ciblée et sans fuite (ralice trouvé, alice sans tokens absente)', async () => {
  const ralice = () => testEnv.authenticatedContext('ralice');
  const snap = await getDocs(query(
    collection(ralice().firestore(), 'users'),
    where('searchTokens', 'array-contains', 'alice')
  ));
  const ids = snap.docs.map((d) => d.id);
  if (!ids.includes('ralice')) {
    throw new Error(`La recherche 'alice' devrait trouver ralice : ${ids.join(', ')}`);
  }
  if (ids.includes('alice')) {
    throw new Error(`La recherche 'alice' ne devrait PAS renvoyer le profil seed alice (aucun searchTokens) : ${ids.join(', ')}`);
  }
  const leaked = snap.docs.filter((d) => !(d.data().searchTokens ?? []).includes('alice'));
  if (leaked.length > 0) {
    throw new Error(`Résultat sans le token cherché : ${leaked.map((d) => d.id).join(', ')}`);
  }
});
test('R19 Recherche users par un utilisateur non authentifié REFUS', async () => {
  await expectDenied(getDocs(query(
    collection(anon().firestore(), 'users'),
    where('searchTokens', 'array-contains', 'alice')
  )));
});

// ============================================================
// S. Statistiques d'audience publiques (Phase 9 — Lot 6) : creatorStats
// Collection `creatorStats/{userId}` — lecture PUBLIQUE (utilisateurs
// connectés) avec schéma STRICT (hasOnly + types), AUCUNE écriture côté
// client (les compteurs sont maintenus exclusivement par les Cloud
// Functions). Le postCount est exclu. Un document absent = aucun accès
// (lecture refusée pour un doc inexistant), un document mal formé
// (champ parasite / non numérique / postCount) est illisible.
// ============================================================
function creatorStatsDoc(overrides = {}) {
  return {
    likeCount: 3,
    followerCount: 2,
    followingCount: 1,
    commentCount: 4,
    shareCount: 5,
    ...overrides,
  };
}

test('S1  Non-auth : lecture de creatorStats REFUS', async () => {
  await expectDenied(getDoc(doc(anon().firestore(), 'creatorStats', 'alice')));
});
test('S2  Un utilisateur connecté lit creatorStats OK (schéma strict complet)', async () => {
  await expectAllowed(getDoc(doc(eve().firestore(), 'creatorStats', 'alice')));
});
test('S3  Un autre connecté lit creatorStats OK (lecture publique)', async () => {
  await expectAllowed(getDoc(doc(bob().firestore(), 'creatorStats', 'alice')));
});
test('S4  Lecture d’un creatorStats absent REFUS (document inexistant)', async () => {
  await expectDenied(getDoc(doc(eve().firestore(), 'creatorStats', 'ghost')));
});
test('S5  Un document avec un champ parasite (postCount) est ILLISIBLE REFUS', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'creatorStats', 'extra'),
      creatorStatsDoc({ postCount: 7 }));
  });
  await expectDenied(getDoc(doc(eve().firestore(), 'creatorStats', 'extra')));
});
test('S6  Un compteur non numérique rend le document ILLISIBLE REFUS', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'creatorStats', 'badnum'),
      creatorStatsDoc({ likeCount: 'trois' }));
  });
  await expectDenied(getDoc(doc(eve().firestore(), 'creatorStats', 'badnum')));
});
test('S7  Un champ manquant rend le document ILLISIBLE REFUS (schéma strict)', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'creatorStats', 'missing'), { likeCount: 3 });
  });
  await expectDenied(getDoc(doc(eve().firestore(), 'creatorStats', 'missing')));
});
test('S8  Un client (utilisateur normal) ne peut PAS créer creatorStats REFUS', async () => {
  await expectDenied(setDoc(doc(eve().firestore(), 'creatorStats', 'eve'), creatorStatsDoc()));
});
test('S9  Un client ne peut PAS modifier creatorStats REFUS', async () => {
  await expectDenied(updateDoc(doc(eve().firestore(), 'creatorStats', 'alice'), { likeCount: 999 }));
  await expectDenied(updateDoc(doc(eve().firestore(), 'creatorStats', 'alice'), { likeCount: 50, followerCount: 2, followingCount: 1, commentCount: 4, shareCount: 5 }));
});
test('S10 Un client ne peut PAS supprimer creatorStats REFUS', async () => {
  await expectDenied(deleteDoc(doc(eve().firestore(), 'creatorStats', 'alice')));
});
test('S11 Un modérateur ne peut PAS écrire creatorStats REFUS (serveur uniquement)', async () => {
  await expectDenied(setDoc(doc(mod().firestore(), 'creatorStats', 'mod'), creatorStatsDoc()));
  await expectDenied(updateDoc(doc(mod().firestore(), 'creatorStats', 'alice'), { likeCount: 999 }));
  await expectDenied(deleteDoc(doc(mod().firestore(), 'creatorStats', 'alice')));
});
test('S12 Un admin ne peut PAS écrire creatorStats REFUS (serveur uniquement)', async () => {
  await expectDenied(setDoc(doc(admin().firestore(), 'creatorStats', 'admin'), creatorStatsDoc()));
  await expectDenied(updateDoc(doc(admin().firestore(), 'creatorStats', 'alice'), { likeCount: 999 }));
  await expectDenied(deleteDoc(doc(admin().firestore(), 'creatorStats', 'alice')));
});
test('S13 Un document creatorStats NEGATIF est illisible REFUS', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'creatorStats', 'neg'), creatorStatsDoc({ likeCount: -4 }));
  });
  // Un compteur négatif violerait le contrat (compteurs bornés à >= 0) :
  // le document n'est pas exposé en lecture.
  await expectDenied(getDoc(doc(eve().firestore(), 'creatorStats', 'neg')));
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