// APIs: server functions exposed as HTTP endpoints under /api. Each is a document
// in data/apis - a method, a route, the function it runs, how the request becomes arguments
// and who may call it. The registry here keeps every enabled API as one express Router,
// rebuilt whenever a definition is written; invoke() is the one place a call is checked,
// mapped and run, shared by the router and the designer's Try it.
import express from 'express';
import * as store from './store.js';
import { StoreError } from './store.js';
import { callServer, ScriptError } from './runner.js';
import { functionParams } from './script-signatures.js';
import { isFileSend, openReadStream, statFile, downloadHeaders } from './files.js';
import { authEnabled } from './auth/guard.js';
import { keyFromHeaders } from './auth/api-keys.js';
import { ADMIN_ROLE } from './system-tables.js';

export const PREFIX = '/api';
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const ARGS = ['named', 'body'];
export const AUTH = ['session', 'key', 'any', 'public'];
const ROUTE_MAX = 200;
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const PARAM_RE = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const TARGET_RE = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*\.[A-Za-z_$][\w$]*$/;

// The segments of a route: literals and ":params". Anything else is refused with the reason.
export function parseRoute(route) {
  if (typeof route !== 'string' || !route.trim()) throw new StoreError('A route is needed, such as /customers/:id.');
  if (route.length > ROUTE_MAX) throw new StoreError(`A route is at most ${ROUTE_MAX} characters.`);
  if (!route.startsWith('/')) throw new StoreError('A route starts with /.');
  if (/\s/.test(route)) throw new StoreError('A route has no spaces.');
  if (route.length > 1 && route.endsWith('/')) throw new StoreError('A route does not end with /.');
  const segments = route.slice(1).split('/');
  if (segments.length === 1 && segments[0] === '') throw new StoreError('A route needs at least one segment after /.');
  const params = new Set();
  for (const segment of segments) {
    if (segment === '') throw new StoreError('A route has no empty segment (//).');
    if (segment.startsWith(':')) {
      if (!PARAM_RE.test(segment)) throw new StoreError(`"${segment}" is not a parameter: use :name with letters, digits and underscore.`);
      if (params.has(segment)) throw new StoreError(`The parameter ${segment} appears twice.`);
      params.add(segment);
    } else if (!SEGMENT_RE.test(segment)) {
      throw new StoreError(`"${segment}" is not a route segment: use letters, digits, dot, dash and underscore, or :name for a parameter.`);
    }
  }
  return segments;
}

export function routeParams(route) {
  return parseRoute(route).filter((s) => s.startsWith(':')).map((s) => s.slice(1));
}

// The shape of a route: its literals, with every parameter reduced to ":" - two routes of one
// shape match exactly the same requests, whatever their parameters are called.
export function routeShape(route) {
  return parseRoute(route).map((s) => (s.startsWith(':') ? ':' : s)).join('/');
}

export function sameShape(a, b) {
  return a.method === b.method && routeShape(a.route) === routeShape(b.route);
}

// The order routes are registered in: the more specific first - at each segment from the
// left a literal beats a parameter - then by name, so /customers/latest answers before
// /customers/:id and /customers/:id before /:kind/:id.
export function routeOrder(a, b) {
  const sa = parseRoute(a.route);
  const sb = parseRoute(b.route);
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i += 1) {
    const pa = sa[i].startsWith(':');
    const pb = sb[i].startsWith(':');
    if (pa !== pb) return pa ? 1 : -1;
  }
  if (sa.length !== sb.length) return sa.length - sb.length;
  return String(a.name).localeCompare(String(b.name));
}

// The document as the store keeps it, every field checked; anything wrong is a 400 with the
// reason. Missing fields take the defaults, so an older or hand-written file still loads.
export function validateApi(raw, { name } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const method = String(src.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new StoreError(`The method must be one of ${METHODS.join(', ')}.`);
  const route = typeof src.route === 'string' ? src.route.trim() : '';
  parseRoute(route);
  const target = typeof src.target === 'string' ? src.target.trim() : '';
  if (target && !TARGET_RE.test(target)) throw new StoreError(`"${target}" is not a server function: use Module.script.function.`);
  const args = src.args === undefined ? 'named' : src.args;
  if (!ARGS.includes(args)) throw new StoreError(`The arguments mode must be one of ${ARGS.join(', ')}.`);
  const auth = src.auth === undefined ? 'any' : src.auth;
  if (!AUTH.includes(auth)) throw new StoreError(`The access rule must be one of ${AUTH.join(', ')}.`);
  const roles = [];
  for (const role of Array.isArray(src.roles) ? src.roles : []) {
    const clean = String(role ?? '').trim();
    if (!clean) continue;
    if (clean.length > 40) throw new StoreError(`Role "${clean}" is longer than 40 characters.`);
    if (!roles.includes(clean)) roles.push(clean);
  }
  const enabled = Boolean(src.enabled);
  if (enabled && !target) throw new StoreError('An enabled API needs a function to run.');
  const description = typeof src.description === 'string' ? src.description.trim().slice(0, 500) : '';
  return { name: name || src.name, method, route, target, args, auth, roles, enabled, description };
}

// No two enabled APIs of one method may share a route shape: the second would never be
// reached, and which one answered would depend on their names.
export function assertNoClash(name, doc, others) {
  if (!doc.enabled) return;
  for (const other of others || []) {
    if (other.name === name || !other.enabled) continue;
    if (sameShape(doc, other)) {
      throw new StoreError(`${doc.method} ${doc.route} is already taken by ${other.name} (${other.route}); a route of the same shape answers the same requests.`, 409);
    }
  }
}

// Every API on disk, normalised; an unreadable or invalid file is skipped with a warning
// rather than taking the rest down. `files` is the store to read from: this process's own
// project unless another project's is given (the preview host reads any project's).
export async function readAll({ warn = (msg) => console.warn(`[apis] ${msg}`), files = store } = {}) {
  const out = [];
  for (const name of await files.list('apis')) {
    try {
      const { api } = await files.read('apis', name);
      out.push(validateApi(api, { name }));
    } catch (err) {
      warn(`${name}: ${err.message}`);
    }
  }
  return out;
}

// --- the call itself --------------------------------------------------------------

function refused(status, message) {
  return { status, error: { message } };
}

// Who is calling, by the API's rule. Only `public` answers an anonymous caller; every other
// rule needs a principal - a user of the app's session or an API key - and with sign-in off
// there is no user to be signed in, so `session` refuses and `any` takes a key alone.
function principalFor(api, principal) {
  const { user = null, key = null, token = null, crossSite = false } = principal || {};
  if (api.auth === 'public') return { ok: true, user: null, key: null };
  if (token && !key) return { ok: false, reply: refused(401, 'The API key is not valid.') };
  const takesKey = api.auth === 'key' || api.auth === 'any';
  const takesSession = api.auth === 'session' || api.auth === 'any';
  let who = null;
  if (takesKey && key) who = { role: key.role, key, user: null };
  else if (takesSession) {
    if (!authEnabled()) {
      return { ok: false, reply: refused(401, api.auth === 'session' ? 'Sign-in is off for this project, so nobody can call this API as a signed-in user.' : 'Send an API key: sign-in is off for this project, so nobody can call this API as a signed-in user.') };
    }
    if (!user) return { ok: false, reply: refused(401, takesKey ? 'Sign in or send an API key.' : 'Sign in to continue.') };
    if (crossSite) return { ok: false, reply: refused(403, 'This API cannot be called with a session from another site.') };
    who = { role: user.role, key: null, user };
  } else return { ok: false, reply: refused(401, 'Send an API key.') };
  if (api.roles.length && !api.roles.includes(who.role)) return { ok: false, reply: refused(403, `This API is for ${api.roles.join(', ')}; ${who.key ? `the key ${who.key.name}` : user.email} is ${who.role}.`) };
  return { ok: true, user: who.user, key: who.key };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The arguments handed to the function. `named`: each parameter takes the route parameter of
// its name, else the query value, else the body field; a function with one parameter and a
// body that has no field of that name gets the whole body; a rest parameter takes an array
// body. `body`: the body is the argument list, as callServer takes it.
export async function mapArguments(api, { params = {}, query = {}, body }) {
  if (api.args === 'body') return Array.isArray(body) ? body : body === undefined ? [] : [body];
  const names = await functionParams(api.target);
  if (!names) throw new ScriptError(`"${api.target}" is not a function of a server script.`, 500);
  const bodyObject = isPlainObject(body) ? body : null;
  const hasBody = body !== undefined && !(bodyObject && Object.keys(bodyObject).length === 0);
  return names.map((p) => {
    if (p.rest) return Array.isArray(body) ? body : [];
    if (Object.hasOwn(params, p.name)) return params[p.name];
    if (Object.hasOwn(query, p.name)) return query[p.name];
    if (bodyObject && Object.hasOwn(bodyObject, p.name)) return bodyObject[p.name];
    if (names.length === 1 && hasBody) return body;
    return undefined;
  });
}

const HIDDEN_HEADERS = new Set(['cookie', 'authorization', 'x-api-key']);

// One call: the access check, the `request` the function sees, the arguments, the function,
// and the outcome as { status, body | file | error }. A thrown error keeps its status when it
// has one (a script may throw with status 404) and is a 500 otherwise; the stack rides along
// for the designer and is never sent outside.
export async function invoke(api, { method, path, params = {}, query = {}, body, headers = {}, principal } = {}) {
  if (!api.enabled) return refused(404, 'This API is disabled.');
  const who = principalFor(api, principal);
  if (!who.ok) return who.reply;
  const shown = {};
  for (const [name, value] of Object.entries(headers || {})) if (!HIDDEN_HEADERS.has(name.toLowerCase())) shown[name.toLowerCase()] = value;
  const request = {
    method: String(method || api.method).toUpperCase(),
    path: path || api.route,
    params: { ...params },
    query: { ...query },
    body,
    headers: shown,
    key: who.key ? { name: who.key.name, role: who.key.role } : null
  };
  try {
    const args = await mapArguments(api, { params, query, body });
    const result = await callServer(api.target, args, { user: who.user, request });
    if (result === undefined) return { status: 204 };
    if (isFileSend(result)) return { status: 200, file: result };
    return { status: 200, body: result };
  } catch (err) {
    const status = err instanceof ScriptError ? err.status : Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    return { status, error: { message: err.message }, stack: err.detail || err.stack };
  }
}

// --- the router ---------------------------------------------------------------

function handler(api) {
  return async (req, res) => {
    let outcome;
    try {
      const { token, key } = keyFromHeaders(req.headers);
      const principal = { user: req.user || null, key, token, crossSite: String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site' };
      outcome = await invoke(api, { method: req.method, path: req.path, params: req.params, query: req.query, body: req.body, headers: req.headers, principal });
    } catch (err) {
      outcome = { status: err.status || 500, error: { message: err.message } };
    }
    if (outcome.error) {
      if (outcome.status === 401) res.set('WWW-Authenticate', 'Bearer');
      res.status(outcome.status).json({ error: { message: outcome.error.message } });
      return;
    }
    if (outcome.file) {
      try {
        const stream = await openReadStream(outcome.file.path);
        res.set(downloadHeaders(outcome.file));
        stream.on('error', (err) => {
          if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
          else res.destroy(err);
        });
        stream.pipe(res);
      } catch (err) {
        res.status(err.status || 500).json({ error: { message: err.message } });
      }
      return;
    }
    if (outcome.status === 204) res.status(204).end();
    else res.status(outcome.status).json(outcome.body === undefined ? null : outcome.body);
  };
}

let current = express.Router();
let defs = [];

export const registry = {
  // Reads every definition and builds the router anew, the enabled ones in route order.
  async refresh(options) {
    const all = await readAll(options);
    const router = express.Router();
    const enabled = all.filter((api) => api.enabled && api.target).sort(routeOrder);
    for (const api of enabled) router[api.method.toLowerCase()](api.route, handler(api));
    defs = all;
    current = router;
    return all;
  },
  router(req, res, next) {
    current(req, res, next);
  },
  list() {
    return defs;
  }
};

// A file answer described for the designer's Try it, which cannot stream.
export async function describeFile(sent) {
  const stat = await statFile(sent.path).catch(() => null);
  const headers = downloadHeaders(sent);
  return { name: sent.name || sent.path.split('/').pop(), type: headers['Content-Type'] || headers['content-type'] || 'application/octet-stream', size: stat ? stat.size : null, path: sent.path };
}

export { ADMIN_ROLE };
