// Parametric N-section pipe adapter: a planar chain of straight sections joined
// by bends (Section 1 · Bend 1 · Section 2 · … · Section N), swept along a
// centerline with per-station inner/outer radii, end features, binary STL export.
//
// Parameter model (single source of truth):
//   { sections: [ {id, w, l, end?}, … ],   // N straight sections, N >= 2
//     bends:    [ {ang, l2, idm, w2, idmSmooth, w2Smooth}, … ] }   // N-1 bends
// Only the FIRST and LAST sections carry an `end` treatment; interior sections
// are pure constant-profile straight runs. Each bend owns the diameter/wall
// transition between its two neighbouring sections. All bends lie in one plane;
// a bend's `ang` is SIGNED ([-90,90]) — its sign is the turn direction.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// ── Parameter limits ─────────────────────────────────────────────────────────
export const SECTION_LIMITS = { id: [1, 120], w: [0.4, 20], l: [3, 200] };
export const BEND_LIMITS = {
  ang: [-90, 90], l2: [0, 200], idm: [1, 120], w2: [0.4, 20],
  idmSmooth: [0, 1], w2Smooth: [0, 1],
};
export const END_LIMITS = {
  ChX: [0, 200], ChY: [0, 20], ChIX: [0, 200], ChIY: [0, 20],   // chamfer (X capped at section length in normalize)
  Fw: [0.8, 25], Ft: [0.8, 15], Fn: [0, 12], Fh: [0, 20],       // flange
  Bh: [0.3, 6], Bn: [1, 8], Bp: [2, 20],                        // barb
  Tn: [1, 12], Tw: [2, 120], Th: [0.2, 12], Tf: [0, 20],        // teeth
  FitL: [0, 200], FitTol: [0, 1], FitChX: [0, 50], FitChY: [0, 20],   // fit (slip joint); FitSide is a string, handled separately
};
export const END_TYPES = ['plain', 'chamfer', 'flange', 'barb', 'teeth', 'fit'];
const END_WHOLE = new Set(['Fn', 'Bn', 'Tn']);
// A slip-joint's shoulder ("stop") is a solid floor as thick as the section wall,
// so it reads as a proper flange-like step; the tolerance gap is bridged over it.
// Capped at half the fit length so a very short stub still has a spigot/socket.
const fitFloor = (wall, L) => Math.min(wall, L * 0.5);

// Fresh default sub-objects (never share mutable references between params).
export function defaultEnd() {
  return {
    type: 'plain',
    ChX: 1.4, ChY: 0.7, ChIX: 1.2, ChIY: 0.6,
    Fw: 5, Ft: 2.5, Fn: 4, Fh: 3,
    Bh: 1.2, Bn: 3, Bp: 6,
    Tn: 1, Tw: 24, Th: 1.5, Tf: 0.4,
    FitSide: 'outside', FitL: 8, FitTol: 0.4, FitChX: 1.2, FitChY: 0.8,
  };
}
export function defaultBend() {
  return { ang: 45, l2: 22, idm: 16, w2: 2.2, idmSmooth: 1, w2Smooth: 1 };
}
export function defaultParams() {
  return {
    sections: [
      { id: 12, w: 2, l: 26, end: defaultEnd() },
      { id: 20, w: 2.5, l: 26, end: defaultEnd() },
    ],
    bends: [defaultBend()],
  };
}
export const DEFAULTS = defaultParams();

// Structured deep clone of a params object (sections/bends/ends).
export function cloneParams(p) {
  return {
    sections: (p.sections || []).map((s) => ({ ...s, end: s.end ? { ...s.end } : undefined })),
    bends: (p.bends || []).map((b) => ({ ...b })),
  };
}

const cnum = (v, lim, whole, dflt) => {
  v = Number(v);
  if (!isFinite(v)) v = dflt;
  const c = clamp(v, lim[0], lim[1]);
  return whole ? Math.round(c) : Math.round(c * 100) / 100;
};

function normEnd(raw) {
  const d = defaultEnd();
  const e = { type: END_TYPES.includes(raw && raw.type) ? raw.type : 'plain' };
  for (const k of Object.keys(END_LIMITS)) e[k] = cnum(raw ? raw[k] : undefined, END_LIMITS[k], END_WHOLE.has(k), d[k]);
  e.FitSide = (raw && raw.FitSide === 'inside') ? 'inside' : 'outside';
  return e;
}

// Resolve a slip-joint stub's radii from its section and fit params. Constant
// wall (= section wall). Inside → male spigot (outer Ø = ID − tol); Outside →
// female socket (bore Ø = OD + tol). Radii are clamped to stay printable.
function fitStub(end, sec) {
  const w = sec.w, O = sec.id / 2 + w, I = sec.id / 2, tol = end.FitTol;
  if (end.FitSide === 'outside') {
    const sI = O + tol / 2;                 // socket bore radius = (OD + tol)/2
    return { side: 'outside', O, I, w, sO: sI + w, sI };
  }
  let sO = I - tol / 2;                      // spigot outer radius = (ID − tol)/2
  let sI = sO - w;
  if (sI < 0.25) { sI = 0.25; sO = Math.max(sO, sI + 0.3); }   // keep a minimal bore/wall
  return { side: 'inside', O, I, w, sO, sI };
}

// Clamp every value into a printable, non-self-intersecting range, and enforce
// the shape invariant (N >= 2 sections, exactly N-1 bends, ends on the two
// extremes only). Returns { p, notes } — notes describe what had to be pulled back.
export function normalize(raw) {
  const notes = [];
  const rawSecs = Array.isArray(raw && raw.sections) ? raw.sections : [];
  const rawBends = Array.isArray(raw && raw.bends) ? raw.bends : [];
  const n = Math.max(2, rawSecs.length);

  const sections = [];
  for (let i = 0; i < n; i++) {
    const rs = rawSecs[i] || {};
    const sec = {
      id: cnum(rs.id, SECTION_LIMITS.id, false, 12),
      w: cnum(rs.w, SECTION_LIMITS.w, false, 2),
      l: cnum(rs.l, SECTION_LIMITS.l, false, 26),
    };
    if (i === 0 || i === n - 1) sec.end = normEnd(rs.end);   // ends only on first/last
    sections.push(sec);
  }
  const bends = [];
  for (let i = 0; i < n - 1; i++) {
    const rb = rawBends[i] || {};
    bends.push({
      ang: cnum(rb.ang, BEND_LIMITS.ang, false, 45),
      l2: cnum(rb.l2, BEND_LIMITS.l2, false, 22),
      idm: cnum(rb.idm, BEND_LIMITS.idm, false, 16),
      w2: cnum(rb.w2, BEND_LIMITS.w2, false, 2.2),
      idmSmooth: cnum(rb.idmSmooth, BEND_LIMITS.idmSmooth, true, 1),
      w2Smooth: cnum(rb.w2Smooth, BEND_LIMITS.w2Smooth, true, 1),
    });
  }

  fitEnd(sections[0], 0, notes);
  fitEnd(sections[n - 1], n - 1, notes);
  return { p: { sections, bends }, notes };
}

// An end feature must fit inside its straight section. Mutates sec.end and
// appends any pull-back notes (labelled by 1-based section index).
function fitEnd(sec, index, notes) {
  const e = sec.end;
  if (!e) return;
  const label = 'Section ' + (index + 1);
  const secLen = sec.l, wall = sec.w;
  if (e.type === 'chamfer') {
    const maxX = secLen;   // an along-axis chamfer can span the whole section
    for (const k of ['ChX', 'ChIX']) {
      if (e[k] > maxX) { e[k] = Math.round(maxX * 100) / 100; notes.push(label + ' chamfer depth limited to ' + e[k] + ' mm by section length'); }
    }
    // The outer and bore radial chamfers share the wall: together at most the
    // full wall thickness, so either can consume it all when the other is 0.
    if (e.ChIY > wall) { e.ChIY = Math.round(wall * 100) / 100; notes.push(label + ' bore chamfer reduced to ' + e.ChIY + ' mm by wall thickness'); }
    const outMax = wall - e.ChIY;
    if (e.ChY > outMax) { e.ChY = Math.round(outMax * 100) / 100; notes.push(label + ' outer chamfer reduced to ' + e.ChY + ' mm — wall shared with the bore chamfer'); }
  } else if (e.type === 'flange') {
    const maxT = secLen * 0.45;
    if (e.Ft > maxT) { e.Ft = Math.round(maxT * 100) / 100; notes.push(label + ' flange thinned to ' + e.Ft + ' mm to fit the section'); }
    // Bolt holes sit on a circle through the middle of the flange lip; keep
    // them inside the lip and clear of one another.
    const nn = e.Fn;
    if (nn >= 1 && e.Fh > 0) {
      const fw = e.Fw;
      const O = (sec.id + 2 * wall) / 2;
      const rc = O + fw / 2;
      let maxDia = fw * 0.8;                                   // fit across the lip width
      if (nn >= 2) maxDia = Math.min(maxDia, 2 * rc * Math.sin(Math.PI / nn) * 0.8); // don't overlap neighbours
      if (e.Fh > maxDia) { e.Fh = Math.round(maxDia * 100) / 100; notes.push(label + ' flange holes reduced to ø' + e.Fh + ' mm to fit'); }
    }
  } else if (e.type === 'barb') {
    const maxSpan = secLen * 0.85;
    if (e.Bn * e.Bp > maxSpan) {
      e.Bn = Math.max(1, Math.floor(maxSpan / e.Bp));
      notes.push(label + ' barbs reduced to ' + e.Bn + ' — no room for more');
    }
  } else if (e.type === 'teeth') {
    // Teeth share the circle: their angular widths can't sum past 360°.
    const maxW = 360 / e.Tn;
    if (e.Tw > maxW) { e.Tw = Math.round(maxW * 100) / 100; notes.push(label + ' teeth narrowed to ' + e.Tw + '° — no room for more'); }
    // The fillet rounds the top edge at its full value (up to ~2.5× the height)
    // and the sides at a quarter, so the cap allows for both.
    const O = (sec.id + 2 * wall) / 2;
    const halfArc = (e.Tw * Math.PI / 180 / 2) * O;
    const maxF = Math.min(2.5 * e.Th, 4 * halfArc);
    if (e.Tf > maxF) { e.Tf = Math.round(maxF * 100) / 100; notes.push(label + ' tooth fillet reduced to ' + e.Tf + ' mm'); }
  } else if (e.type === 'fit') {
    // The stub is carved from the section's length, so it must leave a body.
    const maxL = Math.max(0, secLen - 1);
    if (e.FitL > maxL) { e.FitL = Math.round(maxL * 100) / 100; notes.push(label + ' fit length limited to ' + e.FitL + ' mm by section length'); }
    // A spigot's tolerance can't exceed the bore (it would invert the wall).
    if (e.FitSide === 'inside') {
      const maxTol = Math.max(0, sec.id - 2 * wall - 0.5);
      if (e.FitTol > maxTol) { e.FitTol = Math.round(maxTol * 100) / 100; notes.push(label + ' fit tolerance limited to ' + e.FitTol + ' mm by wall'); }
    }
    // The lead-in chamfer can't exceed the wall (radial) or the stub (axial).
    if (e.FitChY > wall) { e.FitChY = Math.round(wall * 100) / 100; notes.push(label + ' fit chamfer reduced to ' + e.FitChY + ' mm by wall thickness'); }
    if (e.FitChX > e.FitL) { e.FitChX = Math.round(e.FitL * 100) / 100; notes.push(label + ' fit chamfer depth limited to ' + e.FitChX + ' mm by fit length'); }
  }
}

// The diameter/wall transition a bend owns, resolved between its two neighbours.
function transitionOf(a, b, bend) {
  return {
    idA: a.id / 2, idB: b.id / 2, idm: bend.idm / 2,
    wA: a.w, wB: b.w, w2: bend.w2,
    idmSmooth: bend.idmSmooth, w2Smooth: bend.w2Smooth,
  };
}

// Inner radius + wall of a transition at blend parameter t (0..1).
function transitionAt(tr, t) {
  const inner = tr.idmSmooth
    ? lerp(tr.idA, tr.idB, smooth(t))
    : (t < 0.5 ? lerp(tr.idA, tr.idm, smooth(t * 2)) : lerp(tr.idm, tr.idB, smooth(t * 2 - 1)));
  const wall = tr.w2Smooth
    ? lerp(tr.wA, tr.wB, smooth(t))
    : (t < 0.5 ? lerp(tr.wA, tr.w2, smooth(t * 2)) : lerp(tr.w2, tr.wB, smooth(t * 2 - 1)));
  return { inner, wall };
}
// Outer radius of the transition at t, on the same smooth profile profileAt uses.
function outerAtT(tr, t) { const { inner, wall } = transitionAt(tr, t); return inner + wall; }

// Rotate a 2D vector by angle a (CCW). Written termwise so the single-bend case
// reduces bit-for-bit to the original l1 + R·sinφ / R − R·cosφ formulas.
function rot2(vx, vy, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [vx * c - vy * s, vx * s + vy * c];
}

// Build the centerline as a chain of straight/arc segments in the z=0 plane.
// Returns `at(s) → {P, T}` plus per-segment and per-bend metadata.
function makePath(p) {
  const sections = p.sections, bends = p.bends;
  const N = sections.length;
  const segments = [];
  const perBend = [];
  const sectionSpans = [];
  let P = [0, 0, 0], theta = 0, s = 0;

  for (let i = 0; i < N; i++) {
    const L = sections[i].l;
    const dir = [Math.cos(theta), Math.sin(theta), 0];
    segments.push({ kind: 'section', si: i, straight: true, sStart: s, sEnd: s + L, P0: [P[0], P[1], P[2]], dir, T: [dir[0], dir[1], 0] });
    sectionSpans.push({ sStart: s, sEnd: s + L });
    P = [P[0] + L * dir[0], P[1] + L * dir[1], 0];
    s += L;

    if (i < N - 1) {
      const bd = bends[i];
      const A = (bd.ang * Math.PI) / 180;                 // signed
      const bent = Math.abs(A) > 1e-6;
      const tr = transitionOf(sections[i], sections[i + 1], bd);
      // B is the arc length along the OUTER surface on the inner side of the
      // bend; solve the centreline radius that produces exactly that length.
      const sol = bent ? solveBendRadius(tr, Math.abs(A), bd.l2) : { R: 0, clamped: false };
      const R = sol.R;
      const arcLen = bent ? R * Math.abs(A) : bd.l2;
      const minFace = bent ? innerFaceLength(tr, Math.abs(A), minBendRadius(tr)) : 0;
      const sStart = s, sEnd = s + arcLen;
      let center = null;
      if (bent) {
        const sign = A >= 0 ? 1 : -1;                     // + = left turn, − = right
        const nrm = [-Math.sin(theta) * sign, Math.cos(theta) * sign, 0];
        center = [P[0] + R * nrm[0], P[1] + R * nrm[1], 0];
        const v0 = [P[0] - center[0], P[1] - center[1]];
        segments.push({ kind: 'bend', bi: i, straight: false, sStart, sEnd, tr, R, center, v0, sign, theta0: theta });
        const rEnd = rot2(v0[0], v0[1], A);
        P = [center[0] + rEnd[0], center[1] + rEnd[1], 0];
        theta = theta + A;
      } else {
        const dir2 = [Math.cos(theta), Math.sin(theta), 0];
        segments.push({ kind: 'bend', bi: i, straight: true, sStart, sEnd, tr, P0: [P[0], P[1], P[2]], dir: dir2, T: [dir2[0], dir2[1], 0] });
        P = [P[0] + arcLen * dir2[0], P[1] + arcLen * dir2[1], 0];
      }
      perBend.push({ bi: i, R, arcLen, A, bend: bent, center, faceClamped: sol.clamped, minFace, sStart, sEnd });
      s = sEnd;
    }
  }

  function at(s) {
    let seg = segments[segments.length - 1];
    for (const sg of segments) { if (s <= sg.sEnd) { seg = sg; break; } }
    if (seg.straight) {
      const d = s - seg.sStart;
      return { P: [seg.P0[0] + d * seg.dir[0], seg.P0[1] + d * seg.dir[1], 0], T: [seg.T[0], seg.T[1], seg.T[2]] };
    }
    const phi = (s - seg.sStart) / seg.R;
    const ang = seg.sign * phi;
    const [rx, ry] = rot2(seg.v0[0], seg.v0[1], ang);
    const ha = seg.theta0 + ang;
    return { P: [seg.center[0] + rx, seg.center[1] + ry, 0], T: [Math.cos(ha), Math.sin(ha), 0] };
  }

  return { at, total: s, segments, perBend, sectionSpans, sections, bends };
}

// True 2D path length of the outer surface on the inner side of the bend, for a
// given centreline radius R. The surface sits at ρ(φ) = R - outer(t); because
// the two ends differ in diameter the curve also moves radially, so the length
// is ∫√(ρ² + ρ'²) dφ rather than just ∫ρ dφ.
function innerFaceLength(tr, A, R) {
  const n = 400;
  let len = 0, prev = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const rho = R - outerAtT(tr, t);
    const phi = t * A;
    const q = [rho * Math.sin(phi), -rho * Math.cos(phi)];
    if (prev) len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    prev = q;
  }
  return len;
}

// Smallest R that keeps the inner face clear of the centreline, plus margin.
function minBendRadius(tr) {
  let mx = 0;
  for (let i = 0; i <= 40; i++) mx = Math.max(mx, outerAtT(tr, i / 40));
  return mx * 1.02;
}

// Solve R so the inner face arc equals the requested length. Monotonic in R.
function solveBendRadius(tr, A, target) {
  let lo = minBendRadius(tr);
  if (innerFaceLength(tr, A, lo) >= target) return { R: lo, clamped: true };
  let hi = lo + Math.max(target, 1) / Math.max(A, 1e-3) + 100;
  while (innerFaceLength(tr, A, hi) < target && hi < 1e6) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (innerFaceLength(tr, A, mid) < target) lo = mid; else hi = mid;
  }
  return { R: (lo + hi) / 2, clamped: false };
}

// Inner radius + outer radius at arclength s: constant within a straight
// section, blended across a bend's transition.
function profileAt(s, path) {
  let seg = path.segments[path.segments.length - 1];
  for (const sg of path.segments) { if (s <= sg.sEnd) { seg = sg; break; } }
  if (seg.kind === 'section') {
    const sec = path.sections[seg.si];
    return { inner: sec.id / 2, outer: sec.id / 2 + sec.w };
  }
  const len = seg.sEnd - seg.sStart;
  const t = len > 0 ? (s - seg.sStart) / len : 1;
  const { inner, wall } = transitionAt(seg.tr, t);
  return { inner, outer: inner + wall };
}

// ── Teeth end treatment ──────────────────────────────────────────────────────
// A ring of saw-tooth barbs near the end. Each tooth spans an angular sector:
// its radius rises to O+Th at the centre and rounds back to the base radius O at
// the sector edges over a fillet, and is flat O between teeth. Along the axis the
// tooth is a barb: a lead-in ramp out to the peak, then a steep drop (cliff) back
// to the base. The profile is zero at both the end face and the inner boundary,
// which keeps the end cap a flat annulus and the outer surface one watertight tube.
const TOOTH_PEAK = 0.7, TOOTH_CLIFF = 0.8;   // ramp to the peak by 0.7, cliff back to base by 0.8
// Smooth minimum: like Math.min(a, b) but rounds the corner where they cross,
// over a radius k. Used to fillet the tooth's top edge (the ramp/cliff crest).
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
// Axial tooth profile in [0=end face .. 1=inner boundary]: a lead-in ramp up to
// the peak, then a steep cliff back to the base (the saw-tooth barb). It's the
// lower of the two lines; `k` rounds their crossing so the top edge is filleted.
function toothBumpAxial(u, k) {
  u = clamp(u, 0, 1);
  const ramp = u / TOOTH_PEAK;
  const cliff = 1 - (u - TOOTH_PEAK) / (TOOTH_CLIFF - TOOTH_PEAK);
  return clamp(smin(ramp, cliff, k || 0), 0, 1);
}
// Teeth are centred on the top of the pipe within the bend plane: θ=0 in ring()
// points out of that plane (the +z "side") and +v (θ=+90°) is the bottom, so the
// pattern is phase-shifted to −90° to put a tooth at the top (−v). A single tooth
// then sits at the top, and larger counts stay symmetric about the bend plane.
const TOOTH_PHASE = -Math.PI / 2;
function toothAngular(th, n, half, fRad) {
  const sector = (2 * Math.PI) / n;
  const rel = (th - TOOTH_PHASE) / sector;
  const frac = rel - Math.round(rel);                   // −0.5..0.5 of the nearest sector
  const delta = Math.abs(frac) * sector;                // angular distance to the nearest tooth centre
  // A gap only exists where teeth don't fill the circle (half < sector/2). When
  // they do fill it, the seams stay at full height so the ring is solid.
  if (delta >= half && half < sector / 2 - 1e-9) return 0;
  const edge = half - delta;                            // inward from the tooth edge
  if (fRad <= 0 || edge >= fRad) return 1;
  const x = clamp(edge / fRad, 0, 1);
  return x * x * (3 - 2 * x);                            // smoothstep fillet, base → top
}
function teethLength(end, secLen) {
  return Math.min(secLen * 0.7, Math.max(1.2, end.Th * 2.2));
}
// Teeth parameters resolved for meshing. `atStart` = true for the first section
// (teeth at s=0), false for the last (teeth at s=T). `T` is the total path length.
function teethSpec(end, O, T, secLen, atStart) {
  const L = teethLength(end, secLen);
  const n = Math.round(end.Tn);
  const half = (end.Tw * Math.PI) / 180 / 2;
  const halfGap = Math.max(0, Math.PI / n - half);   // sector/2 − half: angular room to the next tooth
  return {
    n,
    half,
    // Side (angular) fillet gets a QUARTER of the value — it reads strongly there,
    // so most of the value is reserved for the top edge where it matters most.
    // Still capped by the tooth half-width and the gap to its neighbour, so teeth
    // that fill the circle merge into a solid ring instead of grooving each seam.
    fRad: Math.min(0.25 * end.Tf / Math.max(O, 0.1), half, halfGap),
    // Top-edge fillet gets the FULL value; ~2.5× the height fully rounds the crest.
    kAx: clamp(end.Tf / Math.max(end.Th, 0.01), 0, 2.5),
    h: end.Th, O, L,
    dir: atStart ? 1 : -1,
    sEnd: atStart ? 0 : T,
    sMin: atStart ? 0 : T - L,
    sMax: atStart ? L : T,
  };
}
// Ring-radius function r(k, θ) for a teeth-zone station at arclength s.
function teethRadiusFn(spec, s) {
  const u = spec.dir > 0 ? s / spec.L : (spec.sEnd - s) / spec.L;
  const ax = toothBumpAxial(u, spec.kAx);
  const { O, h, n, half, fRad } = spec;
  return (k, th) => O + h * ax * toothAngular(th, n, half, fRad);
}

// Outer-radius control points measured from one end, innermost first.
function endFeature(end, baseOuter, sec) {
  const type = end.type;
  const secLen = sec.l;
  const O = baseOuter;
  const pts = [];
  if (type === 'chamfer') {
    const cx = end.ChX, cy = end.ChY;
    if (cx > 0 && cy > 0) pts.push({ d: 0, r: O - cy }, { d: cx, r: O });
    else pts.push({ d: 0, r: O });
  } else if (type === 'flange') {
    const fw = end.Fw, ft = end.Ft;
    pts.push({ d: 0, r: O + fw }, { d: ft, r: O + fw }, { d: ft, r: O });
  } else if (type === 'barb') {
    const h = end.Bh, n = end.Bn, pitch = end.Bp;
    // Simple saw-tooth riding on the outer surface: each tooth ramps up to its
    // peak over one pitch, then a vertical cliff back down to O (never below O,
    // so it can't dip into the wall). Each corner station is duplicated so the
    // sweep gives it a hard edge (crisp shading) rather than smoothing the ramp
    // into the cliff — otherwise the cliff's normal is averaged away.
    pts.push({ d: 0, r: O });
    for (let k = 0; k < n; k++) {
      const top = (k + 1) * pitch;
      pts.push({ d: top, r: O + h }, { d: top, r: O + h });   // ramp to peak, hard edge
      pts.push({ d: top, r: O }, { d: top, r: O });           // cliff to base, hard edge
    }
  } else if (type === 'teeth') {
    // Envelope of the teeth zone (peak radius vs. axial distance) — used for the
    // silhouette and to reserve the zone; the mesh replaces these stations with
    // per-angle radius functions (see build / teethRadiusFn). Sampled densely
    // through the ramp with points straddling the cliff so the barb edge stays crisp.
    const h = end.Th, L = teethLength(end, secLen);
    const k = clamp(end.Tf / Math.max(end.Th, 0.01), 0, 2.5);
    const us = [0, 0.15, 0.3, 0.45, 0.55, 0.62, 0.66, 0.68, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.83, 0.9, 1];
    for (const u of us) pts.push({ d: u * L, r: O + h * toothBumpAxial(u, k) });
  } else if (type === 'fit' && end.FitL > 0) {
    // Slip joint: a coaxial stub stepped off the end, meeting the body at a flat
    // shoulder ("stop") backed by a thin solid floor (FIT_FLOOR). Inside → male
    // spigot (outer steps DOWN to the stub, lead-in chamfer on the outer tip).
    // Outside → female socket (outer steps UP; the bore is chamfered instead).
    const st = fitStub(end, sec);
    const L = end.FitL, floor = fitFloor(st.w, L);
    if (st.side === 'inside') {
      const cx = Math.min(end.FitChX, L - floor), cy = end.FitChY;
      if (cx > 0 && cy > 0) pts.push({ d: 0, r: st.sO - cy }, { d: cx, r: st.sO });
      else pts.push({ d: 0, r: st.sO });
      pts.push({ d: L - floor, r: st.sO });   // spigot outer runs to the stop
      pts.push({ d: L - floor, r: O });        // stop: outer step up to the body (zone ends here)
    } else {
      pts.push({ d: 0, r: st.sO });            // socket outer (no outer chamfer)
      pts.push({ d: L, r: st.sO });            // runs through the floor
      pts.push({ d: L, r: O });                // collar step to the body
    }
  } else {
    pts.push({ d: 0, r: O });
  }
  return pts;
}

// Bore-side control points measured from one end, innermost first. The chamfer
// and the fit (slip joint) touch the bore; every other treatment leaves it straight.
function innerEndFeature(end, baseInner, sec) {
  if (end.type === 'fit' && end.FitL > 0) {
    const st = fitStub(end, sec);
    const L = end.FitL, floor = fitFloor(st.w, L);
    if (st.side === 'inside') {
      // Spigot bore runs straight through the insertion length, then opens back
      // out to the body bore as one gradual taper spanning the whole inside of
      // the section (a smooth internal reducer, rather than an abrupt wall).
      return [{ d: 0, r: st.sI }, { d: L - floor, r: st.sI }, { d: sec.l, r: st.I }];
    }
    // Socket bore = stub bore with a lead-in flare, running to the stop where it
    // steps DOWN to the body bore (the mate bottoms against that shoulder).
    const cx = Math.min(end.FitChX, L - floor), cy = end.FitChY, pts = [];
    if (cx > 0 && cy > 0) pts.push({ d: 0, r: st.sI + cy }, { d: cx, r: st.sI });
    else pts.push({ d: 0, r: st.sI });
    pts.push({ d: L - floor, r: st.sI });
    pts.push({ d: L - floor, r: st.I });
    return pts;
  }
  if (end.type !== 'chamfer') return [{ d: 0, r: baseInner }];
  const ix = end.ChIX, iy = end.ChIY;
  if (ix <= 0 || iy <= 0) return [{ d: 0, r: baseInner }];
  return [{ d: 0, r: baseInner + iy }, { d: ix, r: baseInner }];
}

// Texture-coordinate tiling: UREPEAT tiles around the circumference, and one
// tile per VSCALE mm along the length (and across a cap/flange face). A tileable
// texture then wraps seamlessly.
const TEX_UREPEAT = 8;
const TEX_VSCALE = 6;

// `r` is either a scalar radius or a function (k, θ) → radius, letting a station
// vary its radius by angle (used by the teeth end treatment). Emits N+1 vertices
// — the last duplicates the first position but carries u at the full wrap — so a
// wrap-around texture has no seam at the ring closure. The k=0 / k=N index pair
// is recorded in `seams` so their normals can be welded back together (the extra
// vertex is only for UVs, not a shading crease). `vCoord` is the v texture
// coordinate; pass `uvs`/`seams` = null to skip.
function ring(out, uvs, seams, path, s, r, N, vCoord) {
  const { P, T } = path.at(s);
  const u = [0, 0, 1], v = [T[1], -T[0], 0];
  const base = out.length / 3;
  const fn = typeof r === 'function';
  for (let k = 0; k <= N; k++) {
    const kk = k % N;
    const th = (2 * Math.PI * kk) / N, c = Math.cos(th), sn = Math.sin(th);
    const rk = fn ? r(kk, th) : r;
    out.push(
      P[0] + rk * (c * u[0] + sn * v[0]),
      P[1] + rk * (c * u[1] + sn * v[1]),
      P[2] + rk * (c * u[2] + sn * v[2])
    );
    if (uvs) uvs.push((k / N) * TEX_UREPEAT, vCoord || 0);
  }
  if (seams) seams.push(base, base + N);
  return base;
}

function tubeSurface(verts, uvs, seams, idx, path, stations, N, outward) {
  // The v texture coordinate follows the profile's arc length (in the s–r plane)
  // so a vertical step like a barb cliff gets real UV extent, not a zero-height
  // band. r may be an angle-dependent function (teeth), so only count radial
  // change between two scalar-radius stations.
  let vAcc = 0;
  const bases = stations.map((st, i) => {
    if (i > 0) {
      const prev = stations[i - 1];
      const dr = (typeof st.r === 'number' && typeof prev.r === 'number') ? st.r - prev.r : 0;
      vAcc += Math.hypot(st.s - prev.s, dr);
    }
    return ring(verts, uvs, seams, path, st.s, st.r, N, vAcc / TEX_VSCALE);
  });
  // pick winding by testing the first non-degenerate pair
  let flip = false;
  for (let i = 0; i + 1 < stations.length; i++) {
    const b0 = bases[i], b1 = bases[i + 1];
    const a = [verts[b0 * 3], verts[b0 * 3 + 1], verts[b0 * 3 + 2]];
    const b = [verts[(b0 + 1) * 3], verts[(b0 + 1) * 3 + 1], verts[(b0 + 1) * 3 + 2]];
    const c = [verts[(b1 + 1) * 3], verts[(b1 + 1) * 3 + 1], verts[(b1 + 1) * 3 + 2]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (nx * nx + ny * ny + nz * nz < 1e-12) continue;
    const P = path.at(stations[i].s).P;
    const rad = [a[0] - P[0], a[1] - P[1], a[2] - P[2]];
    const dot = nx * rad[0] + ny * rad[1] + nz * rad[2];
    flip = outward ? dot < 0 : dot > 0;
    break;
  }
  for (let i = 0; i + 1 < stations.length; i++) {
    // Two identical consecutive stations mean "hard edge here": emit no quad
    // between them, so their (coincident) rings keep separate normals. Used to
    // give a saw-tooth barb crisp corners instead of smoothing ramp into cliff.
    if (stations[i].s === stations[i + 1].s && stations[i].r === stations[i + 1].r) continue;
    const b0 = bases[i], b1 = bases[i + 1];
    for (let k = 0; k < N; k++) {
      const k1 = k + 1;   // N+1 vertices per ring, so no wraparound modulo
      if (flip) {
        idx.push(b0 + k, b1 + k1, b0 + k1, b0 + k, b1 + k, b1 + k1);
      } else {
        idx.push(b0 + k, b0 + k1, b1 + k1, b0 + k, b1 + k1, b1 + k);
      }
    }
  }
  return bases;
}

function cap(verts, uvs, seams, idx, path, s, ri, ro, N, outSign) {
  const bi = ring(verts, uvs, seams, path, s, ri, N, ri / TEX_VSCALE);
  const bo = ring(verts, uvs, seams, path, s, ro, N, ro / TEX_VSCALE);
  const T = path.at(s).T;
  // test winding against the outward face direction
  const a = [verts[bi * 3], verts[bi * 3 + 1], verts[bi * 3 + 2]];
  const b = [verts[bo * 3], verts[bo * 3 + 1], verts[bo * 3 + 2]];
  const c = [verts[(bo + 1) * 3], verts[(bo + 1) * 3 + 1], verts[(bo + 1) * 3 + 2]];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const flip = (nx * T[0] + ny * T[1] + nz * T[2]) * outSign < 0;
  for (let k = 0; k < N; k++) {
    const k1 = k + 1;   // N+1 vertices per ring
    if (flip) idx.push(bi + k, bo + k1, bo + k, bi + k, bi + k1, bo + k1);
    else idx.push(bi + k, bo + k, bo + k1, bi + k, bo + k1, bi + k1);
  }
}

// A flanged end whose lip is drilled with a symmetric ring of bolt holes. The
// lip is a thick washer: an exposed front face (annulus [bore, O+fw]), a back
// face (annulus [O, O+fw]), the outer rim, and one cylindrical barrel per hole.
// Each face is a flat annulus-with-holes triangulated by earcut. Every boundary
// circle is sampled to coincide with the swept tube it meets, so the seams are
// watertight without shared vertex indices — the module's usual contract.
function buildFlangeEnd(verts, uvs, seams, idx, path, N, o) {
  const { sFace, sRoot, O, fw, rh, n, boreR, frontPlusTangent } = o;
  const rOut = O + fw, rc = O + fw / 2;
  const M = Math.max(16, Math.round(N / 4));   // segments per hole

  // A face plane at arclength s: origin P, in-plane axis v, with local coord
  // A along +z and B along v (matching ring()'s cos·u + sin·v convention).
  const basis = (s) => { const { P, T } = path.at(s); return { P, v: [T[1], -T[0], 0] }; };
  const facePush = (b, A, B) => {
    const i = verts.length / 3;
    verts.push(b.P[0] + B * b.v[0], b.P[1] + B * b.v[1], b.P[2] + A);
    if (uvs) uvs.push(A / TEX_VSCALE, B / TEX_VSCALE);   // planar UVs on the flat face
    return i;
  };
  const triNormal = (i0, i1, i2) => {
    const e1 = [verts[i1 * 3] - verts[i0 * 3], verts[i1 * 3 + 1] - verts[i0 * 3 + 1], verts[i1 * 3 + 2] - verts[i0 * 3 + 2]];
    const e2 = [verts[i2 * 3] - verts[i0 * 3], verts[i2 * 3 + 1] - verts[i0 * 3 + 1], verts[i2 * 3 + 2] - verts[i0 * 3 + 2]];
    return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  };

  // Flat annulus [rIn, rOut] with n bolt holes. earcut emits clockwise tris,
  // whose 3D normal is −tangent; `reverse` flips to +tangent.
  const face = (s, rIn, reverse) => {
    const b = basis(s);
    const data = [], gi = [], holeIdx = [];
    const add = (A, B) => { gi.push(facePush(b, A, B)); data.push(A, B); };
    for (let k = 0; k < N; k++) { const th = (2 * Math.PI * k) / N; add(rOut * Math.cos(th), rOut * Math.sin(th)); }
    holeIdx.push(gi.length);
    for (let k = 0; k < N; k++) { const th = (2 * Math.PI * k) / N; add(rIn * Math.cos(th), rIn * Math.sin(th)); }
    for (let j = 0; j < n; j++) {
      holeIdx.push(gi.length);
      const phi = (2 * Math.PI * j) / n, A0 = rc * Math.cos(phi), B0 = rc * Math.sin(phi);
      for (let m = 0; m < M; m++) { const ps = (2 * Math.PI * m) / M; add(A0 + rh * Math.cos(ps), B0 + rh * Math.sin(ps)); }
    }
    const tris = earcut(data, holeIdx);
    for (let t = 0; t < tris.length; t += 3) {
      const a = gi[tris[t]], c1 = gi[tris[t + 1]], c2 = gi[tris[t + 2]];
      if (reverse) idx.push(a, c1, c2); else idx.push(a, c2, c1);
    }
  };

  // Barrel through one hole; the solid's outward normal faces the hole axis.
  const barrel = (phi) => {
    const A0 = rc * Math.cos(phi), B0 = rc * Math.sin(phi);
    const bF = basis(sFace), bR = basis(sRoot);
    const baseF = verts.length / 3;
    for (let m = 0; m < M; m++) { const ps = (2 * Math.PI * m) / M; facePush(bF, A0 + rh * Math.cos(ps), B0 + rh * Math.sin(ps)); }
    const baseR = verts.length / 3;
    for (let m = 0; m < M; m++) { const ps = (2 * Math.PI * m) / M; facePush(bR, A0 + rh * Math.cos(ps), B0 + rh * Math.sin(ps)); }
    // toward the hole axis at m=0 is −z; flip if the first tri faces away
    const nrm = triNormal(baseF, baseF + 1, baseR + 1);
    const flip = -nrm[2] < 0;
    for (let k = 0; k < M; k++) {
      const k1 = (k + 1) % M;
      if (!flip) idx.push(baseF + k, baseF + k1, baseR + k1, baseF + k, baseR + k1, baseR + k);
      else idx.push(baseF + k, baseR + k1, baseF + k1, baseF + k, baseR + k, baseR + k1);
    }
  };

  face(sFace, boreR, frontPlusTangent);   // exposed end face, [bore, O+fw]
  face(sRoot, O, !frontPlusTangent);      // lip back face, [O, O+fw]
  tubeSurface(verts, uvs, seams, idx, path, [{ s: sFace, r: rOut }, { s: sRoot, r: rOut }], N, true);  // rim
  for (let j = 0; j < n; j++) barrel((2 * Math.PI * j) / n);
}

export function build(raw, radialSegments) {
  const { p, notes } = normalize(raw);
  const sections = p.sections, bends = p.bends;
  const nSec = sections.length;
  const first = sections[0], last = sections[nSec - 1];
  const od = sections.map((sc) => sc.id + 2 * sc.w);
  const hasTeeth = first.end.type === 'teeth' || last.end.type === 'teeth';
  // Teeth need more angular resolution to render their sectors and fillets.
  const N = hasTeeth ? Math.max(radialSegments || 84, 160) : (radialSegments || 84);
  const path = makePath(p);
  const T = path.total;
  for (let i = 0; i < path.perBend.length; i++) {
    const b = path.perBend[i];
    if (b.bend && b.faceClamped) {
      notes.push('Bend ' + (i + 1) + ' raised to ~' + (Math.round(b.minFace * 10) / 10) + ' mm — the tightest bend this diameter allows');
    }
  }

  // ---- longitudinal sampling -------------------------------------------
  // End features only exist on the first and last sections.
  const Ofirst = od[0] / 2, Olast = od[nSec - 1] / 2;
  const featA = endFeature(first.end, Ofirst, first);
  const featB = endFeature(last.end, Olast, last);
  const zoneA = featA[featA.length - 1].d;
  const zoneB = featB[featB.length - 1].d;

  const samples = [];
  const push = (s) => { if (s >= -1e-9 && s <= T + 1e-9) samples.push(clamp(s, 0, T)); };
  const seg = (from, to, n) => { for (let i = 0; i <= n; i++) push(lerp(from, to, i / n)); };
  for (const sg of path.segments) {
    const span = sg.sEnd - sg.sStart;
    if (sg.kind === 'section') {
      seg(sg.sStart, sg.sEnd, Math.max(4, Math.ceil(span / 2)));
    } else {
      const bd = bends[sg.bi], b = path.perBend[sg.bi];
      seg(sg.sStart, sg.sEnd, b.bend ? Math.max(24, Math.ceil(Math.abs(bd.ang) / 1.5)) : Math.max(6, Math.ceil(bd.l2 / 2)));
    }
  }

  const innerFeatA = innerEndFeature(first.end, first.id / 2, first);
  const innerFeatB = innerEndFeature(last.end, last.id / 2, last);
  const iZoneA = innerFeatA[innerFeatA.length - 1].d;
  const iZoneB = innerFeatB[innerFeatB.length - 1].d;
  const sorted = [...new Set(samples)].sort((a, b) => a - b);

  const inner = [];
  for (const f of innerFeatA) inner.push({ s: f.d, r: f.r });
  for (const s of sorted) {
    if (s > iZoneA + 1e-6 && s < T - iZoneB - 1e-6) inner.push({ s, r: profileAt(s, path).inner });
  }
  for (let i = innerFeatB.length - 1; i >= 0; i--) inner.push({ s: T - innerFeatB[i].d, r: innerFeatB[i].r });

  // A flange with drilled holes can't be a plain surface of revolution, so its
  // lip is meshed separately (see buildFlangeEnd). When that happens the outer
  // sweep is trimmed to the lip root and the end cap is replaced by hole-aware
  // faces; the full station list is still kept for the schematic silhouette.
  const holesA = first.end.type === 'flange' && first.end.Fn >= 1 && first.end.Fh > 0;
  const holesB = last.end.type === 'flange' && last.end.Fn >= 1 && last.end.Fh > 0;

  const assembleOuter = (trimA, trimB) => {
    const arr = [];
    if (trimA) arr.push({ s: first.end.Ft, r: Ofirst });
    else for (const f of featA) arr.push({ s: f.d, r: f.r });
    for (const s of sorted) {
      if (s > zoneA + 1e-6 && s < T - zoneB - 1e-6) arr.push({ s, r: profileAt(s, path).outer });
    }
    if (trimB) arr.push({ s: T - last.end.Ft, r: Olast });
    else for (let i = featB.length - 1; i >= 0; i--) arr.push({ s: T - featB[i].d, r: featB[i].r });
    return arr;
  };
  const outerStations = assembleOuter(false, false);                         // full, for the silhouette
  let meshStations = (holesA || holesB) ? assembleOuter(holesA, holesB) : outerStations;

  // Teeth turn their zone's stations from a scalar radius into a per-angle
  // radius function (the base outer radius there is O, so the bumps ride on top
  // of the plain cylinder). Mapped into a fresh array so the scalar-envelope
  // outerStations stay untouched.
  const teethSpecs = [];
  if (first.end.type === 'teeth') teethSpecs.push(teethSpec(first.end, Ofirst, T, first.l, true));
  if (last.end.type === 'teeth') teethSpecs.push(teethSpec(last.end, Olast, T, last.l, false));
  if (teethSpecs.length) {
    meshStations = meshStations.map((st) => {
      for (const spec of teethSpecs) {
        if (st.s >= spec.sMin - 1e-6 && st.s <= spec.sMax + 1e-6) return { s: st.s, r: teethRadiusFn(spec, st.s) };
      }
      return st;
    });
  }

  const verts = [], uvs = [], seams = [], idx = [];
  tubeSurface(verts, uvs, seams, idx, path, meshStations, N, true);
  tubeSurface(verts, uvs, seams, idx, path, inner, N, false);
  if (holesA) buildFlangeEnd(verts, uvs, seams, idx, path, N, { sFace: 0, sRoot: first.end.Ft, O: Ofirst, fw: first.end.Fw, rh: first.end.Fh / 2, n: first.end.Fn, boreR: first.id / 2, frontPlusTangent: false });
  else cap(verts, uvs, seams, idx, path, 0, inner[0].r, meshStations[0].r, N, -1);
  if (holesB) buildFlangeEnd(verts, uvs, seams, idx, path, N, { sFace: T, sRoot: T - last.end.Ft, O: Olast, fw: last.end.Fw, rh: last.end.Fh / 2, n: last.end.Fn, boreR: last.id / 2, frontPlusTangent: true });
  else cap(verts, uvs, seams, idx, path, T, inner[inner.length - 1].r, meshStations[meshStations.length - 1].r, N, 1);

  const positions = new Float32Array(verts);
  const uv = new Float32Array(uvs);
  const seamPairs = new Uint32Array(seams);
  const indices = new Uint32Array(idx);

  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < bbox.min[a]) bbox.min[a] = v;
      if (v > bbox.max[a]) bbox.max[a] = v;
    }
  }
  bbox.size = [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];

  // ---- 2D silhouette in the bend plane (for the schematic) --------------
  // `st.r` is a scalar radius, or { top, bot } to give the two sides different
  // radii — which the bend plane cuts at +v and −v (see silStations for teeth).
  const sil = (stations) => {
    const top = [], bot = [];
    for (const st of stations) {
      const { P, T: t } = path.at(st.s);
      const v = [t[1], -t[0]];
      const rTop = typeof st.r === 'object' ? st.r.top : st.r;
      const rBot = typeof st.r === 'object' ? st.r.bot : st.r;
      top.push([P[0] + rTop * v[0], P[1] + rTop * v[1]]);
      bot.push([P[0] - rBot * v[0], P[1] - rBot * v[1]]);
    }
    return { top, bot, s: stations.map((st) => st.s) };
  };
  // The bend plane cuts the pipe at the +v and −v directions (θ = ±90° in
  // ring()), so sample the tooth radius there rather than the peak envelope —
  // a tooth then shows in the section only on the side it actually occupies.
  const silStations = teethSpecs.length ? outerStations.map((st) => {
    for (const spec of teethSpecs) {
      if (st.s >= spec.sMin - 1e-6 && st.s <= spec.sMax + 1e-6) {
        const fn = teethRadiusFn(spec, st.s);
        return { s: st.s, r: { top: fn(0, Math.PI / 2), bot: fn(0, -Math.PI / 2) } };
      }
    }
    return st;
  }) : outerStations;
  const centerLine = [...new Set(samples)].sort((a, b) => a - b).map((s) => {
    const P = path.at(s).P; return [P[0], P[1]];
  });

  // A bore-diameter tick per section (for the schematic), placed at each
  // straight section's midpoint.
  const bores = sections.map((sc, i) => {
    const span = path.sectionSpans[i];
    return { s: (span.sStart + span.sEnd) / 2, id: sc.id, od: od[i] };
  });

  return {
    p, notes, positions, uv, seamPairs, indices, bbox,
    triCount: indices.length / 3,
    path: {
      total: T,
      // Any bend present → the schematic uses its bend/arc drawing mode.
      bend: path.perBend.some((b) => b.bend),
      segments: path.segments.map((s) => ({
        kind: s.kind, si: s.si, bi: s.bi, sStart: s.sStart, sEnd: s.sEnd,
        curved: s.kind === 'bend' ? path.perBend[s.bi].bend : false,
      })),
      sections: sections.map((sc, i) => {
        const sp = path.sectionSpans[i];
        const a = path.at(sp.sStart), c = path.at(sp.sEnd);
        return { id: sc.id, w: sc.w, l: sc.l, od: od[i], sStart: sp.sStart, sEnd: sp.sEnd, p0: [a.P[0], a.P[1]], p1: [c.P[0], c.P[1]], t: [a.T[0], a.T[1]] };
      }),
      bends: path.perBend.map((b, i) => {
        const a = path.at(b.sStart), c = path.at(b.sEnd);
        return {
          ang: bends[i].ang, l2: bends[i].l2, R: b.R, arcLen: b.arcLen, A: b.A, bend: b.bend,
          idmSmooth: bends[i].idmSmooth, idm: bends[i].idm,
          center: b.center, faceClamped: b.faceClamped, minFace: b.minFace, sStart: b.sStart, sEnd: b.sEnd,
          p0: [a.P[0], a.P[1]], p1: [c.P[0], c.P[1]], t0: [a.T[0], a.T[1]], t1: [c.T[0], c.T[1]],
        };
      }),
    },
    od, bores,
    silhouette: { outer: sil(silStations), inner: sil(inner), center: centerLine },
    endPoints: [path.at(0), path.at(T)],
  };
}

/* ── Ear-clipping triangulation with holes ─────────────────────────────────
   Adapted from mapbox/earcut (ISC License). The z-order hashing fast path is
   removed — the flange faces have few vertices, so the plain O(n²) ear test is
   fine. `data` is a flat [x0,y0,x1,y1,…] list; `holeIndices` gives the vertex
   index at which each hole ring starts. Returns a flat list of triangle vertex
   indices, wound clockwise (matching the outer ring earcut normalizes to). */
function earcut(data, holeIndices) {
  const dim = 2;
  const hasHoles = holeIndices && holeIndices.length;
  const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
  let outerNode = ecLinkedList(data, 0, outerLen, dim, true);
  const triangles = [];
  if (!outerNode || outerNode.next === outerNode.prev) return triangles;
  if (hasHoles) outerNode = ecEliminateHoles(data, holeIndices, outerNode, dim);
  ecEarcutLinked(outerNode, triangles, dim);
  return triangles;
}

function ECNode(i, x, y) {
  this.i = i; this.x = x; this.y = y;
  this.prev = null; this.next = null; this.steiner = false;
}

function ecLinkedList(data, start, end, dim, clockwise) {
  let i, last;
  if (clockwise === (ecSignedArea(data, start, end, dim) > 0)) {
    for (i = start; i < end; i += dim) last = ecInsert(i / dim, data[i], data[i + 1], last);
  } else {
    for (i = end - dim; i >= start; i -= dim) last = ecInsert(i / dim, data[i], data[i + 1], last);
  }
  if (last && ecEquals(last, last.next)) { ecRemove(last); last = last.next; }
  return last;
}

function ecFilterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start, again;
  do {
    again = false;
    if (!p.steiner && (ecEquals(p, p.next) || ecArea(p.prev, p, p.next) === 0)) {
      ecRemove(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== end);
  return end;
}

function ecEarcutLinked(ear, triangles, dim, pass) {
  if (!ear) return;
  let stop = ear, prev, next;
  while (ear.prev !== ear.next) {
    prev = ear.prev; next = ear.next;
    if (ecIsEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);
      ecRemove(ear);
      ear = next.next; stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) ecEarcutLinked(ecFilterPoints(ear), triangles, dim, 1);
      else if (pass === 1) { ear = ecCureLocal(ecFilterPoints(ear), triangles); ecEarcutLinked(ear, triangles, dim, 2); }
      else if (pass === 2) ecSplitEarcut(ear, triangles, dim);
      break;
    }
  }
}

function ecIsEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  if (ecArea(a, b, c) >= 0) return false;
  let p = ear.next.next;
  while (p !== ear.prev) {
    if (ecPointInTri(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && ecArea(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

function ecCureLocal(start, triangles) {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!ecEquals(a, b) && ecIntersects(a, p, p.next, b) && ecLocallyInside(a, b) && ecLocallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);
      ecRemove(p); ecRemove(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return ecFilterPoints(p);
}

function ecSplitEarcut(start, triangles, dim) {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && ecValidDiagonal(a, b)) {
        let c = ecSplitPolygon(a, b);
        a = ecFilterPoints(a, a.next);
        c = ecFilterPoints(c, c.next);
        ecEarcutLinked(a, triangles, dim);
        ecEarcutLinked(c, triangles, dim);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function ecEliminateHoles(data, holeIndices, outerNode, dim) {
  const queue = [];
  let i, len, start, end, list;
  for (i = 0, len = holeIndices.length; i < len; i++) {
    start = holeIndices[i] * dim;
    end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
    list = ecLinkedList(data, start, end, dim, false);
    if (list === list.next) list.steiner = true;
    queue.push(ecLeftmost(list));
  }
  queue.sort((a, b) => a.x - b.x);
  for (i = 0; i < queue.length; i++) outerNode = ecEliminateHole(queue[i], outerNode);
  return outerNode;
}

function ecEliminateHole(hole, outerNode) {
  const bridge = ecFindHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = ecSplitPolygon(bridge, hole);
  ecFilterPoints(bridgeReverse, bridgeReverse.next);
  return ecFilterPoints(bridge, bridge.next);
}

function ecFindHoleBridge(hole, outerNode) {
  let p = outerNode;
  const hx = hole.x, hy = hole.y;
  let qx = -Infinity, m;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) / (p.next.y - p.y) * (p.next.x - p.x);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;
      }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!m) return null;
  const stop = m, mx = m.x, my = m.y;
  let tanMin = Infinity, tan;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        ecPointInTri(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      tan = Math.abs(hy - p.y) / (hx - p.x);
      if (ecLocallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && ecSectorContains(m, p)))))) {
        m = p; tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function ecSectorContains(m, p) {
  return ecArea(m.prev, m, p.prev) < 0 && ecArea(p.next, m, m.next) < 0;
}

function ecLeftmost(start) {
  let p = start, leftmost = start;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
    p = p.next;
  } while (p !== start);
  return leftmost;
}

function ecPointInTri(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
         (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
         (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function ecValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !ecIntersectsPolygon(a, b) &&
    ((ecLocallyInside(a, b) && ecLocallyInside(b, a) && ecMiddleInside(a, b) &&
      (ecArea(a.prev, a, b.prev) || ecArea(a, b.prev, b))) ||
     (ecEquals(a, b) && ecArea(a.prev, a, a.next) > 0 && ecArea(b.prev, b, b.next) > 0));
}

function ecArea(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
function ecEquals(p1, p2) { return p1.x === p2.x && p1.y === p2.y; }

function ecIntersects(p1, q1, p2, q2) {
  const o1 = ecSign(ecArea(p1, q1, p2));
  const o2 = ecSign(ecArea(p1, q1, q2));
  const o3 = ecSign(ecArea(p2, q2, p1));
  const o4 = ecSign(ecArea(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && ecOnSegment(p1, p2, q1)) return true;
  if (o2 === 0 && ecOnSegment(p1, q2, q1)) return true;
  if (o3 === 0 && ecOnSegment(p2, p1, q2)) return true;
  if (o4 === 0 && ecOnSegment(p2, q1, q2)) return true;
  return false;
}
function ecOnSegment(p, q, r) {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}
function ecSign(n) { return n > 0 ? 1 : n < 0 ? -1 : 0; }

function ecIntersectsPolygon(a, b) {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && ecIntersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}

function ecLocallyInside(a, b) {
  return ecArea(a.prev, a, a.next) < 0 ?
    ecArea(a, b, a.next) >= 0 && ecArea(a, a.prev, b) >= 0 :
    ecArea(a, b, a.prev) < 0 || ecArea(a, a.next, b) < 0;
}

function ecMiddleInside(a, b) {
  let p = a, inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y &&
        (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}

function ecSplitPolygon(a, b) {
  const a2 = new ECNode(a.i, a.x, a.y), b2 = new ECNode(b.i, b.x, b.y),
    an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

function ecInsert(i, x, y, last) {
  const p = new ECNode(i, x, y);
  if (!last) { p.prev = p; p.next = p; }
  else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}
function ecRemove(p) { p.next.prev = p.prev; p.prev.next = p.next; }

function ecSignedArea(data, start, end, dim) {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}

export function toBinarySTL(positions, indices, name) {
  const tris = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const p1 = [positions[a], positions[a + 1], positions[a + 2]];
    const p2 = [positions[b], positions[b + 1], positions[b + 2]];
    const p3 = [positions[c], positions[c + 1], positions[c + 2]];
    const e1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const e2 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue; // drop degenerate facets
    nx /= len; ny /= len; nz /= len;
    tris.push([nx, ny, nz, p1, p2, p3]);
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const header = (name || 'pipe adapter').slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    dv.setFloat32(o, t[0], true); dv.setFloat32(o + 4, t[1], true); dv.setFloat32(o + 8, t[2], true);
    o += 12;
    for (let k = 3; k < 6; k++) {
      dv.setFloat32(o, t[k][0], true); dv.setFloat32(o + 4, t[k][1], true); dv.setFloat32(o + 8, t[k][2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}

// ── 3MF export ──────────────────────────────────────────────────────────────
// 3MF is an OPC (ZIP) package of XML. Unlike STL's triangle soup it is indexed
// and topological, so we first weld coincident vertices (the sweep leaves
// coincident-but-distinct verts at seams) into a single manifold vertex list.

const MF_CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
  '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
  '</Types>\n';

const MF_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  '  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
  '</Relationships>\n';

let mfCrcTable = null;
function mfCrc32(bytes) {
  if (!mfCrcTable) {
    mfCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      mfCrcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = mfCrcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Assemble a store-only (uncompressed) ZIP from [{name, data:Uint8Array}].
function mfZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = mfCrc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
    lh.setUint16(8, 0, true);          // store, no flags
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    const lhBytes = new Uint8Array(lh.buffer);
    chunks.push(lhBytes, nameBytes, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(10, 0, true);         // store
    cd.setUint32(16, crc, true); cd.setUint32(20, size, true); cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += lhBytes.length + nameBytes.length + size;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(eocd.buffer));
  return chunks;
}

export function to3MF(positions, indices, name) {
  // Weld coincident vertices onto a 1e-4 mm grid — far below print resolution,
  // above float noise — so shared edges become truly shared (manifold by index).
  const map = new Map();
  const verts = [];
  const remap = new Int32Array(positions.length / 3);
  const q = (v) => Math.round(v * 1e4) / 1e4;
  for (let i = 0; i < remap.length; i++) {
    const x = q(positions[i * 3]), y = q(positions[i * 3 + 1]), z = q(positions[i * 3 + 2]);
    const key = x + ',' + y + ',' + z;
    let idx = map.get(key);
    if (idx === undefined) { idx = verts.length / 3; map.set(key, idx); verts.push(x, y, z); }
    remap[i] = idx;
  }

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    ' <resources>\n  <object id="1" type="model" name="', (name || 'pipe adapter'), '">\n   <mesh>\n    <vertices>\n',
  ];
  for (let i = 0; i < verts.length; i += 3) {
    parts.push('     <vertex x="' + verts[i] + '" y="' + verts[i + 1] + '" z="' + verts[i + 2] + '"/>\n');
  }
  parts.push('    </vertices>\n    <triangles>\n');
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) continue; // drop degenerate
    parts.push('     <triangle v1="' + a + '" v2="' + b + '" v3="' + c + '"/>\n');
  }
  parts.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1"/>\n </build>\n</model>\n');

  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', data: enc.encode(MF_CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(MF_RELS) },
    { name: '3D/3dmodel.model', data: enc.encode(parts.join('')) },
  ];
  return new Blob(mfZip(files), { type: 'model/3mf' });
}
