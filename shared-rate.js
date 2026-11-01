// A rate that every thread of one process keeps together: how a runner holds what its scripts
// print to a budget of its own, however many worker threads print at once. The state is one
// number in shared memory - the moment the next line is due (the generic cell rate algorithm) -
// so the threads agree on it with one atomic compare-and-swap, and a thread that is refused
// only reads it. A SharedArrayBuffer reaches the threads of one process and no further: each
// project's runner, a process or a container of its own, has budgets nobody else draws on.

// Fresh cells for `count` rates, to hand to the threads that share them.
export function sharedRateCells(count = 2) {
  return new BigInt64Array(new SharedArrayBuffer(8 * count));
}

// `perSecond` lines a second, `burst` at most at once, kept in cells[index]. `now` is in
// microseconds; the default is the wall clock, which every thread reads alike.
export function createSharedRate({ perSecond, burst, cells, index = 0, now = () => Date.now() * 1000 }) {
  const interval = BigInt(Math.max(1, Math.round(1e6 / perSecond)));
  const limit = interval * BigInt(Math.max(1, Math.floor(burst)));
  return {
    // True when a line may go: the due moment moves on by one interval. An idle stretch banks
    // no more than the burst, since the moment never lags behind the present.
    take() {
      const t = BigInt(Math.floor(now()));
      for (;;) {
        const due = Atomics.load(cells, index);
        const next = (due > t ? due : t) + interval;
        if (next - t > limit) return false;
        if (Atomics.compareExchange(cells, index, due, next) === due) return true;
      }
    }
  };
}
