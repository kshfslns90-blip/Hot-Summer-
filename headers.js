// The headers the platform and a runner exchange. A tiny module of its own, so that neither
// has to import the other's code to know the names.
// Set by the platform on a request that passed a project's preview session; the runner's /run
// surface trusts it instead of asking for the app's own sign-in.
export const PREVIEW_HEADER = 'x-appmaker-preview';
// The runner's own secret, made up by the platform for each runner it starts and sent on every
// request it forwards; the runner's /api and status answer nobody else.
export const RUNNER_TOKEN_HEADER = 'x-appmaker-runner-token';
// A client's poll that must not start a runner or count as activity on one: the platform
// answers 204 when the runner is down and forwards without touching it otherwise.
export const PASSIVE_HEADER = 'x-appmaker-passive';
