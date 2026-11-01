// The latest entries of a log, kept in memory up to a fixed number: a circular buffer, so adding
// one is the same small step however full it is - a log that drops its oldest entry by shifting
// an array does work in proportion to its size on every line, which a flood of lines turns into
// a busy process. Entries carry an increasing `seq`, which is how a reader says where it is; the
// caller numbers them, and keeps numbering across a clear().
export function createRing(cap) {
  let capacity = Math.max(1, Math.floor(cap) || 1);
  let items = new Array(capacity);
  let start = 0; // where the oldest entry is
  let count = 0;

  const at = (i) => items[(start + i) % capacity];
  const slice = (from, to) => {
    const out = new Array(Math.max(0, to - from));
    for (let i = from; i < to; i++) out[i - from] = at(i);
    return out;
  };

  function push(entry) {
    if (count < capacity) {
      items[(start + count) % capacity] = entry;
      count += 1;
    } else {
      items[start] = entry;
      start = (start + 1) % capacity;
    }
    return entry;
  }

  // The latest `n` entries, oldest first.
  function last(n) {
    const k = Math.max(0, Math.min(count, Math.floor(n) || 0));
    return slice(count - k, count);
  }

  // The entries after `seq`, oldest first - the latest `limit` of them when there are more. The
  // first one is found by halving, and only what is returned is copied.
  function after(seq, limit = Infinity) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at(mid).seq > seq) hi = mid;
      else lo = mid + 1;
    }
    return slice(Math.max(lo, count - limit), count);
  }

  function clear() {
    items = new Array(capacity);
    start = 0;
    count = 0;
  }

  // A different size, keeping the newest entries that fit.
  function resize(next) {
    const kept = last(next);
    capacity = Math.max(1, Math.floor(next) || 1);
    items = new Array(capacity);
    start = 0;
    count = 0;
    for (const entry of kept) push(entry);
  }

  return { push, last, after, clear, resize, size: () => count, capacity: () => capacity };
}
