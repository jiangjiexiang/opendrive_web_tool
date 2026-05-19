import { markRaw } from 'vue';
import { rotateVec, clamp, vecAdd, vecSub, vecScale, vecDot, vecLen, normalizeVec, perpLeft, convexHull, solveVirtualIntersection, polylineLength, sampleBezier, dirAngle, buildBezierWithRadiusGuard } from '../editorUtils.js';
import { buildLineArcGeometryFromPoints as buildGeneratedLineArcGeometry } from '../lineArcGeometry.js';
import { sanitizeGeometryTypes } from '../geometrySanitize.js';
import {
  CONNECTOR_SAS_TUNE_OVERRIDES,
  DRAW_MIN_CHORD_FOR_CURVE_AT_MAX_SMOOTH_M,
  DRAW_MIN_CHORD_FOR_CURVE_AT_MIN_SMOOTH_M,
  ROAD_BOUNDS_CACHE,
  ROAD_RENDER_CACHE
} from './constants.js';

const MIN_BULGE_ARC_DELTA_RAD = 0.04;

export function installRoadCore(host) {
function nextRoadId() {
  let maxId = 0;
  host.roads.value.forEach((r) => {
    const n = Number.parseInt(r.id, 10);
    if (Number.isFinite(n)) maxId = Math.max(maxId, n);
  });
  return maxId + 1;
}

function defaultRoadFromPoints(points) {
  const idx = nextRoadId();
  return {
    id: String(idx),
    junction: '-1',
    leftLaneCount: 1,
    rightLaneCount: 1,
    laneWidth: 3.5,
    leftLaneWidth: 3.5,
    rightLaneWidth: 3.5,
    centerType: 'none',
    predecessorType: 'road',
    predecessorId: String(idx),
    successorType: 'road',
    successorId: String(idx),
    editPoints: points.map((pt) => ({ x: Number(pt.x), y: Number(pt.y) })),
    points,
    laneOffsetRecords: [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }],
    laneSections: [],
    nativeLeftBoundary: null,
    nativeRightBoundary: null,
    nativeLaneBoundaries: null,
    visible: true,
    geometry: [],
    length: polylineLength(points)
  };
}

function clearNativeGeometry(road) {
  road.nativeLeftBoundary = null;
  road.nativeRightBoundary = null;
  road.nativeLaneBoundaries = null;
}

function invalidateRoadRenderCache(road) {
  if (!road) return;
  delete road[ROAD_RENDER_CACHE];
  delete road[ROAD_BOUNDS_CACHE];
}

function poseAtGeometryEnd(geometry) {
  const list = Array.isArray(geometry) ? geometry.filter((g) => Number(g?.length || 0) > 1e-8) : [];
  if (!list.length) return null;
  const g = list[list.length - 1];
  const len = Number(g.length || 0);
  const p0 = { x: Number(g.x || 0), y: Number(g.y || 0), hdg: Number(g.hdg || 0) };
  const type = String(g.type || 'line').toLowerCase();
  if (type === 'arc') {
    const k = Number(g.curvature || 0);
    if (Math.abs(k) > 1e-10) {
      const r = 1 / k;
      const cx = p0.x - Math.sin(p0.hdg) * r;
      const cy = p0.y + Math.cos(p0.hdg) * r;
      const hdg = p0.hdg + k * len;
      return { x: cx + Math.sin(hdg) * r, y: cy - Math.cos(hdg) * r, hdg };
    }
  } else if (type === 'spiral') {
    return integrateCurvatureSegment(p0, Number(g.curvStart || 0), Number(g.curvEnd || 0), len, Math.max(12, Math.ceil(len / 0.15)));
  }
  return {
    x: p0.x + Math.cos(p0.hdg) * len,
    y: p0.y + Math.sin(p0.hdg) * len,
    hdg: p0.hdg
  };
}

function roadPoseAtEnd(road, atStart) {
  const geometry = Array.isArray(road?.geometry) ? road.geometry.filter((g) => Number(g?.length || 0) > 1e-8) : [];
  if (geometry.length) {
    if (atStart) {
      const first = geometry[0];
      const pose = {
        x: Number(first.x),
        y: Number(first.y),
        hdg: Number(first.hdg)
      };
      if ([pose.x, pose.y, pose.hdg].every(Number.isFinite)) return pose;
    } else {
      const pose = poseAtGeometryEnd(geometry);
      if (pose && [pose.x, pose.y, pose.hdg].every(Number.isFinite)) return pose;
    }
  }
  const pts = road.points || [];
  if (pts.length < 2) return null;
  const idx = atStart ? 0 : pts.length - 1;
  const p = pts[idx];
  let hdg = Number(p.hdg);
  if (!Number.isFinite(hdg) && atStart) {
    const p1 = pts[1];
    hdg = Math.atan2(p1.y - p.y, p1.x - p.x);
  } else if (!Number.isFinite(hdg)) {
    const p0 = pts[pts.length - 2];
    hdg = Math.atan2(p.y - p0.y, p.x - p0.x);
  }
  if (!Number.isFinite(hdg)) {
    hdg = 0;
  }
  return { x: p.x, y: p.y, hdg };
}

function endpointDirection(endpoint, hdg) {
  if (endpoint === 'start') {
    return { x: -Math.cos(hdg), y: -Math.sin(hdg) };
  }
  return { x: Math.cos(hdg), y: Math.sin(hdg) };
}

function endpointFinalDirection(endpoint, hdg) {
  if (endpoint === 'end') {
    return { x: -Math.cos(hdg), y: -Math.sin(hdg) };
  }
  return { x: Math.cos(hdg), y: Math.sin(hdg) };
}


function defaultEditPoints(points) {
  const clean = sanitizePoints(points, 0.05);
  if (clean.length >= 2) return clean;
  if (clean.length === 1) return [clean[0], { ...clean[0] }];
  return [];
}

function getRoadEditPoints(road) {
  if (!road) return [];
  const own = defaultEditPoints(road.editPoints || []);
  if (own.length >= 2) return own;
  const sampled = defaultEditPoints(road.points || []);
  if (sampled.length >= 2) {
    return [sampled[0], sampled[sampled.length - 1]];
  }
  return sampled;
}

function sanitizePoints(points, minStep = 0.25) {
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

function sampleBezierCurve(curve) {
  const chord = Math.hypot(curve.p3.x - curve.p0.x, curve.p3.y - curve.p0.y);
  return sampleBezier(curve.p0, curve.p1, curve.p2, curve.p3, Math.max(10, Math.ceil(chord / 1.5)));
}

function buildLineOnlyGeometryFromPoints(points) {
  const clean = sanitizePoints(points, 0.05);
  if (clean.length < 2) return [];
  const geometry = [];
  let s = 0;
  for (let i = 1; i < clean.length; i += 1) {
    const dx = clean[i].x - clean[i - 1].x;
    const dy = clean[i].y - clean[i - 1].y;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-8) continue;
    geometry.push({
      s: Number(s.toFixed(6)),
      x: clean[i - 1].x,
      y: clean[i - 1].y,
      hdg: Math.atan2(dy, dx),
      length: Number(length.toFixed(6)),
      type: 'line'
    });
    s += length;
  }
  return geometry;
}

function buildCatmullRomBezierSegments(points, tension = 0.55) {
  const pts = sanitizePoints(points);
  if (pts.length < 2) return [];
  if (pts.length === 2) {
    const delta = vecSub(pts[1], pts[0]);
    return [{
      p0: pts[0],
      p1: vecAdd(pts[0], vecScale(delta, 1 / 3)),
      p2: vecAdd(pts[0], vecScale(delta, 2 / 3)),
      p3: pts[1]
    }];
  }
  const alpha = clamp(Number(tension || 0.55), 0.05, 1);
  const segments = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    segments.push({
      p0: p1,
      p1: vecAdd(p1, vecScale(vecSub(p2, p0), alpha / 6)),
      p2: vecSub(p2, vecScale(vecSub(p3, p1), alpha / 6)),
      p3: p2
    });
  }
  return segments;
}

function buildRoadShapeFromBezierSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) {
    return { points: [], geometry: [], length: 0 };
  }
  const points = [];
  segments.forEach((segment, idx) => {
    sampleBezierCurve(segment).forEach((pt, sampleIdx) => {
      if (idx > 0 && sampleIdx === 0) return;
      const last = points[points.length - 1];
      if (!last || Math.hypot(last.x - pt.x, last.y - pt.y) > 1e-4) {
        points.push({ x: pt.x, y: pt.y });
      }
    });
  });
  const lineArc = buildGeneratedLineArcGeometry(points);
  if (lineArc?.geometry?.length) {
    const sampled = sampleGeometryToPoints(lineArc.geometry, 0.35);
    return {
      points: sampled.length >= 2 ? sampled : points,
      geometry: sanitizeGeometryTypes(lineArc.geometry),
      length: lineArc.length
    };
  }
  const lineGeometry = buildLineOnlyGeometryFromPoints(points);
  return {
    points,
    geometry: lineGeometry,
    length: lineGeometry.reduce((acc, g) => acc + Number(g.length || 0), 0)
  };
}

function minChordLengthForDrawCurve(smoothing) {
  const t = clamp(Number(smoothing ?? 0.55), 0.1, 0.95);
  const span = DRAW_MIN_CHORD_FOR_CURVE_AT_MIN_SMOOTH_M - DRAW_MIN_CHORD_FOR_CURVE_AT_MAX_SMOOTH_M;
  const ratio = (0.95 - t) / 0.85;
  return DRAW_MIN_CHORD_FOR_CURVE_AT_MAX_SMOOTH_M + ratio * span;
}

function shouldCurveTwoPointRoad(chordLen, smoothing) {
  const len = Number(chordLen);
  if (!Number.isFinite(len) || len < 0.15) return false;
  const t = clamp(Number(smoothing ?? 0.55), 0.1, 0.95);
  if ((t - 0.1) * 0.5 < 0.02) return false;
  return len >= minChordLengthForDrawCurve(smoothing);
}

function buildStraightRoadShapeFromPoints(editPoints) {
  const geometry = buildLineOnlyGeometryFromPoints(editPoints);
  const length = geometry.reduce((acc, g) => acc + Number(g.length || 0), 0);
  return {
    points: editPoints,
    geometry: sanitizeGeometryTypes(geometry),
    length: Number(length.toFixed(6)),
    editPoints
  };
}

function isDrawControlCurved(a, b, ctrl) {
  const dx = Number(b.x) - Number(a.x);
  const dy = Number(b.y) - Number(a.y);
  const len = Math.hypot(dx, dy);
  if (len < 0.15) return false;
  const perp = Math.abs((Number(ctrl.x) - Number(a.x)) * dy - (Number(ctrl.y) - Number(a.y)) * dx) / len;
  return perp > Math.max(0.08, len * 0.004);
}

function defaultDrawSegmentControl(a, b, smoothing = host.drawForm.smoothing) {
  const ax = Number(a.x);
  const ay = Number(a.y);
  const bx = Number(b.x);
  const by = Number(b.y);
  const mx = (ax + bx) * 0.5;
  const my = (ay + by) * 0.5;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: mx, y: my };
  if (!shouldCurveTwoPointRoad(len, smoothing)) {
    return { x: mx, y: my };
  }
  const t = clamp(Number(smoothing || 0.55), 0.1, 0.95);
  const bulgeFactor = (t - 0.1) * 0.5;
  const bulge = len * bulgeFactor;
  return { x: mx - (dy / len) * bulge, y: my + (dx / len) * bulge };
}

function pinChordEndpoints(points, start, end) {
  const a = { x: Number(start.x), y: Number(start.y) };
  const b = { x: Number(end.x), y: Number(end.y) };
  if (!points?.length) return [a, b];
  const out = points.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
  out[0] = { ...a };
  out[out.length - 1] = { ...b };
  return out;
}

function pinPointsToAllAnchors(points, anchors) {
  if (!anchors?.length) return points || [];
  if (anchors.length < 2) return anchors.map((pt) => ({ x: pt.x, y: pt.y }));
  let out = pinChordEndpoints(points, anchors[0], anchors[anchors.length - 1]);
  if (anchors.length === 2) return out;
  for (let i = 1; i < anchors.length - 1; i += 1) {
    const anchor = anchors[i];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let j = 0; j < out.length; j += 1) {
      const d = Math.hypot(out[j].x - anchor.x, out[j].y - anchor.y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    out[bestIdx] = { x: anchor.x, y: anchor.y };
  }
  return out;
}

function chordHeading(a, b) {
  return Math.atan2(Number(b.y) - Number(a.y), Number(b.x) - Number(a.x));
}

function averageAngle(a, b) {
  const x = Math.cos(Number(a)) + Math.cos(Number(b));
  const y = Math.sin(Number(a)) + Math.sin(Number(b));
  if (Math.hypot(x, y) < 1e-8) return wrapAngleRad(Number(a) + Math.PI);
  return Math.atan2(y, x);
}

/** 每个锚点处的路径切向（端点用弦向，中间点为相邻弦角平分） */
function buildChainJunctionHeadings(anchors) {
  const list = (Array.isArray(anchors) ? anchors : []).filter((pt) => (
    Number.isFinite(Number(pt?.x)) && Number.isFinite(Number(pt?.y))
  ));
  if (list.length < 2) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    if (i === 0) {
      out.push(chordHeading(list[0], list[1]));
    } else if (i === list.length - 1) {
      out.push(chordHeading(list[i - 1], list[i]));
    } else {
      out.push(averageAngle(
        chordHeading(list[i - 1], list[i]),
        chordHeading(list[i], list[i + 1])
      ));
    }
  }
  return out;
}

function buildChainSegmentHeadings(anchors) {
  const junctions = buildChainJunctionHeadings(anchors);
  const out = [];
  for (let i = 0; i < junctions.length - 1; i += 1) {
    out.push({ startHdg: junctions[i], endHdg: junctions[i + 1] });
  }
  return out;
}

/** 尖角处减小 bulge，降低相邻弧段互相叠压 */
function cornerBulgeScaleForSegment(anchors, segIndex) {
  const list = Array.isArray(anchors) ? anchors : [];
  if (list.length < 3) return 1;
  const scaleAt = (vertexIdx) => {
    if (vertexIdx <= 0 || vertexIdx >= list.length - 1) return 1;
    const ax = Number(list[vertexIdx - 1].x);
    const ay = Number(list[vertexIdx - 1].y);
    const bx = Number(list[vertexIdx].x);
    const by = Number(list[vertexIdx].y);
    const cx = Number(list[vertexIdx + 1].x);
    const cy = Number(list[vertexIdx + 1].y);
    const uLen = Math.hypot(ax - bx, ay - by);
    const vLen = Math.hypot(cx - bx, cy - by);
    if (uLen < 1e-6 || vLen < 1e-6) return 1;
    const dot = ((ax - bx) * (cx - bx) + (ay - by) * (cy - by)) / (uLen * vLen);
    const interior = Math.acos(clamp(dot, -1, 1));
    if (interior >= 2.15) return 1;
    if (interior >= 1.35) return 0.72;
    return 0.45;
  };
  let s = 1;
  if (segIndex > 0) s = Math.min(s, scaleAt(segIndex));
  if (segIndex < list.length - 2) s = Math.min(s, scaleAt(segIndex + 1));
  return s;
}

function recomputeSegmentHeadings(anchors) {
  return buildChainSegmentHeadings(anchors);
}

function signedBulgeFromControl(a, b, ctrl) {
  const dx = Number(b.x) - Number(a.x);
  const dy = Number(b.y) - Number(a.y);
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return 0;
  const mx = (Number(a.x) + Number(b.x)) * 0.5;
  const my = (Number(a.y) + Number(b.y)) * 0.5;
  const nx = -dy / len;
  const ny = dx / len;
  return (Number(ctrl.x) - mx) * nx + (Number(ctrl.y) - my) * ny;
}

function bulgeToMinRadius(chord, bulge) {
  const c = Math.max(0.15, Number(chord));
  const b = Math.max(1e-4, Math.abs(Number(bulge)));
  return Math.max(2, (c * c + 4 * b * b) / (8 * b));
}

/** 起止方向平行时，由 bulge 推算 line+arc+line 所需转角 */
function bulgeToArcDelta(chord, bulge) {
  const b = Number(bulge);
  if (!Number.isFinite(b) || Math.abs(b) < 1e-6) return 0;
  const minRadius = bulgeToMinRadius(chord, Math.abs(b));
  const sinHalf = clamp(chord / (2 * minRadius), 0, 0.999);
  let delta = (b >= 0 ? 1 : -1) * 2 * Math.asin(sinHalf);
  if (Math.abs(delta) < MIN_BULGE_ARC_DELTA_RAD) {
    delta = (b >= 0 ? 1 : -1) * MIN_BULGE_ARC_DELTA_RAD;
  }
  return delta;
}

function segmentHeadingsFromRoadGeometry(road, anchors) {
  const list = Array.isArray(anchors) ? anchors : [];
  const targetLen = list.length - 1;
  if (targetLen < 1) return [];
  const geom = sanitizeGeometryTypes(road?.geometry || []);
  if (geom.length >= 1) {
    const first = geom[0];
    const lastEnd = poseAtGeometryEnd(geom);
    if (targetLen === 1 && first && lastEnd) {
      return [{
        startHdg: Number(first.hdg),
        endHdg: Number(lastEnd.hdg)
      }];
    }
  }
  return recomputeSegmentHeadings(list);
}

function inferSegmentControlFromGeometry(a, b, geom) {
  const chord = Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y));
  if (chord < 0.15 || !Array.isArray(geom) || geom.length < 2) return null;
  const hasArc = geom.some((g) => String(g?.type || '').toLowerCase() === 'arc');
  if (!hasArc) return null;
  const sampled = sampleGeometryToPoints(geom, 0.35);
  if (sampled.length < 3) return null;
  let bestBulge = 0;
  let bestPt = sampled[Math.floor(sampled.length / 2)];
  sampled.forEach((pt) => {
    const bulge = signedBulgeFromControl(a, b, pt);
    if (Math.abs(bulge) > Math.abs(bestBulge)) {
      bestBulge = bulge;
      bestPt = pt;
    }
  });
  if (Math.abs(bestBulge) < Math.max(0.05, chord * 0.002)) return null;
  return { x: Number(bestPt.x), y: Number(bestPt.y) };
}

function roadHasActivePenCurvature(road) {
  if (!road) return false;
  if (String(road.drawKind || '').toLowerCase() === 'curve') return true;
  const anchors = getRoadEditPoints(road);
  const controls = Array.isArray(road.segmentControls) ? road.segmentControls : [];
  if (anchors.length < 2 || controls.length < anchors.length - 1) return false;
  for (let i = 0; i < anchors.length - 1; i += 1) {
    if (isDrawControlCurved(anchors[i], anchors[i + 1], controls[i])) return true;
  }
  return false;
}

function prepareRoadPenEdit(road) {
  if (!road) return road;
  const anchors = getRoadEditPoints(road);
  if (anchors.length < 2) return road;
  const controls = ensureRoadSegmentControls(road);
  const targetLen = anchors.length - 1;
  if (!Array.isArray(road.segmentHeadings) || road.segmentHeadings.length !== targetLen) {
    road.segmentHeadings = segmentHeadingsFromRoadGeometry(road, anchors);
  }
  const geom = sanitizeGeometryTypes(road.geometry || []);
  if (geom.length >= 2 && targetLen === 1) {
    const inferred = inferSegmentControlFromGeometry(anchors[0], anchors[1], geom);
    if (inferred) {
      const a = anchors[0];
      const b = anchors[1];
      if (!isDrawControlCurved(a, b, controls[0])) {
        controls[0] = inferred;
        road.segmentControls = controls;
      }
    }
  }
  return road;
}

function minPenStubLength(chord) {
  const c = Math.max(0.15, Number(chord));
  return clamp(c * 0.06, 1.0, Math.max(2.0, c * 0.22));
}

function reindexGeometryS(geometry) {
  const list = Array.isArray(geometry) ? geometry : [];
  let s = 0;
  return list.map((segment) => {
    const length = Number(segment.length || 0);
    const next = { ...segment, s: Number(s.toFixed(6)), length: Number(length.toFixed(6)) };
    s += length;
    return next;
  });
}

function snapLastLineToPoint(geometry, point) {
  const list = Array.isArray(geometry) ? geometry.map((g) => ({ ...g })) : [];
  if (!list.length) return list;
  const target = { x: Number(point.x), y: Number(point.y) };
  const last = list[list.length - 1];
  if (String(last.type || '').toLowerCase() !== 'line' || list.length < 2) return list;
  const before = poseAtGeometryEnd(list.slice(0, -1));
  if (!before) return list;
  const lineLen = (target.x - before.x) * Math.cos(before.hdg) + (target.y - before.y) * Math.sin(before.hdg);
  if (lineLen <= 0.05) return list;
  last.x = before.x;
  last.y = before.y;
  last.hdg = before.hdg;
  last.length = Number(lineLen.toFixed(6));
  return reindexGeometryS(list);
}

function shapePointsFromGeometry(geometry, start, end, step = 0.35) {
  const a = { x: Number(start.x), y: Number(start.y) };
  const b = { x: Number(end.x), y: Number(end.y) };
  const sampled = sampleGeometryToPoints(geometry, step);
  if (sampled.length < 2) return [a, b];
  const endPose = poseAtGeometryEnd(geometry);
  const err = Math.hypot(sampled[0].x - a.x, sampled[0].y - a.y)
    + Math.hypot(endPose.x - b.x, endPose.y - b.y);
  if (err > Math.max(0.15, Math.hypot(b.x - a.x, b.y - a.y) * 0.02)) {
    return pinChordEndpoints(sampled, a, b);
  }
  const out = sampled.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
  out[0] = { ...a };
  out[out.length - 1] = { ...b };
  return out;
}

/** 钢笔曲线：两端 line（沿切线），中间 arc；必要时中间改用 spiral */
function buildPenLineMiddleLine(a, b, control, h0, h1, bulge) {
  const ax = Number(a.x);
  const ay = Number(a.y);
  const bx = Number(b.x);
  const by = Number(b.y);
  const chord = Math.hypot(bx - ax, by - ay);
  if (chord < 0.15 || !Number.isFinite(h0)) return null;
  const hEnd = Number.isFinite(h1) ? h1 : h0;
  const bulgeAbs = Math.max(1e-4, Math.abs(Number(bulge)));
  const turnSign = Number(bulge) >= 0 ? 1 : -1;
  const k = turnSign / bulgeToMinRadius(chord, bulgeAbs);
  const line1Len = minPenStubLength(chord);
  const line2Len = minPenStubLength(chord);
  const p1 = { x: ax + Math.cos(h0) * line1Len, y: ay + Math.sin(h0) * line1Len };
  const errTol = Math.max(0.2, chord * 0.012);

  function packMiddle(middleSeg, line2) {
    if (!middleSeg || line2 <= 0.05) return null;
    const midLen = Number(middleSeg.length || 0);
    if (midLen <= 0.05) return null;
    const geometry = reindexGeometryS([
      {
        s: 0,
        x: ax,
        y: ay,
        hdg: h0,
        length: Number(line1Len.toFixed(6)),
        type: 'line'
      },
      {
        s: Number(line1Len.toFixed(6)),
        x: p1.x,
        y: p1.y,
        hdg: Number(middleSeg.hdg ?? h0),
        length: Number(midLen.toFixed(6)),
        type: String(middleSeg.type || 'arc').toLowerCase(),
        ...(String(middleSeg.type).toLowerCase() === 'spiral'
          ? { curvStart: Number(middleSeg.curvStart ?? 0), curvEnd: Number(middleSeg.curvEnd ?? k) }
          : { curvature: Number(middleSeg.curvature ?? k) })
      },
      {
        s: Number((line1Len + midLen).toFixed(6)),
        x: 0,
        y: 0,
        hdg: h0,
        length: Number(line2.toFixed(6)),
        type: 'line'
      }
    ]);
    const beforeEnd = poseAtGeometryEnd(geometry.slice(0, -1));
    if (!beforeEnd) return null;
    geometry[2].x = beforeEnd.x;
    geometry[2].y = beforeEnd.y;
    geometry[2].hdg = beforeEnd.hdg;
    const snapped = snapLastLineToPoint(geometry, { x: bx, y: by });
    const length = snapped.reduce((acc, g) => acc + Number(g.length || 0), 0);
    return { geometry: snapped, length: Number(length.toFixed(6)) };
  }

  let bestArc = null;
  let bestArcErr = Infinity;
  const arcStep = Math.max(0.35, chord * 0.03);
  const arcMax = chord * 1.05;
  for (let arcLen = arcStep; arcLen <= arcMax; arcLen += arcStep) {
    const midEnd = poseAtGeometryEnd([{
      x: p1.x,
      y: p1.y,
      hdg: h0,
      length: arcLen,
      type: 'arc',
      curvature: k
    }]);
    if (!midEnd) continue;
    const l2 = (bx - midEnd.x) * Math.cos(midEnd.hdg) + (by - midEnd.y) * Math.sin(midEnd.hdg);
    if (l2 < line2Len * 0.35) continue;
    const endX = midEnd.x + Math.cos(midEnd.hdg) * l2;
    const endY = midEnd.y + Math.sin(midEnd.hdg) * l2;
    const posErr = Math.hypot(endX - bx, endY - by);
    const hdgErr = Math.abs(wrapAngleRad(hEnd - midEnd.hdg));
    const err = posErr + hdgErr * chord * 0.15;
    if (err < bestArcErr) {
      bestArcErr = err;
      bestArc = {
        middle: {
          hdg: h0,
          length: arcLen,
          type: 'arc',
          curvature: k
        },
        line2: l2
      };
    }
  }

  let bestSpiral = null;
  let bestSpiralErr = Infinity;
  const spiralStep = Math.max(0.4, chord * 0.035);
  for (let ls = spiralStep; ls <= chord * 0.65; ls += spiralStep) {
    const midEnd = integrateCurvatureSegment({ x: p1.x, y: p1.y, hdg: h0 }, 0, k, ls);
    const l2 = (bx - midEnd.x) * Math.cos(midEnd.hdg) + (by - midEnd.y) * Math.sin(midEnd.hdg);
    if (l2 < line2Len * 0.35) continue;
    const endX = midEnd.x + Math.cos(midEnd.hdg) * l2;
    const endY = midEnd.y + Math.sin(midEnd.hdg) * l2;
    const posErr = Math.hypot(endX - bx, endY - by);
    const hdgErr = Math.abs(wrapAngleRad(hEnd - midEnd.hdg));
    const err = posErr + hdgErr * chord * 0.15;
    if (err < bestSpiralErr) {
      bestSpiralErr = err;
      bestSpiral = {
        middle: {
          hdg: h0,
          length: ls,
          type: 'spiral',
          curvStart: 0,
          curvEnd: k
        },
        line2: l2
      };
    }
  }

  const useSpiral = bestSpiral && (!bestArc || bestSpiralErr + 0.05 < bestArcErr);
  const pick = useSpiral ? bestSpiral : bestArc;
  const pickErr = useSpiral ? bestSpiralErr : bestArcErr;
  if (!pick || pickErr > errTol) return null;
  return packMiddle(pick.middle, pick.line2);
}

function buildLineArcLineFromChordBulge(a, b, h0, bulge) {
  const ax = Number(a.x);
  const ay = Number(a.y);
  const bx = Number(b.x);
  const by = Number(b.y);
  const chord = Math.hypot(bx - ax, by - ay);
  if (chord < 0.15 || !Number.isFinite(h0)) return null;
  const bulgeAbs = Math.max(1e-4, Math.abs(Number(bulge)));
  const turnSign = Number(bulge) >= 0 ? 1 : -1;
  const r0 = bulgeToMinRadius(chord, bulgeAbs);
  const d0x = Math.cos(h0);
  const d0y = Math.sin(h0);
  const errTol = Math.max(0.12, chord * 0.006);

  function pathEnd(line1Len, arcLen, k) {
    const arcStartX = ax + d0x * line1Len;
    const arcStartY = ay + d0y * line1Len;
    const arcEnd = poseAtGeometryEnd([{
      x: arcStartX,
      y: arcStartY,
      hdg: h0,
      length: arcLen,
      type: 'arc',
      curvature: k
    }]);
    if (!arcEnd) return null;
    const line2Len = (bx - arcEnd.x) * Math.cos(arcEnd.hdg) + (by - arcEnd.y) * Math.sin(arcEnd.hdg);
    if (line2Len <= 0.05) return null;
    return {
      arcStartX,
      arcStartY,
      arcEnd,
      line2Len,
      endX: arcEnd.x + Math.cos(arcEnd.hdg) * line2Len,
      endY: arcEnd.y + Math.sin(arcEnd.hdg) * line2Len
    };
  }

  let best = null;
  let bestErr = Infinity;
  const radii = [r0 * 0.55, r0 * 0.8, r0, r0 * 1.2, r0 * 1.55];
  const lineStep = Math.max(0.2, chord * 0.022);
  const arcStep = Math.max(0.3, chord * 0.028);
  radii.forEach((radius) => {
    const R = Math.max(2, radius);
    const k = turnSign / R;
    const arcMin = Math.max(R * MIN_BULGE_ARC_DELTA_RAD, 0.35);
    const arcMax = chord * 1.05;
    for (let line1Len = 0.05; line1Len <= chord * 0.46; line1Len += lineStep) {
      for (let arcLen = arcMin; arcLen <= arcMax; arcLen += arcStep) {
        const path = pathEnd(line1Len, arcLen, k);
        if (!path) continue;
        const err = Math.hypot(path.endX - bx, path.endY - by);
        if (err < bestErr) {
          bestErr = err;
          best = { line1Len, arcLen, k, path };
        }
      }
    }
  });
  if (!best || bestErr > errTol) return null;

  const { line1Len, arcLen, k, path } = best;
  const line1Length = Number(line1Len.toFixed(6));
  const arcLength = Number(arcLen.toFixed(6));
  const line2Length = Number(path.line2Len.toFixed(6));
  const geometry = [
    {
      s: 0,
      x: ax,
      y: ay,
      hdg: h0,
      length: line1Length,
      type: 'line'
    },
    {
      s: line1Length,
      x: path.arcStartX,
      y: path.arcStartY,
      hdg: h0,
      length: arcLength,
      type: 'arc',
      curvature: k
    },
    {
      s: Number((line1Length + arcLength).toFixed(6)),
      x: path.arcEnd.x,
      y: path.arcEnd.y,
      hdg: path.arcEnd.hdg,
      length: line2Length,
      type: 'line'
    }
  ];
  const length = line1Length + arcLength + line2Length;
  return { geometry, length: Number(length.toFixed(6)) };
}

/** 由 bulge 定曲率，SAS 从 A(h0) 积到 B，起终点与锚点重合 */
function buildPenSasFromBulge(anchorA, anchorB, h0, h1, bulge) {
  const a = { x: Number(anchorA.x), y: Number(anchorA.y) };
  const b = { x: Number(anchorB.x), y: Number(anchorB.y) };
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < 0.15 || !Number.isFinite(h0)) return null;
  const hEnd = Number.isFinite(h1) ? h1 : h0;
  const bulgeAbs = Math.max(1e-4, Math.abs(Number(bulge)));
  const k = (Number(bulge) >= 0 ? 1 : -1) / bulgeToMinRadius(chord, bulgeAbs);
  const errTol = Math.max(0.25, chord * 0.018);

  let best = null;
  const lsStep = Math.max(0.2, chord * 0.02);
  const laStep = Math.max(0.35, chord * 0.03);
  for (let ls0 = 0.35; ls0 <= chord * 0.42; ls0 += lsStep) {
    for (let la = Math.max(0.5, chord * 0.08); la <= chord * 0.92; la += laStep) {
      for (let ls1 = 0.35; ls1 <= chord * 0.42; ls1 += lsStep) {
        const p0 = { x: a.x, y: a.y, hdg: h0 };
        const p1 = integrateCurvatureSegment(p0, 0, k, ls0);
        const p2 = integrateCurvatureSegment(p1, k, k, la);
        const p3 = integrateCurvatureSegment(p2, k, 0, ls1);
        const posErr = Math.hypot(p3.x - b.x, p3.y - b.y);
        const hdgErr = Math.abs(wrapAngleRad(p3.hdg - hEnd));
        const err = posErr + hdgErr * chord * 0.12;
        if (err < errTol && (!best || err < best.err)) {
          best = { ls0, ls1, la, err, p1, p2, p3 };
        }
      }
    }
  }
  if (!best) {
    const sas = buildSasGeometryBetweenPoses({ x: a.x, y: a.y, hdg: h0 }, { x: b.x, y: b.y, hdg: hEnd });
    if (sas?.geometry?.length >= 3) {
      const geometry = reindexGeometryS(sas.geometry.map((seg, i) => (i === 0
        ? { ...seg, x: a.x, y: a.y, hdg: h0 }
        : seg)));
      const length = geometry.reduce((acc, g) => acc + Number(g.length || 0), 0);
      return { geometry, length: Number(length.toFixed(6)) };
    }
    return null;
  }

  const { ls0, ls1, la, p1, p2 } = best;
  const geometry = reindexGeometryS([
    {
      s: 0,
      x: a.x,
      y: a.y,
      hdg: h0,
      length: Number(ls0.toFixed(6)),
      type: 'spiral',
      curvStart: 0,
      curvEnd: k
    },
    {
      s: Number(ls0.toFixed(6)),
      x: p1.x,
      y: p1.y,
      hdg: p1.hdg,
      length: Number(la.toFixed(6)),
      type: 'arc',
      curvature: k
    },
    {
      s: Number((ls0 + la).toFixed(6)),
      x: p2.x,
      y: p2.y,
      hdg: p2.hdg,
      length: Number(ls1.toFixed(6)),
      type: 'spiral',
      curvStart: k,
      curvEnd: 0
    }
  ]);
  const length = geometry.reduce((acc, g) => acc + Number(g.length || 0), 0);
  return { geometry, length: Number(length.toFixed(6)) };
}

/** 由过 A、B 的 arc 拆成几何连续的 line+arc+line（已弃用：端部切线会内缩锚点） */
function splitArcToLineArcLine(arcSeg, anchorA, anchorB) {
  const a = { x: Number(anchorA.x), y: Number(anchorA.y) };
  const b = { x: Number(anchorB.x), y: Number(anchorB.y) };
  const total = Number(arcSeg?.length || 0);
  const k = Number(arcSeg?.curvature || 0);
  const ax = Number(arcSeg?.x);
  const ay = Number(arcSeg?.y);
  const ah = Number(arcSeg?.hdg);
  if (total < 0.35 || !Number.isFinite(k) || !Number.isFinite(ah)) return null;

  const stub = clamp(total * 0.06, 0.5, Math.min(2.5, total * 0.22));
  if (total <= stub * 2 + 0.25) return null;

  const arcMidLen = Number((total - stub * 2).toFixed(6));
  const afterFirstStub = poseAtGeometryEnd([{
    x: ax,
    y: ay,
    hdg: ah,
    length: stub,
    type: 'arc',
    curvature: k
  }]);
  if (!afterFirstStub) return null;

  const line1Len = Math.hypot(afterFirstStub.x - a.x, afterFirstStub.y - a.y);
  if (line1Len <= 0.05) return null;
  const line1Hdg = Math.atan2(afterFirstStub.y - a.y, afterFirstStub.x - a.x);

  const afterArc = poseAtGeometryEnd([{
    x: afterFirstStub.x,
    y: afterFirstStub.y,
    hdg: afterFirstStub.hdg,
    length: arcMidLen,
    type: 'arc',
    curvature: k
  }]);
  if (!afterArc) return null;

  const line2Len = (b.x - afterArc.x) * Math.cos(afterArc.hdg) + (b.y - afterArc.y) * Math.sin(afterArc.hdg);
  if (line2Len <= 0.05) return null;

  const geometry = reindexGeometryS([
    {
      s: 0,
      x: a.x,
      y: a.y,
      hdg: line1Hdg,
      length: Number(line1Len.toFixed(6)),
      type: 'line'
    },
    {
      s: Number(line1Len.toFixed(6)),
      x: afterFirstStub.x,
      y: afterFirstStub.y,
      hdg: afterFirstStub.hdg,
      length: arcMidLen,
      type: 'arc',
      curvature: k
    },
    {
      s: Number((line1Len + arcMidLen).toFixed(6)),
      x: afterArc.x,
      y: afterArc.y,
      hdg: afterArc.hdg,
      length: Number(line2Len.toFixed(6)),
      type: 'line'
    }
  ]);
  const length = geometry.reduce((acc, g) => acc + Number(g.length || 0), 0);
  return { geometry, length: Number(length.toFixed(6)) };
}

function penShapeFromGeometry(geometry, a, b) {
  const sanitized = sanitizeGeometryTypes(geometry);
  const points = sampleGeometryToPoints(sanitized, 0.35);
  if (points.length >= 2) {
    points[0] = { x: a.x, y: a.y };
    points[points.length - 1] = { x: b.x, y: b.y };
  }
  const length = sanitized.reduce((acc, g) => acc + Number(g.length || 0), 0);
  return {
    points: points.length >= 2 ? points : [a, b],
    geometry: sanitized,
    length: Number(length.toFixed(6))
  };
}

/** 钢笔段：A/B 固定，菱形 bulge；两点用三点 arc，多点用切向约束 line+arc+line */
function buildPenSegmentShape(anchorA, anchorB, control, headings, options = {}) {
  const a = { x: Number(anchorA.x), y: Number(anchorA.y) };
  const b = { x: Number(anchorB.x), y: Number(anchorB.y) };
  const ctrl = { x: Number(control?.x), y: Number(control?.y) };
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < 0.15) {
    return buildStraightRoadShapeFromPoints([a, b]);
  }
  const chordHdg = chordHeading(a, b);
  const h0 = Number.isFinite(Number(headings?.startHdg)) ? Number(headings.startHdg) : chordHdg;
  const h1 = Number.isFinite(Number(headings?.endHdg)) ? Number(headings.endHdg) : chordHdg;
  const bulgeScale = clamp(Number(options.bulgeScale ?? 1), 0.15, 1);
  const bulge = signedBulgeFromControl(a, b, ctrl) * bulgeScale;
  const delta = wrapAngleRad(h1 - h0);
  const bulgeThreshold = Math.max(0.08, chord * 0.004);
  const constrainedJunction = Math.abs(delta) > 0.02;

  if (Math.abs(bulge) < bulgeThreshold && Math.abs(delta) < 0.01) {
    const projected = (b.x - a.x) * Math.cos(h0) + (b.y - a.y) * Math.sin(h0);
    if (projected > 0.05) {
      const geometry = [{
        s: 0,
        x: a.x,
        y: a.y,
        hdg: h0,
        length: Number(projected.toFixed(6)),
        type: 'line'
      }];
      return {
        points: [a, b],
        geometry: sanitizeGeometryTypes(geometry),
        length: Number(projected.toFixed(6))
      };
    }
  }

  if (!Number.isFinite(ctrl.x) || !Number.isFinite(ctrl.y)) {
    return buildStraightRoadShapeFromPoints([a, b]);
  }

  if (constrainedJunction) {
    const lal = buildPenLineMiddleLine(a, b, ctrl, h0, h1, bulge);
    if (lal?.geometry?.length >= 3) {
      return penShapeFromGeometry(lal.geometry, a, b);
    }
    const posed = buildLineArcLineGeometryFromPoses(
      { x: a.x, y: a.y, hdg: h0 },
      { x: b.x, y: b.y, hdg: h1 },
      { forcedDelta: delta, requireTriple: Math.abs(bulge) >= bulgeThreshold }
    );
    if (posed?.geometry?.length) {
      return penShapeFromGeometry(posed.geometry, a, b);
    }
  }

  const arcBuilt = buildGeneratedLineArcGeometry([a, ctrl, b]);
  const arcSeg = arcBuilt?.geometry?.find((g) => String(g?.type || '').toLowerCase() === 'arc')
    || arcBuilt?.geometry?.[0];
  if (arcSeg && String(arcSeg.type || '').toLowerCase() === 'arc') {
    return penShapeFromGeometry([{
      ...arcSeg,
      s: 0,
      x: a.x,
      y: a.y,
      length: Number(Number(arcSeg.length || 0).toFixed(6))
    }], a, b);
  }

  const sas = buildPenSasFromBulge(a, b, h0, h1, bulge);
  if (sas?.geometry?.length >= 3) {
    return penShapeFromGeometry(sas.geometry, a, b);
  }

  return buildStraightRoadShapeFromPoints([a, b]);
}

function stitchNextGeometryToPrevEnd(prevGeometry, nextGeometry) {
  const list = Array.isArray(nextGeometry) ? nextGeometry : [];
  if (!list.length) return list;
  const endPose = poseAtGeometryEnd(prevGeometry);
  if (!endPose) return list;
  const first = { ...list[0] };
  first.x = endPose.x;
  first.y = endPose.y;
  first.hdg = endPose.hdg;
  return [first, ...list.slice(1)];
}

function mergeRoadShapeSegments(shapes) {
  const geometry = [];
  const points = [];
  let sOffset = 0;
  let totalLength = 0;
  shapes.forEach((shape, segIdx) => {
    let segs = shape.geometry || [];
    if (segIdx > 0 && geometry.length) {
      segs = stitchNextGeometryToPrevEnd(geometry, segs);
    }
    segs.forEach((segment) => {
      geometry.push({
        ...segment,
        s: Number((sOffset + Number(segment.s || 0)).toFixed(6))
      });
    });
    sOffset += Number(shape.length || 0);
    totalLength += Number(shape.length || 0);
    (shape.points || []).forEach((pt, pointIdx) => {
      if (segIdx > 0 && pointIdx === 0) return;
      points.push({ x: Number(pt.x), y: Number(pt.y) });
    });
  });
  return {
    geometry: sanitizeGeometryTypes(geometry),
    points,
    length: Number(totalLength.toFixed(6))
  };
}

function buildRoadShapeFromDrawAnchors(anchors, segmentControls, segmentHeadings, smoothing = host.drawForm.smoothing) {
  const cleanAnchors = (Array.isArray(anchors) ? anchors : []).map((pt) => ({
    x: Number(pt.x),
    y: Number(pt.y)
  })).filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
  if (cleanAnchors.length < 2) {
    return { points: cleanAnchors, geometry: [], length: 0, editPoints: cleanAnchors };
  }
  const controls = Array.isArray(segmentControls) ? segmentControls : [];
  const chainHeadings = buildChainSegmentHeadings(cleanAnchors);
  const headings = Array.isArray(segmentHeadings) && segmentHeadings.length === cleanAnchors.length - 1
    ? segmentHeadings
    : chainHeadings;
  const segmentShapes = [];
  for (let i = 0; i < cleanAnchors.length - 1; i += 1) {
    const a = cleanAnchors[i];
    const b = cleanAnchors[i + 1];
    const ctrl = controls[i] || defaultDrawSegmentControl(a, b, smoothing);
    const segHeading = chainHeadings[i] || headings[i];
    const bulgeScale = cornerBulgeScaleForSegment(cleanAnchors, i);
    segmentShapes.push(buildPenSegmentShape(a, b, ctrl, segHeading, { bulgeScale }));
  }
  const merged = mergeRoadShapeSegments(segmentShapes);
  if (cleanAnchors.length === 2) {
    merged.points = merged.points?.length >= 2 ? merged.points : cleanAnchors;
    if (merged.points.length >= 2) {
      merged.points[0] = { x: cleanAnchors[0].x, y: cleanAnchors[0].y };
      merged.points[merged.points.length - 1] = {
        x: cleanAnchors[1].x,
        y: cleanAnchors[1].y
      };
    }
  } else {
    merged.points = pinPointsToAllAnchors(merged.points, cleanAnchors);
  }
  return {
    ...merged,
    editPoints: cleanAnchors
  };
}

function buildRoadShapeFromStraightAnchors(anchors) {
  const cleanAnchors = (Array.isArray(anchors) ? anchors : []).map((pt) => ({
    x: Number(pt.x),
    y: Number(pt.y)
  })).filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
  if (cleanAnchors.length < 2) {
    return { points: cleanAnchors, geometry: [], length: 0, editPoints: cleanAnchors };
  }
  const geometry = sanitizeGeometryTypes(buildLineOnlyGeometryFromPoints(cleanAnchors));
  const length = geometry.reduce((acc, g) => acc + Number(g.length || 0), 0);
  return {
    points: cleanAnchors.map((pt) => ({ x: pt.x, y: pt.y })),
    geometry,
    length: Number(length.toFixed(6)),
    editPoints: cleanAnchors.map((pt) => ({ x: pt.x, y: pt.y }))
  };
}

function isDrawCurveKind(kind = host.drawForm.drawKind) {
  return String(kind || '').toLowerCase() !== 'line';
}

function buildRoadShapeFromDrawDraft() {
  if (!isDrawCurveKind()) {
    return buildRoadShapeFromStraightAnchors(host.drawingPoints.value);
  }
  return buildRoadShapeFromDrawAnchors(
    host.drawingPoints.value,
    host.drawSegmentControls.value,
    host.drawSegmentHeadings.value,
    host.drawForm.smoothing
  );
}

function createRoadFromDrawDraft(anchors, segmentControls, overrides = {}, segmentHeadings = null) {
  const cleanAnchors = sanitizePoints(anchors, 0.05);
  const road = defaultRoadFromPoints(defaultEditPoints(cleanAnchors));
  Object.assign(road, overrides || {});
  const drawKind = overrides?.drawKind ?? host.drawForm.drawKind ?? 'curve';
  road.drawKind = drawKind;

  if (String(drawKind).toLowerCase() === 'line') {
    const shape = buildRoadShapeFromStraightAnchors(cleanAnchors);
    road.editPoints = shape.editPoints.map((pt) => ({ x: pt.x, y: pt.y }));
    road.segmentControls = [];
    road.segmentHeadings = [];
    road.points = shape.points.length ? shape.points : cleanAnchors;
    road.geometry = sanitizeGeometryTypes(shape.geometry || []);
    road.geometryDirty = true;
    road.length = Number((shape.length || polylineLength(road.points)).toFixed(6));
    clearNativeGeometry(road);
    return road;
  }

  const controls = (Array.isArray(segmentControls) ? segmentControls : []).map((pt) => ({
    x: Number(pt.x),
    y: Number(pt.y)
  }));
  const headings = Array.isArray(segmentHeadings) && segmentHeadings.length === cleanAnchors.length - 1
    ? segmentHeadings.map((h) => ({
      startHdg: Number(h.startHdg),
      endHdg: Number(h.endHdg)
    }))
    : recomputeSegmentHeadings(cleanAnchors);
  const shape = buildRoadShapeFromDrawAnchors(cleanAnchors, controls, headings, host.drawForm.smoothing);
  road.editPoints = shape.editPoints.map((pt) => ({ x: pt.x, y: pt.y }));
  road.segmentControls = controls;
  road.segmentHeadings = headings;
  road.points = shape.points.length ? shape.points : cleanAnchors;
  road.geometry = sanitizeGeometryTypes(shape.geometry || []);
  road.geometryDirty = true;
  road.length = Number((shape.length || polylineLength(road.points)).toFixed(6));
  clearNativeGeometry(road);
  return road;
}

function ensureRoadSegmentControls(road) {
  const anchors = getRoadEditPoints(road);
  if (anchors.length < 2) {
    road.segmentControls = [];
    road.segmentHeadings = [];
    return road.segmentControls;
  }
  const targetLen = anchors.length - 1;
  if (!Array.isArray(road.segmentControls)) {
    road.segmentControls = [];
  }
  while (road.segmentControls.length < targetLen) {
    const i = road.segmentControls.length;
    road.segmentControls.push(defaultDrawSegmentControl(anchors[i], anchors[i + 1]));
  }
  while (road.segmentControls.length > targetLen) {
    road.segmentControls.pop();
  }
  return road.segmentControls;
}

function ensureRoadSegmentHeadings(road, recompute = false) {
  const anchors = getRoadEditPoints(road);
  if (anchors.length < 2) {
    road.segmentHeadings = [];
    return road.segmentHeadings;
  }
  const targetLen = anchors.length - 1;
  if (recompute || !Array.isArray(road.segmentHeadings) || road.segmentHeadings.length !== targetLen) {
    road.segmentHeadings = recomputeSegmentHeadings(anchors);
  }
  return road.segmentHeadings;
}

function applyRoadFromSegmentControls(road, smoothing = host.drawForm.smoothing, options = {}) {
  if (!road) return road;
  const anchors = (Array.isArray(road.editPoints) && road.editPoints.length >= 2
    ? road.editPoints
    : getRoadEditPoints(road)
  ).map((pt) => ({ x: Number(pt.x), y: Number(pt.y) }));
  if (anchors.length < 2) return road;

  const controls = ensureRoadSegmentControls(road);
  if (String(road.drawKind || '').toLowerCase() === 'line' && !roadHasActivePenCurvature(road)) {
    const shape = buildRoadShapeFromStraightAnchors(anchors);
    road.editPoints = anchors.map((pt) => ({ x: pt.x, y: pt.y }));
    road.segmentControls = controls;
    road.points = shape.points.length ? shape.points : anchors;
    road.geometry = sanitizeGeometryTypes(shape.geometry || []);
    road.geometryDirty = true;
    road.length = Number((shape.length || polylineLength(road.points)).toFixed(6));
    clearNativeGeometry(road);
    invalidateRoadRenderCache(road);
    const roadIdx = host.roads.value.indexOf(road);
    if (roadIdx >= 0) host.roads.value.splice(roadIdx, 1, road);
    return road;
  }

  if (roadHasActivePenCurvature(road)) {
    road.drawKind = 'curve';
  }
  const headings = ensureRoadSegmentHeadings(road, Boolean(options.recomputeHeadings));
  const shape = buildRoadShapeFromDrawAnchors(anchors, controls, headings, smoothing);
  road.editPoints = anchors.map((pt) => ({ x: pt.x, y: pt.y }));
  road.points = shape.points.length ? shape.points : anchors;
  road.geometry = sanitizeGeometryTypes(shape.geometry || []);
  road.geometryDirty = true;
  road.length = Number((shape.length || polylineLength(road.points)).toFixed(6));
  clearNativeGeometry(road);
  invalidateRoadRenderCache(road);
  const roadIdx = host.roads.value.indexOf(road);
  if (roadIdx >= 0) {
    host.roads.value.splice(roadIdx, 1, road);
  }
  return road;
}

function pickRoadCurveControl(screenX, screenY, roadIdx) {
  const road = host.roads.value[roadIdx];
  if (!road) return null;
  const anchors = getRoadEditPoints(road);
  if (anchors.length < 2) return null;
  const controls = ensureRoadSegmentControls(road);
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < controls.length; i += 1) {
    const ctrl = controls[i];
    if (!ctrl) continue;
    const p = host.worldToScreen(ctrl.x, ctrl.y);
    const d = Math.hypot(screenX - p.x, screenY - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = { roadIdx, segmentIndex: i };
    }
  }
  return bestDist <= 11 ? best : null;
}

function syncDrawSegmentHeadings() {
  const n = host.drawingPoints.value.length;
  if (n < 2) {
    host.drawSegmentHeadings.value = [];
    return;
  }
  if (n >= 3) {
    host.drawSegmentHeadings.value = buildChainSegmentHeadings(host.drawingPoints.value);
    return;
  }
  const targetLen = 1;
  while (host.drawSegmentHeadings.value.length > targetLen) {
    host.drawSegmentHeadings.value.pop();
  }
  while (host.drawSegmentHeadings.value.length < targetLen) {
    const a = host.drawingPoints.value[0];
    const b = host.drawingPoints.value[1];
    const h = chordHeading(a, b);
    host.drawSegmentHeadings.value.push({ startHdg: h, endHdg: h });
  }
}

function appendDrawAnchor(point) {
  host.drawingPoints.value.push({ x: Number(point.x), y: Number(point.y) });
  const count = host.drawingPoints.value.length;
  if (count >= 2 && isDrawCurveKind()) {
    const a = host.drawingPoints.value[count - 2];
    const b = host.drawingPoints.value[count - 1];
    host.drawSegmentControls.value.push(defaultDrawSegmentControl(a, b, host.drawForm.smoothing));
    if (count >= 3) {
      host.drawSegmentHeadings.value = buildChainSegmentHeadings(host.drawingPoints.value);
    } else {
      const h = chordHeading(a, b);
      host.drawSegmentHeadings.value.push({ startHdg: h, endHdg: h });
    }
  }
}

function syncDrawSegmentControls() {
  const targetLen = Math.max(0, host.drawingPoints.value.length - 1);
  while (host.drawSegmentControls.value.length > targetLen) {
    host.drawSegmentControls.value.pop();
  }
  while (host.drawSegmentControls.value.length < targetLen) {
    const i = host.drawSegmentControls.value.length;
    const a = host.drawingPoints.value[i];
    const b = host.drawingPoints.value[i + 1];
    host.drawSegmentControls.value.push(defaultDrawSegmentControl(a, b, host.drawForm.smoothing));
  }
  syncDrawSegmentHeadings();
}

function pickDrawCurveControl(screenX, screenY) {
  const anchors = host.drawingPoints.value;
  const controls = host.drawSegmentControls.value || [];
  if (anchors.length < 2 || !controls.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < controls.length; i += 1) {
    const ctrl = controls[i];
    if (!ctrl) continue;
    const p = host.worldToScreen(ctrl.x, ctrl.y);
    const d = Math.hypot(screenX - p.x, screenY - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = { segmentIndex: i };
    }
  }
  return bestDist <= 11 ? best : null;
}

function inflatePointsForArcIfNeeded(points, smoothing) {
  const clean = sanitizePoints(points, 0.05);
  if (clean.length !== 2) return clean;
  const p0 = clean[0];
  const p1 = clean[1];
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (!shouldCurveTwoPointRoad(len, smoothing)) return clean;
  const t = clamp(Number(smoothing || 0.55), 0.1, 0.95);
  const bulgeFactor = (t - 0.1) * 0.5;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const mx = (p0.x + p1.x) * 0.5;
  const my = (p0.y + p1.y) * 0.5;
  const bulge = len * bulgeFactor;
  return [p0, { x: mx - (dy / len) * bulge, y: my + (dx / len) * bulge }, p1];
}

function buildRoadShapeFromPoints(points, smoothing = host.drawForm.smoothing) {
  const editPoints = sanitizePoints(points, 0.05);
  if (editPoints.length < 2) {
    return { points: editPoints, geometry: [], length: 0, editPoints };
  }
  if (editPoints.length === 2) {
    const chord = Math.hypot(editPoints[1].x - editPoints[0].x, editPoints[1].y - editPoints[0].y);
    if (!shouldCurveTwoPointRoad(chord, smoothing)) {
      return buildStraightRoadShapeFromPoints(editPoints);
    }
  }
  const fitPoints = inflatePointsForArcIfNeeded(editPoints, smoothing);
  const lineArc = buildGeneratedLineArcGeometry(fitPoints);
  if (lineArc?.geometry?.length) {
    const sampled = sampleGeometryToPoints(lineArc.geometry, 0.35);
    return {
      points: sampled.length >= 2 ? sampled : editPoints,
      geometry: sanitizeGeometryTypes(lineArc.geometry),
      length: lineArc.length,
      editPoints
    };
  }
  const bezierShape = buildRoadShapeFromBezierSegments(
    buildCatmullRomBezierSegments(fitPoints, smoothing)
  );
  bezierShape.editPoints = editPoints;
  bezierShape.geometry = sanitizeGeometryTypes(bezierShape.geometry);
  return bezierShape;
}

function applyRoadShape(road, points, options = {}) {
  const sourcePoints = defaultEditPoints(points);
  const shape = Array.isArray(options.bezierSegments) && options.bezierSegments.length
    ? (() => {
      const built = buildRoadShapeFromBezierSegments(options.bezierSegments);
      built.editPoints = sourcePoints;
      return built;
    })()
    : buildRoadShapeFromPoints(sourcePoints, options.smoothing ?? host.drawForm.smoothing);
  const controlPoints = Array.isArray(shape.editPoints) && shape.editPoints.length >= 2
    ? shape.editPoints
    : sourcePoints;
  road.editPoints = controlPoints.map((pt) => ({ x: pt.x, y: pt.y }));
  road.points = shape.points.length ? shape.points : sourcePoints;
  road.geometry = sanitizeGeometryTypes(shape.geometry || []);
  road.geometryDirty = true;
  road.length = Number((shape.length || polylineLength(road.points)).toFixed(6));
  clearNativeGeometry(road);
  return road;
}

function createRoadFromPoints(points, overrides = {}, options = {}) {
  const road = defaultRoadFromPoints(defaultEditPoints(points));
  Object.assign(road, overrides || {});
  return applyRoadShape(road, getRoadEditPoints(road), options);
}

function nextJunctionId() {
  let maxId = 0;
  (host.junctionSpecs.value || []).forEach((j) => {
    const n = Number.parseInt(j.id, 10);
    if (Number.isFinite(n)) maxId = Math.max(maxId, n);
  });
  (host.junctionMeshes.value || []).forEach((j) => {
    const n = Number.parseInt(j.id, 10);
    if (Number.isFinite(n)) maxId = Math.max(maxId, n);
  });
  return maxId + 1;
}

function mapLaneIndex(laneIdx, fromCount, toCount) {
  const fromN = Math.max(1, Number(fromCount || 1));
  const toN = Math.max(1, Number(toCount || 1));
  if (fromN === 1 || toN === 1) return 1;
  const t = (laneIdx - 1) / (fromN - 1);
  return clamp(Math.round(1 + t * (toN - 1)), 1, toN);
}

function getApproachLaneId(approach, role, laneIndex) {
  const idx = Math.max(1, Number(laneIndex || 1));
  if (role === 'incoming') {
    return approach.handle.endpoint === 'end' ? -idx : idx;
  }
  return approach.handle.endpoint === 'start' ? -idx : idx;
}

function resolveApproachLaneProfile(approach, preferredRole) {
  const incomingCount = Math.max(0, Number(approach?.incomingCount || 0));
  const outgoingCount = Math.max(0, Number(approach?.outgoingCount || 0));
  const incomingWidth = Math.max(0.5, Number(approach?.incomingWidth || 3.5));
  const outgoingWidth = Math.max(0.5, Number(approach?.outgoingWidth || 3.5));

  // Junction internal connectors are forced to single-lane.
  if (preferredRole === 'incoming') {
    return {
      roleUsed: incomingCount > 0 ? 'incoming' : (outgoingCount > 0 ? 'outgoing' : 'incoming'),
      count: 1,
      width: incomingCount > 0 ? incomingWidth : (outgoingCount > 0 ? outgoingWidth : incomingWidth),
      fallbackUsed: incomingCount <= 0
    };
  }
  return {
    roleUsed: outgoingCount > 0 ? 'outgoing' : (incomingCount > 0 ? 'incoming' : 'outgoing'),
    count: 1,
    width: outgoingCount > 0 ? outgoingWidth : (incomingCount > 0 ? incomingWidth : outgoingWidth),
    fallbackUsed: outgoingCount <= 0
  };

}

function buildLaneSectionLinkSpecs(fromApproach, fromProfile, toApproach, toProfile, useLeftLanes) {
  const fromCount = Math.max(1, Number(fromProfile?.count || 1));
  const toCount = Math.max(1, Number(toProfile?.count || 1));
  const fromRoleUsed = fromProfile?.roleUsed || 'incoming';
  const toRoleUsed = toProfile?.roleUsed || 'outgoing';

  const laneMap = [];
  for (let lane = 1; lane <= fromCount; lane += 1) {
    const mapped = mapLaneIndex(lane, fromCount, toCount);
    laneMap.push({
      connectorLaneId: useLeftLanes ? lane : -lane,
      fromRoadLaneId: getApproachLaneId(fromApproach, fromRoleUsed, lane),
      toRoadLaneId: getApproachLaneId(toApproach, toRoleUsed, mapped),
      from: lane,
      to: mapped
    });
  }

  const inverseLaneMap = [];
  for (let lane = 1; lane <= toCount; lane += 1) {
    const mapped = mapLaneIndex(lane, toCount, fromCount);
    inverseLaneMap.push({
      connectorLaneId: useLeftLanes ? lane : -lane,
      fromRoadLaneId: getApproachLaneId(fromApproach, fromRoleUsed, mapped),
      toRoadLaneId: getApproachLaneId(toApproach, toRoleUsed, lane),
      from: mapped,
      to: lane
    });
  }

  const buildLaneLinkObject = (items) => Object.fromEntries(
    items.map((m) => [m.connectorLaneId, {
      predecessor: m.fromRoadLaneId,
      successor: m.toRoadLaneId
    }])
  );

  return {
    laneMap,
    fromCount,
    toCount,
    fromRoleUsed,
    toRoleUsed,
    sectionStartLaneLinks: buildLaneLinkObject(laneMap),
    sectionEndLaneLinks: buildLaneLinkObject(inverseLaneMap)
  };
}

function sideLaneCenterOffset(laneIdx, laneWidth, isLeftSide) {
  const idx = Math.max(1, Number(laneIdx || 1));
  const w = Math.max(0.5, Number(laneWidth || 3.5));
  const sign = isLeftSide ? 1 : -1;
  return sign * ((idx - 0.5) * w);
}

function approachRoleIsLeft(approach, role) {
  const endpoint = String(approach?.handle?.endpoint || '');
  if (role === 'incoming') return endpoint === 'start';
  if (role === 'outgoing') return endpoint === 'end';
  return endpoint === 'start';
}

function orientApproachesToward(approaches, target) {
  approaches.forEach((a) => {
    const toTarget = vecSub(target, a.pose);
    if (vecDot(toTarget, a.dir) < 0) {
      a.dir = vecScale(a.dir, -1);
    }
  });
}

function collectApproachInfo(handle) {
  const road = host.roads.value[handle.roadIdx];
  if (!road) return null;
  const pose = roadPoseAtEnd(road, handle.endpoint === 'start');
  if (!pose) return null;
  const incomingDir = normalizeVec(endpointDirection(handle.endpoint, pose.hdg));
  const outgoingDir = vecScale(incomingDir, -1);
  const leftLaneCount = Math.max(0, Number(road.leftLaneCount || 0));
  const rightLaneCount = Math.max(0, Number(road.rightLaneCount || 0));
  const leftLaneWidth = Math.max(0.5, Number(road.leftLaneWidth || road.laneWidth || 3.5));
  const rightLaneWidth = Math.max(0.5, Number(road.rightLaneWidth || road.laneWidth || 3.5));
  const incomingCount = handle.endpoint === 'end' ? rightLaneCount : leftLaneCount;
  const outgoingCount = handle.endpoint === 'end' ? leftLaneCount : rightLaneCount;
  const incomingWidth = handle.endpoint === 'end' ? rightLaneWidth : leftLaneWidth;
  const outgoingWidth = handle.endpoint === 'end' ? leftLaneWidth : rightLaneWidth;
  const totalRoadWidth = Math.max(2, leftLaneCount * leftLaneWidth + rightLaneCount * rightLaneWidth);
  return {
    handle: { roadIdx: handle.roadIdx, endpoint: handle.endpoint },
    road,
    pose: { x: pose.x, y: pose.y, hdg: pose.hdg },
    dir: incomingDir,
    incomingDir,
    outgoingDir,
    incomingNormal: perpLeft(incomingDir),
    outgoingNormal: perpLeft(outgoingDir),
    incomingCount,
    outgoingCount,
    incomingWidth,
    outgoingWidth,
    totalRoadWidth,
    halfWidth: totalRoadWidth * 0.5
  };
}

function normalizeConnectorCenterline(points, p0, p3) {
  const out = [];
  const source = Array.isArray(points) ? points : [];
  for (const pt of source) {
    if (!pt || !Number.isFinite(Number(pt.x)) || !Number.isFinite(Number(pt.y))) continue;
    const next = { x: Number(pt.x), y: Number(pt.y) };
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - next.x, last.y - next.y) > 1e-4) {
      out.push(next);
    }
  }
  if (!out.length) return [{ x: p0.x, y: p0.y }, { x: p3.x, y: p3.y }];
  out[0] = { x: p0.x, y: p0.y };
  out[out.length - 1] = { x: p3.x, y: p3.y };
  if (out.length < 2) out.push({ x: p3.x, y: p3.y });
  return out;
}

function buildConnectorCenterline(fromApproach, toApproach, smoothness) {
  const p0 = fromApproach.boundary;
  const p3 = toApproach.boundary;
  const d0 = normalizeVec(fromApproach.incomingDir || fromApproach.dir);
  const d3 = normalizeVec(toApproach.outgoingDir || vecScale(toApproach.dir, -1));
  const minRadius = Math.max(3, Number(fromApproach.halfWidth || 0) + Number(toApproach.halfWidth || 0) + 1.2);
  const directDist = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  if (directDist <= 1e-6) {
    return {
      points: [{ x: p0.x, y: p0.y }, { x: p3.x, y: p3.y }],
      bezierSegments: []
    };
  }
  const stub = clamp(directDist * 0.12, 0.6, 2.6);
  const p0Lead = vecAdd(p0, vecScale(d0, Math.min(stub, directDist * 0.3)));
  const p3Lead = vecSub(p3, vecScale(d3, Math.min(stub, directDist * 0.3)));
  const midChord = Math.hypot(p3Lead.x - p0Lead.x, p3Lead.y - p0Lead.y);
  const primaryCurve = buildBezierWithRadiusGuard(
    midChord > 0.3 ? p0Lead : p0,
    midChord > 0.3 ? p3Lead : p3,
    d0,
    d3,
    smoothness,
    minRadius
  );
  const stitched = [{ x: p0.x, y: p0.y }, ...primaryCurve.points, { x: p3.x, y: p3.y }];
  const primary = normalizeConnectorCenterline(stitched, p0, p3);
  const ratio = polylineLength(primary) / Math.max(1e-6, directDist);
  if (ratio <= 2.1) {
    return {
      points: primary,
      bezierSegments: []
    };
  }
  return {
    points: [],
    bezierSegments: []
  };
}

function buildInternalLaneCurve(
  fromApproach,
  toApproach,
  fromLane,
  toLane,
  smoothness,
  fromIsLeftSide = true,
  toIsLeftSide = true,
  fromLaneWidth = null,
  toLaneWidth = null
) {
  const startWidth = Number.isFinite(Number(fromLaneWidth))
    ? Number(fromLaneWidth)
    : Number(fromApproach.incomingWidth || 3.5);
  const endWidth = Number.isFinite(Number(toLaneWidth))
    ? Number(toLaneWidth)
    : Number(toApproach.outgoingWidth || 3.5);
  const startOffset = sideLaneCenterOffset(fromLane, startWidth, fromIsLeftSide);
  const endOffset = sideLaneCenterOffset(toLane, endWidth, toIsLeftSide);
  const p0 = vecAdd(fromApproach.boundary, vecScale(fromApproach.incomingNormal || fromApproach.normal, startOffset));
  const p3 = vecAdd(toApproach.boundary, vecScale(toApproach.outgoingNormal || vecScale(toApproach.normal, -1), endOffset));
  const d0 = normalizeVec(fromApproach.incomingDir || fromApproach.dir);
  const d3 = normalizeVec(toApproach.outgoingDir || vecScale(toApproach.dir, -1));
  const minRadius = Math.max(2, Math.max(Math.abs(startOffset), Math.abs(endOffset)) + 0.8);
  return buildBezierWithRadiusGuard(p0, p3, d0, d3, smoothness, minRadius).points;
}



function wrapAngleRad(angle) {
  let out = Number(angle || 0);
  while (out > Math.PI) out -= Math.PI * 2;
  while (out < -Math.PI) out += Math.PI * 2;
  return out;
}

function lineIntersectionFromPointsAndDirs(p0, d0, p1, d1) {
  const det = d0.x * d1.y - d0.y * d1.x;
  if (Math.abs(det) < 1e-8) return null;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  return {
    t0: (dx * d1.y - dy * d1.x) / det,
    t1: (dx * d0.y - dy * d0.x) / det
  };
}

function buildLineArcLineGeometryFromPoses(startPose, endPose, options = {}) {
  const x0 = Number(startPose?.x);
  const y0 = Number(startPose?.y);
  const h0 = Number(startPose?.hdg);
  const x3 = Number(endPose?.x);
  const y3 = Number(endPose?.y);
  const h3 = Number(endPose?.hdg);
  if (![x0, y0, h0, x3, y3, h3].every(Number.isFinite)) return null;
  const p0 = { x: x0, y: y0 };
  const p3 = { x: x3, y: y3 };
  const d0 = normalizeVec({ x: Math.cos(h0), y: Math.sin(h0) });
  const d3 = normalizeVec({ x: Math.cos(h3), y: Math.sin(h3) });
  const directDist = Math.hypot(x3 - x0, y3 - y0);
  if (directDist < 0.15) return null;

  let delta = wrapAngleRad(h3 - h0);
  if (Number.isFinite(Number(options.forcedDelta)) && Math.abs(delta) < 0.01) {
    delta = Number(options.forcedDelta);
  }
  if (Math.abs(delta) < 0.01 && !options.requireTriple) {
    const projected = vecDot(vecSub(p3, p0), d0);
    if (projected <= 0.05) return null;
    return {
      geometry: [{
        s: 0,
        x: x0,
        y: y0,
        hdg: h0,
        length: Number(projected.toFixed(6)),
        type: 'line'
      }],
      length: Number(projected.toFixed(6))
    };
  }
  if (Math.abs(delta) < MIN_BULGE_ARC_DELTA_RAD && options.requireTriple) {
    delta = delta >= 0 ? MIN_BULGE_ARC_DELTA_RAD : -MIN_BULGE_ARC_DELTA_RAD;
  }

  const turnSign = delta >= 0 ? 1 : -1;
  const inDirAtEnd = vecScale(d3, -1);
  const hit = lineIntersectionFromPointsAndDirs(p0, d0, p3, inDirAtEnd);
  if (!hit || hit.t0 <= 0.05 || hit.t1 <= 0.05) return null;

  const halfTurn = Math.abs(delta) * 0.5;
  const tanHalf = Math.tan(halfTurn);
  if (!Number.isFinite(tanHalf) || Math.abs(tanHalf) < 1e-6) return null;
  const targetLine = clamp(directDist * 0.045, 0.45, 1.2);
  const minLine = Math.min(targetLine, Math.max(0.05, Math.min(hit.t0, hit.t1) * 0.35));
  const maxTangent = Math.min(hit.t0 - minLine, hit.t1 - minLine);
  if (maxTangent <= 0.05) return null;

  const tangentForTargetLine = Math.min(hit.t0 - targetLine, hit.t1 - targetLine);
  const preferredRadius = Math.max(Number(options.minRadius || 0), 1.0);
  const radiusTangent = preferredRadius * Math.abs(tanHalf);
  const tangent = clamp(
    Math.max(radiusTangent, tangentForTargetLine),
    0.05,
    maxTangent
  );
  const radius = tangent / Math.abs(tanHalf);
  if (!Number.isFinite(radius) || radius < 0.2) return null;

  const line1Length = hit.t0 - tangent;
  const line2Length = hit.t1 - tangent;
  const arcStart = vecAdd(p0, vecScale(d0, line1Length));
  const arcEnd = vecAdd(p3, vecScale(inDirAtEnd, line2Length));
  const arcLength = radius * Math.abs(delta);
  if (line1Length <= 0.05 || line2Length <= 0.05 || arcLength <= 0.05) return null;

  const hArcEnd = h0 + delta;
  const geometry = [
    {
      s: 0,
      x: x0,
      y: y0,
      hdg: h0,
      length: Number(line1Length.toFixed(6)),
      type: 'line'
    },
    {
      s: Number(line1Length.toFixed(6)),
      x: arcStart.x,
      y: arcStart.y,
      hdg: h0,
      length: Number(arcLength.toFixed(6)),
      type: 'arc',
      curvature: turnSign / radius
    },
    {
      s: Number((line1Length + arcLength).toFixed(6)),
      x: arcEnd.x,
      y: arcEnd.y,
      hdg: hArcEnd,
      length: Number(line2Length.toFixed(6)),
      type: 'line'
    }
  ];
  const length = geometry.reduce((acc, g) => acc + Number(g.length || 0), 0);
  return { geometry, length: Number(length.toFixed(6)) };
}

function buildStubbedConnectorGeometryFromPoses(startPose, endPose) {
  const x0 = Number(startPose?.x);
  const y0 = Number(startPose?.y);
  const h0 = Number(startPose?.hdg);
  const x3 = Number(endPose?.x);
  const y3 = Number(endPose?.y);
  const h3 = Number(endPose?.hdg);
  if (![x0, y0, h0, x3, y3, h3].every(Number.isFinite)) return null;
  const directDist = Math.hypot(x3 - x0, y3 - y0);
  if (directDist < 0.15) return null;
  const stubLength = clamp(directDist * 0.045, 0.45, 1.2);
  const d0 = { x: Math.cos(h0), y: Math.sin(h0) };
  const d3 = { x: Math.cos(h3), y: Math.sin(h3) };
  const startLineEnd = { x: x0 + d0.x * stubLength, y: y0 + d0.y * stubLength };
  const endLineStart = { x: x3 - d3.x * stubLength, y: y3 - d3.y * stubLength };
  const middleLength = Math.hypot(endLineStart.x - startLineEnd.x, endLineStart.y - startLineEnd.y);
  const geometry = [];
  let s = 0;
  geometry.push({
    s,
    x: x0,
    y: y0,
    hdg: h0,
    length: Number(stubLength.toFixed(6)),
    type: 'line'
  });
  s += stubLength;
  if (middleLength > 0.05) {
    geometry.push({
      s: Number(s.toFixed(6)),
      x: startLineEnd.x,
      y: startLineEnd.y,
      hdg: Math.atan2(endLineStart.y - startLineEnd.y, endLineStart.x - startLineEnd.x),
      length: Number(middleLength.toFixed(6)),
      type: 'line'
    });
    s += middleLength;
  }
  geometry.push({
    s: Number(s.toFixed(6)),
    x: endLineStart.x,
    y: endLineStart.y,
    hdg: h3,
    length: Number(stubLength.toFixed(6)),
    type: 'line'
  });
  s += stubLength;
  return {
    geometry,
    length: Number(s.toFixed(6))
  };
}

function connectorTuneKey(fromRoadId, fromEndpoint, toRoadId, toEndpoint) {
  return `${String(fromRoadId)}:${String(fromEndpoint)}->${String(toRoadId)}:${String(toEndpoint)}`;
}

function getConnectorSasTune(fromRoadId, fromEndpoint, toRoadId, toEndpoint) {
  const direct = host.CONNECTOR_SAS_TUNE_OVERRIDES[connectorTuneKey(fromRoadId, fromEndpoint, toRoadId, toEndpoint)];
  if (direct) return direct;
  return host.CONNECTOR_SAS_TUNE_OVERRIDES[connectorTuneKey(toRoadId, toEndpoint, fromRoadId, fromEndpoint)] || null;
}

function integrateCurvatureSegment(startPose, curvStart, curvEnd, length, steps = 28) {
  const len = Math.max(0, Number(length || 0));
  const n = Math.max(1, Number(steps || 1));
  const ds = len / n;
  let x = Number(startPose.x || 0);
  let y = Number(startPose.y || 0);
  let hdg = Number(startPose.hdg || 0);
  for (let i = 0; i < n; i += 1) {
    const t = (i + 0.5) / n;
    const k = Number(curvStart || 0) + (Number(curvEnd || 0) - Number(curvStart || 0)) * t;
    hdg += k * ds * 0.5;
    x += Math.cos(hdg) * ds;
    y += Math.sin(hdg) * ds;
    hdg += k * ds * 0.5;
  }
  return { x, y, hdg };
}

function simulateSasPoses(startPose, curvature, spiralLength, arcLength) {
  const ls = Math.max(0.08, Number(spiralLength || 0));
  const la = Math.max(0.08, Number(arcLength || 0));
  const p0 = { x: Number(startPose.x || 0), y: Number(startPose.y || 0), hdg: Number(startPose.hdg || 0) };
  const p1 = integrateCurvatureSegment(p0, 0, curvature, ls);
  const p2 = integrateCurvatureSegment(p1, curvature, curvature, la);
  const p3 = integrateCurvatureSegment(p2, curvature, 0, ls);
  return { p0, p1, p2, p3 };
}

function buildSasGeometryBetweenPoses(startPose, endPose, options = {}) {
  const x0 = Number(startPose?.x);
  const y0 = Number(startPose?.y);
  const h0 = Number(startPose?.hdg);
  const x3 = Number(endPose?.x);
  const y3 = Number(endPose?.y);
  const h3 = Number(endPose?.hdg);
  if (![x0, y0, h0, x3, y3, h3].every(Number.isFinite)) return null;
  const chord = Math.hypot(x3 - x0, y3 - y0);
  if (chord < 0.6) return null;
  const delta = wrapAngleRad(h3 - h0);
  const chordDir = Math.atan2(y3 - y0, x3 - x0);
  const crossLike = Math.sin(chordDir - h0);
  const turnSign = Math.abs(delta) > 1e-6 ? (delta >= 0 ? 1 : -1) : (crossLike >= 0 ? 1 : -1);
  const absDelta = Math.max(Math.abs(delta), 1e-4);

  let best = null;
  const qMin = Number.isFinite(Number(options.qMin)) ? Number(options.qMin) : 0.45;
  const qMax = Number.isFinite(Number(options.qMax)) ? Number(options.qMax) : 2.2;
  const qPreferred = Number.isFinite(Number(options.qPreferred)) ? Number(options.qPreferred) : 1;
  const evalCandidate = (spiralRatio, totalLen, endSpiralScale = 1) => {
    const tLen = Math.max(chord * 0.5, Number(totalLen || 0));
    const p = clamp(Number(spiralRatio || 0.35), 0.12, 0.88);
    const q = clamp(Number(endSpiralScale || 1), qMin, qMax);
    const ls0 = tLen * p;
    const ls1 = ls0 * q;
    const la = tLen - ls0;
    if (ls0 < 0.08 || ls1 < 0.08 || la < 0.08) return;
    const headingGain = 0.5 * ls0 + la + 0.5 * ls1;
    if (headingGain < 1e-6) return;
    const curvature = turnSign * absDelta / headingGain;
    const p0 = { x: x0, y: y0, hdg: h0 };
    const p1 = integrateCurvatureSegment(p0, 0, curvature, ls0);
    const p2 = integrateCurvatureSegment(p1, curvature, curvature, la);
    const p3 = integrateCurvatureSegment(p2, curvature, 0, ls1);
    const poses = { p0, p1, p2, p3 };
    const posErr = Math.hypot(poses.p3.x - x3, poses.p3.y - y3);
    const hdgErr = Math.abs(wrapAngleRad(poses.p3.hdg - h3));
    const qPenalty = Math.abs(Math.log(Math.max(1e-6, q / Math.max(1e-6, qPreferred))));
    const score = posErr + chord * 0.35 * hdgErr + chord * 0.03 * qPenalty;
    if (!best || score < best.score) {
      best = { score, posErr, hdgErr, ls0, ls1, la, curvature, poses, q };
    }
  };

  for (let r = 0.08; r <= 0.92 + 1e-6; r += 0.06) {
    for (let scale = 0.45; scale <= 6.0 + 1e-6; scale += 0.2) {
      for (let q = 0.25; q <= 4.0 + 1e-6; q += 0.25) {
        evalCandidate(r, chord * scale, q);
      }
    }
  }
  if (!best) return null;

  let stepRatio = 0.08;
  let stepLen = Math.max(0.4, chord * 0.16);
  let stepQ = 0.16;
  for (let i = 0; i < 18; i += 1) {
    const baseRatio = best.ls0 / Math.max(1e-6, best.ls0 + best.la);
    const baseLen = best.ls0 + best.la;
    const candidates = [
      [baseRatio, baseLen, best.q],
      [baseRatio + stepRatio, baseLen, best.q],
      [baseRatio - stepRatio, baseLen, best.q],
      [baseRatio, baseLen + stepLen, best.q],
      [baseRatio, baseLen - stepLen, best.q],
      [baseRatio, baseLen, best.q + stepQ],
      [baseRatio, baseLen, best.q - stepQ]
    ];
    const prev = best;
    candidates.forEach(([ratio, len, q]) => evalCandidate(ratio, len, q));
    if (best === prev) {
      stepRatio *= 0.66;
      stepLen *= 0.66;
      stepQ *= 0.66;
    }
  }

  const { ls0, ls1, la, curvature, poses } = best;
  const geometry = [
    {
      s: 0,
      x: poses.p0.x,
      y: poses.p0.y,
      hdg: poses.p0.hdg,
      length: ls0,
      type: 'spiral',
      curvStart: 0,
      curvEnd: curvature
    },
    {
      s: ls0,
      x: poses.p1.x,
      y: poses.p1.y,
      hdg: poses.p1.hdg,
      length: la,
      type: 'arc',
      curvature
    },
    {
      s: ls0 + la,
      x: poses.p2.x,
      y: poses.p2.y,
      hdg: poses.p2.hdg,
      length: ls1,
      type: 'spiral',
      curvStart: curvature,
      curvEnd: 0
    }
  ];
  return {
    geometry,
    length: Number((ls0 + la + ls1).toFixed(6))
  };
}

function sampleGeometryToPoints(geometry, step = 0.45) {
  const out = [];
  (Array.isArray(geometry) ? geometry : []).forEach((g, idx) => {
    const len = Math.max(0, Number(g?.length || 0));
    if (len <= 1e-8) return;
    const p0 = { x: Number(g.x || 0), y: Number(g.y || 0), hdg: Number(g.hdg || 0) };
    const type = String(g.type || 'line').toLowerCase();
    const n = Math.max(1, Math.ceil(len / Math.max(0.1, Number(step || 0.45))));
    if (idx === 0) out.push({ x: p0.x, y: p0.y });
    for (let i = 1; i <= n; i += 1) {
      const sSeg = (len * i) / n;
      let pose = null;
      if (type === 'spiral') {
        pose = integrateCurvatureSegment(p0, Number(g.curvStart || 0), Number(g.curvEnd || 0), sSeg, Math.max(4, Math.ceil(sSeg / 0.12)));
      } else if (type === 'arc') {
        const k = Number(g.curvature || 0);
        if (Math.abs(k) < 1e-10) {
          pose = { x: p0.x + Math.cos(p0.hdg) * sSeg, y: p0.y + Math.sin(p0.hdg) * sSeg, hdg: p0.hdg };
        } else {
          const r = 1 / k;
          const cx = p0.x - Math.sin(p0.hdg) * r;
          const cy = p0.y + Math.cos(p0.hdg) * r;
          const a = p0.hdg + k * sSeg;
          pose = { x: cx + Math.sin(a) * r, y: cy - Math.cos(a) * r, hdg: a };
        }
      } else {
        pose = { x: p0.x + Math.cos(p0.hdg) * sSeg, y: p0.y + Math.sin(p0.hdg) * sSeg, hdg: p0.hdg };
      }
      out.push({ x: pose.x, y: pose.y });
    }
  });
  return sanitizePoints(out, 0.05);
}

function applySasGeometryToRoad(road, startPose, endPose, options = {}) {
  const sas = buildSasGeometryBetweenPoses(startPose, endPose, options);
  if (!sas) return false;
  road.geometry = sanitizeGeometryTypes(sas.geometry);
  road.geometryDirty = true;
  road.length = sas.length;
  const sampled = sampleGeometryToPoints(sas.geometry, 0.45);
  if (sampled.length >= 2) {
    road.points = sampled;
    road.editPoints = [sampled[0], sampled[sampled.length - 1]];
  }
  clearNativeGeometry(road);
  return true;
}

function applySasGeometryToRoadSafe(road, startPose, endPose, options = {}) {
  try {
    return applySasGeometryToRoad(road, startPose, endPose, options);
  } catch (error) {
    console.warn('[junction] applySasGeometryToRoad failed:', error);
    return false;
  }
}

function buildLineArcLineGeometryBetweenPoses(startPose, endPose) {
  if (host.junctionForm.debugEndpointLines) {
    return buildStubbedConnectorGeometryFromPoses(startPose, endPose);
  }
  const lalExact = buildLineArcLineGeometryFromPoses(startPose, endPose);
  if (lalExact) return lalExact;
  return buildStubbedConnectorGeometryFromPoses(startPose, endPose);
}

function applyConnectorGeometryToRoad(road, startPose, endPose) {
  const lal = buildLineArcLineGeometryBetweenPoses(startPose, endPose);
  if (!lal) return false;
  road.geometry = sanitizeGeometryTypes(lal.geometry);
  road.geometryDirty = true;
  road.length = lal.length;
  const sampled = sampleGeometryToPoints(lal.geometry, 0.45);
  if (sampled.length >= 2) {
    road.points = sampled;
    road.editPoints = [sampled[0], sampled[sampled.length - 1]];
  }
  clearNativeGeometry(road);
  return true;
}

function applyLineArcGeometryToRoad(road, points) {
  const built = buildGeneratedLineArcGeometry(points);
  if (!built) return false;
  road.geometry = sanitizeGeometryTypes(built.geometry);
  road.geometryDirty = true;
  road.length = built.length;
  const sampled = sampleGeometryToPoints(built.geometry, 0.45);
  if (sampled.length >= 2) {
    road.points = sampled;
    road.editPoints = [sampled[0], sampled[sampled.length - 1]];
  }
  clearNativeGeometry(road);
  return true;
}

function extendRoadEndpointToBoundary(road, endpoint, boundary) {
  const pts = getRoadEditPoints(road);
  if (pts.length < 2) return;
  if (endpoint === 'end') {
    const last = pts[pts.length - 1];
    const d = Math.hypot(boundary.x - last.x, boundary.y - last.y);
    if (d < 0.1) {
      last.x = boundary.x;
      last.y = boundary.y;
    } else {
      pts.push({ x: boundary.x, y: boundary.y });
    }
  } else {
    const first = pts[0];
    const d = Math.hypot(boundary.x - first.x, boundary.y - first.y);
    if (d < 0.1) {
      first.x = boundary.x;
      first.y = boundary.y;
    } else {
      pts.unshift({ x: boundary.x, y: boundary.y });
    }
  }
  applyRoadShape(road, pts);
}

function segmentIntersection(a1, a2, b1, b2) {
  const r = vecSub(a2, a1);
  const s = vecSub(b2, b1);
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-8) return null;
  const qp = vecSub(b1, a1);
  const t = (qp.x * s.y - qp.y * s.x) / denom;
  const u = (qp.x * r.y - qp.y * r.x) / denom;
  if (t <= 1e-4 || t >= 1 - 1e-4 || u <= 1e-4 || u >= 1 - 1e-4) return null;
  return {
    x: a1.x + t * r.x,
    y: a1.y + t * r.y,
    t,
    u
  };
}

function findRoadIntersection(firstRoad, secondRoad) {
  const firstPts = firstRoad?.points || [];
  const secondPts = secondRoad?.points || [];
  for (let i = 0; i < firstPts.length - 1; i += 1) {
    for (let j = 0; j < secondPts.length - 1; j += 1) {
      const hit = segmentIntersection(firstPts[i], firstPts[i + 1], secondPts[j], secondPts[j + 1]);
      if (hit) return { point: { x: hit.x, y: hit.y }, firstSeg: i, secondSeg: j };
    }
  }
  return null;
}

function isStandaloneRoad(road) {
  if (!road) return false;
  const id = String(road.id);
  return String(road.junction || '-1') === '-1'
    && String(road.predecessorType || 'road') === 'road'
    && String(road.successorType || 'road') === 'road'
    && String(road.predecessorId || id) === id
    && String(road.successorId || id) === id;
}

function splitRoadPointsAt(points, segIdx, point) {
  const source = sanitizePoints(points, 0.05);
  if (segIdx < 0 || segIdx >= source.length - 1) return null;
  const hit = { x: Number(point.x), y: Number(point.y) };
  const left = source.slice(0, segIdx + 1);
  const right = source.slice(segIdx + 1);
  if (!left.length || !right.length) return null;
  if (Math.hypot(left[left.length - 1].x - hit.x, left[left.length - 1].y - hit.y) > 1e-4) {
    left.push(hit);
  }
  if (Math.hypot(right[0].x - hit.x, right[0].y - hit.y) > 1e-4) {
    right.unshift(hit);
  }
  if (left.length < 2 || right.length < 2) return null;
  return { left, right };
}

function splitStandaloneRoadAtIntersection(roadIndex, segIdx, point) {
  const road = host.roads.value[roadIndex];
  if (!road || !isStandaloneRoad(road)) return null;
  const split = splitRoadPointsAt(road.points, segIdx, point);
  if (!split) return null;
  const leftRoadId = String(road.id);
  const rightRoad = createRoadFromPoints(split.right, {
    junction: '-1',
    leftLaneCount: road.leftLaneCount,
    rightLaneCount: road.rightLaneCount,
    laneWidth: road.laneWidth,
    leftLaneWidth: road.leftLaneWidth,
    rightLaneWidth: road.rightLaneWidth,
    centerType: road.centerType,
    predecessorType: 'road',
    successorType: 'road'
  });
  applyRoadShape(road, split.left);
  road.predecessorType = 'road';
  road.predecessorId = leftRoadId;
  road.successorType = 'road';
  road.successorId = String(rightRoad.id);
  rightRoad.predecessorId = leftRoadId;
  rightRoad.successorId = String(rightRoad.id);
  host.roads.value.splice(roadIndex + 1, 0, rightRoad);
  return {
    leftRoadId,
    rightRoadId: String(rightRoad.id)
  };
}

function maybeAutoGenerateJunctionForNewestRoad() {
  if (!host.drawForm.autoJunction || host.roads.value.length < 2) return false;
  const newRoadIndex = host.roads.value.length - 1;
  const newRoad = host.roads.value[newRoadIndex];
  if (!isStandaloneRoad(newRoad)) return false;
  let hitInfo = null;
  for (let i = 0; i < host.roads.value.length - 1; i += 1) {
    const other = host.roads.value[i];
    if (!isStandaloneRoad(other)) continue;
    const hit = findRoadIntersection(newRoad, other);
    if (hit) {
      hitInfo = { otherIndex: i, ...hit };
      break;
    }
  }
  if (!hitInfo) return false;

  const otherSplit = splitStandaloneRoadAtIntersection(hitInfo.otherIndex, hitInfo.secondSeg, hitInfo.point);
  if (!otherSplit) return false;
  const shiftedNewIndex = host.roads.value.findIndex((road) => String(road.id) === String(newRoad.id));
  const newSplit = splitStandaloneRoadAtIntersection(shiftedNewIndex, hitInfo.firstSeg, hitInfo.point);
  if (!newSplit) return false;

  const handles = [
    { id: otherSplit.leftRoadId, endpoint: 'end' },
    { id: otherSplit.rightRoadId, endpoint: 'start' },
    { id: newSplit.leftRoadId, endpoint: 'end' },
    { id: newSplit.rightRoadId, endpoint: 'start' }
  ].map((item) => ({
    roadIdx: host.roads.value.findIndex((road) => String(road.id) === String(item.id)),
    endpoint: item.endpoint
  })).filter((item) => item.roadIdx >= 0);

  if (handles.length < 3) return false;
  const result = generateJunctionFromHandles(handles);
  if (!result.ok) return false;
  host.junctionDraft.value = { handles: [] };
  return true;
}

function validateJunctionHandles(handles) {
  if (!Array.isArray(handles) || handles.length < 3 || handles.length > 4) {
    return '请先选择 3~4 个端点。';
  }
  const uniqRoads = new Set(handles.map((h) => String(h.roadIdx)));
  if (uniqRoads.size !== handles.length) {
    return '每个端点必须来自不同道路。';
  }
  const poses = handles.map((h) => {
    const road = host.roads.value[h.roadIdx];
    if (!road) return null;
    return roadPoseAtEnd(road, h.endpoint === 'start');
  });
  if (poses.some((p) => !p)) {
    return '存在无法识别的道路端点。';
  }
  for (let i = 0; i < poses.length; i += 1) {
    for (let j = i + 1; j < poses.length; j += 1) {
      if (Math.hypot(poses[i].x - poses[j].x, poses[i].y - poses[j].y) < 0.6) {
        return '检测到端点过近（可能已经连接），请选择彼此分离的道路段。';
      }
    }
  }
  return '';
}

function generateJunctionFromHandles(handles) {
  const invalidReason = validateJunctionHandles(handles);
  if (invalidReason) return { ok: false, reason: invalidReason };
  const preserveSelectedRoads = true;

  const approaches = handles.map((h) => collectApproachInfo(h)).filter(Boolean);
  if (approaches.length < 3 || approaches.length > 4) {
    return { ok: false, reason: '路口生成失败：端点解析不完整。' };
  }

  const centroid = approaches.reduce((acc, a) => ({ x: acc.x + a.pose.x, y: acc.y + a.pose.y }), { x: 0, y: 0 });
  centroid.x /= approaches.length;
  centroid.y /= approaches.length;

  orientApproachesToward(approaches, centroid);
  let center = solveVirtualIntersection(approaches) || centroid;
  orientApproachesToward(approaches, center);
  center = solveVirtualIntersection(approaches) || center;

  const edgePadding = Math.max(1, Number(host.junctionForm.edgePadding || 6));
  const refined = approaches.map((a) => {
    const toCenter = vecSub(center, a.pose);
    const projected = vecDot(toCenter, a.dir);
    const clearance = a.halfWidth + edgePadding;
    let advance = projected - clearance;
    if (!Number.isFinite(advance)) advance = vecLen(toCenter) * 0.55;
    if (projected > 0.8) {
      advance = clamp(advance, 0.8, Math.max(0.8, projected - 0.4));
    } else {
      advance = 0.8;
    }
    const meshBoundary = vecAdd(a.pose, vecScale(a.dir, advance));
    const boundary = preserveSelectedRoads
      ? { x: a.pose.x, y: a.pose.y }
      : meshBoundary;
    const normal = perpLeft(a.dir);
    const leftEdge = vecAdd(meshBoundary, vecScale(normal, a.halfWidth));
    const rightEdge = vecAdd(meshBoundary, vecScale(normal, -a.halfWidth));
    const radial = normalizeVec(vecSub(meshBoundary, center), vecScale(a.dir, -1));
    return {
      ...a,
      anchor: { x: a.pose.x, y: a.pose.y },
      boundary,
      normal,
      leftEdge,
      rightEdge,
      angle: Math.atan2(radial.y, radial.x)
    };
  }).sort((a, b) => a.angle - b.angle);

  const meshPolygon = convexHull(refined.flatMap((a) => [a.leftEdge, a.rightEdge]));
  if (meshPolygon.length < 3) {
    return { ok: false, reason: '路口生成失败：无法构造有效路口多边形。' };
  }

  const touchedApproachRoadIds = refined.map((a) => String(a.road.id));
  host.detachImportedSource({
    roadIds: touchedApproachRoadIds
  });
  const meshId = nextJunctionId();

  refined.forEach((a) => {
    if (a.handle.endpoint === 'end') {
      a.road.successorType = 'junction';
      a.road.successorId = String(meshId);
    } else {
      a.road.predecessorType = 'junction';
      a.road.predecessorId = String(meshId);
    }
  });

  if (!preserveSelectedRoads) {
    refined.forEach((a) => {
      extendRoadEndpointToBoundary(a.road, a.handle.endpoint, a.boundary);
    });
  }

  const generatedRoadIds = [];
  const laneCurves = [];
  const connectorMeta = [];
  let sasFallbackCount = 0;
  const directedFlows = [];
  for (const from of refined) {
    for (const to of refined) {
      if (to === from) continue;
      let centerline = buildConnectorCenterline(from, to, host.junctionForm.smoothness);
      if (!Array.isArray(centerline?.points) || centerline.points.length < 2) {
        return {
          ok: false,
          reason: `自动路口生成失败：道路 ${from.road.id} 到 ${to.road.id} 无法生成有效中心线，当前场景过于复杂。`
        };
      }
      const fromProfile = resolveApproachLaneProfile(from, 'incoming');
      const toProfile = resolveApproachLaneProfile(to, 'outgoing');
      directedFlows.push({
        from,
        to,
        centerline,
        fromProfile,
        toProfile
      });
    }
  }

  const expectedConnectorCount = directedFlows.length;

  for (const primary of directedFlows) {
    if (!primary) continue;

    const primarySideLeft = approachRoleIsLeft(primary.from, primary.fromProfile.roleUsed);
    const buildSideSpec = (flow, sideLeft) => {
      if (!flow) return null;
      const links = buildLaneSectionLinkSpecs(
        flow.from,
        flow.fromProfile,
        flow.to,
        flow.toProfile,
        sideLeft
      );
      const fromLaneWidth = Math.max(0.5, Number(flow.fromProfile.width || 3.5));
      const toLaneWidth = Math.max(0.5, Number(flow.toProfile.width || 3.5));
      return {
        flow,
        sideLeft,
        links,
        fromLaneWidth,
        toLaneWidth,
        transitionType: links.fromCount === links.toCount
          ? 'match'
          : (links.fromCount > links.toCount ? 'merge' : 'split')
      };
    };

    const leftSpec = primarySideLeft ? buildSideSpec(primary, true) : null;
    const rightSpec = primarySideLeft ? null : buildSideSpec(primary, false);

    const connectorRoad = createRoadFromPoints(
      primary.centerline.points,
      {},
      {
        bezierSegments: primary.centerline.bezierSegments,
        smoothing: host.junctionForm.smoothness
      }
    );
    const startPose = {
      x: primary.from.boundary.x,
      y: primary.from.boundary.y,
      hdg: Math.atan2(primary.from.incomingDir.y, primary.from.incomingDir.x)
    };
    const endDir = endpointFinalDirection(primary.to.handle.endpoint, primary.to.pose.hdg);
    const endPose = {
      x: primary.to.boundary.x,
      y: primary.to.boundary.y,
      hdg: Math.atan2(endDir.y, endDir.x)
    };
    const lineArcApplied = applyConnectorGeometryToRoad(connectorRoad, startPose, endPose);
    if (!lineArcApplied) {
      return {
        ok: false,
        reason: `自动路口生成失败：道路 ${primary.from.road.id} 到 ${primary.to.road.id} 无法生成 line/arc 连接几何，请调整道路位置、方向或减少复杂度后重试。`
      };
    }
    sasFallbackCount += 1;
    connectorRoad.junction = String(meshId);
    const leftStartCount = leftSpec ? leftSpec.links.fromCount : 0;
    const rightStartCount = rightSpec ? rightSpec.links.fromCount : 0;
    const leftEndCount = leftSpec ? leftSpec.links.toCount : leftStartCount;
    const rightEndCount = rightSpec ? rightSpec.links.toCount : rightStartCount;
    const leftStartWidth = leftSpec ? leftSpec.fromLaneWidth : 3.5;
    const rightStartWidth = rightSpec ? rightSpec.fromLaneWidth : 3.5;
    const leftEndWidth = leftSpec ? leftSpec.toLaneWidth : leftStartWidth;
    const rightEndWidth = rightSpec ? rightSpec.toLaneWidth : rightStartWidth;
    const mergeLaneLinks = (...objects) => Object.assign({}, ...objects.filter(Boolean));
    const sectionStartLaneLinks = mergeLaneLinks(
      leftSpec?.links?.sectionStartLaneLinks,
      rightSpec?.links?.sectionStartLaneLinks
    );
    const sectionEndLaneLinks = mergeLaneLinks(
      leftSpec?.links?.sectionEndLaneLinks,
      rightSpec?.links?.sectionEndLaneLinks
    );
    const leftWidthRecords = [{
      sOffset: 0,
      a: leftStartWidth,
      b: connectorRoad.length > 1e-6 ? (leftEndWidth - leftStartWidth) / connectorRoad.length : 0,
      c: 0,
      d: 0
    }];
    const rightWidthRecords = [{
      sOffset: 0,
      a: rightStartWidth,
      b: connectorRoad.length > 1e-6 ? (rightEndWidth - rightStartWidth) / connectorRoad.length : 0,
      c: 0,
      d: 0
    }];

    connectorRoad.leftLaneCount = leftStartCount;
    connectorRoad.rightLaneCount = rightStartCount;
    connectorRoad.leftLaneWidth = leftStartWidth;
    connectorRoad.rightLaneWidth = rightStartWidth;
    connectorRoad.laneWidth = (leftStartWidth + rightStartWidth) * 0.5;
    connectorRoad.centerType = primary.from.centerType || 'none';
    connectorRoad.predecessorType = 'road';
    connectorRoad.predecessorId = String(primary.from.road.id);
    connectorRoad.predecessorContactPoint = primary.from.handle.endpoint;
    connectorRoad.successorType = 'road';
    connectorRoad.successorId = String(primary.to.road.id);
    connectorRoad.successorContactPoint = primary.to.handle.endpoint;
    connectorRoad.connectorMeta = {
      kind: 'junction_internal',
      bidirectional: false,
      fromRoadId: String(primary.from.road.id),
      toRoadId: String(primary.to.road.id),
      fromEndpoint: primary.from.handle.endpoint,
      toEndpoint: primary.to.handle.endpoint
    };
    connectorRoad.leftWidthRecords = leftWidthRecords;
    connectorRoad.rightWidthRecords = rightWidthRecords;
    connectorRoad.laneSectionsSpec = [
      {
        s: 0,
        leftLaneCount: leftStartCount,
        rightLaneCount: rightStartCount,
        leftLaneWidth: leftStartWidth,
        rightLaneWidth: rightStartWidth,
        centerType: 'none',
        leftWidthRecords,
        rightWidthRecords,
        laneLinks: sectionStartLaneLinks
      }
    ];

    const roadLaneCurves = [];
    const appendLaneCurves = (spec) => {
      if (!spec) return;
      const fromLaneSideIsLeft = approachRoleIsLeft(spec.flow.from, spec.links.fromRoleUsed);
      const toLaneSideIsLeft = approachRoleIsLeft(spec.flow.to, spec.links.toRoleUsed);
      spec.links.laneMap.forEach((m) => {
        roadLaneCurves.push(buildInternalLaneCurve(
          spec.flow.from,
          spec.flow.to,
          m.from,
          m.to,
          host.junctionForm.smoothness,
          fromLaneSideIsLeft,
          toLaneSideIsLeft,
          spec.fromLaneWidth,
          spec.toLaneWidth
        ));
      });
    };
    appendLaneCurves(leftSpec);
    appendLaneCurves(rightSpec);
    connectorRoad.internalLaneCurves = roadLaneCurves;
    roadLaneCurves.forEach((curve) => laneCurves.push(curve));

    clearNativeGeometry(connectorRoad);
    host.roads.value.push(connectorRoad);
    generatedRoadIds.push(String(connectorRoad.id));

    const pushConnectionMeta = (spec) => {
      if (!spec) return;
      connectorMeta.push({
        roadId: String(connectorRoad.id),
        fromRoadId: String(spec.flow.from.road.id),
        toRoadId: String(spec.flow.to.road.id),
        entryContactPoint: 'start',
        transition: spec.transitionType,
        fromRoleUsed: spec.links.fromRoleUsed,
        toRoleUsed: spec.links.toRoleUsed,
        fromRoleFallback: Boolean(spec.flow.fromProfile.fallbackUsed),
        toRoleFallback: Boolean(spec.flow.toProfile.fallbackUsed),
        laneMap: spec.links.laneMap
      });
    };
    pushConnectionMeta(leftSpec);
    pushConnectionMeta(rightSpec);
  }

  host.junctionMeshes.value.push({
    id: meshId,
    center,
    polygon: meshPolygon,
    approaches: refined.map((a) => ({
      roadId: String(a.road.id),
      endpoint: a.handle.endpoint,
      anchor: a.anchor,
      boundary: a.boundary
    })),
    connectorMeta,
    internalLaneCurves: laneCurves
  });
  host.junctionSpecs.value.push({
    id: String(meshId),
    name: `junction_${meshId}`,
    connections: connectorMeta.map((conn, index) => ({
      id: String(index),
      incomingRoad: String(conn.fromRoadId),
      connectingRoad: String(conn.roadId),
      contactPoint: conn.entryContactPoint || 'start',
      laneLinks: (conn.laneMap || []).map((link) => ({
        from: String(link.fromRoadLaneId),
        to: String(link.connectorLaneId)
      }))
    }))
  });

  if (generatedRoadIds.length !== expectedConnectorCount) {
    window.alert(`路口连接生成不完整：理论 ${expectedConnectorCount} 条，实际 ${generatedRoadIds.length} 条。`);
  }

  if (generatedRoadIds.length) {
    const lastAddedRoadId = generatedRoadIds[generatedRoadIds.length - 1];
    host.selectedRoadIndex.value = host.roads.value.findIndex((r) => String(r.id) === lastAddedRoadId);
  } else {
    host.selectedRoadIndex.value = refined.length ? refined[0].handle.roadIdx : -1;
  }
  host.render();
  return {
    ok: true,
    generatedCount: generatedRoadIds.length,
    expectedCount: expectedConnectorCount,
    sasFallbackCount
  };
}

function generateJunctionFromDraft() {
  if (host.junctionUi.generating) return;
  const handles = (host.junctionDraft.value.handles || []).slice();
  host.junctionUi.generating = true;
  host.junctionUi.status = '正在生成路口...';
  host.junctionUi.lastError = '';
  host.junctionUi.lastGeneratedCount = 0;
  host.junctionUi.lastExpectedCount = 0;
  host.render();
  try {
    const result = generateJunctionFromHandles(handles);
    host.junctionDraft.value = { handles: [] };
    if (!result?.ok) {
      host.junctionUi.lastError = result?.reason || '自动路口生成失败。';
      host.junctionUi.status = '';
      window.alert(host.junctionUi.lastError);
      return;
    }
    host.junctionUi.lastGeneratedCount = Number(result.generatedCount || 0);
    host.junctionUi.lastExpectedCount = Number(result.expectedCount || 0);
    const lineArcGeometryCount = Number(result.sasFallbackCount || 0);
    host.junctionUi.status = `已生成 ${host.junctionUi.lastGeneratedCount}/${host.junctionUi.lastExpectedCount} 条连接道路`;
    if (lineArcGeometryCount > 0) {
      host.junctionUi.status += `（${lineArcGeometryCount} 条使用 line/arc 几何）`;
    }
  } catch (error) {
    const message = error?.message || String(error || '未知错误');
    host.junctionUi.lastError = `自动路口生成异常：${message}`;
    host.junctionUi.status = '';
    console.error('[junction] generate failed:', error);
    window.alert(host.junctionUi.lastError);
  } finally {
    host.junctionUi.generating = false;
    host.render();
  }
}

function buildBezierBetweenHandles(firstHandle, secondHandle, smoothness, overlapValue = host.connectForm.overlap) {
  const firstRoad = host.roads.value[firstHandle.roadIdx];
  const secondRoad = host.roads.value[secondHandle.roadIdx];
  if (!firstRoad || !secondRoad) return null;
  const p0 = roadPoseAtEnd(firstRoad, firstHandle.endpoint === 'start');
  const p3 = roadPoseAtEnd(secondRoad, secondHandle.endpoint === 'start');
  if (!p0 || !p3) return null;
  const overlap = clamp(Number(overlapValue || 0), 0, 6);
  const d0 = endpointDirection(firstHandle.endpoint, p0.hdg);
  const d3 = endpointFinalDirection(secondHandle.endpoint, p3.hdg);
  const start = { x: p0.x, y: p0.y };
  const end = { x: p3.x, y: p3.y };
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const handleLen = Math.max(4, Math.min(120, dist * Number(smoothness || 0.35))) + overlap * 0.25;
  const p1 = { x: start.x + d0.x * handleLen, y: start.y + d0.y * handleLen };
  const p2 = { x: end.x - d3.x * handleLen, y: end.y - d3.y * handleLen };
  const curve = { p0: start, p1, p2, p3: end };
  const points = sampleBezierCurve(curve);
  return { points, bezierSegments: [curve], firstRoad, secondRoad, overlap };
}

function laneProfileAtConnectorSide(road, endpoint, sideMode) {
  const leftCount = Math.max(0, Number(road.leftLaneCount || 0));
  const rightCount = Math.max(0, Number(road.rightLaneCount || 0));
  const leftWidth = Math.max(0.5, Number(road.leftLaneWidth || road.laneWidth || 3.5));
  const rightWidth = Math.max(0.5, Number(road.rightLaneWidth || road.laneWidth || 3.5));
  let swap = false;
  if (sideMode === 'outward') {
    swap = endpoint === 'start';
  } else if (sideMode === 'inward') {
    swap = endpoint === 'end';
  }
  if (!swap) {
    return { leftCount, rightCount, leftWidth, rightWidth };
  }
  return {
    leftCount: rightCount,
    rightCount: leftCount,
    leftWidth: rightWidth,
    rightWidth: leftWidth
  };
}

function blendedConnectorProfile(firstRoad, firstEndpoint, secondRoad, secondEndpoint) {
  const a = laneProfileAtConnectorSide(firstRoad, firstEndpoint, 'outward');
  const b = laneProfileAtConnectorSide(secondRoad, secondEndpoint, 'inward');
  let leftCount = Math.round((a.leftCount + b.leftCount) / 2);
  let rightCount = Math.round((a.rightCount + b.rightCount) / 2);
  if (leftCount + rightCount <= 0) rightCount = 1;
  return {
    leftLaneCount: Math.max(0, leftCount),
    rightLaneCount: Math.max(0, rightCount),
    leftLaneWidth: Math.max(0.5, (a.leftWidth + b.leftWidth) * 0.5),
    rightLaneWidth: Math.max(0.5, (a.rightWidth + b.rightWidth) * 0.5)
  };
}

function connectorPosesFromHandles(firstHandle, secondHandle) {
  const firstRoad = host.roads.value[firstHandle?.roadIdx];
  const secondRoad = host.roads.value[secondHandle?.roadIdx];
  if (!firstRoad || !secondRoad) return null;
  const p0 = roadPoseAtEnd(firstRoad, firstHandle.endpoint === 'start');
  const p3 = roadPoseAtEnd(secondRoad, secondHandle.endpoint === 'start');
  if (!p0 || !p3) return null;
  const startDir = endpointDirection(firstHandle.endpoint, p0.hdg);
  const endDir = endpointFinalDirection(secondHandle.endpoint, p3.hdg);
  return {
    startPose: {
      x: p0.x,
      y: p0.y,
      hdg: Math.atan2(startDir.y, startDir.x)
    },
    endPose: {
      x: p3.x,
      y: p3.y,
      hdg: Math.atan2(endDir.y, endDir.x)
    },
    firstRoad,
    secondRoad
  };
}

function connectRoadsWithBezier(firstHandle, secondHandle, smoothness) {
  if (!firstHandle || !secondHandle) return false;
  if (firstHandle.roadIdx === secondHandle.roadIdx) return false;
  const built = buildBezierBetweenHandles(firstHandle, secondHandle, smoothness);
  if (!built) return false;
  const { points, bezierSegments, firstRoad, secondRoad, overlap } = built;
  const existingIdx = host.roads.value.findIndex((r) => {
    if (!r?.connectorMeta) return false;
    const m = r.connectorMeta;
    const sameDir = String(m.fromRoadId) === String(firstRoad.id)
      && String(m.toRoadId) === String(secondRoad.id)
      && String(m.fromEndpoint) === String(firstHandle.endpoint)
      && String(m.toEndpoint) === String(secondHandle.endpoint);
    const reverseDir = String(m.fromRoadId) === String(secondRoad.id)
      && String(m.toRoadId) === String(firstRoad.id)
      && String(m.fromEndpoint) === String(secondHandle.endpoint)
      && String(m.toEndpoint) === String(firstHandle.endpoint);
    return sameDir || reverseDir;
  });
  const targetRoad = existingIdx >= 0
    ? host.roads.value[existingIdx]
    : createRoadFromPoints(points, {}, { bezierSegments });
  const profile = blendedConnectorProfile(firstRoad, firstHandle.endpoint, secondRoad, secondHandle.endpoint);
  const poses = connectorPosesFromHandles(firstHandle, secondHandle);
  const connectorApplied = poses
    ? applyConnectorGeometryToRoad(targetRoad, poses.startPose, poses.endPose)
    : false;
  if (!connectorApplied) {
    applyRoadShape(targetRoad, points, { bezierSegments, smoothing: smoothness });
  }
  targetRoad.leftLaneCount = profile.leftLaneCount;
  targetRoad.rightLaneCount = profile.rightLaneCount;
  targetRoad.leftLaneWidth = profile.leftLaneWidth;
  targetRoad.rightLaneWidth = profile.rightLaneWidth;
  targetRoad.laneWidth = (profile.leftLaneWidth + profile.rightLaneWidth) * 0.5;
  targetRoad.connectorMeta = {
    fromRoadId: String(firstRoad.id),
    toRoadId: String(secondRoad.id),
    fromEndpoint: firstHandle.endpoint,
    toEndpoint: secondHandle.endpoint,
    smoothness: Number(smoothness || 0.35),
    overlap: Number(overlap || 0)
  };
  targetRoad.predecessorType = 'road';
  targetRoad.predecessorId = String(firstRoad.id);
  targetRoad.successorType = 'road';
  targetRoad.successorId = String(secondRoad.id);
  if (firstHandle.endpoint === 'end') {
    firstRoad.successorType = 'road';
    firstRoad.successorId = targetRoad.id;
  } else {
    firstRoad.predecessorType = 'road';
    firstRoad.predecessorId = targetRoad.id;
  }
  if (secondHandle.endpoint === 'start') {
    secondRoad.predecessorType = 'road';
    secondRoad.predecessorId = targetRoad.id;
  } else {
    secondRoad.successorType = 'road';
    secondRoad.successorId = targetRoad.id;
  }
  clearNativeGeometry(firstRoad);
  clearNativeGeometry(secondRoad);
  clearNativeGeometry(targetRoad);
  host.detachImportedSource({
    roadIds: [String(firstRoad.id), String(secondRoad.id), String(targetRoad.id)]
  });
  if (existingIdx < 0) {
    host.roads.value.push(targetRoad);
    host.selectedRoadIndex.value = host.roads.value.length - 1;
  } else {
    host.selectedRoadIndex.value = existingIdx;
  }
  host.render();
  return true;
}

function rebuildSelectedConnector() {
  const road = host.selectedRoad.value;
  if (!road?.connectorMeta) return;
  const fromIdx = host.roads.value.findIndex((r) => String(r.id) === String(road.connectorMeta.fromRoadId));
  const toIdx = host.roads.value.findIndex((r) => String(r.id) === String(road.connectorMeta.toRoadId));
  if (fromIdx < 0 || toIdx < 0) return;
  const firstHandle = { roadIdx: fromIdx, endpoint: road.connectorMeta.fromEndpoint };
  const secondHandle = { roadIdx: toIdx, endpoint: road.connectorMeta.toEndpoint };
  const built = buildBezierBetweenHandles(firstHandle, secondHandle, host.connectForm.smoothness, host.connectForm.overlap);
  if (!built) return;
  const profile = blendedConnectorProfile(host.roads.value[fromIdx], firstHandle.endpoint, host.roads.value[toIdx], secondHandle.endpoint);
  const poses = connectorPosesFromHandles(firstHandle, secondHandle);
  const connectorApplied = poses
    ? applyConnectorGeometryToRoad(road, poses.startPose, poses.endPose)
    : false;
  if (!connectorApplied) {
    applyRoadShape(road, built.points, { bezierSegments: built.bezierSegments });
    applyLineArcGeometryToRoad(road, built.points);
  }
  road.leftLaneCount = profile.leftLaneCount;
  road.rightLaneCount = profile.rightLaneCount;
  road.leftLaneWidth = profile.leftLaneWidth;
  road.rightLaneWidth = profile.rightLaneWidth;
  road.laneWidth = (profile.leftLaneWidth + profile.rightLaneWidth) * 0.5;
  road.connectorMeta.smoothness = Number(host.connectForm.smoothness);
  road.connectorMeta.overlap = Number(host.connectForm.overlap || 0);
  host.detachImportedSource({
    roadIds: [String(road.id)]
  });
  host.render();
}

function rebuildConnectorRoadFromMeta(connectorRoad) {
  if (!connectorRoad?.connectorMeta) return false;
  const meta = connectorRoad.connectorMeta;
  const fromIdx = host.roads.value.findIndex((r) => String(r.id) === String(meta.fromRoadId));
  const toIdx = host.roads.value.findIndex((r) => String(r.id) === String(meta.toRoadId));
  if (fromIdx < 0 || toIdx < 0) return false;
  const firstHandle = { roadIdx: fromIdx, endpoint: meta.fromEndpoint };
  const secondHandle = { roadIdx: toIdx, endpoint: meta.toEndpoint };
  const smoothness = Number(meta.smoothness || 0.35);
  const overlap = Number(meta.overlap || 0);
  const built = buildBezierBetweenHandles(firstHandle, secondHandle, smoothness, overlap);
  if (!built) return false;
  const profile = blendedConnectorProfile(host.roads.value[fromIdx], firstHandle.endpoint, host.roads.value[toIdx], secondHandle.endpoint);
  const poses = connectorPosesFromHandles(firstHandle, secondHandle);
  const connectorApplied = poses
    ? applyConnectorGeometryToRoad(connectorRoad, poses.startPose, poses.endPose)
    : false;
  if (!connectorApplied) {
    applyRoadShape(connectorRoad, built.points, { bezierSegments: built.bezierSegments });
    applyLineArcGeometryToRoad(connectorRoad, built.points);
  }
  connectorRoad.leftLaneCount = profile.leftLaneCount;
  connectorRoad.rightLaneCount = profile.rightLaneCount;
  connectorRoad.leftLaneWidth = profile.leftLaneWidth;
  connectorRoad.rightLaneWidth = profile.rightLaneWidth;
  connectorRoad.laneWidth = (profile.leftLaneWidth + profile.rightLaneWidth) * 0.5;
  host.detachImportedSource({
    roadIds: [String(connectorRoad.id)]
  });
  return true;
}

function getAllHandles() {
  const handles = [];
  host.roads.value.forEach((road, roadIdx) => {
    const start = roadPoseAtEnd(road, true);
    const end = roadPoseAtEnd(road, false);
    if (start) handles.push({ roadIdx, endpoint: 'start', ...start });
    if (end) handles.push({ roadIdx, endpoint: 'end', ...end });
  });
  return handles;
}

function pickHandle(screenX, screenY) {
  let best = null;
  let bestDist = Infinity;
  getAllHandles().forEach((h) => {
    const p = host.worldToScreen(h.x, h.y);
    const d = Math.hypot(screenX - p.x, screenY - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  });
  return bestDist <= 10 ? best : null;
}

function completeExtend(toPoint) {
  const draft = host.extendDraft.value;
  if (!draft) return;
  const fromRoad = host.roads.value[draft.roadIdx];
  if (!fromRoad) {
    host.extendDraft.value = null;
    return;
  }
  const anchor = draft.anchor;
  const d = Math.hypot(toPoint.x - anchor.x, toPoint.y - anchor.y);
  if (d < 0.5) {
    host.extendDraft.value = null;
    host.render();
    return;
  }
  const newRoad = createRoadFromPoints([
    { x: anchor.x, y: anchor.y },
    { x: toPoint.x, y: toPoint.y }
  ]);
  if (draft.endpoint === 'end') {
    fromRoad.successorType = 'road';
    fromRoad.successorId = newRoad.id;
    newRoad.predecessorType = 'road';
    newRoad.predecessorId = String(fromRoad.id);
  } else {
    fromRoad.predecessorType = 'road';
    fromRoad.predecessorId = newRoad.id;
    newRoad.successorType = 'road';
    newRoad.successorId = String(fromRoad.id);
  }
  clearNativeGeometry(fromRoad);
  host.detachImportedSource({ roadIds: [String(fromRoad.id), String(newRoad.id)] });
  host.roads.value.push(newRoad);
  host.selectedRoadIndex.value = host.roads.value.length - 1;
  host.extendDraft.value = null;
  host.render();
}

function rebuildConnectorsLinkedToRoad(roadId) {
  const targetRoadId = String(roadId || '').trim();
  if (!targetRoadId) return false;
  let changed = false;
  host.roads.value.forEach((road) => {
    if (!road?.connectorMeta) return;
    if (String(road.connectorMeta.fromRoadId) !== targetRoadId
      && String(road.connectorMeta.toRoadId) !== targetRoadId) {
      return;
    }
    if (rebuildConnectorRoadFromMeta(road)) changed = true;
  });
  return changed;
}


  Object.assign(host, {
    nextRoadId, defaultRoadFromPoints, applyRoadShape, buildRoadShapeFromPoints, createRoadFromPoints, nextJunctionId,
    generateJunctionFromDraft, connectRoadsWithBezier, rebuildSelectedConnector, rebuildConnectorsLinkedToRoad,
    getRoadEditPoints, getAllHandles, pickHandle, completeExtend,
    buildRoadShapeFromDrawDraft, buildRoadShapeFromStraightAnchors, isDrawCurveKind,
    createRoadFromDrawDraft, appendDrawAnchor, syncDrawSegmentControls,
    pickDrawCurveControl, pickRoadCurveControl, defaultDrawSegmentControl, isDrawControlCurved,
    ensureRoadSegmentControls, ensureRoadSegmentHeadings, applyRoadFromSegmentControls,
    prepareRoadPenEdit, recomputeSegmentHeadings, syncDrawSegmentHeadings, defaultEditPoints,
    maybeAutoGenerateJunctionForNewestRoad
  });

}
