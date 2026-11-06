// -----------------------------------------------------------------------------
// The integration: one link to the MySensors gateway (TCP Ethernet gateway or
// MQTT gateway through the broker of the user), the nodes it hears, their
// devices and states, the commands, the stops and /data.
//
// Link: one at a time; a new one only once the previous one is closed. After
// a failure or a dead link the next attempt waits longer each time (1 s up to
// 1 min), never a storm; a stop clicked meanwhile tries at once. The gateway
// is "connected" only once it sent a valid MySensors message on this link
// (its version is asked when the link opens and every minute); over TCP a
// link silent for 150 s is closed.
//
// Stops (a relay or a light turned off, a brightness of 0): never held by
// the option, the declaration, the configuration not read yet, the link not
// verified yet or a busy /data. Sent at once when the link is open (else the
// link is opened at once, and every kept stop leaves first when it opens),
// with the echo of the node asked; confirmed by that echo or by a report of
// the node showing it off, after the send. Not confirmed: sent again after
// 1.5 s, 5 s, 20 s and 1 min (5 sends), then reported as abandoned. Only an
// effective send counts. Kept in /data (route, node, child, count) until
// confirmed, sent again after a restart before the configuration is read.
// A command of the same target that actually left afterwards cancels it.
//
// Clock: the monotonic clock for every wait and decision; the wall clock
// only for what /data keeps (ids handed out, the time of the next try after
// refused credentials).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { randomBytes } from 'node:crypto';
import {
  GATEWAY_NODE,
  I,
  KIND,
  LIMITS,
  NODE_CHILD,
  NODE_MAX,
  S,
  TIMINGS,
  TRANSPORTS,
  TYPE,
  V,
  ASSIGN_MIN,
  BROADCAST,
  MQTT_PREFIX,
} from './constants.js';
import { normalizeConfig, routeOf, sessionKey } from './config.js';
import {
  COMMAND_KINDS,
  KINDS,
  buildNode,
  cleanText,
  commandOf,
  featureKey,
  kindOfValue,
  kindsOfPresentation,
  kindsReading,
  nodeIds,
  parseExternalId,
} from './model.js';
import { discoverMessage, sameCommand } from './protocol.js';
import { StatePublisher } from './publisher.js';
import {
  authWait,
  credentialsMark,
  emptyMemory,
  fileStore,
  normalizeMemory,
  serializeMemory,
} from './store.js';
import { ERRORS, T, TEST, age, join, targetList, word } from './i18n.js';
import { openTcp as defaultOpenTcp } from './tcp.js';
import { errorReason, openMqtt as defaultOpenMqtt } from './mqtt.js';

const TIMEOUT = Symbol('timeout');
/** Sends of one stop before it is reported as abandoned (2 in the click, then 3). */
export const STOP_SENDS = 5;
const STOP_WAITS = [TIMINGS.stopRetryInClick, ...TIMINGS.stopResends];

/** A stop kept in memory (see the header of the class). */
const newStop = (node, child, sends) => ({
  node,
  child,
  /** Sends proven read by the gateway (an answer after it, or an echo). */
  sends,
  /** Writes of this process since the click (the resend schedule). */
  writes: 0,
  sentHere: false,
  writtenOn: undefined,
  proofAt: 0,
  onReports: 0,
  abandoned: sends >= STOP_SENDS,
  timer: undefined,
  waiters: [],
});

/** A promise bounded in time: `fallback` when it takes longer. */
function bounded(promise, ms, timers, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

export class CommandError extends Error {
  constructor(text) {
    super(text.en);
    this.name = 'CommandError';
    this.text = text;
  }
}

const isMeasurement = (kind) => KINDS[kind]?.feature.type === 'decimal';

export class MySensorsApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'mysensors' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    openTcp = defaultOpenTcp,
    openMqtt = defaultOpenMqtt,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.openTcp = openTcp;
    this.openMqtt = openMqtt;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
    this.config = undefined;
    this.memory = emptyMemory();
    /** 'unknown' (not loaded yet) | 'ok' | 'unreadable'. */
    this.memoryState = 'unknown';
    this.memoryLoading = undefined;
    this.memoryTimer = undefined;
    this.writable = true;
    this.closed = false;
    this.booted = undefined;
    this.lifecycle = Promise.resolve();
    this.configFailures = 0;
    this.configSeq = 0;
    this.switching = false;
    this.configTimer = undefined;
    this.configAt = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.devicesTimer = undefined;
    this.createdCache = undefined;
    // Link.
    this.link = undefined;
    this.linkKey = undefined;
    this.linkTarget = undefined;
    this.linking = undefined;
    this.linkGen = 0;
    this.failures = 0;
    this.retryTimer = undefined;
    this.nextAttemptAt = undefined;
    this.reason = undefined;
    this.protocolVersion = 5;
    this.unanswered = 0;
    this.authUntil = undefined;
    this.authTimer = undefined;
    this.keepaliveTimer = undefined;
    this.resetSession();
    /** node id -> what was heard of it (presentations, values, battery). */
    this.nodes = new Map();
    /** "node:child" -> the stop (see the header). */
    this.stops = new Map();
    /** Commands waiting for their echo. */
    this.waiters = [];
    this.versionWaiters = [];
    this.dropped = 0;
    this.bucket = { tokens: LIMITS.linesPerSecond, at: 0 };
    this.answeredAt = new Map();
    this.idNote = undefined;
    this.assigning = false;
    this.lastScanAt = -Infinity;
    this.lastDiscoverAt = -Infinity;
    /** "node:child" of the stops lifted by the node turned on again in place. */
    this.overridden = new Set();
    this.urgentAfterAttempt = false;
    this.asked = 0;
    this.answered = 0;
    this.scanTimers = new Set();
  }

  resetSession() {
    this.asked = 0;
    this.answered = 0;
    this.live = false;
    this.version = undefined;
    this.lastRx = this.monotonic();
    this.openedAt = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Configurations apply one at a time, in order, the last one winning. */
  serialized(fn) {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch((err) => this.logger.error(`MySensors: ${err.message}`));
    return run;
  }

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read (again until it comes, for life); the stops kept in
   * /data leave at once, before it.
   */
  async connected() {
    if (!this.booted) this.booted = this.boot();
    await this.booted;
    if (this.closed) return;
    this.published = undefined;
    this.lastStatus = undefined;
    this.createdCache = undefined;
    // A reconnection never republishes old states as new.
    this.publisher.clear();
    this.gladys.forgetPublishedStates?.();
    await this.readConfig();
  }

  async boot() {
    await this.loadMemory();
    this.publisher.start();
    this.scheduleKeepalive();
    if (this.dueStops().length > 0) this.ensureLink({ urgent: true });
  }

  /** getConfig(), tried again (5 s, 15 s, then every minute) until it answers, for life. */
  async readConfig() {
    if (this.closed) return;
    this.clearConfigTimer();
    const seq = this.configSeq;
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      if (this.closed || seq !== this.configSeq) return;
      const waits = TIMINGS.configRetry;
      const wait = waits[Math.min(this.configFailures, waits.length - 1)];
      this.configFailures += 1;
      this.configAt = this.monotonic() + wait;
      this.logger.warn(
        `Reading the configuration failed: ${err.message}; next try in ${age(wait)}`,
      );
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.readConfig().catch(() => {});
      }, wait);
      await this.updateStatus();
      return;
    }
    // A configuration saved meanwhile is newer: this read is dropped.
    if (seq !== this.configSeq) return;
    this.configFailures = 0;
    this.configAt = undefined;
    await this.applyConfig(raw ?? {}, { fromUser: false });
  }

  clearConfigTimer() {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** The configuration saved by the user: always applied, new credentials always tried. */
  configUpdated(raw = {}) {
    this.configSeq += 1;
    this.clearConfigTimer();
    this.configFailures = 0;
    this.configAt = undefined;
    return this.applyConfig(raw, { fromUser: true });
  }

  applyConfig(raw, { fromUser }) {
    return this.serialized(() => this.doApplyConfig(raw, { fromUser }));
  }

  async doApplyConfig(raw, { fromUser }) {
    if (this.closed) return;
    const next = normalizeConfig(raw);
    const previous = this.config;
    this.config = next;
    if (fromUser) {
      this.liftAuth();
    } else if (this.memory.auth.failures > 0) {
      // A restart: the spaced tries go on only if the refused pair is still the one configured.
      const same =
        next.transport === TRANSPORTS.MQTT &&
        this.memory.auth.salt &&
        this.memory.auth.mark ===
          credentialsMark(this.memory.auth.salt, next.username, next.password);
      if (!same) this.liftAuth();
    }
    const route = routeOf(next);
    if (JSON.stringify(route) !== JSON.stringify(this.memory.route)) {
      this.memory.route = route;
      this.saveLater();
    }
    const key = next.problem ? undefined : sessionKey(next);
    if (key !== this.linkKey || !previous) {
      await this.restartLink(key);
    }
    this.scheduleDevices(0);
    await this.updateStatus();
  }

  /** A new gateway (or none): the link closed, the next one opened once it is gone. */
  async restartLink(key) {
    if (key !== undefined && key === this.linkKey && this.link && !this.link.closed) return;
    // An attempt to the same gateway is going on: kept (its outcome plans the next try).
    if (key !== undefined && this.linking && this.linkingKey === key && !this.link) return;
    const gen = ++this.linkGen;
    this.switching = true;
    this.clearRetry();
    this.failures = 0;
    this.reason = undefined;
    this.protocolVersion = 5;
    this.unanswered = 0;
    const old = this.link;
    this.link = undefined;
    this.linkKey = undefined;
    if (old) {
      old.close('configuration changed');
      await bounded(old.closedSocket(), 2000, this.timers, undefined);
    }
    if (this.linking) await bounded(this.linking, 2000, this.timers, undefined);
    if (gen !== this.linkGen || this.closed) return;
    this.switching = false;
    // Another network: what was heard of the nodes no longer applies.
    if (this.heardKey !== key) {
      this.nodes.clear();
      this.heardKey = key;
    }
    this.resetSession();
    this.ensureLink({ urgent: true });
  }

  /** The SDK shutdown: no timer, no request after it; /data written. */
  async stop() {
    this.closed = true;
    this.linkGen += 1;
    this.clearConfigTimer();
    this.clearRetry();
    for (const timer of [this.authTimer, this.memoryTimer, this.devicesTimer]) {
      if (timer) this.timers.clearTimeout(timer);
    }
    if (this.keepaliveTimer) this.timers.clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    for (const timer of this.scanTimers) this.timers.clearTimeout(timer);
    this.scanTimers.clear();
    for (const stop of this.stops.values()) {
      if (stop.timer) this.timers.clearTimeout(stop.timer);
      stop.timer = undefined;
    }
    for (const w of this.waiters.splice(0)) {
      this.timers.clearTimeout(w.timer);
      w.resolve(false);
    }
    for (const w of this.versionWaiters.splice(0)) w.resolve(false);
    this.publisher.stop();
    const link = this.link;
    this.link = undefined;
    link?.close('stopped');
    await this.saveMemory();
  }

  // --- /data -----------------------------------------------------------------

  /** Loads /data within its bound; unreadable is never taken for empty (read again every 10 s). */
  async loadMemory() {
    if (this.memoryLoading) return this.memoryLoading;
    this.memoryLoading = (async () => {
      let raw;
      try {
        // One read at a time: a read that never ended is waited for again, never doubled.
        this.rawLoad ??= Promise.resolve(this.store.load()).finally(() => {
          this.rawLoad = undefined;
        });
        raw = await bounded(this.rawLoad, TIMINGS.storeLoad, this.timers, TIMEOUT);
      } catch (err) {
        this.logger.warn(`Reading /data failed: ${err.code ?? err.message}`);
        raw = TIMEOUT;
      }
      if (this.closed) return;
      if (raw === TIMEOUT) {
        this.memoryState = 'unreadable';
        this.lastStatus = undefined;
        if (!this.memoryTimer) {
          this.memoryTimer = this.timers.setTimeout(() => {
            this.memoryTimer = undefined;
            this.loadMemory()
              .then(() => this.afterLoad())
              .catch(() => {});
          }, TIMINGS.storeRetry);
        }
        return;
      }
      const loaded = normalizeMemory(raw, this.now());
      // What this process learnt while /data was unknown is kept (a click is never overwritten).
      if (this.config) loaded.route = routeOf(this.config);
      for (const entry of this.memory.ids) {
        if (!loaded.ids.some((e) => e.id === entry.id)) loaded.ids.push(entry);
      }
      if (this.memory.auth.failures > 0) loaded.auth = this.memory.auth;
      this.memory = loaded;
      this.memoryState = 'ok';
      this.lastStatus = undefined;
      for (const s of loaded.stops) {
        const key = `${s.node}:${s.child}`;
        if (!this.stops.has(key)) {
          this.stops.set(key, newStop(s.node, s.child, s.sends));
        }
      }
      if (loaded.auth.failures > 0 && loaded.auth.until > 0) {
        this.armAuth(loaded.auth.until - this.now());
      }
    })().finally(() => {
      this.memoryLoading = undefined;
    });
    return this.memoryLoading;
  }

  /** /data became readable: the stops it kept leave, the status says so. */
  async afterLoad() {
    if (this.closed || this.memoryState !== 'ok') return;
    if (this.dueStops().length > 0) {
      if (this.link && !this.link.closed) this.sendDueStops();
      else this.ensureLink({ urgent: true });
    }
    await this.updateStatus();
  }

  /** Saves /data within its bound; false when it was not written (never over an unreadable file). */
  async saveMemory() {
    if (this.memoryState !== 'ok') return false;
    this.memory.stops = [...this.stops.values()].slice(0, LIMITS.stops).map((s) => ({
      node: s.node,
      child: s.child,
      sends: s.sends,
    }));
    let ok;
    try {
      ok = await bounded(
        this.store.save(serializeMemory(this.memory)).then(() => true),
        TIMINGS.storeSave,
        this.timers,
        false,
      );
    } catch (err) {
      this.logger.warn(`Saving /data failed: ${err.code ?? err.message}`);
      ok = false;
    }
    if (ok !== this.writable) {
      this.writable = ok;
      this.lastStatus = undefined;
      this.updateStatus().catch(() => {});
    }
    return ok;
  }

  /** A save in the background (a stop never waits for /data). */
  saveLater() {
    this.saveMemory().catch(() => {});
  }

  // --- Link ------------------------------------------------------------------

  /** Where the link goes: the configuration, else (stops kept, configuration not read) /data. */
  linkConfig() {
    if (this.config) return this.config.problem ? undefined : this.config;
    const route = this.memory.route;
    if (!route || this.dueStops().length === 0) return undefined;
    return {
      ...route,
      problem: undefined,
      username: '',
      password: '',
      inPrefix: route.inPrefix ?? MQTT_PREFIX.out,
      outPrefix: route.outPrefix ?? MQTT_PREFIX.in,
    };
  }

  clearRetry() {
    if (this.retryTimer) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.nextAttemptAt = undefined;
  }

  get authStopped() {
    return this.authUntil !== undefined;
  }

  /** Opens the link unless it is open or opening; `urgent` (a click) skips the wait between tries. */
  ensureLink({ urgent = false } = {}) {
    if (this.closed || (this.link && !this.link.closed)) return;
    if (this.linking) {
      // A click during an attempt: if it fails, one more try at once (then the waits again).
      if (urgent) this.urgentAfterAttempt = true;
      return;
    }
    if (this.switching) {
      // The previous link is still closing: the next one opens right after.
      return;
    }
    const cfg = this.linkConfig();
    if (!cfg) return;
    if (cfg.transport === TRANSPORTS.MQTT && this.authStopped) return;
    if (this.retryTimer && !urgent) return;
    this.clearRetry();
    this.linkingKey = sessionKey(cfg);
    this.linking = this.openLink(cfg).finally(() => {
      this.linking = undefined;
      if (this.relinkNow) {
        this.relinkNow = false;
        this.ensureLink({ urgent: true });
      }
    });
  }

  async openLink(cfg) {
    const gen = this.linkGen;
    const key = sessionKey(cfg);
    const target = `${cfg.host}:${cfg.port}`;
    this.linkTarget = target;
    const holder = {};
    const handlers = {
      onMessage: (msg, meta) => {
        if (!holder.link || this.link !== holder.link) return;
        try {
          this.handleMessage(msg, meta);
        } catch (err) {
          // An unexpected message never stops the link nor the other nodes.
          this.dropped += 1;
          this.logger.warn(`A message of node ${msg?.node} was dropped: ${err.message}`);
        }
      },
      onClose: (reason) => {
        if (holder.link && this.link === holder.link) this.linkClosed(reason);
      },
      timers: this.timers,
    };
    this.lastStatus = undefined;
    this.updateStatus().catch(() => {});
    let link;
    try {
      link =
        cfg.transport === TRANSPORTS.TCP
          ? await this.openTcp(cfg, handlers)
          : await this.openMqtt(cfg, { ...handlers, protocolVersion: this.protocolVersion });
    } catch (err) {
      if (gen !== this.linkGen || this.closed) {
        // An attempt for an older configuration: the current one is tried right after.
        if (!this.closed) this.relinkNow = true;
        return;
      }
      await this.linkFailed(cfg, err);
      if (this.urgentAfterAttempt) {
        this.urgentAfterAttempt = false;
        this.relinkNow = true;
      }
      return;
    }
    if (gen !== this.linkGen || this.closed) {
      link.close('stale');
      if (!this.closed) this.relinkNow = true;
      return;
    }
    this.urgentAfterAttempt = false;
    holder.link = link;
    this.link = link;
    this.linkKey = key;
    this.heardKey ??= key;
    this.resetSession();
    this.openedAt = this.monotonic();
    if (link.closed) {
      // Closed between its opening and now: the next try is planned as for any close.
      this.linkClosed('connection closed');
      return;
    }
    this.reason = undefined;
    this.unanswered = 0;
    if (cfg.transport === TRANSPORTS.MQTT && this.memory.auth.failures > 0) {
      this.liftAuth();
      this.saveLater();
    }
    // Every kept stop first, then the version of the gateway (its answer proves
    // it alive, and that it read the stops).
    if (this.sendDueStops() === 0) this.askVersion();
    this.lastStatus = undefined;
    await this.updateStatus();
  }

  async linkFailed(cfg, err) {
    const reason = cfg.transport === TRANSPORTS.MQTT ? errorReason(err) : (err?.code ?? 'error');
    this.reason = typeof reason === 'string' ? reason.slice(0, 80) : 'error';
    if (cfg.transport === TRANSPORTS.MQTT) {
      if (err?.protocol && this.protocolVersion === 5) {
        this.logger.warn('The MQTT broker does not support MQTT 5: using MQTT 3.1.1');
        this.protocolVersion = 4;
        this.relinkNow = true;
        return;
      }
      const credentials = Boolean(cfg.username || cfg.password);
      if (err?.refusal) {
        await this.onRefused(cfg, this.reason);
        return;
      }
      if (err?.unanswered && credentials) {
        // A CONNECT with the credentials left without answer, twice in a row: a refusal.
        this.unanswered += 1;
        if (this.unanswered >= 2) {
          this.unanswered = 0;
          await this.onRefused(cfg, `${this.reason}, twice`);
          return;
        }
      }
    }
    this.logger.warn(`MySensors gateway ${cfg.host}:${cfg.port}: ${this.reason}`);
    this.failures += 1;
    this.scheduleRetry();
    this.lastStatus = undefined;
    await this.updateStatus();
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const waits = TIMINGS.reconnect;
    const wait = waits[Math.min(Math.max(this.failures, 1), waits.length) - 1];
    this.nextAttemptAt = this.monotonic() + wait;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.nextAttemptAt = undefined;
      this.ensureLink();
    }, wait);
  }

  linkClosed(reason) {
    const lived = this.openedAt === undefined ? 0 : this.monotonic() - this.openedAt;
    const closed = this.link;
    this.link = undefined;
    // Stops written on it and not proven read: never counted, sent again on the next link.
    for (const stop of this.stops.values()) {
      if (stop.writtenOn === closed) stop.writtenOn = undefined;
    }
    this.reason = typeof reason === 'string' ? reason.slice(0, 80) : 'closed';
    if (lived >= TIMINGS.stableSession) this.failures = 0;
    this.failures += 1;
    this.resetSession();
    for (const w of this.versionWaiters.splice(0)) w.resolve(false);
    this.scheduleRetry();
    this.lastStatus = undefined;
    this.updateStatus().catch(() => {});
  }

  /** The broker refused the credentials: no try before the spaced wait (persisted). */
  async onRefused(cfg, reason) {
    this.logger.warn(`MQTT broker refused the connection: ${reason}`);
    const failures = this.memory.auth.failures + 1;
    const wait = authWait(failures);
    const salt = this.memory.auth.salt ?? randomBytes(16).toString('hex');
    this.memory.auth = {
      failures,
      until: this.now() + wait,
      mark: credentialsMark(salt, cfg.username, cfg.password),
      salt,
    };
    this.reason = reason;
    this.armAuth(wait);
    this.saveLater();
    this.lastStatus = undefined;
    await this.updateStatus();
  }

  armAuth(wait) {
    if (this.authTimer) this.timers.clearTimeout(this.authTimer);
    this.authUntil = this.monotonic() + Math.max(0, wait);
    this.authTimer = this.timers.setTimeout(
      () => {
        this.authTimer = undefined;
        this.authUntil = undefined;
        this.ensureLink({ urgent: true });
      },
      Math.max(0, wait),
    );
  }

  /** New credentials, the test button or an accepted connection: the next try is now. */
  liftAuth() {
    if (this.authTimer) this.timers.clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.authUntil = undefined;
    this.unanswered = 0;
    if (this.memory.auth.failures > 0) {
      this.memory.auth = { failures: 0, until: 0, mark: undefined, salt: this.memory.auth.salt };
      this.saveLater();
    }
  }

  /** The next keepalive a full minute after the last answer of the gateway (or the last ask). */
  scheduleKeepalive() {
    if (this.closed) return;
    if (this.keepaliveTimer) this.timers.clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = this.timers.setTimeout(() => {
      this.keepaliveTimer = undefined;
      this.keepalive();
      this.scheduleKeepalive();
    }, TIMINGS.keepalive);
  }

  /** Every minute: the version of the gateway asked; a TCP link silent for too long closed. */
  keepalive() {
    if (this.closed) return;
    const link = this.link;
    if (!link || link.closed) return;
    const silent = this.monotonic() - this.lastRx;
    if (silent > TIMINGS.silence) {
      if (link.kind === 'tcp') {
        link.close('no answer from the gateway');
        return;
      }
      if (this.live) {
        this.live = false;
        this.lastStatus = undefined;
        this.updateStatus().catch(() => {});
      }
    }
    this.askVersion();
    this.updateStatus().catch(() => {});
  }

  /** Writes a message on the open link: true when it left. */
  send(msg) {
    const link = this.link;
    if (!link || link.closed) return false;
    try {
      return link.send(msg) === true;
    } catch (err) {
      this.logger.warn(`Sending to the gateway failed: ${err.message}`);
      return false;
    }
  }

  // --- Messages ----------------------------------------------------------------

  /** At most LIMITS.linesPerSecond messages handled per second. */
  takeToken() {
    const now = this.monotonic();
    const b = this.bucket;
    b.tokens = Math.min(
      LIMITS.linesPerSecond,
      b.tokens + ((now - b.at) / 1000) * LIMITS.linesPerSecond,
    );
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  handleMessage(msg, { retained = false } = {}) {
    // A retained message was kept by the broker: it may be hours old, never a value.
    if (retained) return;
    if (!this.takeToken()) {
      this.dropped += 1;
      return;
    }
    this.lastRx = this.monotonic();
    if (!this.live) {
      this.live = true;
      this.lastStatus = undefined;
      this.updateStatus().catch(() => {});
    }
    if (msg.node > NODE_MAX && !(msg.type === TYPE.INTERNAL && msg.sub === I.ID_REQUEST)) return;
    switch (msg.type) {
      case TYPE.PRESENTATION:
        this.onPresentation(msg);
        break;
      case TYPE.SET:
        this.onSet(msg);
        break;
      case TYPE.INTERNAL:
        this.onInternal(msg);
        break;
      default:
        // REQ (a node asking for a value the controller keeps) and STREAM (firmware) are not served.
        if (msg.node <= NODE_MAX) this.nodeInfo(msg.node);
        break;
    }
  }

  /** What is known of a node (created on its first message). */
  nodeInfo(id) {
    let info = this.nodes.get(id);
    if (!info) {
      info = {
        id,
        sketch: '',
        version: '',
        protocol: '',
        children: new Map(),
        values: new Map(),
        battery: undefined,
      };
      this.nodes.set(id, info);
      this.markIdSeen(id);
      this.scheduleDevices();
    }
    return info;
  }

  onPresentation(msg) {
    const info = this.nodeInfo(msg.node);
    if (msg.child === NODE_CHILD) {
      if (msg.sub === S.ARDUINO_NODE || msg.sub === S.ARDUINO_REPEATER_NODE) {
        info.protocol = cleanText(msg.payload);
        this.scheduleDevices();
      }
      return;
    }
    if (!info.children.has(msg.child) && info.children.size >= LIMITS.childrenPerNode) return;
    const previous = info.children.get(msg.child);
    const description = cleanText(msg.payload);
    if (previous?.sType !== msg.sub || previous?.description !== description) {
      info.children.set(msg.child, { sType: msg.sub, description });
      this.scheduleDevices();
    }
  }

  onSet(msg) {
    const info = this.nodeInfo(msg.node);
    if (msg.child === NODE_CHILD) return;
    const key = `${msg.child}:${msg.sub}`;
    if (info.values.has(key) || info.values.size < LIMITS.childrenPerNode * 4) {
      const known = info.values.has(key);
      info.values.set(key, {
        child: msg.child,
        sub: msg.sub,
        payload: msg.payload,
        at: this.monotonic(),
      });
      if (!known && !info.children.has(msg.child)) this.scheduleDevices();
    }
    if (msg.sub === V.STATUS && msg.payload === '0') this.stopSeen(msg.node, msg.child);
    else if (
      msg.ack === 0 &&
      ((msg.sub === V.STATUS && msg.payload === '1') ||
        (msg.sub === V.PERCENTAGE && /^[1-9]\d{0,2}$/.test(msg.payload)))
    ) {
      this.stopContradicted(msg.node, msg.child);
    }
    // An echo (ack 1) proves the node received a command, not that it applied
    // it: only the reports of the node (ack 0) are published as states.
    if (msg.ack === 1) {
      this.resolveEcho(msg);
      return;
    }
    this.queueValue(info, msg.child, msg.sub, msg.payload);
  }

  onInternal(msg) {
    switch (msg.sub) {
      case I.VERSION:
        if (msg.node === GATEWAY_NODE) {
          this.version = cleanText(msg.payload);
          this.answered += 1;
          this.proveStops();
          for (const w of this.versionWaiters.splice(0)) w.resolve(true);
          this.updateStatus().catch(() => {});
          // An answer (asked by the test button too) counts: the next ask a full minute later.
          this.scheduleKeepalive();
        }
        return;
      case I.GATEWAY_READY:
        // Once a minute at most (a forged "ready" never floods the radio network).
        if (msg.node === GATEWAY_NODE && this.monotonic() - this.lastDiscoverAt >= TIMINGS.scan) {
          this.lastDiscoverAt = this.monotonic();
          this.send(discoverMessage(I.DISCOVER));
        }
        return;
      case I.ID_REQUEST:
        this.assignId().catch((err) => this.logger.warn(`Handing out an id: ${err.message}`));
        return;
      default:
        break;
    }
    if (msg.node > NODE_MAX) return;
    const info = this.nodeInfo(msg.node);
    switch (msg.sub) {
      case I.BATTERY_LEVEL: {
        const value = KINDS[KIND.BATTERY].read(msg.payload);
        if (value === undefined) return;
        const first = info.battery === undefined;
        info.battery = { payload: msg.payload, at: this.monotonic() };
        if (first) this.scheduleDevices();
        const id = nodeIds(this.gladys, msg.node).feature(KIND.BATTERY);
        if (this.createdFeatures().has(id)) this.publisher.push(id, value);
        return;
      }
      case I.SKETCH_NAME: {
        const sketch = cleanText(msg.payload);
        if (sketch !== info.sketch) {
          info.sketch = sketch;
          this.scheduleDevices();
        }
        return;
      }
      case I.SKETCH_VERSION:
        info.version = cleanText(msg.payload);
        return;
      case I.CONFIG:
        // Metric: the values are read as °C, cm, hPa.
        if (this.mayAnswer(msg.node, I.CONFIG)) {
          this.send({
            node: msg.node,
            child: NODE_CHILD,
            type: TYPE.INTERNAL,
            ack: 0,
            sub: I.CONFIG,
            payload: 'M',
          });
        }
        return;
      case I.TIME:
        if (this.mayAnswer(msg.node, I.TIME)) {
          const local = this.now() - new Date(this.now()).getTimezoneOffset() * 60_000;
          this.send({
            node: msg.node,
            child: NODE_CHILD,
            type: TYPE.INTERNAL,
            ack: 0,
            sub: I.TIME,
            payload: String(Math.floor(local / 1000)),
          });
        }
        return;
      default:
        return;
    }
  }

  /** One answer (config, time) per node every 2 s at most. */
  mayAnswer(node, sub) {
    const now = this.monotonic();
    const key = `${node}:${sub}`;
    const last = this.answeredAt.get(key);
    if (last !== undefined && now - last < 2000) return false;
    if (this.answeredAt.size > 2 * NODE_MAX) this.answeredAt.clear();
    this.answeredAt.set(key, now);
    return true;
  }

  /** The kinds a value may feed for this child: those of its presentation, else all. */
  candidateKinds(info, child, sub) {
    const reading = kindsReading(sub);
    const presented = info.children.get(child);
    if (!presented) return reading;
    const allowed = new Set([
      ...kindsOfPresentation(presented.sType, true),
      ...kindsOfPresentation(presented.sType, false),
    ]);
    return reading.filter((kind) => allowed.has(kind));
  }

  queueValue(info, child, sub, payload, at) {
    const ids = nodeIds(this.gladys, info.id);
    const created = this.createdFeatures();
    for (const kind of this.candidateKinds(info, child, sub)) {
      const id = ids.feature(featureKey(child, kind));
      if (!created.has(id)) continue;
      const value = KINDS[kind].read(payload);
      if (value === undefined) continue;
      this.publisher.push(id, value, { spaced: isMeasurement(kind) });
      if (at !== undefined) this.publisher.pending.get(id).at = at;
    }
  }

  // --- Ids ---------------------------------------------------------------------

  markIdSeen(id) {
    const entry = this.memory.ids.find((e) => e.id === id);
    if (entry && !entry.seen) {
      entry.seen = true;
      this.saveLater();
    }
  }

  /**
   * A node without an id asked for one: the lowest id no node uses (heard,
   * created in Gladys or handed out before), kept in /data BEFORE it is
   * given. One at a time; an id handed out and not used by a node within
   * 5 min is given again; 10 unused at most.
   */
  async assignId() {
    if (!this.config || this.assigning) return;
    this.assigning = true;
    try {
      this.idNote = await this.giveId();
    } finally {
      this.assigning = false;
    }
    this.lastStatus = undefined;
    await this.updateStatus();
  }

  /** Hands out one id; the note for the status (undefined when given). */
  async giveId() {
    if (!this.config.assignIds) return T.idsOff;
    if (this.memoryState !== 'ok') return T.idsUnsaved;
    const wall = this.now();
    const unseen = this.memory.ids.filter((e) => !e.seen);
    let entry = unseen
      .filter((e) => wall - e.at >= TIMINGS.idReuse || e.at > wall)
      .sort((a, b) => a.at - b.at)[0];
    let added = false;
    if (entry) {
      entry.at = wall;
    } else {
      if (unseen.length >= LIMITS.unseenIds) return T.idsFull;
      const used = new Set([...this.nodes.keys(), ...this.memory.ids.map((e) => e.id)]);
      for (const device of this.gladys.devices ?? []) {
        const parsed = parseExternalId(device?.external_id);
        if (parsed) used.add(parsed.node);
      }
      let id;
      for (let n = ASSIGN_MIN; n <= NODE_MAX && id === undefined; n += 1) {
        if (!used.has(n)) id = n;
      }
      if (id === undefined) return T.idsFull;
      entry = { id, at: wall, seen: false };
      this.memory.ids.push(entry);
      added = true;
    }
    if (!(await this.saveMemory())) {
      // Not kept: never given (a restart could give it to another node).
      if (added) this.memory.ids = this.memory.ids.filter((e) => e !== entry);
      return T.idsUnsaved;
    }
    this.send({
      node: BROADCAST,
      child: NODE_CHILD,
      type: TYPE.INTERNAL,
      ack: 0,
      sub: I.ID_RESPONSE,
      payload: String(entry.id),
    });
    return undefined;
  }

  // --- Devices -----------------------------------------------------------------

  /** The external ids of the features created in Gladys. */
  createdFeatures() {
    if (!this.createdCache) {
      const set = new Set();
      for (const device of this.gladys.devices ?? []) {
        for (const feature of device?.features ?? []) {
          if (typeof feature?.external_id === 'string') set.add(feature.external_id);
        }
      }
      this.createdCache = set;
    }
    return this.createdCache;
  }

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  isSafe(node, child) {
    return this.config?.safe.has(`${node}:${child}`) === true;
  }

  /** The children of a node and their kinds, from its presentations and its values. */
  childrenOf(info) {
    const children = new Map();
    for (const [child, { sType, description }] of info.children) {
      const kinds = kindsOfPresentation(sType, this.isSafe(info.id, child));
      if (kinds.length > 0) children.set(child, { kinds, description });
    }
    for (const { child, sub } of info.values.values()) {
      if (info.children.has(child)) continue;
      const kind = sub === V.STATUS ? KIND.STATE : kindOfValue(sub);
      if (!kind) continue;
      const entry = children.get(child) ?? { kinds: [], description: '' };
      if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
      children.set(child, entry);
    }
    return children;
  }

  buildDevices() {
    const language = this.config?.language ?? 'en';
    const devices = [];
    for (const id of [...this.nodes.keys()].sort((a, b) => a - b)) {
      const info = this.nodes.get(id);
      const children = this.childrenOf(info);
      if (children.size === 0 && !info.battery) continue;
      const ids = nodeIds(this.gladys, id);
      devices.push(
        buildNode(
          this.gladys,
          { ...info, children, battery: Boolean(info.battery) },
          { language, created: this.createdDevice(ids.device) },
        ),
      );
      if (devices.length >= LIMITS.devices) break;
    }
    return devices;
  }

  /** The Discovery published again a little later (presentations come in bursts). */
  scheduleDevices(delay = 2000) {
    if (this.closed) return;
    if (this.devicesTimer) {
      if (delay > 0) return;
      this.timers.clearTimeout(this.devicesTimer);
    }
    this.devicesTimer = this.timers.setTimeout(() => {
      this.devicesTimer = undefined;
      this.publishDevices().catch(() => {});
    }, delay);
  }

  async publishDevices() {
    if (this.closed || !this.config) return;
    const devices = this.buildDevices();
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** Scan: the Discovery now; the nodes asked to present themselves (once a minute at most). */
  async scan() {
    const now = this.monotonic();
    if (this.live && now - this.lastScanAt >= TIMINGS.scan) {
      this.lastScanAt = now;
      this.send(discoverMessage(I.DISCOVER));
      const known = new Set(this.nodes.keys());
      for (const device of this.gladys.devices ?? []) {
        const parsed = parseExternalId(device?.external_id);
        if (parsed) known.add(parsed.node);
      }
      known.delete(GATEWAY_NODE);
      const asked = [...known]
        .filter((id) => (this.nodes.get(id)?.children.size ?? 0) === 0)
        .sort((a, b) => a - b)
        .slice(0, 50);
      asked.forEach((id, index) => {
        const timer = this.timers.setTimeout(
          () => {
            this.scanTimers.delete(timer);
            this.send({
              node: id,
              child: NODE_CHILD,
              type: TYPE.INTERNAL,
              ack: 0,
              sub: I.PRESENTATION,
              payload: '',
            });
          },
          (index + 1) * 250,
        );
        this.scanTimers.add(timer);
      });
    }
    this.published = undefined;
    await this.publishDevices();
  }

  /** A device created or updated: the values heard within the freshness window, never older. */
  async deviceCreated(device) {
    this.createdCache = undefined;
    const parsed = parseExternalId(device?.external_id);
    if (!parsed) return;
    const info = this.nodes.get(parsed.node);
    if (!info) return;
    const now = this.monotonic();
    for (const value of info.values.values()) {
      if (now - value.at <= TIMINGS.stateFresh) {
        this.queueValue(info, value.child, value.sub, value.payload, value.at);
      }
    }
    if (info.battery && now - info.battery.at <= TIMINGS.stateFresh) {
      const id = nodeIds(this.gladys, parsed.node).feature(KIND.BATTERY);
      const value = KINDS[KIND.BATTERY].read(info.battery.payload);
      if (this.createdFeatures().has(id) && value !== undefined) {
        this.publisher.push(id, value);
        this.publisher.pending.get(id).at = info.battery.at;
      }
    }
    this.published = undefined;
    this.scheduleDevices();
  }

  deviceDeleted(device) {
    this.createdCache = undefined;
    if (typeof device?.external_id === 'string') this.publisher.forget(device.external_id);
    this.published = undefined;
    this.scheduleDevices();
  }

  // --- Commands ----------------------------------------------------------------

  async setValue(device, feature, value) {
    const prefix = this.gladys.externalId ? this.gladys.externalId('node:') : undefined;
    const parsed = parseExternalId(feature?.external_id, prefix);
    if (!parsed || parsed.kind === undefined || !Object.hasOwn(COMMAND_KINDS, parsed.kind)) {
      throw new CommandError(ERRORS.unknownFeature);
    }
    const command = commandOf(parsed.kind, value);
    if (!command) throw new CommandError(ERRORS.badValue);
    const target = `${parsed.node}:${parsed.child}`;
    if (command.off) return this.stopClick(parsed.node, parsed.child);
    // Everything below is checked synchronously, then the message leaves: no
    // await between the checks and the send.
    if (!this.config || this.config.problem) throw new CommandError(ERRORS.noConfig);
    if (!this.isSafe(parsed.node, parsed.child)) throw new CommandError(ERRORS.notSafe(target));
    const presented = this.nodes.get(parsed.node)?.children.get(parsed.child);
    const expected = parsed.kind === KIND.RELAY ? S.BINARY : S.DIMMER;
    if (presented && presented.sType !== expected) throw new CommandError(ERRORS.otherType(target));
    if (!this.link || this.link.closed || !this.live) throw new CommandError(ERRORS.offline);
    const msg = {
      node: parsed.node,
      child: parsed.child,
      type: TYPE.SET,
      ack: 1,
      sub: command.sub,
      payload: command.payload,
    };
    const echo = this.waitEcho(msg);
    if (!this.send(msg)) {
      echo.cancel();
      throw new CommandError(ERRORS.offline);
    }
    // A newer command of the target left: the stop is not sent again over it.
    this.cancelStop(target);
    return (await echo.promise) ? 'confirmed' : 'unconfirmed';
  }

  /** A waiter for the echo of `msg` (registered before the send: an echo never comes too early). */
  waitEcho(msg) {
    if (this.waiters.length >= LIMITS.waiters) {
      return { promise: Promise.resolve(false), cancel() {} };
    }
    let entry;
    const promise = new Promise((resolve) => {
      entry = { msg, resolve, timer: undefined };
      entry.timer = this.timers.setTimeout(() => {
        this.removeWaiter(entry);
        resolve(false);
      }, TIMINGS.echo);
      this.waiters.push(entry);
    });
    return {
      promise,
      cancel: () => {
        this.timers.clearTimeout(entry.timer);
        this.removeWaiter(entry);
        entry.resolve(false);
      },
    };
  }

  removeWaiter(entry) {
    const at = this.waiters.indexOf(entry);
    if (at >= 0) this.waiters.splice(at, 1);
  }

  resolveEcho(msg) {
    const entry = this.waiters.find((w) => sameCommand(w.msg, msg));
    if (!entry) return;
    this.removeWaiter(entry);
    this.timers.clearTimeout(entry.timer);
    entry.resolve(true);
  }

  // --- Stops -------------------------------------------------------------------

  /** The stops still to send (not abandoned). */
  dueStops() {
    return [...this.stops.values()].filter((s) => !s.abandoned);
  }

  /**
   * A relay or a light turned off: never held. Resolves 'confirmed' (the
   * node echoed it or reported off), 'unconfirmed' (sent, no echo yet: sent
   * again) or 'kept' (nothing sent yet: the gateway is not connected; it
   * leaves as soon as it is).
   */
  async stopClick(node, child) {
    const key = `${node}:${child}`;
    let stop = this.stops.get(key);
    if (!stop) {
      stop = newStop(node, child, 0);
      this.stops.set(key, stop);
    }
    // A new click: the whole budget again.
    stop.sends = 0;
    stop.writes = 0;
    stop.onReports = 0;
    stop.abandoned = false;
    this.overridden.delete(key);
    if (stop.timer) this.timers.clearTimeout(stop.timer);
    stop.timer = undefined;
    const confirmed = new Promise((resolve) => stop.waiters.push(resolve));
    if (this.link && !this.link.closed) this.sendStop(stop);
    else this.ensureLink({ urgent: true });
    this.saveLater();
    this.lastStatus = undefined;
    this.updateStatus().catch(() => {});
    const done = await bounded(confirmed, TIMINGS.echo, this.timers, TIMEOUT);
    if (done !== TIMEOUT) return done;
    return stop.sends > 0 ? 'unconfirmed' : 'kept';
  }

  /** Asks the gateway its version: true when written (its answer proves what was written before). */
  askVersion() {
    const sent = this.send({
      node: GATEWAY_NODE,
      child: NODE_CHILD,
      type: TYPE.INTERNAL,
      ack: 0,
      sub: I.VERSION,
      payload: '',
    });
    if (sent) this.asked += 1;
    return sent;
  }

  /**
   * Writes a stop, then (unless `ask` is false: the caller asks once for
   * several) the version of the gateway. The write counts as a send only once
   * the gateway answered that ask on the same link (it read the stop before
   * it) or the node echoed it: a link closed before never counts.
   */
  sendStop(stop, { ask = true } = {}) {
    if (stop.abandoned || this.stops.get(`${stop.node}:${stop.child}`) !== stop) return false;
    const written = this.send({
      node: stop.node,
      child: stop.child,
      type: TYPE.SET,
      ack: 1,
      sub: V.STATUS,
      payload: '0',
    });
    if (stop.timer) this.timers.clearTimeout(stop.timer);
    stop.timer = undefined;
    if (!written) {
      // Not written (the link is closing): tried again shortly on an open
      // link; a link that opens sends it anyway. Never counted as a send.
      stop.timer = this.timers.setTimeout(() => {
        stop.timer = undefined;
        if (this.link && !this.link.closed) this.sendStop(stop);
      }, TIMINGS.stopRetryInClick);
      return false;
    }
    stop.writes += 1;
    stop.writtenOn = this.link;
    stop.proofAt = this.asked + 1;
    if (ask) this.askVersion();
    const wait = STOP_WAITS[Math.min(stop.writes - 1, STOP_WAITS.length - 1)];
    stop.timer = this.timers.setTimeout(() => this.stopDue(stop), wait);
    return true;
  }

  /** The resend time of a stop: sent again, or abandoned after STOP_SENDS proven sends. */
  stopDue(stop) {
    stop.timer = undefined;
    if (this.stops.get(`${stop.node}:${stop.child}`) !== stop) return;
    if (stop.sends >= STOP_SENDS) {
      stop.abandoned = true;
      this.logger.warn(
        `Off of node ${stop.node} child ${stop.child}: no echo after ${STOP_SENDS} sends`,
      );
      this.saveLater();
      this.lastStatus = undefined;
      this.updateStatus().catch(() => {});
      return;
    }
    // On an open link: sent again; else the link follows its waits (no storm without a click).
    if (this.link && !this.link.closed) this.sendStop(stop);
    else this.ensureLink();
  }

  /** Every kept stop, written at once, then one ask (a link just opened, /data just read). */
  sendDueStops() {
    let written = 0;
    for (const stop of this.dueStops()) {
      if (this.sendStop(stop, { ask: false })) written += 1;
    }
    if (written > 0) this.askVersion();
    return written;
  }

  /** The gateway answered an ask: the stops written before it on this link were read. */
  proveStops() {
    let proven = false;
    for (const stop of this.stops.values()) {
      if (stop.writtenOn && stop.writtenOn === this.link && stop.proofAt <= this.answered) {
        stop.writtenOn = undefined;
        stop.sends += 1;
        stop.sentHere = true;
        proven = true;
      }
    }
    if (proven) {
      this.saveLater();
      this.lastStatus = undefined;
      this.updateStatus().catch(() => {});
    }
  }

  /** A stop that may have reached the node: proven sent, or written on the open link. */
  stopLeft(stop) {
    return stop.sentHere || (stop.writtenOn !== undefined && stop.writtenOn === this.link);
  }

  /** The node showed the target off (echo or report) after a stop left: confirmed. */
  stopSeen(node, child) {
    const key = `${node}:${child}`;
    const stop = this.stops.get(key);
    if (!stop || !this.stopLeft(stop)) return;
    this.endStop(key, 'confirmed');
  }

  /**
   * The node reported itself on (its own button, a local rule) after the stop
   * left: twice in a row, the stop is lifted and never sent again over it (a
   * single report may have crossed the send).
   */
  stopContradicted(node, child) {
    const key = `${node}:${child}`;
    const stop = this.stops.get(key);
    if (!stop || !this.stopLeft(stop)) return;
    stop.onReports += 1;
    if (stop.onReports < 2) return;
    if (this.overridden.size >= 20) this.overridden.clear();
    this.overridden.add(key);
    this.endStop(key, 'overridden');
  }

  /** A newer command of the target left: the stop is over (never sent again over it). */
  cancelStop(key) {
    if (this.stops.has(key)) this.endStop(key, 'superseded');
  }

  endStop(key, outcome) {
    const stop = this.stops.get(key);
    if (!stop) return;
    if (stop.timer) this.timers.clearTimeout(stop.timer);
    stop.timer = undefined;
    this.stops.delete(key);
    for (const resolve of stop.waiters.splice(0)) resolve(outcome);
    this.saveLater();
    this.lastStatus = undefined;
    this.updateStatus().catch(() => {});
  }

  // --- Test button -------------------------------------------------------------

  async testConnection() {
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch {
      return TEST.noConfig;
    }
    await this.configUpdated(raw ?? {});
    if (!this.config || this.config.problem) return T.problem(this.config?.problem);
    this.ensureLink({ urgent: true });
    const answered = new Promise((resolve) => this.versionWaiters.push({ resolve }));
    // Asked on the open link (a link opening asks it by itself).
    if (this.link && !this.link.closed) this.askVersion();
    const ok = await bounded(answered, TIMINGS.test, this.timers, false);
    if (ok) {
      this.lastRx = this.monotonic();
      return TEST.ok(this.version, this.heardCount());
    }
    await this.updateStatus();
    const [, status] = this.statusText();
    return this.link && !this.link.closed ? TEST.silent : status;
  }

  // --- Status ------------------------------------------------------------------

  async updateStatus() {
    if (this.closed) return;
    const [connected, message] = this.statusText();
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  notes() {
    const notes = [];
    if (this.memoryState === 'unreadable') notes.push(T.dataUnreadable);
    else if (!this.writable) notes.push(T.dataUnwritable);
    const waiting = [];
    const unconfirmed = [];
    const abandoned = [];
    for (const stop of this.stops.values()) {
      const name = `${stop.node}:${stop.child}`;
      if (stop.abandoned) abandoned.push(name);
      else if (stop.sends === 0) waiting.push(name);
      else unconfirmed.push(name);
    }
    if (waiting.length) notes.push(T.stopsWaiting(targetList(waiting)));
    if (unconfirmed.length) notes.push(T.stopsUnconfirmed(targetList(unconfirmed)));
    if (abandoned.length) notes.push(T.stopsAbandoned(targetList(abandoned)));
    if (this.overridden.size) notes.push(T.stopsOverridden(targetList([...this.overridden])));
    if (this.config?.invalidSafe.length)
      notes.push(T.invalidSafe(this.config.invalidSafe.join(', ')));
    if (this.idNote) notes.push(this.idNote);
    const dropped = this.dropped + (this.link?.dropped ?? 0);
    if (dropped > 0) notes.push(T.dropped(dropped));
    if (this.link && !this.link.closed && this.link.kind === 'mqtt' && this.protocolVersion === 4) {
      notes.push(T.mqtt311);
    }
    return notes;
  }

  statusText() {
    const notes = this.notes();
    const mono = this.monotonic();
    if (!this.config) {
      const wait = this.configAt === undefined ? 1000 : this.configAt - mono;
      return [false, join(T.configUnread(age(Math.max(1000, wait))), ...notes)];
    }
    if (this.config.problem) return [false, join(T.problem(this.config.problem), ...notes)];
    const target = this.linkTarget ?? `${this.config.host}:${this.config.port}`;
    if (this.config.transport === TRANSPORTS.MQTT && this.authStopped) {
      return [
        false,
        join(
          T.refused(this.reason ?? 'refused', age(Math.max(1000, this.authUntil - mono))),
          ...notes,
        ),
      ];
    }
    if (!this.link || this.link.closed) {
      if (this.linking || !this.reason) return [false, join(T.connecting(target), ...notes)];
      const wait = Math.max(1000, (this.nextAttemptAt ?? mono) - mono);
      return [false, join(T.unreachable(target, this.reason, age(wait)), ...notes)];
    }
    if (!this.live) {
      if (
        this.link.kind === 'mqtt' &&
        this.openedAt !== undefined &&
        mono - this.lastRx > TIMINGS.silence
      ) {
        return [false, join(T.gatewaySilent(age(mono - this.lastRx)), ...notes)];
      }
      return [false, join(T.waitingGateway(target), ...notes)];
    }
    return [true, join(T.connected(this.version, this.heardCount()), ...notes)];
  }

  /** The nodes heard (the gateway counts only when it carries sensors itself). */
  heardCount() {
    let count = 0;
    for (const info of this.nodes.values()) {
      if (info.id !== GATEWAY_NODE || info.children.size > 0 || info.values.size > 0) count += 1;
    }
    return count;
  }

  /** For logs and tests: one language of the status. */
  statusIn(language = 'en') {
    return word(this.statusText()[1], language);
  }
}
