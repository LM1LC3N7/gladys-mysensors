// Generates cover.png (800x534) for gladys-mysensors: plain Node, no
// dependency. A home-made sensor network: a gateway in the middle, small
// nodes around it (a thermometer, a lamp, a door, a relay) linked by radio,
// and the local network towards Gladys, on a deep blue-green gradient (no
// brand logo). Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [18 + 24 * t, 70 + 50 * t, 96 + 60 * t]);
  }
}
const white = [255, 255, 255];
const dark = [22, 40, 70];
const green = [110, 220, 140];
const glass = [170, 210, 240];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// An arc of a ring, between two angles (radians, 0 = right, clockwise on screen).
const arc = (cx, cy, r, width, from, to, color) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      if (angle < from || angle > to) continue;
      const a = Math.max(
        0,
        Math.min(1, width / 2 - Math.abs(Math.hypot(x - cx, y - cy) - r) + 0.5),
      );
      if (a > 0) set(x, y, color, a);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

// Soft halo.
disc(400, 267, 250, white, 0.06);

// Radio links from the gateway to the nodes (dashed).
const nodes = [
  [150, 130],
  [650, 130],
  [150, 400],
  [650, 400],
];
for (const [x, y] of nodes) {
  const steps = 14;
  for (let k = 0; k < steps; k += 2) {
    const a = k / steps;
    const b = (k + 1) / steps;
    line(
      400 + (x - 400) * a,
      267 + (y - 267) * a,
      400 + (x - 400) * b,
      267 + (y - 267) * b,
      5,
      glass,
    );
  }
}

// The gateway: a board with its antenna and radio waves.
box(330, 215, 470, 320, 18, white);
box(348, 233, 452, 302, 8, dark);
for (let k = 0; k < 4; k += 1) disc(368 + k * 22, 268, 6, k === 0 ? green : glass);
line(450, 215, 470, 160, 7, white);
disc(470, 158, 8, white);
for (const r of [22, 40]) arc(470, 158, r, 7, -2.4, -0.75, white);

// The nodes: small boards, each with what it reads or drives.
for (const [x, y] of nodes) box(x - 62, y - 48, x + 62, y + 48, 16, white);
// Thermometer.
box(140, 100, 160, 150, 10, dark);
disc(150, 156, 15, dark);
disc(150, 156, 9, green);
box(146, 118, 154, 154, 4, green);
// Lamp.
disc(650, 118, 24, dark);
disc(650, 118, 15, [255, 214, 90]);
box(638, 140, 662, 160, 5, dark);
// Door, ajar.
box(122, 362, 178, 440, 4, dark);
box(130, 370, 170, 440, 2, glass);
line(130, 372, 160, 386, 6, dark);
// Relay: a switch.
box(610, 380, 690, 420, 20, dark);
disc(668, 400, 14, green);

// The local network towards Gladys (no cloud).
for (const r of [24, 44, 64]) arc(400, 470, r, 9, -2.4, -0.75, white);
disc(400, 470, 7, white);
line(400, 320, 400, 458, 6, white);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
