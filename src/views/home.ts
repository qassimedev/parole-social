import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import { createTextPost, fetchFeed, type Post, type PostVisibility } from '../lib/posts';
import { createComment, fetchComments, fetchAuthorNames, type Comment } from '../lib/comments';
import { fetchLikedPostIds, toggleLike } from '../lib/likes';
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

function commentMarkup(comment: Comment, authorName: string): string {
  const date =
    comment.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';
  const initial = escapeHtml((authorName || '?').trim().charAt(0).toUpperCase() || '?');
  const isModerated = comment.moderationStatus !== 'visible';
  const moderationBadge = isModerated
    ? `<span class="badge badge--warn">${escapeHtml(MODERATION_LABELS[comment.moderationStatus] ?? comment.moderationStatus)}</span>`
    : '';
  return `
    <article class="comment-card">
      <header class="comment-card__header">
        <span class="avatar avatar--sm avatar--fallback" aria-hidden="true">${initial}</span>
        <div class="comment-card__meta">
          <strong class="comment-card__author">${escapeHtml(authorName)}</strong>
          <span class="comment-card__date muted">${escapeHtml(date)}</span>
        </div>
        <div class="comment-card__badges">${moderationBadge}</div>
      </header>
      <p class="comment-card__content">${escapeHtml(comment.content)}</p>
    </article>
  `;
}

function commentsListMarkup(comments: Comment[], authorNames: Map<string, string>): string {
  return comments.map((c) => commentMarkup(c, authorNames.get(c.authorId) ?? c.authorId)).join('\n');
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
  return `
    <article class="post-card">
      <header class="post-card__header">
        <span class="avatar avatar--sm avatar--fallback" aria-hidden="true">${initial}</span>
        <div class="post-card__meta">
          <strong class="post-card__author">${escapeHtml(post.authorName)}</strong>
          <span class="post-card__date muted">${escapeHtml(date)}</span>
        </div>
        <div class="post-card__badges">${visibilityBadge}${moderationBadge}</div>
      </header>
      <p class="post-card__content">${escapeHtml(post.content)}</p>
      <div class="post-card__actions">
        ${likeButton}
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
      <div id="post-feed" class="post-feed" aria-live="polite">
        <div class="post-feed__status">${spinnerMarkup()}<span class="muted">Chargement des publications…</span></div>
      </div>
    </section>
  `;
}

function emptyMarkup(): string {
  return `
    <div class="post-feed__empty">
      <p class="muted">Aucune publication pour le moment. Soyez la première voix à se faire entendre !</p>
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
  return appShell(inner, 'home', isModeratorRole(session.profile?.role));
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

  const form = root.querySelector<HTMLFormElement>('#post-form');
  const feed = root.querySelector<HTMLDivElement>('#post-feed');
  const alerts = root.querySelector<HTMLDivElement>('#post-alerts');

  const loadFeed = async (): Promise<void> => {
    if (!feed) return;
    feed.innerHTML = `
      <div class="post-feed__status">${spinnerMarkup()}<span class="muted">Chargement des publications…</span></div>
    `;
    try {
      const posts = await fetchFeed(uid);
      feed.innerHTML = posts.length === 0 ? emptyMarkup() : listMarkup(posts, uid);
      try {
        likedPostIds = await fetchLikedPostIds(uid);
      } catch {
        likedPostIds = new Set();
      }
      applyLikedState(feed);
      attachLikeHandlers(feed);
      attachCommentsHandlers(root);
      attachReportHandlers(root);
    } catch (err) {
      feed.innerHTML = errorMarkup(describeError(err));
      feed.querySelector<HTMLButtonElement>('#post-feed-retry')?.addEventListener('click', () => {
        void loadFeed();
      });
    }
  };

  const attachCommentsHandlers = (container: HTMLElement): void => {
    const commentForms = container.querySelectorAll<HTMLFormElement>('.comment-form');
    commentForms.forEach((commentForm) => {
      const postId = commentForm.dataset.postId;
      if (!postId) return;

      const commentsSection = commentForm.closest('.comments');
      const listEl = commentsSection?.querySelector<HTMLDivElement>('.comments__list');
      const countEl = commentsSection?.querySelector<HTMLSpanElement>('.comments__count');
      const alertsEl = commentsSection?.querySelector<HTMLDivElement>(`#comment-alerts-${postId}`);

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

      commentForm.addEventListener('submit', async (event) => {
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