// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, never mojibake
// (UTF-8 bytes read as Latin-1 / Windows-1252 and saved again), and hold no
// control byte. No text calls anything "encrypted": the protocol of the
// MySensors protocol is plain.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ch = (...codes) => String.fromCharCode(...codes);
const MOJIBAKE = new RegExp(
  `[${ch(0xc2, 0xc3)}][${ch(0x80)}-${ch(0xbf)}${ch(0x2018)}-${ch(0x203a)}${ch(0x20ac, 0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc)}]|${ch(0xe2, 0x20ac)}`,
);
const DOCS = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
];
const SOURCES = [
  'index.js',
  'Dockerfile',
  'package.json',
  ...readdirSync(new URL('../src/', import.meta.url), { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => `src/${f.replaceAll('\\', '/')}`),
  ...readdirSync(new URL('../test/', import.meta.url), { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => `test/${f.replaceAll('\\', '/')}`),
];

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url));

for (const file of [...DOCS, ...SOURCES]) {
  test(`${file}: UTF-8 without BOM, no mojibake, no control byte`, () => {
    const bytes = read(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes(String.fromCharCode(0xfffd)), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
    // eslint-disable-next-line no-control-regex
    const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(text);
    assert.equal(control, null, `control byte at ${control?.index}`);
  });
}

test('the mojibake pattern catches what it should', () => {
  assert.match(`Fran${ch(0xc3, 0xa7)}ais`, MOJIBAKE);
  assert.match(ch(0xc2, 0xab), MOJIBAKE);
  assert.match(`l${ch(0xe2, 0x20ac, 0x2122)}app`, MOJIBAKE);
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
});

test('LICENSE names nobody', () => {
  const license = read('LICENSE').toString('utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = read('Dockerfile').toString('utf8');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  const notices = read('THIRD_PARTY_NOTICES.md').toString('utf8');
  assert.match(notices, /pymysensors/);
  assert.match(notices, /MIT License/);
});

test('no text calls anything encrypted', () => {
  for (const file of [...DOCS, 'src/i18n.js']) {
    const text = read(file).toString('utf8');
    assert.doesNotMatch(text, /\bchiffr|\bencrypt|\bcrypté|hachage/i, file);
  }
});
