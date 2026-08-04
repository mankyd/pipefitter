// Live cross-section schematic drawn on a 2D canvas from the geometry result.

const T = {
  bg: '#1b1d2b',
  wall: '#b2b6ca',
  fill: '#2b2e3d',
  bore: '#161826',
  highlight: '#5d5294',   // section / bend highlight band
  center: '#796cbf',
  dim: '#75798c',
  label: '#9397ab',
  accent: '#b5abfc',
};

// `highlight` selects the hovered group to band: null, or { kind:'section'|'bend',
// index } (an arclength span is derived from g.path). Returns { leftX, leftTopY }
// — the screen position (CSS px, canvas-relative) of the pipe's left edge and the
// top of its left end, so callers can line an overlay up with the drawing.
export function drawDiagram(canvas, g, highlight, bottomInset, units) {
  if (!canvas || !g) return null;
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

  const pts = [...g.silhouette.outer.top, ...g.silhouette.outer.bot];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const q of pts) {
    if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
    if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1];
  }
  // Fit to the pipe alone. The bend centre is deliberately excluded — at
  // shallow angles it is hundreds of mm away and would shrink the part to a
  // hairline. The B arc and angle mark may run out of frame; that is fine.
  const pad = 44;
  const bi = bottomInset || 0;   // extra reserved space at the bottom (for a floating overlay)
  const sx = (w - pad * 2) / Math.max(1, maxX - minX);
  const sy = (h - pad * 2 - bi) / Math.max(1, maxY - minY);
  const k = Math.min(sx, sy);
  const ox = (w - (maxX - minX) * k) / 2 - minX * k;
  // Centre vertically within [pad, h - pad - bi] (Y is flipped, so Y(maxY) is the top).
  const oy = pad + ((h - 2 * pad - bi) - (maxY - minY) * k) / 2 + maxY * k;
  const X = (x) => ox + x * k;
  const Y = (y) => oy - y * k;

  const poly = (list, close) => {
    ctx.beginPath();
    list.forEach((q, i) => (i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1]))));
    if (close) ctx.closePath();
  };

  // Solid wall body: outer silhouette, bore knocked out, outlines stroked.
  const outerLoop = [...g.silhouette.outer.top, ...[...g.silhouette.outer.bot].reverse()];
  const innerLoop = [...g.silhouette.inner.top, ...[...g.silhouette.inner.bot].reverse()];

  poly(outerLoop, true);
  ctx.fillStyle = T.fill;
  ctx.fill();
  ctx.strokeStyle = T.wall;
  ctx.lineWidth = 1.25;
  ctx.stroke();

  poly(innerLoop, true);
  ctx.fillStyle = T.bore;
  ctx.fill();
  ctx.strokeStyle = T.wall;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Section highlight (hover-driven). `highlight` is { kind, index } naming a
  // section or bend — a translucent band over that segment, expanded a little
  // beyond the pipe — or falsy for no highlight. Building it from the segment's
  // outer silhouette offset along its own outward normal handles straight,
  // tapered, and bent sections uniformly. Drawn over the cross-section so it
  // reads as a highlight; centreline and dimensions stay crisp on top.
  if (highlight) {
    const src = highlight.kind === 'bend' ? g.path.bends[highlight.index] : g.path.sections[highlight.index];
    const span = src ? [src.sStart, src.sEnd] : null;
    const sO = g.silhouette.outer.s;
    const idx = [];
    if (span) for (let i = 0; i < sO.length; i++) if (sO[i] >= span[0] - 1e-6 && sO[i] <= span[1] + 1e-6) idx.push(i);
    if (idx.length > 1) {
      const mWorld = 9 / k; // margin beyond the pipe, world units (≈9 screen px)
      const topB = [], botB = [];
      for (const i of idx) {
        const t = g.silhouette.outer.top[i], b = g.silhouette.outer.bot[i];
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
  poly(g.silhouette.center, false);
  ctx.stroke();
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

  const baseY = Y(minY) + 24;
  const anyBend = g.path.bend;   // any bent segment present → parts run off-axis

  // Bore-diameter tick across a section at its own midpoint (constant Ø within a
  // straight section, so the midpoint reads cleanly).
  const boreTick = (sec, label) => {
    const mx = (sec.p0[0] + sec.p1[0]) / 2, my = (sec.p0[1] + sec.p1[1]) / 2;
    const v = [sec.t[1], -sec.t[0]], r = sec.id / 2;
    tick(X(mx + r * v[0]), Y(my + r * v[1]), X(mx - r * v[0]), Y(my - r * v[1]), label);
  };
  // Length tick along a section's own axis, offset outward (toward −v) so it
  // clears the wall. With no bends at all, parts lie on x, so use the base line.
  const lengthTick = (sec, label) => {
    if (!anyBend) { tick(X(sec.sStart), baseY, X(sec.sEnd), baseY, label); return; }
    const v = [sec.t[1], -sec.t[0]];
    const off = sec.od / 2 + 6;
    tick(
      X(sec.p0[0] - v[0] * off), Y(sec.p0[1] - v[1] * off),
      X(sec.p1[0] - v[0] * off), Y(sec.p1[1] - v[1] * off),
      label
    );
  };

  // Sections: one length tick + one bore-diameter tick each.
  g.path.sections.forEach((sec, i) => {
    lengthTick(sec, 'S' + (i + 1) + ' ' + nv(sec.l) + uu);
    boreTick(sec, 'ø' + nv(sec.id));
  });

  const sArr = g.silhouette.outer.s;
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

  // Bends: curved ones trace the inner-face arc (that IS dimension B) with radial
  // lines to their own centre and an angle readout; straight ones (0 deg) get a
  // plain length tick. A fixed (non-continuous) middle diameter draws a bore tick
  // at its midpoint.
  g.path.bends.forEach((bd, i) => {
    const tag = 'B' + (i + 1);
    if (bd.bend) {
      const c = bd.center;
      const idx = [];
      for (let j = 0; j < sArr.length; j++) if (sArr[j] >= bd.sStart - 1e-6 && sArr[j] <= bd.sEnd + 1e-6) idx.push(j);
      // B runs along the outer surface on the INNER (concave) side of the bend —
      // the silhouette edge nearer the bend centre. Which of top/bot that is
      // depends on the turn direction, so choose by distance to the centre.
      const midIdx = idx[Math.floor(idx.length / 2)];
      const oTop = g.silhouette.outer.top, oBot = g.silhouette.outer.bot;
      const d2c = (q) => (q[0] - c[0]) * (q[0] - c[0]) + (q[1] - c[1]) * (q[1] - c[1]);
      const innerArr = (midIdx !== undefined && d2c(oBot[midIdx]) <= d2c(oTop[midIdx])) ? oBot : oTop;
      const outerArr = innerArr === oBot ? oTop : oBot;
      const face = idx.map((j) => innerArr[j]);
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
        boxLabel(X(mid[0]) + (toC[0] / L) * 22, Y(mid[1]) + (toC[1] / L) * 22, tag + ' arc ' + nv(bd.l2) + uu, T.accent);

        // Angle readout just outside the outer (convex) bend face at its midpoint.
        const outMid = outerArr[midIdx];
        const away = [X(outMid[0]) - X(c[0]), Y(outMid[1]) - Y(c[1])];
        const aL = Math.hypot(away[0], away[1]) || 1;
        boxLabel(X(outMid[0]) + (away[0] / aL) * 15, Y(outMid[1]) + (away[1] / aL) * 15, Math.abs(bd.ang) + '°', T.center, '500 11px Inter, system-ui, sans-serif');
      }
    } else if (bd.l2 > 0) {
      // Straight transition (0 deg): a length tick along its axis.
      if (!anyBend) tick(X(bd.sStart), baseY, X(bd.sEnd), baseY, tag + ' ' + nv(bd.l2) + uu);
      else {
        const v = [bd.t0[1], -bd.t0[0]], off = 10;
        tick(X(bd.p0[0] - v[0] * off), Y(bd.p0[1] - v[1] * off), X(bd.p1[0] - v[0] * off), Y(bd.p1[1] - v[1] * off), tag + ' ' + nv(bd.l2) + uu);
      }
    }

    // Fixed middle bore diameter (only when not continuous), at the bend midpoint.
    if (!bd.idmSmooth && bd.arcLen > 0) {
      const sMid = (bd.sStart + bd.sEnd) / 2;
      const iS = g.silhouette.inner.s, iT = g.silhouette.inner.top, iB = g.silhouette.inner.bot;
      let a = 0;
      while (a < iS.length - 2 && iS[a + 1] < sMid) a++;
      const b = Math.min(a + 1, iS.length - 1);
      const f = Math.max(0, Math.min(1, (sMid - iS[a]) / ((iS[b] - iS[a]) || 1)));
      const lp = (u, wv) => [u[0] + (wv[0] - u[0]) * f, u[1] + (wv[1] - u[1]) * f];
      const mt = lp(iT[a], iT[b]), mb = lp(iB[a], iB[b]);
      tick(X(mt[0]), Y(mt[1]), X(mb[0]), Y(mb[1]), 'ø' + nv(bd.idm));
    }
  });

  // 'top'/'bot' are the two surfaces, not necessarily the visual top — take the
  // one higher on screen (Y is flipped, so smaller Y is higher).
  const oT = g.silhouette.outer.top[0], oB = g.silhouette.outer.bot[0];
  return { leftX: X(minX), leftTopY: Math.min(Y(oT[1]), Y(oB[1])) };
}
