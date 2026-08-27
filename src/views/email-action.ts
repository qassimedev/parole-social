import { handleEmailAction, resetPasswordWithCode } from '../lib/auth';
import { describeError } from '../lib/errors';
import { validatePassword, validatePasswordConfirm } from '../lib/validation';
import {
  authShell,
  alertMarkup,
  fieldMarkup,
  setSubmitting,
  spinnerMarkup,
  type ViewContext,
} from './layout';

export function renderEmailAction(ctx: ViewContext): string {
  const mode = ctx.route.params.get('mode');
  const inner =
    mode === 'resetPassword'
      ? `
      <h2 class="auth-card__title">Nouveau mot de passe</h2>
      <p class="auth-card__subtitle">Définissez un nouveau mot de passe pour votre compte.</p>
      <div id="email-action-alerts"></div>
      <form id="reset-action-form" novalidate>
        ${fieldMarkup({
          id: 'reset-action-new',
          label: 'Nouveau mot de passe',
          name: 'password',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
          minlength: 8,
        })}
        ${fieldMarkup({
          id: 'reset-action-confirm',
          label: 'Confirmer le mot de passe',
          name: 'confirm',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
        })}
        <button type="submit" class="btn btn--primary btn--block">
          <span class="btn__label">Enregistrer le mot de passe</span>
        </button>
      </form>
      <p class="auth-card__links"><a href="#/login">Retour à la connexion</a></p>
    `
      : `
      <h2 class="auth-card__title">Vérification de l’adresse email</h2>
      <div id="email-action-alerts" aria-busy="true">${spinnerMarkup()}</div>
      <p class="auth-card__links"><a href="#/login">Se connecter</a></p>
    `;
  return authShell(inner);
}

export function mountEmailAction(root: HTMLElement, ctx: ViewContext): void {
  const mode = ctx.route.params.get('mode');
  const alerts = root.querySelector<HTMLDivElement>('#email-action-alerts');
  if (!alerts) return;

  if (mode === 'resetPassword') {
    const form = root.querySelector<HTMLFormElement>('#reset-action-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = form.password.value;
      const confirm = form.confirm.value;
      const code = ctx.route.params.get('oobCode') ?? '';

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
      setErr('reset-action-new', errors.password ?? '');
      setErr('reset-action-confirm', errors.confirm ?? '');
      if (Object.keys(errors).length > 0) return;

      if (!code) {
        alerts.innerHTML = alertMarkup('Lien incomplet : code manquant.', 'error');
        return;
      }

      setSubmitting(form, true);
      try {
        await resetPasswordWithCode(code, password);
        alerts.innerHTML = alertMarkup('Mot de passe réinitialisé. Vous pouvez vous connecter.', 'success');
        window.setTimeout(() => ctx.navigate('/login'), 1500);
      } catch (err) {
        alerts.innerHTML = alertMarkup(describeError(err), 'error');
      } finally {
        setSubmitting(form, false);
      }
    });
    return;
  }

  // mode === 'verifyEmail' : applique le code puis rafraîchit.
  void (async () => {
    try {
      await handleEmailAction(ctx.route.params);
      if (ctx.session.status === 'signed-in') {
        alerts.innerHTML = alertMarkup('Adresse email vérifiée. Bienvenue sur PAROLE !', 'success');
        window.setTimeout(() => ctx.navigate('/'), 1500);
      } else {
        alerts.innerHTML = alertMarkup('Adresse email vérifiée. Vous pouvez vous connecter.', 'success');
        window.setTimeout(() => ctx.navigate('/login'), 1500);
      }
    } catch (err) {
      alerts.setAttribute('aria-busy', 'false');
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    }
  })();
}