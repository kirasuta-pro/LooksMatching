"use strict";
const ppro = require("premierepro");
const uxp = require("uxp");
const fs = uxp.storage.localFileSystem;
const { decodeBMP } = require("./bmp");
const E = require("./engine");
const { encodePNG, downscale, contactSheet } = require("./png");
const Claude = require("./claude");

const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent = m; };
const state = { ref: [], tgt: [], res: null, history: [] };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const strengthNow = () => Number($("strength").value) / 100;

for (const [id, out] of [["strength", "sv"], ["nSamples", "nv"], ["rounds", "rv"]]) $(id).addEventListener("input", (e) => { $(out).textContent = e.target.value; });

// ---------- API key (kept in UXP secure storage) ----------
(async () => { try { const v = await uxp.storage.secureStorage.getItem("lm_key"); if (v) $("apiKey").value = new TextDecoder().decode(v); } catch (_) {} })();
$("apiKey").addEventListener("change", async () => { try { await uxp.storage.secureStorage.setItem("lm_key", $("apiKey").value); } catch (_) {} });

// ---------- frame grabbing (single frame or video samples) ----------
async function seqCtx() {
  const project = await ppro.Project.getActiveProject();
  const seq = await project.getActiveSequence();
  if (!seq) throw new Error("Open a sequence first.");
  let w = 1920, h = 1080;
  try { const f = await seq.getFrameSize(); if (f && f.width) { w = Math.round(f.width); h = Math.round(f.height); } } catch (_) {}
  return { project, seq, w, h };
}
async function exportAt(c, tick, name) {
  const tmp = await fs.getTemporaryFolder();
  const file = await tmp.createFile(name + ".bmp", { overwrite: true });
  const ok = await ppro.Exporter.exportSequenceFrame(c.seq, tick, file.nativePath, c.w, c.h);
  if (ok === false) throw new Error("Premiere refused the frame export.");
  return decodeBMP(await file.read({ format: uxp.storage.formats.binary }));
}
async function clipRange(seq) {
  try { const sel = await seq.getSelection(); const items = await sel.getTrackItems();
    if (items && items.length) { const s = await items[0].getStartTime(), e = await items[0].getEndTime(); return [s.seconds, e.seconds]; } } catch (_) {}
  try { const i = await seq.getInPoint(), o = await seq.getOutPoint(); if (o.seconds > i.seconds) return [i.seconds, o.seconds]; } catch (_) {}
  throw new Error("Select a clip on the timeline (or set In/Out points) to sample a video.");
}
async function grab(which, video) {
  const key = which === "ref" ? "ref" : "tgt", label = $(which + "State");
  try {
    const c = await seqCtx(), frames = [];
    if (!video) { log("Exporting frame…"); frames.push(await exportAt(c, await c.seq.getPlayerPosition(), which + "0")); }
    else {
      const [a, b] = await clipRange(c.seq), n = Number($("nSamples").value);
      for (let i = 0; i < n; i++) { log(`Sampling ${which} video… ${i + 1}/${n}`); const t = a + ((i + 0.5) / n) * (b - a); frames.push(await exportAt(c, ppro.TickTime.createWithSeconds(t), which + i)); }
    }
    state[key] = frames; state.res = null;
    label.innerHTML = `<span class="ok">✓ ${frames.length} frame${frames.length > 1 ? "s" : ""} · ${frames[0].width}×${frames[0].height}</span>`;
    log("Got " + which + (video ? " video samples." : " frame."));
  } catch (e) { log("Error: " + e.message); }
}
$("refFrame").addEventListener("click", () => grab("ref", false));
$("refVideo").addEventListener("click", () => grab("ref", true));
$("tgtFrame").addEventListener("click", () => grab("tgt", false));
$("tgtVideo").addEventListener("click", () => grab("tgt", true));

// ---------- helpers ----------
const need = () => { if (!state.ref.length || !state.tgt.length) throw new Error("Grab a reference and a target first."); };
const mid = (a) => a[Math.floor(a.length / 2)];
async function saveFiles(files) {
  const folder = await fs.getFolder(); if (!folder) throw new Error("Cancelled — no output folder chosen.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19), paths = [];
  for (const [suffix, data, binary] of files) {
    const f = await folder.createFile(`LookMatch_${stamp}${suffix}`, { overwrite: true });
    await f.write(data, binary ? { format: uxp.storage.formats.binary } : undefined); paths.push(f.nativePath);
  }
  return paths;
}
const sensorText = (a) => { const g = a.grain_add_8bit_levels; return `• Grain to add (8-bit levels): shadows ${g.shadows}, mids ${g.mids}, highs ${g.highlights}\n• Grain size: ${a.grain_size}\n• Chroma noise vs luma: ${a.chroma_noise_vs_luma}×\n• ${a.softness}` + (a.target_noisier_than_reference ? "\n• Your target is noisier than the reference → denoise first." : ""); };
const ensureMatch = (post) => { need(); return E.matchLook(state.ref, state.tgt, { strength: strengthNow(), post }); };

// ---------- contact sheet (so Claude in chat can see your sources) ----------
$("sheet").addEventListener("click", async () => {
  try {
    need(); log("Building contact sheet…");
    const png = encodePNG(contactSheet([...state.ref, ...state.tgt].map((f) => downscale(f, 640)), 3, 480));
    const [p] = await saveFiles([["_sheet.png", png.buffer, true]]);
    log(`Saved ${p}\n\nTop rows = reference, then target. Upload this image to a Claude chat to have it look at your sources.`);
  } catch (e) { log("Error: " + e.message); }
});

// ---------- plain statistical match ----------
$("run").addEventListener("click", async () => {
  try {
    log("Matching…"); await new Promise((r) => setTimeout(r, 30));
    const res = ensureMatch(null); state.res = res;
    const [c, j] = await saveFiles([[".cube", res.cube], ["_sensor.json", JSON.stringify(res.advice, null, 2)]]);
    log(`Saved:\n${c}\n\nLumetri → Basic Correction → Input LUT → Browse… → that .cube\n\nSENSOR LOOK (add as effects):\n${sensorText(res.advice)}`);
  } catch (e) { log("Error: " + e.message); }
});

// ---------- Claude directs the grade: it SEES ref/target/graded, tunes, repeats ----------
$("direct").addEventListener("click", async () => {
  try {
    const apiKey = $("apiKey").value.trim(), model = $("model").value.trim(), rounds = Number($("rounds").value);
    log("Fitting statistical match…"); await new Promise((r) => setTimeout(r, 30));
    const res = ensureMatch(null); state.res = res;
    let post = E.sanitizePost(null), strength = strengthNow(), notes = [], warnings = [], sensor = "";
    res.ctx.post = null;
    for (let r = 1; r <= rounds; r++) {
      log(`Claude is looking at the frames… (round ${r}/${rounds})`);
      const graded = E.applyToImage(res.ctx, downscale(mid(state.tgt), 512), strength);
      const out = await Claude.refine({ apiKey, model, ref: state.ref.map((f) => downscale(f, 768)), tgt: downscale(mid(state.tgt), 768), graded, post, advice: res.advice, round: r });
      post = E.sanitizePost(out.post); strength = clamp01(typeof out.strength === "number" ? out.strength : strength);
      res.ctx.post = post;
      notes.push(`R${r}: ${out.assessment}`); warnings = out.warnings || warnings; sensor = out.sensor_notes || sensor;
      if (out.converged) break;
    }
    const report = { notes, warnings, sensor_notes: sensor, strength, post, engine_sensor_stats: res.advice };
    const [c] = await saveFiles([[".cube", E.buildCube(res.ctx, { strength, title: "LookMatch-Claude" })], ["_claude_report.json", JSON.stringify(report, null, 2)]]);
    log(`Saved: ${c}\nStrength used: ${Math.round(strength * 100)}%\n\n${notes.join("\n")}\n\n` + (warnings.length ? "Warnings:\n• " + warnings.join("\n• ") + "\n\n" : "") + `Sensor look:\n${sensor}\n\nEngine numbers:\n${sensorText(res.advice)}`);
  } catch (e) { log("Error: " + e.message); }
});

// ---------- chat with Claude about the footage ----------
$("send").addEventListener("click", async () => {
  try {
    const userText = $("ask").value.trim(); if (!userText) return log("Type a question first.");
    const apiKey = $("apiKey").value.trim(), model = $("model").value.trim();
    log("Claude is looking…");
    const graded = state.res && state.tgt.length ? E.applyToImage(state.res.ctx, downscale(mid(state.tgt), 512), strengthNow()) : null;
    const reply = await Claude.chat({ apiKey, model, history: state.history, userText, ref: state.ref.map((f) => downscale(f, 768)), tgt: state.tgt.map((f) => downscale(f, 768)), graded });
    state.history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
    $("ask").value = ""; log(reply);
  } catch (e) { log("Error: " + e.message); }
});
