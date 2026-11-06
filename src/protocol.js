// -----------------------------------------------------------------------------
// The MySensors serial protocol 2.x: one message per line,
//   node-id;child-sensor-id;command;ack;type;payload\n
// over the TCP Ethernet gateway, and as an MQTT topic + payload,
//   <prefix>/node-id/child-sensor-id/command/ack/type  ->  payload
// over the MQTT gateway (ported from pymysensors 0.26.0, message.py and
// gateway_mqtt.py; MIT). Pure functions, everything from the network checked:
// strict numbers in their ranges, a printable payload of bounded length.
// -----------------------------------------------------------------------------

import { BROADCAST, LIMITS, TYPE } from './constants.js';

/** A field of 1 to 3 digits, no sign, no leading zero, no space. */
const FIELD = /^(?:0|[1-9]\d{0,2})$/;
/** A payload: printable ASCII only (no control byte, no separator of lines). */

const PRINTABLE = /^[\x20-\x7e]*$/;
/** The longest payload read (a debug log line of the gateway fits). */
export const MAX_PAYLOAD = 200;

const field = (text, max) => {
  if (!FIELD.test(text)) return undefined;
  const value = Number(text);
  return value <= max ? value : undefined;
};

/** A message from its five numbers and its payload (strings), or undefined. */
export function messageOf(parts, payload) {
  if (parts.length !== 5) return undefined;
  const node = field(parts[0], 255);
  const child = field(parts[1], 255);
  const type = field(parts[2], 4);
  const ack = field(parts[3], 1);
  const sub = field(parts[4], 255);
  if ([node, child, type, ack, sub].includes(undefined)) return undefined;
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD || !PRINTABLE.test(payload)) {
    return undefined;
  }
  return { node, child, type, ack, sub, payload };
}

/** One line of the TCP gateway (without its line feed), or undefined when it is not one. */
export function parseLine(line) {
  if (typeof line !== 'string' || line.length > LIMITS.lineBytes) return undefined;
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  const parts = [];
  let start = 0;
  for (let i = 0; i < 5; i += 1) {
    const at = text.indexOf(';', start);
    if (at < 0) return undefined;
    parts.push(text.slice(start, at));
    start = at + 1;
  }
  return messageOf(parts, text.slice(start));
}

const checkOutgoing = (msg) => {
  for (const [key, max] of [
    ['node', 255],
    ['child', 255],
    ['type', 4],
    ['ack', 1],
    ['sub', 255],
  ]) {
    if (!Number.isInteger(msg[key]) || msg[key] < 0 || msg[key] > max) {
      throw new RangeError(`invalid ${key}`);
    }
  }
  const payload = String(msg.payload ?? '');
  if (payload.length > LIMITS.payloadBytes || !PRINTABLE.test(payload) || payload.includes(';')) {
    throw new RangeError('invalid payload');
  }
  return payload;
};

/** The line sent to the TCP gateway. */
export function encodeLine(msg) {
  const payload = checkOutgoing(msg);
  return `${msg.node};${msg.child};${msg.type};${msg.ack};${msg.sub};${payload}\n`;
}

/** An MQTT message of the gateway (topic under `prefix`), or undefined. */
export function parseTopic(prefix, topic, payload) {
  if (typeof topic !== 'string' || topic.length > LIMITS.topicBytes) return undefined;
  if (!topic.startsWith(`${prefix}/`)) return undefined;
  const parts = topic.slice(prefix.length + 1).split('/');
  return messageOf(parts, payload);
}

/** The MQTT topic and payload of a message sent to the gateway (under `prefix`). */
export function encodeTopic(prefix, msg) {
  const payload = checkOutgoing(msg);
  return {
    topic: `${prefix}/${msg.node}/${msg.child}/${msg.type}/${msg.ack}/${msg.sub}`,
    payload,
  };
}

/**
 * A number sent by a node: decimal digits, an optional sign and fraction.
 * '' or anything else is unknown (undefined), never 0.
 */
export function numberOf(payload) {
  if (typeof payload !== 'string' || !/^-?\d{1,9}(?:\.\d{1,6})?$/.test(payload)) {
    return undefined;
  }
  const value = Number(payload);
  return Number.isFinite(value) ? value : undefined;
}

/** An on/off sent by a node: "0" or "1" only. */
export const binaryOf = (payload) => (payload === '0' ? 0 : payload === '1' ? 1 : undefined);

/** A whole number within [min, max], else undefined. */
export function integerOf(payload, min, max) {
  if (typeof payload !== 'string' || !/^\d{1,4}$/.test(payload)) return undefined;
  const value = Number(payload);
  return value >= min && value <= max ? value : undefined;
}

/** Two messages are the same command (the echo of a command, payload compared as text). */
export const sameCommand = (a, b) =>
  a.node === b.node &&
  a.child === b.child &&
  a.type === b.type &&
  a.sub === b.sub &&
  a.payload === b.payload;

/** The message asking every node to answer (sent when the gateway says it is ready). */
export const discoverMessage = (sub) => ({
  node: BROADCAST,
  child: BROADCAST,
  type: TYPE.INTERNAL,
  ack: 0,
  sub,
  payload: '',
});
