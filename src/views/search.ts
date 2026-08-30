// ============================================================
// PAROLE - Page Recherche (Phase 9 - Lot 5)
//
// Route `#/search` (paramètre `?q=` partageable) : une seule barre de
// recherche restitue
//   1) les UTILISATEURS dont le profil porte un token de recherche
//      correspondant (`users.searchTokens` array-contains, déterminé
//      par le displayName — voir src/lib/search.ts) ;
//   2) les PUBLICATIONS portant `#token` (réutilisation de
//      `fetchPostsByHashtag`, même contrainte de lecture que la page
//      hashtag), avec un lien vers `#/hashtag/{tag}`.
// Aucune Cloud Function, aucun index composite, aucune recherche
// plein-texte ni recherche des messages/contenu privé. La requête
// est normalisée (minuscules, [0-9a-z_]) ; une requête vide ou trop
// courte (moins de 2 caractères) n'interroge pas le réseau. Tout
// contenu utilisateur affiché est échappé.
// ============================================================

import { runSearch, type SearchResults } from '../lib/search';
import { linkifyHashtags, type Post } from '../lib/posts';
import { navigate } from '../lib/router';
import { describeError } from '../lib/errors';
import { appShell, avatarMarkup, escapeHtml, isModeratorRole, spinnerMarkup, type ViewContext } from './layout';

function userMarkup(user: { uid: string; displayName: string; bio: string; avatarPath: string }): string {
  // Avatar en lettre-fallback (comme les cartes de posts) : un appel
  // de téléchargement par résultat multiplierait les requêtes réseau
  // sans apport de sécurité (le profil public reste lisible).
  return `
    <article class="search-user">
      ${avatarMarkup(null, user.displayName || user.uid, 'sm')}
      <div class="search-user__body">
        <a class="search-user__name" href="#/u/${escapeHtml(user.uid)}">${escapeHtml(user.displayName)}</a>
        ${user.bio ? `<p class="search-user__bio muted">${escapeHtml(user.bio)}</p>` : ''}
      </div>
    </article>
  `;
}

function usersSection(users: SearchResults['users']): string {
  if (users.length === 0) {
    return `<p class="muted">Aucun utilisateur trouvé.</p>`;
  }
  return `<div class="search-users">${users.map(userMarkup).join('\n')}</div>`;
}

function postMarkup(post: Post): string {
  const date =
    post.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';
  const shareCount = Number(post.shareCount) || 0;
  return `
    <article class="post-card post-card--compact">
      <header class="post-card__header">
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

function postsSection(tag: string | null, posts: Post[]): string {
  if (!tag) return '';
  if (posts.length === 0) {
    return `
      <p class="muted">Aucune publication ne porte le hashtag #${escapeHtml(tag)} pour le moment.</p>
      <p class="muted"><a href="#/hashtag/${escapeHtml(tag)}">Voir la page hashtag #${escapeHtml(tag)}</a></p>
    `;
  }
  return `
    <div class="post-feed">${posts.map(postMarkup).join('\n')}</div>
    <p class="muted"><a href="#/hashtag/${escapeHtml(tag)}">Voir tous les posts #${escapeHtml(tag)} →</a></p>
  `;
}

export function renderSearch(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const q = ctx.route.params.get('q') ?? '';

  const inner = `
    <section class="card">
      <h2 class="card__title">Recherche</h2>
      <form id="search-form" class="search-form" role="search">
        <input
          id="search-input"
          class="field__input"
          type="search"
          name="q"
          placeholder="Nom d'utilisateur ou hashtag…"
          value="${escapeHtml(q)}"
          autocomplete="off"
          required
          minlength="2"
          maxlength="50"
        />
        <button type="submit" class="btn btn--primary">
          <span class="btn__label">Rechercher</span>
        </button>
      </form>
      <div id="search-results" class="search-results">
        ${q ? `<div class="muted">${spinnerMarkup()} Recherche…</div>` : '<p class="muted">Recherchez par nom d’utilisateur ou par hashtag.</p>'}
      </div>
    </section>
  `;
  return appShell(inner, 'search', isModeratorRole(session.profile?.role), session.profile?.notificationCount ?? 0, session.profile?.messageCount ?? 0);
}

export function mountSearch(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const results = root.querySelector<HTMLDivElement>('#search-results');
  if (!results) return;

  const form = root.querySelector<HTMLFormElement>('#search-form');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>('#search-input');
    const q = (input?.value ?? '').trim();
    if (!q) return;
    navigate(`/search?q=${encodeURIComponent(q)}`);
  });

  const renderError = (message: string): void => {
    results.innerHTML = `
      <div class="alert alert--error" role="alert">${escapeHtml(message)}</div>
      <div class="actions">
        <button type="button" id="search-retry" class="btn btn--ghost btn--sm">
          <span class="btn__label">Réessayer</span>
        </button>
      </div>
    `;
    results.querySelector<HTMLButtonElement>('#search-retry')?.addEventListener('click', () => {
      void load();
    });
  };

  const load = async (): Promise<void> => {
    const q = ctx.route.params.get('q') ?? '';
    const rawToken = q.trim().toLowerCase().split(/[^0-9a-z_]+/).filter(Boolean)[0] ?? '';
    if (rawToken.length < 2) {
      results.innerHTML = '<p class="muted">Saisissez au moins 2 caractères pour lancer une recherche.</p>';
      return;
    }
    results.innerHTML = `<div class="muted">${spinnerMarkup()} Recherche…</div>`;
    try {
      const data = await runSearch(q, session.uid!);
      results.innerHTML = `
        <section class="search-section">
          <h3 class="search-section__title">Utilisateurs</h3>
          ${usersSection(data.users)}
        </section>
        <section class="search-section">
          <h3 class="search-section__title">Hashtags #${escapeHtml(data.tag ?? rawToken.slice(0, 12))}</h3>
          ${postsSection(data.tag, data.posts)}
        </section>
      `;
    } catch (err) {
      renderError(describeError(err));
    }
  };

  void load();
}