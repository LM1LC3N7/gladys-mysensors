// -----------------------------------------------------------------------------
// Constants: the MySensors serial protocol 2.x (the lines a gateway exchanges
// with its controller, the same over TCP and MQTT), the feature kinds, the
// manifest keys, the limits and the timings.
//
// Numbers from the published "MySensors Serial Protocol (2.x)" and from
// pymysensors 0.26.0 (MIT, mysensors/const_20.py to const_22.py).
// -----------------------------------------------------------------------------

/** Message types (third field). */
export const TYPE = { PRESENTATION: 0, SET: 1, REQ: 2, INTERNAL: 3, STREAM: 4 };

/** The node id of the gateway, the broadcast/unassigned id, the "node itself" child id. */
export const GATEWAY_NODE = 0;
export const BROADCAST = 255;
export const NODE_CHILD = 255;
/** Sensor nodes 1-254; the gateway (0) may carry sensors too. */
export const NODE_MIN = 0;
export const NODE_MAX = 254;
/** Ids handed out to nodes that ask for one (never 0, the gateway). */
export const ASSIGN_MIN = 1;

/** Presentation sub-types (S_*) used here. */
export const S = {
  DOOR: 0,
  MOTION: 1,
  SMOKE: 2,
  BINARY: 3,
  DIMMER: 4,
  COVER: 5,
  TEMP: 6,
  HUM: 7,
  BARO: 8,
  UV: 11,
  POWER: 13,
  HEATER: 14,
  DISTANCE: 15,
  LIGHT_LEVEL: 16,
  ARDUINO_NODE: 17,
  ARDUINO_REPEATER_NODE: 18,
  MULTIMETER: 30,
  SPRINKLER: 31,
  WATER_LEAK: 32,
  VIBRATION: 34,
  MOISTURE: 35,
  WATER_QUALITY: 39,
};

/** Value sub-types (V_*) used here. */
export const V = {
  TEMP: 0,
  HUM: 1,
  STATUS: 2,
  PERCENTAGE: 3,
  PRESSURE: 4,
  UV: 11,
  DISTANCE: 13,
  TRIPPED: 16,
  WATT: 17,
  LEVEL: 37,
  VOLTAGE: 38,
  CURRENT: 39,
  PH: 51,
  ORP: 52,
};

/** Internal sub-types (I_*) used here. */
export const I = {
  BATTERY_LEVEL: 0,
  TIME: 1,
  VERSION: 2,
  ID_REQUEST: 3,
  ID_RESPONSE: 4,
  CONFIG: 6,
  LOG_MESSAGE: 9,
  SKETCH_NAME: 11,
  SKETCH_VERSION: 12,
  GATEWAY_READY: 14,
  HEARTBEAT_RESPONSE: 22,
  PRESENTATION: 19,
  DISCOVER: 20,
  DISCOVER_RESPONSE: 21,
};

/**
 * Feature kinds: the last part of the feature external ids
 * (`<device>:<child>-<kind>`, or `<device>:battery`). Frozen: never rename.
 */
export const KIND = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  PRESSURE: 'pressure',
  DOOR: 'door',
  MOTION: 'motion',
  SMOKE: 'smoke',
  LEAK: 'leak',
  VIBRATION: 'vibration',
  /** A relay declared safe: `switch/binary`, commanded. */
  RELAY: 'relay',
  /** A relay (or any on/off output) not declared safe: read only. */
  STATE: 'state',
  /** A dimmer declared safe: `light/binary` + `light/brightness`. */
  LIGHT: 'light',
  BRIGHTNESS: 'brightness',
  /** A dimmer not declared safe: read only. */
  LEVEL: 'level',
  POWER: 'power',
  VOLTAGE: 'voltage',
  CURRENT: 'current',
  LUX: 'lux',
  MOISTURE: 'moisture',
  UV: 'uv',
  DISTANCE: 'distance',
  PH: 'ph',
  ORP: 'orp',
  BATTERY: 'battery',
};

/** Manifest `actions` keys: frozen. */
export const ACTIONS = { TEST: 'test_connection' };

export const TRANSPORTS = { TCP: 'tcp', MQTT: 'mqtt' };

/** Default ports: the Ethernet gateway (MY_PORT) and MQTT. */
export const PORTS = { tcp: 5003, mqtt: 1883 };

/** Default topic prefixes of the MySensors MQTT gateway. */
export const MQTT_PREFIX = { out: 'mygateway1-out', in: 'mygateway1-in' };

export const LIMITS = {
  /**
   * One line of the serial protocol: 5 numbers, a payload of 25 bytes at
   * most (MAX_PAYLOAD, 50 in hex), a debug log line of the gateway (120
   * characters, MY_SERIAL_OUTPUT_SIZE). Longer is dropped unread.
   */
  lineBytes: 256,
  /** The payload kept from a message (a hex payload of 25 bytes is 50). */
  payloadBytes: 64,
  /** An MQTT topic of a MySensors message: the prefix and five numbers. */
  topicBytes: 160,
  /** The largest MQTT packet accepted from the broker (cut BEFORE it is read). */
  packetBytes: 4096,
  /** Lines handled per second; the others are dropped (a flood never starves Gladys). */
  linesPerSecond: 200,
  /** Children kept per node, nodes known, features of one device. */
  childrenPerNode: 64,
  nodes: 254,
  /** Entries of "Relays and dimmers declared safe". */
  safeEntries: 200,
  /** Stops (offs) kept until the node confirms them. */
  stops: 200,
  /** Ids handed out and not used by a node yet. */
  unseenIds: 10,
  /** Gladys accepts 300 states per minute: a margin is kept. */
  statesPerMinute: 250,
  /** Echo waiters of commands in flight. */
  waiters: 100,
  /** Characters of a sketch name or a child description kept. */
  name: 40,
  /** The core's MAX_DISCOVERED_DEVICES. */
  devices: 2000,
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** TCP: the connection must open within this. */
  connectTimeout: 5 * SECOND,
  /** Waits between two connection attempts after a failure or a dead session. */
  reconnect: [SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE],
  /** A session that lived this long resets the waits. */
  stableSession: MINUTE,
  /** The version of the gateway asked this often (its answer proves it alive). */
  keepalive: MINUTE,
  /** TCP: nothing received for this long closes the session. */
  silence: 150 * SECOND,
  /** The echo of a command awaited this long (Gladys gives up at 5 s). */
  echo: 3500,
  /** A stop not echoed is sent again within the click, after this. */
  stopRetryInClick: 1500,
  /** Then sent again after these waits (3 resends), each from the previous send. */
  stopResends: [5 * SECOND, 20 * SECOND, MINUTE],
  /** getConfig() tried again after these waits, then every minute, for life. */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE],
  /** /data: a read or a write waits this long at most. */
  storeLoad: 2 * SECOND,
  storeSave: 2 * SECOND,
  storeQueue: 2 * SECOND,
  /** /data unreadable at start: read again this often, one read at a time. */
  storeRetry: 10 * SECOND,
  /** MQTT: refused credentials, next tries after these waits. */
  authRetry: [15 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR],
  /** A handed-out id that no node used is given again after this. */
  idReuse: 5 * MINUTE,
  /** The test button waits this long for the gateway. */
  test: 10 * SECOND,
  /** A Scan asks the nodes to present themselves at most this often. */
  scan: MINUTE,
  /** States are sent to Gladys this often, within the budget. */
  flush: SECOND,
  /** A measurement of the same feature is sent at most this often. */
  measurementSpacing: 5 * SECOND,
  /** publishChangedStates re-sends an unchanged value once that old. */
  stateHeartbeat: 30 * MINUTE,
  /** A value is published as it comes, never later than this (a late flush drops it). */
  stateFresh: 2 * MINUTE,
};
