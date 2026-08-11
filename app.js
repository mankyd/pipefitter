// Pipe Fitter - application entry point.
//
// The geometry and schematic live in their own modules; three.js is vendored
// under ./vendor. All state is local to the page: there is no server and no
// persistence beyond the URL hash.

import * as THREE from './vendor/three.module.js';
import * as geo from './pipe-geometry.js';
import { drawDiagram, setDiagramTheme } from './pipe-diagram.js';

// ── DOM references ──────────────────────────────────────────────────────────
const el = {
  summary: document.getElementById('summary'),
  panelSide: document.getElementById('btn-panel-side'),
  unitsSwitch: document.getElementById('units-switch'),
  theme: document.getElementById('btn-theme'),
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
  theme: 'dark',      // 'dark' | 'light' - CSS tokens, schematic palette, and 3D backdrop
                      // (set from the OS at boot; see osTheme)
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
// Auto-frame distance = span · FRAME_K · fitK (lower = tighter). Tuned against
// the worst case for a part measured by its longest axis: a 90° elbow, whose
// two equal legs put the diagonal well outside `span`. That one still clears
// the canvas edges and the schematic card here, so anything flatter does too.
const FRAME_K = 1.45;
let renderer, scene, camera, mesh, material, grid, hemiLight;
let gridStep = 10, gridCells = 20;   // current floor-grid spacing, so a theme change can rebuild it
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

// The parts of the 3D view that belong to the page rather than to the part:
// the canvas backdrop, the floor grid, and the studio environment the materials
// reflect. The materials themselves are the same in both themes - a copper pipe
// is copper either way - but they need something bright to reflect on a light
// page, or the metals read as dark holes cut out of the background.
const SCENE_THEME = {
  dark: {
    clear: 0x191b28,
    grid: [0x8a90ab, 0x5a5f75], gridOpacity: 0.7,
    ground: 0x14151f,                                        // hemisphere light's lower half
    sky: ['#3a3e52', '#222431', '#181a25', '#0e0f16'],       // environment gradient, top → floor
  },
  light: {
    clear: 0xe0e3ee,
    grid: [0x6f7590, 0xa8adc2], gridOpacity: 0.8,
    ground: 0xd6d9e6,
    // Keeps the dark theme's top-to-floor falloff rather than washing the whole
    // sphere white - a uniformly bright environment flattens the shading and
    // the part loses its form against a light page.
    sky: ['#ffffff', '#e4e8f4', '#c8cddf', '#8d92a6'],
  },
};

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
  // The theme deliberately does NOT ride along: it's a preference about the
  // room you're working in, not a property of the part, and a link shouldn't
  // impose it on whoever opens it.
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
  reseatTargetToContent();   // heal any far-drifted target so pan/zoom stay calibrated
  userView = true; framed = true; hasCustomView = true;   // an explicit view: don't auto-reframe
  draw();
}

// Slide the look-at target along the view ray to the model's depth, leaving the
// image untouched (the target's distance doesn't affect what's rendered — only
// pan/zoom sensitivity and the orbit centre). Older saved views could park the
// target far out in empty space with a tiny dist, which made pan/zoom crawl.
function reseatTargetToContent() {
  const g = geometry();
  if (!g) return;
  const center = new THREE.Vector3(0, g.bbox.size[1] / 2, 0);   // model centre (see syncMesh centring)
  const dir = dirToCam();                                       // target -> camera, unit
  const camPos = orbit.target.clone().addScaledVector(dir, orbit.dist);
  const view = dir.clone().negate();                            // camera -> scene
  const d = clampDist(center.sub(camPos).dot(view));            // content depth along the view ray
  orbit.dist = d;
  orbit.target.copy(camPos).addScaledVector(view, d);
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
// A collapsed source section spawns its new section and bend collapsed too.
function addSectionBefore(i) {
  const collapse = collapsedGroups.has('s' + i);
  shiftCollapsed('s', i, 1);                         // section i and everything after it move up one
  shiftCollapsed('b', i, 1);                         // (prepend inserts a bend at i as well)
  if (collapse) { collapsedGroups.add('s' + i); collapsedGroups.add('b' + i); }
  structuralEdit((p) => {
    const sec = p.sections[i];
    p.sections.splice(i, 0, { id: sec.id, w: sec.w, l: sec.l });
    p.bends.splice(i, 0, bendFrom(sec));            // connects new section i and old (now i+1)
  }, 'add-before-' + i);
}
function addSectionAfter(i) {
  // i is the last section, so the new section (i+1) and new bend (i) sit at the
  // end and nothing existing is renumbered.
  const collapse = collapsedGroups.has('s' + i);
  if (collapse) { collapsedGroups.add('s' + (i + 1)); collapsedGroups.add('b' + i); }
  structuralEdit((p) => {
    const sec = p.sections[i];
    p.sections.splice(i + 1, 0, { id: sec.id, w: sec.w, l: sec.l });
    p.bends.splice(i, 0, bendFrom(sec));            // connects old section i and new (i+1)
  }, 'add-after-' + i);
}
function removeSection(i) {
  if (state.params.sections.length <= 2) return;   // keep at least two
  const b = i > 0 ? i - 1 : 0;                      // the adjacent bend that goes with it
  collapsedGroups.delete('s' + i); shiftCollapsed('s', i + 1, -1);
  collapsedGroups.delete('b' + b); shiftCollapsed('b', b + 1, -1);
  structuralEdit((p) => {
    p.sections.splice(i, 1);
    p.bends.splice(b, 1);                            // drop an adjacent bend
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
    // Autolinks - <https://…> - matched after escaping, so the brackets around
    // them are entities by now. Lazy up to the closing one, so a query string's
    // own &amp; can't end the match early.
    .replace(/&lt;(https?:\/\/[^\s]+?)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
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
function numCtrl(key, label, hint, step, integer, maxOverride, minOverride) {
  const lim = limitOf(key);
  // The slider steps coarsely (`step`); the number field allows fine 0.1 entry,
  // except integer counts, which stay whole. `maxOverride`/`minOverride` let a
  // control cap below (or lift above) its static limits — e.g. chamfer depth
  // capped at the section length, or a slip-joint section floored at its stop.
  return { kind: 'num', key, label, hint, min: minOverride != null ? minOverride : lim[0], max: maxOverride != null ? maxOverride : lim[1], step, numStep: integer ? 1 : 0.1 };
}

// A slip-joint's stop is a solid floor (as thick as the wall, up to half the
// joint length) that is part of the section, so the section can't be shorter
// than it. Returns that floor for a fit-ended section, else undefined (no lift).
function sectionMinLen(sec) {
  const e = sec && sec.end;
  if (!e || e.type !== 'fit') return undefined;
  return round(Math.min(sec.w, e.FitL / 2), 2);
}

// The bend-length (B) control. For a bent transition B is the inner-bend face
// arc, which has a floor — the tightest bend the neighboring diameters allow
// (the schematic and the mesh never draw a shorter face). The slider's range
// starts at that floor, and when the stored request sits below it (the floor
// moved after the value was set, e.g. a diameter grew), the control shows the
// effective value actually drawn — the same number the schematic labels and
// the header note reports.
function bendLenCtrl(key, pb) {
  const c = numCtrl(key, pb && pb.bend ? 'Inner-bend face arc' : 'Length', 'mm', 1);
  if (pb && pb.bend) {
    const floor = round(pb.minFace, 1);
    c.min = Math.min(floor, c.max);
    c.display = (p) => (pb.faceClamped ? floor : getP(p, key));
  }
  return c;
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
      { value: 'fit', label: 'Slip Joint' },
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
      kind: 'enum', key: pre + 'FitSide', label: 'Joint side', hint: '',
      options: [
        { value: 'inside', label: 'Inside (spigot — plugs in)' },
        { value: 'outside', label: 'Outside (socket — receives)' },
      ],
    });
    list.push(numCtrl(pre + 'FitL', 'Joint length', 'mm', 0.5));   // extends past the section; not capped by its length
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
      numCtrl('s' + i + '.l', 'Length', 'mm', 1, false, undefined, sectionMinLen(sections[i])),
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
          bendLenCtrl(bpre + 'l2', g.path.bends[i]),
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
let panelBuilt = false;              // false until the first build, which starts every group collapsed
const collapsedGroups = new Set();   // group ids whose body is collapsed (persists across rebuilds)

// Group ids are positional (s<i>/b<i>), so an insert or remove that renumbers
// sections/bends has to renumber the stored collapsed ids in step - otherwise a
// collapsed state stays pinned to an index and jumps to whichever group lands
// there. Shift every `prefix` ('s' or 'b') id at or past `from` by `delta`.
function shiftCollapsed(prefix, from, delta) {
  const next = new Set();
  for (const id of collapsedGroups) {
    const m = /^([sb])(\d+)$/.exec(id);
    if (m && m[1] === prefix && +m[2] >= from) next.add(m[1] + (+m[2] + delta));
    else next.add(id);
  }
  collapsedGroups.clear();
  next.forEach((id) => collapsedGroups.add(id));
}

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
  if (swapped || !br || cardPos) return;   // placed by hand: the user owns the position
  const a = card.getBoundingClientRect(), b = br.getBoundingClientRect();
  const GAP = 12;
  const overlap = a.right + GAP > b.left && a.left < b.right + GAP &&
                  a.bottom > b.top && a.top < b.bottom;
  if (overlap) card.classList.add('raised');
}

// Where the card has been dragged to, in px from the viewer's left and bottom
// edges - null until it's moved, so it keeps its docked corner (and the `raised`
// nudge above) by default. Measured from the bottom to match the CSS, so the
// card stays put when its height changes rather than sliding with the top edge.
// Not persisted: like the theme, it's a per-session preference the URL doesn't
// carry.
let cardPos = null;

// Push cardPos onto the card. While expanded the card fills the viewer via
// `inset: 0`, and inline offsets would beat that, so they come off until it's
// restored.
function applyCardPos() {
  const card = el.schematic;
  if (!card) return;
  if (swapped || !cardPos) { card.style.left = card.style.bottom = ''; return; }
  card.style.left = cardPos.left + 'px';
  card.style.bottom = cardPos.bottom + 'px';
}

// Keep the card inside the viewer - both as it's dragged and after a resize that
// would otherwise strand it out of reach.
function clampCardPos() {
  const card = el.schematic, host = el.viewer;
  if (!cardPos || !card || !host || swapped) return;
  const v = host.getBoundingClientRect(), c = card.getBoundingClientRect();
  cardPos.left = clamp(cardPos.left, 0, Math.max(0, v.width - c.width));
  cardPos.bottom = clamp(cardPos.bottom, 0, Math.max(0, v.height - c.height));
}

// Drag the card by its title bar. The expand button shares that bar and has to
// stay clickable, so presses landing on it are left alone. Docked only: expanded,
// the card is the whole viewer and has nowhere to go.
function bindSchematicDrag() {
  const card = el.schematic;
  const cap = card && card.querySelector('.schematic-cap');
  if (!cap) return;
  let dragId = null, sx = 0, sy = 0, startLeft = 0, startBottom = 0;
  cap.addEventListener('pointerdown', (e) => {
    if (swapped || e.button > 0 || e.target.closest('.schematic-expand')) return;
    // Seed from where the card actually is, so the first drag picks up from the
    // docked corner (or the raised one) without a jump.
    const v = el.viewer.getBoundingClientRect(), c = card.getBoundingClientRect();
    cardPos = { left: c.left - v.left, bottom: v.bottom - c.bottom };
    startLeft = cardPos.left; startBottom = cardPos.bottom;
    dragId = e.pointerId; sx = e.clientX; sy = e.clientY;
    cap.setPointerCapture(dragId);
    card.classList.add('dragging');
    e.preventDefault();
  });
  cap.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    cardPos.left = startLeft + (e.clientX - sx);
    cardPos.bottom = startBottom - (e.clientY - sy);   // bottom-anchored: screen y runs the other way
    clampCardPos();
    applyCardPos();
  });
  const end = (e) => {
    if (e.pointerId !== dragId) return;
    try { cap.releasePointerCapture(dragId); } catch (err) { /* ignore */ }
    dragId = null;
    card.classList.remove('dragging');
  };
  cap.addEventListener('pointerup', end);
  cap.addEventListener('pointercancel', end);
}

function h(tag, cls, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function buildPanel(groups) {
  // The panel opens fully collapsed, so the part - not the controls - is the
  // first thing you see. Seeding the set on the first build (rather than
  // special-casing the render) means everything after it, including a rebuild
  // triggered by adding a section, follows the normal persistence rules.
  if (!panelBuilt) {
    panelBuilt = true;
    groups.forEach((g) => collapsedGroups.add(g.id));
  }
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
        const rawInit = c.derived === 'od' ? odValue(c, state.params)
          : c.display ? c.display(state.params) : getP(state.params, c.key);
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
        const rawVal = c.derived === 'od' ? odValue(c, p)
          : c.display ? c.display(p) : getP(p, c.key);
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
  // The side-swap arrow points at the side it would move the panel to, and sits
  // on that side of the toolbar - so it always reads as "push the panel that
  // way", and never sits between the two buttons it shares the bar with. (In
  // the bottom layout the whole toolbar is hidden above, and there's no manual
  // "below" option to swap to anyway.)
  const toRight = lay !== 'right';
  el.panelSide.textContent = toRight ? '→' : '←';
  el.panelSide.style.order = toRight ? '1' : '-1';
  const sideLabel = 'Move the panel to the ' + (toRight ? 'right' : 'left');
  el.panelSide.title = sideLabel;
  el.panelSide.setAttribute('aria-label', sideLabel);
  // A change in the effective layout (e.g. crossing the width threshold) reshapes
  // the viewer, so re-frame the part to fit it.
  if (lay !== appliedLayout) { appliedLayout = lay; framed = false; }
}

// Put the current theme on the page: the CSS tokens hang off data-theme, and
// the pieces drawn outside CSS - the schematic's canvas palette, the viewer's
// backdrop, floor grid and studio environment - are repainted to match. The
// button always advertises the theme it would switch *to*.
function applyTheme() {
  const th = SCENE_THEME[state.theme] || SCENE_THEME.dark;
  const toLight = state.theme === 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  if (el.theme) {
    const label = 'Switch to the ' + (toLight ? 'light' : 'dark') + ' theme';
    el.theme.textContent = toLight ? '☀' : '☾';
    el.theme.title = label;
    el.theme.setAttribute('aria-label', label);
  }
  setDiagramTheme(state.theme);
  if (renderer) {
    renderer.setClearColor(th.clear, 1);
    hemiLight.groundColor.setHex(th.ground);
    if (scene.environment) scene.environment.dispose();
    scene.environment = makeEnvironment();
    makeGrid(gridStep, gridCells);   // grid colors are baked in, so rebuild it
    draw();
  }
  drawSchematic();
}

// Nothing records the theme - it's not in the URL and the app has no storage -
// so the starting point is the OS preference. `light` has to be asked for
// explicitly; "no-preference" (and browsers that don't support the query at
// all) keeps the app's dark default.
const LIGHT_QUERY = '(prefers-color-scheme: light)';
const osTheme = () => (window.matchMedia && window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark');
let themePinned = false;   // true once the button is used - a manual choice outranks the OS

// Follow the OS if it changes mid-session (unplugging an external display, a
// sunset schedule), but never over the top of a deliberate choice.
function watchOSTheme() {
  const mq = window.matchMedia && window.matchMedia(LIGHT_QUERY);
  if (!mq || !mq.addEventListener) return;
  mq.addEventListener('change', () => {
    if (themePinned) return;
    state.theme = osTheme();
    applyTheme();
  });
}

function setTheme(name) {
  state.theme = name === 'light' ? 'light' : 'dark';
  themePinned = true;
  applyTheme();
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
    const sky = (SCENE_THEME[state.theme] || SCENE_THEME.dark).sky;
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0.00, sky[0]);   // top - lighter "sky"
    g.addColorStop(0.48, sky[1]);
    g.addColorStop(0.52, sky[2]);   // horizon
    g.addColorStop(1.00, sky[3]);   // bottom - darker "floor"
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

// Floor-grid line weights, in CSS pixels: the ordinary lines, and the two
// axis lines through the origin.
const GRID_LINE_PX = 1.6, GRID_AXIS_PX = 2.6;

// (Re)build the floor grid at `step` mm spacing over `cells` cells. Its colors
// and spacing are baked in, so both a spacing change and a theme change mean a
// fresh one.
//
// This is a ground plane carrying a grid shader rather than THREE.GridHelper,
// because WebGL draws LineBasicMaterial exactly one device pixel wide whatever
// `linewidth` says - too fine to read, and finer still on a HiDPI screen where
// that's half a CSS pixel. Deriving each line's coverage from screen-space
// derivatives instead gives it a width we can actually choose.
function makeGrid(step, cells) {
  const th = SCENE_THEME[state.theme] || SCENE_THEME.dark;
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  // The square is centred on the origin and the lines fall on whole multiples
  // of `step` from it, so an odd cell count puts the outer edge half a cell
  // past the last line and the grid ends with no border. Round up to even.
  cells += cells % 2;
  gridStep = step; gridCells = cells;
  const dpr = renderer ? renderer.getPixelRatio() : 1;
  // Half a cell of bleed past the grid square, so the shader can draw the
  // outermost lines at their full width instead of clipping them down
  // the middle.
  const geom = new THREE.PlaneGeometry(step * cells + step, step * cells + step);
  geom.rotateX(-Math.PI / 2);
  grid = new THREE.Mesh(geom, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uStep: { value: step },
      uHalf: { value: (step * cells) / 2 },
      uMinor: { value: new THREE.Color(th.grid[1]) },
      uAxis: { value: new THREE.Color(th.grid[0]) },
      uMinorPx: { value: GRID_LINE_PX * dpr },
      uAxisPx: { value: GRID_AXIS_PX * dpr },
      uOpacity: { value: th.gridOpacity },
    },
    vertexShader: `
      varying vec2 vXZ;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vXZ = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform vec3 uMinor, uAxis;
      uniform float uStep, uHalf, uMinorPx, uAxisPx, uOpacity;
      varying vec2 vXZ;

      // Coverage of a line \`px\` device pixels wide, \`d\` from its centre, where
      // \`fw\` is how far the coordinate advances per pixel. Working in pixels
      // is the whole point: the line holds its weight however far the floor
      // recedes, and gets a real antialiased edge.
      float lineCoverage(float d, float fw, float px) {
        float p = d / max(fw, 1e-8);
        return 1.0 - smoothstep(px * 0.5 - 0.5, px * 0.5 + 0.5, p);
      }

      // Where a line ends: 1 inside \`lim\`, fading over the last pixel so the
      // butt end gets an antialiased edge rather than a jagged one.
      float within(float v, float lim, float fw) {
        return 1.0 - smoothstep(lim - 0.5 * fw, lim + 0.5 * fw, abs(v));
      }

      void main() {
        vec2 wfw = fwidth(vXZ);
        vec2 c = vXZ / uStep;          // position in cells, so lines sit on integers
        vec2 cfw = fwidth(c);
        vec2 d = abs(fract(c - 0.5) - 0.5);

        // Each family of lines is bounded by the extent it runs along, not by a
        // shared box: lines of constant x run along z, so they stop at the z
        // edge. Clipping both families to one box instead let every line poke a
        // few pixels past the border wherever it crossed. They do run half the
        // border line's width past it, so the corners close up square.
        float tol = uMinorPx * 0.5;
        float inX = within(vXZ.x, uHalf + tol * wfw.x, wfw.x);
        float inZ = within(vXZ.y, uHalf + tol * wfw.y, wfw.y);

        float minor = max(lineCoverage(d.x, cfw.x, uMinorPx) * inZ,
                          lineCoverage(d.y, cfw.y, uMinorPx) * inX);
        // Once cells are only a few pixels apart the lines merge into a solid
        // sheet - dissolve them rather than let them alias into moire.
        minor *= 1.0 - smoothstep(0.16, 0.5, max(cfw.x, cfw.y));

        float axis = max(lineCoverage(abs(vXZ.x), wfw.x, uAxisPx) * inZ,
                         lineCoverage(abs(vXZ.y), wfw.y, uAxisPx) * inX);

        float a = max(minor, axis) * uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(mix(uMinor, uAxis, step(minor, axis)), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  scene.add(grid);
}

function initThree() {
  const host = el.stage;
  if (!host) return;

  const th = SCENE_THEME[state.theme] || SCENE_THEME.dark;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(th.clear, 1);
  host.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);

  hemiLight = new THREE.HemisphereLight(0xb9bdd4, th.ground, 0.55);
  scene.add(hemiLight);
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

  makeGrid(gridStep, gridCells);

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
    makeGrid(stepMm, cells);
  }
  draw();
}

function bindControls(node) {
  // Active pointers by id, so a second touch can drive a two-finger gesture
  // (pinch to zoom + drag to pan) instead of just resetting the single-drag.
  const ptrs = new Map();
  let mode = null, lx = 0, ly = 0, moved = false;
  let pinchDist = 0, pinchX = 0, pinchY = 0;   // two-finger baseline
  let orbitPivot = null;   // model point under the cursor at drag start, applied on first move
  let zoomPivot = null, zoomX = 0, zoomY = 0;   // same, for the run of scrolling at one cursor position

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
      // Pivot on the point under the cursor (model, else the nearest point on the
      // grid): captured at press (before the cursor drifts) and held for the whole
      // drag. A bare click never moves.
      orbitPivot = mode === 'orbit' ? pickPivotPoint(e.clientX, e.clientY) : null;
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
      if (orbitPivot) {
        orbitAboutPivot(orbitPivot, dx, dy);         // rotate about the point under the cursor
      } else {
        orbit.az -= dx * 0.008;                      // no model under cursor: spin about the target
        orbit.pol = clampPol(orbit.pol - dy * 0.008);
      }
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
      mode = 'orbit'; lx = p.x; ly = p.y; orbitPivot = null;   // no fresh pick: spin about target
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
    // Zoom into the point under the cursor, picked the way an orbit drag picks
    // its pivot: the model if it's under there, else the nearest point on the
    // grid. Held until the cursor moves, so a run of scrolling can't creep - a
    // fresh pick each notch would chase the point sliding under a still cursor.
    if (!zoomPivot || Math.abs(e.clientX - zoomX) > 2 || Math.abs(e.clientY - zoomY) > 2) {
      zoomPivot = pickPivotPoint(e.clientX, e.clientY);
      zoomX = e.clientX; zoomY = e.clientY;
    }
    const k = 1 + Math.sign(e.deltaY) * 0.09;
    if (zoomPivot) dollyToPivot(zoomPivot, k);
    else orbit.dist = clampDist(orbit.dist * k);
    draw();
    // Zoom has no "release", so persist the pose a beat after scrolling stops -
    // and treat that lull as the end of the gesture, so the next one re-picks.
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { commitView(); zoomPivot = null; }, 350);
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

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);   // y = 0: the ground the part sits on

// How far along a ground track (a ray flattened into y = 0) it is over the grid
// square: [enter, exit] distances from its start, forward only, or null if it
// never crosses the square. Slab method.
function trackSpan(from, dir, h) {
  let tmin = 0, tmax = Infinity;
  for (const [o, d] of [[from.x, dir.x], [from.z, dir.z]]) {
    if (Math.abs(d) < 1e-9) { if (o < -h || o > h) return null; continue; }   // parallel to this pair of edges
    const t1 = (-h - o) / d, t2 = (h - o) / d;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  return tmax >= tmin ? [tmin, tmax] : null;
}

// Nearest point of the grid square to a track that never passes over it.
const _edgePoint = new THREE.Vector3();
function closestEdgePoint(flat, h) {
  const corner = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  const best = new THREE.Vector3();
  let bestD = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = flat.distanceSqToSegment(corner[i], corner[(i + 1) % 4], null, _edgePoint);
    if (d < bestD) { bestD = d; best.copy(_edgePoint); }
  }
  return best;
}

// The point of the drawn grid - a square in y = 0, centred on the origin - that
// a pick ray asks for. Everything is measured along the ray's ground track (the
// ray flattened into the plane), because that track is the direction you're
// pointing: the pivot is the ray's ground crossing, pulled back onto the stretch
// of track that lies over the square.
//
// Working along the track, rather than off the 3D ray, is what makes the shallow
// cases come out right. The closest point to a climbing ray is beside the camera
// - so aiming past the far edge would pivot on the *near* one - and the closest
// point to a far ground crossing is a corner, however far off to the side that
// crossing is. Following the track instead: a crossing over the square is the
// pivot; short of the square it clamps to the near edge; past it - including the
// unbounded "past" of a ray that climbs and never lands - to the far edge.
const _flatRay = new THREE.Ray();
function closestGridPoint(ray) {
  const h = (gridStep * gridCells) / 2;
  const ground = ray.intersectPlane(_groundPlane, new THREE.Vector3());
  const from = new THREE.Vector3(ray.origin.x, 0, ray.origin.z);
  const len = Math.hypot(ray.direction.x, ray.direction.z);
  if (len < 1e-9) {                                   // straight down (or up): no track to follow
    const p = ground || from;
    p.set(clamp(p.x, -h, h), 0, clamp(p.z, -h, h));
    return p;
  }
  const dir = new THREE.Vector3(ray.direction.x / len, 0, ray.direction.z / len);
  const span = trackSpan(from, dir, h);
  if (span) {
    // Distance along the track to the crossing. A ray that climbs away from the
    // ground has none: that reads as infinitely far ahead, which lands the pivot
    // on the far edge - the grid receding under the click.
    const t = ground ? (ground.x - from.x) * dir.x + (ground.z - from.z) * dir.z : Infinity;
    return from.addScaledVector(dir, clamp(t, span[0], span[1]));
  }
  // The track runs past the square without ever crossing it - a click off to one
  // side. There's no stretch of it to clamp into, so use the nearest grid point
  // to where the ray does land, which keeps the pivot beside the click rather
  // than sending it off down the bearing.
  if (ground) {
    ground.set(clamp(ground.x, -h, h), 0, clamp(ground.z, -h, h));
    return ground;
  }
  return closestEdgePoint(_flatRay.set(from, dir), h);   // off to the side *and* never lands
}

// World-space pivot for an orbit drag under the given client coords. Prefer the
// point on the model; off the model, orbit about the grid instead - always a
// point on the drawn square, never past its edge.
//
// Staying inside the square is what makes the off-model case usable at all. The
// ground plane is infinite, so a grazing ray crosses it hundreds of units out,
// and orbiting about a pivot that far away swings the camera wildly - the old
// code rejected those rays outright and spun about the target instead. The grid
// is sized from the part's span, so resolving to a point on it bounds the pivot
// to roughly the size of the part, and every ray now yields one worth using.
//
// The offset projection (setViewOffset) is baked into the camera's matrices, so
// plain [-1,1] NDC unprojects correctly.
function pickPivotPoint(clientX, clientY) {
  if (!mesh || !camera || !renderer) return null;
  const r = renderer.domElement.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
  _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
  _raycaster.setFromCamera(_ndc, camera);
  const hit = _raycaster.intersectObject(mesh, false)[0];
  if (hit) return hit.point.clone();
  return closestGridPoint(_raycaster.ray);
}

// Orbit about an arbitrary world point `p` (the model point under the cursor),
// keeping it fixed on screen. The camera aims at orbit.target (lookAt), so we
// can't just move the target to p — that would re-center on it. Instead rotate
// the camera position rigidly about p by the drag's yaw/pitch and rotate the view
// direction by the same amount; because p is the centre of rotation it stays put
// relative to the camera. The look-at target is only a point along the view ray
// (its distance doesn't change the image), so we re-seat it at p's depth — that
// keeps orbit.dist equal to how far away the thing we're circling actually is, so
// pan and zoom stay calibrated instead of drifting off into empty space.
function orbitAboutPivot(p, dx, dy) {
  userView = true;
  const dir = dirToCam();                            // target -> camera, unit
  const camPos = orbit.target.clone().addScaledVector(dir, orbit.dist);
  const right = new THREE.Vector3().crossVectors(camera.up, dir).normalize();
  const q = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * 0.008)          // yaw about world up
    .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.008)); // then pitch
  const newCam = p.clone().add(camPos.sub(p).applyQuaternion(q));
  const u = dir.applyQuaternion(q).normalize();      // new target -> camera direction
  orbit.pol = clampPol(Math.acos(clamp(u.y, -1, 1)));
  orbit.az = Math.atan2(u.x, u.z);
  orbit.dist = clampDist(newCam.distanceTo(p));       // look-at depth = distance to the pivot
  orbit.target.copy(newCam).addScaledVector(u, -orbit.dist);
}

// Dolly by scale `k` about the world point `p` under the cursor, keeping it fixed
// on screen: slide the camera along the line joining it to p, leaving the view
// direction alone. p's bearing from the camera is unchanged by a move along that
// line, so it projects to the same pixel and the view zooms into whatever is
// under the cursor rather than into the middle of the canvas.
//
// The look-at target re-seats at p's depth for the reason orbitAboutPivot does:
// orbit.dist stays the distance to the thing being looked at, so panning and the
// next zoom step keep their calibration.
function dollyToPivot(p, k) {
  userView = true;
  const u = dirToCam();                              // target -> camera, unit
  const camPos = orbit.target.clone().addScaledVector(u, orbit.dist);
  const toCam = camPos.sub(p);                       // p -> camera
  const len = toCam.length();
  if (len < 1e-6) { orbit.dist = clampDist(orbit.dist * k); return; }   // sitting on the pivot
  const d = clampDist(len * k);
  const newCam = p.clone().addScaledVector(toCam.divideScalar(len), d);
  orbit.dist = d;
  orbit.target.copy(newCam).addScaledVector(u, -d);
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
    scheduleFavicon();
  });
}

// ── Live favicon ────────────────────────────────────────────────────────────
// The tab icon is a miniature of the part being designed: the same scene and
// materials, rendered off-screen into a small target from the direction the
// user is currently looking, framed to the whole mesh, masked to a rounded
// square and installed as a PNG data URI. Scheduled from draw() behind a
// trailing debounce, so a drag repaints the icon once the gesture settles
// instead of once per frame.
const FAV_SIZE = 64;             // icon edge (px)
const FAV_SS = 2;                // supersampling factor - see FAV_RES
const FAV_RES = FAV_SIZE * FAV_SS;   // render edge; multisampled targets come back
                                     // empty here (see below), so anti-alias by
                                     // rendering big and downscaling instead
const FAV_QUIET = 250;   // ms without a redraw before the icon is repainted
let favTarget = null, favCam = null, favPix = null;
let favCanvas = null, favRaw = null, favTimer = null;

function scheduleFavicon() {
  if (favTimer) clearTimeout(favTimer);
  favTimer = setTimeout(paintFavicon, FAV_QUIET);
}

function paintFavicon() {
  favTimer = null;
  const pos = mesh && mesh.geometry.getAttribute('position');
  if (!renderer || !pos || !pos.count) return;
  try {
    if (!favTarget) {
      favTarget = new THREE.WebGLRenderTarget(FAV_RES, FAV_RES);
      // Off-screen targets are written in linear space - only the canvas gets
      // the sRGB encode - which would read back far too dark. r160 keys that
      // conversion off the XR flag, so borrow it: sRGB values in a plain 8-bit
      // buffer, exactly what the on-screen canvas receives. (It does not
      // survive `samples`: an MSAA target flagged this way reads back empty,
      // hence the supersample-and-shrink above.)
      favTarget.texture.colorSpace = THREE.SRGBColorSpace;
      favTarget.isXRRenderTarget = true;
      favCam = new THREE.PerspectiveCamera(30, 1, 0.5, 5000);
      favPix = new Uint8Array(FAV_RES * FAV_RES * 4);
      favRaw = document.createElement('canvas');
      favRaw.width = favRaw.height = FAV_RES;
      favCanvas = document.createElement('canvas');
      favCanvas.width = favCanvas.height = FAV_SIZE;
    }
    // Frame the whole part: the viewer's pan, zoom and offset projection are
    // about fitting a big canvas around a floating card, none of which applies
    // here. Only the orbit direction carries over.
    const g = mesh.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const s = g.boundingSphere;
    const dist = (s.radius / Math.sin((favCam.fov * Math.PI) / 360)) * 1.08;   // 8% breathing room
    favCam.position.copy(s.center).addScaledVector(dirToCam(), dist);
    favCam.lookAt(s.center);

    grid.visible = false;   // a floor grid is just noise at 64px
    renderer.setRenderTarget(favTarget);
    renderer.render(scene, favCam);
    renderer.readRenderTargetPixels(favTarget, 0, 0, FAV_RES, FAV_RES, favPix);
    renderer.setRenderTarget(null);
    grid.visible = true;

    // GL hands back bottom-up rows: flip them into the full-size canvas, shrink
    // that onto the icon (the anti-aliasing pass), then knock the corners out so
    // the icon keeps the rounded-square silhouette of the static one in
    // index.html.
    const raw = favRaw.getContext('2d');
    const img = raw.createImageData(FAV_RES, FAV_RES);
    const row = FAV_RES * 4;
    for (let y = 0; y < FAV_RES; y++) {
      const src = (FAV_RES - 1 - y) * row;
      img.data.set(favPix.subarray(src, src + row), y * row);
    }
    raw.putImageData(img, 0, 0);

    const ctx = favCanvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, FAV_SIZE, FAV_SIZE);
    ctx.drawImage(favRaw, 0, 0, FAV_SIZE, FAV_SIZE);
    if (ctx.roundRect) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.beginPath();
      ctx.roundRect(0, 0, FAV_SIZE, FAV_SIZE, FAV_SIZE * 0.19);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    setFavicon(favCanvas.toDataURL('image/png'));
  } catch (e) {
    // A lost context or a failed readback just leaves the previous icon up.
    renderer.setRenderTarget(null);
    grid.visible = true;
  }
}

// Swap in a fresh <link>: browsers pick up a new node more reliably than a
// mutated href.
function setFavicon(href) {
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = href;
  const old = document.querySelector('link[rel="icon"]');
  if (old) old.remove();
  document.head.appendChild(link);
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
  clampCardPos();               // a hand-placed card can be stranded by a shrinking viewer
  applyCardPos();
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
  clampCardPos();      // restored at its docked size, it may not fit where it was left
  applyCardPos();      // and the offsets come off entirely while expanded
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
  state.theme = osTheme();
  watchOSTheme();
  applyTheme();   // before initThree, so the scene is built with the right backdrop

  el.panelSide.addEventListener('click', () => setLayout(state.layout === 'right' ? 'left' : 'right'));
  el.unitsSwitch.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => setUnits(btn.getAttribute('data-units')));
  });
  el.collapseAll.addEventListener('click', () => setAllCollapsed(true));
  el.expandAll.addEventListener('click', () => setAllCollapsed(false));
  el.theme.addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
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
  bindSchematicDrag();
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
