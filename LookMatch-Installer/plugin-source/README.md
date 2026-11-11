# Look Match (Premiere Pro UXP panel)

Copies the *look* of a reference clip onto your shot.

**Color/tone → .cube LUT** (OKLab histogram-matched tone curve incl. black lift and highlight rolloff, + per-luminance-zone tint and saturation transfer).
**Sensor feel → numbers** (grain per shadow/mid/highlight, grain size, chroma-noise share, softness) — a LUT can't hold texture.

## Install
1. Adobe UXP Developer Tool → Add Plugin → select `manifest.json` → Load (Premiere 25.6+).
2. Window → Extensions → Look Match.

## Use
1. Put the reference clip in any sequence, park the playhead on a representative frame → **Grab REFERENCE**.
2. Park on your shot → **Grab TARGET** (frames should have similar subject/lighting for best results).
3. Pick strength → **Match look** → choose an output folder.
4. Lumetri → Input LUT → Browse → the `.cube`. Add grain/softness from the printed numbers (Noise effect + Gaussian blur/Sharpen).

## Claude inside the panel (new)
- **Sources:** grab a single frame (image-style) or **sample a clip** (2–6 frames spread across the selected clip, or your In/Out range). Video frames are pooled, so the match reflects the whole shot, not one frame.
- **Claude sees your footage:** paste an Anthropic API key (kept in UXP secure storage). Frames are sent as PNGs (≤768px wide) to the Anthropic API.
- **Let Claude direct the grade:** the engine does the statistical match, then Claude looks at reference / target / graded preview and tunes bounded knobs (mid gamma, gain, saturation, global and shadow/highlight tint, strength) for 1–3 rounds, and writes a report with warnings (e.g. content mismatch) and how to fake the sensor character with effects. Knob ranges are clamped in code, so Claude can't blow out the LUT.
- **Ask Claude:** free chat with your frames attached.
- **Contact sheet:** saves a PNG of all grabbed frames so you can also upload it to a normal Claude chat.
- Changes to try: model name field is editable.

## Notes / honest limits
- Statistical matching (no ML). It copies tones/contrast/color-by-brightness well; it cannot invent detail or a different sensor's dynamic range. Highlights your footage never captured stay clipped.
- Different content in the two frames skews the color transfer — lower Strength, or use similar frames.
- Frame export uses BMP; the Premiere UXP calls (`Exporter.exportSequenceFrame`, `getFrameSize`, the experimental Lumetri add) are written from the API docs and not tested inside Premiere — if one differs in your build, the panel shows the error message.
- Claude panel calls (`fetch` to api.anthropic.com, secure storage, `TickTime.createWithSeconds`, selection/in-out range) are untested inside Premiere; errors are shown in the log. Image data leaves your machine when you use Claude features.
- `node test.js` / `node test2.js` verify the engine on synthetic images (color error drops ~10×).
