import './style.css';
import { initAuth } from './lib/auth';
import { store, sessionErrorMessage, type Session } from './lib/store';
import { onRouteChange } from './lib/router';
import { notify } from './lib/notify';
import { renderView } from './views';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Application root #app introuvable');
}

// ------------------------------------------------------------
// Rendu à chaque changement d'état (session ou route).
// ------------------------------------------------------------
const refresh = (): void => {
  renderView(app);
};

let previousSession: Session = { status: 'loading' };

store.subscribe((session) => {
  const message = sessionErrorMessage(previousSession, session);
  previousSession = session;
  if (message) notify(message, 'error');
  refresh();
});

onRouteChange(refresh);

initAuth();
refresh();