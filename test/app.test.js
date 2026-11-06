// -----------------------------------------------------------------------------
// The app end to end: fake Gladys, fake gateways on real local sockets,
// virtual clock, /data in memory.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  F,
  answer,
  command,
  created,
  live,
  settle,
  setup,
  status,
  statesOf,
  until,
} from './helpers/app.js';

test('TCP: the gateway answers its version; the status says connected', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  await until(ctx.clock, () => ctx.gladys.fake.connectionStatus?.connected === true, 'status');
  assert.match(status(ctx.gladys), /MySensors gateway 2\.3\.2 connected/);
  assert.equal(ctx.gw.peak, 1);
});

test('values of created features are published, converted; others never', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  ctx.gw.push('20;255;0;0;17;2.3.2');
  ctx.gw.push('20;0;0;0;6;Living room');
  ctx.gw.push('20;2;0;0;0;Front door');
  ctx.gw.push('20;0;1;0;0;21.5');
  ctx.gw.push('20;1;1;0;1;55');
  // V_TRIPPED 1: the door is open, Gladys 0.
  ctx.gw.push('20;2;1;0;16;1');
  ctx.gw.push('20;255;3;0;0;87');
  // A node never created: nothing published.
  ctx.gw.push('30;0;1;0;0;19.0');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(20, 2, 'door')).length > 0, 'door');
  await ctx.clock.advance(1000);
  assert.deepEqual(statesOf(ctx.gladys, F(20, 0, 'temperature')), [21.5]);
  assert.deepEqual(statesOf(ctx.gladys, F(20, 1, 'humidity')), [55]);
  assert.deepEqual(statesOf(ctx.gladys, F(20, 2, 'door')), [0]);
  assert.deepEqual(statesOf(ctx.gladys, F(20, 'battery')), [87]);
  assert.equal(statesOf(ctx.gladys, F(30, 0, 'temperature')).length, 0);
  ctx.gw.push('20;2;1;0;16;0');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(20, 2, 'door')).length > 1, 'door closed');
  assert.deepEqual(statesOf(ctx.gladys, F(20, 2, 'door')), [0, 1]);
});

test('a text, an empty payload or a value out of range is never a measurement', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  for (const payload of ['', 'nan', '21,5', ' 21', '1e3', '200', '-80', '0x10']) {
    ctx.gw.push(`20;0;1;0;0;${payload}`);
  }
  ctx.gw.push('20;1;1;0;1;101');
  ctx.gw.push('20;2;1;0;16;2');
  ctx.gw.push('20;255;3;0;0;150');
  await ctx.clock.advance(3000);
  await settle(10);
  assert.equal(statesOf(ctx.gladys, F(20, 0, 'temperature')).length, 0);
  assert.equal(statesOf(ctx.gladys, F(20, 1, 'humidity')).length, 0);
  assert.equal(statesOf(ctx.gladys, F(20, 2, 'door')).length, 0);
  assert.equal(statesOf(ctx.gladys, F(20, 'battery')).length, 0);
});

test('a measurement flood of one feature is spaced; on/off never', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  for (let i = 0; i < 10; i += 1) ctx.gw.push(`20;0;1;0;0;${20 + i}`);
  ctx.gw.push('12;1;1;0;2;1');
  ctx.gw.push('12;1;1;0;2;0');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(12, 1, 'relay')).length > 0, 'relay');
  await ctx.clock.advance(2000);
  // The last temperature only (the earlier ones were replaced before the flush).
  assert.deepEqual(statesOf(ctx.gladys, F(20, 0, 'temperature')), [29]);
  ctx.gw.push('20;0;1;0;0;30');
  await until(ctx.clock, () => ctx.app.publisher.pending.size > 0, 'queued', { step: 1 });
  await ctx.clock.advance(1500);
  assert.deepEqual(statesOf(ctx.gladys, F(20, 0, 'temperature')), [29]);
  await ctx.clock.advance(5000);
  assert.deepEqual(statesOf(ctx.gladys, F(20, 0, 'temperature')), [29, 30]);
  assert.deepEqual(statesOf(ctx.gladys, F(12, 1, 'relay')), [0]);
});

test('Discovery: presentations, sketch, battery; a relay is a switch only when declared safe', async (t) => {
  const ctx = await setup(t, { devices: [], config: { language: 'en' } });
  await live(ctx);
  ctx.gw.push('40;255;0;0;17;2.3.2');
  ctx.gw.push('40;255;3;0;11;Relay box');
  ctx.gw.push('40;255;3;0;12;1.2');
  ctx.gw.push('40;1;0;0;3;Pump');
  ctx.gw.push('40;2;0;0;4;Lamp');
  ctx.gw.push('40;3;0;0;14;Heater');
  ctx.gw.push('40;4;0;0;0;');
  ctx.gw.push('40;5;1;0;0;19.5');
  ctx.gw.push('40;255;3;0;0;90');
  await ctx.clock.advance(3000);
  await until(ctx.clock, () => ctx.gladys.fake.discoveredDevices.length === 1, 'discovery');
  let [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.name, 'Relay box (node 40)');
  const kinds = (d) =>
    d.features.map(
      (f) => `${f.external_id.split(':').pop()}=${f.category}/${f.type}/${f.read_only}`,
    );
  assert.deepEqual(kinds(device), [
    '1-state=unknown/binary/true',
    '2-state=unknown/binary/true',
    '2-level=unknown/integer/true',
    '3-state=unknown/binary/true',
    '4-door=opening-sensor/binary/true',
    '5-temperature=temperature-sensor/decimal/true',
    'battery=battery/integer/true',
  ]);
  assert.ok(device.params.some((p) => p.name === 'sketch' && p.value === 'Relay box'));
  // Declared safe: the pump relay becomes a switch, the lamp a light; never the heater.
  await ctx.gladys.fake.configUpdated({ ...ctx.config, safe_actuators: '40:1, 40:2 40:3' });
  await ctx.clock.advance(3000);
  await until(
    ctx.clock,
    () =>
      ctx.gladys.fake.discoveredDevices.length === 1 &&
      ctx.gladys.fake.discoveredDevices[0].features.some((f) => f.category === 'switch'),
    'safe',
  );
  [device] = ctx.gladys.fake.discoveredDevices;
  assert.deepEqual(kinds(device).slice(0, 4), [
    '1-relay=switch/binary/false',
    '2-light=light/binary/false',
    '2-brightness=light/brightness/false',
    '3-state=unknown/binary/true',
  ]);
  assert.ok(
    !device.features.some((f) => f.category === 'switch' && f.external_id.endsWith(':3-relay')),
  );
});

test('a device published again never loses a feature of the created device', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  ctx.gw.push('20;0;0;0;6;');
  await ctx.clock.advance(3000);
  await until(
    ctx.clock,
    () => ctx.gladys.fake.discoveredDevices.some((d) => d.external_id === F(20)),
    'discovery',
  );
  const device = ctx.gladys.fake.discoveredDevices.find((d) => d.external_id === F(20));
  const ids = device.features.map((f) => f.external_id);
  for (const id of [
    F(20, 0, 'temperature'),
    F(20, 1, 'humidity'),
    F(20, 2, 'door'),
    F(20, 'battery'),
  ]) {
    assert.ok(ids.includes(id), id);
  }
});

test('relay declared safe: on is echoed (confirmed); only a report of the node is a state', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  const outcome = await answer(ctx, command(ctx, F(12, 1, 'relay'), 1));
  assert.equal(outcome, 'confirmed');
  const sent = ctx.gw.sent((m) => m.type === 1);
  assert.deepEqual(
    sent.map((m) => [m.node, m.child, m.ack, m.sub, m.payload]),
    [[12, 1, 1, 2, '1']],
  );
  await ctx.clock.advance(2000);
  assert.equal(statesOf(ctx.gladys, F(12, 1, 'relay')).length, 0, 'an echo is not a state');
  ctx.gw.push('12;1;1;0;2;1');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(12, 1, 'relay')).length > 0, 'state');
  assert.deepEqual(statesOf(ctx.gladys, F(12, 1, 'relay')), [1]);
});

test('a scene on 5 relays: all 5 sent at once, each confirmed', async (t) => {
  const nodes = [50, 51, 52, 53, 54];
  const ctx = await setup(t, {
    config: { safe_actuators: nodes.map((n) => `${n}:1`).join(' ') },
    devices: nodes.map((n) => created(n, { 1: ['relay'] })),
  });
  await live(ctx);
  const all = Promise.all(nodes.map((n) => command(ctx, F(n, 1, 'relay'), 1)));
  assert.deepEqual(await answer(ctx, all), Array(5).fill('confirmed'));
});

test('without echo: "sent, without confirmation", never success', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 1)), 'unconfirmed');
  await ctx.clock.advance(2000);
  assert.equal(statesOf(ctx.gladys, F(12, 1, 'relay')).length, 0);
});

test('an echo of another command (payload, node, child) never confirms', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.onReceive = (m) => {
    if (m.type === 1) {
      ctx.gw.push({ ...m, payload: '0' });
      ctx.gw.push({ ...m, child: 2 });
      ctx.gw.push({ ...m, node: 14 });
      ctx.gw.push({ ...m, sub: 3 });
    }
  };
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 1)), 'unconfirmed');
});

test('relay not declared safe: on refused, nothing sent; off always sent', async (t) => {
  const ctx = await setup(t, { config: { safe_actuators: '' } });
  await live(ctx);
  await assert.rejects(
    answer(ctx, command(ctx, F(12, 1, 'relay'), 1)),
    /not in "Relays and dimmers declared safe"/,
  );
  assert.equal(ctx.gw.sent((m) => m.type === 1).length, 0);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'confirmed');
  assert.deepEqual(
    ctx.gw.sent((m) => m.type === 1).map((m) => m.payload),
    ['0'],
  );
});

test('a child now presented as another type refuses on, never off', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  ctx.gw.push('12;1;0;0;14;Heater');
  await settle(10);
  await until(
    ctx.clock,
    () => ctx.app.nodes.get(12)?.children.get(1)?.sType === 14,
    'presentation',
  );
  await assert.rejects(answer(ctx, command(ctx, F(12, 1, 'relay'), 1)), /another kind of sensor/);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'confirmed');
});

test('dimmer: brightness bounded and an integer; 0 is an off', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  assert.equal(await answer(ctx, command(ctx, F(13, 1, 'brightness'), 40)), 'confirmed');
  for (const bad of [101, -1, 40.5, '40%', NaN, null]) {
    await assert.rejects(answer(ctx, command(ctx, F(13, 1, 'brightness'), bad)), /not accepted/);
  }
  assert.equal(await answer(ctx, command(ctx, F(13, 1, 'brightness'), 0)), 'confirmed');
  const sent = ctx.gw.sent((m) => m.type === 1).map((m) => [m.sub, m.payload]);
  assert.deepEqual(sent, [
    [3, '40'],
    [2, '0'],
  ]);
  ctx.gw.push('13;1;1;0;3;40');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(13, 1, 'brightness')).length > 0, 'level');
  assert.deepEqual(statesOf(ctx.gladys, F(13, 1, 'brightness')), [40]);
});

test('on refused while the gateway is not connected: nothing sent', async (t) => {
  const ctx = await setup(t, { gateway: { silent: true } });
  await until(ctx.clock, () => ctx.app.link, 'link');
  await assert.rejects(answer(ctx, command(ctx, F(12, 1, 'relay'), 1)), /not connected/);
  assert.equal(ctx.gw.sent((m) => m.type === 1).length, 0);
  // An off is written on the open link even though the gateway never answered;
  // nothing proves it was read: kept, never counted as sent.
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'kept');
  assert.equal(ctx.app.stops.get('12:1').sends, 0);
  assert.ok(ctx.gw.sent((m) => m.type === 1 && m.payload === '0').length >= 1);
});

test('a feature of another integration or a read-only one is refused', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  for (const id of [
    'ext:other:node:12:1-relay',
    F(20, 0, 'temperature'),
    F(12, 1, 'state'),
    `${F(12)}:01-relay`,
    `${F(255)}:1-relay`,
  ]) {
    await assert.rejects(
      ctx.app.setValue({}, { external_id: id }, 0),
      /Unknown MySensors feature/,
      id,
    );
  }
  assert.equal(ctx.gw.sent((m) => m.type === 1).length, 0);
});
