import { buildLineArcGeometryFromPoints } from './lineArcGeometry.js';

const ALLOWED_TYPES = new Set(['line', 'arc', 'spiral']);

function normalizeType(type) {
  return String(type || 'line').toLowerCase();
}

function isAllowedGeometry(segment) {
  return ALLOWED_TYPES.has(normalizeType(segment?.type));
}

function buildGeometryFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const out = [];
  let s = 0;
  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const dx = Number(p1.x) - Number(p0.x);
    const dy = Number(p1.y) - Number(p0.y);
    const length = Math.hypot(dx, dy);
    if (length <= 1e-8) continue;
    out.push({
      s,
      x: Number(p0.x),
      y: Number(p0.y),
      hdg: Math.atan2(dy, dx),
      length,
      type: 'line'
    });
    s += length;
  }
  return out;
}

function sampleParamPoly3Points(segment, step = 0.4) {
  const len = Number(segment.length || 0);
  if (len <= 1e-8) return [];
  const hdg = Number(segment.hdg || 0);
  const cos = Math.cos(hdg);
  const sin = Math.sin(hdg);
  const pRange = String(segment.pRange || 'normalized').toLowerCase();
  const n = Math.max(2, Math.ceil(len / Math.max(0.1, step)));
  const points = [];
  for (let i = 0; i <= n; i += 1) {
    const p = i / n;
    const u = pRange === 'arclength' ? p * len : p;
    const u2 = u * u;
    const u3 = u2 * u;
    const lv = {
      x: Number(segment.aU || 0) + Number(segment.bU || 0) * u + Number(segment.cU || 0) * u2 + Number(segment.dU || 0) * u3,
      y: Number(segment.aV || 0) + Number(segment.bV || 0) * u + Number(segment.cV || 0) * u2 + Number(segment.dV || 0) * u3
    };
    points.push({
      x: Number(segment.x || 0) + lv.x * cos - lv.y * sin,
      y: Number(segment.y || 0) + lv.x * sin + lv.y * cos
    });
  }
  return points;
}

function sampleArcPoints(segment, step = 0.4) {
  const len = Number(segment.length || 0);
  const k = Number(segment.curvature || 0);
  const hdg0 = Number(segment.hdg || 0);
  const x0 = Number(segment.x || 0);
  const y0 = Number(segment.y || 0);
  if (len <= 1e-8) return [{ x: x0, y: y0 }];
  const n = Math.max(2, Math.ceil(len / Math.max(0.1, step)));
  const points = [{ x: x0, y: y0 }];
  if (Math.abs(k) < 1e-10) {
    for (let i = 1; i <= n; i += 1) {
      const s = (len * i) / n;
      points.push({ x: x0 + Math.cos(hdg0) * s, y: y0 + Math.sin(hdg0) * s });
    }
    return points;
  }
  const r = 1 / k;
  const cx = x0 - Math.sin(hdg0) * r;
  const cy = y0 + Math.cos(hdg0) * r;
  for (let i = 1; i <= n; i += 1) {
    const s = (len * i) / n;
    const a = hdg0 + k * s;
    points.push({ x: cx + Math.sin(a) * r, y: cy - Math.cos(a) * r });
  }
  return points;
}

function sampleSpiralPoints(segment, step = 0.4) {
  const len = Number(segment.length || 0);
  const x0 = Number(segment.x || 0);
  const y0 = Number(segment.y || 0);
  let hdg = Number(segment.hdg || 0);
  const k0 = Number(segment.curvStart || 0);
  const k1 = Number(segment.curvEnd || 0);
  if (len <= 1e-8) return [{ x: x0, y: y0 }];
  const n = Math.max(4, Math.ceil(len / Math.max(0.1, step)));
  const points = [{ x: x0, y: y0 }];
  let x = x0;
  let y = y0;
  let sWalked = 0;
  for (let i = 1; i <= n; i += 1) {
    const sTarget = (len * i) / n;
    const ds = sTarget - sWalked;
    const k = k0 + (k1 - k0) * (sTarget / len);
    x += Math.cos(hdg) * ds;
    y += Math.sin(hdg) * ds;
    hdg += k * ds;
    sWalked = sTarget;
    points.push({ x, y });
  }
  return points;
}

function sampleSegmentToPoints(segment, step = 0.4) {
  const type = normalizeType(segment?.type);
  if (type === 'line') {
    const len = Number(segment.length || 0);
    const hdg = Number(segment.hdg || 0);
    return [
      { x: Number(segment.x || 0), y: Number(segment.y || 0) },
      { x: Number(segment.x || 0) + Math.cos(hdg) * len, y: Number(segment.y || 0) + Math.sin(hdg) * len }
    ];
  }
  if (type === 'arc') return sampleArcPoints(segment, step);
  if (type === 'spiral') return sampleSpiralPoints(segment, step);
  if (type === 'parampoly3') return sampleParamPoly3Points(segment, step);
  return [];
}

function dedupePoints(points) {
  const out = [];
  (points || []).forEach((pt) => {
    const next = { x: Number(pt.x), y: Number(pt.y) };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return;
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - next.x, last.y - next.y) > 1e-4) {
      out.push(next);
    }
  });
  return out;
}

function fitLineArcFromPoints(points) {
  const clean = dedupePoints(points);
  if (clean.length < 2) return [];
  const fitted = buildLineArcGeometryFromPoints(clean);
  if (fitted?.geometry?.length) {
    return fitted.geometry.map((segment) => ({ ...segment }));
  }
  return buildGeometryFromPoints(clean);
}

export function sanitizeGeometryTypes(rawGeometry) {
  const input = Array.isArray(rawGeometry) ? rawGeometry : [];
  if (!input.length) return [];

  const needsConversion = input.some((segment) => !isAllowedGeometry(segment));
  if (!needsConversion) {
    return input
      .filter((segment) => Number(segment?.length || 0) > 1e-8)
      .map((segment) => ({ ...segment, type: normalizeType(segment.type) }));
  }

  let polyline = [];
  input.forEach((segment) => {
    if (Number(segment?.length || 0) <= 1e-8) return;
    const pts = sampleSegmentToPoints(segment);
    if (!pts.length) return;
    if (!polyline.length) {
      polyline.push(...pts);
      return;
    }
    pts.forEach((pt, idx) => {
      if (idx === 0) return;
      polyline.push(pt);
    });
  });

  const fitted = fitLineArcFromPoints(polyline);
  if (!fitted.length) return buildGeometryFromPoints(polyline);

  let s = 0;
  return fitted.map((segment) => {
    const length = Number(segment.length || 0);
    const next = {
      ...segment,
      type: normalizeType(segment.type),
      s: Number(s.toFixed(6)),
      length: Number(length.toFixed(6))
    };
    s += length;
    return next;
  });
}
