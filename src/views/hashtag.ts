// ============================================================
// PAROLE - Page hashtag (Phase 9 - Lot 1)
//
// Route `#/hashtag/{tag}` : liste les posts publics visibles portant
// le hashtag, du plus récent au plus ancien. Le tag est normalisé
// (minuscules, sans '#') ; un tag invalide affiche un état vide. La
// requête réutilise exactement la contrainte du fil « Général »
// (hashtags array-contains + visibility == 'public' +
// moderationStatus == 'visible') : les posts visibility
// 'followers'/'private' d'autrui n'apparaissent jamais ici.
// ============================================================

import { describeError } from '../lib/errors';
import { fetchPostsByHashtag, linkifyHashtags, normalizeHashtag, type Post } from '../lib/posts';
import { navigate } from '../lib/router';
import { appShell, escapeHtml, isModeratorRole, spinnerMarkup, type ViewContext } from './layout';

// Carte compacte d'un post (miroir du profil public) : la visibilité
// étant 'public', aucun badge n'est nécessaire. Les hashtags du texte
// sont reliés vers leur propre page (`#/hashtag/{tag}`).
function postMarkup(post: Post): string {
  const date =
    post.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';
  const shareCount = Number(post.shareCount) || 0;
  return `
    <article class="post-card post-card--compact">
      <header class="post-card__header">
        <span class="avatar avatar--sm avatar--fallback" aria-hidden="true">${escapeHtml((post.authorName || '?').trim().charAt(0).toUpperCase() || '?')}</span>
        <div class="post-card__meta">
          <a class="post-card__author" href="#/u/${escapeHtml(post.authorId)}">${escapeHtml(post.authorName)}</a>
          <span class="post-card__date muted">${escapeHtml(date)}</span>
        </div>
      </header>
      <p class="post-card__content">${linkifyHashtags(escapeHtml(post.content))}</p>
      ${shareCount > 0 ? `<span class="post-card__shares muted">${shareCount} partage${shareCount > 1 ? 's' : ''}</span>` : ''}
    </article>
  `;
}

function postsMarkup(posts: Post[]): string {
  return posts.map(postMarkup).join('\n');
}

export function renderHashtag(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const rawTag = ctx.route.params.get('tag') ?? '';
  const tag = normalizeHashtag(rawTag);

  const inner = `
    <section class="card">
      <h2 class="card__title">Hashtag #${escapeHtml((tag ?? rawTag) || '…')}</h2>
      <div id="hashtag-page">
        <div class="muted">Chargement des publications…</div>
      </div>
    </section>
  `;
  return appShell(inner, '', isModeratorRole(session.profile?.role), session.profile?.notificationCount ?? 0, session.profile?.messageCount ?? 0);
}

export function mountHashtag(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const container = root.querySelector<HTMLDivElement>('#hashtag-page');
  if (!container) return;

  const rawTag = ctx.route.params.get('tag') ?? '';
  const tag = normalizeHashtag(rawTag);

  // Route non canonique (majuscules, '#' inclus…) : redirection vers
  // la forme normalisée pour un rendu déterministe.
  if (tag && tag !== rawTag) {
    navigate(`/hashtag/${tag}`);
    return;
  }

  const renderError = (message: string): void => {
    container.innerHTML = `
      <div class="alert alert--error" role="alert">${escapeHtml(message)}</div>
      <div class="actions">
        <button type="button" id="hashtag-retry" class="btn btn--ghost btn--sm">
          <span class="btn__label">Réessayer</span>
        </button>
      </div>
    `;
    container.querySelector<HTMLButtonElement>('#hashtag-retry')?.addEventListener('click', () => {
      void load();
    });
  };

  const load = async (): Promise<void> => {
    container.innerHTML = `<div class="hashtag-feed__status">${spinnerMarkup()}<span class="muted">Chargement des publications…</span></div>`;
    try {
      if (!tag) {
        container.innerHTML = `
          <p class="muted">Hashtag invalide. Vérifiez le lien.</p>
          <p class="muted"><a href="#/">Retour à l’accueil</a></p>
        `;
        return;
      }
      const posts = await fetchPostsByHashtag(tag);
      if (posts.length === 0) {
        container.innerHTML = `
          <div class="hashtag-feed__empty">
            <p class="muted">Aucune publication ne porte le hashtag #${escapeHtml(tag)} pour le moment.</p>
            <p class="muted">Soyez la première voix à utiliser ce hashtag !</p>
          </div>
        `;
        return;
      }
      container.innerHTML = `<div class="post-feed">${postsMarkup(posts)}</div>`;
    } catch (err) {
      renderError(describeError(err));
    }
  };

  void load();
}