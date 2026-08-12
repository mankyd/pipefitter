// Live cross-section schematic drawn on a 2D canvas from the geometry result.

// Canvas drawing can't read CSS variables, so the two themes are spelled out
// here and swapped by setDiagramTheme (called from applyTheme in app.js).
// `bore` is the hollow and reads as absence, so it sits past `bg` on the same
// side as the theme's background: darker than everything in dark, lighter in
// light. `fill` is the pipe wall and always sits on the other side.
const THEMES = {
  dark: {
    bg: '#1b1d2b',
    wall: '#b2b6ca',
    fill: '#2b2e3d',
    bore: '#161826',
    highlight: '#5d5294',   // section / bend highlight band
    center: '#796cbf',
    dim: '#75798c',
    label: '#9397ab',
    accent: '#b5abfc',
  },
  light: {
    bg: '#ffffff',
    wall: '#4c5060',
    fill: '#e6e9f4',
    bore: '#fbfbfe',
    highlight: '#ded9ff',
    center: '#6f61c4',
    dim: '#83879a',
    label: '#5b5f70',
    accent: '#5d5294',
  },
};
let T = THEMES.dark;

export function setDiagramTheme(name) {
  T = THEMES[name] || THEMES.dark;
}

// `chain` is the buildChain result: { pipes: [...] }, every pipe already in
// assembly coordinates, so the whole set shares one fit and one transform.
// `highlight` selects the hovered group to band: null, or { pipe, kind:'pipe'|
// 'section'|'bend', index } (an arclength span is derived from that pipe's
// path). `view` is an optional user zoom/pan applied on top of the base fit:
// { zoom, panX, panY } in screen (CSS px) space, defaulting to identity - the
// drawing keeps its correct aspect ratio at every zoom because the base fit
// uses a single uniform scale. `onlyPipe` draws a single pipe of the chain by
// index, so one part can be read on its own; null or undefined draws them all.
// Returns { leftX, leftTopY } - the screen position (CSS px, canvas-relative)
// of the drawing's left edge and the top of its first pipe's left end, so
// callers can line an overlay up with it.
export function drawDiagram(canvas, chain, highlight, bottomInset, units, view, onlyPipe) {
  if (!canvas || !chain || !chain.pipes || !chain.pipes.length) return null;
  // Each entry keeps the pipe's index in the whole chain, so a part drawn on
  // its own is still labelled by which pipe it actually is.
  const all = chain.pipes
    .map((g, i) => ({ g, i }))
    .filter((p) => onlyPipe == null || p.i === onlyPipe);
  if (!all.length) return null;
  const nPipes = chain.pipes.length;
  const g = all[0].g;
  // Dimension labels are converted for display only; the geometry is always mm.
  const inMode = units === 'in';
  const nv = (mm) => inMode ? (Math.round((mm / 25.4) * 1000) / 1000) : mm;   // number in the active unit
  const uu = inMode ? ' in' : ' mm';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, w, h);

  // Fit the whole chain at once, so the parts keep their relative size and the
  // joints read as joints rather than as two separately-scaled drawings.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { g: gp } of all) {
    for (const q of [...gp.silhouette.outer.top, ...gp.silhouette.outer.bot]) {
      if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
      if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1];
    }
  }
  // Fit to the pipe alone. The bend center is deliberately excluded - at
  // shallow angles it is hundreds of mm away and would shrink the part to a
  // hairline. The B arc and angle mark may run out of frame; that is fine.
  const pad = 44;
  const bi = bottomInset || 0;   // extra reserved space at the bottom (for a floating overlay)
  const sx = (w - pad * 2) / Math.max(1, maxX - minX);
  const sy = (h - pad * 2 - bi) / Math.max(1, maxY - minY);
  const k = Math.min(sx, sy);
  const ox = (w - (maxX - minX) * k) / 2 - minX * k;
  // Center vertically within [pad, h - pad - bi] (Y is flipped, so Y(maxY) is the top).
  const oy = pad + ((h - 2 * pad - bi) - (maxY - minY) * k) / 2 + maxY * k;
  // User zoom/pan rides on top of the base fit as a uniform screen-space
  // transform, so the aspect ratio is preserved at every zoom level.
  const zoom = (view && view.zoom) || 1;
  const panX = (view && view.panX) || 0;
  const panY = (view && view.panY) || 0;
  const X = (x) => panX + zoom * (ox + x * k);
  const Y = (y) => panY + zoom * (oy - y * k);
  const kz = k * zoom;   // effective world→screen scale, for screen-px margins

  const trace = (list) => {
    list.forEach((q, i) => (i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1]))));
  };
  const poly = (list, close) => {
    ctx.beginPath();
    trace(list);
    if (close) ctx.closePath();
  };

  // Solid wall bodies. Every part is drawn before any dimension is, so one
  // pipe's body can't paint over its neighbour's labels.
  //
  // A joint puts one pipe INSIDE another - a spigot down its mate's bore, or a
  // socket's collar around its mate's end - so the parts have to be layered by
  // what they are rather than by which pipe they belong to. Hollow first for
  // every pipe, then solid for every pipe: a bore is a hole, and anything that
  // reaches into it is material seen through that hole, so it has to sit on
  // top. Drawing each pipe complete in turn would let the later one's bore
  // paint out the end of the pipe plugged into it.
  const loops = all.map(({ g: gp }) => ({
    outer: [...gp.silhouette.outer.top, ...[...gp.silhouette.outer.bot].reverse()],
    inner: [...gp.silhouette.inner.top, ...[...gp.silhouette.inner.bot].reverse()],
  }));

  ctx.fillStyle = T.bore;
  for (const lp of loops) { poly(lp.inner, true); ctx.fill(); }

  // The wall alone - the outer silhouette with the bore knocked out (even-odd),
  // so filling it can never cover what is inside the hollow.
  ctx.fillStyle = T.fill;
  for (const lp of loops) {
    ctx.beginPath();
    trace(lp.outer); ctx.closePath();
    trace(lp.inner); ctx.closePath();
    ctx.fill('evenodd');
  }

  ctx.strokeStyle = T.wall;
  for (const lp of loops) {
    ctx.lineWidth = 1.25;
    poly(lp.outer, true); ctx.stroke();
    ctx.lineWidth = 1;
    poly(lp.inner, true); ctx.stroke();
  }

  // Section highlight (hover-driven). `highlight` is { pipe, kind, index }
  // naming a section, a bend, or a whole pipe - a translucent band over that
  // segment, expanded a little beyond the pipe - or falsy for no highlight.
  // Building it from the segment's outer silhouette offset along its own
  // outward normal handles straight, tapered, and bent sections uniformly.
  // Drawn over the cross-section so it reads as a highlight; centerline and
  // dimensions stay crisp on top.
  if (highlight) {
    const found = all.find((p) => p.i === (highlight.pipe || 0));
    const gp = found && found.g;
    const src = gp && (highlight.kind === 'bend' ? gp.path.bends[highlight.index]
      : highlight.kind === 'pipe' ? { sStart: 0, sEnd: gp.path.total }
        : gp.path.sections[highlight.index]);
    const span = src ? [src.sStart, src.sEnd] : null;
    const sO = gp ? gp.silhouette.outer.s : [];
    const idx = [];
    if (span) for (let i = 0; i < sO.length; i++) if (sO[i] >= span[0] - 1e-6 && sO[i] <= span[1] + 1e-6) idx.push(i);
    if (idx.length > 1) {
      const mWorld = 9 / kz; // margin beyond the pipe, world units (≈9 screen px)
      const topB = [], botB = [];
      for (const i of idx) {
        const t = gp.silhouette.outer.top[i], b = gp.silhouette.outer.bot[i];
        let nx = t[0] - b[0], ny = t[1] - b[1];
        const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl; // outward, toward the 'top' side
        topB.push([t[0] + mWorld * nx, t[1] + mWorld * ny]);
        botB.push([b[0] - mWorld * nx, b[1] - mWorld * ny]);
      }
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = T.highlight;
      poly([...topB, ...botB.reverse()], true);
      ctx.fill();
      ctx.restore();
    }
  }

  // centerline
  ctx.save();
  ctx.setLineDash([6, 4, 2, 4]);
  ctx.strokeStyle = T.center;
  ctx.lineWidth = 1;
  for (const { g: gp } of all) { poly(gp.silhouette.center, false); ctx.stroke(); }
  ctx.restore();

  ctx.font = '500 10px Inter, system-ui, sans-serif';
  ctx.fillStyle = T.label;

  const tick = (x1, y1, x2, y2, label, off) => {
    ctx.save();
    ctx.strokeStyle = T.dim;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const a = 3.2;
    [[x1, y1, 1], [x2, y2, -1]].forEach(([px, py, s]) => {
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
      const ux = (dx / L) * s * 6, uy = (dy / L) * s * 6;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + ux - uy * 0.35 * a / 3, py + uy + ux * 0.35 * a / 3);
      ctx.lineTo(px + ux + uy * 0.35 * a / 3, py + uy - ux * 0.35 * a / 3);
      ctx.closePath();
      ctx.fillStyle = T.dim;
      ctx.fill();
    });
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    ctx.fillStyle = T.label;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const bw = ctx.measureText(label).width + 8;
    ctx.fillStyle = T.bg;
    ctx.fillRect(mx - bw / 2, my - 7 + (off || 0), bw, 14);
    ctx.fillStyle = T.label;
    ctx.fillText(label, mx, my + (off || 0));
    ctx.restore();
  };

  // Is the drawing axis-aligned? Only then can dimensions be measured against a
  // shared horizontal base line. A bend tilts a pipe, but so does its PLACEMENT
  // in the chain - a perfectly straight pipe is still drawn at an angle when the
  // part before it turns - so ask the sections which way they actually run
  // rather than inferring it from the bends.
  const offAxis = all.some(({ g: gp }) => gp.path.bend
    || gp.path.sections.some((sec) => Math.abs(sec.t[1]) > 1e-6));
  // Dimensions belong to a pipe once there is more than one to tell apart.
  const partTag = (pi, t) => (nPipes > 1 ? 'P' + (pi + 1) + '·' + t : t);
  // Straight chains measure against a base line under the drawing. Two pipes
  // laid end to end would stack their ticks on the same line — and largely on
  // the same span — so each pipe gets a row of its own.
  const rowY = (pj) => Y(minY) + 24 + pj * 18;

  // Bore-diameter tick across a section at its own midpoint (constant Ø within a
  // straight section, so the midpoint reads cleanly).
  const boreTick = (sec, label) => {
    const mx = (sec.p0[0] + sec.p1[0]) / 2, my = (sec.p0[1] + sec.p1[1]) / 2;
    const v = [sec.t[1], -sec.t[0]], r = sec.id / 2;
    tick(X(mx + r * v[0]), Y(my + r * v[1]), X(mx - r * v[0]), Y(my - r * v[1]), label);
  };
  // Length tick along a section's own axis, offset outward (toward −v) so it
  // clears the wall. With no bends at all, parts lie on x, so use the base line.
  const lengthTick = (sec, label, base) => {
    // lp0/lp1 span the section body only — a slip joint's extension past the
    // free end isn't part of the section's length. They are points in assembly
    // space, which is what the base line has to be measured against: arclength
    // only doubles as an x coordinate for a lone pipe standing at the origin.
    if (!offAxis) { tick(X(sec.lp0[0]), base, X(sec.lp1[0]), base, label); return; }
    const v = [sec.t[1], -sec.t[0]];
    const off = sec.od / 2 + 6;
    tick(
      X(sec.lp0[0] - v[0] * off), Y(sec.lp0[1] - v[1] * off),
      X(sec.lp1[0] - v[0] * off), Y(sec.lp1[1] - v[1] * off),
      label
    );
  };

  const boxLabel = (x, y, text, color, font) => {
    ctx.save();
    ctx.font = font || '500 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const bw = ctx.measureText(text).width + 8;
    ctx.fillStyle = T.bg;
    ctx.fillRect(x - bw / 2, y - 7, bw, 14);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  };

  for (let pj = 0; pj < all.length; pj++) {
  const { g: gp, i: pi } = all[pj];
  const sArr = gp.silhouette.outer.s;

  // Sections: one length tick + one bore-diameter tick each.
  gp.path.sections.forEach((sec, i) => {
    lengthTick(sec, partTag(pi, 'S' + (i + 1)) + ' ' + nv(sec.l) + uu, rowY(pj));
    boreTick(sec, 'ø' + nv(sec.id));
  });

  // Bends: curved ones trace the inner-face arc (that IS dimension B) with radial
  // lines to their own center and an angle readout; straight ones (0 deg) get a
  // plain length tick. A fixed (non-continuous) middle diameter draws a bore tick
  // at its midpoint.
  gp.path.bends.forEach((bd, i) => {
    const tag = partTag(pi, 'B' + (i + 1));
    if (bd.bend) {
      const c = bd.center;
      const idx = [];
      for (let j = 0; j < sArr.length; j++) if (sArr[j] >= bd.sStart - 1e-6 && sArr[j] <= bd.sEnd + 1e-6) idx.push(j);
      // B runs along the outer surface on the INNER (concave) side of the bend -
      // the silhouette edge nearer the bend center. Which of top/bot that is
      // depends on the turn direction, so choose by distance to the center.
      const midIdx = idx[Math.floor(idx.length / 2)];
      const oTop = gp.silhouette.outer.top, oBot = gp.silhouette.outer.bot;
      const d2c = (q) => (q[0] - c[0]) * (q[0] - c[0]) + (q[1] - c[1]) * (q[1] - c[1]);
      const innerArr = (midIdx !== undefined && d2c(oBot[midIdx]) <= d2c(oTop[midIdx])) ? oBot : oTop;
      const outerArr = innerArr === oBot ? oTop : oBot;
      const face = idx.map((j) => innerArr[j]);
      // Extend to the exact junction planes: stations rarely land exactly on
      // sStart/sEnd, and B runs junction-to-junction — the same measurement the
      // geometry solved the bend radius for, so the label matches the request.
      if (face.length > 1) {
        const lerpPt = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        const j0 = idx[0], j1 = idx[idx.length - 1];
        if (j0 > 0 && sArr[j0] > bd.sStart + 1e-9 && sArr[j0 - 1] < bd.sStart - 1e-9)
          face.unshift(lerpPt(innerArr[j0 - 1], innerArr[j0], (bd.sStart - sArr[j0 - 1]) / (sArr[j0] - sArr[j0 - 1])));
        if (j1 < sArr.length - 1 && sArr[j1] < bd.sEnd - 1e-9 && sArr[j1 + 1] > bd.sEnd + 1e-9)
          face.push(lerpPt(innerArr[j1], innerArr[j1 + 1], (bd.sEnd - sArr[j1]) / (sArr[j1 + 1] - sArr[j1])));
      }
      if (face.length > 1) {
        ctx.save();
        ctx.strokeStyle = T.accent;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        poly(face, false);
        ctx.stroke();
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = T.dim;
        [face[0], face[face.length - 1]].forEach((q) => {
          ctx.beginPath();
          ctx.moveTo(X(c[0]), Y(c[1]));
          ctx.lineTo(X(q[0]), Y(q[1]));
          ctx.stroke();
        });
        ctx.restore();

        const mid = face[Math.floor(face.length / 2)];
        const toC = [X(c[0]) - X(mid[0]), Y(c[1]) - Y(mid[1])];
        const L = Math.hypot(toC[0], toC[1]) || 1;
        // Label the effective B the geometry drew: the requested arc, or the
        // raised floor when the diameters clamped it. The bend's own control and
        // the header note show the same value, so the three readouts agree.
        const bEff = Math.round((bd.faceClamped ? bd.minFace : bd.l2) * 10) / 10;
        boxLabel(X(mid[0]) + (toC[0] / L) * 22, Y(mid[1]) + (toC[1] / L) * 22, tag + ' arc ' + nv(bEff) + uu, T.accent);

        // Angle readout just outside the outer (convex) bend face at its midpoint.
        const outMid = outerArr[midIdx];
        const away = [X(outMid[0]) - X(c[0]), Y(outMid[1]) - Y(c[1])];
        const aL = Math.hypot(away[0], away[1]) || 1;
        boxLabel(X(outMid[0]) + (away[0] / aL) * 15, Y(outMid[1]) + (away[1] / aL) * 15, Math.abs(bd.ang) + '°', T.center, '500 11px Inter, system-ui, sans-serif');
      }
    } else if (bd.arcLen > 1e-6) {
      // Straight transition (0 deg): a length tick along its axis. Label the
      // length actually drawn (rounded to a tenth) — the reducer may have been
      // lengthened past the requested l2 to keep its wall thick, and l2 can be 0.
      const len = Math.round(bd.arcLen * 10) / 10;
      if (!offAxis) tick(X(bd.p0[0]), rowY(pj), X(bd.p1[0]), rowY(pj), tag + ' ' + nv(len) + uu);
      else {
        const v = [bd.t0[1], -bd.t0[0]], off = 10;
        tick(X(bd.p0[0] - v[0] * off), Y(bd.p0[1] - v[1] * off), X(bd.p1[0] - v[0] * off), Y(bd.p1[1] - v[1] * off), tag + ' ' + nv(len) + uu);
      }
    }

    // Fixed middle bore diameter (only when not continuous). A middle Ø beyond
    // both neighbours makes the bore bulge (or pinch) somewhere inside the bend,
    // and that extremum is what the eye reads as "the" middle diameter — it need
    // not land on the arc midpoint, and the drawn crest can fall short of the
    // requested value (the wall envelope rounds it off). So measure: mark the
    // station where the bore actually reaches its extremum and label the span
    // there. A middle Ø that just passes through between the two ends has no
    // extremum of its own — mark the midpoint, as before.
    if (!bd.idmSmooth && bd.arcLen > 0) {
      const iS = gp.silhouette.inner.s, iT = gp.silhouette.inner.top, iB = gp.silhouette.inner.bot;
      const spanAt = (k) => Math.hypot(iT[k][0] - iB[k][0], iT[k][1] - iB[k][1]);
      const inBend = [];
      for (let k = 0; k < iS.length; k++) if (iS[k] >= bd.sStart - 1e-6 && iS[k] <= bd.sEnd + 1e-6) inBend.push(k);
      let mt, mb, dia;
      const ends = inBend.length ? [spanAt(inBend[0]), spanAt(inBend[inBend.length - 1])] : null;
      const dir = ends && bd.idm > Math.max(ends[0], ends[1]) + 1e-6 ? 1
        : ends && bd.idm < Math.min(ends[0], ends[1]) - 1e-6 ? -1 : 0;
      if (dir !== 0) {
        let best = inBend[0];
        for (const k of inBend) if (dir * (spanAt(k) - spanAt(best)) > 0) best = k;
        mt = iT[best]; mb = iB[best]; dia = spanAt(best);
      } else {
        const sMid = (bd.sStart + bd.sEnd) / 2;
        let a = 0;
        while (a < iS.length - 2 && iS[a + 1] < sMid) a++;
        const b = Math.min(a + 1, iS.length - 1);
        const f = Math.max(0, Math.min(1, (sMid - iS[a]) / ((iS[b] - iS[a]) || 1)));
        const lp = (u, wv) => [u[0] + (wv[0] - u[0]) * f, u[1] + (wv[1] - u[1]) * f];
        mt = lp(iT[a], iT[b]); mb = lp(iB[a], iB[b]);
        dia = Math.hypot(mt[0] - mb[0], mt[1] - mb[1]);
      }
      tick(X(mt[0]), Y(mt[1]), X(mb[0]), Y(mb[1]), 'ø' + nv(Math.round(dia * 10) / 10));
    }
  });
  }

  // 'top'/'bot' are the two surfaces, not necessarily the visual top - take the
  // one higher on screen (Y is flipped, so smaller Y is higher). The first pipe
  // owns the chain's left end, so its end face is the one to line up with.
  const oT = g.silhouette.outer.top[0], oB = g.silhouette.outer.bot[0];
  return { leftX: X(minX), leftTopY: Math.min(Y(oT[1]), Y(oB[1])) };
}
