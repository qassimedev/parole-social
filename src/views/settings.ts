import { changePassword, signOut, sendVerificationEmail } from '../lib/auth';
import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import { validatePassword, validatePasswordConfirm } from '../lib/validation';
import { fetchBlockedIds, unblockUser } from '../lib/blocks';
import { getFirestoreInstance } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';

const db = getFirestoreInstance();

interface BlockedUserInfo {
  blockedId: string;
  displayName: string;
}

// Liste des utilisateurs bloqués par l'utilisateur courant (requête
// « mes blocages » : where blockerId == moi). Strictement privée —
// les règles refusent de lire les blocages d'autrui.
// Ne pas afficher le blocage : uniquement Débloquer + lien profil.
async function loadBlockedUsers(root: HTMLElement, uid: string): Promise<void> {
  const container = root.querySelector<HTMLDivElement>('#settings-blocked');
  const alerts = root.querySelector<HTMLDivElement>('#settings-alerts');
  if (!container) return;
  container.innerHTML = `<div class="muted">Chargement…</div>`;
  try {
    const blockedIds = await fetchBlockedIds(uid);
    if (blockedIds.size === 0) {
      container.innerHTML = `<p class="muted">Aucun utilisateur bloqué pour le moment.</p>`;
      return;
    }
    const infos: BlockedUserInfo[] = [];
    for (const blockedId of blockedIds) {
      const snap = await getDoc(doc(db, 'users', blockedId));
      const displayName = snap.exists() ? String(snap.data().displayName ?? blockedId) : blockedId;
      infos.push({ blockedId, displayName });
    }
    infos.sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
    container.innerHTML = infos
      .map(
        (info) => `
      <div class="blocked-user" id="blocked-user-${escapeHtml(info.blockedId)}">
        <div class="blocked-user__info">
          <a href="#/u/${escapeHtml(info.blockedId)}">${escapeHtml(info.displayName)}</a>
          <span class="muted small">${escapeHtml(info.blockedId)}</span>
        </div>
        <button type="button" class="btn btn--ghost btn--sm blocked-user__unblock" data-blocked-id="${escapeHtml(info.blockedId)}">
          <span class="btn__label">Débloquer</span>
        </button>
      </div>
    `
      )
      .join('\n');

    container.querySelectorAll<HTMLButtonElement>('.blocked-user__unblock').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const blockedId = btn.dataset.blockedId ?? '';
        if (!blockedId || btn.disabled) return;
        btn.disabled = true;
        try {
          await unblockUser(uid, blockedId);
          container.querySelector(`#blocked-user-${CSS.escape(blockedId)}`)?.remove();
          notify('Utilisateur débloqué.', 'success');
          if (container.querySelectorAll('.blocked-user').length === 0) {
            container.innerHTML = `<p class="muted">Aucun utilisateur bloqué pour le moment.</p>`;
          }
        } catch (err) {
          if (alerts) alerts.innerHTML = alertMarkup(describeError(err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="alert alert--error" role="alert">${escapeHtml(describeError(err))}</div>`;
  }
}
import {
  appShell,
  alertMarkup,
  escapeHtml,
  fieldMarkup,
  isModeratorRole,
  type ViewContext,
} from './layout';

export function renderSettings(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');

  const profile = session.profile;
  const roleLabels: Record<string, string> = { user: 'Utilisateur', moderator: 'Modérateur', admin: 'Administrateur' };
  const roleLabel = profile ? roleLabels[profile.role] ?? profile.role : '—';

  const inner = `
    <section class="card">
      <h2 class="card__title">Paramètres du compte</h2>
      <dl class="info-list">
        <dt>Adresse email</dt><dd>${escapeHtml(session.email ?? '—')}</dd>
        <dt>Vérification</dt>
        <dd>
          ${session.emailVerified
            ? '<span class="badge badge--ok">Email vérifié</span>'
            : '<span class="badge badge--warn">Email non vérifié</span>'}
          ${session.emailVerified ? '' : '<button id="settings-resend-verify" class="btn btn--ghost btn--sm">Renvoyer l’email de vérification</button>'}
        </dd>
        <dt>Rôle</dt><dd>${escapeHtml(roleLabel)}</dd>
      </dl>
      <div id="settings-alerts"></div>
    </section>

    <section class="card">
      <h2 class="card__title">Changer le mot de passe</h2>
      <form id="settings-password-form" novalidate>
        ${fieldMarkup({
          id: 'settings-current',
          label: 'Mot de passe actuel',
          name: 'currentPassword',
          type: 'password',
          autocomplete: 'current-password',
          required: true,
        })}
        ${fieldMarkup({
          id: 'settings-new',
          label: 'Nouveau mot de passe',
          name: 'newPassword',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
          minlength: 8,
        })}
        ${fieldMarkup({
          id: 'settings-confirm',
          label: 'Confirmer le nouveau mot de passe',
          name: 'confirm',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
        })}
        <button type="submit" class="btn btn--primary">
          <span class="btn__label">Mettre à jour le mot de passe</span>
        </button>
      </form>
    </section>

    <section class="card">
      <h2 class="card__title">Utilisateurs bloqués</h2>
      <p class="muted small">
        Les personnes bloquées ne pourront pas entrer en contact avec vous
        (messagerie notamment). Cette liste est strictement personnelle.
      </p>
      <div id="settings-blocked">
        <div class="muted">Chargement…</div>
      </div>
    </section>

    <section class="card">
      <h2 class="card__title">Session</h2>
      <button id="settings-signout" class="btn btn--danger">
        <span class="btn__label">Se déconnecter</span>
      </button>
      <p class="muted small">Votre session est conservée localement jusqu’à la déconnexion.</p>
    </section>

    <section class="card">
      <h2 class="card__title">Champs protégés</h2>
      <p class="muted small">
        Certains champs sont gérés par le système et ne peuvent pas être modifiés depuis
        l’application : rôle, statut administrateur, statut de bannissement, compteurs
        (publications, signalements, likes, abonnements/abonnés) et données de modération.
        Toute tentative de modification directe est refusée par les règles de sécurité.
      </p>
    </section>
  `;
  return appShell(inner, 'settings', isModeratorRole(profile?.role), profile?.notificationCount ?? 0);
}

export function mountSettings(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const uid = session.uid;
  if (!uid) return;
  const alerts = root.querySelector<HTMLDivElement>('#settings-alerts');
  const passwordForm = root.querySelector<HTMLFormElement>('#settings-password-form');
  const signoutBtn = root.querySelector<HTMLButtonElement>('#settings-signout');
  const resendBtn = root.querySelector<HTMLButtonElement>('#settings-resend-verify');

  resendBtn?.addEventListener('click', async () => {
    if (!alerts) return;
    alerts.innerHTML = '';
    try {
      await sendVerificationEmail();
      alerts.innerHTML = alertMarkup('Email de vérification renvoyé. Vérifiez votre boîte mail.', 'success');
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    }
  });

  passwordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!alerts) return;
    alerts.innerHTML = '';
    const currentPassword = passwordForm.currentPassword.value;
    const newPassword = passwordForm.newPassword.value;
    const confirm = passwordForm.confirm.value;

    const errors: Record<string, string> = {};
    const pwErr = validatePassword(newPassword);
    if (pwErr) errors.newPassword = pwErr;
    if (!pwErr) {
      const cfErr = validatePasswordConfirm(newPassword, confirm);
      if (cfErr) errors.confirm = cfErr;
    }
    if (currentPassword.length === 0) errors.currentPassword = 'Mot de passe actuel requis.';

    const setErr = (id: string, message: string) => {
      const input = root.querySelector<HTMLInputElement>(`#${id}`);
      if (input) input.classList.toggle('field__input--invalid', Boolean(message));
      const existing = root.querySelector(`#${id}-error`);
      if (existing) existing.textContent = message;
    };
    setErr('settings-current', errors.currentPassword ?? '');
    setErr('settings-new', errors.newPassword ?? '');
    setErr('settings-confirm', errors.confirm ?? '');
    if (Object.keys(errors).length > 0) return;

    const submitBtn = passwordForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await changePassword(currentPassword, newPassword);
      passwordForm.reset();
      alerts.innerHTML = alertMarkup('Mot de passe mis à jour.', 'success');
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  signoutBtn?.addEventListener('click', async () => {
    try {
      await signOut();
      notify('Vous êtes déconnecté.', 'info');
      ctx.navigate('/login');
    } catch (err) {
      if (alerts) alerts.innerHTML = alertMarkup(describeError(err), 'error');
    }
  });

  void loadBlockedUsers(root, uid);
}