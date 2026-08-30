import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import {
  createTextPost,
  fetchFeed,
  linkifyHashtags,
  type FeedMode,
  type Post,
  type PostVisibility,
} from '../lib/posts';
import { createComment, fetchComments, fetchAuthorNames, type Comment } from '../lib/comments';
import { fetchLikedPostIds, toggleLike } from '../lib/likes';
import { fetchSharedPostIds, toggleShare } from '../lib/shares';
import {
  createReport,
  hasReported,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  type ReportReason,
} from '../lib/reports';
import {
  appShell,
  alertMarkup,
  escapeHtml,
  isModeratorRole,
  spinnerMarkup,
  setSubmitting,
  textareaMarkup,
  type ViewContext,
} from './layout';

const VISIBILITY_LABELS: Record<PostVisibility, string> = {
  public: 'Public',
  followers: 'Abonnés',
  private: 'Privé',
};

const MODERATION_LABELS: Record<string, string> = {
  visible: '',
  hidden: 'Masqué par la modération',
  removed: 'Retiré',
};

// Carte d'un commentaire. `level` contrôle l'indentation du thread
// (0 = racine, 1 = réponse, 2 = niveau max affiché ; au-delà aplati).
// Chaque carte expose un bouton « Répondre » et un conteneur
// `.comment-reply` dans lequel le composer de réponse est injecté à
// la volée côté client (voir mountHome).
// NB : les utilisateurs normaux ne reçoivent que des commentaires
// `moderationStatus == 'visible'` (les masqués/retirés sont filtrés
// par la règle + fetchComments) ; aucun badge de modération n'est
// donc affiché ici.
function commentMarkup(comment: Comment, authorName: string, level: number): string {
  const date =
    comment.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';
  const initial = escapeHtml((authorName || '?').trim().charAt(0).toUpperCase() || '?');
  return `
    <article class="comment-card comment-card--level-${Math.min(Math.max(level, 0), 2)}"
      data-comment-id="${escapeHtml(comment.id)}">
      <header class="comment-card__header">
        <span class="avatar avatar--sm avatar--fallback" aria-hidden="true">${initial}</span>
        <div class="comment-card__meta">
          <a class="comment-card__author" href="#/u/${escapeHtml(comment.authorId)}">${escapeHtml(authorName)}</a>
          <span class="comment-card__date muted">${escapeHtml(date)}</span>
        </div>
      </header>
      <p class="comment-card__content">${escapeHtml(comment.content)}</p>
      <div class="comment-card__actions">
        <button type="button" class="btn btn--ghost btn--sm comment-reply-toggle"
          data-reply-to="${escapeHtml(comment.id)}"
          aria-expanded="false">
          <span class="btn__label">Répondre</span>
        </button>
      </div>
      <div class="comment-reply" aria-live="polite"></div>
    </article>
  `;
}

// Placeholder affiché quand le parent d'une réponse est supprimé,
// masqué/retiré par la modération ou introuvable parmi les
// commentaires chargés. Son contenu n'est jamais exposé.
function commentDeletedMarkup(level: number): string {
  return `
    <div class="comment-card comment-card--level-${Math.min(Math.max(level, 0), 2)} comment-card--deleted" role="note">
      <span class="comment-card__deleted muted">Commentaire indisponible.</span>
    </div>
  `;
}

// Rendu en arbre des commentaires (thread) :
//  - replyToId === '' → commentaire racine ;
//  - sinon → réponse rendue sous son parent ;
//  - 3 niveaux d'affichage maximum (0, 1, 2), au-delà aplatis sur 2 ;
//  - parent supprimé/masqué/retiré ou introuvable → placeholder
//    « Commentaire indisponible » (le contenu du parent n'est pas
//    exposé ; seules ses réponses visibles sont affichées).
function commentsListMarkup(comments: Comment[], authorNames: Map<string, string>): string {
  const ids = new Set(comments.map((c) => c.id));
  const byParent = new Map<string, Comment[]>();
  for (const comment of comments) {
    const parentKey = comment.replyToId || '';
    const siblings = byParent.get(parentKey);
    if (siblings) siblings.push(comment);
    else byParent.set(parentKey, [comment]);
  }

  const rendered = new Set<string>();
  const renderSubtree = (comment: Comment, level: number): string => {
    if (rendered.has(comment.id)) return '';
    rendered.add(comment.id);
    const card = commentMarkup(comment, authorNames.get(comment.authorId) ?? comment.authorId, level);
    const replies = (byParent.get(comment.id) ?? [])
      .map((child) => renderSubtree(child, Math.min(level + 1, 2)))
      .join('\n');
    return [card, replies].join('\n');
  };

  const parts: string[] = [];
  for (const comment of comments) {
    if (comment.replyToId === '') parts.push(renderSubtree(comment, 0));
  }
  // Réponses orphelines : parent supprimé ou absent du chargement.
  for (const comment of comments) {
    if (comment.replyToId !== '' && !ids.has(comment.replyToId) && !rendered.has(comment.id)) {
      parts.push(commentDeletedMarkup(0));
      parts.push(renderSubtree(comment, 1));
    }
  }
  // Filet de sécurité : tout commentaire non encore rendu (cycle ou
  // auto-référence dans replyToId) apparaît au minimum en racine.
  for (const comment of comments) {
    if (!rendered.has(comment.id)) parts.push(renderSubtree(comment, 0));
  }
  return parts.join('\n');
}

function commentsEmptyMarkup(): string {
  return `<div class="comments__empty muted">Aucun commentaire pour le moment.</div>`;
}

function commentsErrorMarkup(message: string): string {
  return `
    <div class="comments__error" role="alert">
      <div class="alert alert--error">${escapeHtml(message)}</div>
      <button type="button" class="comments__retry btn btn--ghost btn--sm">
        <span class="btn__label">Réessayer</span>
      </button>
    </div>
  `;
}

function commentComposerMarkup(postId: string): string {
  return `
    <form class="comment-form" data-post-id="${escapeHtml(postId)}" novalidate>
      ${textareaMarkup({
        id: `comment-content-${postId}`,
        label: 'Ajouter un commentaire',
        name: 'content',
        rows: 2,
        maxlength: 2000,
        placeholder: 'Votre réponse…',
        hint: '1 à 2000 caractères.',
      })}
      <div id="comment-alerts-${postId}"></div>
      <div class="actions">
        <button type="submit" class="btn btn--primary btn--sm">
          <span class="btn__label">Commenter</span>
        </button>
      </div>
    </form>
  `;
}

// Composer de réponse inline, injecté sous le commentaire ciblé
// (le parent de la réponse = le commentaire `commentId`).
function replyFormMarkup(postId: string, commentId: string): string {
  const safePostId = escapeHtml(postId);
  const safeCommentId = escapeHtml(commentId);
  return `
    <form class="comment-reply__form" data-post-id="${safePostId}" data-comment-id="${safeCommentId}" novalidate>
      ${textareaMarkup({
        id: `reply-content-${postId}-${commentId}`,
        label: 'Répondre',
        name: 'content',
        rows: 2,
        maxlength: 2000,
        placeholder: 'Votre réponse…',
        hint: '1 à 2000 caractères.',
      })}
      <div class="comment-reply__alerts"></div>
      <div class="actions">
        <button type="submit" class="btn btn--primary btn--sm">
          <span class="btn__label">Répondre</span>
        </button>
        <button type="button" class="btn btn--ghost btn--sm comment-reply__cancel">
          <span class="btn__label">Annuler</span>
        </button>
      </div>
    </form>
  `;
}

function commentsSectionMarkup(postId: string): string {
  return `
    <section class="comments" data-post-id="${escapeHtml(postId)}" aria-label="Commentaires">
      <div class="comments__header">
        <h3 class="comments__title">Commentaires</h3>
        <span class="comments__count badge" aria-live="polite">0</span>
      </div>
      <div class="comments__list">
        <div class="comments__status">${spinnerMarkup()}<span class="muted">Chargement…</span></div>
      </div>
      <div class="comments__composer">${commentComposerMarkup(postId)}</div>
    </section>
  `;
}

function reportPanelMarkup(postId: string): string {
  const options = REPORT_REASONS.map(
    (r) => `<option value="${r}">${escapeHtml(REPORT_REASON_LABELS[r])}</option>`
  ).join('\n');
  return `
    <div class="report-panel" id="report-panel-${escapeHtml(postId)}" hidden>
      <form class="report-form" data-post-id="${escapeHtml(postId)}" novalidate>
        <div class="field">
          <label class="field__label" for="report-reason-${escapeHtml(postId)}">Motif</label>
          <select class="field__input" id="report-reason-${escapeHtml(postId)}" name="reason" required>
            <option value="" disabled selected>Choisir un motif…</option>
            ${options}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="report-details-${escapeHtml(postId)}">Détails (facultatif)</label>
          <textarea class="field__input" id="report-details-${escapeHtml(postId)}" name="details" rows="2" maxlength="1000" placeholder="Précisions utiles à la modération…"></textarea>
        </div>
        <div id="report-alerts-${escapeHtml(postId)}"></div>
        <div class="actions">
          <button type="submit" class="btn btn--primary btn--sm">
            <span class="btn__label">Envoyer le signalement</span>
          </button>
          <button type="button" class="btn btn--ghost btn--sm report-cancel">
            <span class="btn__label">Annuler</span>
          </button>
        </div>
      </form>
    </div>
  `;
}

function postMarkup(post: Post, uid: string): string {
  const date =
    post.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';
  const initial = escapeHtml((post.authorName || '?').trim().charAt(0).toUpperCase() || '?');
  const visibilityBadge = `<span class="badge">${escapeHtml(VISIBILITY_LABELS[post.visibility] ?? post.visibility)}</span>`;
  const moderationBadge =
    post.moderationStatus !== 'visible'
      ? `<span class="badge badge--warn">${escapeHtml(MODERATION_LABELS[post.moderationStatus] ?? post.moderationStatus)}</span>`
      : '';
  const isOwn = post.authorId === uid;
  const reportButton = isOwn
    ? ''
    : `
      <button type="button" class="btn btn--ghost btn--sm report-toggle"
        data-report-toggle="${escapeHtml(post.id)}"
        aria-expanded="false" aria-controls="report-panel-${escapeHtml(post.id)}">
        <span class="btn__label">Signaler</span>
      </button>
    `;
  const likeButton = `
    <button type="button" class="btn btn--ghost btn--sm like-toggle"
      data-like-toggle="${escapeHtml(post.id)}"
      data-liked="false"
      aria-pressed="false"
      aria-label="Aimer ou retirer votre j’aime de cette publication">
      <span class="like-toggle__icon" aria-hidden="true">♥</span>
      <span class="like-toggle__count" aria-label="Nombre de j’aime">${Number(post.likeCount) || 0}</span>
    </button>
  `;
  const shareButton = `
    <button type="button" class="btn btn--ghost btn--sm share-toggle"
      data-share-toggle="${escapeHtml(post.id)}"
      data-shared="false"
      aria-pressed="false"
      aria-label="Partager ou retirer le partage de cette publication">
      <span class="share-toggle__icon" aria-hidden="true">↗</span>
      <span class="share-toggle__count" aria-label="Nombre de partages">${Number(post.shareCount) || 0}</span>
      <span class="share-toggle__label">Partager</span>
    </button>
  `;
  return `
    <article class="post-card">
      <header class="post-card__header">
        <span class="avatar avatar--sm avatar--fallback" aria-hidden="true">${initial}</span>
        <div class="post-card__meta">
          <a class="post-card__author" href="#/u/${escapeHtml(post.authorId)}">${escapeHtml(post.authorName)}</a>
          <span class="post-card__date muted">${escapeHtml(date)}</span>
        </div>
        <div class="post-card__badges">${visibilityBadge}${moderationBadge}</div>
      </header>
      <p class="post-card__content">${linkifyHashtags(escapeHtml(post.content))}</p>
      <div class="post-card__actions">
        ${likeButton}
        ${shareButton}
        ${reportButton}
      </div>
      ${isOwn ? '' : reportPanelMarkup(post.id)}
      ${commentsSectionMarkup(post.id)}
    </article>
  `;
}

function listMarkup(posts: Post[], uid: string): string {
  return posts.map((post) => postMarkup(post, uid)).join('\n');
}

function composerMarkup(): string {
  return `
    <section class="card">
      <h2 class="card__title">Publier</h2>
      <form id="post-form" novalidate>
        ${textareaMarkup({
          id: 'post-content',
          label: 'Votre message',
          name: 'content',
          rows: 3,
          maxlength: 5000,
          placeholder: 'Quoi de neuf ?',
          hint: '1 à 5000 caractères.',
        })}
        <div class="field">
          <label class="field__label" for="post-visibility">Visibilité</label>
          <select class="field__input" id="post-visibility" name="visibility" aria-describedby="post-visibility-hint">
            <option value="public">Public</option>
            <option value="followers">Abonnés</option>
            <option value="private">Privé</option>
          </select>
          <span class="field__hint" id="post-visibility-hint">
            Public : visible par tous les utilisateurs connectés.
          </span>
        </div>
        <div id="post-alerts"></div>
        <div class="actions">
          <button type="submit" class="btn btn--primary">
            <span class="btn__label">Publier</span>
          </button>
        </div>
      </form>
    </section>
  `;
}

function feedMarkup(): string {
  return `
    <section class="card">
      <h2 class="card__title">Fil de publications</h2>
      <div class="feed-tabs" role="tablist" aria-label="Type de fil">
        <button type="button" class="feed-tab feed-tab--active" data-feed-tab="general"
          role="tab" aria-selected="true" aria-controls="post-feed">
          <span class="btn__label">Général</span>
        </button>
        <button type="button" class="feed-tab" data-feed-tab="following"
          role="tab" aria-selected="false" aria-controls="post-feed">
          <span class="btn__label">Abonnés</span>
        </button>
      </div>
      <div id="post-feed" class="post-feed" aria-live="polite">
        <div class="post-feed__status">${spinnerMarkup()}<span class="muted">Chargement des publications…</span></div>
      </div>
    </section>
  `;
}

function emptyMarkup(mode: FeedMode): string {
  const message =
    mode === 'following'
      ? 'Aucune publication pour le moment. Suivez d’autres voix ou partagez votre parole pour alimenter ce fil.'
      : 'Aucune publication pour le moment. Soyez la première voix à se faire entendre !';
  return `
    <div class="post-feed__empty">
      <p class="muted">${escapeHtml(message)}</p>
    </div>
  `;
}

function errorMarkup(message: string): string {
  return `
    <div class="post-feed__error" role="alert">
      <div class="alert alert--error">${escapeHtml(message)}</div>
      <button type="button" id="post-feed-retry" class="btn btn--ghost btn--sm">
        <span class="btn__label">Réessayer</span>
      </button>
    </div>
  `;
}

export function renderHome(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const name = escapeHtml(session.profile?.displayName || session.displayName || 'PAROLE');

  const verifyBanner = session.emailVerified
    ? ''
    : `
    <div class="alert alert--info">
      Votre adresse email n’est pas encore vérifiée.
      <a href="#/verify-email">Vérifier maintenant</a>
    </div>
  `;

  const inner = `
    ${verifyBanner}
    <section class="card">
      <h2 class="card__title">Bienvenue, ${name}</h2>
      <p class="muted">
        Vous êtes connecté. Partagez votre parole ou explorez les publications.
      </p>
    </section>
    ${composerMarkup()}
    ${feedMarkup()}
    <section class="quick-links">
      <a class="card quick-link" href="#/profile">
        <strong>Mon profil</strong>
        <span class="muted">Consulter et modifier mes informations.</span>
      </a>
      <a class="card quick-link" href="#/settings">
        <strong>Paramètres du compte</strong>
        <span class="muted">Sécurité, mot de passe et session.</span>
      </a>
    </section>
  `;
  return appShell(inner, 'home', isModeratorRole(session.profile?.role), session.profile?.notificationCount ?? 0, session.profile?.messageCount ?? 0);
}

export function mountHome(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const uid = session.uid;
  if (!uid) return;
  const authorName = session.profile?.displayName || session.displayName || uid;

  let likedPostIds = new Set<string>();

  const setLiked = (btn: HTMLButtonElement, liked: boolean): void => {
    btn.dataset.liked = String(liked);
    btn.setAttribute('aria-pressed', String(liked));
    btn.classList.toggle('like-toggle--active', liked);
  };

  const applyLikedState = (container: HTMLElement): void => {
    container.querySelectorAll<HTMLButtonElement>('.like-toggle').forEach((btn) => {
      const postId = btn.dataset.likeToggle;
      setLiked(btn, Boolean(postId && likedPostIds.has(postId)));
    });
  };

  let sharedPostIds = new Set<string>();

  const setShared = (btn: HTMLButtonElement, shared: boolean): void => {
    btn.dataset.shared = String(shared);
    btn.setAttribute('aria-pressed', String(shared));
    btn.classList.toggle('share-toggle--active', shared);
    const label = btn.querySelector<HTMLSpanElement>('.share-toggle__label');
    if (label) label.textContent = shared ? 'Partagé' : 'Partager';
  };

  const applySharedState = (container: HTMLElement): void => {
    container.querySelectorAll<HTMLButtonElement>('.share-toggle').forEach((btn) => {
      const postId = btn.dataset.shareToggle;
      setShared(btn, Boolean(postId && sharedPostIds.has(postId)));
    });
  };

  const attachLikeHandlers = (container: HTMLElement): void => {
    container.querySelectorAll<HTMLButtonElement>('.like-toggle').forEach((btn) => {
      const postId = btn.dataset.likeToggle;
      if (!postId) return;

      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const wasLiked = btn.dataset.liked === 'true';
        const countEl = btn.querySelector<HTMLSpanElement>('.like-toggle__count');
        const currentCount = countEl ? Number(countEl.textContent ?? '0') : 0;
        const nextLiked = !wasLiked;

        // Mise à jour optimiste : l'état réel reste garanti par les
        // règles (doublon = update refusé, suppression = propriétaire).
        setLiked(btn, nextLiked);
        if (countEl) countEl.textContent = String(Math.max(0, currentCount + (nextLiked ? 1 : -1)));

        try {
          await toggleLike(uid, postId);
          if (nextLiked) likedPostIds.add(postId);
          else likedPostIds.delete(postId);
        } catch (err) {
          setLiked(btn, wasLiked);
          if (countEl) countEl.textContent = String(currentCount);
          notify(describeError(err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  };

  const attachShareHandlers = (container: HTMLElement): void => {
    container.querySelectorAll<HTMLButtonElement>('.share-toggle').forEach((btn) => {
      const postId = btn.dataset.shareToggle;
      if (!postId) return;

      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const wasShared = btn.dataset.shared === 'true';
        const countEl = btn.querySelector<HTMLSpanElement>('.share-toggle__count');
        const currentCount = countEl ? Number(countEl.textContent ?? '0') : 0;
        const nextShared = !wasShared;

        // Mise à jour optimiste : l'état réel reste garanti par les
        // règles (doublon = update refusé, suppression = propriétaire).
        setShared(btn, nextShared);
        if (countEl) countEl.textContent = String(Math.max(0, currentCount + (nextShared ? 1 : -1)));

        try {
          await toggleShare(uid, postId);
          if (nextShared) sharedPostIds.add(postId);
          else sharedPostIds.delete(postId);
        } catch (err) {
          setShared(btn, wasShared);
          if (countEl) countEl.textContent = String(currentCount);
          notify(describeError(err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  };

  const form = root.querySelector<HTMLFormElement>('#post-form');
  const feed = root.querySelector<HTMLDivElement>('#post-feed');
  const alerts = root.querySelector<HTMLDivElement>('#post-alerts');

  let activeFeedMode: FeedMode = 'general';

  const setActiveTab = (mode: FeedMode): void => {
    const tabs = root.querySelectorAll<HTMLButtonElement>('.feed-tab');
    tabs.forEach((tab) => {
      const active = tab.dataset.feedTab === mode;
      tab.classList.toggle('feed-tab--active', active);
      tab.setAttribute('aria-selected', String(active));
    });
  };

  const loadFeed = async (mode: FeedMode = activeFeedMode): Promise<void> => {
    if (!feed) return;
    activeFeedMode = mode;
    setActiveTab(mode);
    feed.innerHTML = `
      <div class="post-feed__status">${spinnerMarkup()}<span class="muted">Chargement des publications…</span></div>
    `;
    try {
      const posts = await fetchFeed(uid, mode);
      feed.innerHTML = posts.length === 0 ? emptyMarkup(mode) : listMarkup(posts, uid);
      try {
        likedPostIds = await fetchLikedPostIds(uid);
      } catch {
        likedPostIds = new Set();
      }
      try {
        sharedPostIds = await fetchSharedPostIds(uid);
      } catch {
        sharedPostIds = new Set();
      }
      applyLikedState(feed);
      attachLikeHandlers(feed);
      applySharedState(feed);
      attachShareHandlers(feed);
      attachCommentsHandlers(root);
      attachReportHandlers(root);
    } catch (err) {
      feed.innerHTML = errorMarkup(describeError(err));
      feed.querySelector<HTMLButtonElement>('#post-feed-retry')?.addEventListener('click', () => {
        void loadFeed(mode);
      });
    }
  };

  root.querySelectorAll<HTMLButtonElement>('.feed-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.feedTab as FeedMode | undefined;
      if (!mode || mode === activeFeedMode) return;
      void loadFeed(mode);
    });
  });

  const attachCommentsHandlers = (container: HTMLElement): void => {
    const commentsSections = container.querySelectorAll<HTMLElement>('.comments');
    commentsSections.forEach((section) => {
      const postId = section.dataset.postId;
      if (!postId) return;

      const commentForm = section.querySelector<HTMLFormElement>('.comment-form');
      const listEl = section.querySelector<HTMLDivElement>('.comments__list');
      const countEl = section.querySelector<HTMLSpanElement>('.comments__count');
      const alertsEl = commentForm
        ? section.querySelector<HTMLDivElement>(`#comment-alerts-${postId}`)
        : null;

      const loadComments = async (): Promise<void> => {
        if (!listEl) return;
        listEl.innerHTML = `<div class="comments__status">${spinnerMarkup()}<span class="muted">Chargement…</span></div>`;
        try {
          const comments = await fetchComments(postId);
          const authorIds = comments.map((c) => c.authorId);
          const authorNames = await fetchAuthorNames(authorIds);
          listEl.innerHTML = comments.length === 0 ? commentsEmptyMarkup() : commentsListMarkup(comments, authorNames);
          if (countEl) countEl.textContent = String(comments.length);
        } catch (err) {
          listEl.innerHTML = commentsErrorMarkup(describeError(err));
          listEl.querySelector<HTMLButtonElement>('.comments__retry')?.addEventListener('click', () => {
            void loadComments();
          });
        }
      };

      commentForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!alertsEl) return;
        alertsEl.innerHTML = '';

        const contentEl = commentForm.elements.namedItem('content') as HTMLTextAreaElement;
        const content = contentEl.value;

        let message: string | null = null;
        if (!content.trim()) message = 'Le commentaire ne peut pas être vide.';
        else if (content.trim().length > 2000) message = '2000 caractères maximum.';
        if (message) {
          alertsEl.innerHTML = alertMarkup(message, 'error');
          return;
        }

        setSubmitting(commentForm, true);
        try {
          await createComment(postId, uid, content);
          commentForm.reset();
          alertsEl.innerHTML = alertMarkup('Commentaire publié.', 'success');
          await loadComments();
        } catch (err) {
          alertsEl.innerHTML = alertMarkup(describeError(err), 'error');
        } finally {
          setSubmitting(commentForm, false);
        }
      });

      // Composer de réponse : un seul actif par section. Délégation
      // d'événements car la liste est re-rendue à chaque chargement.
      const clearCommentReply = (el: HTMLElement | null | undefined): void => {
        const replyHost = el?.querySelector<HTMLElement>('.comment-reply');
        if (replyHost) replyHost.innerHTML = '';
      };

      const syncReplyExpand = (): void => {
        section.querySelectorAll<HTMLButtonElement>('.comment-reply-toggle').forEach((btn) => {
          const hasForm = btn
            .closest<HTMLElement>('.comment-card')
            ?.querySelector<HTMLFormElement>('.comment-reply__form') != null;
          btn.setAttribute('aria-expanded', String(hasForm));
        });
      };

      section.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;

        const cancel = target.closest<HTMLButtonElement>('.comment-reply__cancel');
        if (cancel) {
          clearCommentReply(cancel.closest<HTMLElement>('.comment-card'));
          syncReplyExpand();
          return;
        }

        const toggle = target.closest<HTMLButtonElement>('.comment-reply-toggle');
        if (!toggle) return;
        const card = toggle.closest<HTMLElement>('.comment-card');
        const commentId = card?.dataset.commentId;
        const replyHost = card?.querySelector<HTMLElement>('.comment-reply');
        if (!commentId || !replyHost) return;

        const openForm = section.querySelector<HTMLFormElement>('.comment-reply__form');
        if (openForm) {
          const openHost = openForm.closest<HTMLElement>('.comment-card');
          // Même carte déjà ouverte → bascule (fermeture).
          if (openHost === card) {
            clearCommentReply(openHost);
            syncReplyExpand();
            return;
          }
          clearCommentReply(openHost);
        }

        replyHost.innerHTML = replyFormMarkup(postId, commentId);
        replyHost.querySelector<HTMLTextAreaElement>('textarea')?.focus();
        syncReplyExpand();
      });

      section.addEventListener('submit', async (event) => {
        const replyForm = (event.target as HTMLElement).closest<HTMLFormElement>('.comment-reply__form');
        if (!replyForm) return;
        event.preventDefault();

        const commentId = replyForm.dataset.commentId;
        const card = replyForm.closest<HTMLElement>('.comment-card');
        const replyAlerts = replyForm.querySelector<HTMLDivElement>('.comment-reply__alerts');
        if (!commentId || !replyAlerts) return;
        replyAlerts.innerHTML = '';

        const contentEl = replyForm.elements.namedItem('content') as HTMLTextAreaElement;
        const content = contentEl.value;

        let message: string | null = null;
        if (!content.trim()) message = 'La réponse ne peut pas être vide.';
        else if (content.trim().length > 2000) message = '2000 caractères maximum.';
        if (message) {
          replyAlerts.innerHTML = alertMarkup(message, 'error');
          return;
        }

        setSubmitting(replyForm, true);
        try {
          await createComment(postId, uid, content, commentId);
          clearCommentReply(card);
          syncReplyExpand();
          await loadComments();
        } catch (err) {
          replyAlerts.innerHTML = alertMarkup(describeError(err), 'error');
        } finally {
          setSubmitting(replyForm, false);
        }
      });

      void loadComments();
    });
  };

  const attachReportHandlers = (container: HTMLElement): void => {
    container.querySelectorAll<HTMLButtonElement>('.report-toggle').forEach((btn) => {
      const postId = btn.dataset.reportToggle;
      if (!postId) return;
      const panel = container.querySelector<HTMLElement>(`#report-panel-${postId}`);
      if (!panel) return;
      const form = panel.querySelector<HTMLFormElement>('.report-form');
      const alertsEl = panel.querySelector<HTMLDivElement>(`#report-alerts-${postId}`);
      const submitBtn = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
      const cancelBtn = panel.querySelector<HTMLButtonElement>('.report-cancel');
      let submitted = false;
      let alreadyChecked = false;

      const close = (): void => {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      };

      btn.addEventListener('click', () => {
        if (!panel.hidden) {
          close();
          return;
        }
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        if (!alreadyChecked && alertsEl && submitBtn) {
          alreadyChecked = true;
          void hasReported(uid, 'post', postId)
            .then((exists) => {
              if (exists) {
                submitBtn.disabled = true;
                alertsEl.innerHTML = alertMarkup('Vous avez déjà signalé ce contenu.', 'info');
              }
            })
            .catch(() => {
              // Les règles restent l'autorité : un doublon sera refusé.
            });
        }
      });

      cancelBtn?.addEventListener('click', close);

      form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!alertsEl) return;
        alertsEl.innerHTML = '';
        const reasonEl = form.elements.namedItem('reason') as HTMLSelectElement;
        const detailsEl = form.elements.namedItem('details') as HTMLTextAreaElement;
        const reason = reasonEl.value as ReportReason;
        const details = detailsEl?.value ?? '';

        let message: string | null = null;
        if (!REPORT_REASONS.includes(reason)) message = 'Veuillez choisir un motif.';
        else if (details.length > 1000) message = '1000 caractères maximum pour les détails.';
        if (message) {
          alertsEl.innerHTML = alertMarkup(message, 'error');
          return;
        }

        setSubmitting(form, true);
        submitted = false;
        try {
          await createReport(uid, 'post', postId, reason, details);
          submitted = true;
          if (submitBtn) submitBtn.disabled = true;
          alertsEl.innerHTML = alertMarkup('Signalement envoyé. Merci de votre vigilance.', 'success');
        } catch (err) {
          const msg = /permission[-_]denied/i.test(err instanceof Error ? err.message : '')
            ? 'Vous avez déjà signalé ce contenu.'
            : describeError(err);
          alertsEl.innerHTML = alertMarkup(msg, 'error');
        } finally {
          if (!submitted) setSubmitting(form, false);
        }
      });
    });
  };

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!alerts) return;
    alerts.innerHTML = '';

    const contentEl = form.elements.namedItem('content') as HTMLTextAreaElement;
    const visEl = form.elements.namedItem('visibility') as HTMLSelectElement;
    const content = contentEl.value;
    const visibility = visEl.value as PostVisibility;

    let message: string | null = null;
    if (!content.trim()) message = 'Le contenu ne peut pas être vide.';
    else if (content.trim().length > 5000) message = '5000 caractères maximum.';
    if (message) {
      alerts.innerHTML = alertMarkup(message, 'error');
      return;
    }

    setSubmitting(form, true);
    try {
      await createTextPost(uid, authorName, content, visibility);
      form.reset();
      alerts.innerHTML = alertMarkup('Publication en ligne.', 'success');
      await loadFeed();
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    } finally {
      setSubmitting(form, false);
    }
  });

  void loadFeed();
}