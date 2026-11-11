"use strict";
// Claude integration: Claude can SEE the reference/target/graded frames and steer the match.
const { encodePNG, downscale, toBase64 } = require("./png");
const { sanitizePost } = require("./engine");

const API = "https://api.anthropic.com/v1/messages";
const img = (frame, maxW = 768) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: toBase64(encodePNG(downscale(frame, maxW))) } });
const txt = (text) => ({ type: "text", text });

async function call({ apiKey, model, system, messages, maxTokens = 1500 }) {
  if (!apiKey) throw new Error("Paste your Anthropic API key first.");
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "API error " + r.status);
  return j.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
const parseJSON = (t) => { const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a < 0 || b < 0) throw new Error("Claude didn't return JSON."); return JSON.parse(t.slice(a, b + 1)); };

const COLORIST = `You are a senior colorist inside a Premiere Pro plugin. You are shown REFERENCE frame(s) whose look the user wants to copy, the TARGET frame(s) from their shot, and sometimes a GRADED preview (target after the plugin's automatic statistical match).
Judge by eye: contrast, black level, highlight rolloff, color cast per tonal zone, saturation, skin tones, and any sensor/texture character (grain, softness, halation, chroma noise).
Beware content mismatch: if the reference's color is dominated by subject matter (sky, foliage, a red wall) don't push the target toward it.`;

// Ask Claude for bounded refinement knobs on top of the statistical match.
async function refine({ apiKey, model, ref, tgt, graded, post, advice, round }) {
  const content = [txt("REFERENCE frame(s):"), ...ref.slice(0, 2).map((f) => img(f)), txt("TARGET (original):"), img(tgt), ...(graded ? [txt("GRADED preview (current match):"), img(graded)] : []),
    txt(`Current refinement values: ${JSON.stringify(post)}\nSensor stats from the engine: ${JSON.stringify(advice)}\nRound ${round}.\n` +
      `Reply with ONLY JSON: {"assessment": string (what still differs, 1-3 sentences), "converged": boolean, "strength": 0-1, ` +
      `"post": {"gamma":0.7-1.4 (>1 brightens mids),"gain":0.85-1.15,"chroma":0.5-1.6,"a":-0.03..0.03 (+ = magenta/red),"b":-0.03..0.03 (+ = yellow),"shadowTint":[a,b] each -0.04..0.04,"highlightTint":[a,b] each -0.04..0.04}, ` +
      `"warnings": [strings], "sensor_notes": string (how to fake the reference's sensor character with Premiere effects)}. Make small moves; set converged true if the graded frame already reads as the reference.`)];
  return parseJSON(await call({ apiKey, model, system: COLORIST, messages: [{ role: "user", content }] }));
}

// Free-form chat about the footage. Frames are attached to the latest user turn.
async function chat({ apiKey, model, history, userText, ref, tgt, graded }) {
  const attach = [];
  if (ref && ref.length) attach.push(txt("REFERENCE frame(s):"), ...ref.slice(0, 3).map((f) => img(f)));
  if (tgt && tgt.length) attach.push(txt("TARGET frame(s):"), ...tgt.slice(0, 3).map((f) => img(f)));
  if (graded) attach.push(txt("GRADED preview:"), img(graded));
  const messages = [...history, { role: "user", content: [...attach, txt(userText)] }];
  const reply = await call({ apiKey, model, system: COLORIST + "\nAnswer conversationally and concisely; give concrete Lumetri / effect settings when asked.", messages, maxTokens: 1200 });
  return reply;
}
module.exports = { refine, chat, sanitizePost };
