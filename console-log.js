// What server scripts print. A script's `console` is the object sandboxConsole() builds: what it
// prints is kept here in a ring buffer the designer's Console tab reads, and written to the real
// console too, so the terminal (and a deployed app's log) sees the lines. A worker thread has no
// buffer of its own to be read: it hands its lines to a sink, the message channel to the main
// thread, which stores them in its buffer.
//
// Both ways out are held to budgets of the whole runner, which all its threads share (see
// shared-rate.js), so a script stuck printing in a loop costs the runner's main thread, its
// memory and the platform's log only so much: the real console takes PRINT_PER_SECOND lines a
// second, the main thread takes KEEP_PER_SECOND a second from the workers, and what is left out
// is counted and said. The main thread's own lines go into the buffer unchecked: it is a ring,
// so a flood shows its latest lines there.
import util from 'node:util';
import { createRing } from './ring.js';
import { sharedRateCells, createSharedRate } from './shared-rate.js';

const CAP = 2000;
const MESSAGE_CAP = 4000;
const PRINT_PER_SECOND = 200;
const PRINT_BURST = 1000;
const KEEP_PER_SECOND = 1000;
const KEEP_BURST = 2000;
const SUMMARY_MS = 1000;
// The moment this process started: a client that sees a different epoch knows the buffer it
// was reading belongs to a runner that is gone.
const epoch = Date.now();

const lines = createRing(CAP);
let seq = 0;
let sink = null;

export function setSink(fn) {
  sink = fn;
}

export function append({ level = 'log', origin = null, message = '' }) {
  const entry = { seq: 0, t: Date.now(), level, origin, message: String(message) };
  if (sink) {
    sink(entry);
    return entry;
  }
  seq += 1;
  entry.seq = seq;
  lines.push(entry);
  return entry;
}

// The lines after `after` (a seq the client has already seen; 0 for everything kept).
export function since(after = 0) {
  const from = Number(after) || 0;
  return { epoch, last: seq, lines: lines.after(from) };
}

export function clear() {
  lines.clear();
}

const LEVELS = { log: 'log', info: 'info', debug: 'debug', warn: 'warn', error: 'error' };
const REAL = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };

// --- the budgets ----------------------------------------------------------------------------

const defaults = () => ({
  perSecond: PRINT_PER_SECOND,
  burst: PRINT_BURST,
  keepPerSecond: KEEP_PER_SECOND,
  keepBurst: KEEP_BURST,
  now: Date.now,
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  print: null
});
let settings = defaults();
// The runner's two budgets - the real console, and lines from the workers - in cells made here
// on the main thread and handed to every worker, so that all of them draw on the same two.
let cells = sharedRateCells(2);
let budget = makeBudget();
// What this thread left out and has not said yet, since when, and for whom.
const held = { print: 0, keep: 0 };
const mark = { print: 0, keep: 0 };
const heldOrigin = { print: null, keep: null };
let timer = null;

function makeBudget() {
  const now = () => settings.now() * 1000;
  return {
    print: createSharedRate({ perSecond: settings.perSecond, burst: settings.burst, cells, index: 0, now }),
    keep: createSharedRate({ perSecond: settings.keepPerSecond, burst: settings.keepBurst, cells, index: 1, now })
  };
}

// The cells the worker pool hands to every worker it starts.
export function consoleBudgetCells() {
  return cells;
}

// A worker draws on the runner's budgets: the main thread's cells.
export function useConsoleBudget(shared) {
  cells = shared;
  budget = makeBudget();
}

// For tests: fresh cells and counters, with the rates, the clock (ms), the timers and the real
// console's stand-in (`print(level, prefix, message)`) given.
export function setConsoleBudget(options = {}) {
  if (timer !== null) settings.clearTimer(timer);
  timer = null;
  settings = { ...defaults(), ...options };
  cells = sharedRateCells(2);
  budget = makeBudget();
  held.print = 0;
  held.keep = 0;
  heldOrigin.print = null;
  heldOrigin.keep = null;
}

function printLine(level, prefix, message) {
  if (settings.print) settings.print(level, prefix, message);
  else REAL[level].call(console, prefix, message);
}

const count = (n) => `${n.toLocaleString('en-US')} line${n === 1 ? '' : 's'}`;

// What was left out is said in a line of its own, which takes its token from the same budget.
function say(kind) {
  const n = held[kind];
  held[kind] = 0;
  mark[kind] = settings.now();
  if (kind === 'print') printLine('log', '[script]', `… ${count(n)} not printed to the server log (more than ${settings.perSecond} a second)`);
  else append({ level: 'warn', origin: heldOrigin.keep, message: `… ${count(n)} not shown here (the runner's jobs printed more than ${settings.keepPerSecond} a second)` });
}

// A script stuck in a loop never lets a timer fire: what it left out is said on the way, once
// the spell has lasted a second - by the next token it gets, in place of its line. (In a flood
// every token is taken the moment it comes; a summary that waited for one of its own would wait
// for ever.)
function due(kind) {
  return held[kind] > 0 && settings.now() - mark[kind] >= SUMMARY_MS;
}

// And when the thread is free again, a second after the first drop: what is left to say. A
// summary the budget refuses waits for the next second.
function flush() {
  timer = null;
  for (const kind of ['print', 'keep']) {
    if (held[kind] > 0 && budget[kind].take()) say(kind);
  }
  if (held.print > 0 || held.keep > 0) arm();
}

function arm() {
  if (timer !== null) return;
  timer = settings.setTimer(flush, SUMMARY_MS);
  if (typeof timer?.unref === 'function') timer.unref();
}

function hold(kind, origin) {
  if (held[kind] === 0) mark[kind] = settings.now();
  held[kind] += 1;
  heldOrigin[kind] = origin;
  arm();
}

// The `console` a script session gets. `origin` says who printed: the target the session was
// created for, or a job run's id.
export function sandboxConsole(origin = null) {
  const prefix = `[script${origin ? ` ${origin}` : ''}]`;
  const emit = (level) => (...args) => {
    // Into the Console buffer: the main thread's own always, a worker's within the budget. To
    // the real console: within the budget. A token that comes while a summary is due carries the
    // summary instead, and the line counts as left out. A line nothing wants is never formatted.
    let keep = sink === null || budget.keep.take();
    let print = budget.print.take();
    if (keep && sink !== null && due('keep')) {
      say('keep');
      keep = false;
    }
    if (print && due('print')) {
      say('print');
      print = false;
    }
    if (!keep) hold('keep', origin);
    if (!print) hold('print', origin);
    if (!keep && !print) return;
    let message;
    try {
      message = util.format(...args);
    } catch (err) {
      message = `[unprintable: ${err.message}]`;
    }
    if (message.length > MESSAGE_CAP) message = `${message.slice(0, MESSAGE_CAP)}…`;
    if (keep) append({ level, origin, message });
    if (print) printLine(level, prefix, message);
  };
  const out = {};
  for (const level of Object.keys(LEVELS)) out[level] = emit(level);
  out.dir = out.log;
  out.table = out.log;
  out.trace = out.error;
  out.assert = (condition, ...args) => {
    if (!condition) out.error('Assertion failed', ...args);
  };
  return out;
}
