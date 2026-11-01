// The project's settings: what data/project.json holds beyond the name. Pure functions, no
// file access, so the store and the tests can both lean on them. A settings file from before
// these existed - just { name } - normalises to the defaults for everything else.
import { isSecretName, SECRET_NAME_MAX } from './secret-names.js';

export const SHELLS = ['none', 'classic', 'office', 'navbar', 'actionbar', 'bottom'];
export const AUTH_TEMPLATES = ['classic', 'split', 'cover'];
export const SELF_REGISTER = ['open', 'invite'];
export const ADMIN_ROLE = 'Administrator';

// A form is named with its module: "Module.Form".
const FORM_RE = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/;
const ICON_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// A picture uploaded to data/images: a plain file name with a picture extension.
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp|svg|ico)$/i;

export const DEFAULTS = Object.freeze({
  name: 'My App',
  // A few sentences on what the app does; shown where the project is offered as a template.
  description: '',
  shell: 'none',
  // The logo replaces the project name in the shells' brand spot; a file name in data/images.
  logo: '',
  startForm: '',
  menu: [],
  // Off: the shells draw the items as one flat list, the groups only organise the editor.
  showGroups: true,
  auth: {
    enabled: false,
    template: 'classic',
    title: '',
    tagline: '',
    accent: '#2f6fd0',
    selfRegister: 'invite',
    newUsersActive: true,
    roles: [ADMIN_ROLE, 'User']
  },
  // The SMTP account's password is a secret (secrets.js): the settings name it, never hold it.
  mail: { host: '', port: 587, secure: false, user: '', passwordSecret: 'SMTP_PASSWORD', from: '' }
});

function text(value, max, fallback = '') {
  const clean = typeof value === 'string' ? value.trim() : fallback;
  return clean.length > max ? clean.slice(0, max) : clean;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// A menu is groups of items; an item points at a form. Anything malformed is reported rather
// than silently dropped, so the settings page can show what is wrong. An item's `roles` are
// the only roles that see it (none: everyone); a name that is not one of the project's roles
// is reported, so a role removed from the list does not quietly leave an item invisible.
function normalizeMenu(raw, errors, knownRoles) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push('The menu must be a list of groups.');
    return [];
  }
  const groups = [];
  raw.forEach((group, gi) => {
    if (!group || typeof group !== 'object') {
      errors.push(`Menu group ${gi + 1} is not an object.`);
      return;
    }
    const label = text(group.label, 60);
    if (!label) errors.push(`Menu group ${gi + 1} needs a label.`);
    const icon = text(group.icon, 60);
    if (icon && !ICON_RE.test(icon)) errors.push(`Menu group "${label || gi + 1}" has an invalid icon name.`);
    const items = [];
    (Array.isArray(group.items) ? group.items : []).forEach((item, ii) => {
      if (!item || typeof item !== 'object') {
        errors.push(`Item ${ii + 1} of group "${label}" is not an object.`);
        return;
      }
      const itemLabel = text(item.label, 60);
      const form = text(item.form, 80);
      if (!itemLabel) errors.push(`Item ${ii + 1} of group "${label}" needs a label.`);
      if (form && !FORM_RE.test(form)) errors.push(`Item "${itemLabel}" points at an invalid form name "${form}" (a form is named "Module.Form").`);
      const itemIcon = text(item.icon, 60);
      if (itemIcon && !ICON_RE.test(itemIcon)) errors.push(`Item "${itemLabel}" has an invalid icon name.`);
      let args = null;
      if (item.args !== undefined && item.args !== null && item.args !== '') {
        try {
          args = JSON.parse(JSON.stringify(item.args));
        } catch {
          errors.push(`Item "${itemLabel}" has arguments that are not plain data.`);
        }
      }
      const roles = [];
      for (const role of Array.isArray(item.roles) ? item.roles : []) {
        const clean = text(role, 40);
        if (!clean || roles.includes(clean)) continue;
        if (!knownRoles.includes(clean)) errors.push(`Item "${itemLabel}" is visible to a role "${clean}" that is not one of the project's roles.`);
        roles.push(clean);
      }
      items.push({ label: itemLabel, icon: itemIcon, form, args, roles });
    });
    groups.push({ label, icon, items });
  });
  return groups;
}

function normalizeRoles(raw, errors) {
  const source = Array.isArray(raw) ? raw : DEFAULTS.auth.roles;
  const roles = [];
  for (const role of source) {
    const clean = text(role, 40);
    if (!clean) continue;
    if (clean.length !== String(role).trim().length) errors.push(`Role "${clean}" is longer than 40 characters.`);
    if (!roles.includes(clean)) roles.push(clean);
  }
  if (!roles.includes(ADMIN_ROLE)) roles.unshift(ADMIN_ROLE);
  return roles;
}

function normalizeAuth(raw, errors) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const accent = text(src.accent, 7, DEFAULTS.auth.accent) || DEFAULTS.auth.accent;
  if (!COLOR_RE.test(accent)) errors.push('The accent colour must be #rrggbb.');
  return {
    enabled: Boolean(src.enabled),
    template: oneOf(src.template, AUTH_TEMPLATES, DEFAULTS.auth.template),
    title: text(src.title, 80),
    tagline: text(src.tagline, 200),
    accent,
    selfRegister: oneOf(src.selfRegister, SELF_REGISTER, DEFAULTS.auth.selfRegister),
    newUsersActive: src.newUsersActive === undefined ? DEFAULTS.auth.newUsersActive : Boolean(src.newUsersActive),
    roles: normalizeRoles(src.roles, errors)
  };
}

function normalizeMail(raw, errors) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const port = src.port === undefined || src.port === '' ? DEFAULTS.mail.port : Math.floor(Number(src.port));
  if (!Number.isFinite(port) || port < 1 || port > 65535) errors.push('The mail port must be between 1 and 65535.');
  const secret = typeof src.passwordSecret === 'string' ? src.passwordSecret.trim() : '';
  if (secret && !isSecretName(secret)) errors.push(`The mail password's secret must be a secret's name: letters, digits and underscores, starting with a letter, at most ${SECRET_NAME_MAX} characters.`);
  return {
    host: text(src.host, 200),
    port: Number.isFinite(port) ? port : DEFAULTS.mail.port,
    secure: Boolean(src.secure),
    user: text(src.user, 200),
    passwordSecret: secret && isSecretName(secret) ? secret : DEFAULTS.mail.passwordSecret,
    from: text(src.from, 200)
  };
}

// Whole-object normalisation: every section present with its defaults filled in, plus the
// list of things that were wrong. The caller decides whether errors are fatal.
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const name = text(src.name, 80, DEFAULTS.name) || DEFAULTS.name;
  if (typeof src.name === 'string' && (!src.name.trim() || src.name.trim().length > 80)) {
    errors.push('A project name is 1 to 80 characters.');
  }
  const startForm = text(src.startForm, 80);
  if (startForm && !FORM_RE.test(startForm)) errors.push(`The start form "${startForm}" is not a valid form name (a form is named "Module.Form").`);
  const logo = text(src.logo, 120);
  if (logo && (!IMAGE_RE.test(logo) || logo.includes('..'))) errors.push(`The logo "${logo}" is not the name of a picture in data/images.`);
  const auth = normalizeAuth(src.auth, errors);
  const settings = {
    name,
    description: text(src.description, 2000),
    shell: oneOf(src.shell, SHELLS, DEFAULTS.shell),
    logo,
    startForm,
    menu: normalizeMenu(src.menu, errors, auth.roles),
    showGroups: src.showGroups === undefined ? DEFAULTS.showGroups : Boolean(src.showGroups),
    auth,
    mail: normalizeMail(src.mail, errors)
  };
  return { settings, errors };
}

// A patch merged over the current settings, section by section: { name } alone leaves the
// shell, the menu and the rest untouched.
export function mergeSettings(current, patch) {
  const base = current && typeof current === 'object' ? current : {};
  const src = patch && typeof patch === 'object' ? patch : {};
  const merged = { ...base };
  for (const key of ['name', 'description', 'shell', 'logo', 'startForm', 'menu', 'showGroups']) if (src[key] !== undefined) merged[key] = src[key];
  for (const key of ['auth', 'mail']) {
    if (src[key] !== undefined) merged[key] = { ...(base[key] || {}), ...(src[key] && typeof src[key] === 'object' ? src[key] : {}) };
  }
  return merged;
}

// What the running app may see: everything but the mail account.
export function publicSettings(settings) {
  const { mail, ...rest } = settings;
  return { ...rest, auth: { ...rest.auth } };
}

// Every form the menu and the start form point at, in order, without duplicates.
export function menuForms(settings) {
  const names = [];
  const add = (name) => {
    if (name && !names.includes(name)) names.push(name);
  };
  add(settings.startForm);
  for (const group of settings.menu || []) for (const item of group.items || []) add(item.form);
  return names;
}
