"use strict";
/*
 * Blueprint-ify: a product, assembled, then taken apart.
 *
 * Geometry runs on the Hairline kernel (HL, github.com/lucasmarkes/hairline): the same
 * 2:1 camera, rounded rings, hulls, creases, springs and tweens as @lucasmarkes/hairline.
 *
 * spec (parts in mm, assembled positions) -> normalize -> layers (a part rises above
 * every part it overlaps and sits on) -> one camera for every part -> geometry split
 * into a back and a front group, so an open shell holds what sits inside it -> a paint
 * order worked out as the parts move -> callouts -> the inventory under the frame.
 */
const {
  Cam, proj, rrect, circ, hull, run, poly, open, seg, fillet, clamp, lerp, r2,
  spring, stepS, tween, tset, tval, tdone, register,
} = HL;

const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}
/** Sets an attribute only when its value changes. */
function setA(node, name, v) {
  const c = node.__c || (node.__c = {});
  if (c[name] !== v) { c[name] = v; node.setAttribute(name, v); }
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const claudeUse = (name) => (window.claude && window.claude.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null));
const pad2 = (n) => String(n).padStart(2, "0");

/* ---------------------------------------------------------------- camera */

const AZ = 45, K = 0.5, ZF = Math.sqrt(1 - K * K);
const VIEW = [Math.sin(AZ * Math.PI / 180), Math.cos(AZ * Math.PI / 180), K / ZF];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** P(x, y, z) in world millimetres, at scale S, with c at the screen origin. */
function projector(S, c) {
  const P = proj(Cam(AZ, K, S));
  return (x, y, z) => P(x - c[0], y - c[1], z - c[2]);
}

/* ---------------------------------------------------------- extrusions */

// An extrusion is a 2D section (u, v) swept along an axis (w).
const MAP = { z: (u, v, w) => [u, v, w], x: (u, v, w) => [w, u, v], y: (u, v, w) => [u, w, v] };
const NRM = { z: (a, b) => [a, b, 0], x: (a, b) => [0, a, b], y: (a, b) => [a, 0, b] };
const facesView = (axis) => (q) => dot3(NRM[axis](q.nu, q.nv), VIEW) >= -1e-6;
/** [U, V, L]: the section's extents and the length along the axis. */
function section(axis, s) { return axis === "z" ? [s[0], s[1], s[2]] : axis === "x" ? [s[1], s[2], s[0]] : [s[0], s[2], s[1]]; }
const shift = (ring, du, dv) => ring.map((q) => ({ u: q.u + du, v: q.v + dv, nu: q.nu, nv: q.nv }));
const steps = (r, S) => clamp(Math.ceil(r * S / 4), 4, 16);
const inset = (S, side) => clamp(1.7 / S, 0.04, side * 0.3);

function Geo(S, c) { return { S, P: projector(S, c), ops: [], pts: [], cut: -1, hole: null }; }
function add(g, d, cls, pts) { if (d) g.ops.push([d, cls]); if (pts) for (const p of pts) g.pts.push(p); }

/** A solid: the hull of both end rings (silhouette), and one dim crease inside the near rim of the far-end cap. */
function extrude(g, base, axis, ring, inner, w0, w1) {
  const m = MAP[axis];
  const at = (q, w) => { const p = m(q.u, q.v, w); return g.P(base[0] + p[0], base[1] + p[1], base[2] + p[2]); };
  const a = ring.map((q) => at(q, w0)), b = ring.map((q) => at(q, w1));
  const all = a.concat(b);
  add(g, poly(hull(all)), "sil", all);
  if (inner) {
    const f = run(inner, facesView(axis));
    if (f.length > 1) add(g, open(f.map((q) => at(q, w1))), "nf lo");
  }
}

/** A plus outline in (u, v), filleted. */
function plusPts(cu, cv, span, arm, rad) {
  const h = span / 2, a = arm / 2;
  const pts = [[cu + a, cv - h], [cu + a, cv - a], [cu + h, cv - a], [cu + h, cv + a], [cu + a, cv + a], [cu + a, cv + h],
    [cu - a, cv + h], [cu - a, cv + a], [cu - h, cv + a], [cu - h, cv - a], [cu - a, cv - a], [cu - a, cv - h]];
  return fillet(pts, pts.map(() => rad), 3);
}
function signedArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }

/** An upright extrusion of any outline, convex or not: stroke the union at double width, then fill it, so only the outer half of the stroke stays. */
function extrudeOutline(g, base, pts2, z0, z1) {
  const at = (q, z) => g.P(base[0] + q[0], base[1] + q[1], base[2] + z);
  const bot = pts2.map((q) => at(q, z0)), top = pts2.map((q) => at(q, z1));
  const n = pts2.length, ccw = signedArea(pts2) > 0;
  const front = pts2.map((a, i) => {
    const b = pts2[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1];
    const nx = ccw ? dy : -dy, ny = ccw ? -dx : dx;
    return nx * VIEW[0] + ny * VIEW[1] > 0;
  });
  const pieces = [bot];
  for (let i = 0; i < n; i++) {
    if (!front[i] || front[(i + n - 1) % n]) continue;
    const idx = [i]; let j = i;
    while (front[j] && idx.length <= n) { j = (j + 1) % n; idx.push(j); }
    pieces.push(idx.map((q) => top[q]).concat(idx.map((q) => bot[q]).reverse()));
  }
  pieces.push(top);
  add(g, pieces.map(poly).join(""), "nf sil u2", bot.concat(top));
  for (const pc of pieces) add(g, poly(pc), "fo");
  add(g, poly(top), "nf lo");
}

/** The part of convex polygon `subject` inside convex polygon `clip` (Sutherland–Hodgman). */
function clipConvex(subject, clip) {
  const sgn = signedArea(clip) > 0 ? 1 : -1;
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length], inp = out;
    const ex = b[0] - a[0], ey = b[1] - a[1];
    if (Math.abs(ex) + Math.abs(ey) < 1e-9) continue;
    const side = (p) => sgn * (ex * (p[1] - a[1]) - ey * (p[0] - a[0])) >= 0;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const P = inp[k], Q = inp[(k + 1) % inp.length], pi = side(P), qi = side(Q);
      if (pi) out.push(P);
      if (pi !== qi) {
        const dx = Q[0] - P[0], dy = Q[1] - P[1], den = dx * ey - dy * ex;
        if (Math.abs(den) > 1e-12) { const t = ((a[0] - P[0]) * ey - (a[1] - P[1]) * ex) / den; out.push([P[0] + t * dx, P[1] + t * dy]); }
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------- the parts */

const KINDS = ["box", "cyl", "tray", "flex", "screw"];

function drawBox(g, p) {
  const [U, V, L] = section(p.axis, p.size);
  const r = Math.min(p.r, U / 2, V / 2), n = steps(r, g.S), b = inset(g.S, Math.min(U, V));
  if (p.shape === "plus" && p.axis === "z") {
    const span = Math.min(U, V);
    extrudeOutline(g, [p.at[0] + (U - span) / 2, p.at[1] + (V - span) / 2, p.at[2]], plusPts(span / 2, span / 2, span, span * p.arm, Math.max(0.3, Math.min(r, span * 0.08))), 0, L);
    return;
  }
  if (p.outline && p.axis === "z") {
    extrudeOutline(g, p.at, outlineShape(p), 0, L);
    return;
  }
  if (p.taper > 0 && p.axis === "z") {
    const t = Math.min(p.taper, U / 2 - 0.4, V / 2 - 0.4);
    const foot = rrect(0, 0, U, V, r, n), top = rrect(t, t, U - t, V - t, Math.max(0.2, r - t), n);
    const inner = rrect(t + b, t + b, U - t - b, V - t - b, Math.max(0.2, r - t - b), n);
    const at = (q, z) => g.P(p.at[0] + q.u, p.at[1] + q.v, p.at[2] + z);
    const all = foot.map((q) => at(q, 0)).concat(top.map((q) => at(q, L)));
    add(g, poly(hull(all)), "sil", all);
    add(g, open(run(inner, facesView("z")).map((q) => at(q, L))), "nf lo");
    return;
  }
  const bev = p.axis === "z" ? bevelOf(p) : 0;
  if (bev > 0) {
    // a softened top edge: the full outline up to the shoulder, then the top face set in by the bevel
    const foot = rrect(0, 0, U, V, r, n), top = rrect(bev, bev, U - bev, V - bev, Math.max(0.2, r - bev), n);
    const at = (q, z) => g.P(p.at[0] + q.u, p.at[1] + q.v, p.at[2] + z);
    const all = foot.map((q) => at(q, 0)).concat(foot.map((q) => at(q, L - bev)), top.map((q) => at(q, L)));
    add(g, poly(hull(all)), "sil", all);
    const near = facesView("z");
    if (bev * g.S > 1.6) add(g, open(run(foot, near).map((q) => at(q, L - bev))), "nf lo");
    add(g, open(run(top, near).map((q) => at(q, L))), "nf lo");
    return;
  }
  extrude(g, p.at, p.axis, rrect(0, 0, U, V, r, n), rrect(b, b, U - b, V - b, Math.max(0.2, r - b), n), 0, L);
}
const bevelOf = (p) => Math.max(0, Math.min(p.bevel || 0, p.size[2] * 0.9, p.size[0] / 2 - 0.4, p.size[1] / 2 - 0.4));
/** A box's own footprint, rounded at every corner by r, in mm from its lowest corner. */
function outlineShape(p, by = 0) {
  const pts = by > 0 ? offsetClosed(p.outline, -by) : p.outline;
  const r = Math.max(0, p.r - by);
  return r > 0.05 ? fillet(pts, pts.map(() => r), 4) : pts.map((q) => q.slice());
}
/** A closed outline moved out by d (in by -d), mitred at the corners. */
function offsetClosed(pts, d) {
  const n = pts.length, ccw = signedArea(pts) > 0, s = ccw ? -1 : 1, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    const t1 = norm2([b[0] - a[0], b[1] - a[1]]), t2 = norm2([c[0] - b[0], c[1] - b[1]]);
    const n1 = [s * -t1[1], s * t1[0]], n2 = [s * -t2[1], s * t2[0]];
    let m = [n1[0] + n2[0], n1[1] + n2[1]]; const ml = Math.hypot(m[0], m[1]) || 1; m = [m[0] / ml, m[1] / ml];
    const cos = Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    out.push([b[0] + (m[0] * d) / cos, b[1] + (m[1] * d) / cos]);
  }
  return out;
}

function drawCyl(g, p) {
  const [U, V, L] = section(p.axis, p.size), R = Math.min(U, V) / 2;
  const n = clamp(Math.round(R * g.S * 0.9), 24, 96), b = inset(g.S, 2 * R);
  extrude(g, p.at, p.axis, shift(circ(R, n), U / 2, V / 2), shift(circ(Math.max(0.1, R - b), n), U / 2, V / 2), 0, L);
}

const LR = (pts) => (pts.length && pts[0][0] <= pts[pts.length - 1][0] ? pts : pts.slice().reverse());
/**
 * An open shell, as Riffle's tray: the body and far walls, then what sits on the floor,
 * then (from g.cut on) the near wall, which goes in the front group. A shell with no
 * floor fills only its walls, so what lies below shows through the opening.
 */
function drawTray(g, p, floorFeatures) {
  const [U, V, L] = section(p.axis, p.size), r = Math.min(p.r, U / 2, V / 2), n = steps(r, g.S);
  const w = Math.min(p.wall, U / 3, V / 3), front = facesView(p.axis), m = MAP[p.axis];
  const outer = rrect(0, 0, U, V, r, n), inner = rrect(w, w, U - w, V - w, Math.max(0.2, r - w), n);
  const at = (q, z) => { const o = m(q.u, q.v, z); return g.P(p.at[0] + o[0], p.at[1] + o[1], p.at[2] + o[2]); };
  const body = outer.map((q) => at(q, 0)).concat(outer.map((q) => at(q, L)));
  const outline = hull(body);
  if (p.floor) add(g, poly(outline), "sil", body);
  else {
    const hole = clipConvex(inner.map((q) => at(q, L)), inner.map((q) => at(q, 0)));
    if (hole.length > 2) g.hole = hole;
    add(g, poly(outline) + (g.hole ? poly(hole) : ""), "fo eo", body);
    add(g, poly(outline), "nf sil");
  }
  add(g, poly(inner.map((q) => at(q, L))), "nf");
  const fz = p.floor ? Math.min(w, L * 0.4) : 0;
  add(g, open(run(inner, (q) => !front(q)).map((q) => at(q, fz))), "nf lo");
  floorFeatures();
  g.cut = g.ops.length;
  const iF = LR(run(inner, front).map((q) => at(q, L)));
  const oT = LR(run(outer, front).map((q) => at(q, L)));
  const oB = LR(run(outer, front).map((q) => at(q, 0)));
  if (iF.length && oT.length && oB.length) {
    add(g, poly([...iF, oT[oT.length - 1], ...oB.slice().reverse(), oT[0]]), "fo");
    add(g, open(oT), "nf lo");
    add(g, open(iF), "nf");
    add(g, open([oT[0], ...oB, oT[oT.length - 1]]), "nf sil");
  }
}

/** A standing screw: shank with threads, then a head with a cross recess. */
function screwAt(g, base, d, L) {
  const hh = clamp(d * 0.38, 0.25, L * 0.45), rs = d * 0.27, c = d / 2, len = L - hh;
  extrude(g, base, "z", shift(circ(rs, 28), c, c), null, 0, len);
  const turns = clamp(Math.round(len / (d * 0.33)), 2, 10);
  const ex = [VIEW[1], -VIEW[0]];
  let th = "";
  for (let j = 1; j < turns; j++) {
    const z = (len * j) / turns;
    const a = g.P(base[0] + c - rs * ex[0], base[1] + c - rs * ex[1], base[2] + z);
    const b = g.P(base[0] + c + rs * ex[0], base[1] + c + rs * ex[1], base[2] + z + (len / turns) * 0.45);
    th += seg(a, b);
  }
  add(g, th, "nf lo");
  extrude(g, base, "z", shift(circ(d / 2, 36), c, c), shift(circ(d / 2 - inset(g.S, d), 36), c, c), len, L);
  const k = d * 0.2, top = base[2] + L;
  add(g, seg(g.P(base[0] + c - k, base[1] + c, top), g.P(base[0] + c + k, base[1] + c, top)) + seg(g.P(base[0] + c, base[1] + c - k, top), g.P(base[0] + c, base[1] + c + k, top)), "nf");
}
/** Where each copy of a screw part stands: over its hole when seated, else in a row. */
function screwBases(p) {
  if (p.spots && p.spots.length) return p.spots.map(([x, y]) => [x - p.d / 2, y - p.d / 2, p.at[2]]);
  return Array.from({ length: p.copies }, (_, k) => [p.at[0] + k * p.d * 1.9, p.at[1], p.at[2]]);
}
function drawScrew(g, p) {
  for (const b of screwBases(p)) screwAt(g, b, p.d, p.size[2]);
}

/** A ribbon cable: the centreline offset both ways, filleted, with two dim traces along it. */
function offsetLine(path, o) {
  const n = path.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[i], c = path[Math.min(n - 1, i + 1)];
    const d1 = norm2([b[0] - a[0], b[1] - a[1]]), d2 = norm2([c[0] - b[0], c[1] - b[1]]);
    const t1 = i === 0 ? d2 : d1, t2 = i === n - 1 ? d1 : d2;
    const n1 = [-t1[1], t1[0]], n2 = [-t2[1], t2[0]];
    let m = [n1[0] + n2[0], n1[1] + n2[1]]; const ml = Math.hypot(m[0], m[1]) || 1; m = [m[0] / ml, m[1] / ml];
    const cos = Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    out.push([b[0] + (m[0] * o) / cos, b[1] + (m[1] * o) / cos]);
  }
  return out;
}
function norm2(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
function drawFlex(g, p) {
  const w = p.width, z = p.at[2] + p.size[2];
  const at = (q) => g.P(p.origin[0] + q[0], p.origin[1] + q[1], z);
  const left = offsetLine(p.path, w / 2), right = offsetLine(p.path, -w / 2);
  const outline = left.concat(right.slice().reverse());
  const rad = outline.map((_, i) => (i === 0 || i === left.length - 1 || i === left.length || i === outline.length - 1 ? Math.min(0.6, w * 0.2) : w * 0.45));
  const shape = fillet(outline, rad, 3).map(at);
  add(g, poly(shape), "sil", shape);
  if (w * g.S > 9) add(g, open(offsetLine(p.path, w * 0.2).map(at)) + open(offsetLine(p.path, -w * 0.2).map(at)), "nf lo");
}

/* ------------------------------------------------------------ features */

const FEATS = ["hole", "ring", "slot", "cross", "grille", "boss", "pin", "inset", "line"];
const raised = (f) => f.t === "boss" || f.t === "pin" || (f.t === "ring" && f.h > 0);
function faceFrame(p, face) {
  const [x0, y0, z0] = p.at, [sx, sy, sz] = p.size;
  if (p.kind === "flex") return { axis: "z", base: [p.origin[0], p.origin[1], 0], w0: z0 + sz, U: sx, V: sy, r: 0.5 };
  if (face === "front") return { axis: "y", base: [x0, 0, z0], w0: y0 + sy, U: sx, V: sz, r: 0.6 };
  if (face === "side") return { axis: "x", base: [0, y0, z0], w0: x0 + sx, U: sy, V: sz, r: 0.6 };
  const openTop = p.kind === "tray" && p.axis === "z";
  const zt = openTop ? z0 + (p.floor ? Math.min(p.wall, sz * 0.4) : 0) : z0 + sz;
  const insetTop = p.kind === "box" && p.axis === "z" ? (p.taper > 0 ? p.taper : bevelOf(p)) : 0;
  return { axis: "z", base: [x0, y0, 0], w0: zt, U: sx, V: sy, r: openTop ? Math.max(0.3, p.r - p.wall) : p.r, inTop: insetTop, outline: p.kind === "box" && p.axis === "z" && p.outline ? p : null };
}
function drawFeature(g, p, f) {
  const F = faceFrame(p, f.face), m = MAP[F.axis];
  const at = (u, v, w) => { const q = m(u, v, w); return g.P(F.base[0] + q[0], F.base[1] + q[1], F.base[2] + q[2]); };
  const w0 = F.w0 + (f.z || 0);
  const flat = (ring, cls) => add(g, poly(ring.map((q) => at(q.u, q.v, w0))), cls);
  const [u, v] = f.at;
  switch (f.t) {
    case "hole": flat(shift(circ(f.d / 2, clamp(Math.round(f.d * g.S), 16, 64)), u, v), "nf"); break;
    case "slot": {
      const [w, h] = f.size, r = f.r == null ? Math.min(w, h) * 0.3 : Math.min(f.r, w / 2, h / 2);
      flat(rrect(u - w / 2, v - h / 2, u + w / 2, v + h / 2, r, steps(r, g.S)), "nf"); break;
    }
    case "cross": {
      const [span, arm] = f.size;
      add(g, poly(plusPts(u, v, span, arm, Math.max(0.2, arm * 0.15)).map((q) => at(q[0], q[1], w0))), "nf"); break;
    }
    case "inset": {
      const by = f.by + (F.inTop || 0), r = Math.max(0.2, (F.r || 1) - by);
      if (F.outline) { if (F.U - 2 * by > 0.5 && F.V - 2 * by > 0.5) add(g, poly(outlineShape(F.outline, by).map((q) => at(q[0], q[1], w0))), "nf"); }
      else if (F.U - 2 * by > 0.5 && F.V - 2 * by > 0.5) flat(rrect(by, by, F.U - by, F.V - by, r, steps(r, g.S)), "nf");
      break;
    }
    case "ring": {
      const R = f.d / 2, R2 = f.d2 / 2, n = clamp(Math.round(R * g.S), 24, 96);
      if (f.h > 0) {
        const b = inset(g.S, f.d);
        extrude(g, F.base, F.axis, shift(circ(R, n), u, v), shift(circ(Math.max(0.1, R - b), n), u, v), w0, w0 + f.h);
        if (R2 > 0.05) add(g, poly(shift(circ(R2, n), u, v).map((q) => at(q.u, q.v, w0 + f.h))), "nf");
      } else {
        flat(shift(circ(R, n), u, v), "nf");
        if (R2 > 0.05) flat(shift(circ(R2, n), u, v), "nf");
      }
      break;
    }
    case "line": add(g, seg(at(u, v, w0), at(f.to[0], f.to[1], w0)), "nf lo"); break;
    case "grille": {
      const [w, h] = f.size; let pitch = f.pitch;
      while ((w / pitch + 1) * (h / pitch + 1) > 500) pitch *= 1.25;
      const rr = clamp(pitch * g.S * 0.2, 0.45, 1.4);
      let d = "";
      for (let a = -w / 2 + pitch / 2; a <= w / 2 - pitch / 2 + 1e-6; a += pitch)
        for (let b = -h / 2 + pitch / 2; b <= h / 2 - pitch / 2 + 1e-6; b += pitch) {
          const c = at(u + a, v + b, w0);
          d += `M${r2(c[0] - rr)} ${r2(c[1])}a${rr} ${rr} 0 1 0 ${r2(2 * rr)} 0a${rr} ${rr} 0 1 0 ${r2(-2 * rr)} 0`;
        }
      add(g, d, "dot"); break;
    }
    case "boss": {
      const [w, h, H] = f.size, r = Math.min(f.r == null ? Math.min(w, h) * 0.12 : f.r, w / 2, h / 2), n = steps(r, g.S), b = inset(g.S, Math.min(w, h));
      extrude(g, F.base, F.axis, rrect(u - w / 2, v - h / 2, u + w / 2, v + h / 2, r, n), rrect(u - w / 2 + b, v - h / 2 + b, u + w / 2 - b, v + h / 2 - b, Math.max(0.15, r - b), n), w0, w0 + H);
      break;
    }
    case "pin": {
      const R = f.d / 2, n = clamp(Math.round(R * g.S), 20, 72), b = inset(g.S, f.d);
      extrude(g, F.base, F.axis, shift(circ(R, n), u, v), shift(circ(Math.max(0.1, R - b), n), u, v), w0, w0 + f.h);
      break;
    }
  }
}
function featureDepth(p, f) {
  const F = faceFrame(p, f.face), q = MAP[F.axis](f.at[0], f.at[1], F.w0);
  return [f.z || 0, dot3([F.base[0] + q[0], F.base[1] + q[1], F.base[2] + q[2]], VIEW)];
}

/** One part's geometry at scale S, about the shared origin. Ops before g.cut are the back group, the rest the front. */
function buildPart(p, S, origin) {
  const g = Geo(S, origin);
  const flatOn = (pred) => p.features.filter((f) => !raised(f) && pred(f));
  const raisedOn = (pred) => p.features.filter((f) => raised(f) && pred(f))
    .map((f) => [f, featureDepth(p, f)]).sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]).map((x) => x[0]);
  const isTop = (f) => f.face === "top", notTop = (f) => f.face !== "top";
  if (p.kind === "tray") {
    drawTray(g, p, () => { for (const f of flatOn(isTop)) drawFeature(g, p, f); for (const f of raisedOn(isTop)) drawFeature(g, p, f); });
    for (const f of flatOn(notTop)) drawFeature(g, p, f);
    for (const f of raisedOn(notTop)) drawFeature(g, p, f);
    return g;
  }
  if (p.kind === "cyl") drawCyl(g, p);
  else if (p.kind === "screw") drawScrew(g, p);
  else if (p.kind === "flex") drawFlex(g, p);
  else drawBox(g, p);
  for (const f of flatOn(() => true)) drawFeature(g, p, f);
  for (const f of raisedOn(() => true)) drawFeature(g, p, f);
  g.cut = g.ops.length;
  return g;
}

/** Where a part's screws stand: over its small top holes, or near its corners. */
function screwSpots(p) {
  if (!p.screwHoles || !p.screwHoles.length) return null;
  const F = faceFrame(p, "top"), ds = p.screwHoles.map((f) => f.d).sort((a, b) => a - b);
  const d = clamp(ds[Math.floor(ds.length / 2)] * 1.25, 1, 3.6);
  return { d, len: d * 2.3, z: F.w0, pts: p.screwHoles.map((f) => [F.base[0] + f.at[0], F.base[1] + f.at[1]]) };
}

/*
 * Screws always land in holes. A screw part finds the part it rests on and takes that
 * part's screw holes nearest to where it was placed (or the exact spots it lists); a
 * part with "screws" takes its own. Where a part has too few holes, holes are added at
 * its corners, then along its edges, so no screw ever floats over a blank face.
 */
const SCREW_HOLE_MAX = 3.6;
const isScrewHole = (f) => f.t === "hole" && f.face === "top" && f.d <= SCREW_HOLE_MAX;
function holeCandidates(p) {
  const F = faceFrame(p, "top"), U = F.U, V = F.V;
  const openTop = p.kind === "tray" && p.axis === "z", wall = openTop ? Math.min(p.wall, U / 3, V / 3) : 0;
  const e = wall + clamp(Math.max((openTop ? Math.max(0, p.r - wall) : p.r) * 0.55, 2.2), 1.4, Math.max(1.4, Math.min(U, V) * 0.2));
  if (U - 2 * e < 0.5 || V - 2 * e < 0.5) return [[U / 2, V / 2]];
  const c = [[e, e], [U - e, V - e], [U - e, e], [e, V - e], [U / 2, e], [U / 2, V - e], [e, V / 2], [U - e, V / 2], [U / 3, e], [(2 * U) / 3, V - e], [(2 * U) / 3, e], [U / 3, V - e]];
  const ring = p.outline && p.axis === "z" ? outlineShape(p) : null;
  return ring ? c.filter((q) => pointInPoly(q, ring)) : c;
}
function addHole(p, at, d) {
  const f = { t: "hole", face: "top", at: [Math.round(at[0] * 100) / 100, Math.round(at[1] * 100) / 100], z: 0, d: Math.round(clamp(d, 1, SCREW_HOLE_MAX - 0.2) * 100) / 100 };
  p.features.push(f);
  return f;
}
function seatScrews(parts) {
  const taken = new Map(), takenOf = (h) => taken.get(h) || taken.set(h, new Set()).get(h);
  const holeXY = (h, f) => { const F = faceFrame(h, "top"); return [F.base[0] + f.at[0], F.base[1] + f.at[1]]; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const freeCandidates = (h) => {
    const F = faceFrame(h, "top"), have = h.features.filter((f) => f.t === "hole" && f.face === "top").map((f) => f.at);
    return holeCandidates(h).filter((q) => have.every((a) => dist(a, q) > 2.5)).map((q) => ({ uv: q, xy: [F.base[0] + q[0], F.base[1] + q[1]] }));
  };
  for (const p of parts) {
    if (p.kind !== "screw") continue;
    const d = p.d, n = clamp(p.qty, 1, 16);
    const wanted = p.wantSpots && p.wantSpots.length ? p.wantSpots.slice(0, n) : null;
    const row = Array.from({ length: Math.min(4, n) }, (_, k) => [p.at[0] + k * d * 1.9 + d / 2, p.at[1] + d / 2]);
    const pts = wanted || row, cx = pts.reduce((a, q) => a + q[0], 0) / pts.length, cy = pts.reduce((a, q) => a + q[1], 0) / pts.length;
    // the part it rests on: under its centre, the highest face at or just below the screw
    const under = parts.filter((h) => h !== p && h.kind !== "screw" && h.kind !== "flex" && cx >= h.at[0] - 1 && cx <= h.at[0] + h.size[0] + 1 && cy >= h.at[1] - 1 && cy <= h.at[1] + h.size[1] + 1);
    const topZ = (h) => faceFrame(h, "top").w0, highest = (list) => list.reduce((a, b) => (topZ(b) > topZ(a) ? b : a));
    // first choice: the part whose holes match the listed spots; then the part the screw head rests on exactly;
    // then the highest face just below the screw; then the nearest face at all
    const matches = (h) => (wanted ? wanted.filter((q) => h.features.some((f) => isScrewHole(f) && dist(holeXY(h, f), q) <= 1)).length : 0);
    const best = under.length ? Math.max(...under.map(matches)) : 0;
    const exact = under.filter((h) => Math.abs(topZ(h) - p.at[2]) <= 0.3);
    const ok = under.filter((h) => topZ(h) <= p.at[2] + 0.5 * p.size[2] + 0.5);
    const host = best > 0 ? highest(under.filter((h) => matches(h) === best))
      : exact.length ? highest(exact) : ok.length ? highest(ok)
      : under.length ? under.reduce((a, b) => (Math.abs(topZ(b) - p.at[2]) < Math.abs(topZ(a) - p.at[2]) ? b : a)) : null;
    if (!host) { p.spots = wanted; if (wanted) p.copies = wanted.length; continue; }
    const used = takenOf(host), picks = [];
    const free = () => host.features.filter((f) => isScrewHole(f) && !used.has(f) && !picks.includes(f));
    if (wanted) {
      // listed spots: the hole under each, or a new hole right there
      const F = faceFrame(host, "top");
      for (const q of wanted) {
        const near = free().map((f) => [f, dist(holeXY(host, f), q)]).sort((a, b) => a[1] - b[1])[0];
        if (near && near[1] <= 3) picks.push(near[0]);
        else {
          const uv = [clamp(q[0] - F.base[0], 0.6, F.U - 0.6), clamp(q[1] - F.base[1], 0.6, F.V - 0.6)];
          picks.push(addHole(host, uv, d * 0.85));
        }
      }
    } else {
      for (const [f] of free().map((f) => [f, dist(holeXY(host, f), [cx, cy])]).sort((a, b) => a[1] - b[1])) { if (picks.length >= n) break; picks.push(f); }
      const cands = freeCandidates(host).sort((a, b) => dist(a.xy, [cx, cy]) - dist(b.xy, [cx, cy]));
      while (picks.length < n && cands.length) picks.push(addHole(host, cands.shift().uv, d * 0.85));
    }
    for (const f of picks) used.add(f);
    const F = faceFrame(host, "top");
    p.spots = picks.map((f) => holeXY(host, f));
    p.copies = p.spots.length;
    p.host = host.id;
    const b = bbox(p.spots);
    p.at = [b.x0 - d / 2, b.y0 - d / 2, F.w0];
    p.size = [b.w + d, b.h + d, p.size[2]];
  }
  for (const p of parts) {
    if (!p.screws || p.kind === "screw" || p.kind === "flex") continue;
    const used = takenOf(p), seated = used.size > 0;
    const free = p.features.filter((f) => isScrewHole(f) && !used.has(f));
    let pick = [];
    if (free.length >= p.screws) for (let k = 0; k < p.screws; k++) { const f = free[Math.floor((k * free.length) / p.screws)]; if (!pick.includes(f)) pick.push(f); }
    else pick = free.slice();
    // screw parts already fasten this part: its own count never doubles them
    if (!seated) { const cands = freeCandidates(p); while (pick.length < p.screws && cands.length) pick.push(addHole(p, cands.shift().uv, 1.8)); }
    for (const f of pick) used.add(f);
    p.screwHoles = pick;
  }
}

/** The part's bottom outline, in world x and y. */
function bottomOutline(p) {
  const [x0, y0] = p.at, [U, V] = p.size;
  if (p.kind === "cyl" && p.axis === "z") { const R = Math.min(U, V) / 2; return circ(R, 48).map((q) => [x0 + U / 2 + q.u, y0 + V / 2 + q.v]); }
  if (p.outline && p.axis === "z") return outlineShape(p).map((q) => [x0 + q[0], y0 + q[1]]);
  const r = p.kind === "box" || p.kind === "tray" ? Math.min(p.r, U / 2, V / 2) : Math.min(U, V) * 0.2;
  return rrect(0, 0, U, V, r, 4).map((q) => [x0 + q.u, y0 + q.v]);
}

/* ------------------------------------------------------------- 2D help */

function bbox(pts) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
function pointInPoly(pt, pg) {
  let c = false;
  for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
    const [xi, yi] = pg[i], [xj, yj] = pg[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy || 1;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l, 0, 1);
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function nearPoly(pt, pg, tol) {
  if (pointInPoly(pt, pg)) return true;
  for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) if (distSeg(pt, pg[j], pg[i]) <= tol) return true;
  return false;
}
function segCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function segHitsPoly(a, b, pg) {
  if (pointInPoly(a, pg) || pointInPoly(b, pg)) return true;
  for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) if (segCross(a, b, pg[j], pg[i])) return true;
  return false;
}
const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
/** Spreads sorted 1D positions so none sit closer than gap, keeping order, within [lo, hi]. */
function spread(xs, gap, lo, hi) {
  const p = xs.slice();
  for (let it = 0; it < 200; it++) {
    let moved = false;
    for (let i = 1; i < p.length; i++) {
      const d = p[i] - p[i - 1];
      if (d < gap - 0.01) { const m = (gap - d) / 2; p[i - 1] -= m; p[i] += m; moved = true; }
    }
    for (let i = 0; i < p.length; i++) p[i] = clamp(p[i], lo + i * gap, hi - (p.length - 1 - i) * gap);
    if (!moved) break;
  }
  return p;
}

/* ---------------------------------------------------------- the spec */

const num = (v, d, a, b) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, a, b) : d; };
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const vec = (v, n, d, a, b) => Array.from({ length: n }, (_, i) => num(Array.isArray(v) ? v[i] : undefined, Array.isArray(d) ? d[i] : d, a, b));
const SMALL = new Set(["a", "an", "and", "of", "the", "for", "to", "in", "on", "or", "with"]);
const titleCase = (s) => (/[A-Z]/.test(s) ? s : s.split(" ").map((w, i) => (i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" "));

function normFeature(f, part) {
  if (!f || typeof f !== "object") return null;
  const t = FEATS.includes(f.t) ? f.t : FEATS.includes(f.type) ? f.type : null;
  if (!t) return null;
  const face = part.kind === "flex" ? "top" : ["top", "front", "side"].includes(f.face) ? f.face : "top";
  const o = { t, face, at: vec(f.at, 2, 0, -5000, 5000), z: num(f.z, 0, 0, 1000) };
  const big = 5000;
  if (t === "hole") o.d = num(f.d, 2, 0.1, big);
  if (t === "ring") { o.d = num(f.d, 6, 0.2, big); o.d2 = num(f.d2, o.d * 0.4, 0, o.d * 0.97); o.h = num(f.h, 0, 0, big); }
  if (t === "slot") { o.size = vec(f.size, 2, [4, 2], 0.1, big); if (f.r != null) o.r = num(f.r, 0, 0, big); }
  if (t === "cross") o.size = vec(f.size, 2, [10, 3], 0.2, big);
  if (t === "grille") { o.size = vec(f.size, 2, [6, 6], 0.2, big); o.pitch = num(f.pitch, 1.2, 0.2, big); }
  if (t === "boss") { o.size = vec(f.size, 3, [3, 3, 1], 0.05, big); if (f.r != null) o.r = num(f.r, 0, 0, big); }
  if (t === "pin") { o.d = num(f.d, 3, 0.1, big); o.h = num(f.h, 1, 0.05, big); }
  if (t === "inset") o.by = num(f.by, 1.5, 0.05, big);
  if (t === "line") o.to = vec(f.to, 2, o.at, -big, big);
  return o;
}
function normPart(raw, i) {
  if (!raw || typeof raw !== "object") return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : raw.kind === "cylinder" ? "cyl" : "box";
  const p = {
    id: i, name: titleCase(str(raw.name, 36) || "Part " + (i + 1)), qty: Math.round(num(raw.qty, 1, 1, 999)), kind,
    axis: ["x", "y", "z"].includes(raw.axis) ? raw.axis : "z",
    size: vec(raw.size, 3, 10, 0.1, 20000), at: vec(raw.at, 3, 0, -20000, 20000),
    r: num(raw.r, kind === "box" ? 1 : 2, 0, 5000), taper: num(raw.taper, 0, 0, 5000), bevel: num(raw.bevel, 0, 0, 5000),
    wall: num(raw.wall, 1.2, 0.1, 5000), floor: raw.floor !== false, shape: raw.shape === "plus" ? "plus" : "", arm: num(raw.arm, 0.34, 0.15, 0.6),
    screws: Math.round(num(raw.screws, 0, 0, 4)), features: [],
  };
  const pn = str(raw.pn, 24);
  if (pn) p.pn = pn;
  if (kind === "tray" && !["x", "y", "z"].includes(raw.axis)) p.axis = "z";
  if (kind === "screw") {
    p.axis = "z"; p.d = clamp(Math.min(p.size[0], p.size[1]), 0.6, 6);
    p.copies = Math.min(4, p.qty);
    p.size = [p.d * (1 + 1.9 * (p.copies - 1)), p.d, p.size[2]];
    if (Array.isArray(raw.spots)) {
      const sp = raw.spots.filter((q) => Array.isArray(q)).slice(0, 16).map((q) => vec(q, 2, 0, -20000, 20000));
      if (sp.length) p.wantSpots = sp;
    }
  }
  if (kind === "flex") {
    let path = Array.isArray(raw.path) ? raw.path.filter((q) => Array.isArray(q)).slice(0, 40).map((q) => vec(q, 2, 0, -20000, 20000)) : [];
    path = path.filter((q, k) => k === 0 || Math.hypot(q[0] - path[k - 1][0], q[1] - path[k - 1][1]) > 0.01);
    if (path.length < 2) path = [[0, 0], [Math.max(p.size[0], 4), 0]];
    p.width = num(raw.width, Math.min(p.size[1], 6) || 4, 0.3, 500);
    p.origin = [p.at[0], p.at[1]];
    p.path = path;
    const b = bbox(path), h = p.width / 2;
    p.at = [p.at[0] + b.x0 - h, p.at[1] + b.y0 - h, p.at[2]];
    p.size = [b.w + p.width, b.h + p.width, Math.min(p.size[2], 0.6) || 0.3];
  }
  if (kind === "box" && p.axis === "z" && !p.shape && Array.isArray(raw.outline)) {
    let pts = raw.outline.filter((q) => Array.isArray(q)).slice(0, 64).map((q) => vec(q, 2, 0, -20000, 20000));
    pts = pts.filter((q, k) => k === 0 || Math.hypot(q[0] - pts[k - 1][0], q[1] - pts[k - 1][1]) > 0.05);
    if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.05) pts.pop();
    const b = bbox(pts);
    if (pts.length > 2 && Math.abs(signedArea(pts)) > 1 && b.w > 0.2 && b.h > 0.2) {
      p.outline = pts.map((q) => [q[0] - b.x0, q[1] - b.y0]);
      p.at = [p.at[0] + b.x0, p.at[1] + b.y0, p.at[2]];
      p.size = [b.w, b.h, p.size[2]];
      p.taper = 0; p.bevel = 0;
    }
  }
  p.features = (Array.isArray(raw.features) ? raw.features : []).slice(0, 40).map((f) => normFeature(f, p)).filter(Boolean);
  return p;
}
/** Up to 8 distinct http(s) addresses, from a list or from loose text. */
function cleanSources(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const out = [];
  for (const item of list) {
    const text = typeof item === "string" ? item : item && typeof item.url === "string" ? item.url : "";
    for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
      const u = m[0].replace(/[.,;:!?]+$/, "");
      try { const url = new URL(u); if (!out.includes(url.href)) out.push(url.href); } catch {}
      if (out.length >= 8) return out;
    }
  }
  return out;
}
function normalize(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.parts)) throw new Error("The spec needs a parts list.");
  const parts = raw.parts.slice(0, 40).map(normPart).filter(Boolean);
  parts.forEach((p, i) => (p.id = i));
  seatScrews(parts);
  if (parts.length < 2) throw new Error("The spec needs at least two parts.");
  const out = { object: str(raw.object, 48) || "Object", parts };
  const notes = str(raw.notes, 3000);
  if (notes) out.notes = notes;
  if (raw.explode === "front" || raw.explode === "side") out.explode = raw.explode;
  const src = cleanSources(raw.sources);
  if (src.length) out.sources = src;
  return out;
}
/** The spec as a person would write it again: what normalize() accepts. */
function denormalize(s) {
  return {
    ...(s.notes ? { notes: s.notes } : {}),
    object: s.object,
    ...(s.explode ? { explode: s.explode } : {}),
    ...(s.sources && s.sources.length ? { sources: s.sources } : {}),
    parts: s.parts.map((p) => {
      const o = { name: p.name };
      if (p.pn) o.pn = p.pn;
      if (p.qty > 1) o.qty = p.qty;
      o.kind = p.kind;
      if (p.kind === "flex") { o.at = [p.origin[0], p.origin[1], p.at[2]]; o.path = p.path; o.width = p.width; o.size = [0, 0, p.size[2]]; }
      else if (p.kind === "screw") { o.at = p.at; o.size = [p.d, p.d, p.size[2]]; if (p.spots) o.spots = p.spots.map((q) => q.map((x) => Math.round(x * 100) / 100)); }
      else { o.at = p.at; o.size = p.size; }
      if ((p.kind === "box" || p.kind === "cyl" || p.kind === "tray") && p.axis !== "z") o.axis = p.axis;
      if (p.kind === "box" || p.kind === "tray") o.r = p.r;
      if (p.taper) o.taper = p.taper;
      if (p.bevel) o.bevel = p.bevel;
      if (p.outline) o.outline = p.outline.map((q) => q.map((x) => Math.round(x * 100) / 100));
      if (p.shape) { o.shape = p.shape; o.arm = p.arm; }
      if (p.kind === "tray") { o.wall = p.wall; if (!p.floor) o.floor = false; }
      if (p.screws) o.screws = p.screws;
      if (p.features.length) o.features = p.features.map((f) => { const c = { ...f }; if (c.face === "top") delete c.face; if (!c.z) delete c.z; return c; });
      return o;
    }),
  };
}

/* ------------------------------------------------------------- layers */

const footprint = (p) => [p.at[0], p.at[1], p.at[0] + p.size[0], p.at[1] + p.size[1]];
const overlaps = (a, b, e = 0.05) => a[0] < b[2] - e && b[0] < a[2] - e && a[1] < b[3] - e && b[1] < a[3] - e;
const within = (a, b, t) => a[0] >= b[0] - t && a[1] >= b[1] - t && a[2] <= b[2] + t && a[3] <= b[3] + t;
/** Each part's layer: one above the highest layer of any part it overlaps and sits on. */
function layering(parts, xa = 2) {
  // footprints across the explode axis; parts ordered along it
  const [a, b] = [0, 1, 2].filter((k) => k !== xa);
  const n = parts.length, fp = parts.map((p) => [p.at[a], p.at[b], p.at[a] + p.size[a], p.at[b] + p.size[b]]);
  const top = (p) => p.at[xa] + p.size[xa];
  const order = [...Array(n).keys()].sort((i, j) => parts[i].at[xa] - parts[j].at[xa] || top(parts[i]) - top(parts[j]) || i - j);
  const layer = Array(n).fill(0);
  order.forEach((i, a) => { for (let b = 0; b < a; b++) { const j = order[b]; if (overlaps(fp[i], fp[j])) layer[i] = Math.max(layer[i], layer[j] + 1); } });
  let max = Math.max(...layer);
  if (!max && n > 1) { order.forEach((i, a) => (layer[i] = a)); max = n - 1; }
  return { layer, max };
}

const trayInner = (p) => {
  if (p.kind !== "tray") return null;
  const w = Math.min(p.wall, p.size[0] / 3, p.size[1] / 3), f = footprint(p);
  return [f[0] + w, f[1] + w, f[2] - w, f[3] - w];
};
/**
 * Exploded straight up, a small part under a big plate stays hidden. Such a part slides
 * out sideways, along x or y, far enough to clear the parts above it, in whichever
 * direction leaves it most in view. Returns each part's slide, in world mm.
 */
function slideOut(parts, layer, gap, sep, g1, P1, oc, lo, hi) {
  const maxDim = Math.max(hi[0] - lo[0], hi[1] - lo[1]), area = (hi[0] - lo[0]) * (hi[1] - lo[1]);
  const pushes = parts.map(() => [0, 0]);
  const tmp = parts.map((p, i) => ({
    i, fp0: footprint(p), z0: p.at[2], z1: p.at[2] + p.size[2], dz: layer[i] * gap,
    tray: p.kind === "tray", inner: trayInner(p), hull: hull(g1[i].pts), hole: g1[i].hole,
  }));
  const place = (t, push) => {
    t.fp = [t.fp0[0] + push[0], t.fp0[1] + push[1], t.fp0[2] + push[0], t.fp0[3] + push[1]];
    const v = P1(oc[0] + push[0], oc[1] + push[1], oc[2]), dy = -layer[t.i] * sep;
    t.poly = t.hull.map(([x, y]) => [x + v[0], y + v[1] + dy]);
    t.holeP = t.hole ? t.hole.map(([x, y]) => [x + v[0], y + v[1] + dy]) : null;
    t.bb = bbox(t.poly);
  };
  tmp.forEach((t) => place(t, [0, 0]));
  const coverage = (t) => {
    const bb = t.bb, covers = [];
    for (const o of tmp) {
      if (o === t || o.bb.x0 >= bb.x1 || o.bb.x1 <= bb.x0 || o.bb.y0 >= bb.y1 || o.bb.y1 <= bb.y0) continue;
      const [kind, A] = relate(t, o);
      if (kind === "above" ? A === o : kind !== "inside" && A === t) covers.push(o);
    }
    let inside = 0, hit = 0;
    for (let a = 0; a < 14; a++) for (let b = 0; b < 14; b++) {
      const q = [bb.x0 + ((a + 0.5) / 14) * bb.w, bb.y0 + ((b + 0.5) / 14) * bb.h];
      if (!pointInPoly(q, t.poly)) continue;
      inside++;
      if (covers.some((o) => pointInPoly(q, o.poly) && !(o.holeP && pointInPoly(q, o.holeP)))) hit++;
    }
    return inside ? hit / inside : 0;
  };
  const m = 2 + 0.04 * maxDim;
  const cand = tmp.filter((t) => !t.tray && parts[t.i].kind !== "screw" && (t.fp0[2] - t.fp0[0]) * (t.fp0[3] - t.fp0[1]) <= 0.3 * area)
    .map((t) => [t, coverage(t)]).filter(([, c]) => c >= 0.45).sort((a, b) => b[1] - a[1]);
  for (const [t] of cand) {
    const c0 = coverage(t);
    if (c0 < 0.45) continue;
    const above = tmp.filter((o) => o !== t && o.dz > t.dz && overlaps(o.fp, t.fp));
    if (!above.length) continue;
    const f = t.fp0;
    let best = null;
    // a slid part must not land inside another part at the same height
    const collides = () => tmp.some((o) => o !== t && overlaps(t.fp, o.fp, -0.6) && t.z0 + t.dz < o.z1 + o.dz && o.z0 + o.dz < t.z1 + t.dz);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let dist = dx > 0 ? Math.max(...above.map((o) => o.fp[2])) - f[0] + m
        : dx < 0 ? f[2] - Math.min(...above.map((o) => o.fp[0])) + m
        : dy > 0 ? Math.max(...above.map((o) => o.fp[3])) - f[1] + m
        : f[3] - Math.min(...above.map((o) => o.fp[1])) + m;
      const step = (dx ? f[2] - f[0] : f[3] - f[1]) + m;
      place(t, [dx * dist, dy * dist]);
      for (let k = 0; k < 6 && collides(); k++) { dist += step; place(t, [dx * dist, dy * dist]); }
      if (collides()) continue;
      const c = coverage(t), score = c + (dist / maxDim) * 0.5;
      if (!best || score < best.score) best = { score, c, push: [dx * dist, dy * dist] };
    }
    if (best && best.c < c0 - 0.25) pushes[t.i] = best.push;
    place(t, pushes[t.i]);
  }
  return pushes;
}

/* --------------------------------------------------------- the stage */

const W = 958, BAR = 28.6, PADY = 36, GUT = 70, LIFT = 14, SPREAD = 0.7;
const svg = $("stage");
const slider = $("explode");
const state = {
  spec: null, items: [], act: null, H: 680, Sa: 1, gap: 0, rise: 0, max: 0, kx: 1,
  C: [W / 2, 340], Oa: [0, 0], Ox: [0, 0], cam: { k: 1, O: [0, 0] }, camKey: "",
  nodes: [], keys: [], hitOrder: [], orderKey: "", orderT: -1, orderDirty: true, revealAt: 0, layerG: null, readout: null,
  // which drawing the frame shows: the exploded isometric, orthographic views or a section
  view: "iso", proj: "third", cut: { axis: "y", t: 0.5 }, flatG: null, sec: null, solids: [], flatS: 0, isoH: 680,
  labels: store.get("bp.labels", true) !== false,
};
const ex = spring(1, { eps: 0.0008 });
const SOFT = { k: 22, c: 9.4 }, FIRM = { k: 100, c: 18 };
const setSpring = (o) => { ex.k = o.k; ex.c = o.c; };
const play = { on: false, until: 0 };

const STAGE_CSS = `
#stage{--psw:.75px;font-family:var(--font)}
#stage .paper{fill:var(--paper)}
#stage text{fill:var(--ink);font-family:var(--font)}
#stage .rule{fill:none;stroke:var(--ink);stroke-width:.5}
#stage .grid{fill:url(#bp-grid)}
#stage .grid-line{fill:none;stroke:var(--grid);stroke-width:.5}
#stage .part,#stage .callout{--p-ink:var(--ink);--p-mid:var(--mid);--p-lo:var(--lo)}
#stage .dim{--p-ink:var(--dim);--p-mid:var(--dim);--p-lo:var(--dim-lo)}
#stage .part path{fill:var(--paper);stroke:var(--p-mid);stroke-width:var(--psw);vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round;transition:stroke 260ms cubic-bezier(.5,0,.1,1) var(--dly,0ms),fill 260ms cubic-bezier(.5,0,.1,1) var(--dly,0ms)}
#stage .part .sil{stroke:var(--p-ink)}
#stage .part .lo{stroke:var(--p-lo)}
#stage .part .nf{fill:none}
#stage .part .fo{stroke:none}
#stage .part .eo{fill-rule:evenodd}
#stage .part .u2{stroke-width:calc(var(--psw)*2)}
#stage .part .dot{stroke:none;fill:var(--p-ink)}
#stage .part .dash{stroke:var(--p-lo);stroke-dasharray:1 3}
#stage .callout text{fill:var(--p-ink);transition:fill 260ms cubic-bezier(.5,0,.1,1) var(--dly,0ms)}
#stage .callout path{fill:none;stroke:var(--p-ink);stroke-width:.5;transition:stroke 260ms cubic-bezier(.5,0,.1,1) var(--dly,0ms)}
#stage .readout{fill:var(--ink)}
`;
const FLAT_CSS = `
#stage .part.hot .sil{stroke-width:calc(var(--psw)*2)}
#stage .part .cut{fill:var(--paper)}
#stage .part .hatch{stroke:var(--p-mid);stroke-width:calc(var(--psw)*.7)}
#stage .part .cutfill{fill:var(--p-ink)}
#stage .anno path{vector-effect:non-scaling-stroke}
#stage .anno .dimln{fill:none;stroke:var(--ink);stroke-width:.5}
#stage .anno .arrow{fill:var(--ink);stroke:none}
#stage .anno .sym{fill:none;stroke:var(--ink);stroke-width:.75}
#stage .anno .cl{fill:none;stroke:var(--lo);stroke-width:.5;stroke-dasharray:8 2 2 2}
#stage .anno .cpl{fill:none;stroke:var(--ink);stroke-width:.75;stroke-dasharray:16 3 3 3}
#stage .anno .cpl-end{fill:none;stroke:var(--ink);stroke-width:2.4;stroke-linecap:butt}
#stage .anno .cpl-hit{fill:none;stroke:transparent;stroke-width:18;pointer-events:stroke}
#stage .anno .cpl-hit.ns{cursor:ns-resize}
#stage .anno .cpl-hit.ew{cursor:ew-resize}
#stage .anno text{fill:var(--ink)}
#stage .anno .vlabel{fill:var(--lo)}
#stage.nolabels .callout,#stage.nolabels .lab,#stage.nolabels text.dimtx{display:none}
`;

function txt(parent, x, top, s, size = 12, anchor = "start", cls) {
  const e = el("text", { x: r2(x), y: r2(top + size * 0.94), "font-size": size, "text-anchor": anchor }, parent);
  if (cls) e.setAttribute("class", cls);
  e.textContent = s;
  return e;
}
function cross(parent, cx, cy, h = 12) { el("path", { d: `M${cx - h} ${cy}H${cx + h}M${cx} ${cy - h}V${cy + h}`, class: "rule" }, parent); }

function partCode(n, total, name, obj) {
  let h = 2166136261; for (const ch of name + "|" + obj) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const letter = String.fromCharCode(65 + Math.min(12, Math.floor(((n - 1) * 13) / Math.max(1, total))));
  return letter + String(Math.abs(h) % 100000).padStart(5, "0").replace(/^0/, "1");
}

function render(spec, { reveal = false } = {}) {
  state.spec = spec; state.act = null; play.until = 0;
  if (typeof closeDetail === "function") closeDetail();
  state.flatG = null; state.sec = null;
  const parts = spec.parts, n = parts.length;
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const p of parts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p.at[a]); hi[a] = Math.max(hi[a], p.at[a] + p.size[a]); }
  const oc = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  // the direction the product comes apart: up (z), out of the front (y) or out of the right side (x)
  const xa = spec.explode === "front" ? 1 : spec.explode === "side" ? 0 : 2;
  const { layer, max } = layering(parts, xa);

  /* layout, at S = 1: the separation per layer, then the frame and both camera scales */
  const P1 = projector(1, oc);
  const g1 = parts.map((p) => buildPart(p, 1, oc));
  const spots = parts.map(screwSpots);
  const ab = bbox(g1.flatMap((g) => g.pts));
  const fpH = bbox([[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]].map(([x, y]) => P1(x, y, 0))).h;
  const unit = [0, 0, 0]; unit[xa] = 1;
  const p0 = P1(oc[0], oc[1], oc[2]), p1 = P1(oc[0] + unit[0], oc[1] + unit[1], oc[2] + unit[2]);
  const EV1 = [p1[0] - p0[0], p1[1] - p0[1]]; // screen offset of one millimetre along the explode axis
  let sep, gap;
  if (xa === 2) { sep = max ? Math.min(0.62 * fpH, (1.55 * ab.h) / max) : 0; gap = sep / ZF; }
  else { const D = hi[xa] - lo[xa]; gap = max ? Math.min(0.62 * D, (1.4 * D) / max) : 0; sep = gap * Math.hypot(EV1[0], EV1[1]); }
  const rise = xa === 2 ? gap * 0.5 : Math.min(gap * 0.5, 20);
  /*
   * How far each part travels at full explode. Up: one even step per layer. Out of the
   * front or side: far enough to clear everything behind it, so a shelf comes all the way
   * out of its cabinet before the door in front of it moves on.
   */
  const offs = layer.map((l) => l * gap);
  if (xa !== 2 && max) {
    const [qa, qb] = [0, 1, 2].filter((k) => k !== xa), D = hi[xa] - lo[xa], m = Math.max(10, 0.04 * D);
    const fpx = parts.map((p) => [p.at[qa], p.at[qb], p.at[qa] + p.size[qa], p.at[qb] + p.size[qb]]);
    const byLayer = [...parts.keys()].sort((i, j) => layer[i] - layer[j]);
    for (const i of byLayer) {
      if (!layer[i]) { offs[i] = 0; continue; }
      let o = 0;
      for (const j of byLayer) {
        if (layer[j] >= layer[i] || !overlaps(fpx[i], fpx[j])) continue;
        const pj = parts[j], pi = parts[i];
        o = Math.max(o, offs[j] + pj.at[xa] + pj.size[xa] - pi.at[xa] + m, offs[j] + 0.35 * gap);
      }
      offs[i] = o;
    }
  }
  const pushes = xa === 2 ? slideOut(parts, layer, gap, sep, g1, P1, oc, lo, hi) : parts.map(() => [0, 0]);
  // a seated screw stays over its holes: it slides only when the part it fastens slides
  parts.forEach((p, i) => { if (p.kind === "screw" && p.host != null && pushes[p.host]) pushes[i] = pushes[p.host].slice(); });
  const xp = [];
  g1.forEach((g, i) => { const v = P1(oc[0] + pushes[i][0], oc[1] + pushes[i][1], oc[2]); for (const [x, y] of g.pts) xp.push([x + v[0] + offs[i] * EV1[0], y + v[1] + offs[i] * EV1[1]]); });
  spots.forEach((s, i) => { if (s) for (const [x, y] of s.pts) { const q = P1(x + pushes[i][0] + offs[i] * unit[0], y + pushes[i][1] + offs[i] * unit[1], s.z + offs[i] * unit[2] + rise + s.len); xp.push(q); } });
  const xb = bbox(xp);
  /*
   * One fixed camera for the whole slide: it frames every pose from assembled to fully
   * exploded at once (the box around both ends), so the object never pans or zooms.
   * Only the parts move. The geometry is drawn at that scale, so the camera is k = 1.
   */
  const ub = bbox([[ab.x0, ab.y0], [ab.x1, ab.y1], [xb.x0, xb.y0], [xb.x1, xb.y1]]);
  const Wu = W - 2 * GUT, sw = Wu / ub.w;
  const H = Math.round(clamp(BAR + 2 * PADY + ub.h * sw, 560, 900));
  const Hd = H - BAR - 2 * PADY;
  const Sa = 0.97 * Math.min(sw, Hd / ub.h);
  Object.assign(state, {
    H, Sa, gap, rise, max, kx: 1, C: [W / 2, BAR + PADY + Hd / 2], xa, EV: [EV1[0] * Sa, EV1[1] * Sa],
    Ox: [((ub.x0 + ub.x1) / 2) * Sa, ((ub.y0 + ub.y1) / 2) * Sa],
  });

  /* the frame */
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  el("style", {}, svg).textContent = STAGE_CSS + FLAT_CSS;
  const defs = el("defs", {}, svg);
  const pat = el("pattern", { id: "bp-grid", width: 20, height: 20, patternUnits: "userSpaceOnUse", x: 0, y: BAR }, defs);
  el("path", { d: "M20 0H0V20", class: "grid-line" }, pat);
  state.paperEl = el("rect", { x: 0, y: 0, width: W, height: H, class: "paper" }, svg);
  state.gridEl = el("rect", { x: 0, y: BAR, width: W, height: H - BAR, class: "grid" }, svg);
  state.ruleEl = el("rect", { x: 0.25, y: 0.25, width: W - 0.5, height: H - 0.5, class: "rule" }, svg);
  el("path", { d: `M0 ${BAR}H${W}`, class: "rule" }, svg);
  state.isoH = H;
  state.titleEl = txt(svg, 6, 5.3, `exploded view: ${spec.object}`);
  state.readout = txt(svg, W - 6, 5.3, "rest", 12, "end", "readout");
  cross(svg, W - 28, BAR + 28);

  /* the parts, at the assembled scale, about one origin */
  const P = projector(Sa, oc);
  const layerG = el("g", {}, svg);
  state.layerG = layerG;
  const nodes = [];
  const items = parts.map((p, i) => {
    const g = buildPart(p, Sa, oc);
    const it = {
      i, p, layer: layer[i], d: max ? 1 - layer[i] / max : 0, hull: hull(g.pts), hole: g.hole,
      off: offs[i], tray: p.kind === "tray", axis: p.axis, fp0: footprint(p), fp: footprint(p), inner: trayInner(p), z0: p.at[2], z1: p.at[2] + p.size[2], zo: 0, dx: 0,
      push: pushes[i], pv: P(oc[0] + pushes[i][0], oc[1] + pushes[i][1], oc[2]), pushed: !!(pushes[i][0] || pushes[i][1]),
      lift: tween(0), e: 0, eL: 0, dz: 0, dy: 0, liftSa: 0, drops: [], screws: [],
    };
    it.hb = bbox(it.hull);
    it.back = el("g", { class: "part" }, layerG);
    it.dropG = el("g", {}, it.back);
    for (const [d, cls] of g.ops.slice(0, g.cut)) el("path", { d, class: cls }, it.back);
    if (it.tray) { it.front = el("g", { class: "part" }, layerG); for (const [d, cls] of g.ops.slice(g.cut)) el("path", { d, class: cls }, it.front); }
    it.nb = nodes.push(it.back) - 1;
    it.nf = it.front ? nodes.push(it.front) - 1 : it.nb;
    // screws float over the part's top, each on a dashed line back to its hole
    const s = spots[i];
    if (s) for (const [x, y] of s.pts) {
      const sub = el("g", {}, it.front || it.back), drop = el("path", { class: "nf dash" }, sub);
      const sg = Geo(Sa, oc);
      screwAt(sg, [x - s.d / 2, y - s.d / 2, s.z], s.d, s.len);
      for (const [d, cls] of sg.ops) el("path", { d, class: cls }, sub);
      it.screws.push({ sub, drop, s: P(x, y, s.z), top: P(x, y, s.z + s.len) });
    }
    return it;
  });

  /* dashed drops from each part's outermost back corners to the part behind it along the
     explode axis (beneath it, when exploding up); a part that slid out gets one guide from
     its centre, back along the slide and down; a seated screw drops into its own hole */
  const [qa, qb] = [0, 1, 2].filter((k) => k !== xa);
  const behind = (it, q) => {
    let best = null;
    for (const o of items) {
      if (o.layer >= it.layer || o.pushed) continue;
      const p = o.p;
      if (q[qa] < p.at[qa] - 0.3 || q[qa] > p.at[qa] + p.size[qa] + 0.3 || q[qb] < p.at[qb] - 0.3 || q[qb] > p.at[qb] + p.size[qb] + 0.3) continue;
      const end = p.at[xa] + p.size[xa];
      if (!best || o.layer > best.layer || (o.layer === best.layer && end > best.p.at[xa] + best.p.size[xa])) best = o;
    }
    return best;
  };
  const drop = (it, from, to, j) => it.drops.push({ el: el("path", { class: "nf dash" }, it.dropG), s: P(...from), t: P(...to), j });
  items.forEach((it) => {
    if (!it.layer && !it.pushed) return;
    if (it.p.kind === "screw" && it.p.spots && it.p.host != null) {
      const zt = faceFrame(parts[it.p.host], "top").w0;
      for (const [x, y] of it.p.spots) drop(it, [x, y, it.z0], [x, y, zt], it.p.host);
      return;
    }
    if (it.pushed) {
      const x = (it.fp0[0] + it.fp0[2]) / 2, y = (it.fp0[1] + it.fp0[3]) / 2, best = beneath(it, x, y);
      it.drops.push({ el: el("path", { class: "nf dash" }, it.dropG), s: P(x, y, it.z0), j: best ? best.i : -1, slide: true });
      return;
    }
    let pts;
    if (xa === 2) pts = bottomOutline(it.p).map(([x, y]) => [x, y, it.z0]);
    else {
      const p = it.p, c = [];
      for (const u of [p.at[qa], p.at[qa] + p.size[qa]]) for (const v of [p.at[qb], p.at[qb] + p.size[qb]]) { const q = [0, 0, 0]; q[qa] = u; q[qb] = v; q[xa] = p.at[xa]; c.push(q); }
      pts = c;
    }
    const scr = pts.map((q) => [q, P(...q)]);
    const ends = [scr.reduce((a, b) => (b[1][0] < a[1][0] ? b : a)), scr.reduce((a, b) => (b[1][0] > a[1][0] ? b : a))];
    for (const [q] of ends) {
      const best = behind(it, q);
      if (!best) continue;
      const t = q.slice(); t[xa] = best.p.at[xa] + best.p.size[xa];
      drop(it, q, t, best.i);
    }
  });
  function beneath(it, x, y) {
    let best = null;
    for (const o of items) {
      if (o.layer >= it.layer || o.pushed) continue;
      const f = o.fp0;
      if (x < f[0] - 0.3 || x > f[2] + 0.3 || y < f[1] - 0.3 || y > f[3] + 0.3) continue;
      if (!best || o.layer > best.layer || (o.layer === best.layer && o.z1 > best.z1)) best = o;
    }
    return best;
  }
  // parts shut inside a closed solid at rest stay hidden by it until they come clear
  for (const A of items) {
    A.enc = new Set();
    const a = A.p;
    for (const B of items) {
      const b = B.p;
      if (A === B || !(b.kind === "box" || b.kind === "cyl")) continue;
      let inside = true;
      for (let k = 0; k < 3 && inside; k++) inside = a.at[k] >= b.at[k] - 0.3 && a.at[k] + a.size[k] <= b.at[k] + b.size[k] + 0.3;
      if (inside && a.size[0] * a.size[1] * a.size[2] < b.size[0] * b.size[1] * b.size[2]) A.enc.add(B.i);
    }
  }

  /* a fixed priority for ties in the paint order */
  const rank = items.slice().sort((a, b) => a.layer - b.layer || a.z0 - b.z0 || (a.fp[0] + a.fp[1] + a.fp[2] + a.fp[3]) - (b.fp[0] + b.fp[1] + b.fp[2] + b.fp[3]));
  const keys = new Array(nodes.length).fill(0);
  rank.forEach((it, r) => { keys[it.nb] = r * 2; if (it.nf !== it.nb) keys[it.nf] = r * 2 + 1; });
  Object.assign(state, { items, nodes, keys, orderKey: "", orderT: -1, orderDirty: true, camKey: "" });

  /* callouts, laid out on the exploded pose */
  const kx = state.kx, C = state.C, Ox = state.Ox, SZ = Sa * ZF;
  const EV = state.EV, toStage = (q, it) => [C[0] + kx * (q[0] + it.pv[0] + it.off * EV[0] - Ox[0]), C[1] + kx * (q[1] + it.pv[1] + it.off * EV[1] - Ox[1])];
  const polys = items.map((it) => it.hull.map((q) => toStage(q, it)));
  // the paint order at full explode: a leader must end on a part where nothing nearer covers it
  for (const it of items) {
    it.e = 1; it.eL = it.pushed ? 1 : 0; it.dz = it.off; it.dx = it.dz * EV[0]; it.dy = it.dz * EV[1];
    it.zo = xa === 2 ? it.dz : 0; it.ox = it.pv[0] * it.eL; it.oy = it.pv[1] * it.eL;
    const px = it.push[0] * it.eL + (xa === 0 ? it.dz : 0), py = it.push[1] * it.eL + (xa === 1 ? it.dz : 0), f = it.fp0;
    it.fp = [f[0] + px, f[1] + py, f[2] + px, f[3] + py];
  }
  const rankAt = new Map();
  paintOrder().forEach((u, k) => rankAt.set(u, k));
  const hidden = (it, pt) => items.some((o) => o !== it && rankAt.get(o.nb) > rankAt.get(it.nf) && pointInPoly(pt, polys[o.i]));
  const all = bbox(polys.flat());
  const colL = Math.max(34, all.x0 - 24), colR = Math.min(W - 34, all.x1 + 24);
  /*
   * Every leader is one horizontal line. Each part offers anchor heights along its
   * silhouette; a leader from the left or right column runs level to the first edge it
   * meets there. Cost: other parts the line crosses, then length. Labels on one side
   * keep LGAP apart; a part with no free height takes a second, outer column.
   */
  const LGAP = 17, edgeAt = (pg, y, left) => {
    let x = null;
    for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
      const a = pg[j], b = pg[i];
      if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue;
      const v = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      if (x === null || (left ? v < x : v > x)) x = v;
    }
    return x;
  };
  for (const it of items) {
    const pg = polys[it.i], bb = bbox(pg), mid = (bb.y0 + bb.y1) / 2;
    it.cands = [];
    const span = Math.max(0, bb.y1 - bb.y0 - 4);
    it.span = span;
    for (let s = 0; s <= 40; s++) {
      const y = bb.y0 + 2 + (span * s) / 40;
      if (y < BAR + 14 || y > H - 14) continue;
      for (const left of [true, false]) {
        const x = edgeAt(pg, y, left);
        if (x === null) continue;
        const col = left ? colL : colR, end = [x + (left ? -1.5 : 1.5), y];
        let c = 0;
        for (const o of items) if (o !== it && segHitsPoly([col, y], end, polys[o.i])) c++;
        const covered = hidden(it, [x + (left ? 2.5 : -2.5), y]) ? 1000 : 0;
        it.cands.push({ y, x, left, cost: covered + c * 100 + Math.abs(col - x) * 0.02 + Math.abs(y - mid) * 0.02 });
      }
    }
    it.best = it.cands.reduce((a, b) => (!a || b.cost < a.cost ? b : a), null);
  }
  /*
   * Labels on one side never come closer than LGAP, whatever their column, so no number
   * sits on another or on its leader. The smallest parts choose first, since they have the
   * fewest heights to choose from. A part left with no free height keeps its label at the
   * nearest free one and takes a square jog beside the part: horizontal, vertical, horizontal.
   */
  const taken = { true: [], false: [] }, runs = { true: [], false: [] }, jogs = { true: [], false: [] };
  const between = (v, a, b) => v > Math.min(a, b) + 0.5 && v < Math.max(a, b) - 0.5;
  const free = (left, y, x) => taken[left].every((t) => Math.abs(t - y) >= LGAP)
    && jogs[left].every(([jx, y0, y1]) => !(between(y, y0, y1) && between(jx, left ? colL : colR, x)));
  const crossings = (left, jx, y0, y1) => runs[left].filter(([y, a, b]) => between(y, y0, y1) && between(jx, a, b)).length;
  const place = (it, c, dy = 0, jx = 0) => {
    const ly = c.y + dy, col = c.left ? colL : colR;
    taken[c.left].push(ly);
    runs[c.left].push([ly, col, jx ? c.x + jx : c.x]);
    if (jx) { jogs[c.left].push([c.x + jx, c.y, ly]); runs[c.left].push([c.y, c.x + jx, c.x]); }
    it.side = c.left ? "left" : "right";
    it.lx = col;
    it.ly = ly;
    it.ax0 = c.x; it.jx0 = jx ? c.x + jx : null;
    it.elbow = jx ? { dy, jx } : null;
    // the anchor in the part's own coordinates, so it rides with the part
    it.anchor = [(c.x - C[0]) / kx + Ox[0] - it.pv[0] - it.off * EV[0], (c.y - C[1]) / kx + Ox[1] - it.pv[1] - it.off * EV[1]];
  };
  for (const it of items.slice().sort((a, b) => a.span - b.span || (a.best ? a.best.cost : 0) - (b.best ? b.best.cost : 0))) {
    if (!it.best) { const pg = polys[it.i], b = bbox(pg), y = (b.y0 + b.y1) / 2; it.best = { y, x: edgeAt(pg, y, true) ?? b.x0, left: true, cost: 0 }; it.cands = [it.best]; }
    const by = it.best.y;
    let pick = null;
    for (const c of it.cands) if (free(c.left, c.y, c.x) && (!pick || c.cost + Math.abs(c.y - by) * 0.1 < pick.cost + Math.abs(pick.y - by) * 0.1)) pick = c;
    if (pick) { place(it, pick); delete it.cands; continue; }
    // no free height on this part: the nearest free one, on either side, with the fewest crossings
    let best = null;
    for (const left of [true, false]) {
      const base = it.cands.filter((c) => c.left === left).reduce((a, b) => (!a || b.cost < a.cost ? b : a), null);
      if (!base) continue;
      const jx = left ? -10 : 10;
      for (let d = LGAP; d < H; d += 2) for (const sgn of [-1, 1]) {
        const y = base.y + sgn * d;
        if (y < BAR + 14 || y > H - 14 || !free(left, y, base.x + jx)) continue;
        const cost = d + 60 * crossings(left, base.x + jx, base.y, y) + base.cost;
        if (!best || cost < best.cost) best = { c: base, dy: y - base.y, jx, cost };
      }
    }
    if (best) place(it, best.c, best.dy, best.jx); else place(it, it.best);
    delete it.cands;
  }
  /*
   * The labels scatter: each one sits just clear of the drawing at its own height, then
   * steps out by its own amount, so the numbers fall at loose, uneven x positions rather
   * than in one ruled column. The amount comes from the part's name, so it never changes.
   */
  const clearOf = (left, y) => {
    let edge = null;
    for (const pg of polys) for (const yy of [y - 11, y - 3.5, y + 4]) {
      const x = edgeAt(pg, yy, left);
      if (x !== null && (edge === null || (left ? x < edge : x > edge))) edge = x;
    }
    for (const pg of polys) for (const [x, yy] of pg) if (yy >= y - 11 && yy <= y + 4 && (edge === null || (left ? x < edge : x > edge))) edge = x;
    return edge;
  };
  const jitter = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; };
  for (const it of items) {
    const left = it.side === "left", edge = clearOf(left, it.ly);
    const reach = it.jx0 != null ? it.jx0 : it.ax0;
    // the nearest the label may come: clear of every part at its height and of its own leader's end
    let near = left ? Math.min(reach - 16, edge === null ? reach - 16 : edge - 14) : Math.max(reach + 16, edge === null ? reach + 16 : edge + 14);
    const r = jitter(it.p.name + "|" + it.i), step = 8 + r * r * 86;
    let lx = left ? near - step : near + step;
    lx = left ? clamp(lx, 30, W / 2 - 30) : clamp(lx, W / 2 + 30, W - 30);
    // a square jog from another label must not pass through this number
    for (const o of items) {
      if (o === it || !o.elbow || o.side !== it.side) continue;
      const y0 = Math.min(o.ly, o.ly - o.elbow.dy), y1 = Math.max(o.ly, o.ly - o.elbow.dy);
      if (it.ly + 4 > y0 && it.ly - 11 < y1 && Math.abs(o.jx0 - (left ? lx - 10 : lx + 10)) < 16) lx = left ? Math.max(30, o.jx0 - 30) : Math.min(W - 30, o.jx0 + 30);
    }
    it.lx = lx;
  }
  items.slice().sort((a, b) => a.ly - b.ly || (a.side === "left" ? -1 : 1)).forEach((it, k) => (it.num = k + 1));

  const cl = el("g", {}, svg);
  state.calloutG = cl;
  for (const it of items) {
    it.c = el("g", { class: "callout", opacity: 0 }, cl);
    const left = it.side === "left";
    it.labelEl = txt(it.c, left ? it.lx - 3 : it.lx + 3, it.ly - 7.6, pad2(it.num), 12, left ? "end" : "start");
    it.leader = el("path", { d: "" }, it.c);
    it.lbox = [0, 0, 0, 0];
  }
  svg.setAttribute("aria-label", `${spec.object}: exploded drawing of ${n} parts in ${max + 1} layers.`);
  renderInventory();
  applyView();

  if (reveal) { setSpring(SOFT); ex.x = 0; ex.v = 0; ex.t = 0; state.revealAt = performance.now() + 700; }
  else { setSpring(FIRM); ex.x = ex.t = slider.value / 100; ex.v = 0; state.revealAt = 0; }
  tick(0, performance.now());
  board.wake();
}

/* ------------------------------------------------------- paint order */

/**
 * How two parts stand to each other right now. Disjoint footprints: a vertical plane
 * separates them and the one nearer the camera paints later. Overlapping footprints:
 * the higher paints later, or a part inside an open shell paints between its walls.
 */
function relate(A, B) {
  const fa = A.fp, fb = B.fp, e = 0.02;
  if (!overlaps(fa, fb, e)) {
    if (fa[2] <= fb[0] + e) return ["all", A, B];
    if (fb[2] <= fa[0] + e) return ["all", B, A];
    if (fa[3] <= fb[1] + e) return ["all", A, B];
    return ["all", B, A];
  }
  const za = A.zo != null ? A.zo : A.dz, zb = B.zo != null ? B.zo : B.dz;
  const a0 = A.z0 + za, a1 = A.z1 + za, b0 = B.z0 + zb, b1 = B.z1 + zb;
  if (a0 >= b1 - e) return ["above", A, B];
  if (b0 >= a1 - e) return ["above", B, A];
  // a part shut inside a closed solid stays behind it until it comes clear
  if (A.enc && A.enc.has(B.i)) return ["above", B, A];
  if (B.enc && B.enc.has(A.i)) return ["above", A, B];
  if (B.tray && inTray(A, B, a0, a1, b0, b1)) return ["inside", A, B];
  if (A.tray && inTray(B, A, b0, b1, a0, a1)) return ["inside", B, A];
  return a0 + a1 <= b0 + b1 ? ["weak", A, B] : ["weak", B, A];
}
/** Whether A sits within open shell B right now: inside its sides, in front of its floor. */
function inTray(A, B, a0, a1, b0, b1) {
  const ra = [[A.fp[0], A.fp[2]], [A.fp[1], A.fp[3]], [a0, a1]], rb = [[B.fp[0], B.fp[2]], [B.fp[1], B.fp[3]], [b0, b1]];
  const k = B.axis === "x" ? 0 : B.axis === "y" ? 1 : 2;
  for (let j = 0; j < 3; j++) {
    if (j === k) { if (ra[j][0] < rb[j][0] - 0.3) return false; }
    else if (ra[j][0] < rb[j][0] - 0.5 || ra[j][1] > rb[j][1] + 0.5) return false;
  }
  return true;
}
function topo(N, edges, keys, force) {
  const adj = Array.from({ length: N }, () => []), indeg = new Array(N).fill(0);
  for (const [u, v] of edges) { adj[u].push(v); indeg[v]++; }
  const done = new Array(N).fill(false), out = [];
  while (out.length < N) {
    let best = -1;
    for (let u = 0; u < N; u++) if (!done[u] && indeg[u] === 0 && (best < 0 || keys[u] < keys[best])) best = u;
    if (best < 0) {
      if (!force) return null;
      for (let u = 0; u < N; u++) if (!done[u] && (best < 0 || keys[u] < keys[best])) best = u;
    }
    done[best] = true; out.push(best);
    for (const v of adj[best]) indeg[v]--;
  }
  return out;
}
/** Whether two parts' outlines meet on screen right now; parts that never meet need no order. */
function meet(A, B) {
  const ax = A.ox + (A.dx || 0), ay = A.dy + A.oy, bx = B.ox + (B.dx || 0), by = B.dy + B.oy, a = A.hb, b = B.hb, e = 0.5;
  if (a.x0 + ax >= b.x1 + bx - e || a.x1 + ax <= b.x0 + bx + e || a.y0 + ay >= b.y1 + by - e || a.y1 + ay <= b.y0 + by + e) return false;
  const pa = A.hull.map(([x, y]) => [x + ax, y + ay]), pb = B.hull.map(([x, y]) => [x + bx, y + by]);
  const c = clipConvex(pa, pb);
  return c.length > 2 && Math.abs(signedArea(c)) > 1;
}
function paintOrder() {
  const items = state.items, strong = [], weak = [];
  for (const it of items) if (it.nf !== it.nb) strong.push([it.nb, it.nf]);
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (!meet(items[i], items[j])) continue;
    const [kind, A, B] = relate(items[i], items[j]);
    if (kind === "all") strong.push([A.nf, B.nb]);
    else if (kind === "weak") weak.push([A.nf, B.nb]);
    else if (kind === "inside") { strong.push([B.nb, A.nb]); strong.push([A.nf, B.nf]); }
    else {
      // A sits above B: B's body first; B's near wall before A only where A overhangs it
      strong.push([B.nb, A.nb]);
      if (B.tray) strong.push(within(A.fp, B.fp, 0.5) ? [B.nf, A.nf] : [B.nf, A.nb]);
    }
  }
  const N = state.nodes.length;
  return topo(N, strong.concat(weak), state.keys, false) || topo(N, strong, state.keys, false) || topo(N, strong, state.keys, true);
}
function applyOrder() {
  let ord = paintOrder();
  // the next frame breaks ties the way this one did, so nothing flickers between equal orders
  ord.forEach((u, k) => (state.keys[u] = k));
  const pos = new Array(state.nodes.length);
  ord.forEach((u, k) => (pos[u] = k));
  state.hitOrder = state.items.slice().sort((a, b) => pos[a.nf] - pos[b.nf]);
  const a = state.act;
  if (a) ord = ord.filter((u) => u !== a.nb && u !== a.nf).concat(a.nf !== a.nb ? [a.nb, a.nf] : [a.nb]);
  const key = ord.join(",");
  if (key !== state.orderKey) { state.orderKey = key; for (const u of ord) state.layerG.appendChild(state.nodes[u]); }
}

/* ------------------------------------------------------------ motion */

const smooth = (t) => t * t * (3 - 2 * t);
const sstep = (a, b, x) => smooth(clamp((x - a) / (b - a), 0, 1));
function tick(dt, now) {
  const items = state.items;
  if (!items.length) return false;
  let moving = stepS(ex, dt);
  if (state.revealAt) {
    if (now >= state.revealAt) { state.revealAt = 0; ex.t = 1; }
    moving = true;
  } else if (play.on) {
    if (!moving) {
      if (!play.until) play.until = now + (ex.t > 0.5 ? 1800 : 1100);
      else if (now >= play.until) { play.until = 0; setSpring(SOFT); ex.t = ex.t > 0.5 ? 0 : 1; }
    }
    moving = true;
  } else if (!moving && ex.k !== FIRM.k) setSpring(FIRM);
  const T = ex.x;
  const SZ = state.Sa * ZF;
  for (const it of items) {
    it.e = smooth(clamp(T * (1 + SPREAD) - it.d * SPREAD, 0, 1));
    it.eL = it.pushed ? sstep(0.4, 1, it.e) : 0;
    it.dz = it.off * it.e; // millimetres along the explode axis
    it.dx = it.dz * state.EV[0]; it.dy = it.dz * state.EV[1];
    it.zo = state.xa === 2 ? it.dz : 0;
    it.ox = it.pv[0] * it.eL; it.oy = it.pv[1] * it.eL;
    const px = it.push[0] * it.eL + (state.xa === 0 ? it.dz : 0), py = it.push[1] * it.eL + (state.xa === 1 ? it.dz : 0), f = it.fp0;
    it.fp = [f[0] + px, f[1] + py, f[2] + px, f[3] + py];
  }
  // the camera holds still: the same frame at every point of the slide
  const k = state.kx, O = state.Ox;
  state.cam = { k, O };
  const camKey = `translate(${r2(state.C[0])} ${r2(state.C[1])}) scale(${Math.round(k * 10000) / 10000}) translate(${r2(-O[0])} ${r2(-O[1])})`;
  if (camKey !== state.camKey) { state.camKey = camKey; state.layerG.setAttribute("transform", camKey); }
  for (const it of items) {
    it.liftSa = tval(it.lift, now) / k;
    if (!tdone(it.lift, now)) moving = true;
  }
  for (const it of items) {
    const tx = r2(it.ox + it.dx), ty = r2(it.dy + it.oy - it.liftSa), tr = `translate(${tx} ${ty})`;
    setA(it.back, "transform", tr);
    if (it.front) setA(it.front, "transform", tr);
    for (const dr of it.drops) {
      const s = items[dr.j];
      if (dr.slide) {
        const len = (it.z0 + it.dz - (s ? s.z1 + s.dz : it.z0)) * SZ + it.liftSa;
        setA(dr.el, "d", it.eL > 0.02 || len > 0.8 ? `M${r2(dr.s[0])} ${r2(dr.s[1])}l${r2(-it.ox)} ${r2(-it.oy)}v${r2(Math.max(0, len))}` : "");
        continue;
      }
      // the far end stays on the part behind, wherever each of the two has moved
      const ex = dr.t[0] + (s ? s.ox + s.dx : 0) - (it.ox + it.dx), ey = dr.t[1] + (s ? s.dy + s.oy - s.liftSa : 0) - (it.dy + it.oy - it.liftSa);
      setA(dr.el, "d", Math.hypot(ex - dr.s[0], ey - dr.s[1]) > 0.8 ? `M${r2(dr.s[0])} ${r2(dr.s[1])}L${r2(ex)} ${r2(ey)}` : "");
    }
    const rs = state.rise * it.e * SZ;
    for (const sc of it.screws) {
      setA(sc.sub, "transform", `translate(0 ${r2(-rs)})`);
      setA(sc.drop, "d", rs > 0.8 ? `M${r2(sc.s[0])} ${r2(sc.s[1])}v${r2(rs)}` : "");
    }
    // the label rides level with its anchor, so the leader is always one horizontal line
    const a = it.anchor, ax = r2(state.C[0] + k * (a[0] + tx - O[0])), ay = r2(state.C[1] + k * (a[1] + ty - O[1]));
    const left = it.side === "left", x0 = r2(left ? it.lx + 2 : it.lx - 2), ly = r2(ay + (it.elbow ? it.elbow.dy : 0));
    setA(it.labelEl, "y", String(r2(ly - 7.6 + 12 * 0.94)));
    // straight, or a square jog beside the part when the label had to move to a free height
    const jx = it.elbow ? r2(ax + it.elbow.jx) : 0;
    setA(it.leader, "d", !(left ? ax > x0 : ax < x0) ? "" : it.elbow && (left ? jx > x0 : jx < x0) ? `M${x0} ${ly}H${jx}V${ay}H${ax}` : `M${x0} ${ly}H${ax}`);
    it.lbox = left ? [it.lx - 24, ly - 10, it.lx + 6, ly + 10] : [it.lx - 6, ly - 10, it.lx + 24, ly + 10];
    setA(it.c, "opacity", String(r2(sstep(0.55, 1, it.e))));
  }
  if (state.orderDirty || Math.abs(T - state.orderT) > 1e-4) { state.orderT = T; state.orderDirty = false; applyOrder(); }
  if (ex.k === SOFT.k) { const v = String(Math.round(clamp(T, 0, 1) * 100)); if (slider.value !== v) slider.value = v; }
  return moving;
}
const board = register($("stagewrap"), tick);

/* -------------------------------------------------------------- hover */

function setActive(a) {
  if (a === state.act) return;
  state.act = a;
  const now = performance.now();
  for (const it of state.items) {
    const on = a === it, dim = !!a && !on;
    const dly = a ? Math.min(320, Math.abs(it.num - a.num) * 24) + "ms" : "0ms";
    for (const node of [it.back, it.front, it.c]) if (node) { node.classList.toggle("dim", dim); node.style.setProperty("--dly", dly); }
    if (it.rowEl) it.rowEl.classList.toggle("on", on);
    tset(it.lift, on ? LIFT : 0, now, 0);
  }
  state.readout.textContent = a ? `${pad2(a.num)} · ${a.p.name}` : "rest";
  highlightFlat(a);
  state.orderDirty = true;
  board.wake();
}
function pick(pt) {
  if (state.labels) for (const it of state.items) if (it.e > 0.6 && inBox(pt, it.lbox)) return it;
  if (pt[1] < BAR) return null;
  const { k, O } = state.cam, C = state.C;
  const q = [O[0] + (pt[0] - C[0]) / k, O[1] + (pt[1] - C[1]) / k], tol = 3 / k;
  // the pose without the hover lift: a lifted part never slides out from under the pointer
  for (let idx = state.hitOrder.length - 1; idx >= 0; idx--) {
    const it = state.hitOrder[idx], qq = [q[0] - it.ox - it.dx, q[1] - it.dy - it.oy];
    if (it.hole && pointInPoly(qq, it.hole)) continue;
    if (nearPoly(qq, it.hull, tol)) return it;
  }
  return null;
}
function toStage(e) {
  const m = svg.getScreenCTM(); if (!m) return null;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return [p.x, p.y];
}
svg.addEventListener("pointermove", (e) => { if (state.view !== "iso") return; const p = toStage(e); if (p) setActive(pick(p)); });
svg.addEventListener("pointerdown", (e) => { if (state.view !== "iso") return; const p = toStage(e); if (p) setActive(pick(p)); });
svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") setActive(null); });

/*FLAT*/

/* --------------------------------------------------------- inventory */

function renderInventory() {
  const box = $("inv"); box.replaceChildren();
  const list = state.items.slice().sort((a, b) => a.num - b.num), half = Math.ceil(list.length / 2);
  // once any real part number is known, the made-up catalogue codes step aside
  const realPN = list.some((it) => it.p.pn);
  for (const chunk of [list.slice(0, half), list.slice(half)]) {
    if (!chunk.length) continue;
    const ol = document.createElement("ol");
    for (const it of chunk) {
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.setAttribute("aria-label", `${pad2(it.num)}, ${it.p.name}, quantity ${it.p.qty}`);
      for (const [cls, text] of [["n", pad2(it.num)], ["name", it.p.name], ["code", it.p.pn || (realPN ? "" : partCode(it.num, list.length, it.p.name, state.spec.object))], ["q", "x" + it.p.qty]]) {
        const s = document.createElement("span"); s.className = cls; s.textContent = text; li.appendChild(s);
        if (cls === "code" && it.p.pn) { s.classList.add("pn"); s.title = "Part number: " + it.p.pn; }
        if (cls === "name") s.title = it.p.name;
      }
      li.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") setActive(it); });
      li.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") setActive(null); });
      li.addEventListener("click", () => { setActive(it); openDetail(it, null, li); });
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(it, null, li); } });
      li.addEventListener("focus", () => setActive(it));
      li.addEventListener("blur", () => setActive(null));
      it.rowEl = li;
      ol.appendChild(li);
    }
    box.appendChild(ol);
  }
  $("invMeta").textContent = `${list.length} parts · ${state.max + 1} layers`;
  renderSources();
}
/** The pages behind this drawing, as links under the inventory. */
function renderSources() {
  const box = $("sources"), src = (state.spec && state.spec.sources) || [];
  box.replaceChildren();
  box.hidden = !src.length && !(state.spec && state.spec.refUsed);
  if (box.hidden) return;
  box.append("reference: ");
  if (!src.length) box.append("pasted spec notes");
  src.forEach((u, i) => {
    if (i) box.append(", ");
    const a = document.createElement("a");
    a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer";
    let label = u;
    try { const url = new URL(u); label = url.hostname.replace(/^www\./, "") + decodeURIComponent(url.pathname).replace(/\/$/, "").replace(/_/g, " ").replace(/\+/g, " "); } catch {}
    a.textContent = label.length > 72 ? label.slice(0, 69) + "..." : label;
    box.append(a);
  });
}

/* ---------------------------------------------------------- controls */

slider.addEventListener("input", () => { stopPlay(); state.revealAt = 0; setSpring(FIRM); ex.t = slider.value / 100; board.wake(); });
const playBtn = $("play");
function stopPlay() { play.on = false; play.until = 0; playBtn.setAttribute("aria-pressed", "false"); playBtn.textContent = "play"; }
playBtn.addEventListener("click", () => {
  if (play.on) { stopPlay(); return; }
  play.on = true; play.until = 0; state.revealAt = 0;
  playBtn.setAttribute("aria-pressed", "true"); playBtn.textContent = "pause";
  setSpring(SOFT); ex.t = ex.x > 0.5 ? 0 : 1;
  board.wake();
});

function setTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-sheet");
  else document.documentElement.setAttribute("data-sheet", t);
  document.querySelectorAll("[data-theme-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeBtn === t)));
  store.set("bp.theme", t);
}
document.querySelectorAll("[data-theme-btn]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.themeBtn)));

const status = (s, busy = false) => { $("status").textContent = s; $("status").dataset.busy = busy ? "1" : ""; };
const summary = (spec) => `${spec.object}: ${spec.parts.length} parts in ${state.max + 1} layers.`;

function show(spec, opts) {
  render(spec, opts);
  $("specText").value = JSON.stringify(denormalize(spec), null, 1);
  $("specErr").textContent = "";
  store.set("bp.last", denormalize(spec));
  if (typeof setMode === "function" && sampleFn !== undefined) setMode();
}

/* presets and recent drawings */
function chips() {
  const box = $("chips"); box.replaceChildren();
  const add = (label, spec, title) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = label; if (title) b.title = title;
    b.addEventListener("click", () => { try { stopPlay(); const s = normalize(spec); show(s, { reveal: true }); status(summary(s)); } catch (e) { status(e.message); } });
    box.appendChild(b);
  };
  for (const p of PRESETS) add(p.object, p, "Built-in example");
  for (const r of store.get("bp.recent", [])) if (r && r.object && !r.tools && !PRESETS.some((p) => p.object === r.object)) add(r.object, r, "Made earlier on this device");
}
function remember(spec) {
  const d = denormalize(spec), list = store.get("bp.recent", []).filter((r) => r && r.object !== d.object);
  list.unshift(d); store.set("bp.recent", list.slice(0, 6)); chips();
}

/* reference photos: several at once, picked, dropped or pasted */
let photos = [], maxImg = 5;
const photoURLs = new Map();
function renderThumbs() {
  const box = $("thumbs"); box.replaceChildren();
  for (const [k, ph] of photos.entries()) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "thumb"; b.title = "Remove this photo"; b.setAttribute("aria-label", `Remove photo ${k + 1}`);
    if (!photoURLs.has(ph)) photoURLs.set(ph, URL.createObjectURL(ph));
    const im = document.createElement("img"); im.src = photoURLs.get(ph); im.alt = "";
    b.appendChild(im);
    b.addEventListener("click", () => { URL.revokeObjectURL(photoURLs.get(ph)); photoURLs.delete(ph); photos.splice(photos.indexOf(ph), 1); renderThumbs(); });
    box.appendChild(b);
  }
  $("photoCount").textContent = photos.length ? `${photos.length}/${maxImg}` : "";
  $("photoAdd").textContent = photos.length ? "+" : "add photos";
  $("photoAdd").hidden = photos.length >= maxImg;
}
async function addFiles(list) {
  const files = [...list].filter((f) => f && (/^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(f.name || "")));
  if (!files.length) return;
  let bad = 0, over = 0;
  for (const f of files) {
    if (photos.length >= maxImg) { over++; continue; }
    try { photos.push(await shrink(f)); } catch (e) { bad++; console.warn("[blueprint-ify] photo did not open", f.name, e); }
  }
  renderThumbs();
  const n = photos.length;
  status(bad ? `${bad === 1 ? "One photo" : bad + " photos"} did not open. Try JPEG or PNG.` : over ? `Up to ${maxImg} photos per drawing. ${over} left out.` : `${n} reference photo${n === 1 ? "" : "s"} ready. Name the object too if you know it.`);
}
$("photoInput").addEventListener("change", (e) => { const f = [...(e.target.files || [])]; e.target.value = ""; addFiles(f); });
const photoReady = () => sampleFn && imagesOK;
$("console").addEventListener("dragover", (e) => { if (photoReady()) { e.preventDefault(); $("console").dataset.drop = "1"; } });
$("console").addEventListener("dragleave", () => { $("console").dataset.drop = ""; });
$("console").addEventListener("drop", (e) => { $("console").dataset.drop = ""; if (!photoReady()) return; e.preventDefault(); addFiles(e.dataTransfer.files); });
document.addEventListener("paste", (e) => {
  if (!photoReady()) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type));
  if (files.length) { e.preventDefault(); addFiles(files); }
});
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.88));
}

/* Claude: the format both passes share */
const FORMAT = `Axes: x runs left to right, y back to front, z up, in millimetres. The viewer looks down from the front right: they see the top (+z), the front (the y-max side) and the right end (the x-max side).

Orientation: draw the product the right way up, standing as it stands in normal use, with z pointing up. Anything that stands on the floor, a counter or a desk stands upright, tall along z, with its front (doors, display, controls, grille) facing +y: a fridge, oven, washing machine, dishwasher, tower PC, monitor, speaker, lamp, kettle, coffee machine, toaster, bottle, chair. Only products that lie flat in use or in the hand lie with their main face on top: a phone, tablet, closed laptop, remote, handheld console, keyboard, calculator, watch face.

"explode": how the product comes apart in a service manual. "up" (the default): straight up along z, for products that open from the top or lie flat. "front": out of the front along +y, for products whose doors, drawers, shelves and panels come off the front (a fridge, oven, washing machine, dishwasher, cabinet, drawer unit). "side": out of the right side along +x, for products opened from the side (a tower PC with its side panel off).

"at" is the [x,y,z] of a part's lowest corner and "size" its [x,y,z] extent, placed exactly where the part sits when assembled. Parts come apart in layers along the explode direction: each part moves past every part it overlaps and sits on or in front of, so the order along that axis must be right. Parts never pass through each other: a part that rests on another starts at that part's top, and a part held inside a shell starts past the shell's floor. Shells, housings, frames, cabinets and covers are "tray" parts so the parts inside them stay visible; a part shut inside a closed "box" stays hidden until it comes out.

Part fields:
- "name": 1 to 3 words, Title Case.
- "qty": how many (default 1).
- "pn": optional, the real part or model number printed on the part or listed in a teardown or parts catalogue (for example "A1238" or "821-0457-A"). Only when you know it. Never invent one.
- "kind": "box" (rounded block), "cyl" (cylinder), "tray" (an open shell with walls: housings, back covers, frames, cabinets), "flex" (ribbon cable) or "screw".
- "axis": for box and cyl, the direction of the straight edges: "z" (default, upright), "x" or "y" (lying down). A cyl's diameter is the smaller of its two other extents.
- "r": corner radius in mm, for box and tray. Match the real corners: a phone's corners are round, a cassette's are nearly square.
- "bevel": optional mm the top edge of a box is softened or chamfered (axis z): soft-edged shells, bevelled glass, rounded backs.
- "taper": optional mm the top face shrinks inward on each side (box with axis z): keycaps, knobs, wedges.
- "outline": optional [[x,y], ...] footprint of a box that is not a rectangle (axis z), in mm from "at", corners rounded by "r": L-shaped boards, curved grips, teardrops, wedges. Its points set the part's x and y extent.
- "shape": "plus" for a cross-shaped box such as a d-pad.
- "wall": wall thickness for a tray. "floor": false for a frame with no bottom. A tray's "axis" is the side that is open: "z" (the default, open at the top), "y" (open at the front: a fridge, oven or washing machine body) or "x" (open at the right side).
- "path": for a flex, the [[x,y], ...] points of its centreline relative to "at", plus "width" in mm.
- Screws. Every screw sits in a real screw hole: a "hole" feature, d 1 to 3.5, on the top face of the part it passes through, at the screw's true position. Either give that part "screws": the number of its screw holes that take screws (0 to 8), or list the screws as their own "screw" part (better when the screw type matters, as in a teardown): "size" [head diameter, head diameter, length], "qty", and "spots": [[x, y], ...], the world x and y of each screw, exactly over a hole of the part it rests on. Never list the same screws both ways.
- "features": what makes the part recognisable. On the outer shell parts, every visible feature of the real product, at its true size and position (up to 16). Fewer on inside parts. Each is {"t", "face", "at", ...}.
  "face": "top" (default), "front" (the y-max side) or "side" (the x-max end). "at" is the feature's centre [u,v] in mm from the face's lowest corner: on top, u runs along x and v along y; on front, u along x and v along z; on side, u along y and v along z. On a flex, "at" uses the path's coordinates. On a tray, top features sit on its floor.
  Types: "hole" {"d"}; "ring" {"d","d2","h"} (two circles, outer d and inner d2: click wheels, dials, bezels, lens rings; "h" above 0 raises it); "slot" {"size":[w,h], "r"}; "cross" {"size":[span, arm]}; "grille" {"size":[w,h], "pitch"} (a dot grid: speakers, vents); "boss" {"size":[w,h,height], "r"} (raised block: chips, connectors, buttons); "pin" {"d","h"} (raised cylinder: lenses, posts, knobs); "inset" {"by"} (a panel line set in from the face edge: screens, labels); "line" {"to":[u,v]} (a groove or seam).
  Add "z" to a boss, pin or ring to start it above the face, for stacked details such as a lens on a camera block.
  Keep features inside their face. No text, logos or symbols.

Example parts:
{"name":"Shield Screw","kind":"screw","qty":2,"at":[60,10,6],"size":[1.6,1.6,2.2],"spots":[[60,10],[90,40]]}
{"name":"Battery","kind":"box","at":[54,6,4.4],"size":[42,45,4.2],"r":3.5,"features":[{"t":"inset","by":2.5},{"t":"boss","at":[4,10],"size":[5,8,0.4],"r":0.5}]}
{"name":"Rear Case","kind":"tray","at":[0,0,0],"size":[115,61,6.8],"r":10,"wall":1.1,"screws":2,"features":[{"t":"hole","at":[9.5,50.5],"d":6.5},{"t":"hole","at":[20,6],"d":1.8},{"t":"hole","at":[95,55],"d":1.8}]}
{"name":"Front Panel","kind":"box","at":[0,0,8],"size":[61.8,103.5,2],"r":8,"bevel":0.8,"features":[{"t":"inset","at":[0,0],"by":6},{"t":"ring","at":[30.9,72],"d":38,"d2":13.5}]}`;

/* the person's own reference text: pasted from iFixit teardowns, guides and device pages */
const REF_MAX = 40000;
const refBlock = (ref) => ref ? `

Reference text. The person pasted this from repair and specification pages: teardowns and repair guides (often iFixit), device pages or the maker's spec sheet. It is the authority on this product. Take part names, the order parts come off, part and screw counts, model and part numbers, and every measurement from it, over your memory. Skip page navigation, comments, prices, ads and anything about other products. If it describes a different product from the object named, say so in "notes" and set it aside.
<reference>
${ref}
</reference>` : "";

const PROMPT = (name, nPhotos, { ref = "", browse = false } = {}) => {
  const what = name || (nPhotos ? `the object in the attached photo${nPhotos > 1 ? "s" : ""}` : ref ? "the product described in the reference text below" : "the object");
  const pics = nPhotos ? ` ${nPhotos === 1 ? "A reference photo is" : nPhotos + " reference photos are"} attached: identify the exact model from ${nPhotos === 1 ? "it" : "them"}, and take proportions, feature positions and details from what you see.` : "";
  const web = browse ? `

Before you answer, if you can search the web: find this product's iFixit teardown and device page (ifixit.com), and its official technical specifications. Use them as the authority for part names, the order parts come off, part numbers and dimensions, and list the pages you used in "sources".` : "";
  return `You build exploded-view drawings of real products, like a repair manual. Accuracy to the real product matters most: the assembled drawing must be recognisable as this exact model at a glance. Object: ${what}.${pics}${web}

Reply with only one JSON object, no prose, with its keys in this order:
{"notes": string, "object": string, "explode": "up" | "front" | "side", ${browse ? '"sources": [url, ...], ' : ""}"parts": [...]}

"notes": write this first, as a dense paragraph, before any parts. Name the exact model and generation you are drawing. Give its real overall size in mm (length x width x thickness) from published specifications or teardowns. Describe the outer silhouette: corner radii, bevels, curved or flat back, tapers. List every feature visible on the outside, each with its size and position in mm from the left back corner of its face: screens, buttons, wheels, ports, grilles, lenses, seams, feet. Then list the inside stack from bottom to top as a real teardown would find it.${ref || browse ? " Say which facts come from the reference pages." : ""} The parts must follow these notes exactly.

"object": the product's short display name, with model or year when it helps, for example "iPod Classic (2007)".
${browse ? `
"sources": the web addresses of the pages you used, if any.
` : ""}
"parts": at least 20 parts, up to 32, at the level of detail of a good teardown (such as iFixit's). Break assemblies into the real components that come apart: the display stack (cover glass, panel, backlight or frame), each board and daughterboard, shields and brackets, cables and connectors, buttons with their membranes or switches, speakers, microphones, cameras, motors, gaskets and adhesive where they are real parts, and the screws, grouped by type. Reach 20 by going deeper into what is really there, never by inventing: split screws by type and location, and list the brackets, clips, springs, gaskets, adhesive strips, connectors and membranes the product really has. Every part must exist in this exact model. Only an object with fewer than 20 real components in all (a pencil, a spoon) gets fewer. The outer shell parts carry the likeness: get their size, proportions, corner radii, bevels and visible features exactly right. Inside parts follow the real internal layout of this model${ref || browse ? ", in the order the teardown takes them out" : " where you know it"}.

${FORMAT}${refBlock(ref)}`;
};

const REFINE = (spec, name, nRefs, fix, ref = "", ortho = false) => `You are checking an exploded-view drawing of a real product against the real thing, then correcting its spec. The product: ${spec.object}${name && name.toLowerCase() !== spec.object.toLowerCase() ? ` (asked for as "${name}")` : ""}.

Image 1 is the drawing assembled. Image 2 is the same drawing exploded, with numbered parts.${ortho ? " Image 3 shows it as orthographic views in third-angle projection, with overall sizes in mm: the top view above the front view (the front is the y-max side), the right side view to the right of the front view. Check proportions there." : ""}${nRefs ? ` ${nRefs === 1 ? `Image ${ortho ? 4 : 3} is a reference photo` : `Images ${ortho ? 4 : 3} to ${(ortho ? 3 : 2) + nRefs} are reference photos`} of the real product.` : ""}${fix ? `

The person asked for this change: "${fix}". Make it, and keep everything else that is right.` : ""}

First check the product stands the right way up, as it stands in use, and comes apart in the right direction ("explode"). Compare image 1 with the real product${nRefs ? " in the photos" : " as you know it from its published specifications and photos"}: overall proportions (length, width, thickness), outer silhouette and corner radii, edge bevels, and the position, size and shape of every visible feature (screens, buttons, wheels, ports, grilles, lenses, seams). Look for what is missing, extra, misplaced, mis-sized, mirrored or on the wrong face. Then check the exploded view: the stack order and the inside parts.${ref ? " Check part names, counts, part numbers, stack order and sizes against the reference text below." : ""}

Reply with only one JSON object, no prose: the complete corrected spec, in the same format as the current spec below, with its keys in this order: "notes" (a short list of what you changed and why), "object", "explode", "parts". Keep what is right. Fix what is off. Where the real product has components a teardown would show that the drawing lumps together or leaves out, split or add them, so the drawing has at least 20 parts when the real product has that many; remove parts the real product does not have. Every screw must sit over a screw hole of the part beneath it.

${FORMAT}

Current spec:
${JSON.stringify(denormalize(spec))}${refBlock(ref)}`;

/*
 * Two routes to a new drawing. In a Claude view the page asks Claude itself (sample).
 * Anywhere else (a public link opened signed out, a browser on its own) the page hands
 * the viewer the prompt to paste into any chat, and draws from the reply they paste back.
 */
let sampleFn, imagesOK = false, dlFn;
const MANUAL_CODES = new Set(["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"]);
let modeNoted = false;
function setMode() {
  const manual = sampleFn === null;
  $("go").textContent = manual ? "copy prompt →" : "blueprint-ify →";
  if (manual && !modeNoted && state.spec) {
    modeNoted = true;
    status(OUTSIDE
      ? `${summary(state.spec)} To draw your own object, paste an API key in the claude api key box, or press copy prompt to use any AI chat.`
      : `${summary(state.spec)} Claude is not available to this page for you, so press copy prompt to draw with any AI chat. Signed in to Claude, the page draws on its own.`);
  }
  $("photoField").dataset.off = manual || !imagesOK ? "1" : "";
  $("refineForm").hidden = !(sampleFn && imagesOK && state.spec);
}
async function useSample(s) {
  sampleFn = s;
  const lim = s ? await s.limits().catch(() => null) : null;
  imagesOK = !!(lim && lim.images);
  if (imagesOK) {
    maxImg = clamp(lim.images.maxCount || 5, 1, 8);
    if (lim.images.mediaTypes && lim.images.mediaTypes.length) $("photoInput").accept = lim.images.mediaTypes.concat(["image/heic", "image/heif"]).join(",");
  }
  setMode(); renderThumbs(); paintApi();
}
/*
 * Three ways to draw. Inside Claude, the page asks Claude on the viewer's own account.
 * Opened on its own (a clone, GitHub Pages, a saved file), it calls the Claude API with
 * the viewer's own key, or through the host's proxy when config.js names one. With none
 * of these, it hands over the prompt for any AI chat and draws from the pasted reply.
 */
const OUTSIDE = !window.claude;
const API_CFG = (OUTSIDE && window.BLUEPRINTIFY && typeof window.BLUEPRINTIFY === "object") ? window.BLUEPRINTIFY : {};
const API_PROXY = typeof API_CFG.api === "string" ? API_CFG.api.trim().replace(/\/+$/, "") : "";
const API_MODELS = Object.assign({ quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" }, API_CFG.models || {});
function apiSample() {
  const key = String(store.get("bp.apikey", "") || ""), code = String(store.get("bp.apicode", "") || "");
  if (!API_PROXY && !key) return null;
  const fail = (c, message) => Object.assign(new Error(message || c), { code: c });
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(fail("image_rejected")); r.readAsDataURL(blob); });
  async function call(input, o = {}) {
    const images = o.images ? (o.images instanceof Blob ? [o.images] : [...o.images]) : [];
    const content = [];
    for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: img.type || "image/png", data: await b64(img) } });
    content.push({ type: "text", text: String(input) });
    const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
    if (API_PROXY) { if (code) headers["x-access-code"] = code; }
    else { headers["x-api-key"] = key; headers["anthropic-dangerous-direct-browser-access"] = "true"; }
    let res;
    try {
      res = await fetch((API_PROXY || "https://api.anthropic.com") + "/v1/messages", {
        method: "POST", headers, signal: o.signal,
        body: JSON.stringify({ model: API_MODELS[o.modelTier] || API_MODELS.default, max_tokens: 32000, stream: true, messages: [{ role: "user", content }] }),
      });
    } catch (e) { throw o.signal && o.signal.aborted ? fail("cancelled") : fail("upstream_error", "Claude could not be reached."); }
    if (!res.ok) {
      let msg = "";
      try { const j = await res.json(); msg = (j.error && j.error.message) || ""; } catch {}
      if (res.status === 401 || res.status === 403) throw fail(API_PROXY ? "bad_code" : "bad_key", msg);
      if (res.status === 429) throw fail("rate_limited", msg);
      if (res.status === 413 || /too long|too large|exceed/i.test(msg)) throw fail("prompt_too_large", msg);
      if (res.status === 400 && /image/i.test(msg)) throw fail("image_rejected", msg);
      throw fail("upstream_error", msg || `HTTP ${res.status}`);
    }
    // the answer streams in as server-sent events; only its text counts
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", text = "", stop = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const data = buf.slice(0, k).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          buf = buf.slice(k + 2);
          if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { text += ev.delta.text; if (o.onText) o.onText({ text, delta: ev.delta.text }); }
          else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
          else if (ev.type === "error") throw fail(ev.error && ev.error.type === "rate_limit_error" ? "rate_limited" : "upstream_error", ev.error && ev.error.message);
        }
      }
    } catch (e) { if (o.signal && o.signal.aborted) throw fail("cancelled"); throw e.code ? e : fail("upstream_error", e.message); }
    if (stop === "refusal") throw fail("refused");
    if (!text.trim()) throw fail("empty_completion");
    return { text, truncated: stop === "max_tokens" };
  }
  call.json = async (input, o) => { const r = await call(input, o); try { return parseReply(r.text); } catch { throw fail("invalid_json"); } };
  call.limits = async () => ({ images: { maxCount: 5, maxInputBytes: 5000000, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } });
  return call;
}
function paintApi() {
  const f = $("apiField");
  f.hidden = !OUTSIDE;
  if (!OUTSIDE) return;
  const saved = !!store.get(API_PROXY ? "bp.apicode" : "bp.apikey", "");
  $("apiLabel").textContent = API_PROXY ? "access code:" : "claude api key:";
  $("apiAside").textContent = API_PROXY
    ? "this copy draws through its host's own Claude account. Enter a code if the host gave you one."
    : "to draw here without Claude, paste your own Anthropic API key. It stays in this browser and goes only to api.anthropic.com.";
  $("apiKey").placeholder = API_PROXY ? "access code, if you have one" : "sk-ant-...";
  $("apiKey").value = "";
  $("apiState").textContent = saved ? (API_PROXY ? "code saved" : "key saved") : API_PROXY ? "" : "no key";
  $("apiForget").hidden = !saved;
}
$("apiSave").addEventListener("click", () => {
  const v = $("apiKey").value.trim();
  if (!v) { status(API_PROXY ? "Type the access code first." : "Paste your API key first."); $("apiKey").focus(); return; }
  store.set(API_PROXY ? "bp.apicode" : "bp.apikey", v);
  useSample(apiSample());
  status(API_PROXY ? "Access code saved." : "API key saved in this browser. Name an object and press blueprint-ify.");
});
$("apiKey").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("apiSave").click(); } });
$("apiForget").addEventListener("click", () => {
  try { localStorage.removeItem(API_PROXY ? "bp.apicode" : "bp.apikey"); } catch {}
  useSample(apiSample());
  status(API_PROXY ? "Access code removed." : "API key removed from this browser.");
});
if (OUTSIDE) useSample(apiSample());
else {
  claudeUse("sample").then(useSample);
  setTimeout(() => { if (sampleFn === undefined) { sampleFn = null; setMode(); } }, 2500);
}
claudeUse("downloads").then((d) => (dlFn = d));
setTimeout(() => { if (dlFn === undefined) dlFn = null; }, 2500);

/** Copies text inside the click that asked for it; returns false when the browser refuses. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/* the job line: which pass is running, what it is doing, how long it has taken */
let ctl = null, job = null;
function startJob(passes) {
  ctl = new AbortController();
  job = { passes, pass: 1, label: "", t0: performance.now(), timer: setInterval(paintJob, 1000) };
  $("go").hidden = true; $("stop").hidden = false; $("refineGo").disabled = true;
  $("job").hidden = false; status("");
  paintJob();
}
function jobStep(pass, label) { if (!job) return; job.pass = pass; job.label = label; paintJob(); }
function jobLabel(label) { if (!job) return; job.label = label; paintJob(); }
function paintJob() {
  if (!job) return;
  const sec = Math.round((performance.now() - job.t0) / 1000);
  $("jobText").textContent = `${job.passes > 1 ? `pass ${job.pass} of ${job.passes} · ` : ""}${job.label} · ${sec}s`;
}
function endJob() {
  if (job) clearInterval(job.timer);
  job = null; ctl = null;
  $("go").hidden = false; $("stop").hidden = true; $("refineGo").disabled = false; $("job").hidden = true;
}
const ERR = {
  not_granted: "Claude access was declined for this page. Press copy prompt to use your own chat instead.",
  bad_key: "Your API key was not accepted. Check it in the claude api key box, or remove it to use copy prompt.",
  bad_code: "The access code was not accepted. Check it in the access code box.",
  rate_limited: "Too many requests at once. Wait a moment, then try again.",
  invalid_json: "Claude's answer did not come back as a parts list. Try again, or name the object more precisely.",
  images_unavailable: "Photos are not available in this view. Name the object instead.",
  image_rejected: "A photo was not accepted. Use JPEG, PNG, WebP or GIF under 20 MB, then try again.",
  prompt_too_large: "The request is too large. Try fewer or smaller photos.",
  session_expired: "Your Claude session ended. Sign in again, then try again.",
  refused: "Claude declined this one. Try a different name or photo.",
  empty_completion: "Claude sent back nothing. Try again.",
  upstream_error: "The connection to Claude dropped. Try again.",
  cancelled: "Stopped.",
};
function errText(e) {
  const code = e && e.code;
  if (code && MANUAL_CODES.has(code)) { sampleFn = null; setMode(); return "Claude is not available here. Press copy prompt to use your own chat instead."; }
  if (code) return ERR[code] || `Claude could not finish this one (${code}). Try again.`;
  return (e && e.message) || "That did not work. Try again.";
}
const progress = (text, passLabel) => {
  const parts = [...text.matchAll(/"name"\s*:\s*"([^"]{1,40})"/g)].map((m) => m[1]);
  if (parts.length) return `${passLabel} part ${parts.length}: ${parts[parts.length - 1]}`;
  return /"notes"/.test(text) ? "studying the real object" : "thinking";
};

async function blueprintify(sample) {
  const name = $("obj").value.trim(), R = refNow();
  if (!name && !photos.length && !R.text) { status("Name an object, add a photo or paste spec notes first."); $("obj").focus(); return; }
  if (photos.length && !imagesOK) { status(ERR.images_unavailable); return; }
  const refs = photos.slice(0, maxImg);
  const check = imagesOK;
  startJob(check ? 2 : 1);
  const reading = [refs.length ? `${refs.length} photo${refs.length === 1 ? "" : "s"}` : "", R.text ? "your spec notes" : ""].filter(Boolean).join(" and ");
  jobStep(1, reading ? `reading ${reading}` : "thinking");
  let spec = null;
  try {
    const raw = await sample.json(PROMPT(name, refs.length, { ref: R.text }), {
      signal: ctl.signal, cache: false, modelTier: "default", ...(refs.length ? { images: refs } : {}),
      onText: ({ text }) => jobLabel(progress(text, "drafting")),
    });
    spec = drawFrom(raw, { reveal: true, sources: R.urls, refUsed: !!R.text });
    if (check) {
      jobStep(2, "checking the drawing against the real object");
      await refineOnce(sample, spec, name, refs, "");
    }
  } catch (e) {
    console.warn("[blueprint-ify] draw failed", e);
    status(spec ? `Kept the first draft. The check did not finish: ${errText(e)}` : errText(e));
  } finally { endJob(); }
}

/** One check pass: Claude sees the drawing (assembled and exploded) and the photos, and returns a corrected spec. */
async function refineOnce(sample, spec, name, refs, fix) {
  // the reference photos come first; the orthographic sheet joins when a slot is left
  const shots = await renderShots(maxImg - 2 - refs.length > 0), R = refNow();
  const keepRefs = refs.slice(0, Math.max(0, maxImg - shots.length));
  const raw = await sample.json(REFINE(spec, name, keepRefs.length, fix, R.text, shots.length > 2), {
    signal: ctl.signal, cache: false, modelTier: "complex", images: shots.concat(keepRefs),
    onText: ({ text }) => jobLabel(progress(text, "correcting")),
  });
  const target = state.revealAt ? 1 : ex.t;
  const next = drawFrom(raw, { reveal: false, sources: (spec.sources || []).concat(R.urls), refUsed: spec.refUsed || !!R.text });
  if (Math.abs(ex.t - target) > 1e-3 && !play.on) { setSpring(SOFT); ex.t = target; board.wake(); }
  const note = typeof raw.notes === "string" ? raw.notes.replace(/\s+/g, " ").trim() : "";
  status(`${summary(next)}${note ? " Checked and corrected: " + (note.length > 180 ? note.slice(0, 177) + "..." : note) : " Checked against the real object."}`);
  return next;
}
/** Pictures of the drawing for the check pass: assembled and exploded, dark lines on white. */
async function renderShots(withOrtho = false) {
  const keep = { x: ex.x, t: ex.t, v: ex.v, k: ex.k, c: ex.c, playing: play.on, reveal: state.revealAt };
  const view = { view: state.view, proj: state.proj };
  play.on = false; state.revealAt = 0;
  const light = "--paper:#ffffff;--ink:#141414;--mid:#2a2a2a;--lo:#8a8a8a;--dim:#b4b4b4;--dim-lo:#cdcdcd;--grid:transparent;";
  const texts = [];
  // all of this runs in one task, so the page never paints the views it passes through
  if (state.view !== "iso") { state.view = "iso"; applyView(); }
  for (const T of [0, 1]) { ex.x = ex.t = T; ex.v = 0; settle(); texts.push(stageText(T ? 1.2 : 1.8, light)); }
  if (withOrtho) { state.view = "ortho"; state.proj = "third"; applyView(); texts.push(stageText(1.2, light)); }
  if (state.view !== view.view || state.proj !== view.proj) { Object.assign(state, view); applyView(); }
  Object.assign(ex, { x: keep.x, t: keep.t, v: keep.v, k: keep.k, c: keep.c }); play.on = keep.playing; state.revealAt = keep.reveal;
  tick(0, performance.now()); board.wake();
  const [as, ...rest] = await Promise.all(texts.map(pngBlob));
  return [await cropInk(as, 1.8).catch(() => as), ...rest];
}
/** Crops a light render to its drawing, so the assembled object fills the picture Claude checks. */
async function cropInk(blob, scale) {
  const bmp = await createImageBitmap(blob), w = bmp.width, h = bmp.height;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true }); cx.drawImage(bmp, 0, 0);
  const px = cx.getImageData(0, 0, w, h).data;
  const top = Math.ceil((BAR + 4) * scale), edge = Math.ceil(4 * scale), crossX = w - 80 * scale, crossY = (BAR + 60) * scale;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = top; y < h - edge; y += 2) for (let x = edge; x < w - edge; x += 2) {
    if (x > crossX && y < crossY) continue;
    const i = (y * w + x) * 4;
    if (px[i] + px[i + 1] + px[i + 2] < 600) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return blob;
  const pad = 24 * scale; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w, x1 + pad); y1 = Math.min(h, y1 + pad);
  const o = document.createElement("canvas"); o.width = Math.round(x1 - x0); o.height = Math.round(y1 - y0);
  const ox = o.getContext("2d"); ox.fillStyle = "#fff"; ox.fillRect(0, 0, o.width, o.height);
  ox.drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return await new Promise((r, j) => o.toBlob((b) => (b ? r(b) : j()), "image/png"));
}
async function refineNow() {
  if (!sampleFn || !imagesOK || !state.spec || ctl) return;
  const fix = $("fix").value.trim(), name = $("obj").value.trim();
  startJob(1);
  jobStep(1, fix ? "making your change" : "checking the drawing against the real object");
  try { await refineOnce(sampleFn, state.spec, name, photos.slice(0, maxImg), fix); $("fix").value = ""; }
  catch (e) { console.warn("[blueprint-ify] refine failed", e); status(`The drawing is unchanged. ${errText(e)}`); }
  finally { endJob(); }
}
$("refineForm").addEventListener("submit", (e) => { e.preventDefault(); refineNow(); });

function drawFrom(raw, { reveal = true, sources = [], refUsed = false } = {}) {
  const spec = normalize(raw);
  const src = cleanSources(sources.concat(spec.sources || []));
  if (src.length) spec.sources = src;
  if (refUsed) spec.refUsed = true;
  stopPlay();
  show(spec, { reveal });
  remember(spec);
  status(summary(spec) + (refUsed ? " Built from your spec notes." : ""));
  setMode();
  return spec;
}

/* iFixit notes: text the person pastes from teardowns, guides and device pages */
function cleanRef(t) {
  return String(t || "").replace(/\r/g, "").split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function refNow() {
  const all = cleanRef($("ref").value);
  return { text: all.slice(0, REF_MAX), urls: cleanSources(all), cut: all.length > REF_MAX, n: all.length };
}
function paintRef() {
  const ta = $("ref"), R = refNow();
  ta.style.height = "auto";
  ta.style.height = Math.min(Math.max(ta.scrollHeight, 24), 150) + "px";
  const links = R.urls.length ? ` · ${R.urls.length} link${R.urls.length === 1 ? "" : "s"}` : "";
  $("refCount").textContent = R.n ? (R.cut ? `first ${REF_MAX.toLocaleString()} of ${R.n.toLocaleString()} characters used` : `${R.n.toLocaleString()} characters${links}`) : "";
  $("refClear").hidden = !R.n;
  $("refTabNote").textContent = R.n ? `${Math.min(R.n, REF_MAX).toLocaleString()} characters in use` : "";
}
/* folding panels: each panel's small square button tucks its body away; the choice is remembered on this device */
const PANEL_NAMES = { notes: "spec notes", examples: "examples", refine: "refine", inventory: "inventory", view: "view", api: "claude api key" };
function setFold(panel, folded) {
  const key = panel.dataset.panel, btn = panel.querySelector(".fold");
  panel.dataset.folded = folded ? "1" : "";
  btn.textContent = folded ? "+" : "\u2212";
  btn.setAttribute("aria-expanded", String(!folded));
  btn.setAttribute("aria-label", `${folded ? "Show" : "Hide"} ${PANEL_NAMES[key] || key}`);
  btn.title = folded ? "Show" : "Hide";
}
for (const panel of document.querySelectorAll("[data-panel]")) {
  const saved = store.get("bp.fold", {});
  setFold(panel, !!saved[panel.dataset.panel]);
  panel.querySelector(".fold").addEventListener("click", () => {
    const folded = panel.dataset.folded !== "1";
    if (folded && panel.contains(document.activeElement) && document.activeElement.closest(".fold-body")) panel.querySelector(".fold").focus();
    setFold(panel, folded);
    const all = store.get("bp.fold", {}); all[panel.dataset.panel] = folded; store.set("bp.fold", all);
    if (!folded && panel.dataset.panel === "notes") paintRef();
  });
}
$("ref").addEventListener("input", paintRef);
$("refClear").addEventListener("click", () => { $("ref").value = ""; paintRef(); $("ref").focus(); });


/* own-chat route */
let lastPrompt = "";
async function startManual() {
  const name = $("obj").value.trim();
  const R = refNow();
  lastPrompt = PROMPT(name, name || R.text ? 0 : 1, { ref: R.text, browse: true });
  const ok = await copyText(lastPrompt);
  $("manual").hidden = false;
  $("manualStep1").textContent = ok
    ? (name ? `The prompt for ${name} is on your clipboard.` : "The prompt is on your clipboard. With no name typed, it asks your chat to read a photo you attach.")
    : "Copy the prompt from the box below.";
  const pt = $("promptText");
  pt.hidden = ok; pt.value = lastPrompt;
  if (!ok) { pt.focus(); pt.select(); } else $("reply").focus();
  $("manualErr").textContent = "";
  status(ok ? "Prompt copied. Paste it into your chat." : "Copy the prompt from the box, then paste it into your chat.");
}
function parseReply(text) {
  const t = text.trim(), tries = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const s of tries) { try { return JSON.parse(s); } catch {} }
  throw new Error("That reply has no parts list in it. Paste the whole answer, from the first { to the last }.");
}
$("drawReply").addEventListener("click", () => {
  const text = $("reply").value;
  if (!text.trim()) { $("manualErr").textContent = "Paste the reply first."; $("reply").focus(); return; }
  try {
    const R = refNow();
    drawFrom(parseReply(text), { sources: R.urls, refUsed: !!R.text });
    $("reply").value = ""; $("manual").hidden = true;
    $("stagewrap").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { $("manualErr").textContent = e.message; }
});
$("copyPrompt").addEventListener("click", async () => {
  if (!lastPrompt) { const n = $("obj").value.trim(), R = refNow(); lastPrompt = PROMPT(n, n || R.text ? 0 : 1, { ref: R.text, browse: true }); }
  const ok = await copyText(lastPrompt);
  $("manualErr").textContent = ok ? "Copied." : "Your browser blocked the copy. Select the prompt in the box.";
  if (!ok) { const pt = $("promptText"); pt.hidden = false; pt.value = lastPrompt; pt.focus(); pt.select(); }
});
$("closeManual").addEventListener("click", () => { $("manual").hidden = true; });

$("console").addEventListener("submit", (e) => {
  e.preventDefault();
  if (sampleFn) blueprintify(sampleFn);
  else startManual();
});
$("stop").addEventListener("click", () => ctl && ctl.abort());

/* spec editor */
$("applySpec").addEventListener("click", () => {
  try { const spec = normalize(JSON.parse($("specText").value)); stopPlay(); show(spec, { reveal: false }); $("specErr").textContent = "Applied."; status(summary(spec)); }
  catch (e) { $("specErr").textContent = e instanceof SyntaxError ? "That is not valid JSON: " + e.message : e.message; }
});

/* export: the frame as it stands, assembled, exploded or in between */
function settle() {
  setActive(null);
  for (const it of state.items) it.lift = tween(0);
  tick(0, performance.now());
}
/** The frame as standalone SVG text. Pass vars to draw it in other colours than the page's. */
function stageText(scale, vars) {
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", NS);
  clone.setAttribute("width", W * scale); clone.setAttribute("height", state.H * scale);
  if (!vars) {
    const cs = getComputedStyle(document.documentElement);
    vars = ["paper", "ink", "mid", "lo", "dim", "dim-lo", "grid"].map((k) => `--${k}:${cs.getPropertyValue("--" + k).trim()};`).join("");
  }
  const ro = clone.querySelector(".readout"); if (ro) ro.textContent = "";
  const st = clone.querySelector("style");
  st.textContent = `@font-face{font-family:"Caliper Sans";src:url(data:font/otf;base64,${FONT_B64}) format("opentype")}#stage{${vars}--font:"Caliper Sans","Helvetica Neue",Arial,sans-serif}` + st.textContent + `#stage{--psw:${0.75 * scale}px}#stage *{transition:none!important}`;
  return new XMLSerializer().serializeToString(clone);
}
async function stageString(scale) { settle(); return stageText(scale); }
const base = () => (state.spec ? state.spec.object : "drawing").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const slug = () => base() + (state.view === "ortho" ? `-orthographic-${state.proj}-angle` : state.view === "section" ? "-section-a-a" : ex.x < 0.02 ? "-assembled" : ex.x > 0.98 ? "-exploded" : "-explode-" + Math.round(ex.x * 100));
async function pngBlob(svgText) {
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement("canvas"); c.width = img.naturalWidth || W * 2; c.height = img.naturalHeight || state.H * 2;
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j()), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
/* the save sheet: the drawing as an image to save by hand, and its SVG code to copy */
let sheetSvg = "", sheetUrl = "";
function openSheet(blob, svgText) {
  if (sheetUrl) URL.revokeObjectURL(sheetUrl);
  sheetUrl = URL.createObjectURL(blob);
  sheetSvg = svgText;
  // the outline SVG is white lines on nothing: preview it on a dark ground
  $("saveImg").style.background = blob.type === "image/svg+xml" ? "#141517" : "";
  $("saveImg").src = sheetUrl;
  $("saveErr").textContent = "";
  $("saveSheet").hidden = false;
  $("closeSave").focus();
}
function closeSheet() { $("saveSheet").hidden = true; }
$("closeSave").addEventListener("click", closeSheet);
$("saveSheet").addEventListener("click", (e) => { if (e.target === $("saveSheet")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("saveSheet").hidden) closeSheet(); });
$("copySvg").addEventListener("click", async () => { $("saveErr").textContent = (await copyText(sheetSvg)) ? "SVG code copied." : "Your browser blocked the copy."; });

/** Offers a file. In Claude: the save prompt. Elsewhere: a download, or the save sheet. */
async function save(filename, blob, svgText) {
  if (dlFn) {
    try { await dlFn.save({ filename, data: blob }); status(`Saved ${filename}.`); return; }
    catch (e) {
      const c = e && e.code;
      if (c === "declined") { status("Save cancelled."); return; }
      if (c === "rate_limited") { status("A save is already waiting for your answer."); return; }
    }
  }
  if (!window.claude) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    status(`Saved ${filename}.`);
    return;
  }
  openSheet(blob.type === "image/svg+xml" || blob.type === "image/png" ? blob : await pngBlob(svgText), svgText);
  status("Save the drawing from the sheet.");
}
$("saveInv").addEventListener("click", () => {
  if (!state.spec) return;
  let text;
  try { text = inventorySVG(); } catch (e) { console.warn("[blueprint-ify] inventory svg", e); status("The inventory SVG did not build."); return; }
  save(base() + "-inventory.svg", new Blob([text], { type: "image/svg+xml" }), text);
});
$("detailSvgBtn").addEventListener("click", () => {
  if (!detailFor) return;
  let text;
  try { text = detailWindowSVG(); } catch (e) { console.warn("[blueprint-ify] detail svg", e); status("The detail SVG did not build. Try the PNG instead."); return; }
  save(`${base()}-detail-${pad2(detailFor.num)}-${slugOf(detailFor.p.name)}.svg`, new Blob([text], { type: "image/svg+xml" }), text);
});
$("detailPngBtn").addEventListener("click", async () => {
  if (!detailFor) return;
  try { const blob = await detailPngBlob(3); save(`${base()}-detail-${pad2(detailFor.num)}-${slugOf(detailFor.p.name)}.png`, blob, ""); }
  catch (e) { console.warn("[blueprint-ify] detail png", e); status("The detail PNG did not render. Try the SVG instead."); }
});
function setLabels(on) {
  state.labels = on;
  store.set("bp.labels", on);
  svg.classList.toggle("nolabels", !on);
  $("detailSvg").classList.toggle("nolabels", !on);
  for (const b of document.querySelectorAll("[data-labels]")) b.setAttribute("aria-pressed", String((b.dataset.labels === "on") === on));
  if (!on && state.act) setActive(null);
}
for (const b of document.querySelectorAll("[data-labels]")) b.addEventListener("click", () => setLabels(b.dataset.labels === "on"));
setLabels(state.labels);
$("saveSvg").addEventListener("click", async () => {
  status("Tracing the outlines...", true);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  let text;
  try { text = outlineSVG(); } catch (e) { status("The SVG did not build. Try the PNG instead."); return; }
  save(slug() + ".svg", new Blob([text], { type: "image/svg+xml" }), text);
});

/*
 * The SVG is line art: white strokes, no fills, nothing behind a part showing through.
 * On screen a part hides what is behind it with a filled plate. Here every stroke is cut
 * where a plate painted after it covers it, so the file needs no fills, no CSS and no
 * variables, and opens the same in Figma, Illustrator or a browser.
 */
const OUT_EPS = 0.35;
function parsePath(d) {
  const tok = d.match(/[MLHVZmlhvzAa]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const subs = []; let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = "", i = 0;
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    switch (cmd) {
      case "M": x = num(); y = num(); cur = { pts: [[x, y]], closed: false }; subs.push(cur); sx = x; sy = y; cmd = "L"; break;
      case "m": x += num(); y += num(); cur = { pts: [[x, y]], closed: false }; subs.push(cur); sx = x; sy = y; cmd = "l"; break;
      case "L": x = num(); y = num(); cur.pts.push([x, y]); break;
      case "l": x += num(); y += num(); cur.pts.push([x, y]); break;
      case "H": x = num(); cur.pts.push([x, y]); break;
      case "h": x += num(); cur.pts.push([x, y]); break;
      case "V": y = num(); cur.pts.push([x, y]); break;
      case "v": y += num(); cur.pts.push([x, y]); break;
      case "Z": case "z": if (cur) cur.closed = true; x = sx; y = sy; cmd = ""; break;
      default: i++;
    }
  }
  return subs.filter((s) => s.pts.length > 1);
}
function matOf(node, root) {
  let m = new DOMMatrix();
  for (let n = node; n && n !== root; n = n.parentNode) {
    const tl = n.transform && n.transform.baseVal;
    if (tl && tl.numberOfItems) { const c = tl.consolidate().matrix; m = new DOMMatrix([c.a, c.b, c.c, c.d, c.e, c.f]).multiply(m); }
  }
  return m;
}
const applyM = (m, [x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
function insideEO(p, rings) {
  let c = false;
  for (const pg of rings) for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
    const [xi, yi] = pg[i], [xj, yj] = pg[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function distRings(p, rings) {
  let d = Infinity;
  for (const pg of rings) for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) d = Math.min(d, distSeg(p, pg[j], pg[i]));
  return d;
}
/** The stretches of segment a-b that a filled outline covers, as [t0, t1] pairs. */
function covered(a, b, occ) {
  const ts = [0, 1], dx = b[0] - a[0], dy = b[1] - a[1];
  for (const pg of occ.rings) for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
    const c = pg[j], e = pg[i], ex = e[0] - c[0], ey = e[1] - c[1], den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den, u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
    if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  const out = [];
  for (let k = 1; k < ts.length; k++) {
    const t0 = ts[k - 1], t1 = ts[k];
    if (t1 - t0 < 1e-7) continue;
    const m = [a[0] + dx * (t0 + t1) / 2, a[1] + dy * (t0 + t1) / 2];
    if (insideEO(m, occ.rings) && distRings(m, occ.rings) > OUT_EPS) out.push([t0, t1]);
  }
  return out;
}
const bbOf = (pts) => { const b = bbox(pts); return [b.x0, b.y0, b.x1, b.y1]; };
const bbHit = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const escX = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const FONT_FACE = () => `<style>@font-face{font-family:"Caliper Sans";src:url(data:font/otf;base64,${FONT_B64}) format("opentype")}</style>`;
const FAMILY = `font-family="Caliper Sans, Helvetica Neue, Arial, sans-serif"`;
/**
 * Paths as white strokes, each cut where a filled outline painted after it covers it.
 * ownerOf(node) names the part a path belongs to, so the file keeps one group per part.
 */
function traceStrokes(paths, root, ownerOf, base = null) {
  const ops = [];
  for (const node of paths) {
    const d = node.getAttribute("d"); if (!d) continue;
    const cls = node.getAttribute("class") || "";
    if (cls.includes("cpl-hit")) continue;
    const it = ownerOf(node), m = base ? base.multiply(matOf(node, root)) : matOf(node, root);
    if (cls.includes("dot")) {
      const dots = [];
      for (const r of d.matchAll(/M(-?[\d.]+) (-?[\d.]+)a([\d.]+)/g)) {
        const c = applyM(m, [parseFloat(r[1]) + parseFloat(r[3]), parseFloat(r[2])]);
        dots.push([c[0], c[1], parseFloat(r[3]) * Math.hypot(m.a, m.b)]);
      }
      ops.push({ it, dots });
      continue;
    }
    const subs = parsePath(d).map((sp) => ({ pts: sp.pts.map((p) => applyM(m, p)), closed: sp.closed }));
    if (!subs.length) continue;
    const fill = !cls.includes("nf"), stroke = !cls.includes("fo");
    const tone = cls.includes("dash") ? 0.5 : cls.includes("sil") || cls.includes("cpl") ? 1 : cls.includes("lo") || cls.includes("cl") || cls.includes("hatch") ? 0.45 : 0.8;
    const dash = cls.includes("dash") ? "1 3" : cls.includes("cpl-end") ? "" : cls.includes("cpl") ? "16 3 3 3" : cls.split(" ").includes("cl") ? "8 2 2 2" : "";
    ops.push({ it, subs, fill, stroke, tone, dash, width: cls.includes("cpl-end") ? 2.4 : 0.75, bb: bbOf(subs.flatMap((sp) => sp.pts)), rings: subs.map((sp) => sp.pts) });
  }
  const fills = ops.map((o, i) => [o, i]).filter(([o]) => o.fill && o.subs);
  const parts = new Map();
  const out = (it) => { const key = it ? it.num : 0; if (!parts.has(key)) parts.set(key, { it, els: [] }); return parts.get(key).els; };
  const all = [];
  const hiddenAt = (p, i) => fills.some(([o, j]) => j > i && p[0] >= o.bb[0] && p[0] <= o.bb[2] && p[1] >= o.bb[1] && p[1] <= o.bb[3] && insideEO(p, o.rings) && distRings(p, o.rings) > OUT_EPS);
  ops.forEach((op, i) => {
    if (op.dots) {
      for (const [x, y, r] of op.dots) if (!hiddenAt([x, y], i)) { out(op.it).push(`<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(Math.max(0.35, r))}" fill="#FFFFFF"/>`); all.push([x - r, y - r], [x + r, y + r]); }
      return;
    }
    if (!op.stroke) return;
    const occ = fills.filter(([o, j]) => j > i && bbHit(o.bb, op.bb)).map(([o]) => o);
    const runs = [];
    for (const sp of op.subs) {
      const pts = sp.closed ? sp.pts.concat([sp.pts[0]]) : sp.pts;
      let run = null;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], sb = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        let hid = [];
        for (const o of occ) if (bbHit(o.bb, sb)) hid = hid.concat(covered(a, b, o));
        hid.sort((p, q) => p[0] - q[0]);
        // the visible stretches are what the covered ones leave
        let t = 0;
        const vis = [];
        for (const [h0, h1] of hid) { if (h0 > t) vis.push([t, h0]); t = Math.max(t, h1); }
        if (t < 1) vis.push([t, 1]);
        const at = (u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
        // a fully hidden edge ends the line: never bridge across it
        if (!vis.some(([v0, v1]) => v1 - v0 >= 1e-6) && run) { runs.push(run.pts); run = null; }
        for (const [v0, v1] of vis) {
          if (v1 - v0 < 1e-6) continue;
          if (run && v0 === 0 && run.open) run.pts.push(at(v1));
          else { if (run) runs.push(run.pts); run = { pts: [at(v0), at(v1)], open: true }; }
          run.open = v1 === 1;
        }
        if (run && !run.open) { runs.push(run.pts); run = null; }
      }
      if (run) runs.push(run.pts);
    }
    const d = runs.filter((r) => r.length > 1).map((r) => "M" + r.map((p) => r2(p[0]) + " " + r2(p[1])).join("L")).join("");
    if (!d) return;
    for (const r of runs) for (const p of r) all.push(p);
    out(op.it).push(`<path d="${d}" fill="none" stroke="#FFFFFF" stroke-opacity="${op.tone}" stroke-width="${op.width}" stroke-linecap="round" stroke-linejoin="round"${op.dash ? ` stroke-dasharray="${op.dash}"` : ""}/>`);
  });
  return { parts, all };
}
/** Text nodes as white text at their own positions. */
function traceTexts(nodes, all) {
  const calls = [];
  for (const t of nodes) {
    if (!t.textContent) continue;
    const x = parseFloat(t.getAttribute("x")), y = parseFloat(t.getAttribute("y")), fs = t.getAttribute("font-size") || "10";
    const attrs = ["text-anchor", "dominant-baseline", "transform"].map((k) => (t.getAttribute(k) ? ` ${k}="${t.getAttribute(k)}"` : "")).join("");
    const op = t.classList.contains("vlabel") ? 0.6 : 1;
    calls.push(`<text x="${x}" y="${y}" font-size="${fs}"${attrs} ${FAMILY} fill="#FFFFFF" fill-opacity="${op}">${escX(t.textContent)}</text>`);
    all.push([x - 60, y - 8], [x + 60, y + 8]);
  }
  return calls;
}
function svgFile(all, title, parts, calls, pad = 24) {
  const b = bbox(all);
  const vb = [Math.floor(b.x0 - pad), Math.floor(b.y0 - pad), Math.ceil(b.w + 2 * pad), Math.ceil(b.h + 2 * pad)];
  const groups = [...parts.values()].sort((p, q) => (p.it ? p.it.num : 0) - (q.it ? q.it.num : 0))
    .map(({ it, els }) => `<g id="${it ? pad2(it.num) + "-" + slugOf(it.p.name) : "drawing"}">${els.join("")}</g>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" width="${vb[2]}" height="${vb[3]}">
<title>${escX(title)}</title>
${FONT_FACE()}
<g id="parts">
${groups}
</g>${calls.length ? `\n<g id="labels">${calls.join("")}</g>` : ""}
</svg>`;
}
function outlineSVG() {
  settle();
  const owner = new Map(), flat = state.view !== "iso" && state.flatG, lab = state.labels;
  for (const it of state.items) { owner.set(it.back, it); if (it.front) owner.set(it.front, it); }
  const ownerOf = flat ? (node) => { const g = node.closest("[data-i]"); return g ? state.items[+g.dataset.i] : null; }
    : (node) => { let g = node.parentNode; while (g && !owner.has(g)) g = g.parentNode; return g ? owner.get(g) : null; };
  const paths = [...(flat ? state.flatG : state.layerG).querySelectorAll("path")].filter((n) => lab || !n.closest(".lab"));
  const { parts, all } = traceStrokes(paths, svg, ownerOf);
  // labels sit on top of the drawing: the callouts' leaders and numbers, or the flat views' names and sizes
  const calls = flat && lab ? traceTexts(state.flatG.querySelectorAll("text"), all) : [];
  if (!flat && lab) for (const it of state.items) {
    const op = parseFloat(it.c.getAttribute("opacity") || "1");
    if (op < 0.05) continue;
    const ld = it.leader.getAttribute("d");
    if (ld) { calls.push(`<path d="${ld}" fill="none" stroke="#FFFFFF" stroke-opacity="${r2(op)}" stroke-width="0.5"/>`); for (const sp of parsePath(ld)) for (const p of sp.pts) all.push(p); }
    const tx = parseFloat(it.labelEl.getAttribute("x")), ty = parseFloat(it.labelEl.getAttribute("y")), anchor = it.labelEl.getAttribute("text-anchor");
    calls.push(`<text x="${tx}" y="${ty}" text-anchor="${anchor}" ${FAMILY} font-size="12" fill="#FFFFFF" fill-opacity="${r2(op)}">${pad2(it.num)}</text>`);
    all.push([anchor === "end" ? tx - 18 : tx, ty - 11], [anchor === "end" ? tx : tx + 18, ty + 3]);
  }
  return svgFile(all, `${state.spec.object}: ${state.view === "ortho" ? "orthographic views" : state.view === "section" ? "section A-A" : "exploded view"}`, parts, calls);
}
/** The detail window's drawing as line art, with its sizes when labels are on. */
/**
 * The detail window as it stands on screen, as line art: its frame and shadow, the
 * title bar with its close box, the drawing, the sizes line and the save buttons.
 * Every position is measured from the window itself, so the file matches what you see.
 */
function detailWindowSVG() {
  const ds = $("detailSvg"), it = detailFor, lab = state.labels;
  const R = detailEl.getBoundingClientRect(), Wn = R.width, Hn = R.height;
  const rel = (node) => { const r = node.getBoundingClientRect(); return { x: r.left - R.left, y: r.top - R.top, w: r.width, h: r.height }; };
  const fsOf = (node) => parseFloat(getComputedStyle(node).fontSize) || 14;
  const line = (d, w = 0.5) => `<path d="${d}" fill="none" stroke="#FFFFFF" stroke-width="${w}"/>`;
  const box = (b) => line(`M${r2(b.x + 0.25)} ${r2(b.y + 0.25)}H${r2(b.x + b.w - 0.25)}V${r2(b.y + b.h - 0.25)}H${r2(b.x + 0.25)}Z`);
  const text = (x, y, s, fs, op = 1, anchor = "start") => `<text x="${r2(x)}" y="${r2(y)}" font-size="${r2(fs)}"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""} ${FAMILY} fill="#FFFFFF" fill-opacity="${op}">${escX(s)}</text>`;
  // a line of text sits with its baseline a little below the middle of its box
  const mid = (b, fs) => b.y + b.h / 2 + fs * 0.34;
  const chrome = [];
  chrome.push(`<path d="M${r2(Wn)} 4H${r2(Wn + 4)}V${r2(Hn + 4)}H4V${r2(Hn)}H${r2(Wn)}Z" fill="#FFFFFF"/>`);
  chrome.push(box({ x: 0, y: 0, w: Wn, h: Hn }));
  const head = rel($("detailHead")), body = rel(ds), foot = rel(detailEl.querySelector(".detailfoot"));
  chrome.push(line(`M0 ${r2(head.y + head.h)}H${r2(Wn)}`), line(`M0 ${r2(foot.y)}H${r2(Wn)}`));
  const title = $("detailTitle"), tb = rel(title), tfs = fsOf(title);
  chrome.push(text(tb.x, mid(tb, tfs), title.textContent, tfs));
  const close = $("detailClose"), cb = rel(close), cfs = fsOf(close);
  chrome.push(box(cb), text(cb.x + cb.w / 2, mid(cb, cfs), "×", cfs, 1, "middle"));
  // the sizes line wraps where it wraps on screen
  const meta = $("detailMeta"), mb = rel(meta), mcs = getComputedStyle(meta), mfs = fsOf(meta);
  const lh = parseFloat(mcs.lineHeight) || mfs * 1.4;
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${mcs.fontWeight} ${mfs}px ${mcs.fontFamily}`;
  const rows = [];
  for (const word of meta.textContent.split(" ")) {
    const tryRow = rows.length ? rows[rows.length - 1] + " " + word : word;
    if (rows.length && ctx.measureText(tryRow).width <= mb.w + 0.5) rows[rows.length - 1] = tryRow; else rows.push(word);
  }
  rows.forEach((row, k) => chrome.push(text(mb.x, mb.y + lh * k + lh / 2 + mfs * 0.34, row, mfs, 0.55)));
  // the save buttons share their borders, as a segmented control does
  const seg = detailEl.querySelector(".detailfoot .seg");
  chrome.push(box(rel(seg)));
  [...seg.querySelectorAll("button")].forEach((btn, k) => {
    const b = rel(btn), fs = fsOf(btn);
    if (k) chrome.push(line(`M${r2(b.x)} ${r2(b.y)}V${r2(b.y + b.h)}`));
    chrome.push(text(b.x + b.w / 2, mid(b, fs), btn.textContent, fs, 1, "middle"));
  });
  // the drawing, placed and scaled as the window shows it
  const k = body.w / ds.viewBox.baseVal.width;
  const base = new DOMMatrix([k, 0, 0, k, body.x, body.y]);
  const paths = [...ds.querySelectorAll("path")].filter((n) => lab || !n.closest(".lab"));
  const { parts } = traceStrokes(paths, ds, (n) => (n.closest(".part") ? it : null), base);
  const dims = lab ? traceTexts(ds.querySelectorAll("text"), []) : [];
  const drawing = [...parts.values()].map(({ it: owner, els }) => `<g id="${owner ? pad2(owner.num) + "-" + slugOf(owner.p.name) : "dimensions"}">${els.join("")}</g>`).join("\n");
  const pad = 12, vw = Math.ceil(Wn + 4 + 2 * pad), vh = Math.ceil(Hn + 4 + 2 * pad);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${vw} ${vh}" width="${vw}" height="${vh}">
<title>${escX(`${state.spec.object}: detail ${pad2(it.num)}, ${it.p.name}`)}</title>
${FONT_FACE()}
<g id="window">
${chrome.join("\n")}
</g>
<g id="drawing">
${drawing}${dims.length ? `\n<g id="dimension-labels" transform="matrix(${r2(k)} 0 0 ${r2(k)} ${r2(body.x)} ${r2(body.y)})">${dims.join("")}</g>` : ""}
</g>
</svg>`;
}
function detailOutlineSVG() {
  const ds = $("detailSvg"), it = detailFor, lab = state.labels;
  const paths = [...ds.querySelectorAll("path")].filter((n) => lab || !n.closest(".lab"));
  const { parts, all } = traceStrokes(paths, ds, (n) => (n.closest(".part") ? it : null));
  const calls = lab ? traceTexts(ds.querySelectorAll("text"), all) : [];
  return svgFile(all, `${state.spec.object}: detail ${pad2(it.num)}, ${it.p.name}`, parts, calls, 16);
}
/** The inventory as line art: the header bar, then the rows in two columns, as on the page. */
function inventorySVG() {
  const list = state.items.slice().sort((a, b) => a.num - b.num), half = Math.ceil(list.length / 2);
  const realPN = list.some((it) => it.p.pn);
  const Wd = 958, RH = 20.7, HEAD = 26, GAPC = 24, col = (Wd - GAPC) / 2, cw = [26, col - 26 - 92 - 30, 92, 30];
  const line = (d, op = 1) => `<path d="${d}" fill="none" stroke="#FFFFFF" stroke-opacity="${op}" stroke-width="0.5"/>`;
  const text = (x, y, s, op = 1, anchor = "start") => `<text x="${r2(x)}" y="${r2(y)}" font-size="12"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""} ${FAMILY} fill="#FFFFFF" fill-opacity="${op}">${escX(s)}</text>`;
  const els = [];
  els.push(line(`M0 0H${Wd}V${HEAD}H0Z`), text(6, 17, `inventory: ${state.spec.object}`), text(Wd - 6, 17, `${list.length} parts · ${state.max + 1} layers`, 0.55, "end"));
  const fit = (s, px) => { const n = Math.floor(px / 6.7); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s; };
  [list.slice(0, half), list.slice(half)].forEach((chunk, c) => {
    const x0 = c * (col + GAPC), y0 = HEAD + 10;
    if (!chunk.length) return;
    const h = chunk.length * RH;
    let d = `M${r2(x0)} ${y0}H${r2(x0 + col)}V${r2(y0 + h)}H${r2(x0)}Z`;
    for (let k = 1; k < chunk.length; k++) d += `M${r2(x0)} ${r2(y0 + k * RH)}H${r2(x0 + col)}`;
    let x = x0;
    for (let k = 0; k < 3; k++) { x += cw[k]; d += `M${r2(x)} ${y0}V${r2(y0 + h)}`; }
    els.push(line(d));
    chunk.forEach((it, k) => {
      const y = y0 + k * RH + 14.6, code = it.p.pn || (realPN ? "" : partCode(it.num, list.length, it.p.name, state.spec.object));
      els.push(`<g id="${pad2(it.num)}-${slugOf(it.p.name)}">` + text(x0 + 5, y, pad2(it.num)) + text(x0 + cw[0] + 5, y, fit(it.p.name, cw[1] - 10)) + text(x0 + cw[0] + cw[1] + 5, y, fit(code, cw[2] - 10)) + text(x0 + cw[0] + cw[1] + cw[2] + 5, y, "x" + it.p.qty) + "</g>");
    });
  });
  const rows = Math.max(half, list.length - half);
  let H = HEAD + 10 + rows * RH;
  const src = state.spec.sources || [];
  if (src.length) { H += 22; els.push(text(0, H, "reference: " + src.join(", "), 0.55)); }
  const pad = 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${Wd + 2 * pad} ${r2(H + 2 * pad)}" width="${Wd + 2 * pad}" height="${Math.ceil(H + 2 * pad)}">
<title>${escX(state.spec.object)}: inventory</title>
${FONT_FACE()}
${els.join("\n")}
</svg>`;
}
/** The detail window's drawing as a PNG, in the sheet's own colours. */
async function detailPngBlob(scale = 3) {
  const ds = $("detailSvg"), clone = ds.cloneNode(true), vb = ds.viewBox.baseVal;
  clone.setAttribute("xmlns", NS);
  clone.setAttribute("width", vb.width * scale); clone.setAttribute("height", vb.height * scale);
  const cs = getComputedStyle(document.documentElement);
  const vars = ["paper", "ink", "mid", "lo", "dim", "dim-lo", "grid"].map((k) => `--${k}:${cs.getPropertyValue("--" + k).trim()};`).join("");
  const st = clone.querySelector("style");
  st.textContent = `@font-face{font-family:"Caliper Sans";src:url(data:font/otf;base64,${FONT_B64}) format("opentype")}#detailSvg{${vars}--font:"Caliper Sans","Helvetica Neue",Arial,sans-serif}` + st.textContent + `#detailSvg{--psw:${0.75 * scale}px}`;
  return pngBlob(new XMLSerializer().serializeToString(clone));
}
$("savePng").addEventListener("click", async () => {
  status("Rendering the PNG...", true);
  try { const text = await stageString(2); await save(slug() + ".png", await pngBlob(text), text); }
  catch { status("The PNG did not render. Try the SVG instead."); }
});
$("saveJson").addEventListener("click", async () => {
  const json = JSON.stringify(denormalize(state.spec), null, 1);
  if (!dlFn && window.claude) {
    // no download here: the spec goes to the clipboard, inside this click
    status((await copyText(json)) ? "Spec copied to your clipboard. Paste it into the spec box to draw it again." : "Your browser blocked the copy. Open spec (json) below and copy it from there.");
    return;
  }
  save(base() + ".json", new Blob([json], { type: "application/json" }), "");
});

/* boot */
(async function boot() {
  const style = document.createElement("style");
  style.textContent = `@font-face{font-family:"Caliper Sans";src:url(data:font/otf;base64,${FONT_B64}) format("opentype");font-display:block}`;
  document.head.appendChild(style);
  try { await document.fonts.load('12px "Caliper Sans"'); } catch {}
  setTheme(store.get("bp.theme", "auto"));
  chips();
  let spec = null;
  try { const last = store.get("bp.last", null); if (last && !last.tools) spec = normalize(last); } catch {}
  if (!spec) spec = normalize(PRESETS[0]);
  show(spec, { reveal: true });
  status(`${summary(spec)} Name another object to draw it.`);
  modeNoted = false; setMode(); paintRef();
})();
