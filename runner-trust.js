// The runner's own secret. The preview host makes one up for every runner it starts and sends
// it on each request it forwards; with it configured, the designer API at /designer/api and the status
// endpoint answer nobody else, and the preview mark on /run is believed only when it comes
// with the secret. Standalone (`npm run project`, no GD_RUNNER_TOKEN) nothing is checked, which
// is the development mode the boot log points out.
import crypto from 'node:crypto';
import { config } from './config.js';
import { RUNNER_TOKEN_HEADER, PREVIEW_HEADER } from './headers.js';

export function runnerTokenConfigured() {
  return Boolean(config.runnerToken);
}

// True when no token is configured, or the request carries it.
export function runnerTrusted(req) {
  if (!config.runnerToken) return true;
  const given = String(req.get(RUNNER_TOKEN_HEADER) || '');
  return given.length === config.runnerToken.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(config.runnerToken));
}

// A request the preview host vouches for: its preview mark, believed only when it comes with
// the runner's own secret. Without a secret there is no host to vouch for anything (a deployed
// app, a runner started by hand), so the mark is ignored.
export function previewVouched(req) {
  return Boolean(req.get(PREVIEW_HEADER)) && runnerTokenConfigured() && runnerTrusted(req);
}

export function requireRunnerToken(req, res, next) {
  if (runnerTrusted(req)) {
    next();
    return;
  }
  res.status(401).json({ error: { message: 'This surface answers the preview host alone.' } });
}
