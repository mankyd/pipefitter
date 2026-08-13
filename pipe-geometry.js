// Parametric N-section pipe adapter: a planar chain of straight sections joined
// by bends (Section 1 · Bend 1 · Section 2 · ... · Section N), swept along a
// centerline with per-station inner/outer radii, end features, binary STL export.
//
// Parameter model (single source of truth):
//   { sections: [ {id, w, l, endA?, endB?}, ... ],   // N straight sections, N >= 1
//     bends:    [ {ang, l2, idm, w2, idmSmooth, w2Smooth}, ... ] }   // N-1 bends
// The pipe has exactly two open ends, and they live on the sections that own
// them: the FIRST section carries `endA` (the left/start treatment) and the LAST
// carries `endB` (the right/finish treatment). A lone section is both first and
// last, so it carries both and the two treatments split its length between them
// (see endAvail). Interior sections are pure constant-profile straight runs.
// Each bend owns the diameter/wall transition between its two neighboring
// sections. All bends lie in one plane; a bend's `ang` is SIGNED ([-180,180]) -
// its sign is the turn direction.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, dp) => { const f = 10 ** dp; return Math.round(v * f) / f; };
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// ── Parameter limits ─────────────────────────────────────────────────────────
export const SECTION_LIMITS = { id: [1, 120], w: [0.4, 20], l: [3, 200] };
export const BEND_LIMITS = {
  ang: [-180, 180], l2: [0, 200], idm: [1, 120], w2: [0.4, 20],
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
// FitL is the joint's ENGAGEMENT: how far the two pipes overlap once seated -
// a spigot's protruding stub, or the depth of a socket's cup. It is the length
// the joint adds to its section, and the one number that describes the fit, so
// it is what the control carries and what the drawing shows.
//
// Behind it sits the shoulder ("stop"): a solid floor as thick as the section
// wall, so the step reads as a proper flange-like face rather than a knife
// edge, with the tolerance gap bridged over it. That floor is *inside* the
// section - the measured section length runs from the interior stop wall to the
// far end - so it costs the engagement nothing. It is capped at the engagement
// itself, so a hair-thin joint stays a hair thin rather than jumping to a full
// wall of material, and at `secLen` — the straight run the end is given (see
// endAvail) — so it never outgrows the section it sits in.
const fitFloor = (wall, engage, secLen) => Math.min(wall, engage, secLen);

// The two end slots, in path order: `endA` at the near (s=0) end of the first
// section, `endB` at the far (s=T) end of the last one.
export const END_SLOTS = ['endA', 'endB'];
const endsOf = (sec) => END_SLOTS.map((k) => sec && sec[k]).filter(Boolean);
// How much straight length each end treatment may spend. A section with one end
// gets the whole run; a lone section carries both treatments, so they split it
// down the middle and neither can reach across into the other's half.
const endAvail = (sec) => sec.l / Math.max(1, endsOf(sec).length);

// The axial length one slip joint adds to its section: exactly its engagement.
const fitLenOf = (sec, end) => {
  if (!end || end.type !== 'fit') return 0;
  return Math.max(0, end.FitL);
};
// Everything a section's end treatments add to its straight span (both ends,
// when it has two).
const fitLen = (sec) => endsOf(sec).reduce((t, e) => t + fitLenOf(sec, e), 0);

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
export function defaultPipe() {
  return {
    sections: [
      { id: 12, w: 2, l: 26, endA: defaultEnd() },
      { id: 20, w: 2.5, l: 26, endB: defaultEnd() },
    ],
    bends: [defaultBend()],
  };
}
export function defaultParams() {
  return { pipes: [defaultPipe()] };
}
export const DEFAULTS = defaultParams();

// Structured deep clone of one pipe (sections/bends/ends).
export function clonePipe(p) {
  return {
    sections: (p.sections || []).map((s) => {
      const c = { ...s };
      for (const k of END_SLOTS) if (s[k]) c[k] = { ...s[k] }; else delete c[k];
      return c;
    }),
    bends: (p.bends || []).map((b) => ({ ...b })),
  };
}
// Structured deep clone of a chain. A bare { sections, bends } is accepted and
// promoted to a one-pipe chain, so older callers and saved links still work.
export function cloneParams(p) {
  return { pipes: asChain(p).map(clonePipe) };
}
// Coerce anything into an array of pipe objects.
function asChain(raw) {
  if (raw && Array.isArray(raw.pipes)) return raw.pipes;
  return [raw || {}];
}

const cnum = (v, lim, whole, dflt) => {
  v = Number(v);
  if (!isFinite(v)) v = dflt;
  const c = clamp(v, lim[0], lim[1]);
  return whole ? Math.round(c) : round(c, 2);
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
// the shape invariant (N >= 1 sections, exactly N-1 bends, endA on the first
// section and endB on the last - both on the same section when there is only
// one). Returns { p, notes } - notes describe what had to be pulled back.
export function normalize(raw) {
  const notes = [];
  const rawSecs = Array.isArray(raw && raw.sections) ? raw.sections : [];
  const rawBends = Array.isArray(raw && raw.bends) ? raw.bends : [];
  const n = Math.max(1, rawSecs.length);

  const sections = [];
  for (let i = 0; i < n; i++) {
    const rs = rawSecs[i] || {};
    sections.push({
      id: cnum(rs.id, SECTION_LIMITS.id, false, 12),
      w: cnum(rs.w, SECTION_LIMITS.w, false, 2),
      l: cnum(rs.l, SECTION_LIMITS.l, false, 26),
    });
  }
  // Ends live only on the geometric extremes; with one section that is the same
  // section twice, and it ends up carrying both treatments.
  sections[0].endA = normEnd((rawSecs[0] || {}).endA);
  sections[n - 1].endB = normEnd((rawSecs[n - 1] || {}).endB);
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

  // A fixed middle Ø or a defined thickness needs axial room to exist: the
  // bulge (or pinch) it asks for beyond the pass-through blend of its two
  // neighbours can't exceed the bend's effective length — the arc for an angled
  // bend, l2 for a straight one. At zero length they collapse to the blend
  // (mid values between the neighbours remain legal; they're what the
  // transition passes through anyway).
  for (let i = 0; i < bends.length; i++) {
    const bd = bends[i], a = sections[i], b = sections[i + 1];
    if (bd.idmSmooth && bd.w2Smooth) continue;
    const A = Math.abs(bd.ang * Math.PI / 180);
    const eff = A > 1e-6
      ? solveBendRadius(transitionOf(a, b, bd), A, bd.l2).R * A
      : bd.l2;
    if (!bd.idmSmooth) {
      const lo = Math.min(a.id, b.id) - eff, hi = Math.max(a.id, b.id) + eff;
      if (bd.idm < lo - 1e-9 || bd.idm > hi + 1e-9) {
        bd.idm = round(clamp(bd.idm, lo, hi), 2);
        notes.push('Bend ' + (i + 1) + ' middle Ø limited to ' + bd.idm + ' mm — a bulge or pinch needs bend length');
      }
    }
    if (!bd.w2Smooth) {
      const lo = Math.max(BEND_LIMITS.w2[0], Math.min(a.w, b.w) - eff);
      const hi = Math.max(a.w, b.w) + eff;
      if (bd.w2 < lo - 1e-9 || bd.w2 > hi + 1e-9) {
        bd.w2 = round(clamp(bd.w2, lo, hi), 2);
        notes.push('Bend ' + (i + 1) + ' thickness limited to ' + bd.w2 + ' mm — a thicker middle needs bend length');
      }
    }
    // The IMPLIED outer surface obeys the same rule: even an in-range middle Ø
    // can push inner+wall into a bulge (or dip) beyond both ends — e.g. a
    // middle Ø equal to the larger bore opens the bore early while the blended
    // wall is still thick. Pull the fixed value toward its pass-through anchor
    // until the outer profile fits the room the length affords.
    {
      const oA2 = a.id / 2 + a.w, oB2 = b.id / 2 + b.w;
      const oLo = Math.min(oA2, oB2) - eff / 2, oHi = Math.max(oA2, oB2) + eff / 2;
      const excess = () => {
        const t2 = transitionOf(a, b, bd);
        let ex = 0;
        for (let k = 0; k <= 40; k++) {
          const q = transitionAt(t2, k / 40);
          ex = Math.max(ex, q.inner + q.wall - oHi, oLo - (q.inner + q.wall));
        }
        return ex;
      };
      const fitOuter = (key, safe, label) => {
        if (excess() <= 1e-6) return;
        const orig = bd[key];
        let lo2 = 0, hi2 = 1;                    // 0 → safe anchor, 1 → requested value
        for (let k = 0; k < 24; k++) {
          const m = (lo2 + hi2) / 2;
          bd[key] = safe + (orig - safe) * m;
          if (excess() > 1e-6) hi2 = m; else lo2 = m;
        }
        bd[key] = round(safe + (orig - safe) * lo2, 2);
        if (Math.abs(bd[key] - orig) > 0.005) {
          notes.push('Bend ' + (i + 1) + label + bd[key] + ' mm — the outer wall needs bend length to bulge');
        }
      };
      if (!bd.idmSmooth) fitOuter('idm', (a.id + b.id) / 2, ' middle Ø limited to ');
      if (!bd.w2Smooth) fitOuter('w2', Math.min(a.w, b.w), ' thickness limited to ');
    }
  }

  fitEnd(sections[0], 'endA', 0, notes);
  fitEnd(sections[n - 1], 'endB', n - 1, notes);
  return { p: { sections, bends }, notes };
}

// How a note names one end: its 1-based section number, and which side of that
// section when it carries a treatment at each end and the two need telling apart.
const endLabel = (sec, slot, index) => 'Section ' + (index + 1) +
  (endsOf(sec).length > 1 ? (slot === 'endA' ? ' left end' : ' right end') : '');

// An end feature must fit inside the straight length its section affords it —
// the whole section, or half of it when that section carries both treatments.
// Mutates sec[slot] and appends any pull-back notes (labeled by endLabel).
function fitEnd(sec, slot, index, notes) {
  const e = sec[slot];
  if (!e) return;
  const label = endLabel(sec, slot, index);
  const secLen = endAvail(sec), wall = sec.w;
  if (e.type === 'chamfer') {
    const maxX = secLen;   // an along-axis chamfer can span the whole run it's given
    for (const k of ['ChX', 'ChIX']) {
      if (e[k] > maxX) { e[k] = round(maxX, 2); notes.push(label + ' chamfer depth limited to ' + e[k] + ' mm by section length'); }
    }
    // The outer and bore radial chamfers share the wall: together at most the
    // full wall thickness, so either can consume it all when the other is 0.
    if (e.ChIY > wall) { e.ChIY = round(wall, 2); notes.push(label + ' bore chamfer reduced to ' + e.ChIY + ' mm by wall thickness'); }
    const outMax = wall - e.ChIY;
    if (e.ChY > outMax) { e.ChY = round(outMax, 2); notes.push(label + ' outer chamfer reduced to ' + e.ChY + ' mm — wall shared with the bore chamfer'); }
  } else if (e.type === 'flange') {
    const maxT = secLen * 0.45;
    if (e.Ft > maxT) { e.Ft = round(maxT, 2); notes.push(label + ' flange thinned to ' + e.Ft + ' mm to fit the section'); }
    // Bolt holes sit on a circle through the middle of the flange lip; keep
    // them inside the lip and clear of one another.
    const nn = e.Fn;
    if (nn >= 1 && e.Fh > 0) {
      const fw = e.Fw;
      const O = (sec.id + 2 * wall) / 2;
      const rc = O + fw / 2;
      let maxDia = fw * 0.8;                                   // fit across the lip width
      if (nn >= 2) maxDia = Math.min(maxDia, 2 * rc * Math.sin(Math.PI / nn) * 0.8); // don't overlap neighbors
      if (e.Fh > maxDia) { e.Fh = round(maxDia, 2); notes.push(label + ' flange holes reduced to ø' + e.Fh + ' mm to fit'); }
    }
  } else if (e.type === 'barb') {
    const maxSpan = secLen * 0.85;
    if (e.Bn * e.Bp > maxSpan) {
      const n = Math.max(1, Math.floor(maxSpan / e.Bp));
      if (n < e.Bn) { e.Bn = n; notes.push(label + ' barbs reduced to ' + e.Bn + ' — no room for more'); }
      // Even a single barb can outrun a short section; the pitch must give too,
      // or the feature would spill past the junction into the bend.
      if (e.Bn * e.Bp > maxSpan) {
        e.Bp = round(maxSpan / e.Bn, 2);
        notes.push(label + ' barb pitch shortened to ' + e.Bp + ' mm to fit the section');
      }
    }
  } else if (e.type === 'teeth') {
    // Teeth share the circle: their angular widths can't sum past 360°.
    const maxW = 360 / e.Tn;
    if (e.Tw > maxW) { e.Tw = round(maxW, 2); notes.push(label + ' teeth narrowed to ' + e.Tw + '° — no room for more'); }
    // The fillet rounds the top edge at its full value (up to ~2.5× the height)
    // and the sides at a quarter, so the cap allows for both.
    const O = (sec.id + 2 * wall) / 2;
    const halfArc = (e.Tw * Math.PI / 180 / 2) * O;
    const maxF = Math.min(2.5 * e.Th, 4 * halfArc);
    if (e.Tf > maxF) { e.Tf = round(maxF, 2); notes.push(label + ' tooth fillet reduced to ' + e.Tf + ' mm'); }
  } else if (e.type === 'fit') {
    // The joint extends past the section rather than carving into it, so its
    // engagement is independent of the section length (bounded only by FitL's
    // limit, and by the mating section's run at a joint - see capEngagement).
    // The stop's floor does sit inside the section, but fitFloor already keeps
    // it within the run this end is given, so nothing here has to give.
    //
    // A spigot's tolerance can't exceed the bore (it would invert the wall).
    if (e.FitSide === 'inside') {
      const maxTol = Math.max(0, sec.id - 2 * wall - 0.5);
      if (e.FitTol > maxTol) { e.FitTol = round(maxTol, 2); notes.push(label + ' slip joint tolerance limited to ' + e.FitTol + ' mm by wall'); }
    }
    // The lead-in chamfer can't exceed the wall (radial) or the stub (axial).
    if (e.FitChY > wall) { e.FitChY = round(wall, 2); notes.push(label + ' slip joint chamfer reduced to ' + e.FitChY + ' mm by wall thickness'); }
    if (e.FitChX > e.FitL) { e.FitChX = round(e.FitL, 2); notes.push(label + ' slip joint chamfer depth limited to ' + e.FitChX + ' mm by joint length'); }
  }
}

// ── Pipe chain: joints between separately-printed pipes ──────────────────────
// A design is a CHAIN of pipes joined end to end: { pipes: [ {sections,bends} ] }.
// Joint j sits between pipe j's LAST section and pipe j+1's FIRST section. The
// two pipes are separate parts - each is printed and exported on its own - but
// the mating end is a shared interface, so the two sides are kept consistent:
//
//   • the mating sections always share inner Ø and wall (hence outer Ø);
//   • the two end treatments always form a legal mating pair (see MATE_OF);
//   • a flange joint shares width, hole count, and hole size - but NOT
//     thickness, which is each part's own business.
//
// Everything else is independent: chamfer geometry, flange thickness, and a
// slip joint's tolerance all live on one side only. That is what makes the
// tolerance meaningful - it opens a gap against a mate whose Ø does not move.
export const MAX_PIPES = 4;

// The end treatments that can carry a joint, and what the far side becomes.
// Only a slip joint is asymmetric: its stub needs a plain-bored mate to slide
// into (or over), so the other side is chamfered - a lead-in the user can then
// shape, or leave at zero for a square end.
export const MATE_TYPES = ['plain', 'chamfer', 'flange', 'fit'];
const MATE_OF = { plain: 'plain', chamfer: 'chamfer', flange: 'flange', fit: 'chamfer' };
// End params a joint holds identical on both sides (beyond the section's id/w).
const MATE_END_KEYS = { flange: ['Fw', 'Fn', 'Fh'] };

// True when a pair of end types can face each other across a joint. `chamfer`
// opposite `fit` is the slip joint seen from the plain side, so it is legal in
// both orders - which is what lets either pipe be the one carrying the stub.
export function mateableEnds(a, b) {
  return MATE_OF[a] === b || (a === 'chamfer' && b === 'fit');
}

// The mating end of a pipe on the given side of a joint, as the section that
// owns it and the slot it sits in ('l' = the pipe to the left of the joint, so
// its last section's `endB`; 'r' = the pipe to the right, so its first
// section's `endA`). A single-section pipe answers both from the one section,
// which is exactly why it can sit between two joints.
const mateSide = (pipe, side) => (side === 'l'
  ? { sec: pipe.sections[pipe.sections.length - 1], slot: 'endB', i: pipe.sections.length - 1 }
  : { sec: pipe.sections[0], slot: 'endA', i: 0 });
const endAt = (m) => m.sec[m.slot];

// The axial distance the two pipes overlap at a joint: a slip joint's stub
// slides in until the mate lands on its shoulder, so the mate is pulled back by
// the length the stub protrudes. Flanges and butt joints meet face to face.
function jointStub(pipeL, pipeR) {
  const a = mateSide(pipeL, 'l'), b = mateSide(pipeR, 'r');
  for (const m of [a, b]) {
    const e = endAt(m);
    if (e && e.type === 'fit') return fitLenOf(m.sec, e);
  }
  return 0;
}

// What a treatment that can't carry a joint is called in the note that says so.
const NON_MATING_NAMES = { barb: 'hose barb', teeth: 'teeth' };

// Force one joint's two sides into agreement, copying from `src` to `dst`
// (each a { sec, slot, i } from mateSide). `onDrop(side, type)` is called for
// an end that had to give up a treatment it can't wear at a joint - that one is
// worth telling about, since no other joint rule takes a feature away outright.
// Retyping between mating treatments stays silent: the far side following the
// near one is the whole point of a joint.
function syncJoint(src, dst, onDrop) {
  dst.sec.id = src.sec.id;
  dst.sec.w = src.sec.w;
  const se = endAt(src), de = endAt(dst);
  if (!se || !de) return;
  // Only a treatment with an opposite number can carry a joint, so a hose barb
  // or a set of teeth - grown while this end was still free, then joined onto -
  // gives way to a plain face. Nothing on the far side could have met it, and
  // the menu stops offering either one once the end is mated.
  if (!MATE_TYPES.includes(se.type)) { onDrop(src, se.type); se.type = 'plain'; }
  // The far side follows the near side's type, unless the pair is already legal
  // (a chamfer facing a slip joint - the stub simply lives on the other pipe).
  // It can be wearing an unmateable treatment too - the flow simply reached this
  // joint from the other direction - and losing that is just as worth saying.
  if (!mateableEnds(se.type, de.type)) {
    if (!MATE_TYPES.includes(de.type)) onDrop(dst, de.type);
    de.type = MATE_OF[se.type] || 'plain';
  }
  for (const k of (MATE_END_KEYS[se.type] || [])) {
    if (de.type === se.type) de[k] = se[k];
  }
}

// Either way round, a slip joint's engagement is a length of the MATE that ends
// up inside the joint - swallowed by a socket's cup, or run past by a spigot
// sliding up the mate's bore - so it can reach no further than the straight run
// waiting over there. Past that the mate turns into its bend, where the joint
// would foul rather than seat. Since FitL is the engagement, the bound is
// simply the run the mating end owns: the whole mating section, or half of it
// when that lone section carries a treatment on each side. A socket is no less
// bounded than a spigot - it swallows the mate rather than entering it, but the
// mate has only so much to give. With no pipe joined on there is nothing to
// mate with, and the joint length stays free.
//
// The pull-back is stored rather than noted, like every other clamp that keeps
// a value legal: the joint-length control's bound moves with the mating
// section, so the limit shows up where it is edited.
function capEngagement(pipes, j) {
  const cap = (m, mate) => {
    const e = endAt(m);
    if (!e || e.type !== 'fit') return;
    const room = endAvail(mate.sec);
    if (e.FitL > room) e.FitL = round(room, 2);
  };
  const a = mateSide(pipes[j], 'l'), b = mateSide(pipes[j + 1], 'r');
  cap(a, b);
  cap(b, a);
}

// Propagate every joint's locked values across the chain. `driver`, when given,
// names the section the user just edited ({ pi, si }) so that joint copies OUT
// of the edited side; every other joint flows left to right.
//
// A single-section pipe meets both of its joints with the same section, so a
// joint fed backwards into one can knock the joint beyond it out of agreement.
// The sweeps below therefore run outward from the driven joint - back through
// any lone sections it passes through, forward everywhere else - so no joint
// ever undoes one already settled, and a single pass still does it.
function syncJoints(pipes, driver, dropped) {
  const doJoint = (j, fromRight) => {
    const a = mateSide(pipes[j], 'l'), b = mateSide(pipes[j + 1], 'r');
    a.pi = j; b.pi = j + 1;   // each side knows its own pipe, so a note can name it
    const drop = (m, type) => dropped.push(pipeNote(m.pi, pipes.length,
      endLabel(m.sec, m.slot, m.i) + ' ' + (NON_MATING_NAMES[type] || type) + ' removed'));
    if (fromRight) syncJoint(b, a, drop); else syncJoint(a, b, drop);
    capEngagement(pipes, j);
  };
  // Editing a pipe's first section drives the joint on its left from the right.
  const rev = driver && driver.si === 0 && driver.pi > 0 ? driver.pi - 1 : -1;
  let stop = rev;   // how far back that backwards flow carries
  while (stop > 0 && pipes[stop].sections.length === 1) stop--;
  for (let j = 0; j < stop; j++) doJoint(j, false);
  for (let j = rev; j >= stop && j >= 0; j--) doJoint(j, true);
  for (let j = rev + 1; j < pipes.length - 1; j++) doJoint(j, false);
}

// Prefix a per-pipe note with the pipe it belongs to, but only once the design
// has more than one pipe (a single pipe needs no disambiguation).
const pipeNote = (j, n, note) => (n > 1 ? 'Pipe ' + (j + 1) + ' · ' + note : note);

// Clamp a whole chain: normalize each pipe, settle the joints, then normalize
// again so a value pushed across a joint lands inside its own pipe's limits.
// The second pass is stable - every synced quantity is clamped from synced
// inputs alone, so both sides of a joint arrive at the same answer.
//
// `notes` and `dropped` are kept apart because they are different kinds of
// thing. A note is a standing complaint: the value is still being held back,
// and re-normalizing says it again. A `dropped` entry reports a treatment taken
// away for good - said once, by the pass that did it, and never again. Only the
// second kind is worth letting the reader dismiss.
export function normalizeChain(raw, driver) {
  const pipes = asChain(raw).slice(0, MAX_PIPES).map((pp) => normalize(pp).p);
  const notes = [], dropped = [];
  syncJoints(pipes, driver, dropped);
  const out = pipes.map((pp, j) => {
    const r = normalize(pp);
    for (const n of r.notes) notes.push(pipeNote(j, pipes.length, n));
    return r.p;
  });
  return { p: { pipes: out }, notes, dropped };
}

// The diameter/wall transition a bend owns, resolved between its two neighbors.
function transitionOf(a, b, bend) {
  return {
    idA: a.id / 2, idB: b.id / 2, idm: bend.idm / 2,
    wA: a.w, wB: b.w, w2: bend.w2,
    idmSmooth: bend.idmSmooth, w2Smooth: bend.w2Smooth,
  };
}

// Two-phase blend through a fixed middle value at t=0.5. Zero end slopes keep
// the junctions tangent to the straight sections. The middle slope is the
// harmonic mean of the two half-secants when the three values run in one
// direction — a single monotone sweep through the middle value, no flat shelf
// or momentary direction change — and drops to zero only when the middle is a
// true extremum (a deliberate bulge or pinch), where the flat is the extremum.
function blend3(vA, vM, vB, t) {
  const s1 = vM - vA, s2 = vB - vM;                          // rise of each half
  const m = s1 * s2 > 0 ? (2 * s1 * s2) / (s1 + s2) : 0;     // mid slope (per half)
  if (t < 0.5) {
    const u = t * 2, u2 = u * u, u3 = u2 * u;
    return vA + s1 * (3 * u2 - 2 * u3) + m * (u3 - u2);
  }
  const u = t * 2 - 1, u2 = u * u, u3 = u2 * u;
  return vM + s2 * (3 * u2 - 2 * u3) + m * (u3 - 2 * u2 + u);
}

// Inner radius + wall of a transition at blend parameter t (0..1).
function transitionAt(tr, t) {
  const inner = tr.idmSmooth
    ? lerp(tr.idA, tr.idB, smooth(t))
    : blend3(tr.idA, tr.idm, tr.idB, t);
  const wall = tr.w2Smooth
    ? lerp(tr.wA, tr.wB, smooth(t))
    : blend3(tr.wA, tr.w2, tr.wB, t);
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
// Returns `at(s) → {P, T}` plus per-segment and per-bend metadata. `endClear`
// gives the axial depth of the two end-feature zones (outer or bore, whichever
// reaches further), which the envelope leads must stay clear of.
function makePath(p, endClear) {
  const sections = p.sections, bends = p.bends;
  const N = sections.length;
  const segments = [];
  const perBend = [];
  const sectionSpans = [];
  let P = [0, 0, 0], theta = 0, s = 0;

  for (let i = 0; i < N; i++) {
    // A fit end extends its section rather than eating into it, so the straight
    // segment carries the section body plus any slip-joint stub protruding past
    // the end face (the stub is meshed into the far end of this span).
    const L = sections[i].l + fitLen(sections[i]);
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
      // Envelope leads into the neighbouring sections (see envelopeChains):
      // half a section at most, clear of the end-feature zones. The downstream
      // room counts the remaining straight lengths only — later bend arcs are
      // not solved yet — which is exact for the last bend, the only bend the
      // far end-zone clamp can realistically reach.
      const wMaxTr = transitionMaxWall(tr);
      let downstream = 0;
      for (let j = i + 1; j < N; j++) downstream += sections[j].l;
      const leadA = Math.max(0, Math.min(0.75 * wMaxTr, sections[i].l / 2, s - (endClear.a + 0.05)));
      const leadB = Math.max(0, Math.min(0.75 * wMaxTr, sections[i + 1].l / 2, downstream - (endClear.b + 0.05)));
      // B is the arc length along the OUTER surface on the inner side of the
      // bend; solve the centerline radius that produces exactly that length on
      // the face as drawn (the disc-envelope surface for a varying transition).
      const sol = bent ? solveBendFace(tr, Math.abs(A), bd.l2, leadA, leadB) : { R: 0, clamped: false, minFace: 0 };
      const R = sol.R;
      // No length floor for a straight (0°) transition: the wall is built as a
      // disc envelope (envelopeChains), which keeps its thickness at any
      // transition length — even zero, where it collapses to a rounded square
      // shoulder at the junction.
      const arcLen = bent ? R * Math.abs(A) : bd.l2;
      const faceClamped = sol.clamped;
      const minFace = sol.minFace;
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
      perBend.push({ bi: i, R, arcLen, A, bend: bent, center, faceClamped, minFace, sStart, sEnd, leadA, leadB });
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
// given centerline radius R. The surface sits at ρ(φ) = R - outer(t); because
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

// Smallest R (for a bend of half-angle-span A radians) that keeps the concave
// face clear of the centerline. The hard limit is R > maxOuter: at R = maxOuter
// the concave surface passes through the pivot and the sweep degenerates (below
// it, the solid self-intersects). The margin above that is only what the mesh
// needs to resolve the face: the construction (envelopeChains) reads the wall
// off the union of pen circles directly, so a profile that turns tighter than
// its own thickness renders as a filled crease rather than a fold — no extra
// clearance is required for ANY profile, constant or varying. (A straight run
// has no bend, so this is unused.)
// The shortest concave face the mesh can still resolve: the face is sampled at
// the bend's own station count, so what has to stay above float noise is its
// LENGTH, not the corner radius — squeeze either the radius or the angle far
// enough and neighbouring stations land on the same point, collapsing triangles
// on the concave side. Two microns is ~50× the shortest face that still meshed
// cleanly in testing, and is orders of magnitude below any printable feature.
const MIN_FACE_ARC = 0.002;       // mm
function minBendRadius(tr, A) {
  const a = Math.max(Math.abs(A), 1e-6);
  let mx = 0;
  for (let i = 0; i <= 40; i++) mx = Math.max(mx, outerAtT(tr, i / 40));
  return mx + MIN_FACE_ARC / a;
}

// The thinnest wall the transition carries, and its total outer-radius change.
// The inner-bend perpendicular thickness can approach the former but never the
// latter matters for how much arc the reduction needs.
function transitionMinWall(tr) {
  let mn = Infinity;
  for (let i = 0; i <= 40; i++) mn = Math.min(mn, transitionAt(tr, i / 40).wall);
  return mn;
}

// Solve R so the inner face arc equals the requested length. Monotonic in R.
function solveBendRadius(tr, A, target) {
  let lo = minBendRadius(tr, A);
  if (innerFaceLength(tr, A, lo) >= target) return { R: lo, clamped: true };
  let hi = lo + Math.max(target, 1) / Math.max(A, 1e-3) + 100;
  while (innerFaceLength(tr, A, hi) < target && hi < 1e6) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (innerFaceLength(tr, A, mid) < target) lo = mid; else hi = mid;
  }
  return { R: (lo + hi) / 2, clamped: false };
}

// Length of the concave face as actually drawn. A varying transition's wall is
// meshed as a disc envelope (envelopeChains), whose outer surface runs longer
// than the analytic radial profile innerFaceLength integrates — the envelope
// wraps the wall circles at a tilt and bulges past the blend. Build the same
// chains over a local model of the bend (an arc between two straight leads;
// face length is invariant to the rigid placement) and measure the concave
// chain between the two junction planes, interpolating the exact junction
// points — the same measurement the schematic labels. A constant-profile bend
// is meshed from the radial profile itself, where the integral is exact.
// The concave (inner-bend) edge of that envelope, as a polyline between the two
// junction planes. Both the length measurement and the fold test read this same
// curve, so what gets measured is what gets meshed. Returns null when the
// envelope came back too short to clip.
// The envelope chains over a local model of the bend: an arc of radius R
// between two straight leads, in a scratch frame. Face lengths and fold tests
// are invariant to the rigid placement, so this is the same curve the mesher
// builds in assembly space.
function envArcChains(tr, A, R, leadA, leadB) {
  const arc = R * A;
  const at = (s) => {
    if (s <= 0) return { P: [s, 0, 0], T: [1, 0, 0] };
    const phi = Math.min(s, arc) / R, c = Math.cos(phi), sn = Math.sin(phi);
    const P = [R * sn, R * (1 - c), 0];
    if (s >= arc) { const d = s - arc; P[0] += d * c; P[1] += d * sn; }
    return { P, T: [c, sn, 0] };
  };
  return envelopeChains({ tr, sStart: 0, sEnd: arc }, { at }, leadA, leadB);
}

function envConcaveFace(tr, A, R, leadA, leadB) {
  const arc = R * A;
  const st = envArcChains(tr, A, R, leadA, leadB).outer;
  if (st.length < 2) return null;
  // Concave side: whichever envelope edge runs nearer the bend pivot (0, R).
  const pt = (q, sgn) => [q.C[0] + sgn * q.r * q.v[0], q.C[1] + sgn * q.r * q.v[1]];
  const d2 = (q, sgn) => { const p = pt(q, sgn); return p[0] * p[0] + (p[1] - R) * (p[1] - R); };
  const mid = st[Math.floor(st.length / 2)];
  const sgn = d2(mid, 1) <= d2(mid, -1) ? 1 : -1;
  const lerpPt = (a, b, f) => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
  let first = -1, last = -1;
  for (let i = 0; i < st.length; i++) {
    if (st[i].s >= -1e-6 && st[i].s <= arc + 1e-6) { if (first < 0) first = i; last = i; }
  }
  if (first < 0 || last <= first) return null;
  const pts = [];
  if (first > 0 && st[first].s > 1e-9 && st[first - 1].s < -1e-9)
    pts.push(lerpPt(pt(st[first - 1], sgn), pt(st[first], sgn), -st[first - 1].s / (st[first].s - st[first - 1].s)));
  for (let i = first; i <= last; i++) pts.push(pt(st[i], sgn));
  if (last < st.length - 1 && st[last].s < arc - 1e-9 && st[last + 1].s > arc + 1e-9)
    pts.push(lerpPt(pt(st[last], sgn), pt(st[last + 1], sgn), (arc - st[last].s) / (st[last + 1].s - st[last].s)));
  return pts;
}

function envFaceLength(tr, A, R, leadA, leadB) {
  if (!transitionVaries(tr)) return innerFaceLength(tr, A, R);
  const pts = envConcaveFace(tr, A, R, leadA, leadB);
  if (!pts || pts.length < 2) return innerFaceLength(tr, A, R);
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// Solve R so the DRAWN concave-face length equals the requested B. The analytic
// solve is the fast inner model; its target is corrected until the
// envelope-measured face converges (the two differ by a slowly-varying offset,
// so 2-3 rounds settle it). The measured length grows with R, so a plain
// bisection backstops any profile the correction loop can't pin down. Also
// reports the face floor — the drawn length at the tightest radius, which is
// exactly what the schematic shows when the request is clamped up to it.
function solveBendFace(tr, A, target, leadA, leadB) {
  const lo = minBendRadius(tr, A);
  const minFace = envFaceLength(tr, A, lo, leadA, leadB);
  if (minFace >= target) return { R: lo, clamped: true, minFace };
  let t = target, R = lo;
  for (let k = 0; k < 6; k++) {
    R = Math.max(lo, solveBendRadius(tr, A, t).R);
    const face = envFaceLength(tr, A, R, leadA, leadB);
    if (Math.abs(face - target) < 0.01) return { R, clamped: false, minFace };
    t -= face - target;
  }
  let rLo = lo, rHi = Math.max(R, lo + 1);
  while (envFaceLength(tr, A, rHi, leadA, leadB) < target && rHi < 1e6) rHi *= 2;
  for (let k = 0; k < 40; k++) {
    const mid = (rLo + rHi) / 2;
    if (envFaceLength(tr, A, mid, leadA, leadB) < target) rLo = mid; else rHi = mid;
  }
  return { R: (rLo + rHi) / 2, clamped: false, minFace };
}

// The maximum wall thickness a transition carries.
function transitionMaxWall(tr) {
  let mx = 0;
  for (let i = 0; i <= 40; i++) mx = Math.max(mx, transitionAt(tr, i / 40).wall);
  return mx;
}

// ── Pen-stroke wall construction ─────────────────────────────────────────────
// A transition's wall is built the way a draftsman would ink it: run a guide
// curve along the wall's CENTERLINE (top of the pipe and bottom of the pipe
// separately, in the bend plane) and stroke it with a pen whose width is the
// wall thickness called for at each point. The stroke — the union of the pen's
// circles — IS the wall: at each cross-section station the mesh reads the
// stroke off directly, casting the station's own ray and taking how far the
// nearby circles reach along it (see reach). The outer surface is the far
// edge of that run of ink, the bore the near edge, so the wall is a full
// pen-width thick everywhere by construction — at any transition length,
// around any bend, and through any fold: a profile that turns tighter than
// the pen renders as a filled crease, thicker than specified, never thinner.
// Everything is evaluated from the smooth analytic profile (transitionAt) and
// the analytic path, so the surfaces inherit the blends' own C¹ continuity;
// there are no smoothing passes. (A predecessor wrapped tangent lines around
// box-average-smoothed sample positions instead; averaging positions on an
// arc of radius ρ over a window h pulls them inward by ~h²/6ρ, and the window
// width varied along the chain, so the sag modulated into visible surface
// ripple on every bent varying transition.)
// The two sides' rays are paired into cross-section rings (center = midpoint,
// radius = half the gap) and revolved; ring centers may drift slightly off
// the nominal centerline through a transition, which is exactly what keeps
// the in-plane walls true.
const ENV_STEP_WALLS = 0.25;      // sample spacing, × the local min wall
const ENV_MAX_SAMPLES = 600;      // samples per transition
const ENV_STATION_STEP = 0.3;     // target sample spacing along the stroke, mm
const ENV_SHOULDER = 0.75;        // axial spread of a hard shoulder, × max wall
const ENV_LEAD_USE = 0.6;         // fraction of a lead a shoulder may borrow

// Does the transition change shape at all? A constant bore + constant wall
// needs no envelope — the plain radial profile is already exact.
function transitionVaries(tr) {
  let iMin = Infinity, iMax = -Infinity, wLo = Infinity, wHi = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const { inner, wall } = transitionAt(tr, i / 40);
    iMin = Math.min(iMin, inner); iMax = Math.max(iMax, inner);
    wLo = Math.min(wLo, wall); wHi = Math.max(wHi, wall);
  }
  return (iMax - iMin) > 1e-6 || (wHi - wLo) > 1e-6;
}

// Build one transition segment's wall as ring stations read off the pen
// stroke. Returns { outer, inner } station lists; a station is
// { s, r, C:[x,y], v:[x,y] } — a cross-section ring centered at C (bend plane),
// radius r, meeting the two surface edges at C ± r·v. leadA/leadB extend the
// stroke a short way into the neighbouring straight sections (where it IS the
// neighbour's cylinder), so the stations always start and end flush with the
// sections even when a shoulder's ramp reaches past the junction.
function envelopeChains(seg, path, leadA, leadB) {
  const tr = seg.tr, len = seg.sEnd - seg.sStart;
  const span = leadA + len + leadB;
  const sBase = seg.sStart - leadA;

  // The blend window [w0,w1] in span distance d: where t sweeps 0→1 —
  // normally the transition's own span, but never shorter than ENV_SHOULDER
  // of the largest wall. A too-short blend is spread past the junctions,
  // centered on the segment and borrowing at most ENV_LEAD_USE of each lead,
  // so a zero-length shoulder (or a tiny-angle bend asked to swallow a big
  // reduction) becomes a steep MONOTONE ramp instead of a cornered step or an
  // overhang the station model can't hold. The blends' zero end slopes keep
  // the window edges C¹ wherever they land, and the chain endpoints stay on
  // untouched cylinder.
  const half = ENV_SHOULDER * transitionMaxWall(tr) / 2;
  const c = leadA + len / 2;
  const w0 = c - Math.max(len / 2, Math.min(half, ENV_LEAD_USE * leadA + len / 2));
  const w1 = c + Math.max(len / 2, Math.min(half, ENV_LEAD_USE * leadB + len / 2));
  const wSpan = Math.max(w1 - w0, 1e-6);
  const guideAt = (d) => {
    const { P, T } = path.at(sBase + d);
    const { inner, wall } = transitionAt(tr, clamp((d - w0) / wSpan, 0, 1));
    return { P, T, v: [T[1], -T[0]], m: inner + wall / 2, r: wall / 2 };
  };

  // Sample placement: uniform in chain travel, not in d, so the long convex
  // side of a tight bend and the radial run of a steep shoulder get their fair
  // share. A coarse pass measures how far the two side guides (and the pen
  // width) move per interval; the fine grid is laid down uniformly in that
  // measure.
  const M = 64;
  const acc = [0];
  let prev = null, pch = null;
  for (let i = 0; i <= M; i++) {
    const q = guideAt((i / M) * span);
    const gT = [q.P[0] + q.m * q.v[0], q.P[1] + q.m * q.v[1]];
    const gB = [q.P[0] - q.m * q.v[0], q.P[1] - q.m * q.v[1]];
    if (prev) {
      const ch = [gT[0] - prev.gT[0], gT[1] - prev.gT[1], gB[0] - prev.gB[0], gB[1] - prev.gB[1]];
      let step = Math.max(Math.hypot(ch[0], ch[1]), Math.hypot(ch[2], ch[3])) + Math.abs(q.r - prev.r);
      // Where the stroke TURNS at pen scale the envelope curves at pen scale
      // too, so weight the turn by the pen radius — that is what packs the
      // stations onto a bulge's flanks instead of spreading them evenly.
      if (pch) {
        const turn = (a2, b2) => {
          const la = Math.hypot(a2[0], a2[1]), lb = Math.hypot(b2[0], b2[1]);
          if (la < 1e-12 || lb < 1e-12) return 0;
          return Math.atan2(Math.abs(a2[0] * b2[1] - a2[1] * b2[0]), a2[0] * b2[0] + a2[1] * b2[1]);
        };
        step += q.r * Math.max(turn([pch[0], pch[1]], [ch[0], ch[1]]), turn([pch[2], pch[3]], [ch[2], ch[3]]));
      }
      pch = ch;
      acc.push(acc[acc.length - 1] + Math.max(step, 1e-9));
    }
    prev = { gT, gB, r: q.r };
  }
  // Blur the per-cell weights over their neighbours before inverting: an
  // abrupt density change would step the interpolation error from one station
  // to the next, and that step is itself a (tiny) visible ripple.
  {
    const w = [];
    for (let i = 1; i <= M; i++) w.push(acc[i] - acc[i - 1]);
    const sw = w.map((x, i) => {
      const l = w[Math.max(0, i - 1)], r2 = w[Math.min(M - 1, i + 1)];
      return (l + 2 * x + r2) / 4;
    });
    for (let i = 1; i <= M; i++) acc[i] = acc[i - 1] + sw[i - 1];
  }
  const wMin = Math.max(transitionMinWall(tr), 0.1);
  const n = clamp(Math.ceil(acc[M] / Math.min(ENV_STATION_STEP, ENV_STEP_WALLS * wMin)), 48, ENV_MAX_SAMPLES);
  const S = [];
  for (let i = 0, j = 0; i <= n; i++) {
    const target = (i / n) * acc[M];
    while (j < M - 1 && acc[j + 1] < target) j++;
    const f = (target - acc[j]) / ((acc[j + 1] - acc[j]) || 1e-12);
    const d = i === 0 ? 0 : i === n ? span : ((j + f) / M) * span;
    const q = guideAt(d);
    q.s = sBase + d;
    S.push(q);
  }

  // Reach of the union along each station's cross-section ray. The wall's
  // in-plane band at station i is read off the pen stroke directly: cast the
  // ray from the centerline through the side guide (the same ray the revolve
  // station spans) and take the farthest reach of any nearby pen circle along
  // it for the outer surface, the nearest for the bore. That IS the envelope
  // of the union — creases, shoulders and bulge cavities fall out of the
  // max/min with no tangent bookkeeping, and a wall thinner than the pen is
  // impossible by construction: every circle bounds its own ray's band.
  //
  // The scan is windowed to the LOCAL stretch of the stroke, for correctness
  // before cost: on a deep bend the ray, extended far enough, pierces the far
  // side of the arc too, and its circles must not be mistaken for this
  // station's wall. Legitimate contributors sit within the pen radius of the
  // ray (vertical shoulders reach along it by the midwall travel), while the
  // far side of even the tightest legal bend is at least π·rMax of guide arc
  // away (the solver holds R − m > r, so the concave guide circles the pivot
  // no tighter than the pen): a window of 2·(midwall travel) + 2.5·rMax of
  // per-side chord arc covers every contributor and can never reach around.
  const sideArc = (G) => {
    const a = [0];
    for (let i = 1; i <= n; i++) a.push(a[i - 1] + Math.hypot(G[i][0] - G[i - 1][0], G[i][1] - G[i - 1][1]));
    return a;
  };
  const GT = S.map((q) => [q.P[0] + q.m * q.v[0], q.P[1] + q.m * q.v[1]]);
  const GB = S.map((q) => [q.P[0] - q.m * q.v[0], q.P[1] - q.m * q.v[1]]);
  const aT = sideArc(GT), aB = sideArc(GB);
  let mLo = Infinity, mHi = -Infinity, rMax = 0;
  for (const q of S) { mLo = Math.min(mLo, q.m); mHi = Math.max(mHi, q.m); rMax = Math.max(rMax, q.r); }
  const wWin = 2 * (mHi - mLo) + 2.5 * rMax;

  // A max over the SAMPLED circles alone under-reaches the smooth envelope
  // between samples by a hair that oscillates with the sample phase — a
  // scallop the shading picks up — so the scan works interval-by-interval on
  // the linearly interpolated family: center and radius vary linearly over
  // [j, j+1], and the extremum of h(t) ± √(r(t)² − u(t)²) has a closed form
  // (the stationary condition squares to a quadratic in t). Exact to the
  // interpolation, so the only error left is the family's own curvature
  // between samples — far below anything visible.
  const ivalExt = (u0, h0, r0, u1, h1, r1, mode) => {
    // mode +1: max of h+s over t∈[0,1]; mode −1: min of h−s. s = √(r²−u²).
    const du = u1 - u0, dh = h1 - h0, dr = r1 - r0;
    const p0 = r0 * r0 - u0 * u0, p1 = r0 * dr - u0 * du, p2 = dr * dr - du * du;
    const g = (t) => {
      const q1 = p0 + 2 * p1 * t + p2 * t * t;
      return q1 > 0 ? (h0 + dh * t) + mode * Math.sqrt(q1) : undefined;
    };
    let best; // running extremum (max for +1, min for −1)
    const take = (val) => {
      if (val === undefined) return;
      if (best === undefined || (mode > 0 ? val > best : val < best)) best = val;
    };
    take(g(0)); take(g(1));
    const A = (dh * dh - p2) * p2, B = 2 * p1 * (dh * dh - p2), C = dh * dh * p0 - p1 * p1;
    if (Math.abs(A) > 1e-12) {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        for (const t of [(-B + sq) / (2 * A), (-B - sq) / (2 * A)]) {
          if (t > 0 && t < 1) take(g(t));
        }
      }
    } else if (Math.abs(B) > 1e-12) {
      const t = -C / B;
      if (t > 0 && t < 1) take(g(t));
    }
    return best;
  };

  // Reach reads the CONNECTED run of material along the ray, not the global
  // union: on a deep bend the ray pierces the bend's other leg too, and at a
  // razor radius that leg sits closer than the local wall is tall — its
  // circles must extend this station's band only if their material actually
  // touches it. Start from the station's own circle and absorb every circle
  // whose along-ray interval overlaps the run; a gap of even a micron keeps
  // the legs apart, while true contact (a fold, a bulge cavity closing)
  // legitimately merges.
  const reach = (G, dirSign, i, jFrom, jTo) => {
    const P = S[i].P, T = S[i].T, v = S[i].v;
    const kN = jTo - jFrom + 1;
    const us = new Float64Array(kN), hs = new Float64Array(kN), ws = new Float64Array(kN);
    for (let j = jFrom; j <= jTo; j++) {
      const dx = G[j][0] - P[0], dy = G[j][1] - P[1];
      const u = dx * T[0] + dy * T[1];
      const rj = S[j].r;
      const k = j - jFrom;
      us[k] = u;
      hs[k] = (dx * v[0] + dy * v[1]) * dirSign;
      ws[k] = u > -rj && u < rj ? Math.sqrt(rj * rj - u * u) : NaN;
    }
    let lo = S[i].m - S[i].r, hi = S[i].m + S[i].r;
    const inRun = new Uint8Array(kN);
    inRun[i - jFrom] = 1;
    for (let pass = 0; pass < 6; pass++) {
      let grew = false;
      for (let k = 0; k < kN; k++) {
        if (inRun[k] || ws[k] !== ws[k]) continue;               // absorbed or missing the ray
        if (hs[k] - ws[k] <= hi + 1e-9 && hs[k] + ws[k] >= lo - 1e-9) {
          inRun[k] = 1;
          if (hs[k] + ws[k] > hi) { hi = hs[k] + ws[k]; grew = true; }
          if (hs[k] - ws[k] < lo) { lo = hs[k] - ws[k]; grew = true; }
          grew = true;
        }
      }
      if (!grew) break;
    }
    // Circles left over pierce this ray yet never joined the wall's run:
    // material hovering past the surface with air in between. When it comes
    // from the SAME stretch of wall — within a couple of pen radii of
    // centerline abscissa, i.e. a steep shoulder's corner folding over — the
    // station model cannot hold the overhang, so the pocket is filled: union
    // it in, and the wall comes out thicker with a crease, never thinner.
    // Material from farther along the centerline is the bend's own far half
    // (a razor's legs legitimately hover a hair apart across the pivot) and
    // must stay separate.
    for (let pass = 0; pass < 4; pass++) {
      let grew = false;
      for (let k = 0; k < kN; k++) {
        if (inRun[k] || ws[k] !== ws[k]) continue;
        if (Math.abs(S[jFrom + k].s - S[i].s) > 2 * rMax) continue;
        inRun[k] = 1;
        if (hs[k] + ws[k] > hi) { hi = hs[k] + ws[k]; grew = true; }
        if (hs[k] - ws[k] < lo) { lo = hs[k] - ws[k]; grew = true; }
      }
      if (!grew) break;
      // absorbing a pocket can bridge to further circles — resume the plain
      // component expansion with the widened run
      for (let k = 0; k < kN; k++) {
        if (inRun[k] || ws[k] !== ws[k]) continue;
        if (hs[k] - ws[k] <= hi + 1e-9 && hs[k] + ws[k] >= lo - 1e-9) {
          inRun[k] = 1;
          if (hs[k] + ws[k] > hi) hi = hs[k] + ws[k];
          if (hs[k] - ws[k] < lo) lo = hs[k] - ws[k];
        }
      }
    }
    // Polish the run's ends on the interpolated family, pairs inside the run
    // only — a pair straddling the run's edge would bridge the very gap the
    // component test just kept open. Most pairs provably can't move either
    // extremum (h is linear, the radius is bounded by the larger endpoint,
    // |u| by the smaller when it doesn't change sign), so they skip the
    // closed-form solve outright.
    for (let k = 1; k < kN; k++) {
      if (!inRun[k - 1] || !inRun[k]) continue;
      const r0 = S[jFrom + k - 1].r, r1 = S[jFrom + k].r;
      const rM = r0 > r1 ? r0 : r1;
      const um = (us[k - 1] > 0) === (us[k] > 0) ? Math.min(Math.abs(us[k - 1]), Math.abs(us[k])) : 0;
      const wB = rM > um ? Math.sqrt(rM * rM - um * um) : 0;
      const hMax = hs[k - 1] > hs[k] ? hs[k - 1] : hs[k];
      const hMin = hs[k - 1] < hs[k] ? hs[k - 1] : hs[k];
      if (hMax + wB > hi) {
        const mx = ivalExt(us[k - 1], hs[k - 1], r0, us[k], hs[k], r1, 1);
        if (mx !== undefined && mx > hi) hi = mx;
      }
      if (hMin - wB < lo) {
        const mn = ivalExt(us[k - 1], hs[k - 1], r0, us[k], hs[k], r1, -1);
        if (mn !== undefined && mn < lo) lo = mn;
      }
    }
    return { hi, lo };
  };

  // Pair the two rays of each sample — the SAME cross-section — into revolve
  // stations. Each station keeps its honest centerline abscissa, which is what
  // the splice (zoneAt) and the schematic measure against. The end stations
  // are written from the section profile directly: the zone must hand the
  // splice (sameRing) exactly the ring the neighbouring section starts with.
  const stOuter = [], stInner = [];
  let t0 = 0, t1 = 0, b0 = 0, b1 = 0;   // two-pointer window bounds per side
  for (let i = 0; i <= n; i++) {
    const P = S[i].P, v = S[i].v;
    while (t0 < n && aT[t0] < aT[i] - wWin) t0++;
    while (t1 < n && aT[t1 + 1] <= aT[i] + wWin) t1++;
    while (b0 < n && aB[b0] < aB[i] - wWin) b0++;
    while (b1 < n && aB[b1 + 1] <= aB[i] + wWin) b1++;
    let oT, oB, bT, bB;
    if (i === 0 || i === n) {
      oT = oB = S[i].m + S[i].r;
      bT = bB = S[i].m - S[i].r;
    } else {
      const rT = reach(GT, 1, i, t0, Math.max(t1, i)), rB = reach(GB, -1, i, b0, Math.max(b1, i));
      oT = rT.hi; oB = rB.hi; bT = rT.lo; bB = rB.lo;
    }
    const mkSt = (hT, hB) => {
      const pT = [P[0] + hT * v[0], P[1] + hT * v[1]];
      const pB = [P[0] - hB * v[0], P[1] - hB * v[1]];
      const C = [(pT[0] + pB[0]) / 2, (pT[1] + pB[1]) / 2];
      const vx = pT[0] - C[0], vy = pT[1] - C[1];
      const r = Math.hypot(vx, vy);
      return { s: S[i].s, r: Math.max(r, 1e-4), C, v: r > 1e-12 ? [vx / r, vy / r] : [0, 1] };
    };
    stOuter.push(mkSt(oT, oB));
    stInner.push(mkSt(bT, bB));
  }
  return { outer: stOuter, inner: stInner };
}


// Inner radius + outer radius at arclength s: constant within a straight
// section, the nominal radial blend across a bend. Transitions whose shape
// varies are meshed from envelopeChains stations instead of this profile —
// this stays as the reference (and serves the constant case, where it's exact).
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
// its radius rises to O+Th at the center and rounds back to the base radius O at
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
// Teeth are centerd on the top of the pipe within the bend plane: θ=0 in ring()
// points out of that plane (the +z "side") and +v (θ=+90°) is the bottom, so the
// pattern is phase-shifted to −90° to put a tooth at the top (−v). A single tooth
// then sits at the top, and larger counts stay symmetric about the bend plane.
const TOOTH_PHASE = -Math.PI / 2;
function toothAngular(th, n, half, fRad) {
  const sector = (2 * Math.PI) / n;
  const rel = (th - TOOTH_PHASE) / sector;
  const frac = rel - Math.round(rel);                   // −0.5..0.5 of the nearest sector
  const delta = Math.abs(frac) * sector;                // angular distance to the nearest tooth center
  // A gap only exists where teeth don't fill the circle (half < sector/2). When
  // they do fill it, the seams stay at full height so the ring is solid.
  if (delta >= half && half < sector / 2 - 1e-9) return 0;
  const edge = half - delta;                            // inward from the tooth edge
  if (fRad <= 0 || edge >= fRad) return 1;
  const x = clamp(edge / fRad, 0, 1);
  return x * x * (3 - 2 * x);                            // smoothstep fillet, base → top
}
function teethLength(end, secLen) {
  return clamp(end.Th * 2.2, 1.2, secLen * 0.7);
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
    // Side (angular) fillet gets a QUARTER of the value - it reads strongly there,
    // so most of the value is reserved for the top edge where it matters most.
    // Still capped by the tooth half-width and the gap to its neighbor, so teeth
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
  const secLen = endAvail(sec);   // the straight run this end may occupy
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
    // into the cliff - otherwise the cliff's normal is averaged away.
    pts.push({ d: 0, r: O });
    for (let k = 0; k < n; k++) {
      const top = (k + 1) * pitch;
      pts.push({ d: top, r: O + h }, { d: top, r: O + h });   // ramp to peak, hard edge
      pts.push({ d: top, r: O }, { d: top, r: O });           // cliff to base, hard edge
    }
  } else if (type === 'teeth') {
    // Envelope of the teeth zone (peak radius vs. axial distance) - used for the
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
    const E = end.FitL, floor = fitFloor(st.w, E, secLen);
    if (st.side === 'inside') {
      const cx = Math.min(end.FitChX, E), cy = end.FitChY;
      if (cx > 0 && cy > 0) pts.push({ d: 0, r: st.sO - cy }, { d: cx, r: st.sO });
      else pts.push({ d: 0, r: st.sO });
      pts.push({ d: E, r: st.sO });            // spigot outer runs to the stop
      pts.push({ d: E, r: O });                // stop: outer step up to the body (zone ends here)
    } else {
      pts.push({ d: 0, r: st.sO });            // socket outer (no outer chamfer)
      pts.push({ d: E + floor, r: st.sO });    // past the stop, through the floor behind it
      pts.push({ d: E + floor, r: O });        // collar step to the body
    }
  } else {
    pts.push({ d: 0, r: O });
  }
  return pts;
}

// Bore-side control points measured from one end, innermost first. The chamfer
// and the fit (slip joint) touch the bore; every other treatment leaves it straight.
function innerEndFeature(end, baseInner, sec) {
  const secLen = endAvail(sec);   // the straight run this end may occupy
  if (end.type === 'fit' && end.FitL > 0) {
    const st = fitStub(end, sec);
    const E = end.FitL;
    if (st.side === 'inside') {
      // Spigot bore runs straight through the insertion length, then opens back
      // out to the body bore as one gradual taper spanning the whole inside of
      // the section body (a smooth internal reducer, rather than an abrupt wall).
      // The taper reaches the body bore at the far (bend) junction of the span -
      // or, on a section with two ends, at the midpoint where the other end's
      // zone begins.
      return [{ d: 0, r: st.sI }, { d: E, r: st.sI }, { d: secLen + E, r: st.I }];
    }
    // Socket bore = stub bore with a lead-in flare, running to the stop where it
    // steps DOWN to the body bore (the mate bottoms against that shoulder).
    const cx = Math.min(end.FitChX, E), cy = end.FitChY, pts = [];
    if (cx > 0 && cy > 0) pts.push({ d: 0, r: st.sI + cy }, { d: cx, r: st.sI });
    else pts.push({ d: 0, r: st.sI });
    pts.push({ d: E, r: st.sI });
    pts.push({ d: E, r: st.I });
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

// Emits the N+1 vertices of one cross-section ring for station `st` — the last
// duplicates the first position but carries u at the full wrap, so a wrap-around
// texture has no seam at the ring closure. The k=0 / k=N index pair is recorded
// in `seams` so their normals can be welded back together (the extra vertex is
// only for UVs, not a shading crease). `st.r` is either a scalar radius or a
// function (k, θ) → radius, letting a station vary its radius by angle (the
// teeth end treatment). A station is normally { s, r } — centered on the
// centerline at arclength s — but an envelope station carries its own bend-plane
// center C and in-plane direction v (toward its top point), letting rings sit
// off-center through a transition. `vCoord` is the v texture coordinate; pass
// `uvs`/`seams` = null to skip.
function ring(out, uvs, seams, path, st, N, vCoord) {
  let P, v;
  if (st.C) {
    P = [st.C[0], st.C[1], 0];
    v = [st.v[0], st.v[1], 0];
  } else {
    const q = path.at(st.s);
    P = q.P;
    v = [q.T[1], -q.T[0], 0];
  }
  const u = [0, 0, 1], r = st.r;
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
    return ring(verts, uvs, seams, path, st, N, vAcc / TEX_VSCALE);
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
    const st0 = stations[i];
    const P = st0.C ? [st0.C[0], st0.C[1], 0] : path.at(st0.s).P;
    const rad = [a[0] - P[0], a[1] - P[1], a[2] - P[2]];
    const dot = nx * rad[0] + ny * rad[1] + nz * rad[2];
    flip = outward ? dot < 0 : dot > 0;
    break;
  }
  for (let i = 0; i + 1 < stations.length; i++) {
    // Two identical consecutive stations mean "hard edge here": emit no quad
    // between them, so their (coincident) rings keep separate normals. Used to
    // give a saw-tooth barb crisp corners instead of smoothing ramp into cliff.
    // (Envelope stations can legitimately repeat an s, so they never hard-edge.)
    // A teeth zone rebuilds every station's radius as a fresh closure over the
    // same spec, so two identical stations there hold two callable objects that
    // are never ===. Same s and same spec means the same ring, and a zone only
    // ever covers one end, so matching on "both callable" cannot conflate two.
    const ra = stations[i].r, rb = stations[i + 1].r;
    if (stations[i].s === stations[i + 1].s && !stations[i].C && !stations[i + 1].C
        && (ra === rb || (typeof ra === 'function' && typeof rb === 'function'))) continue;
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
  const bi = ring(verts, uvs, seams, path, { s, r: ri }, N, ri / TEX_VSCALE);
  const bo = ring(verts, uvs, seams, path, { s, r: ro }, N, ro / TEX_VSCALE);
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
// watertight without shared vertex indices - the module's usual contract.
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
  // The two open ends: A on the first section, B on the last. With a single
  // section `first` and `last` are the same section, carrying one of each.
  const endA = first.endA, endB = last.endB;
  const od = sections.map((sc) => sc.id + 2 * sc.w);
  const hasTeeth = endA.type === 'teeth' || endB.type === 'teeth';
  // Teeth need more angular resolution to render their sectors and fillets.
  const N = hasTeeth ? Math.max(radialSegments || 84, 160) : (radialSegments || 84);

  // End features only exist on the first and last sections. Their zones are
  // needed before the path: the bend solver keeps its envelope leads clear of
  // them (and the same leads later place the meshed envelope chains).
  const Ofirst = od[0] / 2, Olast = od[nSec - 1] / 2;
  const featA = endFeature(endA, Ofirst, first);
  const featB = endFeature(endB, Olast, last);
  const zoneA = featA[featA.length - 1].d;
  const zoneB = featB[featB.length - 1].d;
  const innerFeatA = innerEndFeature(endA, first.id / 2, first);
  const innerFeatB = innerEndFeature(endB, last.id / 2, last);
  const iZoneA = innerFeatA[innerFeatA.length - 1].d;
  const iZoneB = innerFeatB[innerFeatB.length - 1].d;

  const path = makePath(p, { a: Math.max(zoneA, iZoneA), b: Math.max(zoneB, iZoneB) });
  const T = path.total;
  for (let i = 0; i < path.perBend.length; i++) {
    const b = path.perBend[i];
    // Only note a raise the 0.1 mm readouts can actually show; a request within
    // rounding of the floor (e.g. the slider parked on the floor itself) is met.
    if (b.bend && b.faceClamped && b.minFace - bends[i].l2 > 0.05) {
      notes.push('Bend ' + (i + 1) + ' raised to ~' + (round(b.minFace, 1)) + ' mm — the tightest bend this profile allows');
    }
  }

  // ---- longitudinal sampling -------------------------------------------
  const samples = [];
  const push = (s) => { if (s >= -1e-9 && s <= T + 1e-9) samples.push(clamp(s, 0, T)); };
  const seg = (from, to, n) => { for (let i = 0; i <= n; i++) push(lerp(from, to, i / n)); };
  for (const sg of path.segments) {
    const span = sg.sEnd - sg.sStart;
    if (sg.kind === 'section') {
      seg(sg.sStart, sg.sEnd, Math.max(4, Math.ceil(span / 2)));
    } else {
      // Varying transitions get their stations from envelopeChains (the samples
      // here are skipped for them); this sampling serves constant-profile bends.
      const bd = bends[sg.bi], b = path.perBend[sg.bi];
      const base = b.bend ? Math.max(24, Math.ceil(Math.abs(bd.ang) / 1.5)) : Math.max(6, Math.ceil(bd.l2 / 2));
      seg(sg.sStart, sg.sEnd, base);
    }
  }

  const sorted = [...new Set(samples)].sort((a, b) => a - b);

  // Varying transitions are meshed from their disc-envelope chains — ring
  // stations that may sit off-center and repeat an s (vertical shoulder faces),
  // so they are spliced into the assembly in place of per-sample profileAt
  // stations. Each zone takes a short lead into its neighbouring sections
  // (clamped to half the section and clear of the end-feature zones), so the
  // chains stay flush with the section rings even when a shoulder's end circles
  // overhang the junction. The leads are the ones makePath already used to
  // solve each bend's radius, so the face the solver measured and the face
  // meshed here are the same curve.
  const envZones = [];
  for (const sg of path.segments) {
    if (sg.kind !== 'bend' || !transitionVaries(sg.tr)) continue;
    const { leadA, leadB } = path.perBend[sg.bi];
    const ch = envelopeChains(sg, path, leadA, leadB);
    envZones.push({ sStart: sg.sStart - leadA, sEnd: sg.sEnd + leadB, outer: ch.outer, inner: ch.inner });
  }
  const zoneAt = (s) => envZones.find((z) => s >= z.sStart - 1e-9 && s <= z.sEnd + 1e-9);

  // Two consecutive stations that resolve to the SAME ring — same centre, same
  // in-plane axis, same radius (see ring) — sweep a zero-area band: N triangles
  // with no area, which mesh checkers flag as degenerate facets. That happens
  // where two envelope zones abut. A middle section shorter than both its
  // neighbours' leads has each lead clamped to half of it, so one zone ends
  // exactly where the next begins and both emit the junction ring. Splicing a
  // zone skips a leading repeat. Deliberate duplicates elsewhere are untouched:
  // a barb cliff and a tooth edge stack two stations on purpose so the shared
  // normal isn't averaged away, and those are pushed straight from endFeature,
  // never through here.
  // Compared by where the ring's two rim points land in the bend plane, which
  // pins the circle completely (centre + radius + axis) — two chains can reach
  // the same junction by different arithmetic and disagree in the last few
  // digits, so comparing the stored centre/axis/radius field-by-field misses
  // them. The slack has to clear more than float noise: two chains meeting at a
  // junction agree on centre and radius but can disagree in the last digits of
  // their axis, which swings the rim by ~1e-6 mm — enough to leave a band of
  // collinear (zero-area) triangles behind while every stored field still looks
  // distinct. A tenth of a micron is 20× below the smallest feature the model
  // can hold (a 2 µm face arc) and ~1000× below the spacing of anything that
  // reaches here: envelope rings sit ~0.3 mm apart, profile samples ~0.2 mm.
  // End features stack stations far closer than that on purpose, but they go
  // straight from endFeature into the list and never through pushStation.
  const RING_EPS = 1e-4;   // mm
  const sameRing = (a, b) => {
    if (!a || !b || typeof a.r !== 'number' || typeof b.r !== 'number') return false;
    const rim = (st) => {
      let P, v;
      if (st.C) { P = st.C; v = st.v; }
      else { const q = path.at(st.s); P = q.P; v = [q.T[1], -q.T[0]]; }
      return [P[0] + st.r * v[0], P[1] + st.r * v[1], P[0] - st.r * v[0], P[1] - st.r * v[1]];
    };
    const ra = rim(a), rb = rim(b);
    for (let i = 0; i < 4; i++) if (Math.abs(ra[i] - rb[i]) > RING_EPS) return false;
    return true;
  };
  const pushStation = (arr, q) => { if (!sameRing(arr[arr.length - 1], q)) arr.push(q); };

  const inner = [];
  const innerDone = new Set();
  for (const f of innerFeatA) inner.push({ s: f.d, r: f.r });
  for (const s of sorted) {
    if (s > iZoneA + 1e-6 && s < T - iZoneB - 1e-6) {
      const z = zoneAt(s);
      if (z) { if (!innerDone.has(z)) { innerDone.add(z); for (const q of z.inner) pushStation(inner, q); } continue; }
      pushStation(inner, { s, r: profileAt(s, path).inner });
    }
  }
  for (let i = innerFeatB.length - 1; i >= 0; i--) inner.push({ s: T - innerFeatB[i].d, r: innerFeatB[i].r });

  // A flange with drilled holes can't be a plain surface of revolution, so its
  // lip is meshed separately (see buildFlangeEnd). When that happens the outer
  // sweep is trimmed to the lip root and the end cap is replaced by hole-aware
  // faces; the full station list is still kept for the schematic silhouette.
  const holesA = endA.type === 'flange' && endA.Fn >= 1 && endA.Fh > 0;
  const holesB = endB.type === 'flange' && endB.Fn >= 1 && endB.Fh > 0;

  const assembleOuter = (trimA, trimB) => {
    const arr = [];
    const done = new Set();
    if (trimA) arr.push({ s: endA.Ft, r: Ofirst });
    else for (const f of featA) arr.push({ s: f.d, r: f.r });
    for (const s of sorted) {
      if (s > zoneA + 1e-6 && s < T - zoneB - 1e-6) {
        const z = zoneAt(s);
        if (z) { if (!done.has(z)) { done.add(z); for (const q of z.outer) pushStation(arr, q); } continue; }
        pushStation(arr, { s, r: profileAt(s, path).outer });
      }
    }
    if (trimB) arr.push({ s: T - endB.Ft, r: Olast });
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
  if (endA.type === 'teeth') teethSpecs.push(teethSpec(endA, Ofirst, T, endAvail(first), true));
  if (endB.type === 'teeth') teethSpecs.push(teethSpec(endB, Olast, T, endAvail(last), false));
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
  // A bore chamfer deep enough to eat the whole wall closes the mouth to a knife
  // edge: the end face is a zero-width annulus, and capping it lays down a full
  // ring of zero-area triangles. The bore and the outer surface already end on
  // the same circle there, so they meet without a cap — the solid stays closed
  // once coincident rim vertices are welded, which is what STL/3MF import does.
  const capped = (ri, ro) => typeof ri !== 'number' || typeof ro !== 'number' || Math.abs(ro - ri) > 1e-9;
  if (holesA) buildFlangeEnd(verts, uvs, seams, idx, path, N, { sFace: 0, sRoot: endA.Ft, O: Ofirst, fw: endA.Fw, rh: endA.Fh / 2, n: endA.Fn, boreR: first.id / 2, frontPlusTangent: false });
  else if (capped(inner[0].r, meshStations[0].r)) cap(verts, uvs, seams, idx, path, 0, inner[0].r, meshStations[0].r, N, -1);
  if (holesB) buildFlangeEnd(verts, uvs, seams, idx, path, N, { sFace: T, sRoot: T - endB.Ft, O: Olast, fw: endB.Fw, rh: endB.Fh / 2, n: endB.Fn, boreR: last.id / 2, frontPlusTangent: true });
  else if (capped(inner[inner.length - 1].r, meshStations[meshStations.length - 1].r)) cap(verts, uvs, seams, idx, path, T, inner[inner.length - 1].r, meshStations[meshStations.length - 1].r, N, 1);

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
  // radii - which the bend plane cuts at +v and −v (see silStations for teeth).
  // Envelope stations carry their own bend-plane center/direction.
  const sil = (stations) => {
    const top = [], bot = [];
    for (const st of stations) {
      if (st.C) {
        top.push([st.C[0] + st.r * st.v[0], st.C[1] + st.r * st.v[1]]);
        bot.push([st.C[0] - st.r * st.v[0], st.C[1] - st.r * st.v[1]]);
        continue;
      }
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
  // ring()), so sample the tooth radius there rather than the peak envelope -
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
        // The length tick runs from the slip joint's interior stop wall to the
        // far end — that span is the section's length. A joint extends the span
        // past the free end (s=0 for the first section, s=T for the last) by its
        // protruding stub; trim each end's own stub off so the tick spans
        // exactly sc.l, whichever ends this section carries.
        const lStart = sp.sStart + fitLenOf(sc, sc.endA);
        const lEnd = sp.sEnd - fitLenOf(sc, sc.endB);
        const la = path.at(lStart), lc = path.at(lEnd);
        return {
          id: sc.id, w: sc.w, l: sc.l, od: od[i], sStart: sp.sStart, sEnd: sp.sEnd,
          p0: [a.P[0], a.P[1]], p1: [c.P[0], c.P[1]], t: [a.T[0], a.T[1]],
          lStart, lEnd, lp0: [la.P[0], la.P[1]], lp1: [lc.P[0], lc.P[1]],
        };
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

// ── Assembly ─────────────────────────────────────────────────────────────────
// Each pipe is built on its own, starting at the origin and heading along +x
// with its bends in the z=0 plane. Placing pipe j+1 is therefore a single rigid
// motion in that plane: rotate it to leave along its neighbour's exit tangent,
// and drop its start point on the neighbour's mating face. Since every pipe
// shares the one bend plane, the assembly stays planar - which is what keeps
// the 2D schematic able to draw the whole chain.
//
// A placement is { th, c, s, ox, oy }: rotate (x,y) by th about the z axis
// (the axis the tube rings are swept around), then translate. z is untouched.

// Where each pipe sits, resolved left to right from the first pipe at identity.
function placeChain(paramPipes, built) {
  const out = [{ th: 0, c: 1, s: 0, ox: 0, oy: 0 }];
  for (let j = 1; j < built.length; j++) {
    const prev = out[j - 1];
    // The neighbour's exit frame, still in ITS OWN coordinates - every pipe is
    // placed before any geometry is moved, so these are all local reads.
    const e = built[j - 1].endPoints[1];
    const back = jointStub(paramPipes[j - 1], paramPipes[j]);
    // The point this pipe's origin lands on, in the neighbour's frame: its face,
    // walked back along the tangent by however far a slip-joint stub protrudes.
    const qx = e.P[0] - back * e.T[0], qy = e.P[1] - back * e.T[1];
    const th = prev.th + Math.atan2(e.T[1], e.T[0]);
    out.push({
      th, c: Math.cos(th), s: Math.sin(th),
      ox: prev.ox + prev.c * qx - prev.s * qy,
      oy: prev.oy + prev.s * qx + prev.c * qy,
    });
  }
  return out;
}

// Move one built pipe into assembly coordinates, in place. Everything the app
// consumes downstream - mesh, schematic, export orientation - is left in the
// same space, so nothing past this point has to know about placement.
function placeGeometry(g, pl) {
  if (!pl.th && !pl.ox && !pl.oy) return g;
  const { c, s, ox, oy } = pl;
  const pt = (q) => { const x = q[0], y = q[1]; q[0] = ox + c * x - s * y; q[1] = oy + s * x + c * y; };
  const vec = (q) => { const x = q[0], y = q[1]; q[0] = c * x - s * y; q[1] = s * x + c * y; };
  const P = g.positions;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1];
    P[i] = ox + c * x - s * y; P[i + 1] = oy + s * x + c * y;   // z (P[i+2]) is the rotation axis
  }
  for (const side of [g.silhouette.outer, g.silhouette.inner]) { side.top.forEach(pt); side.bot.forEach(pt); }
  g.silhouette.center.forEach(pt);
  for (const sec of g.path.sections) { pt(sec.p0); pt(sec.p1); pt(sec.lp0); pt(sec.lp1); vec(sec.t); }
  for (const bd of g.path.bends) { pt(bd.p0); pt(bd.p1); vec(bd.t0); vec(bd.t1); if (bd.center) pt(bd.center); }
  for (const ep of g.endPoints) { pt(ep.P); vec(ep.T); }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) { if (P[i + k] < mn[k]) mn[k] = P[i + k]; if (P[i + k] > mx[k]) mx[k] = P[i + k]; }
  }
  g.bbox = { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  return g;
}

// Build a whole chain: every pipe meshed on its own, then assembled. `driver`
// (the { pi, si } of the section the user just edited) steers which side of
// each joint wins - see syncJoints.
export function buildChain(raw, radialSegments, driver) {
  const { p } = normalizeChain(raw, driver);
  const n = p.pipes.length;
  const notes = [];
  const pipes = p.pipes.map((pp, j) => {
    const g = build(pp, radialSegments);
    for (const note of g.notes) notes.push(pipeNote(j, n, note));
    return g;
  });
  const placements = placeChain(p.pipes, pipes);
  pipes.forEach((g, j) => placeGeometry(g, placements[j]));

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let triCount = 0, total = 0;
  for (const g of pipes) {
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], g.bbox.min[k]); mx[k] = Math.max(mx[k], g.bbox.max[k]); }
    triCount += g.triCount;
    total += g.path.total;
  }
  // Assembled, a slip joint's stub lies inside its mate rather than adding to
  // the run, so the chain is shorter than its pipes laid end to end.
  for (let j = 1; j < n; j++) total -= jointStub(p.pipes[j - 1], p.pipes[j]);
  return {
    p, notes, pipes, placements,
    bbox: { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] },
    triCount, total,
  };
}

/* ── Ear-clipping triangulation with holes ─────────────────────────────────
   Adapted from mapbox/earcut (ISC License). The z-order hashing fast path is
   removed - the flange faces have few vertices, so the plain O(n²) ear test is
   fine. `data` is a flat [x0,y0,x1,y1,...] list; `holeIndices` gives the vertex
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

function binarySTLBytes(positions, indices, name) {
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
  return new Uint8Array(buf);
}

export function toBinarySTL(positions, indices, name) {
  return new Blob([binarySTLBytes(positions, indices, name)], { type: 'model/stl' });
}

// STL holds exactly one triangle soup, so a chain of separately-printed pipes
// can't share a file. Bundle one STL per pipe into a ZIP instead of firing a
// download per part - browsers block or prompt on a burst of downloads.
// `parts` is [{ name, positions, indices }]; `name` is the file's base name.
export function toSTLZip(parts) {
  const files = parts.map((pt) => ({
    name: pt.name + '.stl',
    data: binarySTLBytes(pt.positions, pt.indices, pt.name),
  }));
  return new Blob(mfZip(files), { type: 'application/zip' });
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

const mfEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// Emit one <object> for a triangle soup. Coincident vertices are welded onto a
// 1e-4 mm grid - far below print resolution, above float noise - so shared
// edges become truly shared (manifold by index), which is what 3MF wants and
// STL cannot express.
function mfObject(out, id, part) {
  const { positions, indices } = part;
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
  out.push('  <object id="' + id + '" type="model" name="' + mfEsc(part.name || 'pipe adapter') + '">\n   <mesh>\n    <vertices>\n');
  for (let i = 0; i < verts.length; i += 3) {
    out.push('     <vertex x="' + verts[i] + '" y="' + verts[i + 1] + '" z="' + verts[i + 2] + '"/>\n');
  }
  out.push('    </vertices>\n    <triangles>\n');
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) continue; // drop degenerate
    out.push('     <triangle v1="' + a + '" v2="' + b + '" v3="' + c + '"/>\n');
  }
  out.push('    </triangles>\n   </mesh>\n  </object>\n');
}

// Unlike STL, 3MF is a package of indexed objects, so a whole chain fits in one
// file: an object per pipe, each a separate build item the slicer can move or
// print on its own. The parts arrive already in assembly coordinates, so the
// items need no transform of their own and the file opens as the assembly.
// `parts` is [{ name, positions, indices }].
export function to3MF(parts) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    ' <resources>\n',
  ];
  parts.forEach((part, i) => mfObject(out, i + 1, part));
  out.push(' </resources>\n <build>\n');
  parts.forEach((part, i) => out.push('  <item objectid="' + (i + 1) + '"/>\n'));
  out.push(' </build>\n</model>\n');

  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', data: enc.encode(MF_CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(MF_RELS) },
    { name: '3D/3dmodel.model', data: enc.encode(out.join('')) },
  ];
  return new Blob(mfZip(files), { type: 'model/3mf' });
}
