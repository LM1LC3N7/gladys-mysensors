// -----------------------------------------------------------------------------
// MySensors nodes -> Gladys devices (pure).
//
// Identifier rule (frozen, it fixes the external ids):
//   `ext:<selector>:node:<id>`                    one device per node (0-254);
//   `ext:<selector>:node:<id>:<child>-<kind>`     one feature per value of a child;
//   `ext:<selector>:node:<id>:battery`            the battery level of the node.
// MySensors gives no serial number nor MAC address: the node id is the
// identity of a node in its network, as for every MySensors controller
// (pymysensors keys its sensors on it too). One Gladys integration serves one
// MySensors network (one gateway).
//
// What a child becomes comes from its presentation (S_* type), else, for the
// values whose meaning does not depend on it (V_TEMP, V_HUM...), from the
// value itself. A relay (S_BINARY) or a dimmer (S_DIMMER) is a switch or a
// light ONLY when the user declared it safe (`<node>:<child>`): any other
// on/off output is read only, never a `switch` (a "turn everything off/on"
// reaches every switch and light, and a relay may drive a pump, a heater or
// a garage door).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { KIND, LIMITS, NODE_CHILD, NODE_MAX, NODE_MIN, S, V } from './constants.js';
import { binaryOf, integerOf, numberOf } from './protocol.js';
import { kindName, nodeName } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const command = (definition) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...definition,
});

const decimal = (category, unit, min, max) =>
  sensor({ category, type: T.SENSOR.DECIMAL, unit, min, max });

/** A number within [min, max] (a value out of range is not a measurement). */
const measured = (min, max) => (payload) => {
  const value = numberOf(payload);
  return value !== undefined && value >= min && value <= max ? value : undefined;
};
const onOff = (payload) => binaryOf(payload);
const percent = (payload) => integerOf(payload, 0, 100);

/**
 * Every kind: the value type it reads, its Gladys feature and the conversion
 * of a payload to the Gladys value (undefined: not a value, never published).
 */
export const KINDS = {
  [KIND.TEMPERATURE]: {
    v: V.TEMP,
    feature: decimal(C.TEMPERATURE_SENSOR, U.CELSIUS, -60, 125),
    read: measured(-60, 125),
  },
  [KIND.HUMIDITY]: {
    v: V.HUM,
    feature: decimal(C.HUMIDITY_SENSOR, U.PERCENT, 0, 100),
    read: measured(0, 100),
  },
  [KIND.PRESSURE]: {
    v: V.PRESSURE,
    feature: decimal(C.PRESSURE_SENSOR, U.HECTO_PASCAL, 300, 1200),
    read: measured(300, 1200),
  },
  // MySensors: V_TRIPPED 1 = the door is open. Gladys: 1 = closed, 0 = open.
  [KIND.DOOR]: {
    v: V.TRIPPED,
    feature: sensor({ category: C.OPENING_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 }),
    read: (payload) => {
      const tripped = binaryOf(payload);
      return tripped === undefined ? undefined : 1 - tripped;
    },
  },
  [KIND.MOTION]: {
    v: V.TRIPPED,
    feature: sensor({ category: C.MOTION_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 }),
    read: onOff,
  },
  [KIND.SMOKE]: {
    v: V.TRIPPED,
    feature: sensor({ category: C.SMOKE_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 }),
    read: onOff,
  },
  [KIND.LEAK]: {
    v: V.TRIPPED,
    feature: sensor({ category: C.LEAK_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 }),
    read: onOff,
  },
  [KIND.VIBRATION]: {
    v: V.TRIPPED,
    feature: sensor({ category: C.VIBRATION_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 }),
    read: onOff,
  },
  [KIND.RELAY]: {
    v: V.STATUS,
    feature: command({ category: C.SWITCH, type: T.SWITCH.BINARY, min: 0, max: 1 }),
    read: onOff,
  },
  [KIND.STATE]: {
    v: V.STATUS,
    feature: sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
    read: onOff,
  },
  [KIND.LIGHT]: {
    v: V.STATUS,
    feature: command({ category: C.LIGHT, type: T.LIGHT.BINARY, min: 0, max: 1 }),
    read: onOff,
  },
  [KIND.BRIGHTNESS]: {
    v: V.PERCENTAGE,
    feature: command({
      category: C.LIGHT,
      type: T.LIGHT.BRIGHTNESS,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    }),
    read: percent,
  },
  [KIND.LEVEL]: {
    v: V.PERCENTAGE,
    feature: sensor({
      category: C.UNKNOWN,
      type: T.SENSOR.INTEGER,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    }),
    read: percent,
  },
  // V_WATT may be negative (a production): a signed sensor.
  [KIND.POWER]: {
    v: V.WATT,
    feature: decimal(C.ENERGY_SENSOR, U.WATT, -100000, 100000),
    read: measured(-100000, 100000),
  },
  [KIND.VOLTAGE]: {
    v: V.VOLTAGE,
    feature: decimal(C.ENERGY_SENSOR, U.VOLT, -1000, 1000),
    read: measured(-1000, 1000),
  },
  [KIND.CURRENT]: {
    v: V.CURRENT,
    feature: decimal(C.ENERGY_SENSOR, U.AMPERE, -1000, 1000),
    read: measured(-1000, 1000),
  },
  [KIND.LUX]: {
    v: V.LEVEL,
    feature: decimal(C.LIGHT_SENSOR, U.LUX, 0, 200000),
    read: measured(0, 200000),
  },
  [KIND.MOISTURE]: {
    v: V.LEVEL,
    feature: decimal(C.SOIL_MOISTURE_SENSOR, U.PERCENT, 0, 100),
    read: measured(0, 100),
  },
  [KIND.UV]: {
    v: V.UV,
    feature: decimal(C.UV_SENSOR, U.UV_INDEX, 0, 20),
    read: measured(0, 20),
  },
  [KIND.DISTANCE]: {
    v: V.DISTANCE,
    feature: decimal(C.DISTANCE_SENSOR, U.CM, 0, 100000),
    read: measured(0, 100000),
  },
  [KIND.PH]: {
    v: V.PH,
    feature: decimal(C.PH_SENSOR, U.PH, 0, 14),
    read: measured(0, 14),
  },
  [KIND.ORP]: {
    v: V.ORP,
    feature: decimal(C.ORP_SENSOR, U.MILLI_VOLT, -2000, 2000),
    read: measured(-2000, 2000),
  },
  [KIND.BATTERY]: {
    v: undefined,
    feature: sensor({
      category: C.BATTERY,
      type: T.BATTERY.INTEGER,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    }),
    read: percent,
  },
};

/** The kinds of a presented child (S_* type); `safe`: declared safe by the user. */
export function kindsOfPresentation(sType, safe) {
  switch (sType) {
    case S.DOOR:
      return [KIND.DOOR];
    case S.MOTION:
      return [KIND.MOTION];
    case S.SMOKE:
      return [KIND.SMOKE];
    case S.WATER_LEAK:
      return [KIND.LEAK];
    case S.VIBRATION:
      return [KIND.VIBRATION];
    case S.BINARY:
      return safe ? [KIND.RELAY] : [KIND.STATE];
    case S.DIMMER:
      return safe ? [KIND.LIGHT, KIND.BRIGHTNESS] : [KIND.STATE, KIND.LEVEL];
    // A heater or a sprinkler: its on/off is shown, never commanded.
    case S.HEATER:
    case S.SPRINKLER:
      return [KIND.STATE];
    case S.TEMP:
      return [KIND.TEMPERATURE];
    case S.HUM:
      return [KIND.HUMIDITY];
    case S.BARO:
      return [KIND.PRESSURE];
    case S.UV:
      return [KIND.UV];
    case S.DISTANCE:
      return [KIND.DISTANCE];
    case S.LIGHT_LEVEL:
      return [KIND.LUX];
    case S.MOISTURE:
      return [KIND.MOISTURE];
    case S.POWER:
      return [KIND.POWER];
    case S.MULTIMETER:
      return [KIND.VOLTAGE, KIND.CURRENT];
    case S.WATER_QUALITY:
      return [KIND.TEMPERATURE, KIND.PH, KIND.ORP];
    default:
      return [];
  }
}

/** The kinds a value type means whatever the presentation (the others need one). */
const UNAMBIGUOUS = {
  [V.TEMP]: KIND.TEMPERATURE,
  [V.HUM]: KIND.HUMIDITY,
  [V.PRESSURE]: KIND.PRESSURE,
  [V.WATT]: KIND.POWER,
  [V.VOLTAGE]: KIND.VOLTAGE,
  [V.CURRENT]: KIND.CURRENT,
  [V.UV]: KIND.UV,
  [V.DISTANCE]: KIND.DISTANCE,
  [V.PH]: KIND.PH,
  [V.ORP]: KIND.ORP,
};

export const kindOfValue = (vType) => UNAMBIGUOUS[vType];

/** Every kind that reads a value type. */
export const kindsReading = (vType) =>
  Object.entries(KINDS)
    .filter(([, def]) => def.v === vType)
    .map(([kind]) => kind);

/** The kinds a command may target, and the value type each one writes. */
export const COMMAND_KINDS = {
  [KIND.RELAY]: V.STATUS,
  [KIND.LIGHT]: V.STATUS,
  [KIND.BRIGHTNESS]: V.PERCENTAGE,
};

/** The presentation types a declared-safe entry may command. */
export const COMMANDABLE = new Set([S.BINARY, S.DIMMER]);

// --- External ids --------------------------------------------------------------

export const nodeIds = (gladys, node) => gladys.externalIds('node', String(node));

export const featureKey = (child, kind) =>
  kind === KIND.BATTERY ? KIND.BATTERY : `${child}-${kind}`;

const KIND_NAMES = Object.values(KIND).join('|');
const ID_RE = new RegExp(`:node:(\\d{1,3})(?::(?:(\\d{1,3})-(${KIND_NAMES})|(battery)))?$`);

const idNumber = (text, min, max) => {
  const value = Number(text);
  return String(value) === text && value >= min && value <= max ? value : undefined;
};

/**
 * `{ node, child?, kind? }` of one of our external ids (device or feature),
 * else undefined. Strict: the numbers in their ranges, written without a
 * leading zero, a known kind.
 */
export function parseExternalId(externalId, prefix) {
  if (typeof externalId !== 'string' || externalId.length > 200) return undefined;
  if (prefix !== undefined && !externalId.startsWith(prefix)) return undefined;
  const match = ID_RE.exec(externalId);
  if (!match) return undefined;
  const node = idNumber(match[1], NODE_MIN, NODE_MAX);
  if (node === undefined) return undefined;
  if (match[4]) return { node, child: NODE_CHILD, kind: KIND.BATTERY };
  if (match[2] === undefined) return { node };
  const child = idNumber(match[2], 0, NODE_CHILD - 1);
  if (child === undefined) return undefined;
  return { node, child, kind: match[3] };
}

// --- Devices -------------------------------------------------------------------

const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
];

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) return built;
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/**
 * The device of a node: `node` { id, sketch, version, protocol, children:
 * Map<child, { kinds: string[], description }>, battery: boolean }.
 */
export function buildNode(gladys, node, { language, created }) {
  const ids = nodeIds(gladys, node.id);
  const features = [];
  for (const child of [...node.children.keys()].sort((a, b) => a - b)) {
    const { kinds, description } = node.children.get(child);
    for (const kind of kinds) {
      features.push({
        name: kindName(kind, child, description, language),
        external_id: ids.feature(featureKey(child, kind)),
        ...KINDS[kind].feature,
      });
    }
  }
  if (node.battery) {
    features.push({
      name: kindName(KIND.BATTERY, NODE_CHILD, '', language),
      external_id: ids.feature(KIND.BATTERY),
      ...KINDS[KIND.BATTERY].feature,
    });
  }
  const params = [{ name: 'node_id', value: String(node.id) }];
  if (node.sketch) params.push({ name: 'sketch', value: node.sketch });
  if (node.version) params.push({ name: 'sketch_version', value: node.version });
  if (node.protocol) params.push({ name: 'mysensors_version', value: node.protocol });
  return keepCreatedFeatures(
    {
      name: nodeName(node.id, node.sketch, language),
      external_id: ids.device,
      model: node.sketch || 'MySensors',
      should_poll: false,
      features,
      params,
    },
    created,
  );
}

/** A text from a node (sketch name, child description): printable, trimmed, bounded. */
export function cleanText(payload) {
  if (typeof payload !== 'string') return '';

  return payload
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, LIMITS.name);
}

/** A command value, strictly: a finite number, or a text that is exactly one. */
export function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,3})?$/.test(value)) return Number(value);
  return undefined;
}

/**
 * What a command asks, checked on its own: `{ off: true }` (a relay or a
 * light turned off, a brightness of 0: the protective way, never held), or
 * `{ off: false, sub, payload }`. Undefined: not a value this feature takes.
 */
export function commandOf(kind, value) {
  const n = strictNumber(value);
  if (n === undefined || !Object.hasOwn(COMMAND_KINDS, kind)) return undefined;
  if (kind === KIND.BRIGHTNESS) {
    if (!Number.isInteger(n) || n < 0 || n > 100) return undefined;
    if (n === 0) return { off: true };
    return { off: false, sub: V.PERCENTAGE, payload: String(n) };
  }
  if (n === 0) return { off: true };
  if (n === 1) return { off: false, sub: V.STATUS, payload: '1' };
  return undefined;
}
