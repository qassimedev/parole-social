import { signIn } from '../lib/auth';
import { describeError } from '../lib/errors';
import { validateLoginForm } from '../lib/validation';
import {
  authShell,
  alertMarkup,
  fieldMarkup,
  setSubmitting,
  type ViewContext,
} from './layout';

export function renderLogin(_ctx: ViewContext): string {
  const inner = `
    <h2 class="auth-card__title">Connexion</h2>
    <p class="auth-card__subtitle">Retrouvez votre espace.</p>
    <div id="login-alerts"></div>
    <form id="login-form" novalidate>
      ${fieldMarkup({
        id: 'login-email',
        label: 'Adresse email',
        name: 'email',
        type: 'email',
        autocomplete: 'email',
        required: true,
        placeholder: 'vous@exemple.fr',
      })}
      ${fieldMarkup({
        id: 'login-password',
        label: 'Mot de passe',
        name: 'password',
        type: 'password',
        autocomplete: 'current-password',
        required: true,
        placeholder: '••••••••',
      })}
      <button type="submit" class="btn btn--primary btn--block">
        <span class="btn__label">Se connecter</span>
      </button>
    </form>
    <p class="auth-card__links">
      <a href="#/forgot-password">Mot de passe oublié ?</a>
      <span aria-hidden="true">·</span>
      <a href="#/signup">Créer un compte</a>
    </p>
  `;
  return authShell(inner);
}

export function mountLogin(root: HTMLElement, ctx: ViewContext): void {
  const form = root.querySelector<HTMLFormElement>('#login-form');
  const alerts = root.querySelector<HTMLDivElement>('#login-alerts');
  if (!form || !alerts) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alerts.innerHTML = '';
    const email = form.email.value;
    const password = form.password.value;

    const errors = validateLoginForm({ email, password });
    const emailField = form.querySelector('#login-email');
    const passwordField = form.querySelector('#login-password');
    if (emailField) emailField.classList.toggle('field__input--invalid', Boolean(errors.email));
    if (passwordField) passwordField.classList.toggle('field__input--invalid', Boolean(errors.password));
    if (errors.email) {
      const existing = root.querySelector('#login-email-error');
      if (existing) existing.textContent = errors.email;
    }
    if (errors.password) {
      const existing = root.querySelector('#login-password-error');
      if (existing) existing.textContent = errors.password;
    }
    if (Object.keys(errors).length > 0) return;

    setSubmitting(form, true);
    try {
      await signIn(email, password);
      ctx.navigate('/');
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    } finally {
      setSubmitting(form, false);
    }
  });
}