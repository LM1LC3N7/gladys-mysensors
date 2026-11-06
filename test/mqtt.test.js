// -----------------------------------------------------------------------------
// The MQTT gateway through the real mqtt.js (src/mqtt.js) and a local fake
// broker: topics, retained messages, commands never retained, refused
// credentials (spaced, persisted, lifted by new ones), a CONNECT left
// unanswered, MQTT 3.1.1, a packet too large (cut before it is read), and
// the password never in a log, /data or a status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, answer, command, live, settle, setup, status, statesOf, until } from './helpers/app.js';
import { credentialsMark, memoryStore } from '../src/store.js';
import { PacketGuard, openMqtt as realOpenMqtt } from '../src/mqtt.js';

const SECRET = 'S3cret-Passw0rd';

function memoryLogger() {
  const lines = [];
  const log = (...args) =>
    lines.push(
      args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '),
    );
  return { lines, info: log, warn: log, error: log, debug: log };
}

test('MQTT: subscribed under the gateway prefix; values; retained messages ignored', async (t) => {
  const ctx = await setup(t, {
    mqtt: true,
    gateway: { retained: [{ topic: 'mygateway1-out/20/0/1/0/0', payload: '99.9' }] },
  });
  await live(ctx);
  assert.equal(ctx.gw.received[0].sub, 2, 'the version is asked first');
  assert.equal(ctx.gw.published[0].topic, 'mygateway1-in/0/255/3/0/2');
  ctx.gw.push('20;0;1;0;0;21.0', { retain: true });
  ctx.gw.push('20;1;1;0;1;40');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(20, 1, 'humidity')).length === 1, 'value');
  await ctx.clock.advance(2000);
  assert.equal(statesOf(ctx.gladys, F(20, 0, 'temperature')).length, 0);
  assert.equal(ctx.gw.peak, 1);
});

test('MQTT: a command leaves never retained, is echoed and confirmed', async (t) => {
  const ctx = await setup(t, { mqtt: true, config: { safe_actuators: '12:1' } });
  await live(ctx);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 1)), 'confirmed');
  const sent = ctx.gw.published.filter((p) => p.topic === 'mygateway1-in/12/1/1/1/2');
  assert.deepEqual(sent, [{ topic: 'mygateway1-in/12/1/1/1/2', payload: '1', retain: false }]);
});

test('MQTT: custom prefixes; a topic outside them or a long payload is ignored', async (t) => {
  const ctx = await setup(t, {
    mqtt: true,
    gateway: { inPrefix: 'home/ms-out', outPrefix: 'home/ms-in' },
    config: { mqtt_publish_prefix: 'home/ms-out', mqtt_subscribe_prefix: 'home/ms-in' },
  });
  await live(ctx);
  ctx.gw.push({ node: 20, child: 1, type: 1, ack: 0, sub: 1, payload: '5'.repeat(300) });
  ctx.gw.push('20;1;1;0;1;41');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(20, 1, 'humidity')).length === 1, 'value');
  assert.deepEqual(statesOf(ctx.gladys, F(20, 1, 'humidity')), [41]);
  assert.equal(ctx.app.link.dropped, 1, 'the long payload dropped unread');
  assert.ok(ctx.gw.published.every((p) => p.topic.startsWith('home/ms-in/')));
});

test('MQTT: credentials refused: no try before 15 min, persisted; an off is kept and leaves first with new credentials', async (t) => {
  const logger = memoryLogger();
  const store = memoryStore();
  const ctx = await setup(t, {
    mqtt: true,
    store,
    logger,
    config: { mqtt_username: 'gladys', mqtt_password: SECRET },
    gateway: {
      connack: (packet) =>
        String(packet.password) === 'good'
          ? { reasonCode: 0 }
          : { reasonCode: packet.protocolVersion === 5 ? 135 : 5 },
    },
  });
  await until(ctx.clock, () => /refused the connection/.test(status(ctx.gladys)), 'refused');
  assert.match(status(ctx.gladys), /next try in 15 min/);
  const connects = ctx.gw.connects.length;
  await ctx.clock.advance(14 * 60_000);
  assert.equal(ctx.gw.connects.length, connects);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'kept');
  assert.equal(ctx.gw.connects.length, connects, 'a stop never hammers a broker that refuses');
  await until(ctx.clock, () => store.data?.auth?.failures === 1, 'persisted');
  assert.ok(Number.isInteger(store.data.auth.mark) && store.data.auth.mark < 64);
  await ctx.gladys.fake.configUpdated({ ...ctx.config, mqtt_password: 'good' });
  await until(ctx.clock, () => ctx.gw.sent((m) => m.type === 1).length > 0, 'stop sent');
  assert.equal(ctx.gw.received[0].payload, '0', 'the kept stop leaves first');
  await until(ctx.clock, () => store.data?.auth?.failures === 0, 'lifted');
  for (const text of [
    JSON.stringify(store.data),
    ...logger.lines,
    ...ctx.gladys.fake.connectionStatuses.map((s) => JSON.stringify(s)),
  ]) {
    assert.ok(!text.includes(SECRET), text);
  }
});

test('MQTT: after a restart one try at once; the same refused pair then waits longer, another pair starts over', async (t) => {
  // A fixed salt for which the two pairs have different marks (deterministic).
  const SALT = '0'.repeat(32);
  assert.notEqual(
    credentialsMark(SALT, 'gladys', SECRET),
    credentialsMark(SALT, 'gladys', 'another one'),
  );
  const start = Date.UTC(2026, 0, 1);
  const data = {
    format: 1,
    auth: {
      failures: 1,
      until: start + 10 * 60_000,
      mark: credentialsMark(SALT, 'gladys', SECRET),
      salt: SALT,
    },
  };
  for (const [password, wait] of [
    [SECRET, /next try in 60 min/],
    ['another one', /next try in 15 min/],
  ]) {
    const ctx = await setup(t, {
      mqtt: true,
      data,
      config: { mqtt_username: 'gladys', mqtt_password: password },
      gateway: { connack: () => ({ reasonCode: 135 }) },
    });
    await until(ctx.clock, () => ctx.gw.connects.length === 1, 'one try at once');
    await until(ctx.clock, () => /refused the connection/.test(status(ctx.gladys)), 'refused');
    assert.match(status(ctx.gladys), wait);
    await ctx.clock.advance(10 * 60_000);
    assert.equal(ctx.gw.connects.length, 1, 'then the spaced wait');
  }
});

for (const behaviour of ['silent', 'close']) {
  test(`MQTT: a CONNECT with credentials, ${behaviour} twice, counts as a refusal`, async (t) => {
    const ctx = await setup(t, {
      mqtt: true,
      config: { mqtt_username: 'gladys', mqtt_password: SECRET },
      gateway: { connack: () => behaviour },
    });
    await until(ctx.clock, () => /refused the connection/.test(status(ctx.gladys)), 'refusal', {
      step: 100,
      max: 120_000,
    });
    assert.equal(ctx.gw.connects.length, 2);
    await ctx.clock.advance(600_000);
    assert.equal(ctx.gw.connects.length, 2);
  });
}

test('MQTT: a broker without MQTT 5 is used in 3.1.1', async (t) => {
  const ctx = await setup(t, {
    mqtt: true,
    gateway: {
      connack: (packet) => (packet.protocolVersion === 5 ? { reasonCode: 132 } : { reasonCode: 0 }),
    },
  });
  await live(ctx);
  assert.deepEqual(
    ctx.gw.connects.map((c) => c.protocolVersion),
    [5, 4],
  );
  await until(ctx.clock, () => /MQTT 3\.1\.1 broker/.test(status(ctx.gladys)), 'status');
});

test('MQTT: a packet announcing more than 4 KB cuts the connection before it is read', async (t) => {
  const ctx = await setup(t, { mqtt: true });
  await live(ctx);
  // PUBLISH, remaining length 100 MB (variable length: 0x80 0x80 0x80 0x32), a few bytes of it.
  ctx.gw.raw(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x32, 0x00, 0x05, 0x61]));
  await until(ctx.clock, () => !ctx.app.link, 'cut');
  assert.match(ctx.app.reason, /over 4096 bytes|PACKET_TOO_LARGE|closed/);
  await until(ctx.clock, () => ctx.app.live, 'reconnected', { step: 100, max: 10_000 });
});

test('PacketGuard: cuts across chunks; lets a small packet through', async () => {
  const guard = new PacketGuard(100);
  const out = [];
  guard.on('data', (c) => out.push(c));
  const errors = [];
  guard.on('error', (e) => errors.push(e.code));
  guard.write(Buffer.from([0x30, 0x03, 0x00, 0x01, 0x61]));
  guard.write(Buffer.from([0x30]));
  guard.write(Buffer.from([0xe5]));
  guard.write(Buffer.from([0x00]));
  await settle(5);
  // The small packet whole; of the large one, at most its header bytes.
  assert.deepEqual([...Buffer.concat(out).subarray(0, 5)], [0x30, 0x03, 0x00, 0x01, 0x61]);
  assert.ok(Buffer.concat(out).length <= 7);
  assert.deepEqual(errors, ['PACKET_TOO_LARGE']);
});

test('MQTT: the test button that succeeds lifts the refusal; the kept off leaves first', async (t) => {
  let accept = false;
  const ctx = await setup(t, {
    mqtt: true,
    config: { mqtt_username: 'gladys', mqtt_password: SECRET },
    gateway: { connack: () => (accept ? { reasonCode: 0 } : { reasonCode: 135 }) },
  });
  await until(ctx.clock, () => /refused the connection/.test(status(ctx.gladys)), 'refused');
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'kept');
  accept = true;
  const result = await answer(ctx, ctx.app.testConnection(), { step: 20 });
  assert.match(result.en, /Gateway answered/);
  assert.equal(ctx.gw.received[0].payload, '0');
});

test('MQTT: a reconnection to Gladys during a refusal does not try again', async (t) => {
  const ctx = await setup(t, {
    mqtt: true,
    config: { mqtt_username: 'gladys', mqtt_password: SECRET },
    gateway: { connack: () => ({ reasonCode: 135 }) },
  });
  await until(ctx.clock, () => /refused the connection/.test(status(ctx.gladys)), 'refused');
  const before = ctx.gw.connects.length;
  await ctx.app.connected();
  await ctx.clock.advance(60_000);
  assert.equal(ctx.gw.connects.length, before);
});

/** r3 M3: /data whose first read answers only on `release()`, past its 2 s bound. */
function lateStore(data) {
  const store = memoryStore(data);
  const load = store.load.bind(store);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  store.load = () => {
    reads += 1;
    return reads === 1 ? gate.then(load) : load();
  };
  return { store, release };
}

const refusedBefore = (password) => {
  const SALT = '0'.repeat(32);
  return {
    format: 1,
    auth: {
      failures: 1,
      until: Date.UTC(2026, 0, 1) + 15 * 60_000,
      mark: credentialsMark(SALT, 'gladys', password),
      salt: SALT,
    },
  };
};

test('r3 M3: /data read late after a restart never puts its refusal back over a connection accepted meanwhile', async (t) => {
  // The same pair (the broker fixed meanwhile) and a new password.
  for (const password of [SECRET, 'new-pw']) {
    const { store, release } = lateStore(refusedBefore(SECRET));
    const ctx = await setup(t, {
      mqtt: true,
      store,
      connect: false,
      config: { mqtt_username: 'gladys', mqtt_password: password },
    });
    const connecting = ctx.gladys.connect();
    await until(ctx.clock, () => ctx.app.memoryState === 'unreadable', '/data late');
    await connecting;
    await live(ctx);
    assert.equal(ctx.gw.connects.length, 1);
    release();
    await until(ctx.clock, () => ctx.app.memoryState === 'ok', '/data read', { step: 100 });
    await ctx.app.updateStatus();
    assert.match(status(ctx.gladys), /MySensors gateway 2\.3\.2 connected/);
    assert.equal(ctx.app.authStopped, false);
    assert.equal(ctx.app.memory.auth.failures, 0, 'the accepted connection wins');
    await until(ctx.clock, () => store.data?.auth?.failures === 0, 'the file says so too');
    // The link drops: tried again within the waits of the link, never after 15 min.
    ctx.gw.drop();
    await until(ctx.clock, () => ctx.gw.connects.length === 2, 'tried again', {
      step: 100,
      max: 10_000,
    });
  }
});

test('r3 M3: /data read late: the rule of a restart when it comes, unless this process settled the refusal first', async (t) => {
  for (const [password, before, wait, failures] of [
    // Nothing settled before /data: another pair starts over, the same pair goes on.
    ['new-pw', undefined, /next try in 15 min/, 1],
    [SECRET, undefined, /next try in 60 min/, 2],
    // The configuration saved by the user before /data: the count starts over.
    [SECRET, 'saved', /next try in 15 min/, 1],
    // Refused before /data: that refusal stays (no try before its wait).
    ['new-pw', 'refused', /next try in 15 min/, 1],
  ]) {
    const { store, release } = lateStore(refusedBefore(SECRET));
    // The first attempt opens only when the test says so.
    let open;
    const opening = new Promise((resolve) => {
      open = resolve;
    });
    const openMqtt = async (cfg, handlers) => {
      await opening;
      return realOpenMqtt(cfg, handlers);
    };
    const ctx = await setup(t, {
      mqtt: true,
      store,
      connect: false,
      app: { openMqtt },
      config: { mqtt_username: 'gladys', mqtt_password: password },
      gateway: { connack: () => ({ reasonCode: 135 }) },
    });
    const connecting = ctx.gladys.connect();
    await until(ctx.clock, () => ctx.app.memoryState === 'unreadable', '/data late');
    await connecting;
    const refused = () => /refused the connection/.test(status(ctx.gladys));
    if (before === 'saved') await ctx.gladys.fake.configUpdated({ ...ctx.config });
    if (before === 'refused') {
      open();
      await until(ctx.clock, refused, 'refused before /data');
    }
    release();
    await until(ctx.clock, () => ctx.app.memoryState === 'ok', '/data read', { step: 100 });
    open();
    await until(ctx.clock, refused, 'refused');
    assert.match(status(ctx.gladys), wait);
    assert.equal(ctx.app.memory.auth.failures, failures);
    await ctx.clock.advance(10 * 60_000);
    assert.equal(ctx.gw.connects.length, 1, 'one try, then the wait');
  }
});

test('r3 M3: a configuration read again on a reconnection to Gladys with another password is tried at once, even during a refusal', async (t) => {
  const ctx = await setup(t, {
    mqtt: true,
    config: { mqtt_username: 'gladys', mqtt_password: SECRET },
    gateway: {
      connack: (packet) =>
        String(packet.password) === 'good' ? { reasonCode: 0 } : { reasonCode: 135 },
    },
  });
  await until(ctx.clock, () => /refused the connection/.test(status(ctx.gladys)), 'refused');
  const before = ctx.gw.connects.length;
  // The same pair read again: no try (the wait of the refusal goes on).
  await ctx.app.connected();
  await ctx.clock.advance(60_000);
  assert.equal(ctx.gw.connects.length, before);
  // Saved while the integration was away from Gladys (no event): read on the reconnection.
  ctx.gladys.fake.config.mqtt_password = 'good';
  await ctx.app.connected();
  await until(ctx.clock, () => ctx.gw.connects.length === before + 1, 'tried at once', {
    max: 5000,
  });
  await live(ctx);
  assert.equal(ctx.app.memory.auth.failures, 0);
});
