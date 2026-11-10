// -----------------------------------------------------------------------------
// Fake MySensors gateways on real local sockets (127.0.0.1, free port), built
// from the published serial protocol 2.x and pymysensors:
//   - fakeTcpGateway(): the Ethernet gateway (a TCP server, one line per
//     message);
//   - fakeBroker(): an MQTT broker (mqtt-packet, the parser of mqtt.js) with
//     the MQTT gateway behind it (`mygateway1-out` / `mygateway1-in`).
// Both play the same gateway: they answer I_VERSION, and echo the commands
// sent with the ack flag (as the radio layer of a node does) when `echo` is
// on. `received` keeps every message the integration sent; `push(line)`
// sends a message of a node; counters of connections (open, peak).
//
// Latency check: FAKE_GATEWAY_DELAY / FAKE_BROKER_DELAY (ms), or the `delay`
// option, delay what each fake reads from the integration (in order), as a
// slow network or a loaded runner would; the suite must pass with them: its
// network waits are in real time (helpers/app.js) and the virtual clock never
// moves while a delayed message is on its way (`networkIdle`). Example:
//   FAKE_GATEWAY_DELAY=300 FAKE_BROKER_DELAY=700 node --test test/*.test.js
// -----------------------------------------------------------------------------

import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mqttPacket = require('mqtt-packet');

const delayOf = (name) => Math.max(0, Number(process.env[name] ?? 0) || 0);

/** Messages of the integration delayed on their way to a fake (every fake of the process). */
const inflight = { count: 0 };

/** True when no delayed message is on its way (the virtual clock may move). */
export const networkIdle = () => inflight.count === 0;

/** Runs `fn(data)` now, or `ms` later (each chunk in order, counted while on its way). */
function later(ms, fn) {
  if (!(ms > 0)) return fn;
  return (data) => {
    inflight.count += 1;
    setTimeout(() => {
      inflight.count -= 1;
      fn(data);
    }, ms);
  };
}

export const parse = (line) => {
  const parts = line.split(';');
  const [node, child, type, ack, sub] = parts.slice(0, 5).map(Number);
  return { node, child, type, ack, sub, payload: parts.slice(5).join(';') };
};
export const line = (m) => `${m.node};${m.child};${m.type};${m.ack};${m.sub};${m.payload ?? ''}`;

/** The gateway behind both fakes: the answers to one message of the controller. */
function brain(gw, msg) {
  gw.received.push(msg);
  gw.onReceive?.(msg);
  if (gw.silent) return [];
  if (msg.type === 3 && msg.sub === 2 && msg.node === 0) {
    return [{ node: 0, child: 255, type: 3, ack: 0, sub: 2, payload: gw.version }];
  }
  if (msg.type === 1 && msg.ack === 1 && gw.echo && !gw.deaf.has(msg.node)) {
    const answers = [{ ...msg }];
    if (gw.report) answers.push({ ...msg, ack: 0 });
    return answers;
  }
  return [];
}

function gatewayState(options) {
  return {
    version: '2.3.2',
    echo: true,
    report: false,
    silent: false,
    deaf: new Set(),
    received: [],
    connections: 0,
    open: 0,
    peak: 0,
    onReceive: undefined,
    ...options,
  };
}

/** Waits (real time, bounded) until `condition()`. */
export async function waitUntil(condition, what = 'condition', ms = 3000) {
  const deadline = performance.now() + ms;
  for (;;) {
    if (await condition()) return;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export async function fakeTcpGateway(options = {}) {
  const gw = gatewayState(options);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    gw.connections += 1;
    gw.open += 1;
    gw.peak = Math.max(gw.peak, gw.open);
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      gw.open -= 1;
      sockets.delete(socket);
    });
    if (gw.closeOnConnect) {
      socket.destroy();
      return;
    }
    let buffer = '';
    socket.on(
      'data',
      later(gw.delay ?? delayOf('FAKE_GATEWAY_DELAY'), (data) => {
        if (socket.destroyed) return;
        buffer += data.toString('latin1');
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const text = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          for (const answer of brain(gw, parse(text))) socket.write(`${line(answer)}\n`);
        }
      }),
    );
    gw.onConnect?.(socket);
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  gw.port = server.address().port;
  gw.address = `127.0.0.1:${gw.port}`;
  /** Sends raw text (lines) to every connected client. */
  gw.write = (text) => {
    for (const socket of sockets) socket.write(text);
  };
  gw.push = (message) => gw.write(`${typeof message === 'string' ? message : line(message)}\n`);
  gw.drop = () => {
    for (const socket of sockets) socket.destroy();
  };
  gw.sent = (filter) => gw.received.filter(filter);
  gw.close = async () => {
    gw.drop();
    await new Promise((resolve) => server.close(resolve));
  };
  return gw;
}

/**
 * An MQTT broker with the MySensors MQTT gateway behind it. `connack(packet)`
 * answers each CONNECT (default: accepted); `published` keeps every PUBLISH of
 * the integration (topic, payload, retain).
 */
export async function fakeBroker(options = {}) {
  const gw = gatewayState({ inPrefix: 'mygateway1-out', outPrefix: 'mygateway1-in', ...options });
  gw.published = [];
  gw.connects = [];
  const clients = new Set();
  const server = net.createServer((socket) => {
    gw.connections += 1;
    gw.open += 1;
    gw.peak = Math.max(gw.peak, gw.open);
    let version = 4;
    const parser = mqttPacket.parser();
    const client = {
      socket,
      subscribed: false,
      send: (p) => socket.write(mqttPacket.generate(p, { protocolVersion: version })),
    };
    clients.add(client);
    socket.on('error', () => {});
    socket.on('close', () => {
      gw.open -= 1;
      clients.delete(client);
    });
    parser.on('packet', (packet) => {
      if (packet.cmd === 'connect') {
        version = packet.protocolVersion;
        gw.connects.push(packet);
        const answer = gw.connack ? gw.connack(packet, socket) : { reasonCode: 0 };
        if (answer === 'silent') return;
        if (answer === 'close') {
          socket.destroy();
          return;
        }
        client.send({
          cmd: 'connack',
          sessionPresent: false,
          returnCode: answer.reasonCode,
          ...answer,
        });
        if (answer.reasonCode !== 0) socket.end();
        return;
      }
      if (packet.cmd === 'subscribe') {
        client.subscribed = true;
        client.send({
          cmd: 'suback',
          messageId: packet.messageId,
          granted: packet.subscriptions.map(() => 0),
        });
        for (const retained of gw.retained ?? []) {
          client.send({ cmd: 'publish', retain: true, qos: 0, dup: false, ...retained });
        }
        return;
      }
      if (packet.cmd === 'pingreq') {
        client.send({ cmd: 'pingresp' });
        return;
      }
      if (packet.cmd === 'publish') {
        const payload = String(packet.payload);
        gw.published.push({ topic: packet.topic, payload, retain: packet.retain });
        const prefix = `${gw.outPrefix}/`;
        if (!packet.topic.startsWith(prefix)) return;
        const [node, child, type, ack, sub] = packet.topic
          .slice(prefix.length)
          .split('/')
          .map(Number);
        for (const answer of brain(gw, { node, child, type, ack, sub, payload })) gw.push(answer);
      }
    });
    socket.on(
      'data',
      later(gw.delay ?? delayOf('FAKE_BROKER_DELAY'), (data) => {
        if (!socket.destroyed) parser.parse(data);
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  gw.port = server.address().port;
  gw.address = `127.0.0.1:${gw.port}`;
  /** A message of the gateway (published on `<inPrefix>/...`) to every subscribed client. */
  gw.push = (message, { retain = false } = {}) => {
    const m = typeof message === 'string' ? parse(message) : message;
    const topic = `${gw.inPrefix}/${m.node}/${m.child}/${m.type}/${m.ack}/${m.sub}`;
    for (const client of clients) {
      if (client.subscribed) {
        client.send({
          cmd: 'publish',
          topic,
          payload: m.payload ?? '',
          retain,
          qos: 0,
          dup: false,
        });
      }
    }
  };
  /** A raw packet to every client (an oversized one, a wrong topic...). */
  gw.raw = (bytes) => {
    for (const client of clients) client.socket.write(bytes);
  };
  gw.drop = () => {
    for (const client of clients) client.socket.destroy();
  };
  gw.sent = (filter) => gw.received.filter(filter);
  gw.close = async () => {
    gw.drop();
    await new Promise((resolve) => server.close(resolve));
  };
  return gw;
}
