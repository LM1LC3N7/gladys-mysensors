// -----------------------------------------------------------------------------
// The app on a REAL moving clock (sped up 20 times) and a real local TCP
// gateway: the version of the gateway asked every minute (never early, a
// little late under load at most), a stop sent again after 1.5 s, 5 s and
// 20 s; nothing left running after stop.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MySensorsApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { fakeTcpGateway, waitUntil } from './helpers/fakeGateway.js';
import { realClock } from './helpers/clock.js';
import { F, SELECTOR, defaultDevices, quiet } from './helpers/app.js';

const SPEED = 20;

test('real clock: the gateway asked every minute; stop resends at 1.5 s, 5 s, 20 s; nothing after stop', async (t) => {
  // An injected network delay (FAKE_GATEWAY_DELAY, simulated ms) runs SPEED times faster too.
  const delay = (Number(process.env.FAKE_GATEWAY_DELAY) || 0) / SPEED;
  const gw = await fakeTcpGateway({ echo: false, delay });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { gateway_address: gw.address, safe_actuators: '12:1' },
    devices: defaultDevices(),
  });
  const app = new MySensorsApp({
    gladys,
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app, quiet);
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 500))]);
    clock.close();
    await gw.close();
  });
  const asks = [];
  const offs = [];
  gw.onReceive = (m) => {
    if (m.type === 3 && m.sub === 2) asks.push(clock.monotonic());
    if (m.type === 1 && m.payload === '0') offs.push(clock.monotonic());
  };
  await gladys.connect();
  await waitUntil(() => app.live, 'live', 3000);
  const click = clock.monotonic();
  await app.setValue({}, { external_id: F(12, 1, 'relay') }, 0);
  const period = TIMINGS.keepalive;
  // The keepalive asks only (each write of the stop is followed by its own ask).
  const keepalives = () => asks.filter((at) => !offs.some((o) => at >= o && at - o < 100));
  await waitUntil(() => keepalives().length >= 3, 'three keepalives', (3 * period) / SPEED + 3000);
  const kept = keepalives();
  const gaps = kept.slice(1).map((v, i) => v - kept[i]);
  for (const gap of gaps.slice(1)) {
    assert.ok(gap >= period * 0.98 && gap <= period * 1.5, `gap ${Math.round(gap)} ms`);
  }
  assert.ok(offs.length >= 4, `${offs.length} offs`);
  const expected = [0, 1500, 6500, 26500];
  offs.slice(0, 4).forEach((at, i) => {
    const late = at - click - expected[i];
    assert.ok(late >= -50 && late <= 1500, `send ${i}: ${Math.round(late)} ms late`);
  });
  await app.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const count = gw.received.length;
  await new Promise((resolve) => setTimeout(resolve, (2 * period) / SPEED));
  assert.equal(gw.received.length, count, 'nothing sent after stop');
  assert.equal(clock.live, 0, 'no timer left');
});
