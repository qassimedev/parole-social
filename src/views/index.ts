// ============================================================
// PAROLE - Aiguillage des vues (Phase 2)
// Choisit la vue selon l'état de session et la route courante,
// puis la rend et la monte dans le conteneur racine.
// ============================================================

import { store } from '../lib/store';
import { currentRoute, navigate, PUBLIC_ROUTES, type Route } from '../lib/router';
import { isEmulatorMode } from '../lib/firebase';
import { spinnerMarkup, type ViewContext } from './layout';
import { renderLogin, mountLogin } from './login';
import { renderSignup, mountSignup } from './signup';
import { renderVerifyEmail, mountVerifyEmail } from './verify-email';
import { renderForgotPassword, mountForgotPassword } from './forgot-password';
import { renderEmailAction, mountEmailAction } from './email-action';
import { renderHome, mountHome } from './home';
import { renderProfile, mountProfile } from './profile';
import { renderSettings, mountSettings } from './settings';
import { renderModeration, mountModeration } from './moderation';
import { renderUser, mountUser } from './user';
import { renderNotifications, mountNotifications } from './notifications';
import { renderHashtag, mountHashtag } from './hashtag';
import { renderInbox, mountInbox } from './inbox';
import { renderConversation, mountConversation } from './conversation';

export function splashView(): string {
  return `
    <div class="app app--splash">
      <div class="splash">
        <div class="brand__logo" aria-hidden="true">P</div>
        <h1 class="brand__name">PAROLE</h1>
        <p class="brand__slogan">Ta voix. Ton espace. Tes droits.</p>
        <div class="splash-status">${spinnerMarkup()}<span class="muted">Chargement de votre session…</span></div>
      </div>
    </div>
  `;
}

function buildContext(): ViewContext {
  const route: Route = currentRoute();
  return {
    session: store.get(),
    route,
    navigate,
    isEmulator: isEmulatorMode(),
  };
}

const signedOutViews: Record<string, (ctx: ViewContext) => { render: () => string; mount: (root: HTMLElement) => void }> = {
  login: () => ({ render: () => renderLogin(buildContext()), mount: (r) => mountLogin(r, buildContext()) }),
  signup: () => ({ render: () => renderSignup(buildContext()), mount: (r) => mountSignup(r, buildContext()) }),
  'forgot-password': () => ({
    render: () => renderForgotPassword(buildContext()),
    mount: (r) => mountForgotPassword(r, buildContext()),
  }),
};

export function renderView(root: HTMLElement): void {
  const ctx = buildContext();
  const { session, route } = ctx;

  // Session en cours de chargement.
  if (session.status === 'loading') {
    root.innerHTML = splashView();
    return;
  }

  // Route d'action d'email : disponible connecté ou déconnecté.
  if (route.name === 'email-action') {
    root.innerHTML = renderEmailAction(ctx);
    mountEmailAction(root, ctx);
    return;
  }

  if (session.status === 'signed-out') {
    if (!PUBLIC_ROUTES.has(route.name) && !signedOutViews[route.name]) {
      navigate('/login');
      return;
    }
    const view = signedOutViews[route.name]?.(ctx);
    if (view) {
      root.innerHTML = view.render();
      view.mount(root);
    }
    return;
  }

  // Connecté.
  switch (route.name) {
    case 'login':
    case 'signup':
    case 'forgot-password':
      navigate('/');
      return;
    case 'verify-email':
      root.innerHTML = renderVerifyEmail(ctx);
      mountVerifyEmail(root, ctx);
      return;
    case 'profile':
      root.innerHTML = renderProfile(ctx);
      mountProfile(root, ctx);
      return;
    case 'user':
      root.innerHTML = renderUser(ctx);
      mountUser(root, ctx);
      return;
    case 'settings':
      root.innerHTML = renderSettings(ctx);
      mountSettings(root, ctx);
      return;
    case 'hashtag':
      root.innerHTML = renderHashtag(ctx);
      mountHashtag(root, ctx);
      return;
    case 'notifications':
      root.innerHTML = renderNotifications(ctx);
      mountNotifications(root, ctx);
      return;
    case 'messages':
      root.innerHTML = renderInbox(ctx);
      mountInbox(root, ctx);
      return;
    case 'conversation':
      root.innerHTML = renderConversation(ctx);
      mountConversation(root, ctx);
      return;
    case 'moderation':
      // Accès réservé modérateur/admin : l'affichage n'est jamais
      // une autorisation — les Cloud Functions valident le rôle.
      if (session.profile?.role !== 'moderator' && session.profile?.role !== 'admin') {
        navigate('/');
        return;
      }
      root.innerHTML = renderModeration(ctx);
      mountModeration(root, ctx);
      return;
    case 'home':
    default:
      root.innerHTML = renderHome(ctx);
      mountHome(root, ctx);
      return;
  }
}