// ============================================================
// PAROLE - Profil public d'un utilisateur (Phase 4 : Follow)
//
// Route `#/u/{userId}` : affiche le profil d'un autre utilisateur
// (nom, avatar, bio, compteurs d'abonnements) avec un bouton
// Suivre / Ne plus suivre. Un profil public n'est lisible que par un
// utilisateur connecté (règle users). L'état du bouton est optimiste
// (comme le like) ; les compteurs users.followerCount /
// users.followingCount restent strictement sous contrôle des Cloud
// Functions.
// ============================================================

import { getFirestoreInstance } from '../lib/firebase';
import { doc, getDoc, type DocumentData } from 'firebase/firestore';
import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import { getAvatarUrl } from '../lib/profile';
import { fetchPostsByAuthor, linkifyHashtags, type Post } from '../lib/posts';
import { isFollowing, toggleFollow } from '../lib/follows';
import { blockUser, isUserBlocked, unblockUser } from '../lib/blocks';
import { buildConversationId } from '../lib/messages';
import type { UserProfile } from '../lib/store';
import {
  appShell,
  avatarMarkup,
  escapeHtml,
  isModeratorRole,
  type ViewContext,
} from './layout';

const db = getFirestoreInstance();

const ROLE_LABELS: Record<string, string> = {
  user: 'Utilisateur',
  moderator: 'Modérateur',
  admin: 'Administrateur',
};

function snapshotToProfile(data: DocumentData): UserProfile {
  return {
    uid: data.uid,
    displayName: data.displayName ?? '',
    bio: data.bio ?? '',
    avatarPath: data.avatarPath ?? '',
    role: data.role ?? 'user',
    banned: data.banned ?? false,
    bannedUntil: data.bannedUntil?.toDate?.() ?? null,
    moderationStatus: data.moderationStatus ?? 'none',
    postCount: data.postCount ?? 0,
    reportCount: data.reportCount ?? 0,
    likeCount: data.likeCount ?? 0,
    followerCount: typeof data.followerCount === 'number' ? data.followerCount : 0,
    followingCount: typeof data.followingCount === 'number' ? data.followingCount : 0,
    notificationCount: typeof data.notificationCount === 'number' ? data.notificationCount : 0,
    messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
    createdAt: data.createdAt?.toDate?.() ?? new Date(),
    updatedAt: data.updatedAt?.toDate?.() ?? new Date(),
  };
}

function postMarkup(post: Post): string {
  const date =
    post.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';
  const shareCount = Number(post.shareCount) || 0;
  return `
    <article class="post-card post-card--compact">
      <p class="post-card__content">${linkifyHashtags(escapeHtml(post.content))}</p>
      <span class="post-card__date muted">${escapeHtml(date)}</span>
      ${shareCount > 0 ? `<span class="post-card__shares muted">${shareCount} partage${shareCount > 1 ? 's' : ''}</span>` : ''}
    </article>
  `;
}

function postsMarkup(posts: Post[]): string {
  if (posts.length === 0) {
    return `<div class="muted">Aucune publication visible pour le moment.</div>`;
  }
  return posts.map(postMarkup).join('\n');
}

export function renderUser(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const userId = ctx.route.params.get('userId') ?? '';
  if (!userId) {
    return appShell(`
      <section class="card">
        <h2 class="card__title">Profil introuvable</h2>
        <p class="muted">Utilisateur non spécifié.</p>
      </section>
    `, 'user', isModeratorRole(session.profile?.role), session.profile?.notificationCount ?? 0, session.profile?.messageCount ?? 0);
  }
  const inner = `
    <section class="card">
      <div id="user-page-alerts"></div>
      <div id="user-page">
        <div class="muted">Chargement du profil…</div>
      </div>
    </section>
  `;
  return appShell(inner, 'user', isModeratorRole(session.profile?.role), session.profile?.notificationCount ?? 0, session.profile?.messageCount ?? 0);
}

export function mountUser(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const uid = session.uid;
  if (!uid) return;
  const userId = ctx.route.params.get('userId') ?? '';
  const alerts = root.querySelector<HTMLDivElement>('#user-page-alerts');
  const container = root.querySelector<HTMLDivElement>('#user-page');
  if (!alerts || !container) return;

  const renderError = (message: string): void => {
    container.innerHTML = `
      <div class="alert alert--error" role="alert">${escapeHtml(message)}</div>
      <div class="actions">
        <button type="button" id="user-retry" class="btn btn--ghost btn--sm">
          <span class="btn__label">Réessayer</span>
        </button>
      </div>
    `;
    container.querySelector<HTMLButtonElement>('#user-retry')?.addEventListener('click', () => {
      void load();
    });
  };

  const load = async (): Promise<void> => {
    if (!userId) {
      renderError('Utilisateur non spécifié.');
      return;
    }
    container.innerHTML = `<div class="muted">Chargement du profil…</div>`;
    if (alerts) alerts.innerHTML = '';

    try {
      const snap = await getDoc(doc(db, 'users', userId));
      if (!snap.exists()) {
        container.innerHTML = `
          <h2 class="card__title">Profil introuvable</h2>
          <p class="muted">Cet utilisateur n'existe pas ou son profil est inaccessible.</p>
        `;
        return;
      }

      const profile = snapshotToProfile(snap.data());
      const isSelf = profile.uid === uid;
      const followState = isSelf ? false : await isFollowing(uid, profile.uid);
      const blockedState = isSelf ? false : await isUserBlocked(uid, profile.uid);

      let avatarUrl: string | null = null;
      if (profile.avatarPath) {
        try {
          avatarUrl = await getAvatarUrl(profile.avatarPath);
        } catch {
          avatarUrl = null;
        }
      }

      const roleLabel = ROLE_LABELS[profile.role] ?? profile.role;
      const memberSince = profile.createdAt?.toLocaleDateString('fr-FR') ?? '—';

      const followButton = isSelf
        ? `<p class="muted small">C'est votre profil. <a href="#/profile">Modifier mes informations</a>.</p>`
        : `
      <button type="button" id="user-follow" class="btn btn--primary follow-toggle"
        data-following="${followState ? 'true' : 'false'}"
        data-user-id="${escapeHtml(profile.uid)}"
        aria-pressed="${followState ? 'true' : 'false'}">
        <span class="btn__label">${followState ? 'Ne plus suivre' : 'Suivre'}</span>
      </button>
    `;

      const blockButton = isSelf
        ? ``
        : `
      <button type="button" id="user-block" class="btn ${blockedState ? 'btn--ghost' : 'btn--danger'}"
        data-blocked="${blockedState ? 'true' : 'false'}"
        data-user-id="${escapeHtml(profile.uid)}"
        aria-pressed="${blockedState ? 'true' : 'false'}">
        <span class="btn__label">${blockedState ? 'Débloquer' : 'Bloquer'}</span>
      </button>
    `;

      // Messagerie (Lot 3) : bouton « Envoyer un message » vers la
      // conversation déterministe. Masqué si je bloque/débloque cette
      // personne : le blocage est bidirectionnel côté règles, l'envoi
      // serait refusé. (Si c'EST l'autre qui me bloque, je ne peux pas
      // le savoir — la règle refuse l'envoi ; l'historique reste lisible.)
      const messageButton = isSelf
        ? ``
        : blockedState
          ? `<p class="muted small">Messagerie désactivée : un blocage est en place.</p>`
          : `
      <button type="button" id="user-message" class="btn btn--ghost"
        data-user-id="${escapeHtml(profile.uid)}">
        <span class="btn__label">Envoyer un message</span>
      </button>
    `;

      container.innerHTML = `
        <div class="profile-header">
          <div id="user-avatar-slot">${avatarMarkup(avatarUrl, profile.displayName, 'lg')}</div>
          <div class="profile-header__meta">
            <h2 class="card__title">${escapeHtml(profile.displayName)}</h2>
            <div class="badges">
              <span class="badge">${escapeHtml(roleLabel)}</span>
            </div>
          </div>
        </div>
        <p class="profile-bio">${profile.bio ? escapeHtml(profile.bio) : '<span class="muted">Aucune bio pour le moment.</span>'}</p>
        <dl class="info-list">
          <dt>Membre depuis</dt><dd>${escapeHtml(memberSince)}</dd>
          <dt>Abonnements</dt><dd id="user-following-count">${Number(profile.followingCount) || 0}</dd>
          <dt>Abonnés</dt><dd id="user-follower-count">${Number(profile.followerCount) || 0}</dd>
        </dl>
        <div class="actions">${followButton}${blockButton}${messageButton}</div>
        <h3 class="card__title card__title--sm">Publications récentes</h3>
        <div class="post-feed" id="user-posts">
          <div class="muted">Chargement des publications…</div>
        </div>
      `;

      // Publications récentes (lisible / filtrées côté client).
      const postsEl = container.querySelector<HTMLDivElement>('#user-posts');
      try {
        const posts = await fetchPostsByAuthor(profile.uid);
        if (postsEl) postsEl.innerHTML = postsMarkup(posts);
      } catch {
        if (postsEl) postsEl.innerHTML = `<div class="muted">Publications indisponibles.</div>`;
      }

      // Bouton Suivre (état optimiste — les règles restent l'autorité).
      const followBtn = container.querySelector<HTMLButtonElement>('#user-follow');
      const followerCountEl = container.querySelector<HTMLElement>('#user-follower-count');
      if (followBtn && !isSelf && alerts) {
        const setFollowing = (following: boolean): void => {
          followBtn.dataset.following = String(following);
          followBtn.setAttribute('aria-pressed', String(following));
          followBtn.classList.toggle('follow-toggle--active', following);
          const label = followBtn.querySelector('.btn__label');
          if (label) label.textContent = following ? 'Ne plus suivre' : 'Suivre';
        };

        followBtn.addEventListener('click', async () => {
          if (followBtn.disabled) return;
          followBtn.disabled = true;
          const wasFollowing = followBtn.dataset.following === 'true';
          const nextFollowing = !wasFollowing;
          const currentCount = followerCountEl ? Number(followerCountEl.textContent ?? '0') : 0;

          setFollowing(nextFollowing);
          if (followerCountEl) {
            followerCountEl.textContent = String(Math.max(0, currentCount + (nextFollowing ? 1 : -1)));
          }

          try {
            await toggleFollow(uid, profile.uid);
          } catch (err) {
            setFollowing(wasFollowing);
            if (followerCountEl) followerCountEl.textContent = String(currentCount);
            alerts.innerHTML = `<div class="alert alert--error" role="alert">${escapeHtml(describeError(err))}</div>`;
          } finally {
            followBtn.disabled = false;
          }
        });
      }

      // Bouton Bloquer / Débloquer (état après succès — les règles
      // restent l'autorité). Confirmation native avant un blocage.
      const blockBtn = container.querySelector<HTMLButtonElement>('#user-block');
      if (blockBtn && !isSelf && alerts) {
        const setBlocked = (blocked: boolean): void => {
          blockBtn.dataset.blocked = String(blocked);
          blockBtn.setAttribute('aria-pressed', String(blocked));
          blockBtn.classList.toggle('btn--danger', !blocked);
          blockBtn.classList.toggle('btn--ghost', blocked);
          const label = blockBtn.querySelector('.btn__label');
          if (label) label.textContent = blocked ? 'Débloquer' : 'Bloquer';
        };

        blockBtn.addEventListener('click', async () => {
          if (blockBtn.disabled) return;
          const wasBlocked = blockBtn.dataset.blocked === 'true';
          if (!wasBlocked) {
            const ok = window.confirm(
              'Voulez-vous vraiment bloquer cet utilisateur ? Les futurs systèmes (messagerie notamment) lui interdiraient de vous contacter.'
            );
            if (!ok) return;
          }
          blockBtn.disabled = true;
          try {
            if (wasBlocked) {
              await unblockUser(uid, profile.uid);
              setBlocked(false);
              notify('Utilisateur débloqué.', 'success');
            } else {
              await blockUser(uid, profile.uid);
              setBlocked(true);
              notify('Utilisateur bloqué.', 'success');
            }
          } catch (err) {
            alerts.innerHTML = `<div class="alert alert--error" role="alert">${escapeHtml(describeError(err))}</div>`;
          } finally {
            blockBtn.disabled = false;
          }
        });
      }

      // Bouton « Envoyer un message » : ouvre la conversation
      // déterministe (l'ID est construit ici, le peer est transmis
      // pour recréer la conversation si nécessaire).
      const messageBtn = container.querySelector<HTMLButtonElement>('#user-message');
      if (messageBtn && ctx) {
        messageBtn.addEventListener('click', () => {
          ctx.navigate(`#/messages/${buildConversationId(uid, profile.uid)}?peer=${escapeHtml(profile.uid)}`);
        });
      }
    } catch (err) {
      renderError(describeError(err));
    }
  };

  void load();
}