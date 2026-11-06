// -----------------------------------------------------------------------------
// The MQTT side: the MySensors MQTT gateway publishes on `<out prefix>/...`
// and listens on `<in prefix>/...` of the broker of the user.
//
// mqtt.js over a TCP socket built here (from gladys-qbus), so every packet
// the broker sends is bounded BEFORE it is buffered: the fixed header
// announces its length, and a packet over LIMITS.packetBytes (4 KB: a
// MySensors message is a topic of a few dozen bytes and a payload of 25 at
// most) cuts the connection at once. With MQTT 5, `maximumPacketSize` asks
// the broker not to send such a packet at all (Mosquitto drops it). A broker
// without MQTT 5 is used in 3.1.1; the guard still applies.
//
// One client at a time, created per connection attempt and never
// reconnecting by itself (reconnectPeriod 0): src/app.js decides when to try
// again. Nothing is ever queued while offline (queueQoSZero: false): a
// command leaves now or is refused, never minutes later. Commands are
// published with retain off (a retained command would be replayed to the
// gateway by the broker at its next connection).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Duplex, Transform } from 'node:stream';
import { MqttClient } from 'mqtt';
import { LIMITS, TIMINGS } from './constants.js';
import { MAX_PAYLOAD, encodeTopic, parseTopic } from './protocol.js';

export const MAX_PACKET = LIMITS.packetBytes;

/** MQTT 3.1.1 / 5 CONNACK refusals worth a precise message. */
export const REFUSALS = {
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized',
  128: 'unspecified error',
  132: 'unsupported protocol version',
  133: 'client identifier not valid',
  134: 'bad user name or password',
  135: 'not authorized',
  136: 'server unavailable',
  137: 'server busy',
  138: 'banned',
};

/**
 * Cuts the stream as soon as a packet header announces more than `max`
 * bytes (or is malformed): the rest is never buffered. Packets are tracked
 * across chunks (header bytes, then the body skipped).
 */
export class PacketGuard extends Transform {
  constructor(max = MAX_PACKET) {
    super();
    this.max = max;
    this.skip = 0;
    this.header = [];
  }

  _transform(chunk, _encoding, callback) {
    let i = 0;
    // Where the packet being refused starts in this chunk: the packets before
    // it (a CONNACK in the same chunk...) are still delivered before the cut.
    let start = 0;
    const cut = (message) => {
      if (start > 0) this.push(chunk.subarray(0, start));
      callback(guardError(message));
    };
    while (i < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - i);
        this.skip -= n;
        i += n;
        continue;
      }
      if (this.header.length === 0) start = i;
      this.header.push(chunk[i]);
      i += 1;
      if (this.header.length === 1) continue;
      const last = this.header[this.header.length - 1];
      if (last & 0x80) {
        if (this.header.length >= 5) return cut('malformed packet length');
        continue;
      }
      let length = 0;
      let factor = 1;
      for (let k = 1; k < this.header.length; k += 1) {
        length += (this.header[k] & 0x7f) * factor;
        factor *= 128;
      }
      if (length + this.header.length > this.max) {
        return cut(`a message over ${this.max} bytes`);
      }
      this.skip = length;
      this.header = [];
    }
    return callback(null, chunk);
  }
}

function guardError(message) {
  const err = new Error(message);
  err.code = 'PACKET_TOO_LARGE';
  return err;
}

/** The socket to the broker, its incoming side behind the guard; `onOpen` once TCP is connected. */
export function guardedStream(config, { onOpen } = {}) {
  const socket = net.connect({ host: config.host, port: config.port });
  socket.once('connect', () => onOpen?.());
  const guard = new PacketGuard();
  socket.pipe(guard);
  const stream = new Duplex({
    read() {
      guard.resume();
    },
    write(chunk, _encoding, callback) {
      socket.write(chunk, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(err, callback) {
      socket.destroy();
      guard.destroy();
      callback(err);
    },
  });
  guard.on('data', (chunk) => {
    if (!stream.push(chunk)) guard.pause();
  });
  guard.on('end', () => stream.push(null));
  guard.on('error', (err) => stream.destroy(err));
  socket.on('error', (err) => stream.destroy(err));
  socket.on('close', () => stream.destroy());
  return stream;
}

export function connectBroker(config, { protocolVersion = 5, onOpen } = {}) {
  return new MqttClient(() => guardedStream(config, { onOpen }), {
    username: config.username || undefined,
    password: config.password || undefined,
    // A random client id: two instances (a test and a restart) never kick each other out.
    clientId: `gladys_mysensors_${randomBytes(4).toString('hex')}`,
    clean: true,
    keepalive: 60,
    connectTimeout: TIMINGS.connectTimeout,
    reconnectPeriod: 0,
    protocolVersion,
    ...(protocolVersion === 5 ? { properties: { maximumPacketSize: MAX_PACKET } } : {}),
    resubscribe: false,
    queueQoSZero: false,
  });
}

/** A readable reason for a connection error (never the password). */
export function errorReason(err) {
  if (!err) return 'unknown error';
  if (err.code !== undefined && REFUSALS[err.code]) return REFUSALS[err.code];
  if (err.code === 'PACKET_TOO_LARGE') return `the broker sent ${err.message}: connection cut`;
  if (typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code)) return err.code;
  return String(err.message ?? err)
    .replace(/\/\/[^@/\s]*@/g, '//')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 120);
}

/** The broker refused the credentials (or the client is not allowed). */
export const isRefusal = (err) =>
  err?.code !== undefined && [4, 5, 134, 135, 138].includes(err.code);

/** The broker does not speak MQTT 5 (3.1.1 brokers answer 1, MQTT 5 ones 132). */
export const isProtocolRefusal = (err) => err?.code === 1 || err?.code === 132;

/**
 * Opens one MQTT link: resolves once the broker accepted the connection
 * and the subscription; rejects with the error (`refusal`: credentials
 * refused; `protocol`: no MQTT 5; `unanswered`: the CONNECT left once the
 * transport opened and got no CONNACK).
 */
export function openMqtt(
  config,
  { onMessage, onClose, timers = globalThis, connect = connectBroker, protocolVersion = 5 },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connectSent = false;
    let link;
    const client = connect(config, {
      protocolVersion,
      onOpen: () => {
        connectSent = true;
      },
    });
    client.on('packetreceive', (packet) => {
      if (packet?.cmd === 'connack') connectSent = false;
    });
    const timer = timers.setTimeout(
      () => fail(Object.assign(new Error('no answer from the broker'), { code: 'ETIMEDOUT' })),
      TIMINGS.connectTimeout + 1000,
    );
    const end = () => {
      client.removeAllListeners('message');
      client.on('error', () => {});
      client.end(true);
    };
    function fail(err) {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      const error = err instanceof Error ? err : new Error(String(err));
      error.refusal = isRefusal(err);
      error.protocol = isProtocolRefusal(err);
      error.unanswered = connectSent && !error.refusal && !error.protocol;
      end();
      reject(error);
    }
    client.on('connect', () => {
      if (settled) return;
      client.subscribe(`${config.inPrefix}/+/+/+/+/+`, { qos: 0 }, (err, granted) => {
        if (settled) return;
        if (err || !Array.isArray(granted) || granted.some((g) => g.qos >= 128)) {
          fail(Object.assign(new Error('subscription refused'), { code: 'ESUBSCRIBE' }));
          return;
        }
        settled = true;
        timers.clearTimeout(timer);
        link = new MqttLink(client, config, { onClose });
        resolve(link);
      });
    });
    client.on('message', (topic, payload, packet) => {
      if (!link || link.closed) return;
      if (!Buffer.isBuffer(payload) || payload.length > MAX_PAYLOAD) {
        link.dropped += 1;
        return;
      }
      const msg = parseTopic(config.inPrefix, topic, payload.toString('latin1'));
      if (!msg) {
        link.dropped += 1;
        return;
      }
      // A retained message was kept by the broker: it may be hours old.
      onMessage(msg, { retained: packet?.retain === true });
    });
    client.on('error', (err) => {
      if (!settled) {
        fail(err);
        return;
      }
      link?.close(errorReason(err));
    });
    client.on('close', () => {
      if (!settled) {
        fail(Object.assign(new Error('the broker closed the connection'), { code: 'ECLOSED' }));
        return;
      }
      link?.close('connection closed');
    });
  });
}

export class MqttLink {
  constructor(client, config, { onClose }) {
    this.client = client;
    this.outPrefix = config.outPrefix;
    this.onClose = onClose;
    this.closed = false;
    this.dropped = 0;
    this.kind = 'mqtt';
  }

  /** Publishes a message to the gateway: true when it was written to the broker connection. */
  send(msg) {
    if (this.closed || !this.client.connected) return false;
    const { topic, payload } = encodeTopic(this.outPrefix, msg);
    this.client.publish(topic, payload, { qos: 0, retain: false }, () => {});
    return true;
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.client.removeAllListeners('message');
    this.client.on('error', () => {});
    this.client.end(true);
    this.onClose?.(reason);
  }

  /** Resolves once the socket is gone (bounded by the caller). */
  async closedSocket() {
    if (this.client.disconnected || !this.client.stream || this.client.stream.destroyed) return;
    await new Promise((resolve) => this.client.stream.once('close', resolve));
  }
}
