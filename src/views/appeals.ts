// ============================================================
// PAROLE - Recours contre les sanctions (vue utilisateur) — Phase 9 Lot 4
//
// Route `#/appeals` : permet de contester une sanction de modération
// (post/commentaire masqué ou retiré, compte averti/suspendu) et de
// suivre le statut de ses recours (pending / accepted / rejected).
// Le dépôt n'écrit QUE les champs autorisés par les règles et reste
// soumis à la vérification serveur (cible appartenant à l'appelant,
// réellement sanctionnée, sanctionType cohérent, id déterministe).
// La DÉCISION est prise exclusivement côté modération via la Cloud
// Function `reviewAppeal` (jamais ici) ; le client ne fait que
// soumettre et consulter.
// ============================================================

import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import {
  APPEAL_STATUS_LABELS,
  APPEAL_TARGET_LABELS,
  APPEAL_TARGET_SANCTION_TYPES,
  SANCTION_TYPE_LABELS,
  fetchMyAppeals,
  readTargetSanctionType,
  submitAppeal,
  type Appeal,
  type AppealTargetType,
} from '../lib/appeals';
import {
  appShell,
  alertMarkup,
  escapeHtml,
  fieldMarkup,
  isModeratorRole,
  spinnerMarkup,
  textareaMarkup,
  type ViewContext,
} from './layout';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; appeals: Appeal[] };

function statusBadgeClass(status: Appeal['status']): string {
  if (status === 'pending') return ' badge--warn';
  if (status === 'accepted') return ' badge--ok';
  return '';
}

function appealItemMarkup(appeal: Appeal): string {
  const date =
    appeal.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';
  const targetLabel = APPEAL_TARGET_LABELS[appeal.targetType] ?? appeal.targetType;
  const sanctionLabel = SANCTION_TYPE_LABELS[appeal.sanctionType] ?? appeal.sanctionType;
  const statusLabel = APPEAL_STATUS_LABELS[appeal.status] ?? appeal.status;
  return `
    <article class="report-item">
      <div class="report-item__head">
        <span class="badge">${escapeHtml(targetLabel)}</span>
        <span class="badge">${escapeHtml(sanctionLabel)}</span>
        <span class="badge${statusBadgeClass(appeal.status)}">${escapeHtml(statusLabel)}</span>
        <span class="report-item__date muted">${escapeHtml(date)}</span>
      </div>
      <p class="report-item__reporter">Cible : <code>${escapeHtml(appeal.targetId)}</code> · ID du recours : <code>${escapeHtml(appeal.appealId)}</code></p>
      <p class="report-item__details">${escapeHtml(appeal.reason)}</p>
      ${appeal.status !== 'pending'
        ? `<p class="report-item__details muted">Décision rendue le ${
            appeal.reviewedAt
              ? escapeHtml(appeal.reviewedAt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }))
              : '—'
          }${appeal.reviewedBy ? ` par <code>${escapeHtml(appeal.reviewedBy)}</code>` : ''}.</p>`
        : ''}
    </article>
  `;
}

function myAppealsMarkup(state: LoadState): string {
  if (state.kind === 'loading') {
    return `<div class="mod-reports__status">${spinnerMarkup()}<span class="muted">Chargement de vos recours…</span></div>`;
  }
  if (state.kind === 'error') {
    return `
      <div class="mod-reports__error" role="alert">
        <div class="alert alert--error">${escapeHtml(state.message)}</div>
        <button type="button" id="appeals-list-retry" class="btn btn--ghost btn--sm">
          <span class="btn__label">Réessayer</span>
        </button>
      </div>
    `;
  }
  if (state.kind === 'empty') {
    return `<p class="muted">Aucun recours pour le moment. Si une de vos publications, un de vos commentaires ou votre compte a été sanctionné, déposez un recours ci-dessus.</p>`;
  }
  return state.appeals.map(appealItemMarkup).join('\n');
}

function sanctionTypeSelectMarkup(targetType: AppealTargetType): string {
  const options = APPEAL_TARGET_SANCTION_TYPES[targetType];
  return `
    <div class="field">
      <label class="field__label" for="appeal-sanction-type">Type de sanction contestée</label>
      <select class="field__input" id="appeal-sanction-type" name="sanctionType">
        ${options
          .map(
            (value) =>
              `<option value="${escapeHtml(value)}">${escapeHtml(SANCTION_TYPE_LABELS[value] ?? value)}</option>`
          )
          .join('\n')}
      </select>
      <span class="field__hint" id="appeal-sanction-hint">Vérifié côté serveur contre l’état réel de la cible.</span>
    </div>
  `;
}

export function renderAppeals(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');

  const inner = `
    <section class="card">
      <h2 class="card__title">Recours</h2>
      <p class="muted">
        Vous pouvez contester une sanction de modération : publication masquée ou retirée,
        commentaire masqué ou retiré, compte averti ou suspendu. Un seul recours par cible
        (identifiant déterministe). La décision est prise par la modération.
      </p>
      <div id="appeals-alerts"></div>
      <form id="appeal-form" novalidate>
        <div class="field">
          <label class="field__label" for="appeal-target-type">Type de cible</label>
          <select class="field__input" id="appeal-target-type" name="targetType">
            <option value="post">Publication</option>
            <option value="comment">Commentaire</option>
            <option value="user">Mon compte</option>
          </select>
        </div>
        ${fieldMarkup({
          id: 'appeal-target-id',
          label: 'Identifiant de la cible',
          name: 'targetId',
          type: 'text',
          required: true,
          placeholder: 'id du post, du commentaire, ou votre uid',
          hint: 'Pour un compte, utilisez votre identifiant (uid).',
        })}
        ${sanctionTypeSelectMarkup('post')}
        ${textareaMarkup({
          id: 'appeal-reason',
          name: 'reason',
          label: 'Justification',
          required: true,
          rows: 4,
          maxlength: 2000,
          placeholder: 'Expliquez pourquoi cette sanction devrait être revue…',
        })}
        <div class="actions">
          <button type="submit" class="btn btn--primary">
            <span class="btn__label">Soumettre le recours</span>
          </button>
        </div>
      </form>
    </section>

    <section class="card">
      <h2 class="card__title">Mes recours</h2>
      <div id="appeals-list">${myAppealsMarkup({ kind: 'loading' })}</div>
    </section>
  `;
  return appShell(inner, 'appeals', isModeratorRole(session.profile?.role), session.profile?.notificationCount ?? 0, session.profile?.messageCount ?? 0);
}

export function mountAppeals(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const uid = session.uid;
  if (!uid) return;

  const alerts = root.querySelector<HTMLDivElement>('#appeals-alerts');
  const listEl = root.querySelector<HTMLDivElement>('#appeals-list');
  const form = root.querySelector<HTMLFormElement>('#appeal-form');
  const targetTypeEl = root.querySelector<HTMLSelectElement>('#appeal-target-type');
  const targetIdEl = root.querySelector<HTMLInputElement>('#appeal-target-id');
  const sanctionSelect = root.querySelector<HTMLSelectElement>('#appeal-sanction-type');
  const sanctionHint = root.querySelector<HTMLElement>('#appeal-sanction-hint');
  const reasonEl = form?.elements.namedItem('reason') as HTMLTextAreaElement | null;

  if (!alerts || !listEl || !form || !targetTypeEl || !targetIdEl || !sanctionSelect) return;

  const reloadList = async (): Promise<void> => {
    listEl.innerHTML = myAppealsMarkup({ kind: 'loading' });
    try {
      const appeals = await fetchMyAppeals(uid);
      if (appeals.length === 0) {
        listEl.innerHTML = myAppealsMarkup({ kind: 'empty' });
      } else {
        listEl.innerHTML = myAppealsMarkup({ kind: 'ready', appeals });
      }
    } catch (err) {
      listEl.innerHTML = myAppealsMarkup({ kind: 'error', message: describeError(err) });
      listEl.querySelector<HTMLButtonElement>('#appeals-list-retry')?.addEventListener('click', () => {
        void reloadList();
      });
    }
  };

  // Options de sanction contextuelles à la cible.
  const updateSanctionOptions = (targetType: AppealTargetType): void => {
    const options = APPEAL_TARGET_SANCTION_TYPES[targetType];
    sanctionSelect.innerHTML = options
      .map(
        (value) =>
          `<option value="${escapeHtml(value)}">${escapeHtml(SANCTION_TYPE_LABELS[value] ?? value)}</option>`
      )
      .join('\n');
    if (sanctionHint) {
      sanctionHint.textContent =
        targetType === 'user'
          ? 'Votre compte : avertissement ou suspension. Vérifié côté serveur.'
          : 'Masquée / Retirée. Vérifié côté serveur contre l’état réel de la cible.';
    }
  };

  // Pré-remplissage du type de sanction depuis l'état réel de la
  // cible quand elle est lisible (post, compte ; commentaire parfois
  // illisible car masqué). Jamais une autorité : la règle reste le
  // juge final.
  const prefillSanctionType = async (): Promise<void> => {
    const targetType = targetTypeEl.value as AppealTargetType;
    const targetId = targetIdEl.value.trim();
    if (!targetId) return;
    try {
      const derived = await readTargetSanctionType(targetType, targetId, uid);
      if (derived && APPEAL_TARGET_SANCTION_TYPES[targetType].includes(derived)) {
        sanctionSelect.value = derived;
        if (sanctionHint) sanctionHint.textContent = `Sanction détectée : ${SANCTION_TYPE_LABELS[derived] ?? derived}.`;
      } else if (derived === null) {
        if (sanctionHint) sanctionHint.textContent = 'Cible non sanctionnée détectée, ou non lisible : sélectionnez manuellement.';
      }
    } catch {
      // Lecture non décisive : on laisse le choix manuel.
    }
  };

  targetTypeEl.addEventListener('change', () => {
    updateSanctionOptions(targetTypeEl.value as AppealTargetType);
    void prefillSanctionType();
  });
  targetIdEl.addEventListener('change', () => {
    void prefillSanctionType();
  });
  targetIdEl.addEventListener('blur', () => {
    void prefillSanctionType();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alerts.innerHTML = '';
    const targetType = targetTypeEl.value as AppealTargetType;
    const targetId = targetIdEl.value.trim();
    const sanctionType = sanctionSelect.value;
    const reason = reasonEl?.value.trim() ?? '';

    if (!targetId) {
      alerts.innerHTML = alertMarkup('Identifiant de la cible requis.', 'error');
      return;
    }
    if (reason.length === 0) {
      alerts.innerHTML = alertMarkup('Justification requise.', 'error');
      return;
    }

    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const appealId = await submitAppeal(uid, targetType, targetId, reason, sanctionType);
      notify('Recours soumis. Il sera examiné par la modération.', 'success');
      alerts.innerHTML = alertMarkup(`Recours soumis (${appealId}).`, 'success');
      if (reasonEl) reasonEl.value = '';
      await reloadList();
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  void updateSanctionOptions(targetTypeEl.value as AppealTargetType);
  void reloadList();
}