// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one small JSON file readable by the container user only
// (0600), written through a temporary file, fsync and rename:
//   - the route to the gateway (transport, address, topic prefixes) when it
//     needs no credential: a stop kept here leaves after a restart before
//     the configuration of Gladys is read;
//   - the stops (offs) not confirmed by their node yet;
//   - the node ids handed out to nodes that asked for one;
//   - after the broker refused the credentials: the count, the time of the
//     next try and a 6-bit mark of the refused pair (salted, never the
//     password nor a usable hash of it: 64 possible values).
// Nothing secret.
//
// Bounded: the file is opened without following a link and without waiting
// (a FIFO or another special file is refused, never read), 64 KB at most; a
// save never waits more than `queueWait` for the one before it. The app also
// bounds every load and save (src/app.js): a /data that does not answer is
// unreadable or not written, never a wait.
// -----------------------------------------------------------------------------

import * as fsPromises from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { LIMITS, NODE_CHILD, NODE_MAX, NODE_MIN, PORTS, TIMINGS, TRANSPORTS } from './constants.js';
import { parseAddress, parsePrefix } from './config.js';

export const STATE_FILE = '/data/mysensors-state.json';
export const FORMAT = 1;
const MAX_BYTES = 64 * 1024;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export function fileStore(
  path = STATE_FILE,
  { fs = fsPromises, timers = globalThis, queueWait = TIMINGS.storeQueue } = {},
) {
  let previous = Promise.resolve();
  let count = 0;
  let placed = 0;
  let sharedBusy = false;
  return {
    /** null when there is no file; throws when it cannot be read, is not a plain file or does not parse. */
    async load() {
      let handle;
      try {
        handle = await fs.open(path, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw Object.assign(new Error('not a plain file'), { code: 'ESPECIAL' });
        }
        if (stat.size > MAX_BYTES) {
          throw Object.assign(new Error('state file too large'), { code: 'EFBIG' });
        }
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) {
          throw Object.assign(new Error('state file too large'), { code: 'EFBIG' });
        }
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await handle.close().catch(() => {});
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const seq = ++count;
      const before = previous;
      const write = (async () => {
        let timer;
        await Promise.race([
          before,
          new Promise((resolve) => {
            timer = timers.setTimeout(resolve, queueWait);
          }),
        ]);
        timers.clearTimeout(timer);
        const shared = !sharedBusy;
        if (shared) sharedBusy = true;
        const temporary = shared ? `${path}.tmp` : `${path}.tmp-${seq}`;
        try {
          const file = await fs.open(
            temporary,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW | NONBLOCK,
            0o600,
          );
          try {
            const stat = await file.stat();
            if (!stat.isFile()) {
              throw Object.assign(new Error('not a plain file'), { code: 'ESPECIAL' });
            }
            await file.writeFile(text, 'utf8');
            await file.sync();
          } finally {
            await file.close().catch(() => {});
          }
          if (seq < placed) {
            // A newer state is in place (this write hung meanwhile): never put back over it.
            await fs.unlink(temporary).catch(() => {});
            return;
          }
          await fs.rename(temporary, path);
          placed = Math.max(placed, seq);
        } finally {
          if (shared) sharedBusy = false;
        }
      })();
      previous = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests): `fail` makes the saves throw, `unreadable` the loads, `hang` both wait forever. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : structuredClone(initial),
    saves: 0,
    loads: 0,
    fail: false,
    unreadable: false,
    hang: false,
    hangSaves: false,
    async load() {
      this.loads += 1;
      if (this.hang) return new Promise(() => {});
      if (this.unreadable) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      if (this.hang || this.hangSaves) return new Promise(() => {});
      if (this.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const int = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

export const emptyMemory = () => ({
  format: FORMAT,
  route: undefined,
  stops: [],
  ids: [],
  auth: { failures: 0, until: 0, mark: undefined, salt: undefined },
});

function normalizeRoute(raw) {
  const transport = own(raw, 'transport');
  if (transport !== TRANSPORTS.TCP && transport !== TRANSPORTS.MQTT) return undefined;
  const host = own(raw, 'host');
  const port = own(raw, 'port');
  if (typeof host !== 'string' || int(port, 1, 65535) === undefined) return undefined;
  const address = parseAddress(`${host}:${port}`, PORTS[transport]);
  if (address.error) return undefined;
  if (transport === TRANSPORTS.TCP) return { transport, ...address };
  const inPrefix = parsePrefix(own(raw, 'inPrefix'), undefined);
  const outPrefix = parsePrefix(own(raw, 'outPrefix'), undefined);
  if (!inPrefix.prefix || !outPrefix.prefix || inPrefix.prefix === outPrefix.prefix) {
    return undefined;
  }
  return { transport, ...address, inPrefix: inPrefix.prefix, outPrefix: outPrefix.prefix };
}

/**
 * The file read back, repaired: only known keys of the expected shape (never
 * an inherited or `__proto__` key). A date in the future (a clock set back, a
 * hand-edited file) is now; an unreadable count of sends is 0 (the stop keeps
 * every resend).
 */
export function normalizeMemory(raw, now) {
  const memory = emptyMemory();
  memory.route = normalizeRoute(own(raw, 'route'));
  const stops = own(raw, 'stops');
  if (Array.isArray(stops)) {
    const seen = new Set();
    for (const entry of stops.slice(0, LIMITS.stops)) {
      const node = int(own(entry, 'node'), NODE_MIN, NODE_MAX);
      const child = int(own(entry, 'child'), 0, NODE_CHILD - 1);
      if (node === undefined || child === undefined || seen.has(`${node}:${child}`)) continue;
      seen.add(`${node}:${child}`);
      memory.stops.push({ node, child, sends: int(own(entry, 'sends'), 0, 99) ?? 0 });
    }
  }
  const ids = own(raw, 'ids');
  if (Array.isArray(ids)) {
    const seen = new Set();
    for (const entry of ids.slice(0, NODE_MAX)) {
      const id = int(own(entry, 'id'), 1, NODE_MAX);
      const at = own(entry, 'at');
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      memory.ids.push({
        id,
        at: Number.isFinite(at) && at > 0 ? Math.min(at, now) : now,
        seen: own(entry, 'seen') === true,
      });
    }
  }
  const auth = own(raw, 'auth');
  const failures = int(own(auth, 'failures'), 1, 1000);
  const until = own(auth, 'until');
  const mark = int(own(auth, 'mark'), 0, 63);
  const salt = own(auth, 'salt');
  const lastRetry = TIMINGS.authRetry.at(-1);
  memory.auth = {
    failures: failures ?? 0,
    until: Number.isFinite(until) && until > now ? Math.min(until, now + lastRetry) : 0,
    mark: failures ? mark : undefined,
    salt: typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt) ? salt : undefined,
  };
  return memory;
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  return {
    format: FORMAT,
    ...(memory.route ? { route: { ...memory.route } } : {}),
    stops: memory.stops.slice(0, LIMITS.stops).map((s) => ({
      node: s.node,
      child: s.child,
      sends: s.sends,
    })),
    ids: memory.ids.map((e) => ({ id: e.id, at: e.at, seen: e.seen === true })),
    auth: {
      failures: memory.auth.failures,
      until: memory.auth.until,
      ...(memory.auth.mark !== undefined ? { mark: memory.auth.mark } : {}),
      ...(memory.auth.salt ? { salt: memory.auth.salt } : {}),
    },
  };
}

/**
 * The 6-bit mark of a user name and password (salted): it tells, after a
 * restart, that the refused pair is still the one configured (then the
 * spaced tries go on); 64 values, so it says nothing usable of the password.
 */
export function credentialsMark(salt, username, password) {
  return createHash('sha256').update(`${salt}\0${username}\0${password}`).digest()[0] & 0x3f;
}

/** The wait after the n-th refusal in a row (1-based). */
export const authWait = (failures) =>
  TIMINGS.authRetry[Math.min(Math.max(failures, 1), TIMINGS.authRetry.length) - 1];
