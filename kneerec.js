/* Knee Recovery browser engine. Two layers on the same frames, kept apart, as in CONTRIBUTING.md.

   Measurement: MediaPipe landmarks -> knee angle by trigonometry on 2D image coordinates ->
     whole-session statistics. Never segments repetitions. Never reads the z channel.
   Monitoring: frame differencing in a box -> hysteresis counter -> repetitions, tempo, active time.
     Receives pixels and the clock only; never sees landmarks, joints or angles.

   The two results meet only in the session record, side by side. Nothing here joins them. */

export const SOFTWARE = "browser-0.2.0";

/* ---------------- measurement layer (landmarks -> angle -> session statistics) ---------------- */
const LEFT = { hip: 23, knee: 25, ankle: 27 }, RIGHT = { hip: 24, knee: 26, ankle: 28 };

export function pickSide(lms, w, h, side, minVis) {
  const leg = idx => {
    const pts = ["hip", "knee", "ankle"].map(k => lms[idx[k]]);
    const vis = Math.min(...pts.map(p => p.visibility ?? 0));
    return { pts: pts.map(p => [p.x * w, p.y * h]), vis };            // x, y only; z is never read
  };
  let chosen, s;
  if (side === "left") { chosen = leg(LEFT); s = "left"; }
  else if (side === "right") { chosen = leg(RIGHT); s = "right"; }
  else { const l = leg(LEFT), r = leg(RIGHT); if (l.vis >= r.vis) { chosen = l; s = "left"; } else { chosen = r; s = "right"; } }
  if (chosen.vis < minVis) return null;
  return { hip: chosen.pts[0], knee: chosen.pts[1], ankle: chosen.pts[2], visibility: chosen.vis, side: s };
}

export function kneeFlexionDeg(hip, knee, ankle) {
  const ax = hip[0] - knee[0], ay = hip[1] - knee[1], bx = ankle[0] - knee[0], by = ankle[1] - knee[1];
  const na = Math.hypot(ax, ay), nb = Math.hypot(bx, by);
  if (na < 1e-6 || nb < 1e-6) return NaN;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (na * nb)));
  return 180 - Math.acos(c) * 180 / Math.PI;
}

export class AngleTrace {
  constructor(k = 5) { this.k = k; this.win = []; this.rows = []; }
  add(frame, t, lm) {
    let raw = NaN, vis = 0, side = "";
    if (lm) { raw = kneeFlexionDeg(lm.hip, lm.knee, lm.ankle); vis = lm.visibility; side = lm.side; }
    let smooth = NaN;
    if (Number.isNaN(raw)) this.win = [];
    else { this.win.push(raw); if (this.win.length > this.k) this.win.shift(); smooth = [...this.win].sort((a, b) => a - b)[Math.floor(this.win.length / 2)]; }
    this.rows.push([frame, t, raw, smooth, vis, side]);
    return smooth;
  }
  csv() { return "frame,t,flexion_raw,flexion_smooth,visibility,side\n" + this.rows.map(r => `${r[0]},${r[1].toFixed(3)},${Number.isNaN(r[2]) ? "" : r[2].toFixed(2)},${Number.isNaN(r[3]) ? "" : r[3].toFixed(2)},${r[4].toFixed(2)},${r[5]}`).join("\n") + "\n"; }
}

export function summarise(trace, duration, target) {
  const valid = trace.rows.map(r => r[3]).filter(v => !Number.isNaN(v));
  const out = { frames_total: trace.rows.length, frames_with_angle: valid.length, peak_flexion_deg: null, p95_flexion_deg: null,
    min_extension_deg: null, p05_extension_deg: null, mean_flexion_deg: null, median_flexion_deg: null, time_above_target_s: 0, target_flexion_deg: target, histogram_10deg: {}, side: "", trace_file: "angle.csv" };
  if (!valid.length) return out;
  const dt = duration / Math.max(1, trace.rows.length);
  const s = [...valid].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  out.peak_flexion_deg = +s[s.length - 1].toFixed(1); out.p95_flexion_deg = +q(0.95).toFixed(1);
  out.mean_flexion_deg = +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1); out.median_flexion_deg = +q(0.5).toFixed(1);
  out.min_extension_deg = +s[0].toFixed(1); out.p05_extension_deg = +q(0.05).toFixed(1);
  out.time_above_target_s = +(valid.filter(v => v >= target).length * dt).toFixed(1);
  for (const v of valid) { const b = Math.min(150, Math.floor(Math.max(0, v) / 10) * 10); const k = `${b}-${b + 10}`; out.histogram_10deg[k] = (out.histogram_10deg[k] || 0) + dt; }
  for (const k in out.histogram_10deg) out.histogram_10deg[k] = +out.histogram_10deg[k].toFixed(1);
  const sides = trace.rows.map(r => r[5]).filter(Boolean); out.side = sides.length ? sides.sort((a, b) => sides.filter(x => x === b).length - sides.filter(x => x === a).length)[0] : "";
  return out;
}

/* a light version of the trace for the record and the report: one median value per quarter second */
export function tracePreview(rows) {
  const out = []; let bucket = [], b0 = 0;
  for (const r of rows) { const b = Math.floor(r[1] * 4); if (b !== b0) { out.push(bucket.length ? +[...bucket].sort((a, c) => a - c)[Math.floor(bucket.length / 2)].toFixed(1) : null); bucket = []; for (let k = b0 + 1; k < b; k++) out.push(null); b0 = b; } if (!Number.isNaN(r[3])) bucket.push(r[3]); }
  out.push(bucket.length ? +[...bucket].sort((a, c) => a - c)[Math.floor(bucket.length / 2)].toFixed(1) : null);
  return { hz: 4, flexion_deg: out };
}

/* Angle-against-time chart: the whole session, first frame to last, one line, gaps where the leg was not
   found. Nothing on it marks a repetition. rows: [frame, t, raw, smooth, vis, side] */
export function angleChartSvg(rows, w = 900, h = 260, dark = true) {
  const pts = rows.map(r => [r[1], r[3]]);
  const tmax = pts.length ? Math.max(1, pts[pts.length - 1][0]) : 1;
  const valid = pts.filter(p => !Number.isNaN(p[1]));
  const L = 48, R = 16, T = 18, B = 34, pw = w - L - R, ph = h - T - B, ymax = 140;
  const X = t => L + pw * t / tmax, Y = v => T + ph * (1 - Math.min(ymax, Math.max(0, v)) / ymax);
  const ink = dark ? "#b5b5b5" : "#52514e", grid = dark ? "#333" : "#e4e3df", bg = dark ? "#1a1a1a" : "#fcfcfb", line = dark ? "#3987e5" : "#2a78d6";
  let g = "";
  for (let v = 0; v <= ymax; v += 20) g += `<line x1="${L}" x2="${w - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${grid}"/><text x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" fill="${ink}" font-size="11">${v}</text>`;
  const step = tmax > 120 ? 30 : tmax > 40 ? 10 : 5;
  for (let t = 0; t <= tmax; t += step) g += `<text x="${X(t).toFixed(1)}" y="${h - 12}" text-anchor="middle" fill="${ink}" font-size="11">${t}</text>`;
  const segs = []; let cur = [];
  const stride = Math.max(1, Math.floor(pts.length / (pw * 2)));
  for (let i = 0; i < pts.length; i += stride) { const [t, v] = pts[i]; if (Number.isNaN(v)) { if (cur.length) { segs.push(cur); cur = []; } continue; } cur.push(`${X(t).toFixed(1)},${Y(v).toFixed(1)}`); }
  if (cur.length) segs.push(cur);
  const paths = segs.map(s => `<polyline fill="none" stroke="${line}" stroke-width="2" stroke-linejoin="round" points="${s.join(" ")}"/>`).join("");
  const note = valid.length ? "" : `<text x="${(L + pw / 2).toFixed(0)}" y="${(T + ph / 2).toFixed(0)}" text-anchor="middle" fill="${ink}" font-size="14">leg not found in this session</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif"><rect width="${w}" height="${h}" fill="${bg}"/>${g}${paths}${note}<text x="${L}" y="12" fill="${ink}" font-size="11">knee flexion, degrees (0 = straight)</text><text x="${w - R}" y="${h - 12}" text-anchor="end" fill="${ink}" font-size="11">seconds</text></svg>`;
}

export const POSE_CONNECTIONS = [[0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10],[11,12],[11,13],[13,15],[15,17],[15,19],[15,21],[17,19],[12,14],[14,16],[16,18],[16,20],[16,22],[18,20],[11,23],[12,24],[23,24],[23,25],[24,26],[25,27],[26,28],[27,29],[28,31],[29,31],[27,31],[30,32],[28,30],[28,32]];

/* draws every landmark MediaPipe found; a display of the measurement, nothing more */
export function drawSkeleton(ctx, all, W, H, opts = {}) {
  const line = opts.line || "rgba(80,220,120,.9)", dot = opts.dot || "rgba(255,255,255,.95)", lw = opts.lineWidth || 3, r = opts.radius || 4;
  ctx.lineWidth = lw; ctx.strokeStyle = line;
  for (const [a, b] of POSE_CONNECTIONS) { const p = all[a], q = all[b]; if (!p || !q || (p.visibility ?? 1) < 0.4 || (q.visibility ?? 1) < 0.4) continue;
    ctx.beginPath(); ctx.moveTo(p.x * W, p.y * H); ctx.lineTo(q.x * W, q.y * H); ctx.stroke(); }
  for (const p of all) { if ((p.visibility ?? 1) < 0.4) continue; ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(p.x * W, p.y * H, r, 0, 7); ctx.fill(); }
}

/* the hip, knee and ankle of the measured leg with the live angle; bench view */
export function drawLeg(ctx, lm, opts = {}) {
  ctx.lineWidth = opts.lineWidth || 6; ctx.strokeStyle = opts.thigh || "#ffc832"; ctx.beginPath(); ctx.moveTo(...lm.hip); ctx.lineTo(...lm.knee); ctx.stroke();
  ctx.strokeStyle = opts.shank || "#e050ff"; ctx.beginPath(); ctx.moveTo(...lm.knee); ctx.lineTo(...lm.ankle); ctx.stroke();
  for (const [p, c] of [[lm.hip, opts.thigh || "#ffc832"], [lm.knee, "#fff"], [lm.ankle, opts.shank || "#e050ff"]]) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p[0], p[1], opts.radius || 10, 0, 7); ctx.fill(); }
  if (opts.label !== false) { ctx.fillStyle = "#fff"; ctx.font = "18px sans-serif"; ctx.fillText(lm.side, lm.knee[0] + 16, lm.knee[1] - 16); }
}

/* ---------------- model loading ---------------- */
const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
export const MODEL_CDN = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

async function head(url) { try { const r = await fetch(url, { method: "HEAD" }); return r.ok; } catch (e) { return false; } }

/* Library, wasm and model are served from this folder (vendor/ and models/) so the page works offline.
   Anything missing locally is fetched from the same version on the CDN. Returns { landmarker, library, model }. */
export async function loadPose({ wasmLocal = "./vendor/wasm", modelCandidates = ["./models/pose_landmarker_lite.task", "../models/pose_landmarker_lite.task"], log = () => {} } = {}) {
  let mod;
  try { mod = await import("./vendor/vision_bundle.mjs"); } catch (e) { mod = await import(CDN + "/vision_bundle.mjs"); }
  const { PoseLandmarker, FilesetResolver } = mod;
  const wasm = (await head(wasmLocal + "/vision_wasm_internal.wasm")) ? wasmLocal : CDN + "/wasm";
  const vision = await FilesetResolver.forVisionTasks(wasm);
  let model = MODEL_CDN;
  for (const cand of modelCandidates) if (await head(cand)) { model = cand; break; }
  const make = d => PoseLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: model, delegate: d }, runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  let landmarker;
  try { landmarker = await make("GPU"); } catch (e) { log("GPU delegate unavailable, using CPU: " + e.message); landmarker = await make("CPU"); }
  try { const c = document.createElement("canvas"); c.width = 256; c.height = 256; c.getContext("2d").fillRect(0, 0, 256, 256); landmarker.detectForVideo(c, Math.round(performance.now())); } catch (e) { }   // warm up
  return { landmarker, library: wasm === wasmLocal ? "local library" : "library from CDN", model: model === MODEL_CDN ? "model from Google" : "local model" };
}

/* ---------------- monitoring layer (pixels -> reps). Receives ImageData only. ---------------- */
const PW = 160, DIFF_THR = 28, MOVING_FRAC = 0.004, AUTO_BOX_S = 6;

export class RepCounter {
  constructor(fps) { this.aS = 1 - Math.exp(-1 / (0.15 * fps)); this.aA = 1 - Math.exp(-1 / (8 * fps)); this.reset(); }
  reset() { this.v = 0; this.amp = 0.5; this.state = 0; this.reps = 0; this.times = []; this.path = 0; this.sizes = []; }
  update(v, t) {
    this.v += this.aS * (v - this.v); const s = this.v; this.path += Math.abs(s);
    if (Math.abs(s) > this.amp) this.amp = Math.abs(s); else this.amp += this.aA * (Math.abs(s) - this.amp);
    const h = Math.max(0.5, 0.25 * this.amp); let rep = 0;
    if (s > h) { if (this.state === -1 && (!this.times.length || t - this.times[this.times.length - 1] >= 0.6)) { this.reps++; this.times.push(t); this.sizes.push(this.path); this.path = 0; rep = 1; } this.state = 1; }
    else if (s < -h) this.state = -1;
    return [s, rep];
  }
  tempo(k = 4) { if (this.times.length < 2) return null; const ts = this.times.slice(-(k + 1)); return (ts[ts.length - 1] - ts[0]) / (ts.length - 1); }
}

export class FlowMonitor {
  /* Frame differencing inside a box: the centroid of the pixels that changed tracks the moving leg;
     its velocity along the principal movement axis is the counting signal. No key points, no model. */
  constructor(fw, fh, fps) {
    this.fw = fw; this.fh = fh; this.fps = fps; this.scale = PW / fw; this.ph = Math.round(fh * this.scale);
    this.box = [Math.floor(fw / 4), Math.floor(fh / 6), Math.floor(fw / 2), Math.floor(fh * 0.75)]; this.locked = false;
    this.prev = null; this.pc = [NaN, NaN]; this.counter = new RepCounter(fps); this.hist = []; this.rows = [];
    this.acc = new Float32Array(PW * this.ph); this.accN = 0; this.moving = false; this.signal = 0;
    this.work = document.createElement("canvas"); this.work.width = PW; this.work.height = this.ph; this.wctx = this.work.getContext("2d", { willReadFrequently: true });
  }
  setBox(b) { this.box = b.map(v => Math.round(v)); this.locked = true; this.counter.reset(); this.hist = []; }
  reset() { this.counter.reset(); this.hist = []; }
  gray(img) { const d = img.data, n = PW * this.ph, g = new Uint8ClampedArray(n); for (let i = 0; i < n; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; return g; }
  update(source, frame, t) {
    this.wctx.drawImage(source, 0, 0, PW, this.ph);
    const g = this.gray(this.wctx.getImageData(0, 0, PW, this.ph));
    if (!this.prev) { this.prev = g; return 0; }
    const [bx, by, bw, bh] = this.box.map(v => v * this.scale);
    const x0 = Math.max(0, Math.floor(bx)), y0 = Math.max(0, Math.floor(by)), x1 = Math.min(PW, Math.ceil(bx + bw)), y1 = Math.min(this.ph, Math.ceil(by + bh));
    let n = 0, sx = 0, sy = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * PW + x; const d = Math.abs(g[i] - this.prev[i]); if (!this.locked) this.acc[i] += d; if (d > DIFF_THR) { n++; sx += x; sy += y; } }
    if (!this.locked && ++this.accN >= AUTO_BOX_S * this.fps) this.lockFromMotion();
    this.prev = g;
    const area = Math.max(1, (x1 - x0) * (y1 - y0)); this.moving = n / area > MOVING_FRAC;
    let vx = 0, vy = 0;
    if (n / area >= MOVING_FRAC) { const cx = sx / n, cy = sy / n; if (!Number.isNaN(this.pc[0])) { vx = cx - this.pc[0]; vy = cy - this.pc[1]; } this.pc = [cx, cy]; } else this.pc = [NaN, NaN];
    // a centroid jump at a turning point is not leg speed: clip to a few times the running amplitude
    const lim = Math.max(1.5, 3 * this.counter.amp); vx = Math.max(-lim, Math.min(lim, vx)); vy = Math.max(-lim, Math.min(lim, vy));
    const v = this.axis(vx, vy); const [s, rep] = this.counter.update(v, t); this.signal = s;
    this.rows.push([frame, t, vx, vy, n / area, s, rep, this.moving ? 1 : 0]);
    return rep;
  }
  axis(vx, vy) {
    this.hist.push([vx, vy]); if (this.hist.length > 150) this.hist.shift(); if (this.hist.length < 10) return vy;
    let xx = 0, xy = 0, yy = 0; for (const [a, b] of this.hist) { xx += a * a; xy += a * b; yy += b * b; }
    const th = 0.5 * Math.atan2(2 * xy, xx - yy); let d = [Math.cos(th), Math.sin(th)];
    if (Math.abs(d[0]) >= Math.abs(d[1])) { if (d[0] < 0) d = [-d[0], -d[1]]; } else if (d[1] < 0) d = [-d[0], -d[1]];
    return vx * d[0] + vy * d[1];
  }
  lockFromMotion() {
    const a = this.acc; let vals = Array.from(a).filter(v => v > 0).sort((x, y) => x - y); const thr = vals.length ? vals[Math.floor(vals.length * 0.9)] : 1;
    let minx = PW, miny = this.ph, maxx = 0, maxy = 0, cnt = 0;
    for (let y = 0; y < this.ph; y++) for (let x = 0; x < PW; x++) if (a[y * PW + x] >= thr) { cnt++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    if (cnt > 40 && maxx - minx > 10 && maxy - miny > 10) { const p = 6; this.box = [Math.max(0, minx - p) / this.scale, Math.max(0, miny - p) / this.scale, Math.min(PW, maxx - minx + 2 * p) / this.scale, Math.min(this.ph, maxy - miny + 2 * p) / this.scale].map(Math.round); }
    this.locked = true;   // count so far is kept
  }
  summary(duration) {
    const n = this.rows.length, active = this.rows.filter(r => r[7]).length, tempo = this.counter.tempo(Math.max(4, this.counter.times.length));
    return { repetitions: this.counter.reps, tempo_s_per_rep: tempo ? +tempo.toFixed(2) : null, active_fraction: +(active / Math.max(1, n)).toFixed(3),
      active_time_s: +(active / Math.max(1, n) * duration).toFixed(1), early_stop: false, mean_movement_size: this.counter.sizes.length ? +(this.counter.sizes.reduce((a, b) => a + b, 0) / this.counter.sizes.length).toFixed(1) : 0, box: this.box, trace_file: "flow.csv" };
  }
  csv() { return "frame,t,vx,vy,changed_fraction,signal,rep,moving\n" + this.rows.map(r => `${r[0]},${r[1].toFixed(3)},${r[2].toFixed(3)},${r[3].toFixed(3)},${r[4].toFixed(4)},${r[5].toFixed(3)},${r[6]},${r[7]}`).join("\n") + "\n"; }
}

/* ---------------- record helpers ---------------- */
export function localIso(d) { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
export function stampOf(d) { return d.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "_"); }
export function download(name, blob) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
export function daysPostOp(op, when) { return op ? Math.floor((when - new Date(op)) / 864e5) : null; }

/* the stored records this browser holds; report.html reads the same key */
export const STORE_KEY = "kr_sessions";
export function loadRecords() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch (e) { return []; } }
export function storeRecord(rec) { const store = loadRecords(); store.push(rec); try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { } return store.length; }

/* The monitoring layer never touches the video mime; the recorder is plain browser API. */
export function pickRecorderMime() { return ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || ""; }
