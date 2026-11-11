"use strict";
// Tiny dependency-free PNG encoder (stored/uncompressed deflate) + downscaler + base64.
// Lets the panel send frames to the Claude API (which accepts PNG/JPEG, not BMP) and save contact sheets.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function adler32(u8) { let a = 1, b = 0; for (let i = 0; i < u8.length; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
function encodePNG(img) {
  const { width: w, height: h, data } = img, stride = 1 + w * 3, raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = y * stride + 1 + x * 3; raw[d] = data[s]; raw[d + 1] = data[s + 1]; raw[d + 2] = data[s + 2]; }
  const nb = Math.ceil(raw.length / 65535), z = new Uint8Array(2 + raw.length + nb * 5 + 4); let o = 0;
  z[o++] = 0x78; z[o++] = 0x01;
  for (let i = 0; i < nb; i++) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535)), n = part.length;
    z[o++] = i === nb - 1 ? 1 : 0; z[o++] = n & 255; z[o++] = n >> 8; z[o++] = ~n & 255; z[o++] = (~n >> 8) & 255; z.set(part, o); o += n;
  }
  new DataView(z.buffer).setUint32(o, adler32(raw)); 
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function downscale(img, maxW) {
  if (img.width <= maxW) return img;
  const f = img.width / maxW, w = maxW, h = Math.max(1, Math.round(img.height / f)), d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * f), x1 = Math.max(x0 + 1, Math.floor((x + 1) * f)), y0 = Math.floor(y * f), y1 = Math.max(y0 + 1, Math.floor((y + 1) * f));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < img.width; xx++) { const i = (yy * img.width + xx) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
    const o = (y * w + x) * 4; d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n; d[o + 3] = 255;
  }
  return { width: w, height: h, data: d };
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(u8) {
  let s = ""; const n = u8.length;
  for (let i = 0; i < n; i += 3) {
    const a = u8[i], b = i + 1 < n ? u8[i + 1] : 0, c = i + 2 < n ? u8[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < n ? B64[c & 63] : "=");
  }
  return s;
}
function contactSheet(frames, cols = 3, cellW = 480) {
  const cells = frames.map((f) => downscale(f, cellW)), cellH = Math.max(...cells.map((c) => c.height)), rows = Math.ceil(cells.length / cols);
  const W = cols * cellW, H = rows * cellH, d = new Uint8ClampedArray(W * H * 4).fill(20);
  cells.forEach((c, k) => { const ox = (k % cols) * cellW, oy = Math.floor(k / cols) * cellH;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const s = (y * c.width + x) * 4, o = ((oy + y) * W + ox + x) * 4; d[o] = c.data[s]; d[o + 1] = c.data[s + 1]; d[o + 2] = c.data[s + 2]; d[o + 3] = 255; } });
  return { width: W, height: H, data: d };
}
module.exports = { encodePNG, downscale, toBase64, contactSheet };
