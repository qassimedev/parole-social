// ============================================================
// PAROLE - Interface de modération (modérateurs & admins)
//
// Accessible UNIQUEMENT aux rôles moderator/admin (l'accès est
// contrôlé dans views/index.ts ET par les Cloud Functions). Le
// client ne fait JAMAIS confiance au rôle affiché : toutes les
// actions sensibles passent par les callables `moderatePost` et
// `sanctionUser` (Admin SDK) qui valident les rôles côté serveur
// et tracent chaque action dans `auditLogs`.
// ============================================================

import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import { fetchAuthorNames, fetchComment, type Comment } from '../lib/comments';
import { fetchPost, type Post } from '../lib/posts';
import {
  fetchReports,
  REPORT_REASON_LABELS,
  type Report,
  type ReportTargetType,
} from '../lib/reports';
import { getFunctionsInstance } from '../lib/firebase';
import { httpsCallable } from 'firebase/functions';
import {
  appShell,
  alertMarkup,
  escapeHtml,
  fieldMarkup,
  spinnerMarkup,
  setSubmitting,
  type ViewContext,
} from './layout';

const STATUS_LABELS: Record<string, string> = {
  pending: 'En attente',
  reviewing: 'En cours d’examen',
  resolved: 'Résolu',
  dismissed: 'Classé sans suite',
};

const MODERATION_ACTIONS = [
  { value: 'mask', label: 'Masquer', kind: 'warn' as const },
  { value: 'restore', label: 'Rétablir', kind: 'primary' as const },
  { value: 'maintain', label: 'Maintenir', kind: 'ghost' as const },
  { value: 'remove', label: 'Retirer', kind: 'danger' as const },
];

const VALID_ACTIONS = MODERATION_ACTIONS.map((a) => a.value);

interface ModerateResult {
  ok: boolean;
  postId: string;
  moderationStatus: string;
}

interface SanctionResult {
  ok: boolean;
  userId: string;
  action: string;
}

interface CommentModerateResult {
  ok: boolean;
  commentId: string;
  moderationStatus: string;
}

const functions = getFunctionsInstance();
const moderatePost = httpsCallable<{ postId: string; action: string; reason?: string }, ModerateResult>(
  functions,
  'moderatePost'
);
const moderateComment = httpsCallable<
  { commentId: string; action: string; reason?: string },
  CommentModerateResult
>(functions, 'moderateComment');
const sanctionUser = httpsCallable<
  { userId: string; action: string; reason?: string; role?: string },
  SanctionResult
>(functions, 'sanctionUser');

function reportsStatusMarkup(): string {
  return `<div class="mod-reports__status">${spinnerMarkup()}<span class="muted">Chargement des signalements…</span></div>`;
}

function reportsEmptyMarkup(): string {
  return `<p class="muted">Aucun signalement pour le moment.</p>`;
}

function reportsErrorMarkup(message: string): string {
  return `
    <div class="mod-reports__error" role="alert">
      <div class="alert alert--error">${escapeHtml(message)}</div>
      <button type="button" id="mod-reports-retry" class="btn btn--ghost btn--sm">
        <span class="btn__label">Réessayer</span>
      </button>
    </div>
  `;
}

function reportTargetLabel(targetType: ReportTargetType): string {
  switch (targetType) {
    case 'post':
      return 'Publication';
    case 'comment':
      return 'Commentaire';
    case 'user':
      return 'Utilisateur';
  }
}

function reportMarkup(
  report: Report,
  post: Post | null | undefined,
  comment: Comment | null | undefined,
  reporterName: string,
  isAdmin: boolean
): string {
  const reasonLabel = REPORT_REASON_LABELS[report.reason] ?? report.reason;
  const statusLabel = STATUS_LABELS[report.status] ?? report.status;
  const statusBadge =
    report.status === 'pending'
      ? ' badge--warn'
      : report.status === 'resolved'
        ? ' badge--ok'
        : '';
  const date =
    report.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';

  const targetBlock =
    report.targetType === 'post'
      ? post
        ? `
        <div class="report-post">
          <p class="report-post__content">${escapeHtml(post.content)}</p>
          <p class="report-post__meta muted">
            Auteur : ${escapeHtml(post.authorName || post.authorId)} ·
            Statut : ${escapeHtml(post.moderationStatus ?? 'visible')}
          </p>
        </div>`
        : `<p class="muted">Publication introuvable ou supprimée.</p>`
      : report.targetType === 'comment'
        ? comment && comment.content
          ? `
        <div class="report-post">
          <p class="report-post__content">${escapeHtml(comment.content)}</p>
          <p class="report-post__meta muted">
            Auteur : ${escapeHtml(comment.authorId)} ·
            Statut : ${escapeHtml(comment.moderationStatus ?? 'visible')}
          </p>
        </div>`
          : `<p class="muted">Commentaire introuvable ou supprimé.</p>`
        : `<p class="muted">Cible : ${escapeHtml(reportTargetLabel(report.targetType))} ${escapeHtml(report.targetId)}</p>`;

  const actionButtons = report.targetType === 'user'
    ? `
      <button type="button" class="btn btn--warn btn--sm mod-action"
        data-user-id="${escapeHtml(report.targetId)}" data-action="warn">
        <span class="btn__label">Avertir (warn)</span>
      </button>
      ${isAdmin ? `
      <button type="button" class="btn btn--danger btn--sm mod-action"
        data-user-id="${escapeHtml(report.targetId)}" data-action="ban">
        <span class="btn__label">Bannir (ban)</span>
      </button>` : ''}`
    : MODERATION_ACTIONS.map(
        (a) => `
        <button type="button" class="btn btn--${a.kind} btn--sm mod-action"
          data-target-type="${report.targetType}" data-target-id="${escapeHtml(report.targetId)}" data-action="${a.value}">
          <span class="btn__label">${a.label}</span>
        </button>`
      ).join('\n');

  const hasResolvableTarget =
    (report.targetType === 'post' && post) ||
    (report.targetType === 'comment' && comment && comment.content) ||
    report.targetType === 'user';

  const actions = hasResolvableTarget
    ? `<div class="actions">${actionButtons}</div>`
    : '';

  return `
    <article class="report-item">
      <div class="report-item__head">
        <span class="badge">${escapeHtml(reportTargetLabel(report.targetType))}</span>
        <span class="badge">${escapeHtml(reasonLabel)}</span>
        <span class="badge${statusBadge}">${escapeHtml(statusLabel)}</span>
        <span class="report-item__date muted">${escapeHtml(date)}</span>
      </div>
      <p class="report-item__reporter">Signalé par : ${escapeHtml(reporterName)}</p>
      ${report.details ? `<p class="report-item__details">${escapeHtml(report.details)}</p>` : ''}
      ${targetBlock}
      ${actions}
    </article>
  `;
}

export function renderModeration(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const role = session.profile?.role;
  if (role !== 'moderator' && role !== 'admin') {
    return appShell('<p>Accès réservé aux modérateurs.</p>', 'home', false);
  }
  const isAdmin = role === 'admin';

  const inner = `
    <section class="card">
      <h2 class="card__title">Modération</h2>
      <div class="badges">
        <span class="badge">${isAdmin ? 'Administrateur' : 'Modérateur'}</span>
        <span class="badge badge--warn">Toutes les actions sont tracées dans l’audit log.</span>
      </div>
    </section>

    <section class="card">
      <h2 class="card__title">Signalements</h2>
      <div id="mod-reports">${reportsStatusMarkup()}</div>
    </section>

    <section class="card">
      <h2 class="card__title">Sanctions utilisateur</h2>
      <p class="muted">
        Les sanctions passent par la Cloud Function <code>sanctionUser</code> qui vérifie le rôle
        côté serveur. Avertir : modérateur &amp; admin. Bannir, débannir ou changer le rôle : admin.
      </p>
      <form id="sanction-form" novalidate>
        ${fieldMarkup({
          id: 'sanction-user-id',
          label: 'Identifiant utilisateur (uid)',
          name: 'userId',
          type: 'text',
          required: true,
          placeholder: 'uid de l’utilisateur…',
        })}
        <div class="field">
          <label class="field__label" for="sanction-action">Action</label>
          <select class="field__input" id="sanction-action" name="action">
            <option value="warn">Avertir (warn)</option>
            ${isAdmin ? '<option value="ban">Bannir</option><option value="unban">Débannir</option><option value="setRole">Changer de rôle</option>' : ''}
          </select>
        </div>
        <div class="field" id="sanction-role-field" hidden>
          <label class="field__label" for="sanction-role">Nouveau rôle</label>
          <select class="field__input" id="sanction-role" name="role">
            <option value="user">Utilisateur</option>
            <option value="moderator">Modérateur</option>
            <option value="admin">Administrateur</option>
          </select>
        </div>
        ${fieldMarkup({
          id: 'sanction-reason',
          label: 'Motif',
          name: 'reason',
          type: 'text',
          required: true,
          maxlength: 200,
          placeholder: 'Justification (visible dans l’audit log)',
        })}
        <div id="sanction-alerts"></div>
        <div class="actions">
          <button type="submit" class="btn btn--primary">
            <span class="btn__label">Appliquer la sanction</span>
          </button>
        </div>
      </form>
    </section>
  `;
  return appShell(inner, 'moderation', true, session.profile?.notificationCount ?? 0);
}

export function mountModeration(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const role = session.profile?.role;
  if (role !== 'moderator' && role !== 'admin') return;

  const reportsEl = root.querySelector<HTMLDivElement>('#mod-reports');
  const sanctionForm = root.querySelector<HTMLFormElement>('#sanction-form');
  const sanctionAlerts = root.querySelector<HTMLDivElement>('#sanction-alerts');
  const isAdmin = role === 'admin';

  const loadReports = async (): Promise<void> => {
    if (!reportsEl) return;
    reportsEl.innerHTML = reportsStatusMarkup();
    try {
      const reports = await fetchReports();
      const postTargets = reports.filter((r) => r.targetType === 'post');
      const commentTargets = reports.filter((r) => r.targetType === 'comment');
      const [postEntries, commentEntries, authorNames] = await Promise.all([
        Promise.all(
          postTargets.map(async (r) => ({ reportId: r.id, post: await fetchPost(r.targetId) }))
        ),
        Promise.all(
          commentTargets.map(async (r) => ({ reportId: r.id, comment: await fetchComment(r.targetId) }))
        ),
        fetchAuthorNames(reports.map((r) => r.reporterId)),
      ]);
      const postMap = new Map(postEntries.map((p) => [p.reportId, p.post]));
      const commentMap = new Map(commentEntries.map((c) => [c.reportId, c.comment]));

      if (reports.length === 0) {
        reportsEl.innerHTML = reportsEmptyMarkup();
        return;
      }
      reportsEl.innerHTML = reports
        .map((report) =>
          reportMarkup(
            report,
            postMap.get(report.id),
            commentMap.get(report.id),
            authorNames.get(report.reporterId) ?? report.reporterId,
            isAdmin
          )
        )
        .join('\n');
      bindModerationActions(reportsEl, loadReports);
    } catch (err) {
      reportsEl.innerHTML = reportsErrorMarkup(describeError(err));
      reportsEl.querySelector<HTMLButtonElement>('#mod-reports-retry')?.addEventListener('click', () => {
        void loadReports();
      });
    }
  };

  const bindModerationActions = (container: HTMLElement, reload: () => Promise<void>): void => {
    container.querySelectorAll<HTMLButtonElement>('.mod-action').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetType = btn.dataset.targetType as 'post' | 'comment' | 'user' | undefined;
        const targetId = btn.dataset.targetId;
        const userId = btn.dataset.userId;
        const action = btn.dataset.action;
        if (!action) return;
        btn.disabled = true;
        try {
          if (targetType === 'comment' && targetId) {
            await moderateComment({ commentId: targetId, action });
          } else if (targetType === 'post' && targetId && VALID_ACTIONS.includes(action)) {
            await moderatePost({ postId: targetId, action });
          } else if (userId && (action === 'warn' || action === 'ban')) {
            await sanctionUser({ userId, action });
          } else {
            return;
          }
          notify('Action de modération appliquée.', 'success');
          await reload();
        } catch (err) {
          notify(describeError(err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  };

  const actionSelect = root.querySelector<HTMLSelectElement>('#sanction-action');
  const roleField = root.querySelector<HTMLElement>('#sanction-role-field');
  actionSelect?.addEventListener('change', () => {
    if (roleField) roleField.hidden = actionSelect.value !== 'setRole';
  });

  sanctionForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!sanctionAlerts) return;
    sanctionAlerts.innerHTML = '';

    const userIdEl = sanctionForm.elements.namedItem('userId') as HTMLInputElement;
    const actionEl = sanctionForm.elements.namedItem('action') as HTMLSelectElement;
    const reasonEl = sanctionForm.elements.namedItem('reason') as HTMLInputElement;
    const roleEl = sanctionForm.elements.namedItem('role') as HTMLSelectElement;

    const userId = userIdEl.value.trim();
    const action = actionEl.value;
    const reason = reasonEl.value.trim();
    const roleValue = roleEl.value;

    if (!userId) {
      sanctionAlerts.innerHTML = alertMarkup('Identifiant utilisateur requis.', 'error');
      return;
    }
    if (action === 'setRole' && roleValue !== 'user' && roleValue !== 'moderator' && roleValue !== 'admin') {
      sanctionAlerts.innerHTML = alertMarkup('Rôle invalide.', 'error');
      return;
    }

    setSubmitting(sanctionForm, true);
    try {
      await sanctionUser({
        userId,
        action,
        reason,
        ...(action === 'setRole' ? { role: roleValue } : {}),
      });
      notify('Sanction appliquée.', 'success');
      sanctionForm.reset();
      if (roleField) roleField.hidden = true;
    } catch (err) {
      sanctionAlerts.innerHTML = alertMarkup(describeError(err), 'error');
    } finally {
      setSubmitting(sanctionForm, false);
    }
  });

  void loadReports();
}