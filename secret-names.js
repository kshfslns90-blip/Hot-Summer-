// What a secret's name may be (secrets.js): an identifier, unique whatever its case, such as
// STRIPE_API_KEY. A module of its own, so that the settings (which name the mail password's
// secret) and the schema file (which lists the secrets) share the rule without importing each
// other.
export const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
export const SECRET_NAME_MAX = 64;
export const SECRET_DESCRIPTION_MAX = 500;

export function isSecretName(name) {
  return typeof name === 'string' && SECRET_NAME_RE.test(name) && name.length <= SECRET_NAME_MAX;
}
