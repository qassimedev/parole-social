import { register } from '../lib/auth';
import { describeError } from '../lib/errors';
import { validateSignupForm } from '../lib/validation';
import {
  authShell,
  alertMarkup,
  fieldMarkup,
  setSubmitting,
  type ViewContext,
} from './layout';

export function renderSignup(_ctx: ViewContext): string {
  const inner = `
    <h2 class="auth-card__title">Créer un compte</h2>
    <p class="auth-card__subtitle">Votre voix commence ici.</p>
    <div id="signup-alerts"></div>
    <form id="signup-form" novalidate>
      ${fieldMarkup({
        id: 'signup-displayname',
        label: 'Nom affiché',
        name: 'displayName',
        type: 'text',
        autocomplete: 'nickname',
        required: true,
        maxlength: 50,
        placeholder: 'Ex. : Alex',
      })}
      ${fieldMarkup({
        id: 'signup-email',
        label: 'Adresse email',
        name: 'email',
        type: 'email',
        autocomplete: 'email',
        required: true,
        placeholder: 'vous@exemple.fr',
      })}
      ${fieldMarkup({
        id: 'signup-password',
        label: 'Mot de passe',
        name: 'password',
        type: 'password',
        autocomplete: 'new-password',
        required: true,
        minlength: 8,
        hint: '8 caractères minimum, avec une lettre et un chiffre.',
      })}
      ${fieldMarkup({
        id: 'signup-confirm',
        label: 'Confirmer le mot de passe',
        name: 'confirm',
        type: 'password',
        autocomplete: 'new-password',
        required: true,
      })}
      <button type="submit" class="btn btn--primary btn--block">
        <span class="btn__label">S’inscrire</span>
      </button>
    </form>
    <p class="auth-card__links">
      <span>Déjà un compte ?</span>
      <a href="#/login">Se connecter</a>
    </p>
  `;
  return authShell(inner);
}

function setFieldError(root: HTMLElement, fieldId: string, message: string): void {
  const input = root.querySelector<HTMLInputElement>(`#${fieldId}`);
  if (!input) return;
  input.classList.toggle('field__input--invalid', Boolean(message));
  const existing = root.querySelector(`#${fieldId}-error`);
  if (existing) existing.textContent = message;
}

export function mountSignup(root: HTMLElement, ctx: ViewContext): void {
  const form = root.querySelector<HTMLFormElement>('#signup-form');
  const alerts = root.querySelector<HTMLDivElement>('#signup-alerts');
  if (!form || !alerts) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alerts.innerHTML = '';
    const values = {
      displayName: form.displayName.value,
      email: form.email.value,
      password: form.password.value,
      confirm: form.confirm.value,
    };

    const errors = validateSignupForm(values);
    setFieldError(root, 'signup-displayname', errors.displayName ?? '');
    setFieldError(root, 'signup-email', errors.email ?? '');
    setFieldError(root, 'signup-password', errors.password ?? '');
    setFieldError(root, 'signup-confirm', errors.confirm ?? '');
    if (Object.keys(errors).length > 0) return;

    setSubmitting(form, true);
    try {
      await register(values);
      ctx.navigate('/verify-email');
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    } finally {
      setSubmitting(form, false);
    }
  });
}