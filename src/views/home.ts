import { appShell, escapeHtml, type ViewContext } from './layout';

export function renderHome(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const name = escapeHtml(session.profile?.displayName || session.displayName || 'PAROLE');

  const verifyBanner = session.emailVerified
    ? ''
    : `
    <div class="alert alert--info">
      Votre adresse email n’est pas encore vérifiée.
      <a href="#/verify-email">Vérifier maintenant</a>
    </div>
  `;

  const inner = `
    ${verifyBanner}
    <section class="card">
      <h2 class="card__title">Bienvenue, ${name}</h2>
      <p class="muted">
        Vous êtes connecté. Ici prendront vie vos publications, vos échanges et votre
        espace d’expression.
      </p>
    </section>
    <section class="quick-links">
      <a class="card quick-link" href="#/profile">
        <strong>Mon profil</strong>
        <span class="muted">Consulter et modifier mes informations.</span>
      </a>
      <a class="card quick-link" href="#/settings">
        <strong>Paramètres du compte</strong>
        <span class="muted">Sécurité, mot de passe et session.</span>
      </a>
    </section>
    <p class="muted page-note">Les publications arriveront dans une prochaine phase.</p>
  `;
  return appShell(inner, 'home');
}

export const mountHome = (): void => undefined;