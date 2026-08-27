import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import {
  deleteAvatar,
  getAvatarUrl,
  updateProfile,
  uploadAvatar,
  type UserProfile,
} from '../lib/profile';
import { validateBio, validateDisplayName } from '../lib/validation';
import {
  appShell,
  avatarMarkup,
  escapeHtml,
  fieldMarkup,
  textareaMarkup,
  type ViewContext,
} from './layout';

interface ProfileState {
  mode: 'view' | 'edit';
  profile: UserProfile | null;
}

function publicInfoMarkup(profile: UserProfile): string {
  const createdAt = profile.createdAt?.toDate().toLocaleDateString('fr-FR') ?? '—';
  return `
    <details class="public-info">
      <summary>Consulter mes informations publiques</summary>
      <dl class="info-list">
        <dt>Identifiant (uid)</dt><dd><code>${escapeHtml(profile.uid)}</code></dd>
        <dt>Nom affiché</dt><dd>${escapeHtml(profile.displayName)}</dd>
        <dt>Bio</dt><dd>${profile.bio ? escapeHtml(profile.bio) : '—'}</dd>
        <dt>Photo de profil</dt><dd>${profile.avatarPath ? escapeHtml(profile.avatarPath) : '—'}</dd>
        <dt>Membre depuis</dt><dd>${createdAt}</dd>
      </dl>
      <p class="muted small">Ces informations sont visibles par tout utilisateur connecté.</p>
    </details>
  `;
}

function editFormMarkup(profile: UserProfile): string {
  return `
    <form id="profile-edit-form" novalidate>
      ${fieldMarkup({
        id: 'profile-displayname',
        label: 'Nom affiché',
        name: 'displayName',
        type: 'text',
        autocomplete: 'nickname',
        required: true,
        maxlength: 50,
        value: profile.displayName,
      })}
      ${textareaMarkup({
        id: 'profile-bio',
        label: 'Bio',
        name: 'bio',
        rows: 3,
        maxlength: 160,
        placeholder: 'Quelques mots sur vous…',
        hint: '160 caractères maximum.',
        value: profile.bio ?? '',
      })}
      <div class="field">
        <label class="field__label" for="profile-avatar">Photo de profil</label>
        <input class="field__input field__input--file" id="profile-avatar" name="avatar" type="file" accept="image/*" />
        <span class="field__hint">Image, 5 Mo maximum. Remplace votre photo actuelle.</span>
        ${profile.avatarPath ? `
          <button type="button" id="profile-avatar-remove" class="btn btn--ghost btn--sm">
            <span class="btn__label">Supprimer la photo actuelle</span>
          </button>
        ` : ''}
      </div>
      <div class="actions">
        <button type="submit" class="btn btn--primary">
          <span class="btn__label">Enregistrer</span>
        </button>
        <button type="button" id="profile-cancel" class="btn btn--ghost">
          <span class="btn__label">Annuler</span>
        </button>
      </div>
    </form>
  `;
}

export function renderProfile(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const profile = session.profile;

  let inner: string;
  if (!profile) {
    inner = `
      <section class="card">
        <h2 class="card__title">Profil introuvable</h2>
        <p class="muted">Votre profil n’a pas pu être chargé. Veuillez réessayer plus tard.</p>
      </section>
    `;
  } else {
    const roleLabels: Record<string, string> = { user: 'Utilisateur', moderator: 'Modérateur', admin: 'Administrateur' };
    const roleLabel = roleLabels[profile.role] ?? profile.role;
    inner = `
      <section class="card">
        <div class="profile-header">
          <div id="profile-avatar-slot">${avatarMarkup(null, profile.displayName, 'lg')}</div>
          <div class="profile-header__meta">
            <h2 class="card__title">${escapeHtml(profile.displayName)}</h2>
            <div class="badges">
              <span class="badge">${escapeHtml(roleLabel)}</span>
              <span class="badge${session.emailVerified ? ' badge--ok' : ' badge--warn'}">
                ${session.emailVerified ? 'Email vérifié' : 'Email non vérifié'}
              </span>
            </div>
          </div>
        </div>
        <div id="profile-alerts"></div>
        <div id="profile-body">${viewModeMarkup(ctx)}</div>
      </section>
    `;
  }
  return appShell(inner, 'profile');
}

function viewModeMarkup(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in' || !session.profile) return '';
  const profile = session.profile;
  return `
    <p class="profile-bio">${profile.bio ? escapeHtml(profile.bio) : '<span class="muted">Aucune bio pour le moment.</span>'}</p>
    <dl class="info-list">
      <dt>Adresse email</dt><dd>${escapeHtml(session.email ?? '—')}</dd>
      <dt>Rôle</dt><dd>${escapeHtml(profile.role)}</dd>
      <dt>Statut du compte</dt><dd>${profile.banned ? 'Banni' : profile.moderationStatus === 'none' ? 'Actif' : escapeHtml(profile.moderationStatus)}</dd>
    </dl>
    ${publicInfoMarkup(profile)}
    <div class="actions">
      <button id="profile-edit" class="btn btn--primary">
        <span class="btn__label">Modifier le profil</span>
      </button>
    </div>
  `;
}

export function mountProfile(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const state: ProfileState = { mode: 'view', profile: session.profile };
  if (!state.profile) return;

  const avatarSlot = root.querySelector<HTMLDivElement>('#profile-avatar-slot');
  const body = root.querySelector<HTMLDivElement>('#profile-body');
  const alerts = root.querySelector<HTMLDivElement>('#profile-alerts');
  if (!body || !alerts) return;

  void loadAvatar(state.profile.avatarPath, avatarSlot ?? undefined);

  const render = (): void => {
    body.innerHTML = state.mode === 'edit' ? editFormMarkup(state.profile!) : viewModeMarkup(ctx);
    if (state.mode === 'edit') mountEdit();
  };

  const mountEdit = (): void => {
    const form = root.querySelector<HTMLFormElement>('#profile-edit-form');
    const cancel = root.querySelector<HTMLButtonElement>('#profile-cancel');
    const avatarInput = root.querySelector<HTMLInputElement>('#profile-avatar');

    cancel?.addEventListener('click', () => {
      state.mode = 'view';
      render();
    });

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      alerts.innerHTML = '';
      const displayName = form.displayName.value;
      const bio = form.bio.value;

      const errors: Record<string, string> = {};
      const dnErr = validateDisplayName(displayName);
      if (dnErr) errors.displayName = dnErr;
      const bioErr = validateBio(bio);
      if (bioErr) errors.bio = bioErr;

      const setErr = (id: string, message: string) => {
        const input = root.querySelector<HTMLInputElement>(`#${id}`);
        if (input) input.classList.toggle('field__input--invalid', Boolean(message));
        const existing = root.querySelector(`#${id}-error`);
        if (existing) existing.textContent = message;
      };
      setErr('profile-displayname', errors.displayName ?? '');
      setErr('profile-bio', errors.bio ?? '');
      if (Object.keys(errors).length > 0) return;

      const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      try {
        await updateProfile(session.uid, { displayName, bio });
        notify('Profil mis à jour.', 'success');
        state.profile = { ...state.profile!, displayName: displayName.trim(), bio: bio.trim() };
        state.mode = 'view';
        render();
      } catch (err) {
        alerts.innerHTML = `<div class="alert alert--error" role="alert">${escapeHtml(describeError(err))}</div>`;
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    avatarInput?.addEventListener('change', async () => {
      const file = avatarInput.files?.[0];
      if (!file) return;
      alerts.innerHTML = '';
      try {
        const path = await uploadAvatar(session.uid, file);
        await updateProfile(session.uid, { avatarPath: path });
        state.profile = { ...state.profile!, avatarPath: path };
        await loadAvatar(path, avatarSlot ?? undefined);
        notify('Photo de profil mise à jour.', 'success');
      } catch (err) {
        alerts.innerHTML = `<div class="alert alert--error" role="alert">${escapeHtml(describeError(err))}</div>`;
      }
    });

    const removeAvatarBtn = root.querySelector<HTMLButtonElement>('#profile-avatar-remove');
    removeAvatarBtn?.addEventListener('click', async () => {
      const path = state.profile!.avatarPath;
      if (!path) return;
      alerts.innerHTML = '';
      removeAvatarBtn.disabled = true;
      try {
        await removeAvatar(session.uid, path);
        state.profile = { ...state.profile!, avatarPath: '' };
        await loadAvatar('', avatarSlot ?? undefined);
        notify('Photo de profil supprimée.', 'success');
        render();
      } catch (err) {
        alerts.innerHTML = `<div class="alert alert--error" role="alert">${escapeHtml(describeError(err))}</div>`;
      } finally {
        removeAvatarBtn.disabled = false;
      }
    });
  };

  root.querySelector<HTMLButtonElement>('#profile-edit')?.addEventListener('click', () => {
    state.mode = 'edit';
    render();
  });
}

async function loadAvatar(path: string, slot?: HTMLElement): Promise<void> {
  if (!slot) return;
  const url = path ? await getAvatarUrl(path) : null;
  const name = slot.parentElement?.querySelector('.card__title')?.textContent ?? '';
  slot.innerHTML = avatarMarkup(url, name, 'lg');
}

export async function removeAvatar(uid: string, path: string): Promise<void> {
  await deleteAvatar(path);
  await updateProfile(uid, { avatarPath: '' });
}