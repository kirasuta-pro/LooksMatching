"use strict";
// Minimal uncompressed BMP (24/32 bpp) decoder + encoder. Premiere can export BMP stills,
// and BMP needs no zlib/JPEG decoder, so it works inside a bare UXP panel.
function decodeBMP(buf) {
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer);
  if (dv.getUint16(0, true) !== 0x4d42) throw new Error("Not a BMP file");
  const off = dv.getUint32(10, true);
  const w = dv.getInt32(18, true);
  let h = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const comp = dv.getUint32(30, true);
  if ((bpp !== 24 && bpp !== 32) || (comp !== 0 && comp !== 3)) throw new Error("Unsupported BMP (need uncompressed 24/32-bit)");
  const topDown = h < 0; if (topDown) h = -h;
  const bytes = bpp / 8, stride = Math.floor((bpp * w + 31) / 32) * 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const s = row + x * bytes, d = (y * w + x) * 4;
      data[d] = dv.getUint8(s + 2); data[d + 1] = dv.getUint8(s + 1); data[d + 2] = dv.getUint8(s); data[d + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
function encodeBMP(img) {
  const { width: w, height: h, data } = img, stride = Math.floor((24 * w + 31) / 32) * 4;
  const out = new Uint8Array(54 + stride * h), dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; dv.setUint32(2, out.length, true); dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = 54 + (h - 1 - y) * stride + x * 3;
    out[d] = data[s + 2]; out[d + 1] = data[s + 1]; out[d + 2] = data[s];
  }
  return out.buffer;
}
module.exports = { decodeBMP, encodeBMP };
