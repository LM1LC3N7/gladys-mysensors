// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake gateway on a real local
// socket, a virtual clock and a /data in memory. Every wait is bounded: a test
// fails, never hangs, even under a mutant.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MySensorsApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildNode } from '../../src/model.js';
import { memoryStore } from '../../src/store.js';
import { fakeBroker, fakeTcpGateway } from './fakeGateway.js';
import { settle, testClock } from './clock.js';

export const SELECTOR = 'mysensors';
export const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** The external id of a feature: `F(12, 1, 'relay')`, `F(12, 'battery')`. */
export const F = (node, child, kind) =>
  child === 'battery'
    ? `ext:${SELECTOR}:node:${node}:battery`
    : `ext:${SELECTOR}:node:${node}${child === undefined ? '' : `:${child}-${kind}`}`;

/**
 * A device as the user created it: `children` { child: kinds[] }, `battery`.
 */
export function created(node, children, { battery = false, sketch = 'Sketch' } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const map = new Map(
    Object.entries(children).map(([child, kinds]) => [Number(child), { kinds, description: '' }]),
  );
  return buildNode(
    gladys,
    { id: node, sketch, version: '1.0', protocol: '2.3.2', children: map, battery },
    { language: 'en' },
  );
}

/** A relay node 12, child 1, declared safe; a temperature node 20. */
export const defaultDevices = () => [
  created(12, { 1: ['relay'] }),
  created(13, { 1: ['light', 'brightness'] }),
  created(20, { 0: ['temperature'], 1: ['humidity'], 2: ['door'] }, { battery: true }),
];

/**
 * `mqtt: true` for the MQTT gateway; `gateway` options of the fake; `config`
 * merged over the address of the fake; `devices` created in Gladys.
 */
export async function setup(t, options = {}) {
  const clock = options.clock ?? testClock();
  const gw =
    options.gw ??
    (options.mqtt ? await fakeBroker(options.gateway) : await fakeTcpGateway(options.gateway));
  const store = options.store ?? memoryStore(options.data ?? null);
  const config = options.mqtt
    ? { transport: 'mqtt', mqtt_broker: gw.address, ...options.config }
    : {
        transport: 'tcp',
        gateway_address: gw.address,
        safe_actuators: '12:1 13:1',
        ...options.config,
      };
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: options.devices ?? defaultDevices(),
  });
  const app = new MySensorsApp({
    gladys,
    logger: options.logger ?? quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    ...options.app,
  });
  registerHandlers(gladys, app, quiet);
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 200))]);
    await gw.close();
  });
  if (options.connect !== false) await gladys.connect();
  return { app, gladys, gw, clock, store, config };
}

/** Advances the virtual clock until `condition()` (real I/O runs in between), bounded. */
export async function until(clock, condition, what, { step = 10, max = 30_000 } = {}) {
  for (let spent = 0; spent <= max; spent += step) {
    await settle(3);
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await clock.advance(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The answer of a click, the virtual clock run until it comes (bounded). */
export async function answer(ctx, promise, { step = 5, max = 30_000 } = {}) {
  const box = { done: false };
  const settled = promise.then(
    (value) => {
      box.done = true;
      return value;
    },
    (err) => {
      box.done = true;
      throw err;
    },
  );
  // Handled now: a refusal is awaited by the caller, never an unhandled rejection meanwhile.
  settled.catch(() => {});
  await until(ctx.clock, () => box.done, 'answer', { step, max });
  return settled;
}

/** Waits until the gateway answered on the link (connected). */
export async function live(ctx) {
  await until(
    ctx.clock,
    () => ctx.app.live && ctx.app.link && !ctx.app.link.closed,
    'live gateway',
  );
  await settle(5);
}

/** A command through the SDK wiring (as Gladys sends it). */
export function command(ctx, featureId, value) {
  const device = ctx.gladys.devices.find((d) =>
    d.features.some((f) => f.external_id === featureId),
  );
  const feature = device?.features.find((f) => f.external_id === featureId) ?? {
    external_id: featureId,
  };
  return ctx.app.setValue(device, feature, value);
}

/** The states published to Gladys for one feature (values in order). */
export const statesOf = (gladys, featureId) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId).map((s) => s.state);

/** The last status of the integration, in English. */
export const status = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';

export { settle };
