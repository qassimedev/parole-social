// ============================================================
// PAROLE - Gabarits et helpers d'interface (Phase 2)
// Shells connecté / déconnecté, champs de formulaire accessibles.
// ============================================================

import type { Route } from '../lib/router';
import type { Session } from '../lib/store';

export interface ViewContext {
  session: Session;
  route: Route;
  navigate: (path: string) => void;
  isEmulator: boolean;
}

export type { Route, Session };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function brandMarkup(compact = false): string {
  return `
    <div class="brand__logo${compact ? ' brand__logo--sm' : ''}" aria-hidden="true">P</div>
    <h1 class="brand__name${compact ? ' brand__name--sm' : ''}">PAROLE</h1>
    <p class="brand__slogan">Ta voix. Ton espace. Tes droits.</p>
  `;
}

// Shell pour les pages d'authentification (déconnecté).
export function authShell(inner: string): string {
  return `
    <div class="app app--auth">
      <header class="auth-brand">${brandMarkup()}</header>
      <main class="auth-card">${inner}</main>
      <footer class="auth-footer">
        <p class="muted">PAROLE — ta voix compte.</p>
      </footer>
    </div>
  `;
}

// Shell pour les pages de l'application (connecté).
export function appShell(inner: string, active = ''): string {
  const link = (name: string, href: string, label: string) =>
    `<a class="nav__link${active === name ? ' nav__link--active' : ''}" href="${href}">${label}</a>`;
  return `
    <div class="app">
      <header class="topbar">
        <a class="brand brand--compact" href="#/" aria-label="Accueil PAROLE">
          <span class="brand__logo brand__logo--sm" aria-hidden="true">P</span>
          <span class="brand__name brand__name--sm">PAROLE</span>
        </a>
        <nav class="nav" aria-label="Navigation principale">
          ${link('home', '#/', 'Accueil')}
          ${link('profile', '#/profile', 'Profil')}
          ${link('settings', '#/settings', 'Paramètres')}
        </nav>
      </header>
      <main class="page">${inner}</main>
    </div>
  `;
}

export interface FieldOpts {
  id: string;
  label: string;
  type: string;
  name: string;
  autocomplete?: string;
  required?: boolean;
  minlength?: number;
  maxlength?: number;
  placeholder?: string;
  hint?: string;
  value?: string;
  error?: string | null;
}

export function fieldMarkup(field: FieldOpts): string {
  const error = field.error ? `<span class="field__error" role="alert" id="${field.id}-error">${escapeHtml(field.error)}</span>` : '';
  const hint = field.hint ? `<span class="field__hint" id="${field.id}-hint">${escapeHtml(field.hint)}</span>` : '';
  const required = field.required ? ' required' : '';
  const described = field.error
    ? ` aria-describedby="${field.id}-error${field.hint ? ` ${field.id}-hint` : ''}"`
    : field.hint
      ? ` aria-describedby="${field.id}-hint"`
      : '';
  return `
    <div class="field">
      <label class="field__label" for="${field.id}">${escapeHtml(field.label)}</label>
      <input
        class="field__input${field.error ? ' field__input--invalid' : ''}"
        id="${field.id}"
        name="${field.name}"
        type="${field.type}"
        autocomplete="${field.autocomplete ?? 'off'}"
        ${required}
        ${field.minlength ? `minlength="${field.minlength}"` : ''}
        ${field.maxlength ? `maxlength="${field.maxlength}"` : ''}
        ${field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : ''}
        value="${escapeHtml(field.value ?? '')}"
        ${described}
      />
      ${error}
      ${hint}
    </div>
  `;
}

export function textareaMarkup(field: Omit<FieldOpts, 'type'> & { rows?: number }): string {
  const error = field.error ? `<span class="field__error" role="alert">${escapeHtml(field.error)}</span>` : '';
  return `
    <div class="field">
      <label class="field__label" for="${field.id}">${escapeHtml(field.label)}</label>
      <textarea
        class="field__input${field.error ? ' field__input--invalid' : ''}"
        id="${field.id}"
        name="${field.name}"
        rows="${field.rows ?? 3}"
        maxlength="${field.maxlength ?? 160}"
        ${field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : ''}
      >${escapeHtml(field.value ?? '')}</textarea>
      ${error}
      ${field.hint ? `<span class="field__hint">${escapeHtml(field.hint)}</span>` : ''}
    </div>
  `;
}

export function alertMarkup(message: string, type: 'error' | 'success' | 'info' = 'info'): string {
  return `<div class="alert alert--${type}" role="${type === 'error' ? 'alert' : 'status'}">${escapeHtml(message)}</div>`;
}

// Forme un bouton avec état "chargement" (spinner) pendant l'envoi.
export function setSubmitting(form: HTMLFormElement, submitting: boolean): void {
  const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!btn) return;
  btn.disabled = submitting;
  btn.classList.toggle('btn--loading', submitting);
  const label = btn.querySelector('.btn__label');
  if (label) label.textContent = submitting ? 'Veuillez patienter…' : (btn.dataset.label ?? label.textContent);
  if (!btn.dataset.label) btn.dataset.label = label?.textContent ?? '';
}

export function avatarMarkup(avatarUrl: string | null, name: string, size: 'sm' | 'lg' = 'lg'): string {
  const fallback = escapeHtml((name || '?').trim().charAt(0).toUpperCase() || '?');
  if (avatarUrl) {
    return `<img class="avatar avatar--${size}" src="${escapeHtml(avatarUrl)}" alt="Photo de profil de ${escapeHtml(name)}" />`;
  }
  return `<span class="avatar avatar--${size} avatar--fallback" aria-hidden="true">${fallback}</span>`;
}

export function spinnerMarkup(): string {
  return `<span class="spinner" role="status" aria-label="Chargement"></span>`;
}