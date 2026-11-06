// -----------------------------------------------------------------------------
// Pure parts: the serial protocol, the configuration, the model, /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { encodeLine, encodeTopic, numberOf, parseLine, parseTopic } from '../src/protocol.js';
import { LineReader } from '../src/tcp.js';
import { normalizeConfig, parseAddress, parsePrefix, parseSafe, routeOf } from '../src/config.js';
import { KINDS, buildNode, commandOf, kindsOfPresentation, parseExternalId } from '../src/model.js';
import { credentialsMark, fileStore, normalizeMemory, serializeMemory } from '../src/store.js';

test('lines: strict fields, payload up to the end, CR tolerated', () => {
  assert.deepEqual(parseLine('12;1;1;0;2;1'), {
    node: 12,
    child: 1,
    type: 1,
    ack: 0,
    sub: 2,
    payload: '1',
  });
  assert.deepEqual(parseLine('0;255;3;0;9;a;b;c\r').payload, 'a;b;c');
  for (const bad of [
    '12;1;1;0;2',
    '012;1;1;0;2;1',
    '12;1;5;0;2;1',
    '12;1;1;2;2;1',
    '256;1;1;0;2;1',
    '-1;1;1;0;2;1',
    ' 12;1;1;0;2;1',
    '12;1;1;0;2;\u0001',
    '12;1;1;0;2;é',
    `12;1;1;0;2;${'x'.repeat(300)}`,
    `12;1;1;0;2;${'x'.repeat(201)}`,
  ]) {
    assert.equal(parseLine(bad), undefined, bad);
  }
  assert.equal(
    encodeLine({ node: 12, child: 1, type: 1, ack: 1, sub: 2, payload: '1' }),
    '12;1;1;1;2;1\n',
  );
  assert.throws(() => encodeLine({ node: 12, child: 1, type: 1, ack: 1, sub: 2, payload: '1\n' }));
  assert.throws(() => encodeLine({ node: 256, child: 1, type: 1, ack: 1, sub: 2, payload: '1' }));
  assert.throws(() => encodeLine({ node: 1, child: 1, type: 1, ack: 1, sub: 2, payload: 'a;b' }));
});

test('topics: under the prefix only, five numbers', () => {
  assert.deepEqual(parseTopic('gw-out', 'gw-out/20/0/1/0/0', '21.5'), {
    node: 20,
    child: 0,
    type: 1,
    ack: 0,
    sub: 0,
    payload: '21.5',
  });
  assert.equal(parseTopic('gw-out', 'gw-out2/20/0/1/0/0', '1'), undefined);
  assert.equal(parseTopic('gw-out', 'gw-out/20/0/1/0', '1'), undefined);
  assert.equal(parseTopic('gw-out', 'gw-out/20/0/1/0/0/9', '1'), undefined);
  assert.deepEqual(
    encodeTopic('gw-in', { node: 12, child: 1, type: 1, ack: 1, sub: 2, payload: '1' }),
    {
      topic: 'gw-in/12/1/1/1/2',
      payload: '1',
    },
  );
});

test('numbers: strict, empty is unknown, never 0', () => {
  assert.equal(numberOf('21.5'), 21.5);
  assert.equal(numberOf('-3'), -3);
  for (const bad of ['', ' ', '1e3', '0x1', 'NaN', 'Infinity', '1.', '.5', '+1', '21,5']) {
    assert.equal(numberOf(bad), undefined, bad);
  }
});

test('LineReader: a line too long is skipped up to its end, across chunks', () => {
  const reader = new LineReader(10);
  assert.deepEqual(reader.push(Buffer.from('abc\n0123456')), ['abc']);
  assert.deepEqual(reader.push(Buffer.from('789AB')), []);
  assert.equal(reader.size, 0);
  assert.deepEqual(reader.push(Buffer.from('CD\nok\n')), ['ok']);
  assert.equal(reader.dropped, 1);
});

test('addresses: unicast IPv4 or host name, port; never broadcast, multicast, 0.0.0.0', () => {
  assert.deepEqual(parseAddress('192.168.1.50', 5003), { host: '192.168.1.50', port: 5003 });
  assert.deepEqual(parseAddress(' GW.local:5004 ', 5003), { host: 'gw.local', port: 5004 });
  assert.deepEqual(parseAddress('mqtt://broker:1884', 1883, { schemes: ['mqtt'] }), {
    host: 'broker',
    port: 1884,
  });
  for (const bad of [
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '239.1.2.3',
    'a b',
    'host:0',
    'host:65536',
    'host:01',
    'user@host',
    'http://x',
    '1.2.3',
    'host:5003/x',
    'g\rw',
  ]) {
    assert.ok(parseAddress(bad, 5003).error, bad);
  }
});

test('prefixes: no wildcard, no empty or dot level', () => {
  assert.deepEqual(parsePrefix('home/ms-out', 'x'), { prefix: 'home/ms-out' });
  assert.deepEqual(parsePrefix('', 'x'), { prefix: 'x' });
  for (const bad of ['a/+', 'a/#', '/a', 'a/', 'a//b', 'a/../b', 'a b']) {
    assert.ok(parsePrefix(bad, 'x').error, bad);
  }
});

test('safe list: node:child in range, bounded, invalid entries reported', () => {
  const { safe, invalid } = parseSafe('12:1, 13:1;254:254 0:3\n255:1 12:255 a:1 012:1 12:1');
  assert.deepEqual([...safe], ['12:1', '13:1', '254:254', '0:3']);
  assert.deepEqual(invalid, ['255:1', '12:255', 'a:1', '012:1']);
  const many = Array.from({ length: 250 }, (_, i) => `${Math.floor(i / 200)}:${i % 200}`).join(' ');
  assert.equal(parseSafe(many).safe.size, 200);
});

test('configuration: a password without user refused; same prefixes refused; route without credentials only', () => {
  assert.equal(
    normalizeConfig({ transport: 'mqtt', mqtt_broker: 'b', mqtt_password: 'x' }).problem,
    'password-alone',
  );
  assert.equal(
    normalizeConfig({
      transport: 'mqtt',
      mqtt_broker: 'b',
      mqtt_publish_prefix: 'a',
      mqtt_subscribe_prefix: 'a',
    }).problem,
    'same-prefix',
  );
  assert.equal(
    normalizeConfig({
      transport: 'mqtt',
      mqtt_broker: 'b',
      mqtt_username: 'u',
      mqtt_password: 'p\n',
    }).problem,
    'password',
  );
  assert.equal(normalizeConfig({}).problem, 'gateway:empty');
  const tcp = normalizeConfig({ gateway_address: '10.0.0.5' });
  assert.deepEqual(routeOf(tcp), { transport: 'tcp', host: '10.0.0.5', port: 5003 });
  assert.equal(
    routeOf(normalizeConfig({ transport: 'mqtt', mqtt_broker: 'b', mqtt_username: 'u' })),
    undefined,
  );
  assert.equal(normalizeConfig({ assign_node_ids: 'nope' }).assignIds, true);
  assert.equal(normalizeConfig({ assign_node_ids: false }).assignIds, false);
});

test('kinds: a relay or a dimmer is commanded only when declared; a heater never', () => {
  assert.deepEqual(kindsOfPresentation(3, false), ['state']);
  assert.deepEqual(kindsOfPresentation(3, true), ['relay']);
  assert.deepEqual(kindsOfPresentation(4, true), ['light', 'brightness']);
  assert.deepEqual(kindsOfPresentation(14, true), ['state']);
  assert.deepEqual(kindsOfPresentation(31, true), ['state']);
  assert.deepEqual(kindsOfPresentation(5, true), []);
  for (const [kind, def] of Object.entries(KINDS)) {
    if (def.feature.category === 'switch' || def.feature.category === 'light') {
      assert.ok(['relay', 'light', 'brightness'].includes(kind), kind);
    }
  }
});

test('door: MySensors tripped 1 (open) is Gladys 0; values out of range are not values', () => {
  assert.equal(KINDS.door.read('1'), 0);
  assert.equal(KINDS.door.read('0'), 1);
  assert.equal(KINDS.door.read('2'), undefined);
  assert.equal(KINDS.temperature.read('126'), undefined);
  assert.equal(KINDS.humidity.read('-1'), undefined);
  assert.equal(KINDS.battery.read('101'), undefined);
  assert.equal(KINDS.battery.read('99.5'), undefined);
  assert.equal(KINDS.power.read('-250.5'), -250.5);
});

test('commands: off is protective; on and brightness strict', () => {
  assert.deepEqual(commandOf('relay', 0), { off: true });
  assert.deepEqual(commandOf('relay', '1'), { off: false, sub: 2, payload: '1' });
  assert.deepEqual(commandOf('brightness', 0), { off: true });
  assert.deepEqual(commandOf('brightness', 55), { off: false, sub: 3, payload: '55' });
  for (const bad of [2, -1, 0.5, '', ' 1', null, undefined, NaN, Infinity]) {
    assert.equal(commandOf('relay', bad), undefined, String(bad));
  }
  assert.equal(commandOf('brightness', 100.5), undefined);
  assert.equal(commandOf('state', 0), undefined);
});

test('external ids: strict numbers and known kinds', () => {
  assert.deepEqual(parseExternalId('ext:mysensors:node:12:1-relay'), {
    node: 12,
    child: 1,
    kind: 'relay',
  });
  assert.deepEqual(parseExternalId('ext:mysensors:node:12:battery'), {
    node: 12,
    child: 255,
    kind: 'battery',
  });
  assert.deepEqual(parseExternalId('ext:mysensors:node:0'), { node: 0 });
  for (const bad of [
    'ext:mysensors:node:255',
    'ext:mysensors:node:12:255-relay',
    'ext:mysensors:node:12:1-pump',
    'ext:mysensors:node:012:1-relay',
    'x'.repeat(300),
  ]) {
    assert.equal(parseExternalId(bad), undefined, bad);
  }
  assert.equal(parseExternalId('ext:other:node:12:1-relay', 'ext:mysensors:node:'), undefined);
});

test('every published feature follows the rules of the core (no option, finite min <= max, unit of its category)', async () => {
  const constants = await import('@gladysassistant/integration-sdk');
  const units = constants.DEVICE_FEATURE_UNITS_BY_CATEGORY;
  const gladys = createFakeGladys({ selector: 'mysensors' });
  const children = new Map(
    Object.keys(KINDS)
      .filter((k) => k !== 'battery')
      .map((kind, i) => [i, { kinds: [kind], description: 'Desc' }]),
  );
  const device = buildNode(
    gladys,
    { id: 7, sketch: 'All', version: '1', protocol: '2.3.2', children, battery: true },
    { language: 'fr' },
  );
  for (const f of device.features) {
    assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max) && f.min <= f.max, f.external_id);
    assert.equal(f.supported_options, undefined, f.external_id);
    if (f.unit !== undefined && units?.[f.category])
      assert.ok(units[f.category].includes(f.unit), `${f.category} ${f.unit}`);
    assert.equal(typeof f.name, 'string');
    assert.ok(f.name.trim() === f.name && f.name.length > 0);
  }
  assert.equal(new Set(device.features.map((f) => f.external_id)).size, device.features.length);
});

test('/data: repaired on read, nothing inherited, dates bounded, counts unreadable = 0', () => {
  const now = 1_800_000_000_000;
  const raw = JSON.parse(
    '{"__proto__":{"x":1},"route":{"transport":"tcp","host":"0.0.0.0","port":5003},' +
      '"stops":[{"node":12,"child":1,"sends":"x"},{"node":12,"child":1,"sends":2},{"node":300,"child":1},{"node":5,"child":255}],' +
      '"ids":[{"id":3,"at":9e15,"seen":true},{"id":0,"at":1},{"id":3,"at":1}],' +
      '"auth":{"failures":2,"until":9e15,"mark":70,"salt":"zz"}}',
  );
  const m = normalizeMemory(raw, now);
  assert.equal(m.route, undefined);
  assert.deepEqual(m.stops, [{ node: 12, child: 1, sends: 0 }]);
  assert.deepEqual(m.ids, [{ id: 3, at: now, seen: true }]);
  assert.equal(m.auth.failures, 2);
  assert.equal(m.auth.until, now + 24 * 3600_000);
  assert.equal(m.auth.mark, undefined);
  assert.equal(m.auth.salt, undefined);
  assert.equal({}.x, undefined);
  assert.deepEqual(normalizeMemory(serializeMemory(m), now), m);
});

test('the mark of the credentials: 6 bits, salted', () => {
  const marks = new Set();
  for (let i = 0; i < 2000; i += 1) marks.add(credentialsMark('0'.repeat(32), 'u', `p${i}`));
  assert.equal(marks.size, 64);
  assert.notEqual(credentialsMark('a'.repeat(32), 'u', 'p'), undefined);
});

test('fileStore: round trip 0600; a FIFO or an oversized file refused, never read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mysensors-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ a: 1 });
  assert.deepEqual(await store.load(), { a: 1 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, 'x'.repeat(70_000));
  await assert.rejects(store.load(), /too large/);
  const fifo = join(dir, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(fileStore(fifo).load(), /not a plain file/);
});
