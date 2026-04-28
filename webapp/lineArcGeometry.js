import { clamp, polylineLength } from './editorUtils.js';

function sanitizePoints(points, minStep = 0.2) {
  const out = [];
  (Array.isArray(points) ? points : []).forEach((pt) => {
    const next = { x: Number(pt?.x), y: Number(pt?.y) };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return;
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - next.x, last.y - next.y) >= minStep) {
      out.push(next);
    }
  });
  return out;
}

function positiveAngleDelta(angle) {
  let out = Number(angle || 0);
  while (out < 0) out += Math.PI * 2;
  while (out >= Math.PI * 2) out -= Math.PI * 2;
  return out;
}

function negativeAngleDelta(angle) {
  let out = Number(angle || 0);
  while (out > 0) out -= Math.PI * 2;
  while (out <= -Math.PI * 2) out += Math.PI * 2;
  return out;
}

function arcGeometryFromThreePoints(p0, p1, p2, sStart) {
  const ax = Number(p0?.x);
  const ay = Number(p0?.y);
  const bx = Number(p1?.x);
  const by = Number(p1?.y);
  const cx = Number(p2?.x);
  const cy = Number(p2?.y);
  if (![ax, ay, bx, by, cx, cy].every(Number.isFinite)) return null;
  const chord = Math.hypot(cx - ax, cy - ay);
  if (chord < 0.15) return null;
  const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
  if (Math.abs(cross) < 1e-4) return null;

  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-8) return null;
  const ax2ay2 = ax * ax + ay * ay;
  const bx2by2 = bx * bx + by * by;
  const cx2cy2 = cx * cx + cy * cy;
  const center = {
    x: (ax2ay2 * (by - cy) + bx2by2 * (cy - ay) + cx2cy2 * (ay - by)) / d,
    y: (ax2ay2 * (cx - bx) + bx2by2 * (ax - cx) + cx2cy2 * (bx - ax)) / d
  };
  const radius = Math.hypot(ax - center.x, ay - center.y);
  if (!Number.isFinite(radius) || radius < 0.5 || radius > 5000) return null;

  const a0 = Math.atan2(ay - center.y, ax - center.x);
  const a2 = Math.atan2(cy - center.y, cx - center.x);
  const turnSign = cross >= 0 ? 1 : -1;
  const sweep = turnSign > 0
    ? positiveAngleDelta(a2 - a0)
    : negativeAngleDelta(a2 - a0);
  const absSweep = Math.abs(sweep);
  if (!Number.isFinite(absSweep) || absSweep < 0.01 || absSweep > Math.PI * 1.35) return null;

  const length = radius * absSweep;
  if (!Number.isFinite(length) || length < 0.15) return null;
  return {
    s: Number(sStart || 0),
    x: ax,
    y: ay,
    hdg: a0 + turnSign * Math.PI * 0.5,
    length,
    type: 'arc',
    curvature: turnSign / radius
  };
}

function lineGeometryBetweenPoints(p0, p1, sStart) {
  const x0 = Number(p0?.x);
  const y0 = Number(p0?.y);
  const x1 = Number(p1?.x);
  const y1 = Number(p1?.y);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (length < 0.05) return null;
  return {
    s: Number(sStart || 0),
    x: x0,
    y: y0,
    hdg: Math.atan2(y1 - y0, x1 - x0),
    length,
    type: 'line'
  };
}

function pointAtPolylineDistance(points, distance) {
  const pts = sanitizePoints(points, 0.2);
  if (!pts.length) return null;
  const target = Number(distance || 0);
  if (target <= 0) return { ...pts[0] };
  let walked = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (segLen <= 1e-8) continue;
    if (walked + segLen >= target) {
      const t = clamp((target - walked) / segLen, 0, 1);
      return {
        x: p0.x + (p1.x - p0.x) * t,
        y: p0.y + (p1.y - p0.y) * t
      };
    }
    walked += segLen;
  }
  return { ...pts[pts.length - 1] };
}

function pointsBetweenPolylineDistances(points, startDistance, endDistance) {
  const pts = sanitizePoints(points, 0.2);
  const out = [];
  let walked = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (i > 0) {
      walked += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    if (walked > startDistance + 0.1 && walked < endDistance - 0.1) {
      out.push({ ...pts[i] });
    }
  }
  return out;
}

function buildArcMiddleGeometryFromPoints(points, sStart) {
  const pts = sanitizePoints(points, 0.2);
  if (pts.length < 2) return [];
  const geometry = [];
  let s = Number(sStart || 0);
  let i = 0;
  while (i < pts.length - 1) {
    let segment = null;
    if (i + 2 < pts.length) {
      segment = arcGeometryFromThreePoints(pts[i], pts[i + 1], pts[i + 2], s);
    }
    if (segment) {
      i += 2;
    } else {
      segment = lineGeometryBetweenPoints(pts[i], pts[i + 1], s);
      i += 1;
    }
    if (!segment) continue;
    segment.s = Number(s.toFixed(6));
    segment.length = Number(Number(segment.length || 0).toFixed(6));
    geometry.push(segment);
    s += segment.length;
  }
  return geometry;
}

export function buildLineArcGeometryFromPoints(points) {
  const pts = sanitizePoints(points, 0.2);
  if (pts.length < 2) return null;
  const totalPolylineLength = polylineLength(pts);
  if (totalPolylineLength < 0.3) {
    const onlyLine = lineGeometryBetweenPoints(pts[0], pts[pts.length - 1], 0);
    return onlyLine ? { geometry: [onlyLine], length: Number(onlyLine.length.toFixed(6)) } : null;
  }

  const edgeLineLength = Math.min(
    Math.max(0.25, totalPolylineLength * 0.08),
    1.5,
    totalPolylineLength * 0.28
  );
  const headEnd = pointAtPolylineDistance(pts, edgeLineLength);
  const tailStart = pointAtPolylineDistance(pts, totalPolylineLength - edgeLineLength);
  if (!headEnd || !tailStart) return null;

  const geometry = [];
  let s = 0;
  const headLine = lineGeometryBetweenPoints(pts[0], headEnd, s);
  if (headLine) {
    headLine.s = Number(s.toFixed(6));
    headLine.length = Number(headLine.length.toFixed(6));
    geometry.push(headLine);
    s += headLine.length;
  }

  const middlePoints = sanitizePoints([
    headEnd,
    ...pointsBetweenPolylineDistances(pts, edgeLineLength, totalPolylineLength - edgeLineLength),
    tailStart
  ], 0.2);
  const middleGeometry = buildArcMiddleGeometryFromPoints(middlePoints, s);
  middleGeometry.forEach((segment) => {
    segment.s = Number(s.toFixed(6));
    segment.length = Number(Number(segment.length || 0).toFixed(6));
    geometry.push(segment);
    s += segment.length;
  });

  const tailLine = lineGeometryBetweenPoints(tailStart, pts[pts.length - 1], s);
  if (tailLine) {
    tailLine.s = Number(s.toFixed(6));
    tailLine.length = Number(tailLine.length.toFixed(6));
    geometry.push(tailLine);
    s += tailLine.length;
  }

  if (geometry.length >= 2 && String(geometry[0].type).toLowerCase() !== 'line') return null;
  if (geometry.length >= 2 && String(geometry[geometry.length - 1].type).toLowerCase() !== 'line') return null;
  if (!geometry.length) return null;
  return {
    geometry,
    length: Number(s.toFixed(6))
  };
}
