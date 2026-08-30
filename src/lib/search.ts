// ============================================================
// PAROLE - Recherche utilisateurs & hashtags (Phase 9 — Lot 5)
//
// Strategy NOTE : pas de moteur externe, pas de Cloud Function, pas
// de recherche plein-texte. La recherche d'utilisateurs repose sur
// `users.searchTokens` (tableau OPTIONNEL de tokens normalisés,
// dérivés du displayName) interrogé avec un unique `array-contains` —
// cette requête mono-champ ne requiert AUCUN index composite. La
// recherche hashtags/posts réutilise l'implémentation hashtag
// existante (`fetchPostsByHashtag`), page cible `#/hashtag/{tag}`.
//
// Convention de tokenisation — DÉTERMINISTE, identique dans
// `firestore.rules` (isValidSearchTokens) et dans les tests :
//  - token = chaîne en MINUSCULES, charset [0-9a-z_] (NI espace, NI
//    accent, NI ponctuation), longueur 2..12.
//  - chaîne de caractères normalisée en préfixes bornés des mots du
//    displayName (« alice » → « al », « ali », « alic », « alice »).
//  - au plus MAX_SEARCH_TOKENS (12) tokens par profil ; un tableau
//    vide est accepté. La déduplication est côté client.
//  - Aucune donnée sensible (email, uid, numéro de téléphone) n'est
//    jamais dérivée en token.
// Les RÈGLES ne peuvent pas dériver les tokens du displayName
// (langage CEL sans itération) : la re-normalisation a donc lieu
// côté client (`buildSearchTokens`) et côté `registerUser` (Admin
// SDK), tandis que les règles imposent le format et le LIAGE au
// displayName (les tokens ne peuvent changer que lorsque le
// displayName change lui aussi).
// ============================================================

import { getFirestoreInstance } from './firebase';
import {
  collection,
  getDocs,
  limit,
  query,
  where,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { fetchPostsByHashtag, type Post } from './posts';

export const MAX_SEARCH_TOKENS = 12;
export const MIN_TOKEN_LENGTH = 2;
export const MAX_TOKEN_LENGTH = 12;
const TOKEN_SOURCE_SEGMENT_RE = /^[0-9a-z_]+$/;
const MAX_SEARCH_RESULTS = 30;

export interface SearchUserResult {
  uid: string;
  displayName: string;
  bio: string;
  avatarPath: string;
}

export interface SearchResults {
  users: SearchUserResult[];
  posts: Post[];
  tag: string | null;
}

// ------------------------------------------------------------
// Normalisation d'une requête de recherche : minuscules, seuls les
// caractères [0-9a-z_] sont conservés (même sémantique que les
// hashtags : accents/ponctuation interrompent) ; on ne retient QUE le
// premier mot, borné à MAX_TOKEN_LENGTH. Renvoie le token de
// recherche (2..12 caractères) ou null si la requête est vide/trop
// courte (aucun résultat). Le même token sert à l'interrogation
// `array-contains` des utilisateurs ET à la page hashtag.
// ------------------------------------------------------------
export function normalizeSearchQuery(q: string): string | null {
  const cleaned = q
    .trim()
    .toLowerCase()
    .split(/[^0-9a-z_]+/)
    .filter(Boolean)[0] ?? '';
  if (cleaned.length < MIN_TOKEN_LENGTH) return null;
  return cleaned.slice(0, MAX_TOKEN_LENGTH);
}

// ------------------------------------------------------------
// Mot unique du displayName → préfixes. « alice » → al, ali, alic,
// alice. Les mots vides sont ignorés.
// ------------------------------------------------------------
function wordPrefixes(word: string): string[] {
  const prefixes: string[] = [];
  const maxLen = Math.min(word.length, MAX_TOKEN_LENGTH);
  for (let len = MIN_TOKEN_LENGTH; len <= maxLen; len += 1) {
    prefixes.push(word.slice(0, len));
  }
  return prefixes;
}

// ------------------------------------------------------------
// Tokens de recherche d'un displayName : minuscules, seuls les
// caractères [0-9a-z_] sont conservés (accents et ponctuation
// interrompent les mots), chaque mot produit ses préfixes bornés,
// l'ensemble est dédupliqué puis borné à MAX_SEARCH_TOKENS, dans
// l'ordre d'apparition. Un displayName vide/invalide → [].
// ------------------------------------------------------------
export function buildSearchTokens(displayName: string): string[] {
  const cleaned = displayName.trim().toLowerCase().split(/[^0-9a-z_]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const word of cleaned) {
    for (const prefix of wordPrefixes(word)) {
      if (tokens.includes(prefix)) continue;
      tokens.push(prefix);
      if (tokens.length >= MAX_SEARCH_TOKENS) return tokens;
    }
  }
  return tokens;
}

function snapshotToSearchUser(doc: QueryDocumentSnapshot): SearchUserResult {
  const data = doc.data();
  return {
    uid: data.uid ?? '',
    displayName: typeof data.displayName === 'string' ? data.displayName : '',
    bio: typeof data.bio === 'string' ? data.bio : '',
    avatarPath: typeof data.avatarPath === 'string' ? data.avatarPath : '',
  };
}

// ------------------------------------------------------------
// Recherche d'utilisateurs. `currentUid` est exclu du résultat (la
// recherche sert à trouver les AUTRES). La requête reproduit la
// règle de lecture `users` (`isSignedIn` uniquement, pas de champ
// déréférencé) : un unique `array-contains` mono-champ, AUCUN index
// composite nécessaire. Les profils sont lus tels quels par les
// règles (publics pour tout connecté) — pas de tri global ni de
// pagination complexe (borne MAX_SEARCH_RESULTS).
// ------------------------------------------------------------
export async function fetchUsersBySearch(q: string, currentUid: string): Promise<SearchUserResult[]> {
  const token = normalizeSearchQuery(q);
  if (!token || token.length < MIN_TOKEN_LENGTH) return [];
  const snap = await getDocs(
    query(
      collection(getFirestoreInstance(), 'users'),
      where('searchTokens', 'array-contains', token),
      limit(MAX_SEARCH_RESULTS)
    )
  );
  return snap.docs
    .map(snapshotToSearchUser)
    .filter((u) => u.uid !== currentUid);
}

// ------------------------------------------------------------
// Recherche hashtags/posts : réutilise l'implémentation hashtag
// existante (fetchPostsByHashtag), qui applique déjà la contrainte
// de la règle de lecture des posts. Renvoie la liste des posts visibles
// portant `#token`, plus le tag normalisé (destiné au lien vers la
// page `#/hashtag/{tag}`). Un token vide/trop court → aucun post.
// ------------------------------------------------------------
export async function fetchSearchPosts(q: string): Promise<{ tag: string | null; posts: Post[] }> {
  const token = normalizeSearchQuery(q);
  if (!token || !TOKEN_SOURCE_SEGMENT_RE.test(token)) {
    return { tag: null, posts: [] };
  }
  const posts = await fetchPostsByHashtag(token);
  return { tag: token, posts };
}

// ------------------------------------------------------------
// Recherche combinée (utilisateurs + hashtags/posts), utilisée par la
// page `#/search`. La requête vide/trop courte renvoie une structure
// vide sans aller au réseau. `tag` est le token normalisé si une page
// hashtag existe pour ce token.
// ------------------------------------------------------------
export async function runSearch(q: string, currentUid: string): Promise<SearchResults> {
  const normalized = normalizeSearchQuery(q);
  if (!normalized) {
    return { users: [], posts: [], tag: null };
  }
  const [users, { tag, posts }] = await Promise.all([
    fetchUsersBySearch(q, currentUid),
    fetchSearchPosts(q),
  ]);
  return { users, posts, tag };
}