import { getEmulatorOobCode, resetPasswordWithCode, sendPasswordReset } from '../lib/auth';
import { describeError } from '../lib/errors';
import { validateEmail, validatePassword, validatePasswordConfirm } from '../lib/validation';
import {
  authShell,
  alertMarkup,
  fieldMarkup,
  setSubmitting,
  type ViewContext,
} from './layout';

export function renderForgotPassword(_ctx: ViewContext): string {
  const inner = `
    <h2 class="auth-card__title">Mot de passe oublié</h2>
    <p class="auth-card__subtitle">
      Saisissez votre adresse email : nous vous enverrons un lien de réinitialisation.
    </p>
    <div id="reset-alerts"></div>
    <form id="reset-request-form" novalidate>
      ${fieldMarkup({
        id: 'reset-email',
        label: 'Adresse email',
        name: 'email',
        type: 'email',
        autocomplete: 'email',
        required: true,
        placeholder: 'vous@exemple.fr',
      })}
      <button type="submit" class="btn btn--primary btn--block">
        <span class="btn__label">Envoyer le lien</span>
      </button>
    </form>
    <div id="reset-emulator-panel" hidden></div>
    <p class="auth-card__links">
      <a href="#/login">Retour à la connexion</a>
    </p>
  `;
  return authShell(inner);
}

function emulatorPanelHtml(): string {
  return `
    <div class="dev-panel">
      <h3 class="dev-panel__title">Émulateur uniquement</h3>
      <p class="muted">Récupère le code de l’émulateur et définit un nouveau mot de passe sans email réel.</p>
      <form id="reset-complete-form" novalidate>
        ${fieldMarkup({
          id: 'reset-new',
          label: 'Nouveau mot de passe',
          name: 'password',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
          minlength: 8,
        })}
        ${fieldMarkup({
          id: 'reset-confirm',
          label: 'Confirmer le mot de passe',
          name: 'confirm',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
        })}
        <button type="submit" class="btn btn--primary btn--block">
          <span class="btn__label">Réinitialiser (émulateur)</span>
        </button>
      </form>
    </div>
  `;
}

export function mountForgotPassword(root: HTMLElement, ctx: ViewContext): void {
  const requestForm = root.querySelector<HTMLFormElement>('#reset-request-form');
  const alerts = root.querySelector<HTMLDivElement>('#reset-alerts');
  const emulatorPanel = root.querySelector<HTMLDivElement>('#reset-emulator-panel');
  if (!requestForm || !alerts || !emulatorPanel) return;

  requestForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    alerts.innerHTML = '';
    const email = requestForm.email.value;
    const error = validateEmail(email);
    const input = root.querySelector<HTMLInputElement>('#reset-email');
    if (input) input.classList.toggle('field__input--invalid', Boolean(error));
    if (error) {
      const existing = root.querySelector('#reset-email-error');
      if (existing) existing.textContent = error;
      return;
    }

    setSubmitting(requestForm, true);
    try {
      await sendPasswordReset(email);
      alerts.innerHTML = alertMarkup('Lien de réinitialisation envoyé. Vérifiez votre boîte mail.', 'success');
      if (ctx.isEmulator) {
        emulatorPanel.innerHTML = emulatorPanelHtml();
        emulatorPanel.hidden = false;
        mountEmulatorCompletion(root, email, alerts);
      }
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    } finally {
      setSubmitting(requestForm, false);
    }
  });
}

function mountEmulatorCompletion(root: HTMLElement, email: string, alerts: HTMLDivElement): void {
  const form = root.querySelector<HTMLFormElement>('#reset-complete-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = form.password.value;
    const confirm = form.confirm.value;

    const errors: Record<string, string> = {};
    const pwError = validatePassword(password);
    if (pwError) errors.password = pwError;
    if (!pwError) {
      const cfError = validatePasswordConfirm(password, confirm);
      if (cfError) errors.confirm = cfError;
    }

    const setErr = (id: string, message: string) => {
      const input = root.querySelector<HTMLInputElement>(`#${id}`);
      if (input) input.classList.toggle('field__input--invalid', Boolean(message));
      const existing = root.querySelector(`#${id}-error`);
      if (existing) existing.textContent = message;
    };
    setErr('reset-new', errors.password ?? '');
    setErr('reset-confirm', errors.confirm ?? '');
    if (Object.keys(errors).length > 0) return;

    setSubmitting(form, true);
    try {
      const code = await getEmulatorOobCode('resetPassword', email);
      if (!code) throw new Error('Aucun code de réinitialisation trouvé. Envoyez d’abord le lien.');
      await resetPasswordWithCode(code, password);
      alerts.innerHTML = alertMarkup('Mot de passe réinitialisé. Vous pouvez vous connecter.', 'success');
      window.setTimeout(() => (window.location.hash = '#/login'), 1500);
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    } finally {
      setSubmitting(form, false);
    }
  });
}