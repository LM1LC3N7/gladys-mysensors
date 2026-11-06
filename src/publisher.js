// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute.
//
// Nodes push their values when they like (a node may send a temperature
// every second). The publisher keeps the LAST value of each feature with the
// time it came, sends the pending ones every second within a per-minute
// budget, skips the unchanged ones (publishChangedStates), spaces the
// measurements of a same feature (TIMINGS.measurementSpacing) and drops a
// value that waited longer than TIMINGS.stateFresh (never published late as
// new). On/off values are never spaced, only budgeted. A command never waits
// for it. Monotonic clock only.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({ gladys, logger, monotonic, timers = globalThis, budget = LIMITS.statesPerMinute }) {
    this.gladys = gladys;
    this.logger = logger;
    this.monotonic = monotonic;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { state, at, spaced } */
    this.pending = new Map();
    /** featureId -> last send time */
    this.lastSent = new Map();
    /** send times of the last minute */
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flush);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** A value read now (`spaced`: a measurement, sent at most every few seconds). */
  push(featureId, state, { spaced = false } = {}) {
    this.pending.set(featureId, { state, at: this.monotonic(), spaced });
  }

  /** Forget everything (a reconnection to Gladys: nothing old is sent as new). */
  clear() {
    this.pending.clear();
    this.lastSent.clear();
  }

  /** Forget a device (deleted): its pending values are dropped. */
  forget(deviceId) {
    for (const map of [this.pending, this.lastSent]) {
      for (const key of map.keys()) {
        if (key === deviceId || key.startsWith(`${deviceId}:`)) map.delete(key);
      }
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.monotonic();
    this.window = this.window.filter((t) => now - t < 60_000);
    let room = this.budget - this.window.length;
    const batch = [];
    for (const [featureId, entry] of this.pending) {
      if (now - entry.at > TIMINGS.stateFresh) {
        this.pending.delete(featureId);
        continue;
      }
      if (room <= 0) continue;
      const last = this.lastSent.get(featureId);
      if (entry.spaced && last !== undefined && now - last < TIMINGS.measurementSpacing) continue;
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, state: entry.state, at: entry.at });
      room -= 1;
    }
    if (batch.length === 0) return 0;
    try {
      const result = await this.gladys.publishChangedStates(
        batch.map(({ device_feature_external_id: id, state }) => ({
          device_feature_external_id: id,
          state,
        })),
        { heartbeat: TIMINGS.stateHeartbeat },
      );
      for (const entry of batch) this.lastSent.set(entry.device_feature_external_id, now);
      const count = result?.count ?? batch.length;
      for (let i = 0; i < count; i += 1) this.window.push(now);
      return count;
    } catch (err) {
      // Kept for the next round (still dropped once too old), unless a newer one came meanwhile.
      for (const { device_feature_external_id: id, state, at } of batch) {
        if (!this.pending.has(id)) this.pending.set(id, { state, at, spaced: false });
      }
      throw err;
    }
  }
}
