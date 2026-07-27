// Generates a 1024x1024 app icon: dark rounded square, emerald radar glyph.
import zlib from "node:zlib";
import fs from "node:fs";

const S = 1024;
const buf = Buffer.alloc(S * S * 4);

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return c ^ -1;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const cx = S / 2, cy = S / 2;
const corner = 225; // squircle-ish corner radius
const emerald = [52, 211, 153];
const bg = [16, 20, 24];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // rounded-rect mask
    const inX = Math.min(x, S - 1 - x);
    const inY = Math.min(y, S - 1 - y);
    let inside = true;
    if (inX < corner && inY < corner) {
      const dx = corner - inX, dy = corner - inY;
      inside = dx * dx + dy * dy <= corner * corner;
    }
    if (!inside) continue; // transparent corners
    buf[i] = bg[0]; buf[i + 1] = bg[1]; buf[i + 2] = bg[2]; buf[i + 3] = 255;

    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const px = (a) => {
      buf[i] = a[0]; buf[i + 1] = a[1]; buf[i + 2] = a[2]; buf[i + 3] = 255;
    };
    const fade = (dist, r, w) => Math.max(0, 1 - Math.abs(dist - r) / w);
    // three rings
    for (const r of [330, 240, 150]) {
      const f = fade(d, r, 10);
      if (f > 0) px([bg[0] + (emerald[0] - bg[0]) * f, bg[1] + (emerald[1] - bg[1]) * f, bg[2] + (emerald[2] - bg[2]) * f]);
    }
    // sweep beam (NE direction, soft angular falloff)
    const ang = Math.atan2(dy, dx);
    const target = -Math.PI / 4;
    let da = Math.abs(ang - target);
    if (da > Math.PI) da = 2 * Math.PI - da;
    if (d < 330 && d > 30 && da < 0.5) {
      const f = (1 - da / 0.5) * 0.9;
      px([bg[0] + (emerald[0] - bg[0]) * f, bg[1] + (emerald[1] - bg[1]) * f, bg[2] + (emerald[2] - bg[2]) * f]);
    }
    // center dot
    if (d < 42) px(emerald);
    // a "blip" on the outer ring
    const bx = cx + 240 * Math.cos(-2.2), by = cy + 240 * Math.sin(-2.2);
    if ((x - bx) ** 2 + (y - by) ** 2 < 34 ** 2) px(emerald);
  }
}

// PNG encode
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (1 + S * 4));
for (let y = 0; y < S; y++) {
  raw[y * (1 + S * 4)] = 0; // filter: none
  buf.copy(raw, y * (1 + S * 4) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync("icon-src.png", png);
console.log("icon-src.png written", png.length, "bytes");
