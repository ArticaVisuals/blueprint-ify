/* --------------------------------------------------------- flat views */
/*
 * Orthographic and section views. Every part becomes one or more solids: a section
 * (u, v) swept along an axis, maybe changing at levels along the way. A flat view
 * projects those solids along x, y or z and paints the parts far to near, each part's
 * outline filled with paper so nearer parts hide what lies behind them. A section view
 * also slices the solids the cutting plane passes through and hatches the cut faces.
 */
const AXI = { x: 0, y: 1, z: 2 };
const FLAT = {
  // the viewer sits on the + side of the axis; b runs down the screen
  front: { key: "front", axis: "y", P: (q) => [q[0], -q[2]], face: "front", name: "front view" },
  top: { key: "top", axis: "z", P: (q) => [q[0], q[1]], face: "top", name: "top view" },
  side: { key: "side", axis: "x", P: (q) => [-q[1], -q[2]], face: "side", name: "right side view" },
};
const uvOf = (ring) => ring.map((q) => [q.u, q.v]);
const mm = (v) => String(Math.round(v * 10) / 10);
function W3(s, u, v, w) { const m = MAP[s.axis](u, v, w); return [s.base[0] + m[0], s.base[1] + m[1], s.base[2] + m[2]]; }

/** A part as solids: { axis, base, levels: [{w, pts}], inner?, floor?, feature? } */
function solidsOf(p) {
  const out = [], lv = (pairs) => pairs.map(([w, pts]) => ({ w, pts }));
  if (p.kind === "screw") {
    const d = p.d, L = p.size[2], hh = clamp(d * 0.38, 0.25, L * 0.45), rs = d * 0.27, c = d / 2, len = L - hh;
    const shank = uvOf(shift(circ(rs, 20), c, c)), head = uvOf(shift(circ(d / 2, 28), c, c));
    for (const base of screwBases(p)) out.push({ axis: "z", base, levels: lv([[0, shank], [len, shank]]) }, { axis: "z", base, levels: lv([[len, head], [L, head]]) });
    return out;
  }
  if (p.kind === "flex") {
    const w = p.width, left = offsetLine(p.path, w / 2), right = offsetLine(p.path, -w / 2);
    const outline = left.concat(right.slice().reverse());
    const rad = outline.map((_, i) => (i === 0 || i === left.length - 1 || i === left.length || i === outline.length - 1 ? Math.min(0.6, w * 0.2) : w * 0.45));
    const shape = fillet(outline, rad, 3);
    out.push({ axis: "z", base: [p.origin[0], p.origin[1], p.at[2]], levels: lv([[0, shape], [p.size[2], shape]]) });
    return out;
  }
  const [U, V, L] = section(p.axis, p.size), r = Math.min(p.r, U / 2, V / 2), n = 6;
  if (p.kind === "tray") {
    const w = Math.min(p.wall, U / 3, V / 3);
    const outer = uvOf(rrect(0, 0, U, V, r, n)), inner = uvOf(rrect(w, w, U - w, V - w, Math.max(0.2, r - w), n));
    out.push({ axis: p.axis, base: p.at, levels: lv([[0, outer], [L, outer]]), inner, floor: p.floor ? Math.min(w, L * 0.4) : 0 });
  } else if (p.kind === "cyl") {
    const ring = uvOf(shift(circ(Math.min(U, V) / 2, 48), U / 2, V / 2));
    out.push({ axis: p.axis, base: p.at, levels: lv([[0, ring], [L, ring]]) });
  } else if (p.shape === "plus" && p.axis === "z") {
    const span = Math.min(U, V), pts = plusPts(span / 2, span / 2, span, span * p.arm, Math.max(0.3, Math.min(r, span * 0.08))).map(([a, b]) => [a + (U - span) / 2, b + (V - span) / 2]);
    out.push({ axis: "z", base: p.at, levels: lv([[0, pts], [L, pts]]) });
  } else if (p.outline && p.axis === "z") {
    const pts = outlineShape(p);
    out.push({ axis: "z", base: p.at, levels: lv([[0, pts], [L, pts]]) });
  } else {
    const foot = uvOf(rrect(0, 0, U, V, r, n)), bev = p.axis === "z" ? bevelOf(p) : 0;
    if (p.taper > 0 && p.axis === "z") {
      const t = Math.min(p.taper, U / 2 - 0.4, V / 2 - 0.4);
      out.push({ axis: "z", base: p.at, levels: lv([[0, foot], [L, uvOf(rrect(t, t, U - t, V - t, Math.max(0.2, r - t), n))]]) });
    } else if (bev > 0) {
      out.push({ axis: "z", base: p.at, levels: lv([[0, foot], [L - bev, foot], [L, uvOf(rrect(bev, bev, U - bev, V - bev, Math.max(0.2, r - bev), n))]]) });
    } else out.push({ axis: p.axis, base: p.at, levels: lv([[0, foot], [L, foot]]) });
  }
  // raised features stand on their faces as small solids of their own
  for (const f of p.features) {
    if (!raised(f)) continue;
    const F = faceFrame(p, f.face), [u, v] = f.at, w0 = F.w0 + (f.z || 0);
    let ring, H;
    if (f.t === "boss") {
      const [bw, bh, bH] = f.size, rr = Math.min(f.r == null ? Math.min(bw, bh) * 0.12 : f.r, bw / 2, bh / 2);
      ring = uvOf(rrect(u - bw / 2, v - bh / 2, u + bw / 2, v + bh / 2, rr, 4)); H = bH;
    } else { ring = uvOf(shift(circ(f.d / 2, 32), u, v)); H = f.h; }
    out.push({ axis: F.axis, base: F.base, levels: lv([[w0, ring], [w0 + H, ring]]), feature: true });
  }
  return out;
}
/** A solid's [lo, hi] along world axis k. */
function solidRange(s, k) {
  let lo = 1e9, hi = -1e9;
  for (const l of s.levels) for (const [u, v] of l.pts) { const q = W3(s, u, v, l.w)[k]; if (q < lo) lo = q; if (q > hi) hi = q; }
  return [lo, hi];
}

/** One solid seen flat: its filled outline (with holes for an open frame) and the edges inside it. */
function flatSolid(s, V) {
  const rings = s.levels.map((l) => l.pts.map(([u, v]) => V.P(W3(s, u, v, l.w))));
  const res = { fill: null, holes: [], lines: [] };
  if (s.axis === V.axis) {
    // looking along the sweep: the biggest section is the outline; the near end's section shows inside it
    let bi = 0, ba = -1;
    rings.forEach((r, i) => { const a = Math.abs(signedArea(r)); if (a > ba * 1.001) { ba = a; bi = i; } });
    res.fill = rings[bi];
    const near = rings.length - 1;
    if (near !== bi && Math.abs(Math.abs(signedArea(rings[near])) - ba) > ba * 0.01) res.lines.push({ pts: rings[near], closed: true });
    if (s.inner) {
      const ir = s.inner.map(([u, v]) => V.P(W3(s, u, v, s.levels[near].w)));
      if (s.floor > 0) res.lines.push({ pts: ir, closed: true }); else res.holes.push(ir);
    }
  } else {
    res.fill = hull(rings.flat());
    // a level part-way along (a bevel's shoulder) shows as one edge across
    for (let i = 1; i < rings.length - 1; i++) {
      const b = bbox(rings[i]), r = rings[i];
      const [a, c] = b.w >= b.h ? [r.reduce((m, q) => (q[0] < m[0] ? q : m)), r.reduce((m, q) => (q[0] > m[0] ? q : m))] : [r.reduce((m, q) => (q[1] < m[1] ? q : m)), r.reduce((m, q) => (q[1] > m[1] ? q : m))];
      res.lines.push({ pts: [a, c], closed: false });
    }
  }
  return res;
}

/** The face features of a part drawn flat on the view that looks at that face. */
function featureFlat(p, f, V, lines, dots) {
  const F = faceFrame(p, f.face), up = f.t === "ring" && f.h > 0 ? f.h : 0, w = F.w0 + (f.z || 0) + up;
  const fr = { axis: F.axis, base: F.base };
  const at = (u, v) => V.P(W3(fr, u, v, w));
  const ring = (pts) => lines.push({ pts: pts.map(([u, v]) => at(u, v)), closed: true });
  const [u, v] = f.at;
  const circle = (R) => ring(uvOf(shift(circ(R, clamp(Math.round(R * 10), 20, 72)), u, v)));
  switch (f.t) {
    case "hole": circle(f.d / 2); break;
    case "ring": if (!up) circle(f.d / 2); if (f.d2 > 0.1) circle(f.d2 / 2); break;
    case "slot": { const [sw, sh] = f.size, r = f.r == null ? Math.min(sw, sh) * 0.3 : Math.min(f.r, sw / 2, sh / 2); ring(uvOf(rrect(u - sw / 2, v - sh / 2, u + sw / 2, v + sh / 2, r, 6))); break; }
    case "cross": { const [span, arm] = f.size; ring(plusPts(u, v, span, arm, Math.max(0.2, arm * 0.15))); break; }
    case "inset": {
      const by = f.by + (F.inTop || 0), r = Math.max(0.2, (F.r || 1) - by);
      if (F.U - 2 * by > 0.5 && F.V - 2 * by > 0.5) ring(F.outline ? outlineShape(F.outline, by) : uvOf(rrect(by, by, F.U - by, F.V - by, r, 6)));
      break;
    }
    case "line": lines.push({ pts: [at(u, v), at(f.to[0], f.to[1])], closed: false }); break;
    case "grille": {
      const [gw, gh] = f.size; let pitch = f.pitch;
      while ((gw / pitch + 1) * (gh / pitch + 1) > 500) pitch *= 1.25;
      for (let a = -gw / 2 + pitch / 2; a <= gw / 2 - pitch / 2 + 1e-6; a += pitch)
        for (let b = -gh / 2 + pitch / 2; b <= gh / 2 - pitch / 2 + 1e-6; b += pitch) dots.push({ c: at(u + a, v + b), pitch });
      break;
    }
  }
}

/** A part flat, as paint operations in order: body, its face markings, raised features, their tops. */
function flatPart(p, solids, V, keep = () => true, faceMarks = true) {
  const ops = [];
  for (const s of solids) if (!s.feature && keep(s)) ops.push({ shape: flatSolid(s, V) });
  if (faceMarks) {
    const lines = [], dots = [];
    for (const f of p.features) if (f.face === V.face && !raised(f)) featureFlat(p, f, V, lines, dots);
    ops.push({ lines, dots });
  }
  for (const s of solids) if (s.feature && keep(s)) ops.push({ shape: flatSolid(s, V) });
  if (faceMarks) {
    const lines = [];
    for (const f of p.features) if (f.face === V.face && f.t === "ring" && f.h > 0) featureFlat(p, f, V, lines, []);
    ops.push({ lines, dots: [] });
  }
  return ops;
}
/** Paint order in a flat view: by the part's nearest face, so nearer parts cover farther ones. */
function flatKey(p, V) {
  const k = AXI[V.axis], hi = p.at[k] + p.size[k];
  // looking into an open shell: what it holds paints over its floor
  if (p.kind === "tray" && V.axis === p.axis) return p.at[k] + (p.floor ? Math.min(p.wall, p.size[k] * 0.4) : 0);
  return hi;
}
function flatView(name) {
  const V = FLAT[name], parts = state.spec.parts;
  const list = parts.map((p, i) => ({ i, key: flatKey(p, V), lo: p.at[AXI[V.axis]], ops: flatPart(p, state.solids[i], V) }));
  list.sort((a, b) => a.key - b.key || a.lo - b.lo || a.i - b.i);
  const pts = [];
  for (const e of list) for (const o of e.ops) if (o.shape) for (const q of o.shape.fill) pts.push(q);
  return { V, list, bb: bbox(pts) };
}

/* -------- painting flat geometry */

function emitOps(g, ops, T, S) {
  for (const o of ops) {
    if (o.shape) {
      const sh = o.shape;
      el("path", { d: poly(sh.fill.map(T)) + sh.holes.map((h) => poly(h.map(T))).join(""), class: sh.holes.length ? "sil eo" : "sil" }, g);
      for (const ln of sh.lines) el("path", { d: ln.closed ? poly(ln.pts.map(T)) : open(ln.pts.map(T)), class: "nf" }, g);
    } else {
      if (o.lines.length) el("path", { d: o.lines.map((ln) => (ln.closed ? poly(ln.pts.map(T)) : open(ln.pts.map(T)))).join(""), class: "nf" }, g);
      if (o.dots.length) {
        let d = "";
        for (const { c, pitch } of o.dots) {
          const q = T(c), rr = clamp(pitch * S * 0.2, 0.45, 1.4);
          d += `M${r2(q[0] - rr)} ${r2(q[1])}a${rr} ${rr} 0 1 0 ${r2(2 * rr)} 0a${rr} ${rr} 0 1 0 ${r2(-2 * rr)} 0`;
        }
        el("path", { d, class: "dot" }, g);
      }
    }
  }
}
function drawFlatView(parent, view, S, vx, vy) {
  const ox = vx - view.bb.x0 * S, oy = vy - view.bb.y0 * S, T = ([a, b]) => [ox + a * S, oy + b * S];
  const vg = el("g", { class: "fview" }, parent);
  for (const e of view.list) emitOps(el("g", { class: "part", "data-i": e.i }, vg), e.ops, T, S);
  return { T, ox, oy, box: [vx, vy, vx + view.bb.w * S, vy + view.bb.h * S] };
}

/** Parallel hatching inside a polygon, as one path: angle in radians, spacing in px. */
function hatch(pg, ang, sp, phase) {
  const c = Math.cos(ang), s = Math.sin(ang);
  let lo = 1e9, hi = -1e9;
  for (const p of pg) { const t = -s * p[0] + c * p[1]; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  let d = "";
  for (let t = Math.ceil((lo - phase) / sp) * sp + phase; t <= hi; t += sp) {
    const xs = [];
    for (let i = 0; i < pg.length; i++) {
      const a = pg[i], b = pg[(i + 1) % pg.length], da = -s * a[0] + c * a[1] - t, db = -s * b[0] + c * b[1] - t;
      if (da * db < 0) { const u = da / (da - db), q = [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]; xs.push(c * q[0] + s * q[1]); }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const P = (x) => [-s * t + c * x, c * t + s * x], A = P(xs[k]), B = P(xs[k + 1]);
      d += `M${r2(A[0])} ${r2(A[1])}L${r2(B[0])} ${r2(B[1])}`;
    }
  }
  return d;
}
/** Where a line u = k (ax 0) or v = k (ax 1) crosses a polygon: intervals along the other coordinate. */
function intervals(pts, ax, k) {
  const o = 1 - ax, kk = k + 1e-7, xs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if ((a[ax] - kk) * (b[ax] - kk) < 0) xs.push(a[o] + ((kk - a[ax]) / (b[ax] - a[ax])) * (b[o] - a[o]));
  }
  xs.sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) out.push([xs[i], xs[i + 1]]);
  return out;
}
/** The faces a cutting plane (world axis ci = c) leaves on a solid, in view coordinates. */
function cutSolid(s, ci, c, V) {
  const out = [], ai = AXI[s.axis], L0 = s.levels[0].w, L1 = s.levels[s.levels.length - 1].w;
  if (ai === ci) {
    // the plane runs across the sweep: the cut face is the section itself
    const w = c - s.base[ci];
    if (w <= L0 || w >= L1) return out;
    let l = s.levels[0];
    for (const q of s.levels) if (q.w <= w) l = q;
    const ring = l.pts.map(([u, v]) => V.P(W3(s, u, v, w)));
    if (s.inner && w > L0 + s.floor) {
      // past an open shell's floor the cut is a frame: the outline with the opening taken out, joined by a seam
      const hole = s.inner.map(([u, v]) => V.P(W3(s, u, v, w))).reverse();
      let j = 0, d = Infinity;
      hole.forEach((q, k) => { const e = Math.hypot(q[0] - ring[0][0], q[1] - ring[0][1]); if (e < d) { d = e; j = k; } });
      const h = hole.slice(j).concat(hole.slice(0, j));
      out.push(ring.concat([ring[0]], h, [h[0]]));
    } else out.push(ring);
    return out;
  }
  // the plane runs along the sweep: it meets each level's section on one line
  const useU = MAP[s.axis](1, 0, 0)[ci] === 1, k = c - s.base[ci];
  const cut = (pts) => intervals(pts, useU ? 0 : 1, k);
  const toV = (t, w) => V.P(W3(s, useU ? k : t, useU ? t : k, w));
  const rect = (a, b, w0, w1) => [toV(a, w0), toV(b, w0), toV(b, w1), toV(a, w1)];
  if (s.inner) {
    const O = cut(s.levels[0].pts), I = cut(s.inner);
    if (!O.length) return out;
    const [o0, o1] = O[0];
    if (!I.length) out.push(rect(o0, o1, L0, L1));
    else {
      const [i0, i1] = I[0], f = L0 + s.floor;
      if (s.floor > 0) out.push([toV(o0, L0), toV(o1, L0), toV(o1, L1), toV(i1, L1), toV(i1, f), toV(i0, f), toV(i0, L1), toV(o0, L1)]);
      else { out.push(rect(o0, i0, L0, L1)); out.push(rect(i1, o1, L0, L1)); }
    }
    return out;
  }
  const lv = s.levels.map((l) => ({ w: l.w, iv: cut(l.pts) })), n = lv[0].iv.length;
  if (n && lv.every((l) => l.iv.length === n)) {
    for (let j = 0; j < n; j++) out.push(lv.map((l) => toV(l.iv[j][0], l.w)).concat(lv.map((l) => toV(l.iv[j][1], l.w)).reverse()));
  } else {
    const wide = lv.reduce((a, b) => (b.iv.length > a.iv.length ? b : a));
    for (const [a, b] of wide.iv) out.push(rect(a, b, L0, L1));
  }
  return out;
}

/* -------- annotation: dimensions, labels, the projection symbol, the cutting plane */

/** A dimension between screen points a and b, set off along unit n, with its value. */
function dimLine(g, a, b, n, label, off = 16) {
  const A = [a[0] + n[0] * off, a[1] + n[1] * off], B = [b[0] + n[0] * off, b[1] + n[1] * off];
  const ext = (p) => `M${r2(p[0] + n[0] * 3)} ${r2(p[1] + n[1] * 3)}L${r2(p[0] + n[0] * (off + 4))} ${r2(p[1] + n[1] * (off + 4))}`;
  el("path", { d: ext(a) + ext(b) + `M${r2(A[0])} ${r2(A[1])}L${r2(B[0])} ${r2(B[1])}`, class: "nf dimln" }, g);
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (L < 1) return;
  const ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L, h = 5, w = 1.6;
  const arrow = (P, sx, sy) => `M${r2(P[0])} ${r2(P[1])}L${r2(P[0] + sx * h - sy * w)} ${r2(P[1] + sy * h + sx * w)}L${r2(P[0] + sx * h + sy * w)} ${r2(P[1] + sy * h - sx * w)}Z`;
  // a short dimension takes its arrows outside, pointing in, as drafting does
  const inside = L >= 22;
  if (!inside) el("path", { d: `M${r2(A[0] - ux * 10)} ${r2(A[1] - uy * 10)}L${r2(A[0])} ${r2(A[1])}M${r2(B[0])} ${r2(B[1])}L${r2(B[0] + ux * 10)} ${r2(B[1] + uy * 10)}`, class: "nf dimln" }, g);
  el("path", { d: inside ? arrow(A, ux, uy) + arrow(B, -ux, -uy) : arrow(A, -ux, -uy) + arrow(B, ux, uy), class: "arrow" }, g);
  let ang = (Math.atan2(uy, ux) * 180) / Math.PI;
  if (ang >= 90) ang -= 180; if (ang < -90) ang += 180;
  const M = [(A[0] + B[0]) / 2 + n[0] * 8, (A[1] + B[1]) / 2 + n[1] * 8];
  const t = el("text", { x: r2(M[0]), y: r2(M[1]), "text-anchor": "middle", "dominant-baseline": "middle", "font-size": 10, class: "dimtx", transform: `rotate(${r2(ang)} ${r2(M[0])} ${r2(M[1])})` }, g);
  t.textContent = label;
}
function label(g, x, y, s, anchor = "start", cls = "vlabel") {
  const t = el("text", { x: r2(x), y: r2(y), "font-size": 10, "text-anchor": anchor, class: cls }, g);
  t.textContent = s;
  return t;
}
/** The ISO projection symbol: a truncated cone, small end left, as a side view and an end view. */
function projSymbol(g, cx, cy, third) {
  const r1 = 5, r2v = 9, len = 18, gap = 9, total = 2 * r2v + gap + len, x0 = cx - total / 2;
  const tx = third ? x0 + 2 * r2v + gap : x0, ccx = third ? x0 + r2v : x0 + len + gap + r2v;
  el("path", { d: `M${r2(tx)} ${r2(cy - r1)}L${r2(tx + len)} ${r2(cy - r2v)}L${r2(tx + len)} ${r2(cy + r2v)}L${r2(tx)} ${r2(cy + r1)}Z`, class: "nf sym" }, g);
  const circ2 = (R) => `M${r2(ccx - R)} ${r2(cy)}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0`;
  el("path", { d: circ2(r2v) + circ2(r1), class: "nf sym" }, g);
  el("path", { d: `M${r2(x0 - 4)} ${r2(cy)}H${r2(x0 + total + 4)}M${r2(ccx)} ${r2(cy - r2v - 4)}V${r2(cy + r2v + 4)}`, class: "nf cl" }, g);
  label(g, cx, cy + r2v + 16, third ? "third angle projection · us/ansi" : "first angle projection · iso", "middle");
}

/* -------- the two flat layouts */

const FPAD = 64, FGAP = 72;
function flatFrame(rowsMm, colsMm, gapsX, gapsY, extra = 0) {
  // one scale for the sheet: as large as fits the column, the height kept within the frame's bounds
  let S = (W - 2 * FPAD - gapsX * FGAP) / colsMm;
  const need = (s) => BAR + 2 * PADY + 22 + gapsY * FGAP + rowsMm * s + extra;
  if (need(S) > 900) S = (900 - BAR - 2 * PADY - 22 - gapsY * FGAP - extra) / rowsMm;
  return { S, H: Math.round(clamp(need(S), 560, 900)) };
}
function layoutOrtho(fg) {
  const third = state.proj !== "first", spec = state.spec;
  const F = flatView("front"), T = flatView("top"), R = flatView("side");
  const wF = F.bb.w, hF = F.bb.h, wS = R.bb.w, hT = T.bb.h;
  const { S, H } = flatFrame(hT + hF, wF + wS, 1, 1, 20);
  setFrame(H, `orthographic, ${third ? "third angle" : "first angle"}: ${spec.object}`);
  const bw = (wF + wS) * S + FGAP, bh = (hT + hF) * S + FGAP;
  const x0 = (W - bw) / 2, y0 = BAR + PADY + 14 + Math.max(0, (H - BAR - 2 * PADY - 14 - 20 - bh) / 2);
  const pos = third
    ? { top: [x0, y0], front: [x0, y0 + hT * S + FGAP], side: [x0 + wF * S + FGAP, y0 + hT * S + FGAP], q: [x0 + wF * S + FGAP, y0, wS * S, hT * S] }
    : { front: [x0 + wS * S + FGAP, y0], side: [x0, y0], top: [x0 + wS * S + FGAP, y0 + hF * S + FGAP], q: [x0, y0 + hF * S + FGAP, wS * S, hT * S] };
  const views = { front: drawFlatView(fg, F, S, ...pos.front), top: drawFlatView(fg, T, S, ...pos.top), side: drawFlatView(fg, R, S, ...pos.side) };
  const an = el("g", { class: "anno lab" }, fg);
  for (const [k, v] of Object.entries(views)) label(an, v.box[0], v.box[1] - 9, FLAT[k].name);
  const fb = views.front.box, sb = views.side.box;
  dimLine(an, [fb[0], fb[3]], [fb[2], fb[3]], [0, 1], mm(wF));
  dimLine(an, third ? [fb[0], fb[3]] : [fb[2], fb[3]], third ? [fb[0], fb[1]] : [fb[2], fb[1]], [third ? -1 : 1, 0], mm(hF));
  dimLine(an, [sb[0], sb[3]], [sb[2], sb[3]], [0, 1], mm(wS));
  const [qx, qy, qw, qh] = pos.q;
  if (qw >= 120 && qh >= 56) projSymbol(an, qx + qw / 2, qy + qh / 2 - 6, third);
  state.flatS = S;
}
function layoutSection(fg) {
  const spec = state.spec, ax = state.cut.axis, ci = AXI[ax];
  const T = flatView("top"), E = flatView(ax === "y" ? "front" : "side");
  let lo = 1e9, hi = -1e9;
  for (const p of spec.parts) { lo = Math.min(lo, p.at[ci]); hi = Math.max(hi, p.at[ci] + p.size[ci]); }
  const across = ax === "y"; // plan above the section, or beside it
  const { S, H } = across
    ? flatFrame(T.bb.h + E.bb.h, Math.max(T.bb.w, E.bb.w), 0, 1, 26)
    : flatFrame(Math.max(T.bb.h, E.bb.h), T.bb.w + E.bb.w, 1, 0, 26);
  setFrame(H, `section A-A, ${across ? "seen from the front" : "seen from the right"}: ${spec.object}`);
  const top = BAR + PADY + 14;
  let planAt, secAt;
  if (across) {
    const bw = Math.max(T.bb.w, E.bb.w) * S, x0 = (W - bw) / 2, bh = (T.bb.h + E.bb.h) * S + FGAP;
    const y0 = top + Math.max(0, (H - top - PADY - 26 - bh) / 2);
    planAt = [x0 + (T.bb.x0 - Math.min(T.bb.x0, E.bb.x0)) * S, y0];
    secAt = [x0 + (E.bb.x0 - Math.min(T.bb.x0, E.bb.x0)) * S, y0 + T.bb.h * S + FGAP];
  } else {
    const bw = (T.bb.w + E.bb.w) * S + FGAP, x0 = (W - bw) / 2, bh = Math.max(T.bb.h, E.bb.h) * S;
    const y0 = top + Math.max(0, (H - top - PADY - 26 - bh) / 2);
    planAt = [x0, y0 + (bh - T.bb.h * S) / 2];
    secAt = [x0 + T.bb.w * S + FGAP, y0 + (bh - E.bb.h * S) / 2];
  }
  const plan = drawFlatView(fg, T, S, ...planAt);
  const secG = el("g", {}, fg), cplG = el("g", { class: "anno" }, fg), an = el("g", { class: "anno lab" }, fg);
  label(an, plan.box[0], plan.box[1] - 9, "top view");
  const sox = secAt[0] - E.bb.x0 * S, soy = secAt[1] - E.bb.y0 * S;
  const secBox = [secAt[0], secAt[1], secAt[0] + E.bb.w * S, secAt[1] + E.bb.h * S];
  const title = label(an, secBox[0], secBox[3] + 22, "");
  // the grip stays put while the plane moves, so a drag keeps its pointer
  const hit = el("path", { class: `cpl-hit ${ax === "y" ? "ns" : "ew"}` }, el("g", { class: "anno" }, fg));
  hit.addEventListener("pointerdown", startCutDrag);
  state.sec = { ax, ci, lo, hi, S, plan, T, E, secG, cplG, title, sox, soy, secBox, hit };
  drawSection();
  state.flatS = S;
}
/** The section and its cutting plane line, at the plane's current place; redrawn as the plane moves. */
function drawSection() {
  const sc = state.sec, spec = state.spec;
  if (!sc) return;
  const { ax, ci, lo, hi, S, plan, T, secG, cplG } = sc, V = FLAT[ax === "y" ? "front" : "side"];
  const c = lo + (hi - lo) * clamp(state.cut.t, 0.005, 0.995);
  secG.replaceChildren(); cplG.replaceChildren();
  const Tv = ([a, b]) => [sc.sox + a * S, sc.soy + b * S];
  // what stands behind the plane, far to near; parts the plane passes through lose their cut-away face
  const behind = [], cuts = [];
  spec.parts.forEach((p, i) => {
    const pl = p.at[ci], ph = p.at[ci] + p.size[ci];
    if (pl >= c) return;
    const through = ph > c;
    const keep = (s) => solidRange(s, ci)[0] < c;
    behind.push({ i, key: Math.min(flatKey(p, V), c), lo: pl, ops: flatPart(p, state.solids[i], V, keep, !through) });
    if (through) {
      const polys = [];
      for (const s of state.solids[i]) if (keep(s)) for (const pg of cutSolid(s, ci, c, V)) polys.push(pg);
      if (polys.length) cuts.push({ i, polys });
    }
  });
  behind.sort((a, b) => a.key - b.key || a.lo - b.lo || a.i - b.i);
  for (const e of behind) emitOps(el("g", { class: "part", "data-i": e.i }, secG), e.ops, Tv, S);
  // the cut faces lie in the plane, nearest of all: hatched, one direction and spacing per part
  for (const { i, polys } of cuts) {
    const g = el("g", { class: "part", "data-i": i }, secG), ang = ((i % 2 ? 135 : 45) * Math.PI) / 180, sp = [3.6, 4.6, 3][i % 3];
    for (const pg of polys) {
      const q = pg.map(Tv), b = bbox(q);
      if (Math.min(b.w, b.h) < 2.6) { el("path", { d: poly(q), class: "sil cutfill" }, g); continue; }
      el("path", { d: poly(q), class: "sil cut" }, g);
      el("path", { d: hatch(q, ang, sp, (i * 1.7) % sp), class: "nf hatch" }, g);
    }
  }
  // the cutting plane line across the top view, arrows toward the direction of sight
  const bx = plan.box, ext = 20;
  let A, B, dir;
  if (ax === "y") { const y = plan.T([0, c])[1]; A = [bx[0] - ext, y]; B = [bx[2] + ext, y]; dir = [0, -1]; }
  else { const x = plan.T([c, 0])[0]; A = [x, bx[1] - ext]; B = [x, bx[3] + ext]; dir = [-1, 0]; }
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]), u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
  el("path", { d: `M${r2(A[0])} ${r2(A[1])}L${r2(B[0])} ${r2(B[1])}`, class: "nf cpl" }, cplG);
  const end = (P, s) => `M${r2(P[0])} ${r2(P[1])}L${r2(P[0] + s * u[0] * 10)} ${r2(P[1] + s * u[1] * 10)}`;
  el("path", { d: end(A, 1) + end(B, -1), class: "nf cpl-end" }, cplG);
  for (const P of [A, B]) {
    const tip = [P[0] + dir[0] * 16, P[1] + dir[1] * 16];
    el("path", { d: `M${r2(P[0])} ${r2(P[1])}L${r2(tip[0])} ${r2(tip[1])}`, class: "nf dimln" }, cplG);
    const h = 5, w = 1.8;
    el("path", { d: `M${r2(tip[0])} ${r2(tip[1])}L${r2(tip[0] - dir[0] * h - dir[1] * w)} ${r2(tip[1] - dir[1] * h + dir[0] * w)}L${r2(tip[0] - dir[0] * h + dir[1] * w)} ${r2(tip[1] - dir[1] * h - dir[0] * w)}Z`, class: "arrow" }, cplG);
    const lp = [tip[0] + dir[0] * 8 + (ax === "y" ? 0 : 0), tip[1] + dir[1] * 8];
    const t = el("text", { x: r2(lp[0]), y: r2(lp[1]), "font-size": 11, "text-anchor": "middle", "dominant-baseline": "middle", class: "dimtx" }, cplG);
    t.textContent = "A";
  }
  sc.hit.setAttribute("d", `M${r2(A[0])} ${r2(A[1])}L${r2(B[0])} ${r2(B[1])}`);
  sc.title.textContent = `section A-A, plane ${mm(c - lo)} mm from the ${ax === "y" ? "back" : "left"}`;
  $("cutPos").value = String(Math.round(state.cut.t * 100));
}
function startCutDrag(e) {
  const sc = state.sec;
  if (!sc) return;
  e.preventDefault(); e.stopPropagation();
  const hit = e.currentTarget;
  hit.setPointerCapture(e.pointerId);
  let raf = 0;
  const move = (ev) => {
    const p = toStage(ev); if (!p) return;
    const v = sc.ax === "y" ? (p[1] - sc.plan.oy) / sc.S : (p[0] - sc.plan.ox) / sc.S;
    state.cut.t = clamp((v - sc.lo) / (sc.hi - sc.lo), 0, 1);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawSection(); saveViewCfg(); });
  };
  const up = () => { hit.removeEventListener("pointermove", move); hit.removeEventListener("pointerup", up); hit.removeEventListener("pointercancel", up); };
  hit.addEventListener("pointermove", move); hit.addEventListener("pointerup", up); hit.addEventListener("pointercancel", up);
}

/* -------- switching views */

function renderFlat() {
  if (state.flatG) state.flatG.remove();
  state.solids = state.spec.parts.map(solidsOf);
  state.sec = null;
  const fg = el("g", { class: "flat" }, svg);
  state.flatG = fg;
  if (state.view === "ortho") layoutOrtho(fg); else layoutSection(fg);
  if (state.act) highlightFlat(state.act);
}
function setFrame(H, title) {
  state.H = H;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  setA(state.paperEl, "height", String(H));
  setA(state.gridEl, "height", String(H - BAR));
  setA(state.ruleEl, "height", String(H - 0.5));
  state.titleEl.textContent = title;
}
function applyView() {
  if (!state.spec || !state.layerG) return;
  const flat = state.view !== "iso";
  state.layerG.style.display = flat ? "none" : "";
  state.calloutG.style.display = flat ? "none" : "";
  if (flat) renderFlat();
  else {
    if (state.flatG) { state.flatG.remove(); state.flatG = null; }
    state.sec = null;
    setFrame(state.isoH, `exploded view: ${state.spec.object}`);
  }
  paintViewUI();
  const n = state.spec.parts.length;
  svg.setAttribute("aria-label", state.view === "iso" ? `${state.spec.object}: exploded drawing of ${n} parts.`
    : state.view === "ortho" ? `${state.spec.object}: front, top and right side views, ${state.proj === "first" ? "first" : "third"} angle projection.`
    : `${state.spec.object}: section A-A with the top view and its cutting plane.`);
}
function highlightFlat(a) {
  if (!state.flatG) return;
  for (const g of state.flatG.querySelectorAll("[data-i]")) {
    const on = !!a && a.i === +g.dataset.i;
    g.classList.toggle("dim", !!a && !on);
    g.classList.toggle("hot", on);
  }
}
function saveViewCfg() { store.set("bp.viewcfg", { view: state.view, proj: state.proj, axis: state.cut.axis, t: Math.round(state.cut.t * 1000) / 1000 }); }
function paintViewUI() {
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
  for (const b of document.querySelectorAll("[data-proj]")) b.setAttribute("aria-pressed", String(b.dataset.proj === state.proj));
  for (const b of document.querySelectorAll("[data-cut]")) b.setAttribute("aria-pressed", String(b.dataset.cut === state.cut.axis));
  $("orthoOpts").hidden = state.view !== "ortho";
  $("sectionOpts").hidden = state.view !== "section";
  const flat = state.view !== "iso";
  slider.disabled = flat; playBtn.disabled = flat;
  $("explodeTg").dataset.off = flat ? "1" : "";
  $("explodeTg").title = flat ? "Explode works in the isometric view" : "";
  if (flat && play.on) stopPlay();
}
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => { if (state.view === b.dataset.view) return; state.view = b.dataset.view; saveViewCfg(); setActive(null); applyView(); board.wake(); });
for (const b of document.querySelectorAll("[data-proj]")) b.addEventListener("click", () => { state.proj = b.dataset.proj; saveViewCfg(); applyView(); });
for (const b of document.querySelectorAll("[data-cut]")) b.addEventListener("click", () => { state.cut.axis = b.dataset.cut; saveViewCfg(); applyView(); });
$("cutPos").addEventListener("input", () => { state.cut.t = $("cutPos").value / 100; saveViewCfg(); if (state.view === "section") drawSection(); });
{
  const cfg = store.get("bp.viewcfg", null);
  if (cfg) {
    if (["iso", "ortho", "section"].includes(cfg.view)) state.view = cfg.view;
    if (cfg.proj === "first") state.proj = "first";
    if (cfg.axis === "x") state.cut.axis = "x";
    if (Number.isFinite(cfg.t)) state.cut.t = clamp(cfg.t, 0, 1);
  }
}

/* -------- detail: one part, alone, larger, with its overall dimensions */

const detailEl = $("detail");
let detailFor = null;
function openDetail(it, ev, anchor) {
  detailFor = it;
  drawDetail(it);
  const wasHidden = detailEl.hidden;
  detailEl.hidden = false;
  if (wasHidden || ev || anchor) placeDetail(ev, anchor);
}
function closeDetail() { detailEl.hidden = true; detailFor = null; }
function drawDetail(it) {
  const p = it.p, ds = $("detailSvg"), DW = 400, DH = 270;
  ds.replaceChildren();
  ds.setAttribute("viewBox", `0 0 ${DW} ${DH}`);
  el("style", {}, ds).textContent = STAGE_CSS.replaceAll("#stage", "#detailSvg") + FLAT_CSS.replaceAll("#stage", "#detailSvg");
  el("rect", { x: 0, y: 0, width: DW, height: DH, class: "paper" }, ds);
  const oc = p.at.map((v, k) => v + p.size[k] / 2);
  const b1 = bbox(buildPart(p, 1, oc).pts);
  const Sd = Math.min((DW - 130) / Math.max(b1.w, 1e-3), (DH - 96) / Math.max(b1.h, 1e-3));
  const g = buildPart(p, Sd, oc), b = bbox(g.pts);
  const tx = DW / 2 - (b.x0 + b.x1) / 2, ty = DH / 2 - (b.y0 + b.y1) / 2 - 4;
  const pg = el("g", { class: "part", transform: `translate(${r2(tx)} ${r2(ty)})` }, ds);
  for (const [d, cls] of g.ops) el("path", { d, class: cls }, pg);
  // overall dimensions along the three edges nearest the viewer
  const P = projector(Sd, oc), Q = (x, y, z) => { const s = P(x, y, z); return [s[0] + tx, s[1] + ty]; };
  const [x0, y0, z0] = p.at, [x1, y1, z1] = p.at.map((v, k) => v + p.size[k]);
  const unit = (a, b2) => { const dx = b2[0] - a[0], dy = b2[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  const an = el("g", { class: "anno lab" }, ds);
  dimLine(an, Q(x0, y1, z0), Q(x1, y1, z0), unit(Q(x0, y1, z0), Q(x0, y1 + 1, z0)), mm(p.size[0]), 14);
  dimLine(an, Q(x1, y0, z0), Q(x1, y1, z0), unit(Q(x1, y0, z0), Q(x1 + 1, y0, z0)), mm(p.size[1]), 14);
  dimLine(an, Q(x0, y1, z0), Q(x0, y1, z1), [-1, 0], mm(p.size[2]), 14);
  const main = state.view === "iso" ? state.Sa : state.flatS || state.Sa, k = Sd / main;
  const ratio = k >= 1 ? `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}:1` : `1:${Math.round((1 / k) * 10) / 10}`;
  $("detailTitle").textContent = `detail ${pad2(it.num)}: ${p.name}`;
  $("detailMeta").textContent = [`${mm(p.size[0])} × ${mm(p.size[1])} × ${mm(p.size[2])} mm`, `qty ${p.qty}`, p.pn ? `part no. ${p.pn}` : "", `scale ${ratio}`].filter(Boolean).join(" · ");
  ds.setAttribute("aria-label", `${p.name}, drawn alone: ${mm(p.size[0])} by ${mm(p.size[1])} by ${mm(p.size[2])} millimetres.`);
}
function placeDetail(ev, anchor) {
  const r = detailEl.getBoundingClientRect(), vw = document.documentElement.clientWidth, sx = window.scrollX, sy = window.scrollY;
  let x, y;
  if (ev && ev.pageX != null) {
    x = ev.pageX + 20; y = ev.pageY - 40;
    if (x + r.width > sx + vw - 8) x = ev.pageX - r.width - 20;
  } else if (anchor) {
    const a = anchor.getBoundingClientRect();
    x = a.left + sx + Math.min(40, a.width / 3); y = a.top + sy - r.height - 10;
    if (y < sy + 8) y = a.bottom + sy + 10;
  } else { x = sx + (vw - r.width) / 2; y = sy + 80; }
  x = clamp(x, sx + 8, Math.max(sx + 8, sx + vw - r.width - 8)); y = Math.max(sy + 8, y);
  detailEl.style.left = Math.round(x) + "px"; detailEl.style.top = Math.round(y) + "px";
}
$("detailClose").addEventListener("click", closeDetail);
{
  const head = $("detailHead");
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, l0 = parseFloat(detailEl.style.left) || 0, t0 = parseFloat(detailEl.style.top) || 0;
    const move = (ev) => { detailEl.style.left = Math.round(l0 + ev.clientX - x0) + "px"; detailEl.style.top = Math.round(Math.max(0, t0 + ev.clientY - y0)) + "px"; };
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); head.removeEventListener("pointercancel", up); };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up); head.addEventListener("pointercancel", up);
  });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !detailEl.hidden && $("saveSheet").hidden) closeDetail(); });

/* flat views answer the pointer through their part groups; any view opens a part's detail on click */
svg.addEventListener("pointerover", (e) => {
  if (state.view === "iso") return;
  const g = e.target.closest && e.target.closest("[data-i]");
  setActive(g ? state.items[+g.dataset.i] : null);
});
svg.addEventListener("click", (e) => {
  let it = null;
  if (state.view === "iso") { const p = toStage(e); if (p) it = pick(p); }
  else { const g = e.target.closest && e.target.closest("[data-i]"); if (g) it = state.items[+g.dataset.i]; }
  if (it) openDetail(it, e);
});
