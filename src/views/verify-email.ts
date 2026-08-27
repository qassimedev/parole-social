import {
  applyEmailVerificationCode,
  getEmulatorOobCode,
  refreshEmailVerification,
  resendVerificationEmail,
} from '../lib/auth';
import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import { appShell, alertMarkup, escapeHtml, type ViewContext } from './layout';

function cooldownSeconds(): number {
  const stored = window.localStorage.getItem('parole:verify-cooldown');
  if (!stored) return 0;
  const remaining = Math.ceil((Number(stored) - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

export function renderVerifyEmail(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const email = session.email ? escapeHtml(session.email) : 'votre adresse';
  const cooldown = cooldownSeconds();

  const inner = `
    <section class="card">
      <h2 class="card__title">Vérification de l’adresse email</h2>
      <p class="muted">
        Un email de vérification a été envoyé à <strong>${email}</strong>.
        Ouvrez-le et cliquez sur le lien pour confirmer votre adresse.
      </p>
      <div id="verify-alerts"></div>
      <div class="actions">
        <button id="verify-resend" class="btn btn--primary" ${cooldown > 0 ? 'disabled' : ''}>
          <span class="btn__label">${cooldown > 0 ? `Renvoyer (${cooldown}s)` : 'Renvoyer l’email'}</span>
        </button>
        <button id="verify-refresh" class="btn btn--ghost">
          <span class="btn__label">J’ai vérifié — actualiser</span>
        </button>
      </div>
      ${ctx.isEmulator ? `
        <div class="dev-panel">
          <h3 class="dev-panel__title">Émulateur uniquement</h3>
          <p class="muted">Les emails ne sont pas réellement envoyés. Récupèrez le code de l’émulateur et appliquez-le pour simuler le clic sur le lien.</p>
          <button id="verify-simulate" class="btn btn--ghost btn--block">
            <span class="btn__label">Simuler la vérification (émulateur)</span>
          </button>
        </div>
      ` : ''}
    </section>
  `;
  return appShell(inner, 'home');
}

export function mountVerifyEmail(root: HTMLElement, ctx: ViewContext): void {
  const alerts = root.querySelector<HTMLDivElement>('#verify-alerts');
  if (!alerts) return;
  const session = ctx.session;
  const email = session.status === 'signed-in' ? session.email : null;

  const resendBtn = root.querySelector<HTMLButtonElement>('#verify-resend');
  const refreshBtn = root.querySelector<HTMLButtonElement>('#verify-refresh');
  const simulateBtn = root.querySelector<HTMLButtonElement>('#verify-simulate');

  const applyCode = async (code: string): Promise<boolean> => {
    alerts.innerHTML = '';
    try {
      await applyEmailVerificationCode(code);
      notify('Adresse email vérifiée. Bienvenue sur PAROLE !', 'success');
      ctx.navigate('/');
      return true;
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
      return false;
    }
  };

  function setResendCooldown(seconds: number): void {
    window.localStorage.setItem('parole:verify-cooldown', String(Date.now() + seconds * 1000));
    const update = (left: number) => {
      if (!resendBtn) return;
      const label = resendBtn.querySelector('.btn__label');
      if (left > 0) {
        resendBtn.disabled = true;
        if (label) label.textContent = `Renvoyer (${left}s)`;
        window.setTimeout(() => update(left - 1), 1000);
      } else {
        resendBtn.disabled = false;
        if (label) label.textContent = 'Renvoyer l’email';
      }
    };
    update(seconds);
  }

  resendBtn?.addEventListener('click', async () => {
    if (resendBtn.disabled) return;
    alerts.innerHTML = '';
    try {
      await resendVerificationEmail();
      setResendCooldown(60);
      alerts.innerHTML = alertMarkup('Email de vérification renvoyé. Pensez à vérifier vos spams.', 'success');
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    }
  });

  refreshBtn?.addEventListener('click', async () => {
    alerts.innerHTML = '';
    try {
      await refreshEmailVerification();
      if (ctx.session.status === 'signed-in' && ctx.session.emailVerified) {
        notify('Adresse email vérifiée. Bienvenue sur PAROLE !', 'success');
        ctx.navigate('/');
      } else {
        alerts.innerHTML = alertMarkup('Le compte n’est pas encore vérifié. Vérifiez votre boîte mail.', 'info');
      }
    } catch (err) {
      alerts.innerHTML = alertMarkup(describeError(err), 'error');
    }
  });

  simulateBtn?.addEventListener('click', async () => {
    if (!email) return;
    const code = await getEmulatorOobCode('verifyEmail', email);
    if (!code) {
      alerts.innerHTML = alertMarkup('Aucun code de vérification trouvé. Envoyez d’abord l’email (bouton « Renvoyer l’email »).', 'error');
      return;
    }
    await applyCode(code);
  });
}