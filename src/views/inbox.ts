// ============================================================
// PAROLE - Messagerie (Phase 9 — Lot 3)
//
// Vue Inbox — route `#/messages` : liste des conversations du user
// courant, triées par lastMessageAt DESC. Chaque ligne affiche
// l'autre participant (nom résolu via users), l'aperçu du dernier
// message et sa date. Le badge Messages de la navigation affiche
// users.messageCount (messages non lus reçus) et disparaît à zéro.
// L'accès réel reste contrôlé par les règles (participant non banni
// ou modérateur/admin).
// ============================================================

import { describeError } from '../lib/errors';
import { fetchAuthorNames } from '../lib/comments';
import { fetchConversations, type Conversation } from '../lib/messages';
import {
  appShell,
  escapeHtml,
  isModeratorRole,
  spinnerMarkup,
  type ViewContext,
} from './layout';

function conversationDate(conversation: Conversation): string {
  const date = conversation.lastMessageAt ?? conversation.createdAt;
  return date?.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) ?? '—';
}

function conversationMarkup(conversation: Conversation, otherName: string, uid: string): string {
  const otherId = conversation.participants.find((p) => p !== uid) ?? '';
  const preview =
    conversation.lastMessagePreview.trim().length > 0
      ? conversation.lastMessagePreview
      : 'Aucun message pour le moment.';
  const senderLabel =
    conversation.lastSenderId && conversation.lastSenderId === uid ? 'Vous : ' : '';
  return `
    <a class="inbox-row" href="#/messages/${encodeURIComponent(conversation.id)}?peer=${encodeURIComponent(otherId)}">
      <div class="inbox-row__main">
        <span class="inbox-row__name">${escapeHtml(otherName || otherId || '—')}</span>
        <span class="inbox-row__preview">${escapeHtml(senderLabel + preview)}</span>
      </div>
      <span class="inbox-row__date muted">${escapeHtml(conversationDate(conversation))}</span>
    </a>
  `;
}

export function renderInbox(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const profile = session.profile;

  const inner = `
    <section class="card">
      <header class="card__header">
        <h2 class="card__title">Messages</h2>
      </header>
      <div id="inbox-alerts"></div>
      <div id="inbox-list">
        <div class="inbox__status">${spinnerMarkup()}<span class="muted">Chargement…</span></div>
      </div>
    </section>
  `;
  return appShell(
    inner,
    'messages',
    isModeratorRole(profile?.role),
    profile?.notificationCount ?? 0,
    profile?.messageCount ?? 0
  );
}

export function mountInbox(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const uid = session.uid;
  if (!uid) return;

  const list = root.querySelector<HTMLDivElement>('#inbox-list');
  const alerts = root.querySelector<HTMLDivElement>('#inbox-alerts');
  if (!list || !alerts) return;

  const loadingMarkup = (): string =>
    `<div class="inbox__status">${spinnerMarkup()}<span class="muted">Chargement…</span></div>`;

  const errorMarkup = (message: string): string => `
    <div class="inbox__error" role="alert">
      <div class="alert alert--error">${escapeHtml(message)}</div>
      <button type="button" id="inbox-retry" class="btn btn--ghost btn--sm">
        <span class="btn__label">Réessayer</span>
      </button>
    </div>
  `;

  const emptyMarkup = (): string => `
    <div class="inbox__empty muted">
      Aucune conversation pour le moment. Visitez un profil puis « Envoyer un message » pour démarrer une discussion.
    </div>
  `;

  const load = async (): Promise<void> => {
    list.innerHTML = loadingMarkup();
    if (alerts) alerts.innerHTML = '';

    try {
      const conversations = await fetchConversations(uid);
      if (conversations.length === 0) {
        list.innerHTML = emptyMarkup();
        return;
      }
      const otherIds = conversations.map((c) => c.participants.find((p) => p !== uid) ?? '');
      const names = await fetchAuthorNames(otherIds);
      list.innerHTML = conversations
        .map((c) => {
          const otherId = c.participants.find((p) => p !== uid) ?? '';
          return conversationMarkup(c, names.get(otherId) ?? otherId, uid);
        })
        .join('\n');
    } catch (err) {
      list.innerHTML = errorMarkup(describeError(err));
      list.querySelector<HTMLButtonElement>('#inbox-retry')?.addEventListener('click', () => {
        void load();
      });
    }
  };

  void load();
}