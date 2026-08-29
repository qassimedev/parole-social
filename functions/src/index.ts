import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
} from 'firebase-functions/v2/firestore';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  FieldValue,
  getFirestore,
  type WriteBatch,
} from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';

// ============================================================
// PAROLE - Cloud Functions (Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6)
//
// Phase 1 : les données sensibles (role, banned, statuts de
// modération, compteurs système, résolutions de signalements,
// auditLogs) ne sont JAMAIS modifiables par un client. Toutes ces
// mutations passent ici, via l'Admin SDK, et sont systématiquement
// tracées dans `auditLogs`.
//
// Phase 2 : `registerUser` centralise la création de compte côté
// serveur — validation des données, limitation de débit contre les
// créations abusives, création de l'utilisateur Auth et du profil
// Firestore conforme aux règles (rôle `user`, non banni, compteurs
// à zéro, champs strictement limités).
//
// Phase 3 : `onLikeCreated` / `onLikeDeleted` maintiennent les
// compteurs de likes (`posts.likeCount` et `users.likeCount` des
// likes reçus) à chaque création/suppression d'un like.
//
// Phase 4 : `onFollowCreated` / `onFollowDeleted` maintiennent les
// compteurs d'abonnements (`users.followingCount` du suiveur et
// `users.followerCount` du suivi) à chaque création/suppression d'un
// follow.
//
// Phase 5 : les notifications sont créées EXCLUSIVEMENT ici
// (`createNotification`), dans onLikeCreated / onCommentCreated /
// onFollowCreated — jamais pour soi-même. Le compteur
// `users.notificationCount` (non lues) est maintenu par
// `onNotificationCreated` (+1), `onNotificationUpdated` (-1
// idempotent au passage non-lue -> lue) et `onNotificationDeleted`
// (-1 défensif).
//
// Phase 6 : `onShareCreated` / `onShareDeleted` maintiennent
// `posts.shareCount` (+1/-1) à chaque création/suppression d'un
// partage (collection `shares`, ID déterministe `{userId}_{postId}`,
// documents immuables). Aucun compteur `users.shareCount`. Une
// notification de type `share` est créée au propriétaire du post
// partagé (jamais pour un self-share).
// ============================================================

initializeApp();

const db = getFirestore();
const adminAuth = getAuth();

const serverTimestamp = () => FieldValue.serverTimestamp();

const VALID_ROLES = ['user', 'moderator', 'admin'] as const;
type Role = (typeof VALID_ROLES)[number];

type AuthContext = { uid: string; role: Role };

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

async function requireRole(
  context: { auth?: { uid: string } },
  roles: Role[]
): Promise<AuthContext> {
  if (!context.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  const uid = context.auth.uid;
  const user = await db.doc(`users/${uid}`).get();
  if (!user.exists) {
    throw new HttpsError('permission-denied', 'User profile not found.');
  }
  const role = user.data()?.role as Role | undefined;
  if (!role || !roles.includes(role)) {
    throw new HttpsError('permission-denied', 'Insufficient permissions.');
  }
  return { uid, role };
}

// Enregistre une action sensible dans auditLogs (append-only).
async function logAudit(
  actor: AuthContext,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>
): Promise<void> {
  await db.collection('auditLogs').add({
    actorId: actor.uid,
    actorRole: actor.role,
    action,
    targetType,
    targetId,
    details,
    createdAt: serverTimestamp(),
  });
}

// Résout l'utilisateur « propriétaire » d'une cible signalée, pour
// maintenir users.reportCount (nombre de signalements REÇUS).
// - post    -> posts/{targetId}.authorId
// - comment -> comments/{targetId}.authorId
// - user    -> users/{targetId} elle-même
// Retourne l'id du propriétaire, ou undefined si la cible n'existe
// pas (défensif : on ne peut pas comptabiliser une cible absente).
async function resolveReportTargetOwner(
  targetType: string,
  targetId: string
): Promise<string | undefined> {
  const ref =
    targetType === 'user'
      ? db.doc(`users/${targetId}`)
      : targetType === 'comment'
        ? db.doc(`comments/${targetId}`)
        : db.doc(`posts/${targetId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return undefined;
  }
  if (targetType === 'user') {
    return targetId;
  }
  const authorId = snap.data()?.authorId as string | undefined;
  return typeof authorId === 'string' && authorId.length > 0 ? authorId : undefined;
}

// Résout les signalements PENDANTS d'une cible (post, comment ou
// user) vers un statut de clôture, avec une résolution traçée.
// Factorisé pour être partagé par moderatePost / moderateComment /
// sanctionUser. Retourne le nombre de signalements résolus.
async function resolveTargetReports(params: {
  targetType: 'post' | 'comment' | 'user';
  targetId: string;
  status: string;
  action: string;
  reason: string;
  moderatorId: string;
  batch: WriteBatch;
}): Promise<number> {
  const pending = await db
    .collection('reports')
    .where('targetType', '==', params.targetType)
    .where('targetId', '==', params.targetId)
    .where('status', '==', 'pending')
    .get();

  let count = 0;
  for (const report of pending.docs) {
    params.batch.update(report.ref, {
      status: params.status,
      resolution: {
        action: params.action,
        reason: params.reason,
        moderatorId: params.moderatorId,
        resolvedAt: serverTimestamp(),
      },
    });
    count += 1;
  }
  return count;
}

// ------------------------------------------------------------
// Notifications (Phase 5)
// Créées exclusivement ici (Admin SDK) — le client ne peut ni les
// créer, ni les supprimer (règles Firestore). Champs STRICTEMENT
// présents à chaque création. Aucune notification à soi-même.
// ------------------------------------------------------------
const NOTIFICATION_TYPES = ['like', 'comment', 'follow', 'share', 'reply'] as const;
type NotificationType = (typeof NOTIFICATION_TYPES)[number];

async function createNotification(params: {
  recipientId: string;
  actorId: string;
  type: NotificationType;
  postId?: string;
  commentId?: string;
}): Promise<void> {
  if (!params.recipientId || !params.actorId) {
    return;
  }
  // Jamais de notification pour une action sur son propre contenu /
  // son propre profil.
  if (params.actorId === params.recipientId) {
    return;
  }
  await db.collection('notifications').add({
    recipientId: params.recipientId,
    actorId: params.actorId,
    type: params.type,
    postId: params.postId ?? '',
    commentId: params.commentId ?? '',
    read: false,
    readAt: null,
    createdAt: serverTimestamp(),
  });
}

// ------------------------------------------------------------
// Inscription (Phase 2)
// Validation serveur + limitation de débit contre les créations
// abusives. Crée l'utilisateur Auth puis son profil Firestore avec
// EXACTEMENT les champs autorisés par les règles (rôle 'user',
// non banni, compteurs à zéro). La vérification email est envoyée
// côté client après la connexion (sendEmailVerification).
// ------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function isValidPassword(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    password.length <= 128 &&
    /[a-zA-Z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

function isValidDisplayName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 50;
}

// Limiteur de débit en mémoire (fenêtre glissante).
// En production, ce dispositif doit être renforcé (quotas distribués
// / CAPTCHA) — ici il protège déjà contre les créations abusives.
class RateLimiter {
  private hits = new Map<string, number[]>();

  check(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

const registerLimiter = new RateLimiter();

const REGISTER_LIMITS = {
  perEmail: { max: 5, windowMs: 60 * 60 * 1000 },
  perIp: { max: 20, windowMs: 60 * 60 * 1000 },
} as const;

export const registerUser = onCall(
  { cors: true },
  async (request) => {
    const data = (request.data ?? {}) as {
      email?: unknown;
      password?: unknown;
      displayName?: unknown;
    };

    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    const password = data.password;
    const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';

    if (!isValidEmail(email)) {
      throw new HttpsError('invalid-argument', 'Adresse email invalide.');
    }
    if (!isValidPassword(password)) {
      throw new HttpsError(
        'invalid-argument',
        'Le mot de passe doit contenir au moins 8 caractères, une lettre et un chiffre.'
      );
    }
    if (!isValidDisplayName(displayName)) {
      throw new HttpsError('invalid-argument', 'Le nom affiché doit contenir entre 1 et 50 caractères.');
    }

    // Protection contre les créations abusives.
    const ip = (request.rawRequest?.ip as string | undefined) ?? 'unknown';
    if (!registerLimiter.check(`email:${email}`, REGISTER_LIMITS.perEmail.max, REGISTER_LIMITS.perEmail.windowMs)) {
      throw new HttpsError(
        'resource-exhausted',
        'Trop d’inscriptions pour cette adresse. Réessayez plus tard.'
      );
    }
    if (!registerLimiter.check(`ip:${ip}`, REGISTER_LIMITS.perIp.max, REGISTER_LIMITS.perIp.windowMs)) {
      throw new HttpsError(
        'resource-exhausted',
        'Trop d’inscriptions depuis cette adresse IP. Réessayez plus tard.'
      );
    }

    let userRecord;
    try {
      userRecord = await adminAuth.createUser({
        email,
        password,
        displayName,
        emailVerified: false,
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'auth/email-already-exists') {
        throw new HttpsError('already-exists', 'Cette adresse email est déjà utilisée.');
      }
      throw new HttpsError('internal', 'Échec de la création du compte.');
    }

    // Profil conforme aux règles Firestore (hasOnly exact).
    await db.doc(`users/${userRecord.uid}`).set({
      uid: userRecord.uid,
      displayName,
      bio: '',
      avatarPath: '',
      role: 'user',
      banned: false,
      moderationStatus: 'none',
      postCount: 0,
      reportCount: 0,
      likeCount: 0,
      followerCount: 0,
      followingCount: 0,
      notificationCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    logger.info(`User registered: ${email} (${userRecord.uid})`);
    return { uid: userRecord.uid, email };
  }
);

// ------------------------------------------------------------
// Modération des publications
// Actions : mask, restore, maintain, remove.
// Met à jour le post, résout les signalements pendants, met à
// jour la file de modération et trace tout dans auditLogs.
// ------------------------------------------------------------

const POST_STATUS_BY_ACTION: Record<string, string> = {
  mask: 'hidden',
  restore: 'visible',
  maintain: 'visible',
  remove: 'removed',
};

const QUEUE_STATUS_BY_ACTION: Record<string, string> = {
  mask: 'resolved',
  restore: 'dismissed',
  maintain: 'dismissed',
  remove: 'resolved',
};

export const moderatePost = onCall(
  { cors: true },
  async (request) => {
    const actor = await requireRole(request, ['moderator', 'admin']);
    const data = (request.data ?? {}) as {
      postId?: unknown;
      action?: unknown;
      reason?: unknown;
    };

    if (typeof data.postId !== 'string' || data.postId.length === 0) {
      throw new HttpsError('invalid-argument', 'postId is required.');
    }
    if (typeof data.action !== 'string' || !(data.action in POST_STATUS_BY_ACTION)) {
      throw new HttpsError('invalid-argument', `Unknown moderation action: ${String(data.action)}`);
    }

    const postId = data.postId;
    const action = data.action;
    const reason = typeof data.reason === 'string' ? data.reason : '';

    const postRef = db.doc(`posts/${postId}`);
    const post = await postRef.get();
    if (!post.exists) {
      throw new HttpsError('not-found', 'Post not found.');
    }

    const moderationStatus = POST_STATUS_BY_ACTION[action];

    const batch = db.batch();
    batch.update(postRef, {
      moderationStatus,
      moderationReason: reason.trim() ? reason.trim() : null,
      moderatorId: actor.uid,
      moderatedAt: serverTimestamp(),
    });

    // Résolution des signalements pendants liés à ce post.
    const queueStatus = QUEUE_STATUS_BY_ACTION[action];
    await resolveTargetReports({
      targetType: 'post',
      targetId: postId,
      status: queueStatus,
      action,
      reason,
      moderatorId: actor.uid,
      batch,
    });

    // Mise à jour de la file de modération.
    const queueRef = db.doc(`moderationQueue/post_${postId}`);
    const queueSnap = await queueRef.get();
    if (queueSnap.exists) {
      batch.update(queueRef, {
        status: queueStatus,
        resolution: {
          action,
          reason,
          moderatorId: actor.uid,
          resolvedAt: serverTimestamp(),
        },
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();

    await logAudit(actor, `post.${action}`, 'post', postId, { reason });

    logger.info(`Post ${postId} moderated (${action}) by ${actor.uid}`);
    return { ok: true, postId, moderationStatus };
  }
);

// ------------------------------------------------------------
// Modération des commentaires
// Actions : mask, restore, maintain, remove.
// Met à jour le commentaire, résout les signalements pendants, met
// à jour la file de modération et trace tout dans auditLogs.
// NB : la règle de lecture des commentaires ne filtre pas
// `moderationStatus` (lire tout) ; « masquer » enregistre donc la
// décision et clôt les signalements sans retirer le commentaire de
// la lecture (risque résiduel documenté).
// ------------------------------------------------------------

const COMMENT_STATUS_BY_ACTION: Record<string, string> = {
  mask: 'hidden',
  restore: 'visible',
  maintain: 'visible',
  remove: 'removed',
};

export const moderateComment = onCall(
  { cors: true },
  async (request) => {
    const actor = await requireRole(request, ['moderator', 'admin']);
    const data = (request.data ?? {}) as {
      commentId?: unknown;
      action?: unknown;
      reason?: unknown;
    };

    if (typeof data.commentId !== 'string' || data.commentId.length === 0) {
      throw new HttpsError('invalid-argument', 'commentId is required.');
    }
    if (typeof data.action !== 'string' || !(data.action in COMMENT_STATUS_BY_ACTION)) {
      throw new HttpsError('invalid-argument', `Unknown moderation action: ${String(data.action)}`);
    }

    const commentId = data.commentId;
    const action = data.action;
    const reason = typeof data.reason === 'string' ? data.reason : '';

    const commentRef = db.doc(`comments/${commentId}`);
    const comment = await commentRef.get();
    if (!comment.exists) {
      throw new HttpsError('not-found', 'Comment not found.');
    }

    const moderationStatus = COMMENT_STATUS_BY_ACTION[action];

    const batch = db.batch();
    batch.update(commentRef, {
      moderationStatus,
      moderationReason: reason.trim() ? reason.trim() : null,
      moderatorId: actor.uid,
      moderatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // Résolution des signalements pendants liés à ce commentaire.
    const queueStatus = QUEUE_STATUS_BY_ACTION[action];
    await resolveTargetReports({
      targetType: 'comment',
      targetId: commentId,
      status: queueStatus,
      action,
      reason,
      moderatorId: actor.uid,
      batch,
    });

    // Mise à jour de la file de modération.
    const queueRef = db.doc(`moderationQueue/comment_${commentId}`);
    const queueSnap = await queueRef.get();
    if (queueSnap.exists) {
      batch.update(queueRef, {
        status: queueStatus,
        resolution: {
          action,
          reason,
          moderatorId: actor.uid,
          resolvedAt: serverTimestamp(),
        },
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();

    await logAudit(actor, `comment.${action}`, 'comment', commentId, { reason });

    logger.info(`Comment ${commentId} moderated (${action}) by ${actor.uid}`);
    return { ok: true, commentId, moderationStatus };
  }
);

// ------------------------------------------------------------
// Sanctions utilisateur
// Actions : warn (modérateur+admin), ban/unban/setRole (admin).
// Trace toutes les décisions dans auditLogs.
// ------------------------------------------------------------

const SANCTION_ACTIONS = ['warn', 'ban', 'unban', 'setRole'] as const;
type SanctionAction = (typeof SANCTION_ACTIONS)[number];

export const sanctionUser = onCall(
  { cors: true },
  async (request) => {
    const data = (request.data ?? {}) as {
      userId?: unknown;
      action?: unknown;
      reason?: unknown;
      role?: unknown;
    };

    if (typeof data.userId !== 'string' || data.userId.length === 0) {
      throw new HttpsError('invalid-argument', 'userId is required.');
    }
    if (typeof data.action !== 'string' || !SANCTION_ACTIONS.includes(data.action as SanctionAction)) {
      throw new HttpsError('invalid-argument', `Unknown sanction action: ${String(data.action)}`);
    }

    const userId = data.userId;
    const action = data.action as SanctionAction;
    const reason = typeof data.reason === 'string' ? data.reason : '';

    // warn : modérateur + admin. ban/unban/setRole : admin uniquement.
    const requiredRoles: Role[] = action === 'warn' ? ['moderator', 'admin'] : ['admin'];
    const actor = await requireRole(request, requiredRoles);

    const userRef = db.doc(`users/${userId}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'User not found.');
    }

    switch (action) {
      case 'setRole': {
        if (typeof data.role !== 'string' || !VALID_ROLES.includes(data.role as Role)) {
          throw new HttpsError('invalid-argument', 'Invalid role.');
        }
        await userRef.update({ role: data.role, updatedAt: serverTimestamp() });
        break;
      }
      case 'ban':
        await userRef.update({
          banned: true,
          moderationStatus: 'suspended',
          bannedUntil: null,
          updatedAt: serverTimestamp(),
        });
        break;
      case 'unban':
        await userRef.update({
          banned: false,
          moderationStatus: 'none',
          bannedUntil: null,
          updatedAt: serverTimestamp(),
        });
        break;
      case 'warn':
        await userRef.update({ moderationStatus: 'warned', updatedAt: serverTimestamp() });
        break;
    }

    // Avertir ou bannir : on résout aussi les signalements utilisateur
    // pendants contre cette cible et on clôt sa file de modération
    // (le signalement DÉCISIF justifie la sanction). setRole/unban ne
    // clôturent pas : ils sont mécaniques, sans lien avec les
    // signalements en cours.
    if (action === 'warn' || action === 'ban') {
      const batch = db.batch();
      await resolveTargetReports({
        targetType: 'user',
        targetId: userId,
        status: 'resolved',
        action,
        reason,
        moderatorId: actor.uid,
        batch,
      });
      const queueRef = db.doc(`moderationQueue/user_${userId}`);
      const queueSnap = await queueRef.get();
      if (queueSnap.exists) {
        batch.update(queueRef, {
          status: 'resolved',
          resolution: {
            action,
            reason,
            moderatorId: actor.uid,
            resolvedAt: serverTimestamp(),
          },
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }

    await logAudit(actor, `user.${action}`, 'user', userId, {
      reason,
      ...(action === 'setRole' ? { role: data.role } : {}),
    });

    logger.info(`User ${userId} sanctioned (${action}) by ${actor.uid}`);
    return { ok: true, userId, action };
  }
);

// ------------------------------------------------------------
// Compteurs système (déclencheurs Firestore)
// ------------------------------------------------------------

// Un signalement créé incrémente post.reportCount et alimente la
// file de modération. Jamais de suppression automatique.
export const onReportCreated = onDocumentCreated('reports/{reportId}', async (event) => {
  const data = event.data?.data();
  if (!data) {
    return;
  }
  const targetType = data.targetType as string;
  const targetId = data.targetId as string;
  const reporterId = data.reporterId as string;
  const reason = typeof data.reason === 'string' ? data.reason : '';

  // Compteurs « signalements reçus » :
  // - post    -> posts/{targetId}.reportCount
  // - comment -> users/{auteur du commentaire}.reportCount
  // - user    -> users/{targetId}.reportCount
  // users.reportCount est NULL si l'auteur de la cible n'existe pas
  // (défensif : plus de « compteur mort » — il est désormais
  // maintenu par trigger et calculé sur le propriétaire de la cible).
  if (targetType === 'post') {
    try {
      await db.doc(`posts/${targetId}`).update({ reportCount: FieldValue.increment(1) });
    } catch (err) {
      logger.warn(`onReportCreated: post ${targetId} not found (${(err as Error).message})`);
    }
  } else {
    const ownerId = await resolveReportTargetOwner(targetType, targetId);
    if (ownerId) {
      await db.doc(`users/${ownerId}`).update({ reportCount: FieldValue.increment(1) });
    }
  }

  const queueRef = db.doc(`moderationQueue/${targetType}_${targetId}`);
  const queueSnap = await queueRef.get();

  if (queueSnap.exists) {
    let nextStatus = queueSnap.data()?.status as string;
    // Un signalement sur une affaire déjà close la rouvre.
    if (nextStatus === 'resolved' || nextStatus === 'dismissed') {
      nextStatus = 'reviewing';
    }
    await queueRef.update({
      reportCount: FieldValue.increment(1),
      status: nextStatus,
      lastReporterId: reporterId,
      updatedAt: serverTimestamp(),
    });
  } else {
    await queueRef.set({
      targetType,
      targetId,
      status: 'pending',
      reportCount: 1,
      firstReporterId: reporterId,
      lastReporterId: reporterId,
      reason,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  logger.info(`Report registered on ${targetType} ${targetId} by ${reporterId}`);
});

// Décrément DÉFENSIF du compteur « signalements reçus » au retrait
// d'un signalement (le client ne peut pas supprimer un signalement,
// mais le serveur reste robuste — par ex. un nettoyage manuel).
// Un signalement supprimé = un décrément. Pour post, posts.reportCount ;
// pour comment/user, users.reportCount de l'auteur résolu.
// Les compteurs ne passent pas en dessous de 0 (borné).
export const onReportDeleted = onDocumentDeleted('reports/{reportId}', async (event) => {
  const data = event.data?.data();
  const targetType = data?.targetType as string | undefined;
  const targetId = data?.targetId as string | undefined;
  if (!targetType || !targetId) {
    return;
  }

  const decr = { reportCount: FieldValue.increment(-1) };

  if (targetType === 'post') {
    const postSnap = await db.doc(`posts/${targetId}`).get();
    if (!postSnap.exists) {
      return;
    }
    const current = postSnap.data()?.reportCount as number | undefined;
    if (typeof current === 'number' && current > 0) {
      await postSnap.ref.update(decr);
    }
    return;
  }

  const ownerId = await resolveReportTargetOwner(targetType, targetId);
  if (!ownerId) {
    return;
  }
  const ownerSnap = await db.doc(`users/${ownerId}`).get();
  if (!ownerSnap.exists) {
    return;
  }
  const current = ownerSnap.data()?.reportCount as number | undefined;
  if (typeof current === 'number' && current > 0) {
    await ownerSnap.ref.update(decr);
  }
});

export const onCommentCreated = onDocumentCreated('comments/{commentId}', async (event) => {
  const data = event.data?.data();
  const postId = data?.postId as string | undefined;
  const authorId = data?.authorId as string | undefined;
  const replyToId = data?.replyToId as string | undefined;
  const commentId = event.params.commentId;

  if (postId) {
    await db.doc(`posts/${postId}`).update({ commentCount: FieldValue.increment(1) });
  }

  // Notification au propriétaire du post (jamais pour un self-comment).
  if (postId && authorId) {
    const postSnap = await db.doc(`posts/${postId}`).get();
    if (postSnap.exists) {
      const postAuthor = postSnap.data()?.authorId as string | undefined;
      if (postAuthor && postAuthor !== authorId) {
        await createNotification({
          recipientId: postAuthor,
          actorId: authorId,
          type: 'comment',
          postId,
          commentId,
        });
      }
    }
  }

  // Notification de RÉPONSE : si le commentaire répond à un
  // commentaire parent (replyToId non vide), on notifie l'auteur du
  // commentaire parent (jamais pour un self-reply et jamais si c'est
  // déjà le propriétaire du post déjà notifié ci-dessus — on évite
  // ainsi une notification dupliquée au même destinataire).
  if (authorId && replyToId && replyToId.length > 0) {
    const parentSnap = await db.doc(`comments/${replyToId}`).get();
    if (parentSnap.exists) {
      const parentAuthor = parentSnap.data()?.authorId as string | undefined;
      const postSnap = postId ? await db.doc(`posts/${postId}`).get() : null;
      const postAuthor = postSnap?.exists ? (postSnap.data()?.authorId as string | undefined) : undefined;
      if (parentAuthor && parentAuthor !== authorId && parentAuthor !== postAuthor) {
        await createNotification({
          recipientId: parentAuthor,
          actorId: authorId,
          type: 'reply',
          postId,
          commentId,
        });
      }
    }
  }
});

export const onCommentDeleted = onDocumentDeleted('comments/{commentId}', async (event) => {
  const postId = event.data?.data()?.postId as string | undefined;
  if (postId) {
    await db.doc(`posts/${postId}`).update({ commentCount: FieldValue.increment(-1) });
  }
});

// ------------------------------------------------------------
// Compteurs de likes
// onLikeCreated  : +1 posts/{postId}.likeCount et +1
//                  users/{auteur}.likeCount (likes reçus).
// onLikeDeleted  : décréments symétriques.
// Le client ne peut JAMAIS écrire ces compteurs : seule l'existence
// du like (création/suppression, encadrée par les règles Firestore)
// déclenche la mise à jour via l'Admin SDK. Si l'auteur du post n'a
// pas de profil, on met simplement à jour le post (défensif).
// ------------------------------------------------------------
export const onLikeCreated = onDocumentCreated('likes/{likeId}', async (event) => {
  const data = event.data?.data();
  const postId = data?.postId as string | undefined;
  const likerId = data?.userId as string | undefined;
  if (!postId) {
    return;
  }

  const postSnap = await db.doc(`posts/${postId}`).get();
  if (!postSnap.exists) {
    return;
  }
  const authorId = postSnap.data()?.authorId as string | undefined;

  const batch = db.batch();
  batch.update(postSnap.ref, { likeCount: FieldValue.increment(1) });

  if (authorId) {
    const userSnap = await db.doc(`users/${authorId}`).get();
    if (userSnap.exists) {
      batch.update(userSnap.ref, { likeCount: FieldValue.increment(1) });
    }
  }

  await batch.commit();

  // Notification au propriétaire du post (jamais pour un self-like).
  if (authorId && likerId) {
    await createNotification({ recipientId: authorId, actorId: likerId, type: 'like', postId });
  }
  logger.info(`Like registered on post ${postId}`);
});

export const onLikeDeleted = onDocumentDeleted('likes/{likeId}', async (event) => {
  const postId = event.data?.data()?.postId as string | undefined;
  if (!postId) {
    return;
  }

  const postSnap = await db.doc(`posts/${postId}`).get();
  if (!postSnap.exists) {
    return;
  }
  const authorId = postSnap.data()?.authorId as string | undefined;

  const batch = db.batch();
  batch.update(postSnap.ref, { likeCount: FieldValue.increment(-1) });

  if (authorId) {
    const userSnap = await db.doc(`users/${authorId}`).get();
    if (userSnap.exists) {
      batch.update(userSnap.ref, { likeCount: FieldValue.increment(-1) });
    }
  }

  await batch.commit();
  logger.info(`Like removed from post ${postId}`);
});

// ------------------------------------------------------------
// Compteurs de partages (Phase 6)
// onShareCreated  : +1 posts/{postId}.shareCount et notification
//                   « share » au propriétaire du post partagé
//                   (jamais pour un self-share — createNotification
//                   refuse déjà actorId == recipientId).
// onShareDeleted  : -1 posts/{postId}.shareCount.
// Le client ne peut JAMAIS écrire ce compteur : seule l'existence
// du partage (création/suppression, encadrée par les règles Firestore
// — ID déterministe, document immuable, cible lisible, canAct())
// déclenche la mise à jour via l'Admin SDK. Aucun compteur
// users.shareCount.
// ------------------------------------------------------------
export const onShareCreated = onDocumentCreated('shares/{shareId}', async (event) => {
  const data = event.data?.data();
  const postId = data?.postId as string | undefined;
  const sharerId = data?.userId as string | undefined;
  if (!postId) {
    return;
  }

  const postSnap = await db.doc(`posts/${postId}`).get();
  if (!postSnap.exists) {
    return;
  }
  await postSnap.ref.update({ shareCount: FieldValue.increment(1) });

  // Notification au propriétaire du post (jamais pour un self-share).
  const authorId = postSnap.data()?.authorId as string | undefined;
  if (authorId && sharerId) {
    await createNotification({ recipientId: authorId, actorId: sharerId, type: 'share', postId });
  }
  logger.info(`Share registered on post ${postId}`);
});

export const onShareDeleted = onDocumentDeleted('shares/{shareId}', async (event) => {
  const postId = event.data?.data()?.postId as string | undefined;
  if (!postId) {
    return;
  }
  const postSnap = await db.doc(`posts/${postId}`).get();
  if (!postSnap.exists) {
    return;
  }
  await postSnap.ref.update({ shareCount: FieldValue.increment(-1) });
  logger.info(`Share removed from post ${postId}`);
});

// ------------------------------------------------------------
// Compteurs d'abonnements (Phase 4)
// onFollowCreated : +1 users/{suiveur}.followingCount et +1
//                   users/{suivi}.followerCount.
// onFollowDeleted : décréments symétriques.
// Le client ne peut JAMAIS écrire ces compteurs : seule l'existence
// du follow (création/suppression, encadrée par les règles Firestore
// — ID déterministe, immuable, pas de self-follow) déclenche la mise
// à jour via l'Admin SDK. Si un profil manque, on met simplement à
// jour l'autre (défensif).
// ------------------------------------------------------------
export const onFollowCreated = onDocumentCreated('follows/{followId}', async (event) => {
  const data = event.data?.data();
  const followerId = data?.followerId as string | undefined;
  const followingId = data?.followingId as string | undefined;
  if (!followerId || !followingId) {
    return;
  }

  const batch = db.batch();
  let dirty = false;

  const followerSnap = await db.doc(`users/${followerId}`).get();
  if (followerSnap.exists) {
    batch.update(followerSnap.ref, { followingCount: FieldValue.increment(1) });
    dirty = true;
  }

  const followingSnap = await db.doc(`users/${followingId}`).get();
  if (followingSnap.exists) {
    batch.update(followingSnap.ref, { followerCount: FieldValue.increment(1) });
    dirty = true;
  }

  if (dirty) {
    await batch.commit();
  }

  // Notification « X vous suit ». Le self-follow est déjà interdit
  // par les règles ; on reste défensif.
  if (followerId !== followingId) {
    await createNotification({ recipientId: followingId, actorId: followerId, type: 'follow' });
  }
  logger.info(`Follow registered: ${followerId} -> ${followingId}`);
});

export const onFollowDeleted = onDocumentDeleted('follows/{followId}', async (event) => {
  const data = event.data?.data();
  const followerId = data?.followerId as string | undefined;
  const followingId = data?.followingId as string | undefined;
  if (!followerId || !followingId) {
    return;
  }

  const batch = db.batch();
  let dirty = false;

  const followerSnap = await db.doc(`users/${followerId}`).get();
  if (followerSnap.exists) {
    batch.update(followerSnap.ref, { followingCount: FieldValue.increment(-1) });
    dirty = true;
  }

  const followingSnap = await db.doc(`users/${followingId}`).get();
  if (followingSnap.exists) {
    batch.update(followingSnap.ref, { followerCount: FieldValue.increment(-1) });
    dirty = true;
  }

  if (dirty) {
    await batch.commit();
  }
  logger.info(`Follow removed: ${followerId} -> ${followingId}`);
});

// ------------------------------------------------------------
// Notifications (Phase 5) — compteur users.notificationCount
// Maintenu EXCLUSIVEMENT ici (Admin SDK). Le client ne peut jamais
// le modifier (règles Firestore). Tous les trigger sont défensifs :
// - onNotificationCreated  : +1 à la création d'une notification
//                            non lue pour le destinataire.
// - onNotificationUpdated  : -1 au passage EXACT non lue -> lue
//                            (idempotent : une notification déjà
//                            lue ne redécrémente jamais).
// - onNotificationDeleted  : -1 défensif si une notification NON
//                            lue est supprimée (le client ne peut
//                            pas supprimer, mais le serveur reste
//                            robuste). Les compteurs négatifs sont
//                            évités (borné à >= 0).
// ------------------------------------------------------------
export const onNotificationCreated = onDocumentCreated(
  'notifications/{notificationId}',
  async (event) => {
    const data = event.data?.data();
    const recipientId = data?.recipientId as string | undefined;
    const isRead = data?.read === true;
    if (!recipientId || isRead) {
      return;
    }
    const recipientSnap = await db.doc(`users/${recipientId}`).get();
    if (!recipientSnap.exists) {
      return;
    }
    await recipientSnap.ref.update({ notificationCount: FieldValue.increment(1) });
    logger.info(`Notification unread created for user ${recipientId}`);
  }
);

export const onNotificationUpdated = onDocumentUpdated(
  'notifications/{notificationId}',
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const recipientId = after?.recipientId as string | undefined;
    if (!recipientId) {
      return;
    }
    // Décrément EXACTEMENT unitaire : uniquement au passage
    // non lue -> lue. Une notification déjà lue avant/après ne
    // provoque jamais de nouveau décrément (idempotence).
    if (before?.read === false && after?.read === true) {
      const recipientSnap = await db.doc(`users/${recipientId}`).get();
      if (!recipientSnap.exists) {
        return;
      }
      const current = recipientSnap.data()?.notificationCount as number | undefined;
      // Borné à >= 0 : défense contre une éventuelle dérive.
      if (typeof current === 'number' && current > 0) {
        await recipientSnap.ref.update({ notificationCount: FieldValue.increment(-1) });
        logger.info(`Notification marked read by user ${recipientId}`);
      }
    }
  }
);

export const onNotificationDeleted = onDocumentDeleted(
  'notifications/{notificationId}',
  async (event) => {
    const data = event.data?.data();
    const recipientId = data?.recipientId as string | undefined;
    const wasUnread = data?.read === false;
    if (!recipientId || !wasUnread) {
      return;
    }
    const recipientSnap = await db.doc(`users/${recipientId}`).get();
    if (!recipientSnap.exists) {
      return;
    }
    const current = recipientSnap.data()?.notificationCount as number | undefined;
    if (typeof current === 'number' && current > 0) {
      await recipientSnap.ref.update({ notificationCount: FieldValue.increment(-1) });
      logger.info(`Unread notification deleted for user ${recipientId}`);
    }
  }
);

// ------------------------------------------------------------
// Santé du service
// ------------------------------------------------------------

export const healthcheck = onRequest({ cors: true }, (_req, res) => {
  logger.info('PAROLE healthcheck called');
  res.status(200).json({ status: 'ok', service: 'parole-functions', version: '0.2.0' });
});