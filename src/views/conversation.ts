// ============================================================
// PAROLE - Messagerie (Phase 9 — Lot 3)
//
// Vue Conversation — route `#/messages/{conversationId}` : affiche
// les messages d'une conversation 1-à-1 (tri createdAt ASC, paginé
// via bouton « Messages précédents »), marque comme lus les messages
// entrants non lus (badge Messages mis à jour via
// store.setMessageCount) et permet d'envoyer un message. À l'ouverture
// depuis un profil (« ?peer={userId} »), la conversation est créée si
// nécessaire (fetchOrCreateConversation). Le contenu est échappé ;
// la validation finale reste portée par les règles (participant,
// non banni, aucun blocage dans AUCUNE direction).
// ============================================================

import { describeError } from '../lib/errors';
import { fetchAuthorNames } from '../lib/comments';
import { store } from '../lib/store';
import {
  fetchConversation,
  fetchMessages,
  fetchOrCreateConversation,
  markMessageRead,
  sendMessage,
  type Conversation,
  type Message,
} from '../lib/messages';
import {
  appShell,
  escapeHtml,
  isModeratorRole,
  spinnerMarkup,
  type ViewContext,
} from './layout';

const PAGE_SIZE = 50;

function formatContent(content: string): string {
  return escapeHtml(content).replace(/\n/g, '<br />');
}

function messageDate(message: Message): string {
  return message.createdAt?.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) ?? '—';
}

function messageMarkup(message: Message, uid: string, otherName: string): string {
  const mine = message.senderId === uid;
  const otherLabel = mine ? 'Vous' : escapeHtml(otherName || message.senderId);
  return `
    <article class="message-row message-row--${mine ? 'mine' : 'theirs'}" data-id="${escapeHtml(message.id)}" data-sender="${escapeHtml(message.senderId)}" data-read="${message.read ? 'true' : 'false'}">
      <div class="message-bubble">
        <span class="message-bubble__author muted">${otherLabel}</span>
        <p class="message-bubble__content">${formatContent(message.content)}</p>
        <span class="message-bubble__date muted">${escapeHtml(messageDate(message))}</span>
      </div>
    </article>
  `;
}

export function renderConversation(ctx: ViewContext): string {
  const session = ctx.session;
  if (session.status !== 'signed-in') return appShell('<p>Vous êtes déconnecté.</p>');
  const profile = session.profile;

  const inner = `
    <section class="card">
      <header class="card__header">
        <h2 class="card__title" id="conversation-title">Conversation</h2>
      </header>
      <div id="conversation-alerts"></div>
      <div id="conversation-messages" class="conversation-messages" tabindex="0">
        <div class="conversation__status">${spinnerMarkup()}<span class="muted">Chargement…</span></div>
      </div>
      <div class="conversation-composer">
        <textarea id="conversation-input" class="field__input" rows="3" maxlength="2000"
          placeholder="Votre message…" aria-label="Votre message"></textarea>
        <div class="conversation-composer__actions">
          <span class="muted small" id="conversation-counter">0/2000</span>
          <button type="button" id="conversation-send" class="btn btn--primary">
            <span class="btn__label">Envoyer</span>
          </button>
        </div>
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

export function mountConversation(root: HTMLElement, ctx: ViewContext): void {
  const session = ctx.session;
  if (session.status !== 'signed-in') return;
  const uid = session.uid;
  if (!uid) return;

  const conversationId = ctx.route.params.get('conversationId') ?? '';
  const peerHint = ctx.route.params.get('peer') ?? '';

  const title = root.querySelector<HTMLElement>('#conversation-title');
  const messages = root.querySelector<HTMLElement>('#conversation-messages');
  const alerts = root.querySelector<HTMLDivElement>('#conversation-alerts');
  const input = root.querySelector<HTMLTextAreaElement>('#conversation-input');
  const sendBtn = root.querySelector<HTMLButtonElement>('#conversation-send');
  const counter = root.querySelector<HTMLElement>('#conversation-counter');
  if (!title || !messages || !alerts || !input || !sendBtn || !counter) return;

  let conversation: Conversation | null = null;
  let peerId = peerHint;
  let composerAttached = false;

  const loadingMarkup = (): string =>
    `<div class="conversation__status">${spinnerMarkup()}<span class="muted">Chargement…</span></div>`;

  const errorMarkup = (message: string): string => `
    <div class="conversation__error" role="alert">
      <div class="alert alert--error">${escapeHtml(message)}</div>
      <button type="button" id="conversation-retry" class="btn btn--ghost btn--sm">
        <span class="btn__label">Réessayer</span>
      </button>
    </div>
  `;

  const scrollToBottom = (): void => {
    messages.scrollTop = messages.scrollHeight;
  };

  const updateNavBadge = (count: number): void => {
    const badge = document.getElementById('nav-messages-badge');
    if (!badge) return;
    badge.textContent = String(count);
    badge.dataset.count = String(count);
    badge.hidden = count <= 0;
  };

  // Marque comme lus les messages entrants non lus (réservé au
  // destinataire par les règles) puis rafraîchit le badge.
  const markUnreadAsRead = async (items: Message[]): Promise<void> => {
    const incomingUnread = items.filter((m) => m.senderId !== uid && !m.read);
    if (incomingUnread.length === 0) return;
    let marked = 0;
    for (const message of incomingUnread) {
      try {
        await markMessageRead(message.id);
        marked += 1;
        const el = messages.querySelector<HTMLElement>(`.message-row[data-id="${CSS.escape(message.id)}"]`);
        if (el) {
          el.dataset.read = 'true';
          el.classList.add('message-row--read');
        }
      } catch {
        // Règle ou course : on continue, le serveur reste cohérent.
      }
    }
    if (marked > 0) {
      const current = store.get().profile?.messageCount ?? 0;
      const next = Math.max(0, current - marked);
      store.setMessageCount(uid, next);
      updateNavBadge(next);
    }
  };

  const renderMessages = (items: Message[]): void => {
    messages.innerHTML = items.length
      ? items.map((m) => messageMarkup(m, uid, peerId)).join('\n')
      : `<div class="conversation__empty muted">Aucun message. Écrivez le premier message !</div>`;
  };

  const attachComposer = (): void => {
    input.addEventListener('input', () => {
      counter.textContent = `${input.value.length}/2000`;
    });

    const send = async (): Promise<void> => {
      if (!conversation || sendBtn.disabled) return;
      const content = input.value;
      if (content.trim().length === 0) {
        alerts.innerHTML = `<div class="alert alert--error" role="alert">Le message ne peut pas être vide.</div>`;
        return;
      }
      sendBtn.disabled = true;
      input.disabled = true;
      try {
        await sendMessage(uid, conversation.id, content);
        input.value = '';
        counter.textContent = '0/2000';
        alerts.innerHTML = '';
        await load();
      } catch (err) {
        alerts.innerHTML = `<div class="alert alert--error" role="alert">${escapeHtml(describeError(err))}</div>`;
      } finally {
        sendBtn.disabled = false;
        input.disabled = false;
      }
    };

    sendBtn.addEventListener('click', () => void send());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    });
  };

  const load = async (): Promise<void> => {
    if (!conversationId) {
      messages.innerHTML = errorMarkup('Conversation non spécifiée.');
      return;
    }
    messages.innerHTML = loadingMarkup();
    if (alerts) alerts.innerHTML = '';

    try {
      // Résout la conversation (création si « ?peer= » est fourni).
      if (peerId) {
        conversation = await fetchOrCreateConversation(uid, peerId);
      } else {
        conversation = await fetchConversation(conversationId);
      }
      if (!conversation) {
        messages.innerHTML = errorMarkup('Conversation introuvable ou inaccessible.');
        return;
      }

      if (!peerId) {
        peerId = conversation.participants.find((p) => p !== uid) ?? '';
      }

      const otherNames = await fetchAuthorNames([peerId]);
      const otherName = otherNames.get(peerId) ?? peerId;
      // En-tête : lien vers le profil de l'autre participant.
      title.innerHTML = `<a href="#/u/${encodeURIComponent(peerId)}">${escapeHtml(otherName || peerId || 'Conversation')}</a>`;

      const items = await fetchMessages(conversation.id, { limit: PAGE_SIZE });
      renderMessages(items);
      if (!composerAttached) {
        attachComposer();
        composerAttached = true;
      }
      void markUnreadAsRead(items);
      scrollToBottom();
    } catch (err) {
      messages.innerHTML = errorMarkup(describeError(err));
      messages.querySelector<HTMLButtonElement>('#conversation-retry')?.addEventListener('click', () => {
        void load();
      });
    }
  };

  void load();
}