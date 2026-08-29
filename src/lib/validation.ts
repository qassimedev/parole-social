export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return 'Email requis.';
  if (trimmed.length > 254) return 'Email trop long.';
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!emailRe.test(trimmed)) return 'Format d\'email invalide.';
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return 'Mot de passe requis.';
  if (password.length < 8) return '8 caractères minimum.';
  if (password.length > 128) return 'Mot de passe trop long (128 max).';
  if (!/[a-zA-Z]/.test(password)) return 'Doit contenir au moins une lettre.';
  if (!/[0-9]/.test(password)) return 'Doit contenir au moins un chiffre.';
  return null;
}

export function validatePasswordConfirm(password: string, confirm: string): string | null {
  if (!confirm) return 'Confirmation requise.';
  if (password !== confirm) return 'Les mots de passe ne correspondent pas.';
  return null;
}

export function validateDisplayName(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (!trimmed) return 'Nom affiché requis.';
  if (trimmed.length > 50) return '50 caractères maximum.';
  return null;
}

export function validateBio(bio: string): string | null {
  if (bio.length > 160) return '160 caractères maximum.';
  return null;
}

export function validateLoginForm(data: { email: string; password: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  const emailErr = validateEmail(data.email);
  if (emailErr) errors.email = emailErr;
  const pwdErr = validatePassword(data.password);
  if (pwdErr) errors.password = pwdErr;
  return errors;
}

export function validateSignupForm(data: { displayName: string; email: string; password: string; confirm: string }): Record<string, string> {
  const errors: Record<string, string> = {};
  const dnErr = validateDisplayName(data.displayName);
  if (dnErr) errors.displayName = dnErr;
  const emailErr = validateEmail(data.email);
  if (emailErr) errors.email = emailErr;
  const pwdErr = validatePassword(data.password);
  if (pwdErr) errors.password = pwdErr;
  const cfErr = validatePasswordConfirm(data.password, data.confirm);
  if (cfErr) errors.confirm = cfErr;
  return errors;
}