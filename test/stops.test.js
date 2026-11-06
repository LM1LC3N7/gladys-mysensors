// -----------------------------------------------------------------------------
// Stops (a relay or a light turned off): never held, kept until the node
// echoes them, sent again within a budget; only an effective send counts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { F, answer, command, live, settle, setup, status, until } from './helpers/app.js';
import { fakeTcpGateway } from './helpers/fakeGateway.js';
import { memoryStore } from '../src/store.js';

/** getConfig() answers the SDK's own resynchronization, then fails (Gladys busy). */
function failConfigAfterFirst(gladys) {
  const original = gladys.getConfig.bind(gladys);
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    if (calls > 1) throw new Error('Gladys busy');
    return original();
  };
}

const offs = (gw, node = 12, child = 1) =>
  gw.sent((m) => m.type === 1 && m.node === node && m.child === child && m.payload === '0').length;

/** A free local port nobody listens on (the gateway is down). */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('an off while the gateway is down is kept, never abandoned, and leaves first when it is back', async (t) => {
  const port = await freePort();
  const down = { port, address: `127.0.0.1:${port}`, close: async () => {}, sent: () => [] };
  const ctx = await setup(t, { gw: down });
  await until(ctx.clock, () => ctx.app.reason !== undefined, 'first failure');
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'kept');
  assert.match(status(ctx.gladys), /Off kept, not read by the gateway yet .*12:1/);
  // An hour down: the tries are spaced (never a storm), the stop stays.
  await ctx.clock.advance(3_600_000);
  assert.ok(ctx.app.stops.has('12:1'));
  assert.ok(!ctx.app.stops.get('12:1').abandoned);
  const gw = await fakeTcpGateway({ port });
  t.after(() => gw.close());
  await until(ctx.clock, () => offs(gw) === 1, 'stop sent', { max: 120_000, step: 100 });
  // The stop left before anything else, the version asked after it.
  assert.equal(gw.received[0].type, 1);
  assert.equal(gw.received[0].payload, '0');
  await until(ctx.clock, () => !ctx.app.stops.has('12:1'), 'confirmed');
  assert.ok(gw.connections <= 2, `connections: ${gw.connections}`);
});

test('the attempts while the gateway is down are spaced: at most one a minute after a while', async (t) => {
  const port = await freePort();
  let attempts = 0;
  const down = { port, address: `127.0.0.1:${port}`, close: async () => {}, sent: () => [] };
  const ctx = await setup(t, {
    gw: down,
    app: {
      openTcp: async () => {
        attempts += 1;
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
    },
  });
  await ctx.clock.advance(600_000);
  // 1, 2, 5, 10, 30 s then every minute: ~14 tries in 10 min.
  assert.ok(attempts >= 10 && attempts <= 16, `attempts: ${attempts}`);
});

test('no echo: sent again after 1.5 s, 5 s, 20 s and 1 min, then reported abandoned', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'unconfirmed');
  assert.equal(offs(ctx.gw), 2);
  await until(ctx.clock, () => offs(ctx.gw) === 5, 'five sends', { step: 500, max: 200_000 });
  await until(ctx.clock, () => ctx.app.stops.get('12:1').abandoned, 'abandoned', {
    step: 500,
    max: 120_000,
  });
  assert.equal(offs(ctx.gw), 5);
  assert.equal(ctx.app.stops.get('12:1').sends, 5, 'five sends, each read by the gateway');
  await until(ctx.clock, () => /Off read 5 times/.test(status(ctx.gladys)), 'status');
  await ctx.clock.advance(600_000);
  assert.equal(offs(ctx.gw), 5);
  // A new click: the whole budget again.
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  assert.equal(offs(ctx.gw), 7);
});

test('a report of the node showing it off confirms the stop: no more sends', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.onReceive = (m) => {
    if (m.type === 1 && m.payload === '0') ctx.gw.push('12;1;1;0;2;0');
  };
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'confirmed');
  await ctx.clock.advance(120_000);
  assert.equal(offs(ctx.gw), 1);
});

test('a report of off that came BEFORE the stop left never confirms it', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.push('12;1;1;0;2;0');
  await settle(10);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'unconfirmed');
  assert.ok(ctx.app.stops.has('12:1'));
});

test('an on that left after the off cancels its resends; an on refused does not', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  // Not declared: refused, never sent, the stop goes on.
  await ctx.gladys.fake.configUpdated({ ...ctx.config, safe_actuators: '' });
  await assert.rejects(answer(ctx, command(ctx, F(12, 1, 'relay'), 1)), /declared safe/);
  await ctx.clock.advance(6000);
  assert.equal(offs(ctx.gw), 3);
  await ctx.gladys.fake.configUpdated({ ...ctx.config });
  await live(ctx);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 1)), 'unconfirmed');
  assert.ok(!ctx.app.stops.has('12:1'));
  await ctx.clock.advance(120_000);
  assert.equal(offs(ctx.gw), 3);
});

test('stops kept in /data leave at start, before the configuration is read', async (t) => {
  const gw = await fakeTcpGateway({ echo: false });
  const store = memoryStore({
    format: 1,
    route: { transport: 'tcp', host: '127.0.0.1', port: gw.port },
    stops: [
      { node: 12, child: 1, sends: 0 },
      { node: 40, child: 3, sends: 4 },
      { node: 41, child: 2, sends: 5 },
    ],
  });
  const ctx = await setup(t, { gw, store, connect: false });
  failConfigAfterFirst(ctx.gladys);
  await ctx.gladys.connect();
  await until(ctx.clock, () => offs(gw) === 1 && offs(gw, 40, 3) === 1, 'stops sent');
  assert.equal(offs(gw, 41, 2), 0, 'an abandoned stop is not sent again by a restart');
  assert.equal(ctx.app.config, undefined);
  assert.match(status(ctx.gladys), /configuration could not be read/);
});

test('a stop never waits for /data: a save that hangs holds neither it nor the next clicks', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, gateway: { echo: false } });
  await live(ctx);
  store.hangSaves = true;
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0), { max: 4000 }), 'unconfirmed');
  assert.equal(await answer(ctx, command(ctx, F(13, 1, 'light'), 0), { max: 4000 }), 'unconfirmed');
  assert.ok(offs(ctx.gw) >= 2);
  assert.equal(offs(ctx.gw, 13, 1), 2);
  await until(ctx.clock, () => offs(ctx.gw) >= 4, 'resends with /data stuck', {
    step: 500,
    max: 60_000,
  });
});

test('a stop is sent with the configuration not read yet, through the route of /data', async (t) => {
  const gw = await fakeTcpGateway();
  const store = memoryStore({
    format: 1,
    route: { transport: 'tcp', host: '127.0.0.1', port: gw.port },
  });
  const ctx = await setup(t, { gw, store, connect: false });
  failConfigAfterFirst(ctx.gladys);
  await ctx.gladys.connect();
  assert.equal(
    await answer(ctx, ctx.app.setValue({}, { external_id: F(12, 1, 'relay') }, 0)),
    'confirmed',
  );
  assert.equal(offs(gw), 1);
});

test('kept stops are all written at once when the link opens', async (t) => {
  const port = await freePort();
  const down = { port, address: `127.0.0.1:${port}`, close: async () => {}, sent: () => [] };
  const ctx = await setup(t, { gw: down });
  await until(ctx.clock, () => ctx.app.reason !== undefined, 'down');
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  await answer(ctx, command(ctx, F(13, 1, 'light'), 0));
  const gw = await fakeTcpGateway({ port });
  t.after(() => gw.close());
  await until(ctx.clock, () => gw.received.length >= 3, 'link', { step: 100, max: 120_000 });
  assert.deepEqual(
    gw.received
      .slice(0, 2)
      .map((m) => `${m.node}:${m.child}=${m.payload}`)
      .sort(),
    ['12:1=0', '13:1=0'],
  );
});

test('a report of off while the stop could not be written yet never confirms it', async (t) => {
  // A link that is open but refuses to write (an MQTT client between two states).
  let handlers;
  const link = {
    kind: 'tcp',
    closed: false,
    dropped: 0,
    writable: false,
    sent: [],
    send(msg) {
      if (!this.writable) return false;
      this.sent.push(msg);
      return true;
    },
    close() {
      this.closed = true;
    },
    closedSocket: async () => {},
  };
  const ctx = await setup(t, {
    app: {
      openTcp: async (_route, h) => {
        handlers = h;
        return link;
      },
    },
  });
  await until(ctx.clock, () => ctx.app.link === link, 'link');
  handlers.onMessage({ node: 0, child: 255, type: 3, ack: 0, sub: 2, payload: '2.3.2' }, {});
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'kept');
  handlers.onMessage({ node: 12, child: 1, type: 1, ack: 0, sub: 2, payload: '0' }, {});
  await settle(5);
  assert.ok(ctx.app.stops.has('12:1'), 'not confirmed by a report while it never left');
  link.writable = true;
  // Tried again on the open link without a new click.
  await ctx.clock.advance(1600);
  assert.equal(link.sent.filter((m) => m.type === 1).length, 1);
  handlers.onMessage({ node: 12, child: 1, type: 1, ack: 0, sub: 2, payload: '0' }, {});
  assert.ok(!ctx.app.stops.has('12:1'));
});
