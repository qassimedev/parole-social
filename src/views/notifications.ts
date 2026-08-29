// ============================================================
// PAROLE - Notifications (vue) — Phase 5
//
// Route `#/notifications` : liste des notifications du user courant,
// triées de la plus récente à la plus ancienne. Chaque non-lue peut
// être marquée « comme lu » individuellement, ou toutes d'un coup.
// L'écriture client est strictement limitée à read/readAt par les
// règles ; users.notificationCount est décrémenté côté serveur. Le
// badge de navigation est alimenté par la copie en mémoire de cette
// valeur (store.setNotificationCount) et mis à jour ici directement.
// ============================================================

import { describeError } from '../lib/errors';
import { notify } from '../lib/notify';
import { store } from '../lib/store';
import { fetchAuthorNames } from '../lib/comments';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type AppNotification,
} from '../lib/notifications';
import {
  appShell,
  alertMarkup,
  escapeHtml,
  isModeratorRole,
  spinnerMarkup,
  type ViewContext,
} from './layout';

function notificationText(notification: AppNotification, actorName: string): string {
  switch (notification.type) {
    case 'like':
      return `${actorName} a aimé votre publication.`;
    case 'comment':
      return `${actorName} a commenté votre publication.`;
    case 'follow':
      return `${actorName} vous suit maintenant.`;
    case 'share':
      return `${actorName} a partagé votre publication.`;
  }
}

function notificationItemMarkup(notification: AppNotification, actorName: string): string {
  const date =
    notification.createdAt?.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) ?? '—';
  const stateClass = notification.read
    ? 'notification-item--read'
    : 'notification-item--unread';
  const actionsMarkup = notification.read
    ? '<span class="badge">Lu</span>'
    : `
      <button type="button" class="btn btn--ghost btn--sm notification-read" data-id="${escapeHtml(notification.id)}">
        <span class="btn__label">Marquer comme lu</span>
      </button>
    `;
  return `
    <article class="notification-item ${stateClass}"
      data-id="${escapeHtml(notification.id)}"
      data-read="${notification.read ? 'true' : 'false'}">
      <div class="notification-item__meta">
        <a class="notification-item__actor" href="#/u/${escapeHtml(notification.actorId)}">${escapeHtml(actorName)}</a>
        <span class="notification-item__date muted">${escapeHtml(date)}</span>
      </div>
      <p class="notification-item__text">${escapeHtml(notificationText(notification, actorName))}</p>
      <div class="notification-item__actions">${actionsMarkup}</div>
    </article>
  `;
}

export function renderNotifications(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const count = session.profile?.notificationCount ?? 0;

  const inner = `
    <section class="card">
      <header class="card__header">
        <h2 class="card__title">Notifications</h2>
        <button type="button" id="notifications-mark-all" class="btn btn--ghost btn--sm">
          <span class="btn__label">Tout marquer comme lu</span>
        </button>
      </header>
      <div id="notifications-alerts"></div>
      <div id="notifications-list">
        <div class="notifications__status">${spinnerMarkup()}<span class="muted">Chargement…</span></div>
      </div>
    </section>
  `;
  return appShell(inner, 'notifications', isModeratorRole(session.profile?.role), count);
}

export function mountNotifications(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const uid = session.uid;
  if (!uid) return;

  const list = root.querySelector<HTMLDivElement>('#notifications-list');
  const alerts = root.querySelector<HTMLDivElement>('#notifications-alerts');
  const markAllBtn = root.querySelector<HTMLButtonElement>('#notifications-mark-all');
  if (!list || !alerts || !markAllBtn) return;

  const updateNavBadge = (count: number): void => {
    const badge = document.getElementById('nav-notifications-badge');
    if (!badge) return;
    badge.textContent = String(count);
    badge.dataset.count = String(count);
    badge.hidden = count <= 0;
  };

  const applyUnreadPresence = (): void => {
    const hasUnread = list.querySelector('.notification-item--unread') !== null;
    markAllBtn.disabled = !hasUnread;
  };

  const findItem = (id: string): HTMLElement | null => {
    let found: HTMLElement | null = null;
    list.querySelectorAll<HTMLElement>('.notification-item').forEach((item) => {
      if (item.dataset.id === id) found = item;
    });
    return found;
  };

  const markItemRead = (id: string): void => {
    const item = findItem(id);
    if (!item) return;
    item.classList.remove('notification-item--unread');
    item.classList.add('notification-item--read');
    item.setAttribute('data-read', 'true');
    const actionsEl = item.querySelector<HTMLDivElement>('.notification-item__actions');
    if (actionsEl) actionsEl.innerHTML = '<span class="badge">Lu</span>';
  };

  const loadingMarkup = (): string => `
    <div class="notifications__status">${spinnerMarkup()}<span class="muted">Chargement…</span></div>
  `;

  const errorMarkup = (message: string): string => `
    <div class="notifications__error" role="alert">
      <div class="alert alert--error">${escapeHtml(message)}</div>
      <button type="button" id="notifications-retry" class="btn btn--ghost btn--sm">
        <span class="btn__label">Réessayer</span>
      </button>
    </div>
  `;

  const emptyMarkup = (): string => `
    <div class="notifications__empty muted">
      Aucune notification pour le moment. Vos likes, commentaires et abonnements arrivent ici.
    </div>
  `;

  const load = async (): Promise<void> => {
    list.innerHTML = loadingMarkup();
    if (alerts) alerts.innerHTML = '';

    try {
      const notifications = await fetchNotifications(uid);
      if (notifications.length === 0) {
        list.innerHTML = emptyMarkup();
        applyUnreadPresence();
        return;
      }
      const actorNames = await fetchAuthorNames(notifications.map((n) => n.actorId));
      list.innerHTML = notifications
        .map((n) => notificationItemMarkup(n, actorNames.get(n.actorId) ?? n.actorId))
        .join('\n');
      attachReadHandlers();
      applyUnreadPresence();
    } catch (err) {
      list.innerHTML = errorMarkup(describeError(err));
      list.querySelector<HTMLButtonElement>('#notifications-retry')?.addEventListener('click', () => {
        void load();
      });
      applyUnreadPresence();
    }
  };

  const attachReadHandlers = (): void => {
    list.querySelectorAll<HTMLButtonElement>('.notification-read').forEach((btn) => {
      const id = btn.dataset.id;
      if (!id) return;
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await markNotificationRead(uid, id);
          markItemRead(id);
          const current = store.get().profile?.notificationCount ?? 0;
          const next = Math.max(0, current - 1);
          store.setNotificationCount(uid, next);
          updateNavBadge(next);
          applyUnreadPresence();
        } catch (err) {
          notify(describeError(err), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  };

  markAllBtn.addEventListener('click', async () => {
    if (markAllBtn.disabled) return;
    markAllBtn.disabled = true;
    try {
      const marked = await markAllNotificationsRead(uid);
      if (marked > 0) {
        list.querySelectorAll<HTMLElement>('.notification-item--unread').forEach((item) => {
          const id = item.dataset.id;
          if (id) markItemRead(id);
        });
        const current = store.get().profile?.notificationCount ?? 0;
        const next = Math.max(0, current - marked);
        store.setNotificationCount(uid, next);
        updateNavBadge(next);
        alerts.innerHTML = '';
      } else {
        alerts.innerHTML = alertMarkup('Aucune notification non lue.', 'info');
      }
    } catch (err) {
      notify(describeError(err), 'error');
    } finally {
      markAllBtn.disabled = false;
      applyUnreadPresence();
    }
  });

  void load();
}