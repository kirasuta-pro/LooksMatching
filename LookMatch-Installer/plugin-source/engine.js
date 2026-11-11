"use strict";
/*
 * Look Match engine — pure JS, runs inside UXP or Node.
 *
 * Two layers:
 *  1) COLOR/TONE  -> baked into a 33^3 .cube LUT (OKLab histogram-matched tone curve
 *                    + per-luminance-zone chroma transfer). Captures contrast, black lift,
 *                    highlight rolloff/clip level, tint by zone, saturation by zone.
 *  2) SENSOR TEXTURE -> things a LUT cannot hold: grain amount per zone, grain size,
 *                    chroma-noise share, edge softness/sharpness. Returned as numbers.
 */
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------- OKLab ----------
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c) => { c = Math.max(0, c); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
function rgb2lab(r, g, b) {
  r = s2l(r); g = s2l(g); b = s2l(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function lab2rgb(L, a, b) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          l2s(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

// ---------- sampling ----------
function samplePixels(img, target = 60000) {
  const { width: w, height: h, data } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / target)));
  const L = [], A = [], B = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4;
    const v = rgb2lab(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    L.push(v[0]); A.push(v[1]); B.push(v[2]);
  }
  return { L: Float32Array.from(L), A: Float32Array.from(A), B: Float32Array.from(B) };
}

// ---------- tone curve (histogram match on OKLab L) ----------
const NB = 512;
function cdf(Ls) {
  const h = new Float64Array(NB);
  for (let i = 0; i < Ls.length; i++) h[clamp(Math.floor(Ls[i] * NB), 0, NB - 1)]++;
  let s = 0; const c = new Float64Array(NB);
  for (let i = 0; i < NB; i++) { s += h[i]; c[i] = s / Ls.length; }
  return c;
}
function buildToneCurve(tL, rL) {
  const ct = cdf(tL), cr = cdf(rL), map = new Float64Array(NB);
  let j = 0;
  for (let i = 0; i < NB; i++) { while (j < NB - 1 && cr[j] < ct[i]) j++; map[i] = (j + 0.5) / NB; }
  const sm = new Float64Array(NB), R = 6;
  for (let i = 0; i < NB; i++) { let s = 0, n = 0; for (let k = -R; k <= R; k++) { s += map[clamp(i + k, 0, NB - 1)]; n++; } sm[i] = s / n; }
  for (let i = 1; i < NB; i++) if (sm[i] < sm[i - 1]) sm[i] = sm[i - 1];
  return sm;
}
function applyCurve(map, L) {
  const f = clamp(L * NB - 0.5, 0, NB - 1), i = Math.floor(f), t = f - i;
  return map[i] + (map[Math.min(NB - 1, i + 1)] - map[i]) * t;
}

// ---------- luminance-zone color stats ----------
const K = 9;
const kpos = (L) => clamp(L * K - 0.5, 0, K - 1 - 1e-9);
function fillInvalid(arr, valid, def) {
  const idx = []; for (let i = 0; i < K; i++) if (valid[i]) idx.push(i);
  if (!idx.length) return arr.fill(def);
  for (let i = 0; i < K; i++) {
    if (valid[i]) continue;
    let lo = -1, hi = -1; for (const j of idx) { if (j < i) lo = j; if (j > i && hi < 0) hi = j; }
    arr[i] = lo < 0 ? arr[hi] : hi < 0 ? arr[lo] : arr[lo] + ((arr[hi] - arr[lo]) * (i - lo)) / (hi - lo);
  }
  return arr;
}
function smooth121(a) { const o = Float64Array.from(a); for (let i = 0; i < K; i++) o[i] = (a[Math.max(0, i - 1)] + 2 * a[i] + a[Math.min(K - 1, i + 1)]) / 4; return o; }
function zoneStats(L, A, B) {
  const w = new Float64Array(K), sa = new Float64Array(K), sb = new Float64Array(K), saa = new Float64Array(K), sbb = new Float64Array(K);
  for (let n = 0; n < L.length; n++) {
    const f = kpos(L[n]), k = Math.floor(f), t = f - k;
    for (let q = 0; q < 2; q++) {
      const wt = q ? t : 1 - t, i = k + q;
      w[i] += wt; sa[i] += wt * A[n]; sb[i] += wt * B[n]; saa[i] += wt * A[n] * A[n]; sbb[i] += wt * B[n] * B[n];
    }
  }
  const valid = [], ma = new Float64Array(K), mb = new Float64Array(K), sd = new Float64Array(K);
  for (let i = 0; i < K; i++) {
    valid[i] = w[i] > L.length * 0.004;
    if (valid[i]) { ma[i] = sa[i] / w[i]; mb[i] = sb[i] / w[i]; sd[i] = Math.sqrt(Math.max(0, saa[i] / w[i] - ma[i] ** 2) + Math.max(0, sbb[i] / w[i] - mb[i] ** 2)); }
  }
  fillInvalid(ma, valid, 0); fillInvalid(mb, valid, 0); fillInvalid(sd, valid, 0.02);
  return { ma: smooth121(ma), mb: smooth121(mb), sd: smooth121(sd) };
}
function itp(t, L) { const f = kpos(L), k = Math.floor(f), u = f - k; return t[k] + (t[k + 1] - t[k]) * u; }

// ---------- build a grading context from reference + target ----------
const arr = (x) => (Array.isArray(x) ? x : [x]);
function poolSamples(imgs) {
  imgs = arr(imgs); const parts = imgs.map((im) => samplePixels(im, Math.ceil(60000 / imgs.length)));
  const cat = (k) => { const o = new Float32Array(parts.reduce((n, p) => n + p[k].length, 0)); let off = 0; for (const p of parts) { o.set(p[k], off); off += p[k].length; } return o; };
  return { L: cat("L"), A: cat("A"), B: cat("B") };
}
function fitLook(refImg, tgtImg) {
  const R = poolSamples(refImg), T = poolSamples(tgtImg);
  const curve = buildToneCurve(T.L, R.L);
  const T2 = Float32Array.from(T.L, (v) => applyCurve(curve, v));
  const rs = zoneStats(R.L, R.A, R.B), ts = zoneStats(T2, T.A, T.B);
  const scale = new Float64Array(K);
  for (let i = 0; i < K; i++) scale[i] = ts.sd[i] < 0.003 ? 1 : clamp(rs.sd[i] / ts.sd[i], 0.5, 2.0);
  return { curve, rMa: rs.ma, rMb: rs.mb, tMa: ts.ma, tMb: ts.mb, scale: smooth121(scale) };
}
function gradeRGB(ctx, r, g, b) {
  const [L, a, bb] = rgb2lab(r, g, b), L2 = applyCurve(ctx.curve, L);
  const s = itp(ctx.scale, L2);
  let a2 = (a - itp(ctx.tMa, L2)) * s + itp(ctx.rMa, L2);
  let b2 = (bb - itp(ctx.tMb, L2)) * s + itp(ctx.rMb, L2);
  let L3 = L2;
  const p = ctx.post;
  if (p) {
    L3 = clamp(Math.pow(clamp(L2, 0, 1), 1 / p.gamma) * p.gain, 0, 1);
    const sh = (1 - L3) * (1 - L3), hi = L3 * L3;
    a2 = a2 * p.chroma + p.a + sh * p.shadowTint[0] + hi * p.highlightTint[0];
    b2 = b2 * p.chroma + p.b + sh * p.shadowTint[1] + hi * p.highlightTint[1];
  }
  return lab2rgb(L3, a2, b2);
}
// Refinement knobs (what Claude may tune). Ranges are enforced here, not trusted from the model.
function sanitizePost(p) {
  p = p || {};
  const n = (v, lo, hi, d) => (typeof v === "number" && isFinite(v) ? clamp(v, lo, hi) : d);
  const t = (v) => [n(v && v[0], -0.04, 0.04, 0), n(v && v[1], -0.04, 0.04, 0)];
  return { gamma: n(p.gamma, 0.7, 1.4, 1), gain: n(p.gain, 0.85, 1.15, 1), chroma: n(p.chroma, 0.5, 1.6, 1),
           a: n(p.a, -0.03, 0.03, 0), b: n(p.b, -0.03, 0.03, 0), shadowTint: t(p.shadowTint), highlightTint: t(p.highlightTint) };
}
function gradeValue(ctx, r, g, b, strength) {
  const o = gradeRGB(ctx, r, g, b);
  return [clamp(r + (o[0] - r) * strength, 0, 1), clamp(g + (o[1] - g) * strength, 0, 1), clamp(b + (o[2] - b) * strength, 0, 1)];
}
function buildCube(ctx, { size = 33, strength = 1, title = "LookMatch" } = {}) {
  const out = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"], d = size - 1;
  for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
    const v = gradeValue(ctx, ri / d, gi / d, bi / d, strength);
    out.push(v[0].toFixed(6) + " " + v[1].toFixed(6) + " " + v[2].toFixed(6));
  }
  return out.join("\n") + "\n";
}
function applyToImage(ctx, img, strength = 1) {
  const o = new Uint8ClampedArray(img.data);
  for (let i = 0; i < o.length; i += 4) {
    const v = gradeValue(ctx, o[i] / 255, o[i + 1] / 255, o[i + 2] / 255, strength);
    o[i] = v[0] * 255; o[i + 1] = v[1] * 255; o[i + 2] = v[2] * 255;
  }
  return { width: img.width, height: img.height, data: o };
}

// ---------- sensor texture analysis ----------
function mad(arr) {
  if (arr.length < 50) return 0;
  const a = Float32Array.from(arr).sort(), med = a[a.length >> 1];
  const d = Float32Array.from(a, (v) => Math.abs(v - med)).sort();
  return 1.4826 * d[d.length >> 1];
}
function analyzeTexture(img) {
  const cw = Math.min(img.width, 1280), ch = Math.min(img.height, 720);
  const x0 = (img.width - cw) >> 1, y0 = (img.height - ch) >> 1, Y = new Float32Array(cw * ch), C = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = ((y + y0) * img.width + x + x0) * 4, r = img.data[i] / 255, g = img.data[i + 1] / 255, b = img.data[i + 2] / 255;
    Y[y * cw + x] = 0.2126 * r + 0.7152 * g + 0.0722 * b; C[y * cw + x] = g - (r + b) / 2;
  }
  const grads = [], pts = [];
  for (let y = 2; y < ch - 2; y += 1) for (let x = 2; x < cw - 2; x += 1) {
    const i = y * cw + x, gm = Math.abs(Y[i + 1] - Y[i - 1]) + Math.abs(Y[i + cw] - Y[i - cw]);
    pts.push(i); grads.push(gm);
  }
  const sample = Float32Array.from(grads.filter((_, k) => k % 7 === 0)).sort();
  const flatT = sample[Math.floor(sample.length * 0.4)], p95 = sample[Math.floor(sample.length * 0.95)];
  const box = (P, i) => { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += P[i + dy * cw + dx]; return s / 9; };
  const hz = [[], [], []], hc = [], lagN = [0, 0];
  for (let k = 0; k < pts.length; k++) {
    if (grads[k] > flatT) continue;
    const i = pts[k], m = box(Y, i), hp = Y[i] - m, z = m < 0.33 ? 0 : m < 0.66 ? 1 : 2;
    hz[z].push(hp); hc.push(C[i] - box(C, i));
    if (grads[k + 1] <= flatT) { const m2 = box(Y, i + 1); lagN[0] += hp * (Y[i + 1] - m2); lagN[1] += hp * hp; }
  }
  const corr = 1 / Math.sqrt(8 / 9); // box-3 residual deflates white-noise sigma
  const sigma = hz.map((a) => mad(a) * corr), lumaAll = mad([].concat(...hz)) * corr;
  // edge strength on a 3x3-blurred plane so grain doesn't masquerade as sharpness
  const eg = [];
  for (let y = 3; y < ch - 3; y += 2) for (let x = 3; x < cw - 3; x += 2) {
    const i = y * cw + x; eg.push(Math.abs(box(Y, i + 1) - box(Y, i - 1)) + Math.abs(box(Y, i + cw) - box(Y, i - cw)));
  }
  const egs = Float32Array.from(eg).sort(), edgeP99 = egs[Math.floor(egs.length * 0.99)] || 0;
  const edgeConfident = edgeP99 > 8 * lumaAll; // enough real edges above the noise floor to judge softness
  return { sigma, chromaRatio: lumaAll > 1e-6 ? clamp((mad(hc) * corr) / lumaAll, 0, 3) : 1, lag1: lagN[1] > 0 ? clamp(lagN[0] / lagN[1], -1, 1) : 0, edgeP95: edgeP99, edgeConfident };
}
function textureAdvice(refT, tgtT) {
  const names = ["shadows", "mids", "highlights"];
  const grain = refT.sigma.map((r, i) => Math.sqrt(Math.max(0, r * r - tgtT.sigma[i] ** 2)));
  const denoise = refT.sigma.map((r, i) => Math.max(0, tgtT.sigma[i] - r)).some((v) => v > 0.004);
  const edgeOK = refT.edgeConfident && tgtT.edgeConfident && tgtT.edgeP95 > 0;
  const edge = edgeOK ? refT.edgeP95 / tgtT.edgeP95 : 1;
  return {
    grain_add_8bit_levels: Object.fromEntries(names.map((n, i) => [n, +(grain[i] * 255).toFixed(2)])),
    grain_size: refT.lag1 < 0.12 ? "fine (≈1px)" : refT.lag1 < 0.3 ? "medium (≈1.5–2px)" : "coarse (≥2px, soft/clumpy)",
    chroma_noise_vs_luma: +refT.chromaRatio.toFixed(2),
    target_noisier_than_reference: denoise,
    edge_ratio_ref_over_target: +edge.toFixed(2),
    softness: !edgeOK ? "not enough clear edges in one of the frames to judge sharpness — pick frames with detail" : edge < 0.85 ? `reference is softer: blur ≈ ${((1 / edge - 1) * 1.5).toFixed(1)}px` : edge > 1.15 ? `reference is crisper: sharpen ≈ ${Math.min(100, Math.round((edge - 1) * 100))}%` : "similar sharpness",
  };
}

function meanTexture(imgs) {
  const ts = arr(imgs).map(analyzeTexture), m = (f) => ts.reduce((s, t) => s + f(t), 0) / ts.length;
  return { sigma: [0, 1, 2].map((i) => m((t) => t.sigma[i])), chromaRatio: m((t) => t.chromaRatio), lag1: m((t) => t.lag1),
           edgeP95: m((t) => t.edgeP95), edgeConfident: ts.every((t) => t.edgeConfident) };
}
function matchLook(refImg, tgtImg, opts = {}) {
  const ctx = fitLook(refImg, tgtImg), strength = opts.strength ?? 1;
  ctx.post = opts.post ? sanitizePost(opts.post) : null;
  const advice = opts.advice || textureAdvice(meanTexture(refImg), meanTexture(tgtImg));
  return { ctx, advice, strength, makeCube: () => buildCube(ctx, { size: opts.size || 33, strength, title: opts.title || "LookMatch" }),
           get cube() { return this.makeCube(); } };
}

module.exports = { sanitizePost, matchLook, fitLook, buildCube, applyToImage, analyzeTexture, textureAdvice, samplePixels, zoneStats, rgb2lab, lab2rgb };
