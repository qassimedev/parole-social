let notifyContainer: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (notifyContainer) return notifyContainer;
  notifyContainer = document.createElement('div');
  notifyContainer.id = 'notify-container';
  notifyContainer.style.cssText = `
    position: fixed;
    top: 1rem;
    right: 1rem;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
  `;
  document.body.appendChild(notifyContainer);
  return notifyContainer;
}

export function notify(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const container = ensureContainer();

  const el = document.createElement('div');
  el.role = type === 'error' ? 'alert' : 'status';
  el.style.cssText = `
    pointer-events: auto;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    max-width: 320px;
    font-size: 0.875rem;
    line-height: 1.4;
    animation: slideIn 0.2s ease-out;
    ${type === 'success' ? 'background: #166534; color: #dcfce7; border: 1px solid #16a34a;' : ''}
    ${type === 'error' ? 'background: #991b1b; color: #fecaca; border: 1px solid #ef4444;' : ''}
    ${type === 'info' ? 'background: #1e40af; color: #dbeafe; border: 1px solid #3b82f6;' : ''}
  `;
  el.textContent = message;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideIn {
      from { opacity: 0; transform: translateX(100%); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes slideOut {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(100%); }
    }
  `;
  if (!document.getElementById('notify-styles')) {
    style.id = 'notify-styles';
    document.head.appendChild(style);
  }

  container.appendChild(el);

  setTimeout(() => {
    el.style.animation = 'slideOut 0.2s ease-in forwards';
    setTimeout(() => el.remove(), 200);
  }, 4000);
}