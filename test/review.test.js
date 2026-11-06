// -----------------------------------------------------------------------------
// The points of review r1: each correction has its test (a mutant of it
// fails here, never hangs).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { F, answer, command, live, settle, setup, statesOf, status, until } from './helpers/app.js';
import { fakeTcpGateway } from './helpers/fakeGateway.js';
import { testClock } from './helpers/clock.js';
import { memoryStore } from '../src/store.js';
import { openTcp as realOpenTcp, tcpConnect } from '../src/tcp.js';

const offs = (gw, node = 12, child = 1) =>
  gw.sent((m) => m.type === 1 && m.node === node && m.child === child && m.payload === '0').length;

/** A promise settled from outside. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** A fake link (see test/stops.test.js) that counts what it sends. */
function fakeLink() {
  return {
    kind: 'tcp',
    closed: false,
    dropped: 0,
    sent: [],
    send(msg) {
      if (this.closed) return false;
      this.sent.push(msg);
      return true;
    },
    close() {
      this.closed = true;
    },
    closedSocket: async () => {},
  };
}

test('B1: an off written on connections the gateway closes at once never counts, never abandoned', async (t) => {
  // An ESP8266 gateway whose single client slot is taken: accept, then close.
  const ctx = await setup(t, { gateway: { closeOnConnect: true } });
  await ctx.clock.advance(3000);
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'kept');
  await ctx.clock.advance(120_000);
  await settle(10);
  const stop = ctx.app.stops.get('12:1');
  // Spaced by the waits of the link (1 s up to 1 min), never a storm.
  assert.ok(
    ctx.gw.connections >= 3 && ctx.gw.connections <= 10,
    `${ctx.gw.connections} connections`,
  );
  assert.equal(stop.sends, 0, 'nothing proven read');
  assert.equal(stop.abandoned, false);
  assert.match(status(ctx.gladys), /Off kept, not read by the gateway yet/);
  // The slot is free: the off leaves and is confirmed.
  ctx.gw.closeOnConnect = false;
  await until(ctx.clock, () => !ctx.app.stops.has('12:1'), 'confirmed', {
    step: 500,
    max: 120_000,
  });
  assert.ok(offs(ctx.gw) >= 1);
});

test('B1: a send counts only once the gateway answered the version asked after it', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.silent = true;
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'kept');
  assert.equal(ctx.app.stops.get('12:1').sends, 0);
  // A version answer that was asked BEFORE the off proves nothing.
  ctx.gw.push('0;255;3;0;2;2.3.2');
  await settle(10);
  await until(ctx.clock, () => ctx.app.answered >= 1, 'early answer', { step: 1 });
  assert.equal(ctx.app.stops.get('12:1').sends, 0);
  // The link closes before any answer of an ask written after the off: still 0.
  ctx.gw.drop();
  await until(ctx.clock, () => !ctx.app.link, 'closed');
  assert.equal(ctx.app.stops.get('12:1').sends, 0);
  ctx.gw.silent = false;
  await until(ctx.clock, () => ctx.app.stops.get('12:1').sends >= 1, 'proven', {
    step: 100,
    max: 60_000,
  });
});

test('B2: a configuration saved during a slow attempt opens the new gateway; the stale link is closed', async (t) => {
  const first = deferred();
  const stale = fakeLink();
  let calls = 0;
  const openTcp = async (route, handlers) => {
    calls += 1;
    if (calls === 1) {
      await first.promise;
      return stale;
    }
    return realOpenTcp(route, handlers);
  };
  const other = await fakeTcpGateway();
  t.after(() => other.close());
  const ctx = await setup(t, { app: { openTcp } });
  await ctx.clock.advance(1000);
  const saving = ctx.gladys.fake.configUpdated({ ...ctx.config, gateway_address: other.address });
  await ctx.clock.advance(3000);
  // The slow attempt ends (connected) long after the new configuration.
  first.resolve();
  await saving;
  await until(ctx.clock, () => ctx.app.live && other.connections === 1, 'new gateway', {
    max: 30_000,
  });
  assert.equal(stale.closed, true, 'the stale link is closed');
  assert.notEqual(ctx.app.link, stale);
});

test('B2: same case when the slow attempt fails', async (t) => {
  const first = deferred();
  let calls = 0;
  const openTcp = async (route, handlers) => {
    calls += 1;
    if (calls === 1) {
      await first.promise;
      throw Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' });
    }
    return realOpenTcp(route, handlers);
  };
  const other = await fakeTcpGateway();
  t.after(() => other.close());
  const ctx = await setup(t, { app: { openTcp } });
  await ctx.clock.advance(1000);
  const saving = ctx.gladys.fake.configUpdated({ ...ctx.config, gateway_address: other.address });
  await ctx.clock.advance(3000);
  first.resolve();
  await saving;
  await until(ctx.clock, () => ctx.app.live && other.connections === 1, 'new gateway', {
    max: 30_000,
  });
});

test('B2: restart with an off in /data, a slow first attempt, getConfig() meanwhile: the off leaves', async (t) => {
  const gw = await fakeTcpGateway();
  const store = memoryStore({
    format: 1,
    route: { transport: 'tcp', host: '127.0.0.1', port: gw.port },
    stops: [{ node: 12, child: 1, sends: 0 }],
  });
  const first = deferred();
  let calls = 0;
  const openTcp = async (route, handlers) => {
    calls += 1;
    if (calls === 1) {
      await first.promise;
      throw Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' });
    }
    return realOpenTcp(route, handlers);
  };
  const ctx = await setup(t, { gw, store, app: { openTcp }, connect: false });
  const connecting = ctx.gladys.connect();
  await until(ctx.clock, () => calls === 1, 'first attempt');
  await ctx.clock.advance(3000);
  first.resolve();
  await connecting;
  await until(ctx.clock, () => offs(gw) >= 1 && !ctx.app.stops.has('12:1'), 'off left', {
    step: 100,
    max: 90_000,
  });
});

test('I1: the node turned on again in place (reported twice) lifts the off; once does not', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  // Known off before the click (r2 B1: the only case where "on" is a change made elsewhere).
  ctx.gw.push('12;1;1;0;2;0');
  await until(ctx.clock, () => ctx.app.nodes.get(12)?.values.has('1:2'), 'state before');
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'unconfirmed');
  const before = offs(ctx.gw);
  ctx.gw.push('12;1;1;0;2;1');
  await settle(10);
  await until(ctx.clock, () => ctx.app.stops.get('12:1')?.onReports === 1, 'one report', {
    step: 1,
  });
  assert.ok(ctx.app.stops.has('12:1'), 'one report may have crossed the off');
  ctx.gw.push('12;1;1;0;2;1');
  await until(ctx.clock, () => !ctx.app.stops.has('12:1'), 'lifted', { step: 1 });
  await ctx.clock.advance(120_000);
  assert.equal(offs(ctx.gw), before, 'never sent again over the user');
  assert.match(status(ctx.gladys), /Turned on again at the node .*12:1/);
  // A new click: the note goes, the off leaves again.
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  assert.doesNotMatch(status(ctx.gladys), /Turned on again/);
});

test('I1: reports of on that came before the off left do not count', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.push('12;1;1;0;2;1');
  ctx.gw.push('12;1;1;0;2;1');
  await settle(10);
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  assert.ok(ctx.app.stops.has('12:1'));
  assert.equal(ctx.app.stops.get('12:1').onReports, 0);
});

test('I2: an off clicked during an attempt that fails tries again at once, not after the wait', async (t) => {
  const pending = [];
  let calls = 0;
  const openTcp = async () => {
    calls += 1;
    const d = deferred();
    pending.push(d);
    return d.promise;
  };
  const ctx = await setup(t, { app: { openTcp } });
  // Many failures: the wait between tries is 1 min.
  for (let i = 0; i < 7; i += 1) {
    await until(ctx.clock, () => pending.length === i + 1, `attempt ${i + 1}`, {
      step: 100,
      max: 120_000,
    });
    pending[i].reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  }
  await until(ctx.clock, () => pending.length === 8, 'attempt in flight', {
    step: 100,
    max: 120_000,
  });
  const click = command(ctx, F(12, 1, 'relay'), 0);
  await settle(5);
  const link = fakeLink();
  pending[7].reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  await until(ctx.clock, () => pending.length === 9, 'one more try at once', {
    step: 10,
    max: 1000,
  });
  pending[8].resolve(link);
  await answer(ctx, click);
  assert.ok(link.sent.some((m) => m.type === 1 && m.payload === '0'));
  // One more try per click only: the next failure waits again.
  assert.equal(calls, 9);
});

test('M2: "gateway ready" messages ask the nodes once a minute at most', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  for (let i = 0; i < 100; i += 1) ctx.gw.push('0;255;3;0;14;Gateway startup complete.');
  await until(ctx.clock, () => ctx.gw.sent((m) => m.sub === 20).length >= 1, 'one discover');
  await ctx.clock.advance(5000);
  assert.equal(ctx.gw.sent((m) => m.type === 3 && m.sub === 20).length, 1);
  await ctx.clock.advance(60_000);
  ctx.gw.push('0;255;3;0;14;Gateway startup complete.');
  await until(ctx.clock, () => ctx.gw.sent((m) => m.sub === 20).length === 2, 'next minute');
});

test('M4: the messages of an old link are muted', async (t) => {
  const links = [];
  const handlers = [];
  const openTcp = async (_route, h) => {
    const link = fakeLink();
    links.push(link);
    handlers.push(h);
    return link;
  };
  const ctx = await setup(t, { app: { openTcp } });
  await until(ctx.clock, () => links.length === 1, 'first link');
  const saving = ctx.gladys.fake.configUpdated({
    ...ctx.config,
    gateway_address: '127.0.0.1:5999',
  });
  await until(ctx.clock, () => links.length === 2, 'second link');
  await saving;
  handlers[0].onMessage({ node: 0, child: 255, type: 3, ack: 0, sub: 2, payload: '2.3.2' }, {});
  handlers[0].onMessage({ node: 20, child: 0, type: 1, ack: 0, sub: 0, payload: '21.0' }, {});
  await ctx.clock.advance(3000);
  assert.equal(ctx.app.live, false);
  assert.equal(statesOf(ctx.gladys, F(20, 0, 'temperature')).length, 0);
});

test('M4: a TCP connection that does not open is given up after 5 s', async () => {
  const clock = testClock();
  const socket = Object.assign(new EventEmitter(), { setNoDelay() {}, destroyed: false });
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const result = tcpConnect(
    { host: '192.0.2.1', port: 5003 },
    { timers: clock.timers, netConnect: () => socket },
  ).then(
    () => 'open',
    (err) => err.code,
  );
  await clock.advance(4900);
  await clock.advance(200);
  assert.equal(
    await Promise.race([result, new Promise((r) => setTimeout(() => r('pending'), 50))]),
    'ETIMEDOUT',
  );
  assert.equal(socket.destroyed, true);
});

test('M4: messages of node 255 other than an id request are ignored', async (t) => {
  const ctx = await setup(t, { devices: [] });
  await live(ctx);
  ctx.gw.push('255;1;1;0;0;20.0');
  ctx.gw.push('255;255;3;0;11;Fake');
  ctx.gw.push('255;1;0;0;6;');
  await ctx.clock.advance(3000);
  assert.ok(!ctx.app.nodes.has(255));
  assert.ok(!ctx.gladys.fake.discoveredDevices.some((d) => d.external_id === F(255)));
});

test('M4: an on before the configuration is read says so', async (t) => {
  const ctx = await setup(t, { connect: false });
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  let calls = 0;
  ctx.gladys.getConfig = async () => {
    calls += 1;
    if (calls > 1) throw new Error('busy');
    return original();
  };
  await ctx.gladys.connect();
  await assert.rejects(
    ctx.app.setValue({}, { external_id: F(12, 1, 'relay') }, 1),
    /configuration is not read yet/,
  );
});

test('M4: the next keepalive is a full minute after the last answer', async (t) => {
  const ctx = await setup(t);
  await live(ctx);
  const asks = [];
  ctx.gw.onReceive = (m) => {
    if (m.type === 3 && m.sub === 2) asks.push(ctx.clock.elapsed);
  };
  await ctx.clock.advance(30_000);
  const at = ctx.clock.elapsed;
  await answer(ctx, ctx.app.testConnection());
  await until(ctx.clock, () => asks.length >= 2, 'keepalive', { step: 1000, max: 120_000 });
  // The ask of the button, then the keepalive at least a minute after its answer.
  assert.ok(asks[1] - at >= 59_000, `keepalive ${Math.round(asks[1] - at)} ms after the button`);
});

test('B1: a resend due while the link is down waits for the link, never forces a connection', async (t) => {
  const pending = [];
  const links = [];
  const openTcp = async (_route, handlers) => {
    const d = deferred();
    pending.push({ d, handlers });
    return d.promise;
  };
  const ctx = await setup(t, { app: { openTcp } });
  for (let i = 0; i < 7; i += 1) {
    await until(ctx.clock, () => pending.length === i + 1, `attempt ${i + 1}`, {
      step: 100,
      max: 120_000,
    });
    pending[i].d.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  }
  await until(ctx.clock, () => pending.length === 8, 'attempt 8', { step: 100, max: 120_000 });
  const link = fakeLink();
  links.push(link);
  pending[7].d.resolve(link);
  await until(ctx.clock, () => ctx.app.link === link, 'open');
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  // The link dies; its next try is a minute away; the resends of the off fall meanwhile.
  link.closed = true;
  pending[7].handlers.onClose('gone');
  await ctx.clock.advance(30_000);
  assert.equal(pending.length, 8, 'no connection forced by a resend');
});

test('I1: reports of on while the off could not leave do not lift it', async (t) => {
  let handlers;
  const link = { ...fakeLink(), send: () => false };
  const ctx = await setup(t, {
    app: {
      openTcp: async (_route, h) => {
        handlers = h;
        return link;
      },
    },
  });
  await until(ctx.clock, () => ctx.app.link === link, 'link');
  // Known off before the click: only "never left" keeps the reports from counting.
  handlers.onMessage({ node: 12, child: 1, type: 1, ack: 0, sub: 2, payload: '0' }, {});
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'kept');
  handlers.onMessage({ node: 12, child: 1, type: 1, ack: 0, sub: 2, payload: '1' }, {});
  handlers.onMessage({ node: 12, child: 1, type: 1, ack: 0, sub: 2, payload: '1' }, {});
  await settle(5);
  assert.ok(ctx.app.stops.has('12:1'));
});

/** r2: an off whose radio message is lost; the node keeps reporting its state. */
async function lostOff(t, { before, reports }) {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  for (const line of before) ctx.gw.push(line);
  await until(
    ctx.clock,
    () =>
      before.length === 0 ||
      ctx.app.nodes.get(before[0].split(';').map(Number)[0])?.values.size >= 1,
    'before',
  );
  await settle(10);
  const [node, child] = reports[0].split(';').map(Number);
  await answer(ctx, command(ctx, F(node, child, node === 13 ? 'brightness' : 'relay'), 0));
  for (let i = 0; i < 3; i += 1) {
    for (const line of reports) ctx.gw.push(line);
    await ctx.clock.advance(3000);
    await settle(5);
  }
  return { ctx, node, child };
}

test('r2 B1: reports of on when it was on before the click do not lift the off', async (t) => {
  const { ctx } = await lostOff(t, { before: ['12;1;1;0;2;1'], reports: ['12;1;1;0;2;1'] });
  assert.ok(ctx.app.stops.has('12:1'), 'the off goes on');
  await until(ctx.clock, () => ctx.app.stops.get('12:1').abandoned, 'abandoned', {
    step: 500,
    max: 200_000,
  });
  assert.equal(offs(ctx.gw), 5);
  assert.match(status(ctx.gladys), /Off read 5 times/);
});

test('r2 B1: reports of on when the state before was unknown do not lift the off', async (t) => {
  const { ctx } = await lostOff(t, { before: [], reports: ['12;1;1;0;2;1'] });
  assert.ok(ctx.app.stops.has('12:1'));
  assert.ok(offs(ctx.gw) >= 3, 'sent again');
});

test('r2 B1: a dimmer pair V_STATUS + V_PERCENTAGE is one reading', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.push('13;1;1;0;2;0');
  await until(ctx.clock, () => ctx.app.nodes.get(13)?.values.has('1:2'), 'state before');
  await answer(ctx, command(ctx, F(13, 1, 'brightness'), 0));
  ctx.gw.push('13;1;1;0;2;1');
  ctx.gw.push('13;1;1;0;3;60');
  await ctx.clock.advance(1000);
  await settle(10);
  assert.ok(ctx.app.stops.has('13:1'), 'one change, read once');
  assert.equal(ctx.app.stops.get('13:1').onReports, 1);
});

test('r2 M1: the note "turned on again" goes with the next report, or after 10 min', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  for (const target of ['12;1', '13;1']) {
    ctx.gw.push(`${target};1;0;2;0`);
  }
  await until(ctx.clock, () => ctx.app.nodes.get(13)?.values.has('1:2'), 'states before');
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  await answer(ctx, command(ctx, F(13, 1, 'light'), 0));
  for (const target of ['12;1', '12;1', '13;1', '13;1']) ctx.gw.push(`${target};1;0;2;1`);
  await until(ctx.clock, () => ctx.app.overridden.size === 2, 'two lifted', { step: 1 });
  ctx.gw.push('12;1;1;0;2;1');
  await until(ctx.clock, () => !ctx.app.overridden.has('12:1'), 'next report', { step: 1 });
  assert.ok(ctx.app.overridden.has('13:1'));
  await ctx.clock.advance(601_000);
  await ctx.app.updateStatus();
  assert.doesNotMatch(status(ctx.gladys), /Turned on again/);
});

test('r2 I1: an answer proves only the oldest ask still waiting; unasked answers prove nothing', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.silent = true;
  // Unasked answers (another controller of the gateway): no ask waits, nothing proven.
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  // Writes at 0, 1.5 s and 6.5 s, the next one at 26.5 s: at 18 s every ask is over 10 s old.
  await ctx.clock.advance(14_500);
  for (let i = 0; i < 10; i += 1) ctx.gw.push('0;255;3;0;2;2.3.2');
  await until(ctx.clock, () => ctx.app.unaskedCount === 10, 'unasked answers read', { step: 1 });
  assert.equal(ctx.app.stops.get('12:1').sends, 0, 'the asks expired: these answers prove nothing');
  // A minute without unasked answers, then a fresh ask after the off proves it.
  ctx.gw.silent = false;
  const quietFrom = ctx.clock.elapsed;
  await until(ctx.clock, () => ctx.app.stops.get('12:1').sends >= 1, 'proven', {
    step: 500,
    max: 150_000,
  });
  assert.ok(
    ctx.clock.elapsed - quietFrom >= 59_000,
    'no proof in the minute after unasked answers',
  );
  await until(ctx.clock, () => ctx.app.stops.get('12:1').abandoned, 'abandoned after 5', {
    step: 1000,
    max: 300_000,
  });
  assert.equal(ctx.app.stops.get('12:1').sends, 5);
});

test('r2 M2: an attempt to the same gateway is kept when the configuration comes', async (t) => {
  const gw = await fakeTcpGateway();
  const store = memoryStore({
    format: 1,
    route: { transport: 'tcp', host: '127.0.0.1', port: gw.port },
    stops: [{ node: 12, child: 1, sends: 0 }],
  });
  const first = deferred();
  let calls = 0;
  const openTcp = async (route, handlers) => {
    calls += 1;
    if (calls === 1) await first.promise;
    return realOpenTcp(route, handlers);
  };
  const ctx = await setup(t, { gw, store, app: { openTcp }, connect: false });
  const connecting = ctx.gladys.connect();
  await until(ctx.clock, () => calls === 1, 'first attempt');
  await ctx.clock.advance(3000);
  first.resolve();
  await connecting;
  await until(ctx.clock, () => !ctx.app.stops.has('12:1'), 'off confirmed');
  await ctx.clock.advance(5000);
  assert.equal(calls, 1, 'one attempt, kept');
  assert.equal(gw.connections, 1);
});

test('r2 I1: an ask lost while the gateway was away never delays the proof of a later off', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.silent = true;
  // The keepalive ask of the next minute is lost.
  await until(
    ctx.clock,
    () => ctx.gw.sent((m) => m.type === 3 && m.sub === 2).length >= 2,
    'lost ask',
    {
      step: 1000,
      max: 90_000,
    },
  );
  await ctx.clock.advance(12_000);
  ctx.gw.silent = false;
  assert.equal(await answer(ctx, command(ctx, F(12, 1, 'relay'), 0)), 'unconfirmed');
  assert.equal(ctx.app.stops.get('12:1').sends >= 1, true, 'proven by the answer to its own ask');
});

test('r2 I1: answers nobody asked for, coming all along, never make an unread off abandoned', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.silent = true;
  for (let i = 0; i < 6; i += 1) ctx.gw.push('0;255;3;0;2;2.3.2');
  await settle(10);
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0));
  for (let i = 0; i < 60; i += 1) {
    ctx.gw.push('0;255;3;0;2;2.3.2');
    await ctx.clock.advance(3000);
  }
  const stop = ctx.app.stops.get('12:1');
  assert.equal(stop.sends, 0);
  assert.equal(stop.abandoned, false);
  assert.match(status(ctx.gladys), /answers requests Gladys did not make/);
});

test('r2 I1: a proof followed within seconds by an answer nobody asked for is withdrawn', async (t) => {
  const ctx = await setup(t, { gateway: { echo: false } });
  await live(ctx);
  ctx.gw.silent = true;
  await answer(ctx, command(ctx, F(12, 1, 'relay'), 0), { max: 1 }).catch(() => {});
  // A forged answer takes the place of the answer to the ask of the off...
  ctx.gw.push('0;255;3;0;2;2.3.2');
  await until(ctx.clock, () => ctx.app.stops.get('12:1').sends === 1, 'taken as proof', {
    step: 1,
  });
  // ...and the next one shows answers come that nobody asked for.
  ctx.gw.push('0;255;3;0;2;2.3.2');
  await until(ctx.clock, () => ctx.app.unaskedAt !== undefined, 'unasked', { step: 1 });
  assert.equal(ctx.app.stops.get('12:1').sends, 0);
});
