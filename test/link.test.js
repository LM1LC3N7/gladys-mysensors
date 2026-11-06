// -----------------------------------------------------------------------------
// The link to the gateway and the life of the app: bounds on what comes in,
// one connection at a time, a silent gateway, the answers to the nodes, the
// ids handed out, getConfig() and /data failures, freshness.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, answer, command, live, settle, setup, status, statesOf, until } from './helpers/app.js';
import { fakeTcpGateway } from './helpers/fakeGateway.js';
import { memoryStore } from '../src/store.js';
import { TcpLink, tcpConnect } from '../src/tcp.js';

test('a line over 256 bytes is dropped as it comes; the next ones are read', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  ctx.gw.write(`20;0;1;0;0;${'9'.repeat(100_000)}`);
  ctx.gw.write('\n20;0;1;0;0;22.5\n');
  ctx.gw.push('garbage;;;');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(20, 0, 'temperature')).length === 1, 'value');
  assert.deepEqual(statesOf(ctx.gladys, F(20, 0, 'temperature')), [22.5]);
  assert.ok(ctx.app.link.reader.size === 0);
  await ctx.clock.advance(60_000);
  assert.match(status(ctx.gladys), /2 message\(s\) ignored/);
});

test('more than 200 messages a second: the rest is dropped, the link stays', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  ctx.gw.write('20;1;1;0;1;50\n'.repeat(1000));
  await until(ctx.clock, () => ctx.app.dropped >= 700, 'drops');
  assert.ok(ctx.app.dropped <= 801, `${ctx.app.dropped}`);
  assert.ok(!ctx.app.link.closed);
});

test('a TCP gateway silent for 150 s is closed and reconnected (one connection at a time)', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  ctx.gw.silent = true;
  await until(ctx.clock, () => ctx.gw.connections === 2, 'reconnection', {
    step: 1000,
    max: 400_000,
  });
  assert.equal(ctx.gw.peak, 1);
  ctx.gw.silent = false;
  // The version is asked again within a minute.
  await until(ctx.clock, () => ctx.app.live, 'live again', { step: 1000, max: 90_000 });
});

test('a new address: the old connection is closed before the new one opens', async (t) => {
  // The sockets of the app, counted on its side.
  const sockets = { open: 0, atOpen: [] };
  const openTcp = async (route, handlers) => {
    const socket = await tcpConnect(route, handlers);
    sockets.atOpen.push(sockets.open);
    sockets.open += 1;
    socket.once('close', () => {
      sockets.open -= 1;
    });
    return new TcpLink(socket, handlers);
  };
  const ctx = await setup(t, { app: { openTcp } });
  await live(ctx);
  const other = await fakeTcpGateway();
  t.after(() => other.close());
  await ctx.gladys.fake.configUpdated({ ...ctx.config, gateway_address: other.address });
  await until(ctx.clock, () => other.connections === 1 && ctx.gw.open === 0, 'switch');
  await live(ctx);
  assert.deepEqual(sockets.atOpen, [0, 0], 'the old connection was closed first');
  assert.equal(sockets.open, 1);
});

test('a new configuration waits until the old link is really closed', async (t) => {
  // Fake links whose socket takes 30 ms (real) to be gone after close().
  const sockets = { open: 0, atOpen: [] };
  const openTcp = async () => {
    sockets.atOpen.push(sockets.open);
    sockets.open += 1;
    let gone;
    const done = new Promise((resolve) => {
      gone = resolve;
    });
    return {
      kind: 'tcp',
      closed: false,
      dropped: 0,
      send: () => true,
      close() {
        if (this.closed) return;
        this.closed = true;
        setTimeout(() => {
          sockets.open -= 1;
          gone();
        }, 30);
      },
      closedSocket: () => done,
    };
  };
  const ctx = await setup(t, { app: { openTcp } });
  await until(ctx.clock, () => ctx.app.link, 'first link');
  await ctx.gladys.fake.configUpdated({ ...ctx.config, gateway_address: '127.0.0.1:5999' });
  await until(ctx.clock, () => sockets.atOpen.length === 2, 'second link', { step: 1 });
  assert.deepEqual(sockets.atOpen, [0, 0]);
});

test('saving the same configuration again keeps the connection', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  await ctx.gladys.fake.configUpdated({ ...ctx.config, language: 'fr' });
  await ctx.clock.advance(5000);
  assert.equal(ctx.gw.connections, 1);
});

test('the nodes get their configuration (metric) and the time; the gateway ready asks every node', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  ctx.gw.push('20;255;3;0;6;0');
  ctx.gw.push('20;255;3;0;6;0');
  ctx.gw.push('20;255;3;0;1;');
  ctx.gw.push('0;255;3;0;14;Gateway startup complete.');
  await until(ctx.clock, () => ctx.gw.received.some((m) => m.sub === 20), 'discover');
  await until(ctx.clock, () => ctx.gw.received.some((m) => m.sub === 1), 'time');
  const internal = ctx.gw.sent((m) => m.type === 3 && m.sub !== 2);
  const texts = internal.map((m) => `${m.node};${m.child};${m.sub};${m.payload}`);
  assert.ok(texts.includes('20;255;6;M'));
  assert.ok(texts.includes('255;255;20;'));
  const time = internal.find((m) => m.sub === 1);
  assert.equal(time.node, 20);
  assert.match(time.payload, /^\d{10}$/);
  assert.equal(ctx.gw.sent((m) => m.sub === 6).length, 1, 'one answer per node every 2 s');
});

test('a node without id gets the lowest free one, kept in /data before it is given', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  await live(ctx);
  ctx.gw.push('1;255;3;0;0;50');
  ctx.gw.push('255;255;3;0;3;');
  await until(ctx.clock, () => ctx.gw.received.some((m) => m.sub === 4), 'id');
  const [given] = ctx.gw.sent((m) => m.sub === 4);
  // 1 is heard, 12, 13 and 20 are created in Gladys.
  assert.deepEqual([given.node, given.child, given.payload], [255, 255, '2']);
  assert.deepEqual(
    store.data.ids.map((e) => e.id),
    [2],
  );
  // Asked again at once (the first node did not take it yet): another id.
  ctx.gw.push('255;255;3;0;3;');
  await until(ctx.clock, () => ctx.gw.sent((m) => m.sub === 4).length === 2, 'second id');
  assert.equal(ctx.gw.sent((m) => m.sub === 4)[1].payload, '3');
  // Node 2 speaks: its id is used; 3 never shows up and is given again after 5 min.
  ctx.gw.push('2;255;0;0;17;2.3.2');
  await ctx.clock.advance(301_000);
  ctx.gw.push('255;255;3;0;3;');
  await until(ctx.clock, () => ctx.gw.sent((m) => m.sub === 4).length === 3, 'third id');
  assert.equal(ctx.gw.sent((m) => m.sub === 4)[2].payload, '3');
  assert.equal(store.data.ids.find((e) => e.id === 2).seen, true);
});

test('no id given when /data cannot be written, nor when the option is off', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  await live(ctx);
  store.fail = true;
  ctx.gw.push('255;255;3;0;3;');
  await until(
    ctx.clock,
    () => /none given, \/data cannot be written/.test(status(ctx.gladys)),
    'status',
  );
  assert.equal(ctx.gw.sent((m) => m.sub === 4).length, 0);
  store.fail = false;
  await ctx.gladys.fake.configUpdated({ ...ctx.config, assign_node_ids: false });
  ctx.gw.push('255;255;3;0;3;');
  await until(ctx.clock, () => /Hand out node ids/.test(status(ctx.gladys)), 'off');
  assert.equal(ctx.gw.sent((m) => m.sub === 4).length, 0);
});

test('at most 10 ids handed out and unused', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  for (let i = 0; i < 12; i += 1) {
    ctx.gw.push('255;255;3;0;3;');
    await until(ctx.clock, () => !ctx.app.assigning, 'assigning', { step: 5 });
    await ctx.clock.advance(50);
  }
  await settle(10);
  assert.equal(ctx.gw.sent((m) => m.sub === 4).length, 10);
  assert.match(status(ctx.gladys), /10 ids handed out are still unused/);
});

test('getConfig() failing in "connected" is tried again until it answers', async (t) => {
  const ctx = await setup(t, { connect: false });
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  let calls = 0;
  ctx.gladys.getConfig = async () => {
    calls += 1;
    if (calls >= 2 && calls <= 4) throw new Error('busy');
    return original();
  };
  await ctx.gladys.connect();
  assert.match(status(ctx.gladys), /next try in 5 s/);
  await ctx.clock.advance(5000);
  await settle(5);
  assert.match(status(ctx.gladys), /next try in 15 s/);
  await ctx.clock.advance(15_000);
  await settle(5);
  assert.match(status(ctx.gladys), /next try in 60 s/);
  await ctx.clock.advance(60_000);
  await live(ctx);
  assert.equal(calls, 5);
});

test('/data unreadable: read again every 10 s; a click meanwhile is kept, never overwritten', async (t) => {
  const store = memoryStore({
    format: 1,
    stops: [
      { node: 40, child: 1, sends: 0 },
      { node: 12, child: 1, sends: 4 },
    ],
    ids: [{ id: 5, at: 1, seen: true }],
  });
  store.unreadable = true;
  const ctx = await setup(t, { store, gateway: { echo: false } });
  await live(ctx);
  assert.match(status(ctx.gladys), /\/data cannot be read/);
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  const clicked = ctx.app.stops.get('12:1');
  assert.equal(store.saves, 0, 'never written over an unreadable file');
  const loads = store.loads;
  store.unreadable = false;
  await ctx.clock.advance(10_000);
  await until(ctx.clock, () => ctx.app.memoryState === 'ok', 'read again');
  assert.equal(store.loads, loads + 1);
  assert.equal(ctx.app.stops.get('12:1'), clicked, 'the click is kept, never overwritten by /data');
  await until(
    ctx.clock,
    () => ctx.gw.sent((m) => m.node === 40 && m.payload === '0').length >= 1,
    'kept stop sent',
  );
  await until(
    ctx.clock,
    () => store.saves > 0 && store.data.stops.some((s) => s.node === 12),
    'saved',
  );
  assert.equal(store.data.ids[0].id, 5);
});

test('/data that never answers is unreadable, never a wait', async (t) => {
  const store = memoryStore();
  store.hang = true;
  const ctx = await setup(t, { store, connect: false });
  const connecting = ctx.gladys.connect();
  await until(ctx.clock, () => ctx.app.memoryState === 'unreadable', 'unreadable');
  await connecting;
  await live(ctx);
  // Read again every 10 s, but never a second read while the first one hangs.
  await ctx.clock.advance(35_000);
  assert.equal(store.loads, 1);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'confirmed');
});

test('a reconnection to Gladys never republishes old values; a device created gets only fresh ones', async (t) => {
  const ctx = await setup(t, { devices: [] });
  await live(ctx);
  ctx.gw.push('20;0;0;0;6;');
  ctx.gw.push('20;0;1;0;0;18.5');
  await ctx.clock.advance(3000);
  ctx.gladys.devices.push((await import('./helpers/app.js')).created(20, { 0: ['temperature'] }));
  await ctx.gladys.fake.deviceCreated(ctx.gladys.devices[0]);
  await until(
    ctx.clock,
    () => statesOf(ctx.gladys, F(20, 0, 'temperature')).length === 1,
    'fresh value',
  );
  // Three minutes later: a second device creation publishes nothing old.
  await ctx.clock.advance(180_000);
  await ctx.gladys.fake.deviceUpdated(ctx.gladys.devices[0]);
  assert.ok(!ctx.app.publisher.pending.has(F(20, 0, 'temperature')), 'nothing old queued');
  await ctx.clock.advance(3000);
  assert.equal(statesOf(ctx.gladys, F(20, 0, 'temperature')).length, 1);
  // A value queued when Gladys went away is dropped by the reconnection.
  ctx.gw.push('20;0;1;0;0;18.7');
  await until(ctx.clock, () => ctx.app.publisher.pending.size > 0, 'queued', { step: 1 });
  await ctx.gladys.fake.send('disconnected');
  await ctx.app.connected();
  assert.equal(ctx.app.publisher.pending.size, 0);
  await ctx.clock.advance(3000);
  assert.equal(statesOf(ctx.gladys, F(20, 0, 'temperature')).length, 1);
  // After the reconnection the same value as before is published again (caches emptied).
  ctx.gw.push('20;0;1;0;0;18.5');
  await until(ctx.clock, () => statesOf(ctx.gladys, F(20, 0, 'temperature')).length === 2, 'again');
});

test('a scan asks the silent known nodes to present themselves, once a minute at most', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  await ctx.app.scan();
  await ctx.clock.advance(2000);
  const asked = ctx.gw.sent((m) => m.type === 3 && m.sub === 19).map((m) => m.node);
  assert.deepEqual(asked, [12, 13, 20]);
  await ctx.app.scan();
  await ctx.clock.advance(2000);
  assert.equal(ctx.gw.sent((m) => m.type === 3 && m.sub === 19).length, 3);
});

test('a gateway that closes every connection at once: tries spaced, then live when it stops', async (t) => {
  const ctx = await setup(t, { gateway: { closeOnConnect: true } });
  await ctx.clock.advance(60_000);
  await settle(10);
  // 1, 2, 5, 10, 30 s: about 6 connections in a minute, never a storm.
  assert.ok(ctx.gw.connections >= 3 && ctx.gw.connections <= 8, `${ctx.gw.connections}`);
  ctx.gw.closeOnConnect = false;
  await until(ctx.clock, () => ctx.app.live, 'live', { step: 500, max: 120_000 });
});

test('a configuration read that answers after a newer one was saved is dropped', async (t) => {
  const ctx = await setup(t, { connect: false });
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  let calls = 0;
  let release;
  ctx.gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2) {
      const old = await original();
      await new Promise((resolve) => {
        release = resolve;
      });
      return { ...old, gateway_address: '192.0.2.1' };
    }
    return original();
  };
  const connecting = ctx.gladys.connect();
  await until(ctx.clock, () => release !== undefined, 'read in flight');
  await ctx.gladys.fake.configUpdated({ ...ctx.config });
  release();
  await connecting;
  await live(ctx);
  assert.equal(ctx.app.config.host, '127.0.0.1');
});

test('test button: the version of the gateway, or why not', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  ctx.gw.push('20;0;1;0;0;20.0');
  const ok = await answer(ctx, ctx.app.testConnection());
  assert.match(ok.en, /Gateway answered: MySensors 2\.3\.2; 1 node\(s\) heard/);
  ctx.gw.silent = true;
  const silent = await answer(ctx, ctx.app.testConnection(), { step: 100 });
  assert.match(silent.en, /did not answer within 10 s/);
});
