// Pipe Fitter - application entry point.
//
// The geometry and schematic live in their own modules; three.js is vendored
// under ./vendor. All state is local to the page: there is no server and no
// persistence beyond the URL hash.

import * as THREE from './vendor/three.module.js';
import * as geo from './pipe-geometry.js';
import { drawDiagram } from './pipe-diagram.js';

// ── DOM references ──────────────────────────────────────────────────────────
const el = {
  summary: document.getElementById('summary'),
  layoutSwitch: document.getElementById('layout-switch'),
  unitsSwitch: document.getElementById('units-switch'),
  undo: document.getElementById('btn-undo'),
  redo: document.getElementById('btn-redo'),
  reset: document.getElementById('btn-reset'),
  help: document.getElementById('btn-help'),
  helpBackdrop: document.getElementById('help-backdrop'),
  helpClose: document.getElementById('help-close'),
  helpBody: document.getElementById('help-body'),
  body: document.getElementById('body'),
  panel: document.getElementById('panel'),
  panelToolbar: document.getElementById('panel-toolbar'),
  collapseAll: document.getElementById('btn-collapse-all'),
  expandAll: document.getElementById('btn-expand-all'),
  panelGrid: document.getElementById('panel-grid'),
  stage: document.getElementById('stage'),
  bbox: document.getElementById('bbox'),
  mesh: document.getElementById('mesh'),
  notes: document.getElementById('notes'),
  diagram: document.getElementById('diagram'),
  diagramReset: document.getElementById('btn-diagram-reset'),
  schematic: document.getElementById('schematic'),
  overlayBr: document.querySelector('.overlay-br'),
  viewer: document.getElementById('viewer'),
  expand: document.getElementById('btn-expand'),
};

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  params: null,       // the clamped { sections, bends } model - single source of truth
  layout: 'left',     // 'left' | 'right' | 'bottom'
  units: 'mm',        // display units only - 'mm' | 'in'; geometry is always mm
};

// ── Small helpers ─────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, dp) => { const f = 10 ** dp; return Math.round(v * f) / f; };
const clampPol = (p) => clamp(p, 0.08, Math.PI - 0.08);   // keep the camera off the poles (lookAt is degenerate there)
const clampDist = (d) => clamp(d, 6, 4000);               // camera distance range
// Read one decoded field from the URL hash, or null if absent.
const hashParam = (name) => {
  const m = new RegExp('[#&]' + name + '=([^&]*)').exec(window.location.hash || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
};

// Display-unit conversion. The model is stored in millimeters end to end; these
// only affect what the panel, overlays, and schematic *show*. A length control
// with 'mm' in its hint is convertible; counts, angles, and degrees are not.
const MM_PER_IN = 25.4;
const SNAP_IN = 1 / 32;   // inch-mode controls step and snap to 1/32"
const inchMode = () => state.units === 'in';
const toDisp = (mm) => inchMode() ? round(mm / MM_PER_IN, 3) : mm;                     // mm → shown number
const fromDisp = (v) => inchMode() ? v * MM_PER_IN : v;                                // shown number → mm
const snapIn = (inches) => Math.round(inches / SNAP_IN) * SNAP_IN;                     // → nearest 1/32"
// A control's min/max pushed out to the nearest 1/32" grid line, so the slider's
// notches land on clean 1/32 values (edits are re-clamped to the true mm limit).
const dispBound = (mm, dir) => {
  if (!inchMode()) return mm;
  const q = (mm / MM_PER_IN) / SNAP_IN;
  return (dir === 'max' ? Math.ceil(q) : Math.floor(q)) * SNAP_IN;
};
const unitSuffix = () => inchMode() ? 'in' : 'mm';
const isLenCtrl = (c) => c.kind === 'num' && /mm/.test(c.hint || '');
// The hint doubles as the unit label ('mm', 'ø mm', ...) - swap it for display.
const dispHint = (c) => (isLenCtrl(c) && inchMode()) ? c.hint.replace('mm', 'in') : c.hint;

let undoStack = [];
let redoStack = [];
let lastKey = null;   // control key of the last committed edit (coalescing)
let lastT = 0;        // timestamp of the last committed edit
let dragBase = null;  // params snapshot at the start of an edit gesture, so values
let dragKey = null;   // clamped down mid-drag recover if the drag reverses - see set()

let cachedG = null;   // memoized geometry result
let cachedSig = '';   // parameter signature the cache was built for

// three.js handles, initialized in initThree()
const VIEW_HOME = { az: -0.7, pol: 1.30 };   // default orbit angles (az ≈ −40°, from the left; camera elevation ≈ 16°)
const FRAME_K = 1.8;                          // auto-frame distance = span · FRAME_K · fitK (lower = tighter)
let renderer, scene, camera, mesh, material, grid;
let orbit = null;
let fitK = 1;
let span = 0;
let framed = false;
let userView = false; // once true, auto-framing is disabled
let swapped = false;  // true when the diagram is expanded and the 3D view is a thumbnail
let gridKey = '';
let rafPending = false;
let resizeObserver = null;
let hasCustomView = false;   // once true, the camera pose is written to the URL (#view=...)
let wheelTimer = null;       // debounce so zoom writes the URL only after scrolling stops

// Render styles for the 3D mesh, chosen from the topbar "Render" menu and kept
// in the URL (#render=...). Most are PBR (color/metalness/roughness/env intensity,
// lit by the studio environment in makeEnvironment); their per-style surface
// relief/texture lives in SURFACE below. `wireframe` and `normals` swap type.
const RENDER_STYLES = {
  steel:   { color: 0xc2c6d6, metalness: 0.62, roughness: 0.28, env: 0.95 },
  resin:   { color: 0x8f7ff5, metalness: 0.0,  roughness: 0.14, env: 1.1  },
  copper:  { color: 0xc9784a, metalness: 0.9,  roughness: 0.30, env: 1.25 },
  clay:    { color: 0xcabfae, metalness: 0.0,  roughness: 0.92, env: 0.45 },
  wire:    { color: 0x9184d9, wireframe: true },
  normals: { normals: true },
};
let renderStyle = 'steel';
const surfaceCache = {};   // per-style { normalMap, roughnessMap, map }, built lazily

// ── Parameters: hash serialization ──────────────────────────────────────────
// The URL carries the whole chain, list-based so any number of sections works:
//   #s=<sec>|<sec>|...&b=<bend>|<bend>|...&e0=<end>&eN=<end>
// A section is `id~w~l`; a bend is `ang~l2~idm~w2~idmSmooth~w2Smooth`; both use
// `~` between fields and `|` between entries. The two end treatments (first and
// last section) ride in `e0` / `eN` as `type~p1~p2...`, carrying only the params
// that treatment uses. Missing values fall back to defaults; the shape is
// re-normalized on load (≥2 sections, exactly N-1 bends).

const encodeEnd = (end) => [end.type, ...(END_TREATMENT_KEYS[end.type] || []).map((suf) => end[suf])].join('~');
function decodeEnd(token) {
  const parts = (token || '').split('~');
  const end = geo.defaultEnd();
  if (geo.END_TYPES.includes(parts[0])) end.type = parts[0];
  (END_TREATMENT_KEYS[end.type] || []).forEach((suf, i) => { if (parts[i + 1] !== undefined && parts[i + 1] !== '') end[suf] = parts[i + 1]; });
  return end;
}

function readHash() {
  const sRaw = hashParam('s');
  if (sRaw === null) return null;
  const sections = sRaw.split('|').filter((x) => x !== '').map((tok) => {
    const f = tok.split('~');
    return { id: f[0], w: f[1], l: f[2] };
  });
  const bRaw = hashParam('b');
  const bends = (bRaw === null ? [] : bRaw.split('|').filter((x) => x !== '')).map((tok) => {
    const f = tok.split('~');
    return { ang: f[0], l2: f[1], idm: f[2], w2: f[3], idmSmooth: f[4], w2Smooth: f[5] };
  });
  if (sections.length >= 1) {
    const e0 = hashParam('e0'), eN = hashParam('eN');
    sections[0].end = decodeEnd(e0);
    sections[sections.length - 1].end = decodeEnd(eN);
  }
  return geo.normalize({ sections, bends }).p;
}

function writeHash(params) {
  const secs = params.sections;
  const sPart = secs.map((sc) => [sc.id, sc.w, sc.l].join('~')).join('|');
  const bPart = params.bends.map((bd) => [bd.ang, bd.l2, bd.idm, bd.w2, bd.idmSmooth, bd.w2Smooth].join('~')).join('|');
  let s = 's=' + sPart + '&b=' + bPart +
    '&e0=' + encodeEnd(secs[0].end) + '&eN=' + encodeEnd(secs[secs.length - 1].end);
  // The chosen render style rides along too (omitted when it's the default), so
  // the whole viewing state lives in the URL - no cookies or localStorage.
  if (renderStyle && renderStyle !== 'steel') s += '&render=' + renderStyle;
  // The display-unit choice rides along too (omitted when it's the default mm).
  if (state.units === 'in') s += '&units=in';
  // The expanded (diagram-swapped) state rides along, so a refreshed or copied
  // link opens with the cross-section already expanded.
  if (swapped) s += '&expanded=1';
  // The camera pose rides along as `view` once the user has moved it, so a link
  // reproduces both the part and the angle it's being viewed from.
  if (hasCustomView && orbit) s += '&view=' + serializeView();
  try { window.history.replaceState(null, '', '#' + s); } catch (e) { /* sandboxed */ }
}
// Render style ↔ URL (`render`), read back on load.
function readRenderStyle() {
  const v = hashParam('render');
  return v && RENDER_STYLES[v] ? v : null;
}
// Display units ↔ URL (`units`), read back on load.
function readUnits() {
  return hashParam('units') === 'in' ? 'in' : 'mm';
}
// Expanded-diagram state ↔ URL (`expanded`), read back on load.
function readExpanded() {
  return hashParam('expanded') === '1';
}

// Camera pose ↔ URL. Serialized as az,pol,dist,targetX,targetY,targetZ.
function serializeView() {
  const o = orbit;
  return [round(o.az, 3), round(o.pol, 3), round(o.dist, 1), round(o.target.x, 1), round(o.target.y, 1), round(o.target.z, 1)].join(',');
}
function readView() {
  const raw = hashParam('view');
  if (raw === null) return null;
  const v = raw.split(',').map(Number);
  if (v.length < 6 || v.some((x) => !isFinite(x))) return null;
  return { az: v[0], pol: v[1], dist: v[2], tx: v[3], ty: v[4], tz: v[5] };
}
function applyView(v) {
  orbit.az = v.az;
  orbit.pol = clampPol(v.pol);
  orbit.dist = clampDist(v.dist);
  orbit.target.set(v.tx, v.ty, v.tz);
  userView = true; framed = true; hasCustomView = true;   // an explicit view: don't auto-reframe
  draw();
}
// The camera changed and the gesture ended - persist it to the URL.
function commitView() {
  hasCustomView = true;
  writeHash(state.params);
}

// ── Undo / redo ─────────────────────────────────────────────────────────────
// Consecutive changes to the same control within 600ms collapse into one entry,
// so dragging a slider is a single undo step. Stack capped at 80.
function commit(params, key) {
  const now = Date.now();
  const coalesce = key && key === lastKey && now - lastT < 600;
  if (!coalesce) {
    undoStack = undoStack.concat([state.params]).slice(-80);
    redoStack = [];
  }
  lastKey = key;
  lastT = now;
  state.params = params;
  writeHash(params);
  render();
}

function step(dir) {
  const from = dir === 'undo' ? undoStack : redoStack;
  if (!from.length) return;
  const params = from[from.length - 1];
  from.pop();
  (dir === 'undo' ? redoStack : undoStack).push(state.params);
  lastKey = null;
  state.params = params;
  writeHash(params);
  render();
}

function onKey(e) {
  if (!(e.metaKey || e.ctrlKey) || (e.key || '').toLowerCase() !== 'z') return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // let native field undo work
  e.preventDefault();
  step(e.shiftKey ? 'redo' : 'undo');
}

// ── Parameter editing (clamp, never reject) ─────────────────────────────────
// Every editable value has a string key encoding its location in the array
// model, so undo-coalescing and DOM lookups stay key-based:
//   s<i>.id | s<i>.w | s<i>.l          section dimensions
//   s<i>.end.type | s<i>.end.<suf>     first/last end treatment
//   b<i>.ang | b<i>.l2 | b<i>.idm | b<i>.w2 | b<i>.idmSmooth | b<i>.w2Smooth
const END_TREATMENT_KEYS = {
  plain: [],
  chamfer: ['ChX', 'ChY', 'ChIX', 'ChIY'],
  flange: ['Fw', 'Ft', 'Fn', 'Fh'],
  barb: ['Bh', 'Bn', 'Bp'],
  teeth: ['Tn', 'Tw', 'Th', 'Tf'],
  fit: ['FitSide', 'FitL', 'FitTol', 'FitChX', 'FitChY'],
};

function parseKey(key) {
  let m;
  if ((m = /^s(\d+)\.end\.(.+)$/.exec(key))) return { kind: 'end', i: +m[1], leaf: m[2] };
  if ((m = /^s(\d+)\.(id|w|l)$/.exec(key))) return { kind: 'section', i: +m[1], leaf: m[2] };
  if ((m = /^b(\d+)\.(\w+)$/.exec(key))) return { kind: 'bend', i: +m[1], leaf: m[2] };
  return null;
}
// String-valued (enum) leaves bypass numeric coercion in set(): the end type and
// the fit's Inside/Outside toggle.
const isEnumKey = (key) => /\.end\.(type|FitSide)$/.test(key);
function getP(params, key) {
  const k = parseKey(key); if (!k || !params) return undefined;
  if (k.kind === 'section') return params.sections[k.i] && params.sections[k.i][k.leaf];
  if (k.kind === 'bend') return params.bends[k.i] && params.bends[k.i][k.leaf];
  const end = params.sections[k.i] && params.sections[k.i].end;
  return end && end[k.leaf];
}
function setLeaf(params, key, v) {
  const k = parseKey(key); if (!k) return;
  if (k.kind === 'section') params.sections[k.i][k.leaf] = v;
  else if (k.kind === 'bend') params.bends[k.i][k.leaf] = v;
  else params.sections[k.i].end[k.leaf] = v;
}
function limitOf(key) {
  const k = parseKey(key); if (!k) return null;
  if (k.kind === 'section') return geo.SECTION_LIMITS[k.leaf];
  if (k.kind === 'bend') return geo.BEND_LIMITS[k.leaf];
  return geo.END_LIMITS[k.leaf] || null;   // end.type has no numeric limit
}

function set(key, raw) {
  let v = raw;
  if (!isEnumKey(key)) {
    if (raw === '') return;
    v = Number(raw);
    if (!isFinite(v)) return;
    const lim = limitOf(key);
    if (lim) v = clamp(v, lim[0], lim[1]);
  }
  // Snapshot the params at the start of an edit gesture and work forward from it
  // each tick (rather than from the last committed values). This way any value
  // normalize clamps down mid-drag - barb count when a section shortens, the
  // sibling radial chamfer, a flange that no longer fits, ... - recovers if the
  // drag reverses. The snapshot is dropped when the gesture ends (the input's
  // `change` event), so a clamp only becomes permanent once the slider is let go.
  if (!dragBase || dragKey !== key) { dragBase = state.params; dragKey = key; }
  const next = geo.cloneParams(dragBase);
  setLeaf(next, key, v);
  // The outer (ChY) and bore (ChIY) radial chamfers share the wall thickness:
  // raising one trims the other so together they stay within the wall, and the
  // control just edited wins (measured from the drag's start, so reversing
  // restores the sibling).
  const cm = /^s(\d+)\.end\.(ChY|ChIY)$/.exec(key);
  if (cm) {
    const i = +cm[1], sib = cm[2] === 'ChY' ? 'ChIY' : 'ChY';
    const wall = next.sections[i].w;
    next.sections[i].end[sib] = clamp(round(wall - v, 2), 0, dragBase.sections[i].end[sib]);
  }
  commit(geo.normalize(next).p, key);
}

// Copy one section's full definition (diameter, wall, length, and - when both
// are extremes - the end treatment) onto another. Interior sections have no end.
function copySection(target, source) {
  const p = geo.cloneParams(state.params);
  const s = p.sections[source], t = p.sections[target];
  if (!s || !t) return;
  t.id = s.id; t.w = s.w; t.l = s.l;
  if (t.end && s.end) t.end = { ...s.end };
  commit(geo.normalize(p).p, 'copy-' + target);
}

// Set a bend value (idm/w2) from its two neighboring sections' id/w:
// 'left'/'right' copy that neighbor's value, 'between' uses their average.
function setBend(bendIndex, leaf, secLeaf, mode) {
  const a = state.params.sections[bendIndex][secLeaf], b = state.params.sections[bendIndex + 1][secLeaf];
  const v = mode === 'left' ? a : mode === 'right' ? b : (a + b) / 2;
  const p = geo.cloneParams(state.params);
  p.bends[bendIndex][leaf] = v;
  commit(geo.normalize(p).p, 'b' + bendIndex + '.' + leaf + '-' + mode);
}

// Structural edits: splice sections/bends, then re-home the two end treatments
// onto the geometric extremes (they belong only to the first & last sections).
function structuralEdit(mutate, tag) {
  const p = geo.cloneParams(state.params);
  const firstEnd = p.sections[0].end;
  const lastEnd = p.sections[p.sections.length - 1].end;
  mutate(p);
  for (const s of p.sections) delete s.end;
  p.sections[0].end = firstEnd || geo.defaultEnd();
  p.sections[p.sections.length - 1].end = lastEnd || geo.defaultEnd();
  commit(geo.normalize(p).p, tag);
}
// A straight (0°) transition bend whose diameter/wall match a section.
function bendFrom(sec) {
  const nb = geo.defaultBend();
  nb.ang = 0; nb.idm = sec.id; nb.w2 = sec.w;
  return nb;
}
// Add a section, copying the section it was created from. The first section
// prepends (the copy becomes the new first, shifting the rest along); the last
// appends. Only first/last sections expose the button, so these are the only
// cases. structuralEdit re-homes the end treatments onto the new extremes.
function addSectionBefore(i) {
  structuralEdit((p) => {
    const sec = p.sections[i];
    p.sections.splice(i, 0, { id: sec.id, w: sec.w, l: sec.l });
    p.bends.splice(i, 0, bendFrom(sec));            // connects new section i and old (now i+1)
  }, 'add-before-' + i);
}
function addSectionAfter(i) {
  structuralEdit((p) => {
    const sec = p.sections[i];
    p.sections.splice(i + 1, 0, { id: sec.id, w: sec.w, l: sec.l });
    p.bends.splice(i, 0, bendFrom(sec));            // connects old section i and new (i+1)
  }, 'add-after-' + i);
}
function removeSection(i) {
  if (state.params.sections.length <= 2) return;   // keep at least two
  structuralEdit((p) => {
    p.sections.splice(i, 1);
    p.bends.splice(i > 0 ? i - 1 : 0, 1);           // drop an adjacent bend
  }, 'remove-' + i);
}

function geometry() {
  if (!state.params) return null;
  const sig = JSON.stringify(state.params);
  if (sig !== cachedSig) {
    cachedSig = sig;
    cachedG = geo.build(state.params, 64); // 64-segment preview
  }
  return cachedG;
}

// ── Actions ─────────────────────────────────────────────────────────────────
// Rotation matrix (row-major, 9 floats) that turns unit vector `a` onto unit
// `b` (Rodrigues). Used to lay an end face flat on the print bed.
function rotationBetween(a, b) {
  const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (c > 0.999999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -0.999999) { // 180°: rotate about any axis ⟂ a
    let ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let k = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]];
    const kl = Math.hypot(k[0], k[1], k[2]); k = [k[0] / kl, k[1] / kl, k[2] / kl];
    return [
      2 * k[0] * k[0] - 1, 2 * k[0] * k[1], 2 * k[0] * k[2],
      2 * k[1] * k[0], 2 * k[1] * k[1] - 1, 2 * k[1] * k[2],
      2 * k[2] * k[0], 2 * k[2] * k[1], 2 * k[2] * k[2] - 1,
    ];
  }
  const s = 1 / (1 + c), vx = v[0], vy = v[1], vz = v[2];
  return [
    1 + s * (-vz * vz - vy * vy), -vz + s * (vx * vy), vy + s * (vx * vz),
    vz + s * (vx * vy), 1 + s * (-vz * vz - vx * vx), -vx + s * (vy * vz),
    -vy + s * (vx * vz), vx + s * (vy * vz), 1 + s * (-vy * vy - vx * vx),
  ];
}

// Return positions for export in the chosen orientation. 'left'/'right' rotate
// the mesh so that end's face rests flat on the bed (Z = 0), centerd in X/Y;
// 'asis' keeps the design orientation.
function orientPositions(positions, g, orient) {
  if (orient !== 'left' && orient !== 'right') return positions;
  const T = (orient === 'left' ? g.endPoints[0] : g.endPoints[1]).T;
  const sgn = orient === 'left' ? -1 : 1;              // outward face normal
  const R = rotationBetween([sgn * T[0], sgn * T[1], sgn * T[2]], [0, 0, -1]);
  const out = new Float32Array(positions.length);
  let minZ = Infinity, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const rx = R[0] * x + R[1] * y + R[2] * z;
    const ry = R[3] * x + R[4] * y + R[5] * z;
    const rz = R[6] * x + R[7] * y + R[8] * z;
    out[i] = rx; out[i + 1] = ry; out[i + 2] = rz;
    if (rz < minZ) minZ = rz;
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (let i = 0; i < out.length; i += 3) { out[i] -= cx; out[i + 1] -= cy; out[i + 2] -= minZ; }
  return out;
}

// Rebuild at export resolution (160 segments), orient, and download the blob.
function exportModel(ext, serialize, orient) {
  const hi = geo.build(state.params, 160);
  const positions = orientPositions(hi.positions, hi, orient);
  const blob = serialize(positions, hi.indices, 'pipe-adapter');
  const secs = state.params.sections;
  const nb = state.params.bends.length;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pipe-' + secs[0].id + 'to' + secs[secs.length - 1].id + '-' + nb + (nb === 1 ? 'bend.' : 'bends.') + ext;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const downloadSTL = (orient) => exportModel('stl', geo.toBinarySTL, orient);
const download3MF = (orient) => exportModel('3mf', geo.to3MF, orient);

// ── Help modal ──────────────────────────────────────────────────────────────
// Minimal, dependency-free Markdown → HTML: headings, lists, blockquotes, rules,
// paragraphs, and inline bold/italic/code/links. Enough for HELP.md.
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push('<' + list.type + '>' + list.items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</' + list.type + '>'); list = null; } };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flushPara(); flushList(); }
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); }
    else if (/^([-*_])\1\1+$/.test(line.trim())) { flushPara(); flushList(); out.push('<hr>'); }
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); }
    else if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); }
    // An indented, non-blank line while a list is open is the wrapped continuation
    // of the current list item - fold it back in rather than starting a paragraph.
    else if (list && /^\s/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); }
    else { flushList(); para.push(line.trim()); }
  }
  flushPara(); flushList();
  return out.join('\n');
}

let helpLoaded = false;
async function openHelp() {
  if (!helpLoaded) {
    try {
      const md = await fetch('HELP.md', { cache: 'no-cache' }).then((r) => r.text());
      el.helpBody.innerHTML = renderMarkdown(md);
    } catch (e) {
      el.helpBody.innerHTML = '<p>Could not load help.</p>';
    }
    helpLoaded = true;
  }
  el.helpBackdrop.hidden = false;
}
function closeHelp() { el.helpBackdrop.hidden = true; }

// ── Control model ───────────────────────────────────────────────────────────
function numCtrl(key, label, hint, step, integer, maxOverride) {
  const lim = limitOf(key);
  // The slider steps coarsely (`step`); the number field allows fine 0.1 entry,
  // except integer counts, which stay whole. `maxOverride` lets a control cap
  // below its static limit (e.g. chamfer depth capped at the section length).
  return { kind: 'num', key, label, hint, min: lim[0], max: maxOverride != null ? maxOverride : lim[1], step, numStep: integer ? 1 : 0.1 };
}

// An "Outer Ø" slider that edits wall thickness underneath. The stored model
// keeps wall - geometry and every constraint depend on it - but this control
// shows and steers the outer diameter (inner + 2·wall), converting back to wall
// on edit. `getInner(p)` yields the effective inner Ø (blends across a bend when
// Continuous Ø is on). Bounds derive from the wall limits at that inner diameter.
function odCtrl(wallKey, getInner) {
  const inner = getInner(state.params);
  const wlim = limitOf(wallKey);
  return {
    kind: 'num', derived: 'od', key: wallKey + '.OD', wallKey, getInner,
    label: 'Outer Ø', hint: 'mm', step: 0.2, numStep: 0.1,   // 0.2 Ø ↔ 0.1 wall
    min: round(inner + 2 * wlim[0], 1),
    max: round(inner + 2 * wlim[1], 1),
  };
}
// Displayed outer diameter for an Outer Ø control.
function odValue(c, p) { return round(c.getInner(p) + 2 * getP(p, c.wallKey), 1); }
// Edit an Outer Ø control: convert the entered diameter to wall, route to set().
function setOuter(c, raw) {
  if (raw === '') return;
  const od = Number(raw); if (!isFinite(od)) return;
  set(c.wallKey, round((od - c.getInner(state.params)) / 2, 2));
}

// A bend's effective inner Ø: the blend of its two neighbors when Continuous Ø
// is on, else its fixed idm. A section's inner Ø is just its id.
const sectionInner = (i) => (p) => p.sections[i].id;
const bendInner = (i) => (p) => p.bends[i].idmSmooth ? (p.sections[i].id + p.sections[i + 1].id) / 2 : p.bends[i].idm;
const bendWall = (i) => (p) => p.bends[i].w2Smooth ? (p.sections[i].w + p.sections[i + 1].w) / 2 : p.bends[i].w2;

// End-treatment controls for section index `i` (must be a first/last section).
function endControls(i) {
  const sec = state.params.sections[i];
  const end = sec.end;
  const pre = 's' + i + '.end.';
  const list = [{
    kind: 'enum', key: pre + 'type', label: 'End treatment', hint: '',
    options: [
      { value: 'plain', label: 'Plain' },
      { value: 'chamfer', label: 'Chamfer' },
      { value: 'flange', label: 'Flange' },
      { value: 'barb', label: 'Hose Barb' },
      { value: 'teeth', label: 'Teeth' },
      { value: 'fit', label: 'Fit (slip joint)' },
    ],
  }];
  if (end.type === 'chamfer') {
    const secLen = sec.l;   // along-axis cap
    const wall = sec.w;     // radial cap: each maxes at the wall; raising one trims the other (see set)
    list.push(numCtrl(pre + 'ChX', 'Outer chamfer — X, along axis', 'mm', 0.1, false, secLen));
    list.push(numCtrl(pre + 'ChY', 'Outer chamfer — Y, radial', 'mm', 0.1, false, wall));
    list.push(numCtrl(pre + 'ChIX', 'Bore chamfer — X, along axis', 'mm', 0.1, false, secLen));
    list.push(numCtrl(pre + 'ChIY', 'Bore chamfer — Y, radial', 'mm', 0.1, false, wall));
  }
  if (end.type === 'flange') {
    list.push(numCtrl(pre + 'Fw', 'Flange width', 'mm', 0.5));
    list.push(numCtrl(pre + 'Ft', 'Flange thickness', 'mm', 0.5));
    list.push(numCtrl(pre + 'Fn', 'Number of holes', '', 1, true));
    list.push(numCtrl(pre + 'Fh', 'Hole size', 'ø mm', 0.5));
  }
  if (end.type === 'barb') {
    list.push(numCtrl(pre + 'Bh', 'Barb height', 'mm', 0.1));
    list.push(numCtrl(pre + 'Bn', 'Barb count', '', 1, true));
    list.push(numCtrl(pre + 'Bp', 'Barb pitch', 'mm', 0.5));
  }
  if (end.type === 'teeth') {
    const n = Math.max(1, end.Tn);
    const O = (sec.id + 2 * sec.w) / 2;
    const widthMax = Math.min(geo.END_LIMITS.Tw[1], 360 / n);            // teeth can't sum past the circle
    const halfArc = (end.Tw * Math.PI / 180 / 2) * O;
    const filletMax = Math.min(geo.END_LIMITS.Tf[1], 2.5 * end.Th, 4 * halfArc);
    list.push(numCtrl(pre + 'Tn', 'Number of teeth', '', 1, true));
    list.push(numCtrl(pre + 'Tw', 'Tooth width', 'deg', 1, false, widthMax));
    list.push(numCtrl(pre + 'Th', 'Tooth height', 'mm', 0.1));
    list.push(numCtrl(pre + 'Tf', 'Edge fillet', 'mm', 0.1, false, filletMax));
  }
  if (end.type === 'fit') {
    // A telescoping stub for sliding two pipes together. Inside → a spigot that
    // plugs into the mate; Outside → a socket the mate plugs into. The lead-in
    // chamfer is on the outer tip (spigot) or the bore mouth (socket).
    list.push({
      kind: 'enum', key: pre + 'FitSide', label: 'Fit', hint: '',
      options: [
        { value: 'inside', label: 'Inside (spigot — plugs in)' },
        { value: 'outside', label: 'Outside (socket — receives)' },
      ],
    });
    list.push(numCtrl(pre + 'FitL', 'Fit length', 'mm', 0.5, false, Math.max(0, sec.l - 1)));
    list.push(numCtrl(pre + 'FitTol', 'Tolerance (clearance)', 'mm', 0.05));
    list.push(numCtrl(pre + 'FitChX', 'Lead-in chamfer — X, along axis', 'mm', 0.1, false, end.FitL));
    list.push(numCtrl(pre + 'FitChY', 'Lead-in chamfer — Y, radial', 'mm', 0.1, false, sec.w));
  }
  return list;
}

// Build the panel groups: an interleaved chain of section and bend cards.
function groupModel(g) {
  const groups = [];
  const sections = state.params.sections;
  const bends = state.params.bends;
  const N = sections.length;

  for (let i = 0; i < N; i++) {
    const isFirst = i === 0, isLast = i === N - 1;
    // Copy-from-neighbor buttons (dims + end treatment).
    const copyActs = [];
    if (i > 0) copyActs.push({ label: 'Mimic Previous Section', title: 'Copy the previous section onto this one', onClick: () => copySection(i, i - 1) });
    if (i < N - 1) copyActs.push({ label: 'Mimic Next Section', title: 'Copy the next section onto this one', onClick: () => copySection(i, i + 1) });

    const controls = [
      ...(copyActs.length ? [{ kind: 'actions', key: 's' + i + '.copy', actions: copyActs }] : []),
      numCtrl('s' + i + '.id', 'Inner Ø', 'mm', 0.5),
      odCtrl('s' + i + '.w', sectionInner(i)),
      { kind: 'readout', key: 's' + i + '.outer', getWall: (p) => p.sections[i].w },
      numCtrl('s' + i + '.l', 'Length', 'mm', 1),
      ...(isFirst || isLast ? endControls(i) : []),
    ];
    // Only the two end sections can add or remove: the first prepends a new
    // first section, the last appends a new last section. (When N === 2 a section
    // is both first and last; each still gets a single, correctly-directed add.)
    groups.push({
      id: 's' + i, kind: 'section', index: i,
      tag: String(i + 1), title: 'Section ' + (i + 1),
      onAdd: isFirst ? () => addSectionBefore(0) : isLast ? () => addSectionAfter(i) : null,
      addTitle: isFirst ? 'Add a new first section (copies this one)' : 'Add a new last section (copies this one)',
      onRemove: ((isFirst || isLast) && N > 2) ? () => removeSection(i) : null,
      controls,
    });

    if (i < N - 1) {
      const bend = bends[i];
      const bpre = 'b' + i + '.';
      groups.push({
        id: 'b' + i, kind: 'bend', index: i,
        tag: '∿', title: 'Bend ' + (i + 1),
        presets: [-90, -45, -22.5, -11.25, 0, 11.25, 22.5, 45, 90], presetKey: bpre + 'ang',
        controls: [
          numCtrl(bpre + 'ang', 'Bend angle', 'deg', 1),
          numCtrl(bpre + 'l2', g.path.bends[i] && g.path.bends[i].bend ? 'Inner-bend face arc' : 'Length', 'mm', 1),
          { kind: 'toggle', key: bpre + 'idmSmooth', label: 'Continuous Ø', title: 'Blend the inner diameter smoothly across this bend' },
          ...(bend.idmSmooth ? [] : [
            numCtrl(bpre + 'idm', 'Inner Ø', 'mm', 0.5),
            { kind: 'actions', key: bpre + 'idmmatch', actions: [
              { label: 'Set to Left', title: 'Match the left neighbor\'s inner diameter', onClick: () => setBend(i, 'idm', 'id', 'left') },
              { label: 'Set in Between', title: 'Average of the two neighbors\' inner diameters', onClick: () => setBend(i, 'idm', 'id', 'between') },
              { label: 'Set to Right', title: 'Match the right neighbor\'s inner diameter', onClick: () => setBend(i, 'idm', 'id', 'right') },
            ] },
          ]),
          { kind: 'toggle', key: bpre + 'w2Smooth', label: 'Continuous thickness', title: 'Blend the wall thickness smoothly across this bend' },
          ...(bend.w2Smooth ? [] : [
            odCtrl(bpre + 'w2', bendInner(i)),
            { kind: 'actions', key: bpre + 'w2match', actions: [
              { label: 'Set to Left', title: 'Match the left neighbor\'s wall thickness', onClick: () => setBend(i, 'w2', 'w', 'left') },
              { label: 'Set in Between', title: 'Average of the two neighbors\' wall thicknesses', onClick: () => setBend(i, 'w2', 'w', 'between') },
              { label: 'Set to Right', title: 'Match the right neighbor\'s wall thickness', onClick: () => setBend(i, 'w2', 'w', 'right') },
            ] },
          ]),
          { kind: 'readout', key: bpre + 'outer', getWall: bendWall(i) },
        ],
      });
    }
  }
  return groups;
}

// ── Panel rendering ─────────────────────────────────────────────────────────
// The panel structure is rebuilt only when the set of controls changes (layout,
// end-treatment types). Plain value changes update inputs in place, so a slider
// drag or a number edit keeps focus and pointer capture.
let panelSig = '';
const collapsedGroups = new Set();   // group ids whose body is collapsed (persists across rebuilds)

// Collapse or expand every group at once (the panel toolbar). Updates the live
// DOM and keeps `collapsedGroups` in sync so the state survives a panel rebuild.
function setAllCollapsed(collapsed) {
  collapsedGroups.clear();
  el.panelGrid.querySelectorAll('.group').forEach((section) => {
    section.classList.toggle('collapsed', collapsed);
    const toggle = section.querySelector('.group-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) collapsedGroups.add(section.getAttribute('data-group-id'));
  });
}

// Which pipe segment the pointer is over (drives the schematic highlight):
// null, or { kind: 'section' | 'bend', index }.
let hoveredSection = null;
// User zoom/pan for the diagram (screen-space, on top of the base fit). Reset to
// a fit whenever the diagram is expanded so it always opens framed.
const diagramView = { zoom: 1, panX: 0, panY: 0 };
// The view is "at default" when neither zoomed nor panned; the reset-view button
// shows only when it is not. Call this after any change to diagramView.
function syncDiagramReset() {
  const atDefault = diagramView.zoom === 1 && diagramView.panX === 0 && diagramView.panY === 0;
  if (el.diagramReset) el.diagramReset.hidden = atDefault;
}
const resetDiagramView = () => {
  diagramView.zoom = 1; diagramView.panX = 0; diagramView.panY = 0;
  syncDiagramReset();
};
// When expanded, reserve room at the bottom of the drawing for the floating
// coffee button so the diagram content clears it.
const drawSchematic = () => {
  drawDiagram(el.diagram, cachedG, hoveredSection, swapped ? 64 : 0, state.units, diagramView);
};

// Lift the docked schematic card above the copyright/coffee row, but only when
// the two would actually overlap (they're at opposite bottom corners, so this
// only happens once the viewport is narrow enough for them to meet). Measured
// rather than keyed off a fixed breakpoint so the card sits low whenever there's
// room. No-op while expanded - the swapped card fills the viewer.
function updateSchematicPlacement() {
  const card = el.schematic, br = el.overlayBr;
  if (!card) return;
  card.classList.remove('raised');   // always measure from the natural (low) position
  if (swapped || !br) return;
  const a = card.getBoundingClientRect(), b = br.getBoundingClientRect();
  const GAP = 12;
  const overlap = a.right + GAP > b.left && a.left < b.right + GAP &&
                  a.bottom > b.top && a.top < b.bottom;
  if (overlap) card.classList.add('raised');
}

function h(tag, cls, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function buildPanel(groups) {
  el.panelGrid.replaceChildren();
  for (const g of groups) {
    const section = h('section', 'group', { 'data-group-id': g.id });
    const collapsed = collapsedGroups.has(g.id);
    if (collapsed) section.classList.add('collapsed');

    // Hovering a group's controls highlights that segment in the schematic.
    const seg = { kind: g.kind, index: g.index };
    section.addEventListener('mouseenter', () => { hoveredSection = seg; drawSchematic(); });
    section.addEventListener('mouseleave', () => { if (hoveredSection === seg) { hoveredSection = null; drawSchematic(); } });

    // The tag + title form a toggle button that collapses the section body.
    const head = h('div', 'group-head');
    const toggle = h('button', 'group-toggle', { type: 'button', 'aria-expanded': String(!collapsed) });
    const caret = h('span', 'group-caret'); caret.textContent = '▾';
    const tag = h('span', 'group-tag'); tag.textContent = g.tag;
    const title = h('span', 'group-title'); title.textContent = g.title;
    toggle.append(caret, tag, title);
    toggle.addEventListener('click', () => {
      const nowCollapsed = !collapsedGroups.has(g.id);
      if (nowCollapsed) collapsedGroups.add(g.id); else collapsedGroups.delete(g.id);
      section.classList.toggle('collapsed', nowCollapsed);
      toggle.setAttribute('aria-expanded', String(!nowCollapsed));
    });
    head.append(toggle, h('span', 'group-rule'));
    // Section cards can add a section after themselves, or (when more than two
    // remain) remove themselves.
    if (g.onRemove) {
      const btn = h('button', 'btn btn-secondary group-mirror', { type: 'button', title: 'Remove this section' });
      btn.textContent = '✕';
      btn.addEventListener('click', g.onRemove);
      head.append(btn);
    }
    if (g.onAdd) {
      const btn = h('button', 'btn btn-secondary group-mirror', { type: 'button', title: g.addTitle || 'Add a section' });
      btn.textContent = '+ Section';
      btn.addEventListener('click', g.onAdd);
      head.append(btn);
    }
    section.append(head);

    const body = h('div', 'group-body');
    if (g.presets) {
      const row = h('div', 'presets');
      for (const deg of g.presets) {
        const btn = h('button', 'btn', { type: 'button', 'data-preset': String(deg), 'data-preset-key': g.presetKey });
        btn.textContent = deg + '°';
        btn.addEventListener('click', () => set(g.presetKey, deg));
        row.append(btn);
      }
      body.append(row);
    }

    for (const c of g.controls) {
      if (c.kind === 'actions') {
        const row = h('div', 'field-actions');
        for (const act of c.actions) {
          const btn = h('button', 'btn btn-secondary field-action', { type: 'button', title: act.title || '' });
          btn.textContent = act.label;
          btn.addEventListener('click', act.onClick);
          row.append(btn);
        }
        body.append(row);
        continue;
      }
      if (c.kind === 'readout') {
        body.append(h('div', 'field-readout', { 'data-readout': c.key }));
        continue;
      }
      if (c.kind === 'toggle') {
        const label = h('label', 'field-toggle', { title: c.title || '' });
        const cb = h('input', null, { type: 'checkbox', 'data-toggle': c.key });
        cb.checked = !!getP(state.params, c.key);
        cb.addEventListener('change', (e) => set(c.key, e.target.checked ? 1 : 0));
        const span = document.createElement('span'); span.textContent = c.label;
        label.append(cb, span);
        body.append(label);
        continue;
      }
      const field = h('div', 'field');
      const label = document.createElement('label');
      const name = h('span', 'field-name'); name.textContent = c.label;
      name.setAttribute('data-name', c.key);
      const hint = h('span', 'field-hint'); hint.textContent = dispHint(c);
      label.append(name, hint);
      field.append(label);

      if (c.kind === 'enum') {
        const sel = h('select', 'input field-enum', { 'data-sel': c.key });
        for (const o of c.options) {
          const opt = document.createElement('option');
          opt.value = o.value; opt.textContent = o.label;
          sel.append(opt);
        }
        sel.value = getP(state.params, c.key);
        sel.addEventListener('change', (e) => set(c.key, e.target.value));
        field.append(sel);
      } else {
        // Length controls display in the active unit; bounds, step and value are
        // converted for the widgets while set()/setOuter() convert edits back to mm.
        const conv = isLenCtrl(c);
        const dMin = conv ? dispBound(c.min, 'min') : c.min;
        const dMax = conv ? dispBound(c.max, 'max') : c.max;
        // Inch mode steps both widgets by 1/32"; mm mode keeps the per-control steps.
        const dStep = (conv && inchMode()) ? SNAP_IN : c.step;
        const dNumStep = (conv && inchMode()) ? SNAP_IN : c.numStep;
        const wrap = h('div', 'field-num');
        const range = h('input', null, {
          type: 'range', min: dMin, max: dMax, step: dStep, 'data-range': c.key,
        });
        const num = h('input', 'input field-num-input', {
          type: 'number', min: dMin, max: dMax, step: dNumStep, 'data-num': c.key,
        });
        const rawInit = c.derived === 'od' ? odValue(c, state.params) : getP(state.params, c.key);
        const initVal = conv ? toDisp(rawInit) : rawInit;
        range.value = initVal;
        num.value = initVal;
        // Convert the entered number back to mm - snapping to the nearest 1/32"
        // first in inch mode - but pass '' through untouched so set()/setOuter()
        // can ignore an empty field mid-edit (rather than see 0).
        const parse = (raw) => {
          if (raw === '' || !conv) return raw;
          const v = Number(raw);
          return fromDisp(inchMode() && isFinite(v) ? snapIn(v) : v);
        };
        const onInput = c.derived === 'od'
          ? (e) => setOuter(c, parse(e.target.value))
          : (e) => set(c.key, parse(e.target.value));
        const onChange = () => { dragBase = null; dragKey = null; };   // gesture ended - finalize any clamped-down values
        range.addEventListener('input', onInput);
        range.addEventListener('change', onChange);
        num.addEventListener('input', onInput);
        num.addEventListener('change', onChange);
        wrap.append(range, num);
        field.append(wrap);
      }
      body.append(field);
    }
    section.append(body);
    el.panelGrid.append(section);
  }
}

function updatePanelValues(groups) {
  const p = state.params;
  // control values
  for (const g of groups) {
    for (const c of g.controls) {
      if (c.kind === 'actions') continue;
      if (c.kind === 'toggle') {
        const cb = el.panelGrid.querySelector(`[data-toggle="${c.key}"]`);
        const on = !!getP(p, c.key);
        if (cb && cb.checked !== on) cb.checked = on;
        continue;
      }
      if (c.kind === 'readout') {
        const rd = el.panelGrid.querySelector(`[data-readout="${c.key}"]`);
        // Blends the neighbors when Continuous thickness is on (see getWall).
        const wall = toDisp(c.getWall(p));
        if (rd) rd.textContent = 'wall ' + wall.toFixed(inchMode() ? 3 : 1) + ' ' + unitSuffix();
        continue;
      }
      if (c.kind === 'enum') {
        const sel = el.panelGrid.querySelector(`[data-sel="${c.key}"]`);
        const cur = String(getP(p, c.key));
        if (sel && sel.value !== cur) sel.value = cur;
      } else {
        const conv = isLenCtrl(c);
        const range = el.panelGrid.querySelector(`[data-range="${c.key}"]`);
        const num = el.panelGrid.querySelector(`[data-num="${c.key}"]`);
        const rawVal = c.derived === 'od' ? odValue(c, p) : getP(p, c.key);
        const val = conv ? toDisp(rawVal) : rawVal;
        const v = String(val),
          mx = String(conv ? dispBound(c.max, 'max') : c.max),
          mn = String(conv ? dispBound(c.min, 'min') : c.min);
        // c.min/c.max can be dynamic (chamfer depth tracks the section length; an
        // Outer Ø control's bounds track the inner Ø), so keep the input bounds in
        // sync. Set them before the value so the browser doesn't clamp a
        // still-valid value against a stale bound.
        if (range) { if (range.max !== mx) range.max = mx; if (range.min !== mn) range.min = mn; if (range.value !== v) range.value = v; }
        // Skip the focused number field so we don't fight the caret mid-edit.
        if (num) { if (num.max !== mx) num.max = mx; if (num.min !== mn) num.min = mn; if (num !== document.activeElement && num.value !== v) num.value = v; }
      }
      // live label for each bend's B control (arc vs length)
      if (/\.l2$/.test(c.key)) {
        const nm = el.panelGrid.querySelector(`[data-name="${c.key}"]`);
        if (nm) nm.textContent = c.label;
      }
    }
  }
  // angle presets - each keyed to its own bend
  el.panelGrid.querySelectorAll('[data-preset]').forEach((btn) => {
    const key = btn.getAttribute('data-preset-key');
    const active = Number(getP(p, key)) === Number(btn.getAttribute('data-preset'));
    btn.classList.toggle('btn-primary', active);
    btn.classList.toggle('btn-secondary', !active);
  });
}

// ── Layout ──────────────────────────────────────────────────────────────────
// Below this viewport width there isn't room for a side panel, so it's forced
// below the viewer regardless of the user's choice (which is remembered and
// restored once the window is wide enough again).
const FORCE_BELOW_MAXWIDTH = 900;
const effectiveLayout = () => (window.innerWidth < FORCE_BELOW_MAXWIDTH ? 'bottom' : state.layout);

let appliedLayout = null;
function applyLayout() {
  const lay = effectiveLayout();
  el.body.style.flexDirection = lay === 'right' ? 'row-reverse'
    : lay === 'bottom' ? 'column-reverse' : 'row';
  el.panel.style.width = lay === 'bottom' ? '100%' : '316px';
  el.panel.style.height = lay === 'bottom' ? '370px' : '100%';
  el.panelGrid.style.gridAutoFlow = lay === 'bottom' ? 'column' : 'row';
  el.panelGrid.style.gridAutoColumns = lay === 'bottom' ? 'minmax(236px, 1fr)' : 'auto';
  // Collapse/Expand-all bar only makes sense for the vertical left/right panel.
  el.panelToolbar.style.display = lay === 'bottom' ? 'none' : '';
  // Minimize the docked cross-section diagram on the same breakpoint (CSS keys
  // the collapse off this class, so the two always happen together).
  el.viewer.classList.toggle('panel-below', lay === 'bottom');
  // The panel is only forced below (there's no manual "below" option), so the
  // left/right switcher is irrelevant then - hide it.
  el.layoutSwitch.style.display = lay === 'bottom' ? 'none' : '';
  // The mm/in toggle's tighter margins on narrow screens live in app.css (they
  // track viewport width, not the stored layout, so CSS owns them).
  el.layoutSwitch.querySelectorAll('button').forEach((btn) => {
    const active = btn.getAttribute('data-layout') === lay;
    btn.classList.toggle('btn-primary', active);
    btn.classList.toggle('btn-ghost', !active);
  });
  // A change in the effective layout (e.g. crossing the width threshold) reshapes
  // the viewer, so re-frame the part to fit it.
  if (lay !== appliedLayout) { appliedLayout = lay; framed = false; }
}

function applyUnits() {
  el.unitsSwitch.querySelectorAll('button').forEach((btn) => {
    const active = btn.getAttribute('data-units') === state.units;
    btn.classList.toggle('btn-primary', active);
    btn.classList.toggle('btn-ghost', !active);
  });
}

// ── Master render ───────────────────────────────────────────────────────────
function render() {
  const g = geometry();
  const mm = (v) => round(v, 1).toFixed(1);
  const inMode = inchMode(), uSuf = unitSuffix();
  // Formatters that reproduce the mm-mode output exactly and only diverge in inch
  // mode: dv for measured lengths (was 1-dp mm), dRaw for stored diameters.
  const dv = (v) => inMode ? (v / MM_PER_IN).toFixed(3) : mm(v);
  const dRaw = (v) => inMode ? (v / MM_PER_IN).toFixed(3) : v;

  // header + overlays
  el.undo.disabled = !undoStack.length;
  el.redo.disabled = !redoStack.length;
  applyLayout();
  applyUnits();

  if (g) {
    const p = state.params;
    const secs = p.sections, nBend = p.bends.length;
    el.summary.textContent =
      'ø' + dRaw(secs[0].id) + ' → ø' + dRaw(secs[secs.length - 1].id) + '  ·  ' +
      nBend + (nBend === 1 ? ' bend' : ' bends') + '  ·  ' + dv(g.path.total) + ' ' + uSuf + ' along centerline';
    el.bbox.textContent =
      dv(g.bbox.size[0]) + ' × ' + dv(g.bbox.size[1]) + ' × ' + dv(g.bbox.size[2]) + ' ' + uSuf;
    el.mesh.textContent = g.triCount.toLocaleString() + ' facets in preview · 160-segment export';

    // clamp notes
    el.notes.replaceChildren();
    for (const n of g.notes) {
      const div = h('div', 'note'); div.textContent = n;
      el.notes.append(div);
    }

    // panel: rebuild only when the control set changes (section count, end types,
    // and each bend's continuity toggles all affect which controls exist).
    const groups = groupModel(g);
    const sig = [
      state.units, state.layout, secs.length,
      secs[0].end.type, secs[secs.length - 1].end.type,
      p.bends.map((b) => b.idmSmooth + '' + b.w2Smooth).join(','),
    ].join('|');
    if (sig !== panelSig) { buildPanel(groups); panelSig = sig; }
    updatePanelValues(groups);
  } else {
    el.summary.textContent = 'loading geometry engine...';
  }

  // reflect into the 3D view and schematic
  if (renderer) syncMesh();
  drawSchematic();
}

// ── three.js ────────────────────────────────────────────────────────────────
// Build the three.js material for a render style. Wireframe uses an unlit basic
// material for crisp lines; normals uses the geometry's normals for color.
// Each PBR render style gets its own set of tileable maps, sampled through the
// geometry's UVs (u = around the pipe, v = along its length):
//   • a normal map    - a tangent-space encoding of a per-style height field, so
//     the relief has direction (brushed streaks, hammer dents, throwing rings);
//   • a roughness map  - spatial shininess variation, so reflections break up;
//   • a color map     - faint tonal mottling multiplied over the base color.
// Everything derives from wrap-sampled value-noise so it tiles seamlessly. The
// per-style character lives in SURFACE below; makeMaterial just wires it up.

const TEX_S = 256;                 // texture edge (px)

// Returns a sampler (x,y in [0,1]) → value in [0,1]. Each octave is [n, amp] for
// an isotropic n×n grid, or [nx, ny, amp] for a stretched grid - a high ny with
// low nx gives horizontal streaks (brushed metal), and vice versa.
function octaveSampler(octaves) {
  const specs = octaves.map((o) => (o.length === 3 ? { nx: o[0], ny: o[1], a: o[2] } : { nx: o[0], ny: o[0], a: o[1] }));
  const grids = specs.map((s) => { const g = new Float32Array(s.nx * s.ny); for (let i = 0; i < s.nx * s.ny; i++) g[i] = Math.random(); return g; });
  const amp = specs.reduce((s, o) => s + o.a, 0);
  const ss = (t) => t * t * (3 - 2 * t);
  const oct = (g, nx, ny, x, y) => {      // bilinear, wrap-sampled → tileable
    const fx = x * nx, fy = y * ny;
    const x0 = ((Math.floor(fx) % nx) + nx) % nx, y0 = ((Math.floor(fy) % ny) + ny) % ny;
    const x1 = (x0 + 1) % nx, y1 = (y0 + 1) % ny;
    const tx = ss(fx - Math.floor(fx)), ty = ss(fy - Math.floor(fy));
    const a = g[y0 * nx + x0], b = g[y0 * nx + x1], e = g[y1 * nx + x0], f = g[y1 * nx + x1];
    return (a + (b - a) * tx) * (1 - ty) + (e + (f - e) * tx) * ty;
  };
  return (x, y) => { let v = 0; specs.forEach((s, oi) => { v += oct(grids[oi], s.nx, s.ny, x, y) * s.a; }); return v / amp; };
}

// Paint a tileable CanvasTexture from a per-pixel fn → value in [0,1] (grayscale)
// or [r,g,b] each in [0,1]. `srgb` for color data (albedo); linear otherwise.
function paintTexture(fn, { srgb = false } = {}) {
  const S = TEX_S, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
  const q = (v) => clamp(Math.round(v * 255), 0, 255);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = fn(x / S, y / S), i = (y * S + x) * 4;
    if (Array.isArray(o)) { d[i] = q(o[0]); d[i + 1] = q(o[1]); d[i + 2] = q(o[2]); }
    else { d[i] = d[i + 1] = d[i + 2] = q(o); }
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) { if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace; }
  else if (THREE.NoColorSpace !== undefined) t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

// Turn a height field h(x,y)→[0,1] into a tangent-space normal map. `strength`
// scales the slopes; wrap-sampled neighbors keep it tileable.
function buildNormalMap(height, strength) {
  const S = TEX_S, H = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) H[y * S + x] = height(x / S, y / S);
  const c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const l = H[y * S + ((x - 1 + S) % S)], r = H[y * S + ((x + 1) % S)];
    const u = H[((y - 1 + S) % S) * S + x], dn = H[((y + 1) % S) * S + x];
    let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz); nx *= inv; ny *= inv; nz *= inv;
    const i = (y * S + x) * 4;
    d[i] = Math.round((nx * 0.5 + 0.5) * 255);
    d[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    d[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (THREE.NoColorSpace !== undefined) t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

// Per-style surface character. `build()` returns height/rough/mottle fns (each
// x,y→value); `nrm` scales the derived normal map. Built once per style, cached.
const SURFACE = {
  steel: {   // polished metal: only the faintest micro-grain, mostly smooth
    nrm: 0.12,
    build() {
      const grain = octaveSampler([[16, 16, 0.28], [32, 32, 0.26], [48, 48, 0.22], [72, 72, 0.16], [104, 104, 0.08]]);
      return {
        height: (x, y) => grain(x, y),
        rough: (x, y) => 1 - grain(x, y) * 0.05,
        mottle: (x, y) => 1 - grain(x, y) * 0.02,
      };
    },
  },
  resin: {   // polished glossy SLA: essentially smooth, only a trace of grain
    nrm: 0.07,
    build() {
      const grain = octaveSampler([[16, 16, 0.28], [32, 32, 0.26], [48, 48, 0.22], [72, 72, 0.16], [104, 104, 0.08]]);
      return {
        height: (x, y) => grain(x, y),
        rough: (x, y) => 1 - grain(x, y) * 0.02,     // near-uniform, very glossy
        mottle: (x, y) => 1 - grain(x, y) * 0.01,
      };
    },
  },
  copper: {  // polished: barely-there relief, light patina
    nrm: 0.35,
    build() {
      const roll = octaveSampler([[4, 4, 0.6], [8, 8, 0.3], [16, 16, 0.15]]);
      return {
        height: (x, y) => roll(x, y),
        rough: (x, y) => 1 - roll(x, y) * 0.06,
        mottle: (x, y) => 1 - roll(x, y) * 0.04,     // subtle patina variation
      };
    },
  },
  clay: {    // matte ceramic: fine even grain, no rings
    nrm: 0.7,
    build() {
      // Many octaves weighted toward the fine end so the grain reads as random
      // stipple rather than a few big repeating blobs.
      const grain = octaveSampler([[16, 16, 0.28], [32, 32, 0.26], [48, 48, 0.22], [72, 72, 0.16], [104, 104, 0.08]]);
      return {
        height: (x, y) => grain(x, y),
        rough: (x, y) => 1 - grain(x, y) * 0.05,     // stays matte
        mottle: (x, y) => 1 - grain(x, y) * 0.07,    // gentle earthy blotching
      };
    },
  },
};

function getSurface(name) {
  if (surfaceCache[name]) return surfaceCache[name];
  const prof = SURFACE[name] || SURFACE.steel;
  const f = prof.build();
  const s = surfaceCache[name] = {
    normalMap: buildNormalMap(f.height, prof.nrm),
    roughnessMap: paintTexture(f.rough),
    map: paintTexture(f.mottle, { srgb: true }),
  };
  return s;
}

function makeMaterial(name) {
  const s = RENDER_STYLES[name] || RENDER_STYLES.steel;
  if (s.normals) return new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  if (s.wireframe) return new THREE.MeshBasicMaterial({ color: s.color, wireframe: true, side: THREE.DoubleSide });
  const surf = getSurface(name);
  return new THREE.MeshStandardMaterial({
    color: s.color, metalness: s.metalness || 0,
    roughness: s.roughness == null ? 0.5 : s.roughness,
    map: surf.map,                                  // faint tonal mottling over color
    roughnessMap: surf.roughnessMap,                // spatial shininess variation
    normalMap: surf.normalMap,                      // per-style directional relief
    normalScale: new THREE.Vector2(1, 1),
    envMapIntensity: s.env == null ? 1 : s.env,     // reflect scene.environment (see makeEnvironment)
    side: THREE.DoubleSide,
  });
}

// A soft studio environment (a vertical gradient with a few light panels), used
// as an image-based light so the metals and glossy plastics pick up reflections
// and tonal variation instead of reading flat. No geometry UVs needed.
function makeEnvironment() {
  if (!renderer || !THREE.PMREMGenerator) return null;
  try {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0.00, '#3a3e52');   // top - lighter "sky"
    g.addColorStop(0.48, '#222431');
    g.addColorStop(0.52, '#181a25');   // horizon
    g.addColorStop(1.00, '#0e0f16');   // bottom - darker "floor"
    ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
    const blob = (x, y, r, col) => {
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    };
    blob(c.width * 0.28, c.height * 0.30, 150, 'rgba(236,239,255,0.85)');   // key light
    blob(c.width * 0.70, c.height * 0.42, 120, 'rgba(150,140,220,0.55)');   // accent-tinted fill
    blob(c.width * 0.52, c.height * 0.12, 210, 'rgba(200,206,232,0.45)');   // soft overhead
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose(); tex.dispose();
    return env;
  } catch (e) { return null; }
}
function markActiveStyle() {
  document.querySelectorAll('[data-style]').forEach((b) =>
    b.classList.toggle('is-active', b.getAttribute('data-style') === renderStyle));
}
function setRenderStyle(name) {
  if (!RENDER_STYLES[name]) name = 'steel';
  renderStyle = name;
  writeHash(state.params);   // record the choice in the URL (#render=...)
  if (mesh) {
    const old = mesh.material;
    mesh.material = makeMaterial(name);
    material = mesh.material;
    if (old) old.dispose();
    draw();
  }
  markActiveStyle();
}

function initThree() {
  const host = el.stage;
  if (!host) return;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x191b28, 1);
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);

  scene.add(new THREE.HemisphereLight(0xb9bdd4, 0x14151f, 0.55));
  const key = new THREE.DirectionalLight(0xf1f2fa, 1.5);
  key.position.set(0.6, 1, 0.8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9184d9, 0.9);
  rim.position.set(-0.9, 0.3, -0.7);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0x8a90a8, 0.4);
  fill.position.set(0, -1, 0.2);
  scene.add(fill);

  scene.environment = makeEnvironment();   // image-based reflections so materials aren't flat

  material = makeMaterial(renderStyle);
  mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  scene.add(mesh);

  grid = new THREE.GridHelper(200, 20, 0x4a4e5e, 0x2c2f3b);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  orbit = { az: VIEW_HOME.az, pol: VIEW_HOME.pol, dist: 140, target: new THREE.Vector3(0, 0, 0) };

  bindControls(renderer.domElement);
  resizeObserver = new ResizeObserver(() => onResize());
  resizeObserver.observe(host);

  syncMesh(true);
  onResize();
  drawSchematic();
  // Restore a camera pose from the URL, if any (overrides the auto-framing).
  const savedView = readView();
  if (savedView) applyView(savedView);
  // one more pass once the floating card has its final rect - but a saved view
  // is explicit, so don't re-frame over it.
  setTimeout(() => { if (!hasCustomView) { framed = false; syncMesh(); } }, 60);
}

function syncMesh(first) {
  const g = geometry();
  if (!g || !mesh) return;
  const bg = new THREE.BufferGeometry();
  const pos = g.positions.slice();
  const cx = (g.bbox.min[0] + g.bbox.max[0]) / 2;
  const cz = (g.bbox.min[2] + g.bbox.max[2]) / 2;
  const my = g.bbox.min[1];
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] -= cx; pos[i + 1] -= my; pos[i + 2] -= cz;
  }
  bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (g.uv) bg.setAttribute('uv', new THREE.BufferAttribute(g.uv.slice(), 2));   // for the bump-map texture
  bg.setIndex(new THREE.BufferAttribute(g.indices.slice(), 1));
  bg.computeVertexNormals();
  // Weld the normals of each ring's UV-seam vertex pair (coincident k=0 / k=N),
  // so the extra vertex added for texturing isn't a visible shading crease.
  if (g.seamPairs) {
    const nrm = bg.attributes.normal.array, sp = g.seamPairs;
    for (let i = 0; i < sp.length; i += 2) {
      const a = sp[i] * 3, b = sp[i + 1] * 3;
      const nx = nrm[a] + nrm[b], ny = nrm[a + 1] + nrm[b + 1], nz = nrm[a + 2] + nrm[b + 2];
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[a] = nrm[b] = nx / l; nrm[a + 1] = nrm[b + 1] = ny / l; nrm[a + 2] = nrm[b + 2] = nz / l;
    }
    bg.attributes.normal.needsUpdate = true;
  }
  mesh.geometry.dispose();
  mesh.geometry = bg;

  span = Math.max(g.bbox.size[0], g.bbox.size[1], g.bbox.size[2]);
  if (first || !framed) {
    applyViewOffset();
    orbit.dist = span * FRAME_K * fitK;
    orbit.target.set(0, g.bbox.size[1] / 2, 0);
    framed = true;
  }
  const stepMm = span > 120 ? 20 : span > 60 ? 10 : 5;
  const cells = Math.max(8, Math.ceil((span * 2) / stepMm));
  if (gridKey !== stepMm + ':' + cells) {
    gridKey = stepMm + ':' + cells;
    scene.remove(grid);
    grid.geometry.dispose();
    grid = new THREE.GridHelper(stepMm * cells, cells, 0x4a4e5e, 0x2c2f3b);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    scene.add(grid);
  }
  draw();
}

function bindControls(node) {
  // Active pointers by id, so a second touch can drive a two-finger gesture
  // (pinch to zoom + drag to pan) instead of just resetting the single-drag.
  const ptrs = new Map();
  let mode = null, lx = 0, ly = 0, moved = false;
  let pinchDist = 0, pinchX = 0, pinchY = 0;   // two-finger baseline

  // Pan the orbit target by a screen delta, using the exact screen→world scale on
  // the plane through the target so a dragged point stays under the finger/cursor.
  const panBy = (dx, dy) => {
    userView = true;
    const vh = el.stage.clientHeight || 1;
    const k = (2 * orbit.dist * Math.tan((camera.fov * Math.PI) / 360)) / vh;
    const right = new THREE.Vector3().crossVectors(camera.up, dirToCam()).normalize();
    const up = new THREE.Vector3().crossVectors(dirToCam(), right).normalize();
    orbit.target.addScaledVector(right, -dx * k);
    orbit.target.addScaledVector(up, dy * k);
  };
  // (Re)capture the distance and midpoint between the two active pointers.
  const gestureBaseline = () => {
    const [a, b] = [...ptrs.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    pinchX = (a.x + b.x) / 2; pinchY = (a.y + b.y) / 2;
  };

  const down = (e) => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    node.setPointerCapture(e.pointerId);
    node.style.cursor = 'grabbing';
    if (ptrs.size === 1) {
      mode = e.shiftKey || e.button === 1 || e.button === 2 ? 'pan' : 'orbit';
      lx = e.clientX; ly = e.clientY; moved = false;
    } else if (ptrs.size === 2) {
      mode = 'gesture';
      gestureBaseline();
    }
  };
  const move = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'gesture' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      orbit.dist = clampDist(orbit.dist * (pinchDist / dist));                     // pinch zoom
      panBy(cx - pinchX, cy - pinchY);                                             // two-finger pan
      pinchDist = dist; pinchX = cx; pinchY = cy;
      moved = true;
      draw();
      return;
    }
    if (!mode || mode === 'gesture') return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    if (dx || dy) moved = true;
    if (mode === 'orbit') {
      orbit.az -= dx * 0.008;
      orbit.pol = clampPol(orbit.pol - dy * 0.008);
    } else {
      panBy(dx, dy);
    }
    draw();
  };
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    try { node.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (ptrs.size === 1) {
      // Two fingers dropped to one: resume orbiting from the finger left on screen
      // (reset the baseline so the view doesn't jump).
      const [p] = [...ptrs.values()];
      mode = 'orbit'; lx = p.x; ly = p.y;
      return;
    }
    if (ptrs.size >= 2) { gestureBaseline(); return; }
    // Last pointer up: write the URL once, only if the camera actually moved.
    if (mode && moved) commitView();
    mode = null; moved = false; node.style.cursor = 'grab';
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('contextmenu', (e) => e.preventDefault());
  node.addEventListener('wheel', (e) => {
    e.preventDefault();
    userView = true;
    orbit.dist = clampDist(orbit.dist * (1 + Math.sign(e.deltaY) * 0.09));
    draw();
    // Zoom has no "release", so persist the pose a beat after scrolling stops.
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(commitView, 350);
  }, { passive: false });
}

function dirToCam() {
  const o = orbit;
  return new THREE.Vector3(
    Math.sin(o.pol) * Math.sin(o.az),
    Math.cos(o.pol),
    Math.sin(o.pol) * Math.cos(o.az)
  );
}

function draw() {
  if (!renderer || rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    // Re-derive the free region every frame: the card's rect is only final
    // after layout, and it moves with the layout switcher.
    applyViewOffset();
    if (!userView && span) orbit.dist = span * FRAME_K * fitK;
    const o = orbit;
    const d = dirToCam().multiplyScalar(o.dist);
    camera.position.copy(o.target).add(d);
    camera.lookAt(o.target);
    renderer.render(scene, camera);
  });
}

// The schematic card floats over the viewer, so bias the projection to the
// largest region of the canvas it does NOT cover, and pull back to suit.
function applyViewOffset() {
  const host = el.stage;
  if (!host || !camera) return;
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  let cx = w / 2, cy = h / 2, usable = 1;
  // Query the card from the DOM each time - a ref captured at mount can go stale.
  // When swapped, the 3D view is a thumbnail (the schematic no longer floats
  // over it), so just center the projection.
  const fig = swapped ? null : document.getElementById('schematic');
  if (fig && fig.offsetWidth) {
    const m = host.getBoundingClientRect();
    const f = fig.getBoundingClientRect();
    const pad = 14;
    const L = f.left - m.left, R = f.right - m.left, Tp = f.top - m.top, B = f.bottom - m.top;
    const cand = [
      [0, 0, w, Math.max(0, Tp - pad)],
      [0, Math.min(h, B + pad), w, h],
      [0, 0, Math.max(0, L - pad), h],
      [Math.min(w, R + pad), 0, w, h],
    ];
    let best = null;
    for (const [x0, y0, x1, y1] of cand) {
      const a = (x1 - x0) * (y1 - y0);
      if (a > 0 && (!best || a > best.a)) best = { x0, y0, x1, y1, a };
    }
    if (best) {
      cx = (best.x0 + best.x1) / 2;
      cy = (best.y0 + best.y1) / 2;
      usable = Math.min((best.x1 - best.x0) / w, (best.y1 - best.y0) / h);
    }
  }
  fitK = 1 / clamp(usable, 0.42, 1);
  camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
}

function onResize() {
  applyLayout();   // may switch to/from the forced 'below' layout as the width crosses the threshold
  // Keep the diagram's backing store matched to its box on every resize -
  // including while expanded, when the 3D stage below is hidden and this
  // function returns early. Skipping it there let the canvas bitmap get
  // stretched non-uniformly by CSS to fill the new box.
  drawSchematic();
  updateSchematicPlacement();   // raise the docked card only when it would hit the copyright
  const host = el.stage;
  if (!host || !renderer) return;
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  camera.aspect = w / h;
  applyViewOffset();
  camera.updateProjectionMatrix();
  if (!framed) syncMesh(); else draw();   // re-fit the part when the layout just changed
}

// Return the camera to its initial pose and re-enable auto-framing (which
// orbiting or zooming disables). syncMesh reframes distance + target to fit.
function resetView() {
  if (!renderer) return;
  orbit.az = VIEW_HOME.az;
  orbit.pol = VIEW_HOME.pol;
  userView = false;
  framed = false;
  hasCustomView = false;      // drop the saved view from the URL
  writeHash(state.params);
  syncMesh();
}

// Preset orbit angles (az, pol). The part lies in the XY bend plane, running
// along X (left end −X, right end +X), Y up, Z out of the plane. `top` uses a
// near-vertical polar angle because looking straight down the up axis is
// degenerate for lookAt.
const VIEWS = {
  left:  { az: -Math.PI / 2, pol: Math.PI / 2 },
  right: { az:  Math.PI / 2, pol: Math.PI / 2 },
  top:   { az: 0, pol: 0.1 },
  side:  { az: 0, pol: Math.PI / 2 },
};
function setView(name) {
  const v = VIEWS[name];
  if (!renderer || !v) return;
  orbit.az = v.az;
  orbit.pol = v.pol;
  userView = false;           // re-frame distance & target to fit the part
  framed = false;
  hasCustomView = true;       // record the chosen view in the URL
  syncMesh();
  writeHash(state.params);
}

// Apply the swap state (expanded diagram fills the viewer, the 3D render shrinks
// to a thumbnail, and back). Reused by the toggle and by the initial URL restore.
function applySwap(on) {
  swapped = on;
  el.viewer.classList.toggle('swapped', swapped);
  el.expand.title = swapped ? 'Restore diagram' : 'Expand diagram';
  el.expand.classList.toggle('is-swapped', swapped);
  resetDiagramView();  // always open (and close) at a clean fit; zoom/pan is expanded-only
  onResize();          // on restore, re-fit the 3D renderer (it's hidden while expanded)
  drawSchematic();     // redraw the diagram at its new size (onResize bails while the stage is hidden)
  updateSchematicPlacement();
}
// Swap the 2D diagram and the 3D view, and persist the choice to the URL so a
// refresh or copied link opens in the same state.
function toggleSwap() {
  applySwap(!swapped);
  writeHash(state.params);
}

// Zoom/pan on the diagram, in both the docked card and the expanded view. Both
// are composed on top of the base fit in screen space (see drawDiagram's `view`),
// so the maths here stays in CSS px and never has to know the world scale.
const DIAGRAM_ZOOM_MIN = 0.6, DIAGRAM_ZOOM_MAX = 24;
function bindDiagramControls(canvas) {
  const localPt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const clampZoom = (z) => clamp(z, DIAGRAM_ZOOM_MIN, DIAGRAM_ZOOM_MAX);
  // Zoom about the cursor: keep the point under the cursor fixed by adjusting the
  // pan so cx = panX + zoom * baseX stays true across the zoom change.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [cx, cy] = localPt(e);
    const prev = diagramView.zoom;
    const next = clampZoom(prev * Math.exp(-e.deltaY * 0.0015));
    if (next === prev) return;
    diagramView.panX = cx - (next / prev) * (cx - diagramView.panX);
    diagramView.panY = cy - (next / prev) * (cy - diagramView.panY);
    diagramView.zoom = next;
    syncDiagramReset();
    drawSchematic();
  }, { passive: false });

  // Drag to pan; two fingers to pinch-zoom and pan together. Active pointers are
  // tracked by id (local canvas coords) so a second touch drives a gesture rather
  // than resetting the drag. Pointer capture keeps a drag alive off the edge.
  const ptrs = new Map();
  let lastDist = 0, lastCx = 0, lastCy = 0;   // two-finger baseline
  const gestureBaseline = () => {
    const [a, b] = [...ptrs.values()];
    lastDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    lastCx = (a.x + b.x) / 2; lastCy = (a.y + b.y) / 2;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const [x, y] = localPt(e);
    ptrs.set(e.pointerId, { x, y });
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    if (ptrs.size === 2) gestureBaseline();
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    const [x, y] = localPt(e);
    ptrs.set(e.pointerId, { x, y });
    if (ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      diagramView.panX += cx - lastCx;                 // two-finger pan (centroid move)
      diagramView.panY += cy - lastCy;
      const pz = diagramView.zoom, nz = clampZoom(pz * (dist / lastDist));   // pinch zoom
      diagramView.panX = cx - (nz / pz) * (cx - diagramView.panX);           // about the centroid
      diagramView.panY = cy - (nz / pz) * (cy - diagramView.panY);
      diagramView.zoom = nz;
      lastDist = dist; lastCx = cx; lastCy = cy;
    } else {
      diagramView.panX += x - prev.x;                  // single-pointer pan
      diagramView.panY += y - prev.y;
    }
    syncDiagramReset();
    drawSchematic();
  });
  const endPtr = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (ptrs.size === 2) gestureBaseline();            // three→two fingers: re-baseline
    if (ptrs.size === 0) canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);

  // Double-click snaps back to the fit.
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    resetDiagramView();
    drawSchematic();
  });

  // A resize of the canvas box (e.g. the flex reflow on expand, or a viewport
  // change while expanded) re-syncs the backing store so CSS never stretches the
  // bitmap to fit.
  new ResizeObserver(() => drawSchematic()).observe(canvas);
}

// ── Boot ────────────────────────────────────────────────────────────────────
function setLayout(lay) {
  framed = false;
  state.layout = lay;
  render();
  onResize();
  syncMesh();
}

// Switch display units. The stored geometry is untouched; only the panel,
// overlays, and schematic re-render, and the choice is persisted to the URL.
function setUnits(units) {
  if (units !== 'mm' && units !== 'in') return;
  state.units = units;
  writeHash(state.params);
  render();
}

function init() {
  state.params = readHash() || geo.defaultParams();
  renderStyle = readRenderStyle() || 'steel';
  state.units = readUnits();

  el.layoutSwitch.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => setLayout(btn.getAttribute('data-layout')));
  });
  el.unitsSwitch.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => setUnits(btn.getAttribute('data-units')));
  });
  el.collapseAll.addEventListener('click', () => setAllCollapsed(true));
  el.expandAll.addEventListener('click', () => setAllCollapsed(false));
  el.undo.addEventListener('click', () => step('undo'));
  el.redo.addEventListener('click', () => step('redo'));
  document.querySelectorAll('.menu-item[data-dl]').forEach((item) => {
    item.addEventListener('click', () => {
      const orient = item.getAttribute('data-orient');
      if (item.getAttribute('data-dl') === 'stl') downloadSTL(orient);
      else download3MF(orient);
      item.blur(); // close the focus-within menu after choosing
    });
  });
  document.querySelectorAll('[data-style]').forEach((item) => {
    item.addEventListener('click', () => { setRenderStyle(item.getAttribute('data-style')); item.blur(); });
  });
  markActiveStyle();
  el.reset.addEventListener('click', resetView);
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.addEventListener('click', () => setView(b.getAttribute('data-view')));
  });
  el.expand.addEventListener('click', toggleSwap);
  el.diagramReset.addEventListener('click', () => { resetDiagramView(); drawSchematic(); });
  bindDiagramControls(el.diagram);
  el.help.addEventListener('click', openHelp);
  el.helpClose.addEventListener('click', closeHelp);
  el.helpBackdrop.addEventListener('click', (e) => { if (e.target === el.helpBackdrop) closeHelp(); });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.helpBackdrop.hidden) closeHelp(); });
  window.addEventListener('resize', onResize);

  initThree();
  render();
  // Restore the expanded-diagram state from the URL, if set.
  if (readExpanded()) applySwap(true);
}

init();
