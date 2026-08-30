export interface Route {
  name: string;
  params: Map<string, string>;
  hash: string;
}

function parseHash(hash: string): Route {
  const cleanHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathname, search] = cleanHash.split('?');
  const segments = pathname.split('/').filter(Boolean);

  const params = new Map<string, string>();
  if (search) {
    new URLSearchParams(search).forEach((value, key) => params.set(key, value));
  }

  let name = 'home';
  if (segments.length === 0) {
    name = 'home';
  } else if (segments[0] === 'login') {
    name = 'login';
  } else if (segments[0] === 'signup') {
    name = 'signup';
  } else if (segments[0] === 'forgot-password') {
    name = 'forgot-password';
  } else if (segments[0] === 'verify-email') {
    name = 'verify-email';
  } else if (segments[0] === 'email-action') {
    name = 'email-action';
  } else if (segments[0] === 'profile') {
    name = 'profile';
  } else if (segments[0] === 'u') {
    name = 'user';
    if (segments[1]) params.set('userId', segments[1]);
  } else if (segments[0] === 'settings') {
    name = 'settings';
  } else if (segments[0] === 'notifications') {
    name = 'notifications';
  } else if (segments[0] === 'hashtag') {
    name = 'hashtag';
    if (segments[1]) params.set('tag', segments[1]);
  } else if (segments[0] === 'moderation') {
    name = 'moderation';
  } else {
    name = 'home';
  }

  return { name, params, hash: cleanHash };
}

let currentRouteValue: Route = parseHash(window.location.hash);
const routeListeners: ((route: Route) => void)[] = [];

function notifyRouteListeners(): void {
  for (const listener of routeListeners) {
    listener(currentRouteValue);
  }
}

window.addEventListener('hashchange', () => {
  currentRouteValue = parseHash(window.location.hash);
  notifyRouteListeners();
});

export function currentRoute(): Route {
  return currentRouteValue;
}

export function navigate(path: string): void {
  const cleanPath = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash !== cleanPath) {
    window.location.hash = cleanPath;
  }
}

export function onRouteChange(listener: (route: Route) => void): () => void {
  routeListeners.push(listener);
  return () => {
    const idx = routeListeners.indexOf(listener);
    if (idx >= 0) routeListeners.splice(idx, 1);
  };
}

export const PUBLIC_ROUTES = new Set(['login', 'signup', 'forgot-password', 'email-action']);