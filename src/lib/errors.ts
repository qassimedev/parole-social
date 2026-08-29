const KNOWN_CODES: Record<string, string> = {
  'auth/user-not-found': 'Email ou mot de passe incorrect.',
  'auth/wrong-password': 'Email ou mot de passe incorrect.',
  'auth/invalid-credential': 'Email ou mot de passe incorrect.',
  'auth/email-already-in-use': 'Cette adresse email est déjà utilisée.',
  'auth/weak-password': 'Le mot de passe est trop faible (8 caractères minimum, une lettre et un chiffre).',
  'auth/invalid-email': 'Adresse email invalide.',
  'auth/too-many-requests': 'Trop de tentatives. Réessayez plus tard.',
  'auth/network-request-failed': 'Erreur de réseau. Vérifiez votre connexion.',
  'auth/user-disabled': 'Ce compte a été désactivé.',
  'auth/operation-not-allowed': 'Opération non autorisée.',
  'auth/requires-recent-login': 'Veuillez vous reconnecter pour effectuer cette action.',
  'storage/unauthorized': 'Non autorisé à accéder à ce fichier.',
  'storage/canceled': 'Téléchargement annulé.',
  'storage/quota-exceeded': 'Quota de stockage dépassé.',
  'permission-denied': 'Permission refusée.',
  'not-found': 'Ressource introuvable.',
  'already-exists': 'Cette ressource existe déjà.',
  'resource-exhausted': 'Trop de requêtes. Réessayez plus tard.',
  'invalid-argument': 'Argument invalide.',
  'deadline-exceeded': 'Délai dépassé. Réessayez.',
  'unauthenticated': 'Non authentifié.',
};

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    const message = err.message;

    if (code) {
      // Codes complets (ex. 'auth/...', 'storage/...').
      const direct = KNOWN_CODES[code];
      if (direct !== undefined) {
        if (code === 'invalid-argument') return message || direct;
        return direct;
      }
      // Repli sur le dernier segment (ex. 'functions/permission-denied').
      const suffix = code.split('/').pop() ?? '';
      const viaSuffix = KNOWN_CODES[suffix];
      if (viaSuffix !== undefined) {
        if (suffix === 'invalid-argument') return message || viaSuffix;
        return viaSuffix;
      }
      return message || 'Une erreur est survenue.';
    }

    return message;
  }

  if (typeof err === 'string') return err;
  return 'Une erreur inconnue est survenue.';
}