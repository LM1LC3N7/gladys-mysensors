// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password of
// the broker stays here and in the MQTT client only: never logged, never in
// /data, never in a status or an error.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, MQTT_PREFIX, NODE_CHILD, NODE_MAX, PORTS, TRANSPORTS } from './constants.js';

/**
 * Defaults, mirrored by the manifest (checked by test/manifest.test.js). The
 * password has none (a secret field never has a default): read on its own.
 */
export const DEFAULT_CONFIG = {
  transport: TRANSPORTS.TCP,
  gateway_address: '',
  mqtt_broker: '',
  mqtt_username: '',
  mqtt_publish_prefix: MQTT_PREFIX.out,
  mqtt_subscribe_prefix: MQTT_PREFIX.in,
  safe_actuators: '',
  assign_node_ids: true,
  language: 'fr',
};

/** Only `false` (or the text "false") turns off: a missing value keeps the default. */
const strictFalse = (value) => value === false || value === 'false';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** An IPv4 address a gateway or a broker may have: unicast, never 0.0.0.0, broadcast nor multicast. */
function unicastIPv4(host) {
  const parts = host.split('.').map(Number);
  if (parts[0] === 0 || parts[0] >= 224) return false;
  return !parts.every((p) => p === 255);
}

/**
 * `host[:port]` (an IPv4 address or a host name; "mqtt://" or "tcp://"
 * accepted in front of a broker): `{ host, port }` or `{ error }`.
 */
export function parseAddress(raw, defaultPort, { schemes = [] } = {}) {
  let text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === '') return { error: 'empty' };
  if (text.length > 300 || CONTROL.test(text)) return { error: 'invalid' };
  const scheme = /^([a-z]+):\/\//.exec(text);
  if (scheme) {
    if (!schemes.includes(scheme[1])) return { error: 'scheme' };
    text = text.slice(scheme[0].length);
  }
  if (text.endsWith('/')) text = text.slice(0, -1);
  if (text.includes('@')) return { error: 'credentials' };
  const match = /^([^:/]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) return { error: 'invalid' };
  const host = match[1];
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  if (!(port >= 1 && port <= 65535) || (match[2] !== undefined && String(port) !== match[2])) {
    return { error: 'invalid' };
  }
  if (isIP(host) === 4) {
    if (!unicastIPv4(host)) return { error: 'invalid' };
  } else if (!HOSTNAME.test(host) || /^\d+(\.\d+)*$/.test(host)) {
    return { error: 'invalid' };
  }
  return { host, port };
}

/** A topic prefix: letters, digits, `_-.` and `/` between levels; never a wildcard. */
export function parsePrefix(raw, fallback) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { prefix: fallback };
  if (
    text.length > 64 ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(text) ||
    text.split('/').some((level) => level === '.' || level === '..')
  ) {
    return { error: 'prefix' };
  }
  return { prefix: text };
}

/**
 * "Relays and dimmers declared safe": `<node>:<child>` entries (node 0-254,
 * child 0-254) separated by commas, semicolons, spaces or new lines.
 * Anything else is ignored and listed in `invalid` (shown in the status).
 */
export function parseSafe(raw) {
  const safe = new Set();
  const invalid = [];
  const text = typeof raw === 'string' ? raw.slice(0, 20_000) : '';
  for (const entry of text.split(/[\s,;]+/)) {
    if (entry === '') continue;
    const match = /^(0|[1-9]\d{0,2}):(0|[1-9]\d{0,2})$/.exec(entry);
    const node = match ? Number(match[1]) : NaN;
    const child = match ? Number(match[2]) : NaN;
    if (!match || node > NODE_MAX || child >= NODE_CHILD || safe.size >= LIMITS.safeEntries) {
      if (invalid.length < 10) invalid.push(entry.replace(/[^\x20-\x7e]/g, '?').slice(0, 20));
      continue;
    }
    safe.add(`${node}:${child}`);
  }
  return { safe, invalid };
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value !== null && value !== undefined) c[key] = value;
  }
  const transport = c.transport === TRANSPORTS.MQTT ? TRANSPORTS.MQTT : TRANSPORTS.TCP;
  const safe = parseSafe(c.safe_actuators);
  const config = {
    transport,
    /** Why the configuration cannot be used (shown in the status), else undefined. */
    problem: undefined,
    host: undefined,
    port: undefined,
    username: '',
    password: '',
    inPrefix: MQTT_PREFIX.out,
    outPrefix: MQTT_PREFIX.in,
    safe: safe.safe,
    invalidSafe: safe.invalid,
    assignIds: !strictFalse(c.assign_node_ids),
    language: c.language === 'en' ? 'en' : 'fr',
  };
  if (transport === TRANSPORTS.TCP) {
    const address = parseAddress(c.gateway_address, PORTS.tcp);
    if (address.error) config.problem = `gateway:${address.error}`;
    else Object.assign(config, address);
    return config;
  }
  const broker = parseAddress(c.mqtt_broker, PORTS.mqtt, { schemes: ['mqtt', 'tcp'] });
  const username = typeof c.mqtt_username === 'string' ? c.mqtt_username.trim() : '';
  const password =
    raw && Object.hasOwn(raw, 'mqtt_password') && typeof raw.mqtt_password === 'string'
      ? raw.mqtt_password
      : '';
  const inPrefix = parsePrefix(c.mqtt_publish_prefix, MQTT_PREFIX.out);
  const outPrefix = parsePrefix(c.mqtt_subscribe_prefix, MQTT_PREFIX.in);
  if (broker.error) config.problem = `broker:${broker.error}`;
  else if (username.length > 256 || CONTROL.test(username)) config.problem = 'username';
  else if (password.length > 256 || CONTROL.test(password)) config.problem = 'password';
  else if (password !== '' && username === '') config.problem = 'password-alone';
  else if (inPrefix.error || outPrefix.error) config.problem = 'prefix';
  else if (inPrefix.prefix === outPrefix.prefix) config.problem = 'same-prefix';
  if (config.problem) return config;
  return {
    ...config,
    host: broker.host,
    port: broker.port,
    username,
    password,
    inPrefix: inPrefix.prefix,
    outPrefix: outPrefix.prefix,
  };
}

/** What a new session depends on (compared in memory only, never stored: it holds the password). */
export const sessionKey = (config) =>
  JSON.stringify([
    config.problem ?? null,
    config.transport,
    config.host ?? null,
    config.port ?? null,
    config.username,
    config.password,
    config.inPrefix,
    config.outPrefix,
  ]);

/** The route kept in /data for the stops of a restart (never a credential). */
export function routeOf(config) {
  if (!config || config.problem || !config.host) return undefined;
  if (config.transport === TRANSPORTS.MQTT && (config.username || config.password)) {
    return undefined;
  }
  return {
    transport: config.transport,
    host: config.host,
    port: config.port,
    ...(config.transport === TRANSPORTS.MQTT
      ? { inPrefix: config.inPrefix, outPrefix: config.outPrefix }
      : {}),
  };
}
