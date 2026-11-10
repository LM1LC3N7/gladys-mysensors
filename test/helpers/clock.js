// -----------------------------------------------------------------------------
// A virtual clock for an app that takes `now`, `monotonic` and `timers` by
// injection (the one of gladys-testkit, copied: the tests import nothing
// outside the repository). Nothing fires by itself; every read of the clock
// moves it by 1 µs (a decision reading it twice sees it move); `advance(ms)`
// fires the timers due on the way, in order, without awaiting their promise,
// with a turn of the event loop between two.
// -----------------------------------------------------------------------------

/** Lets pending promises and I/O callbacks run (a few turns of the event loop). */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const handle = (id) => ({
  id,
  ref() {
    return this;
  },
  unref() {
    return this;
  },
  hasRef: () => true,
});

export function testClock({ start = Date.UTC(2026, 0, 1), step = 0.001 } = {}) {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  const read = () => (t += step);
  const add = (fn, ms, args, every) => {
    const h = handle((seq += 1));
    const delay = Math.max(0, Number(ms) || 0);
    pending.set(h, { fn, args, at: t + delay, seq, every: every ? Math.max(1, delay) : 0 });
    return h;
  };
  const remove = (h) => pending.delete(h);
  const clock = {
    /**
     * Optional: true when no network message is on its way (set by the test
     * setup); `advance` never moves the time while it is false (bounded).
     */
    idle: undefined,
    now: () => start + read(),
    monotonic: () => read(),
    get elapsed() {
      return t;
    },
    get pending() {
      return pending.size;
    },
    timers: {
      setTimeout: (fn, ms, ...args) => add(fn, ms, args, false),
      setInterval: (fn, ms, ...args) => add(fn, ms, args, true),
      clearTimeout: remove,
      clearInterval: remove,
    },
    async advance(ms) {
      const target = t + ms;
      for (let guard = 0; guard < 100_000; guard += 1) {
        // Time never moves while a message is on its way (it would race the network).
        if (clock.idle) {
          await waitFor(clock.idle, 'the network to be idle', 15_000);
          await settle(2);
        }
        let next;
        for (const [h, timer] of pending) {
          if (
            timer.at <= target &&
            (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.seq < next[1].seq))
          ) {
            next = [h, timer];
          }
        }
        if (!next) break;
        const [h, timer] = next;
        t = Math.max(t, timer.at);
        if (timer.every) timer.at += timer.every;
        else pending.delete(h);
        timer.fn(...timer.args);
        await settle(1);
      }
      t = Math.max(t, target);
      await settle(1);
    },
  };
  return clock;
}

/** Waits (real time, bounded) for `condition()`; throws with `what` past `ms`. */
export async function waitFor(condition, what = 'condition', ms = 3000) {
  const deadline = performance.now() + ms;
  for (;;) {
    if (await condition()) return;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * A real clock sped up `speed` times (the one of gladys-testkit, copied):
 * timers divided by the speed, `now` and `monotonic` in simulated ms;
 * `close()` clears every timer still set.
 */
export function realClock({ speed = 1 } = {}) {
  const p0 = performance.now();
  const w0 = Date.now();
  const live = new Set();
  const wrap =
    (set, repeat) =>
    (fn, ms, ...args) => {
      clock.timersSet += 1;
      const h = set(
        () => {
          if (!repeat) live.delete(h);
          fn(...args);
        },
        Math.max(0, Number(ms) || 0) / speed,
      );
      live.add(h);
      return h;
    };
  const clear = (h) => {
    live.delete(h);
    clearTimeout(h);
  };
  const clock = {
    speed,
    timersSet: 0,
    get live() {
      return live.size;
    },
    now: () => w0 + (performance.now() - p0) * speed,
    monotonic: () => performance.now() * speed,
    timers: {
      setTimeout: wrap(setTimeout, false),
      setInterval: wrap(setInterval, true),
      clearTimeout: clear,
      clearInterval: clear,
    },
    close() {
      for (const h of live) clearTimeout(h);
      live.clear();
    },
  };
  return clock;
}
