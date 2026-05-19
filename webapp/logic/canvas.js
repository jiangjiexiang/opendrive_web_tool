import { rotateVec, clamp, vecAdd, vecSub, vecScale, vecDot, vecLen, normalizeVec, perpLeft, polylineLength, distPointToSeg } from '../editorUtils.js';
import { getRoadPaletteForRoad as computeRoadPaletteForRoad, getJunctionGuideStyle } from '../roadColors.js';
import {
  GRID_BASE_M, GRID_TARGET_PX, ROAD_RENDER_CACHE, ROAD_BOUNDS_CACHE,
  FIT_VIEW_MAX_ROAD_SAMPLES, FIT_VIEW_MAX_POINTS_PER_ROAD
} from './constants.js';

export function installCanvas(host) {
function worldToScreen(x, y) {
  return { x: x * host.view.scale + host.view.offsetX, y: -y * host.view.scale + host.view.offsetY };
}

function screenToWorld(x, y) {
  return { x: (x - host.view.offsetX) / host.view.scale, y: (host.view.offsetY - y) / host.view.scale };
}


function projectPointToSeg(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const segLenSq = vx * vx + vy * vy;
  if (segLenSq <= 1e-10) {
    return {
      x: a.x,
      y: a.y,
      ratio: 0,
      distance: Math.hypot(p.x - a.x, p.y - a.y),
      signedOffset: 0
    };
  }
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const rawRatio = (vx * wx + vy * wy) / segLenSq;
  const ratio = clamp(rawRatio, 0, 1);
  const projX = a.x + vx * ratio;
  const projY = a.y + vy * ratio;
  const dx = p.x - projX;
  const dy = p.y - projY;
  const segLen = Math.sqrt(segLenSq);
  const leftNormalX = -vy / segLen;
  const leftNormalY = vx / segLen;
  return {
    x: projX,
    y: projY,
    ratio,
    distance: Math.hypot(dx, dy),
    signedOffset: dx * leftNormalX + dy * leftNormalY
  };
}

function projectPointToRoadST(p, road) {
  const pts = Array.isArray(road?.points) ? road.points : [];
  if (pts.length < 2) return null;
  let best = null;
  let accS = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen <= 1e-8) continue;
    const projected = projectPointToSeg(p, a, b);
    const s = Number.isFinite(Number(a.s)) && Number.isFinite(Number(b.s))
      ? Number(a.s) + projected.ratio * (Number(b.s) - Number(a.s))
      : accS + projected.ratio * segLen;
    const profile = getRoadProfileAtS(road, s);
    const halfWidth = Math.max(Math.abs(profile.leftBoundary - profile.laneOffset), Math.abs(profile.rightBoundary - profile.laneOffset), 1.8);
    const candidate = {
      roadId: String(road.id ?? ''),
      s,
      t: projected.signedOffset,
      distance: projected.distance,
      halfWidth,
      minT: Math.min(profile.leftBoundary, profile.rightBoundary),
      maxT: Math.max(profile.leftBoundary, profile.rightBoundary),
      laneId: getLaneIdAtST(road, s, projected.signedOffset)
    };
    if (!best || candidate.distance < best.distance) {
      best = candidate;
    }
    accS += segLen;
  }
  return best;
}

function updateHoverRoadCoord(worldPoint) {
  const screenTolerance = 24 / Math.max(0.1, host.view.scale);
  const viewportBounds = getViewportBounds(80);
  const rejectMargin = screenTolerance + 12;
  let best = null;
  host.roads.value.forEach((road) => {
    if (road?.visible === false) return;
    if (!roadNearWorldPoint(road, worldPoint, rejectMargin)) return;
    const bounds = getRoadBounds(road);
    if (bounds && viewportBounds && !boundsIntersect(bounds, viewportBounds)) return;
    const projected = projectPointToRoadST(worldPoint, road);
    if (!projected) return;
    if (!best || projected.distance < best.distance) best = projected;
  });
  const maxDistance = best ? Math.max(screenTolerance, Number(best.halfWidth || 0) + 1.5) : screenTolerance;
  const tWithinRoad = best
    ? Number(best.t || 0) >= Number(best.minT ?? -best.halfWidth) - 0.1
      && Number(best.t || 0) <= Number(best.maxT ?? best.halfWidth) + 0.1
    : false;
  if (!best || best.distance > maxDistance || !tWithinRoad) {
    host.hoverRoadCoord.roadId = '';
    host.hoverRoadCoord.laneId = '';
    host.hoverRoadCoord.s = null;
    host.hoverRoadCoord.t = null;
    host.hoverRoadCoord.distance = null;
    return;
  }
  host.hoverRoadCoord.roadId = best.roadId;
  host.hoverRoadCoord.laneId = best.laneId || '';
  host.hoverRoadCoord.s = best.s;
  host.hoverRoadCoord.t = best.t;
  host.hoverRoadCoord.distance = best.distance;
}

function distPointToPolyline(p, points) {
  if (!Array.isArray(points) || points.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const d = distPointToSeg(p, points[i - 1], points[i]);
    if (d < best) best = d;
  }
  return best;
}

function isPointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  const px = Number(point.x);
  const py = Number(point.y);
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = Number(polygon[i].x);
    const yi = Number(polygon[i].y);
    const xj = Number(polygon[j].x);
    const yj = Number(polygon[j].y);
    const intersect = ((yi > py) !== (yj > py))
      && (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pickRoad(worldPoint) {
  let best = { idx: -1, score: Infinity };
  // clickPadding: minimum 5m or 22px worth, whichever is larger — makes clicking forgiving
  const pxTolerance = 22;
  const clickPadding = Math.max(5, pxTolerance / Math.max(0.1, host.view.scale));
  const nearMargin = clickPadding + 16;
  host.roads.value.forEach((r, idx) => {
    if (r?.visible === false) return;
    if (!r.points || r.points.length < 2) return;
    // Bounds-box pre-filter (cheap)
    if (!roadNearWorldPoint(r, worldPoint, nearMargin)) return;
    const renderData = getRoadRenderData(r);
    // Use rendered centerRef for distance, fallback to raw points
    const centerLine = renderData?.centerRef?.length > 1 ? renderData.centerRef : r.points;
    const centerDist = distPointToPolyline(worldPoint, centerLine);
    if (centerDist > nearMargin + 8) return;
    const firstProfile = getRoadProfileAtS(r, Number(r.points?.[0]?.s || 0));
    const lastProfile = getRoadProfileAtS(r, Number(r.points?.[r.points.length - 1]?.s || r.length || 0));
    const halfWidth = Math.max(
      2,
      Math.abs(firstProfile.leftBoundary - firstProfile.laneOffset),
      Math.abs(firstProfile.rightBoundary - firstProfile.laneOffset),
      Math.abs(lastProfile.leftBoundary - lastProfile.laneOffset),
      Math.abs(lastProfile.rightBoundary - lastProfile.laneOffset)
    );
    let score = centerDist - (halfWidth + clickPadding);

    // Inside the rendered band polygon → highest priority
    const leftPath = renderData?.leftBoundary || [];
    const rightPath = renderData?.rightBoundary || [];
    if (leftPath.length >= 2 && rightPath.length >= 2) {
      const bandPolygon = leftPath.concat([...rightPath].reverse());
      if (isPointInPolygon(worldPoint, bandPolygon)) {
        score = -100;
      }
    }

    if (score < best.score) best = { idx, score };
  });
  // Accept if within the hit zone (score ≤ 0) or very close miss (≤ 1px world unit)
  const missTolerance = 1 / Math.max(0.1, host.view.scale);
  return best.score <= missTolerance ? best.idx : -1;
}

function drawPolyline(points, color, width, dashed = false, showPoints = false) {
  if (!points || !points.length) return;
  host.ctx.beginPath();
  const p0 = worldToScreen(points[0].x, points[0].y);
  host.ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < points.length; i += 1) {
    const p = worldToScreen(points[i].x, points[i].y);
    host.ctx.lineTo(p.x, p.y);
  }
  host.ctx.strokeStyle = color;
  host.ctx.lineWidth = width;
  host.ctx.lineJoin = 'round';
  host.ctx.lineCap = 'round';
  host.ctx.setLineDash(dashed ? [10, 8] : []);
  host.ctx.stroke();
  host.ctx.setLineDash([]);
  if (showPoints) {
    points.forEach((pt) => {
      const p = worldToScreen(pt.x, pt.y);
      host.ctx.beginPath();
      host.ctx.arc(p.x, p.y, 2.8, 0, Math.PI * 2);
      host.ctx.fillStyle = color;
      host.ctx.fill();
    });
  }
}

function buildMeasureStats(includeHover = false) {
  const points = [];
  (host.measurePoints.value || []).forEach((pt) => {
    points.push({ x: Number(pt.x), y: Number(pt.y) });
  });
  if (includeHover && host.mode.value === 'measure' && host.measureHoverPoint.value && points.length > 0) {
    points.push({ x: Number(host.measureHoverPoint.value.x), y: Number(host.measureHoverPoint.value.y) });
  }
  const segmentLengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segmentLengths.push(len);
    total += len;
  }
  return {
    pointCount: host.measurePoints.value.length,
    segmentCount: Math.max(0, host.measurePoints.value.length - 1),
    total,
    segmentLengths
  };
}

function drawMeasureLabel(text, sx, sy) {
  const label = String(text);
  host.ctx.save();
  host.ctx.font = '12px sans-serif';
  const w = host.ctx.measureText(label).width;
  const padX = 6;
  const h = 18;
  const x = sx - w / 2 - padX;
  const y = sy - h - 10;
  host.ctx.fillStyle = 'rgba(7, 14, 26, 0.78)';
  host.ctx.fillRect(x, y, w + padX * 2, h);
  host.ctx.strokeStyle = 'rgba(120, 210, 255, 0.85)';
  host.ctx.lineWidth = 1;
  host.ctx.strokeRect(x + 0.5, y + 0.5, w + padX * 2 - 1, h - 1);
  host.ctx.fillStyle = '#eaf6ff';
  host.ctx.fillText(label, sx - w / 2, y + 13);
  host.ctx.restore();
}

function drawMeasureOverlay() {
  if (!host.measurePoints.value.length && !(host.mode.value === 'measure' && host.measureHoverPoint.value)) return;
  const renderPoints = (host.measurePoints.value || []).map((pt) => ({ x: Number(pt.x), y: Number(pt.y) }));
  if (host.mode.value === 'measure' && host.measureHoverPoint.value && renderPoints.length > 0) {
    renderPoints.push({
      x: Number(host.measureHoverPoint.value.x),
      y: Number(host.measureHoverPoint.value.y)
    });
  }
  if (renderPoints.length >= 2) {
    drawPolyline(renderPoints, '#ffe28a', 2.2, false, false);
  }

  for (let i = 0; i < host.measurePoints.value.length; i += 1) {
    const pt = host.measurePoints.value[i];
    const p = worldToScreen(pt.x, pt.y);
    host.ctx.beginPath();
    host.ctx.arc(p.x, p.y, 4.6, 0, Math.PI * 2);
    host.ctx.fillStyle = '#fff3b8';
    host.ctx.fill();
    host.ctx.strokeStyle = '#1b2430';
    host.ctx.lineWidth = 1.2;
    host.ctx.stroke();
  }

  const fullStats = buildMeasureStats(true);
  if (renderPoints.length >= 2) {
    for (let i = 1; i < renderPoints.length; i += 1) {
      const a = renderPoints[i - 1];
      const b = renderPoints[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const mid = worldToScreen((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
      drawMeasureLabel(`${segLen.toFixed(3)} m`, mid.x, mid.y);
    }
    const last = renderPoints[renderPoints.length - 1];
    const lastS = worldToScreen(last.x, last.y);
    drawMeasureLabel(`总长 ${fullStats.total.toFixed(3)} m`, lastS.x + 6, lastS.y - 8);
  }
}

function evaluateLinear(records, sValue, fallback = 0) {
  if (!records || !records.length) return fallback;
  let active = records[0];
  for (let i = 1; i < records.length; i += 1) {
    if (sValue >= records[i].sOffset) active = records[i];
    else break;
  }
  return active.a + active.b * sValue + active.c * sValue * sValue + active.d * sValue * sValue * sValue;
}

function getLaneSectionAtS(road, sValue) {
  const sections = Array.isArray(road?.laneSections) ? road.laneSections : [];
  if (!sections.length) return null;
  let active = sections[0];
  for (let i = 1; i < sections.length; i += 1) {
    if (sValue >= Number(sections[i]?.s || 0)) active = sections[i];
    else break;
  }
  return active;
}

function laneWidthAt(lane, sValue, fallbackWidth) {
  const width = evaluateLinear(lane?.widthProfile, sValue, fallbackWidth || 0);
  return Math.max(0, Number.isFinite(width) ? width : fallbackWidth || 0);
}

function getRoadProfileAtS(road, sValue) {
  const laneOffset = evaluateLinear(road.laneOffsetRecords || [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }], sValue, 0);
  const fallbackLeftWidth = Number(road.leftLaneWidth || road.laneWidth || 3.5);
  const fallbackRightWidth = Number(road.rightLaneWidth || road.laneWidth || 3.5);
  const section = getLaneSectionAtS(road, sValue);
  if (section) {
    const leftOffsets = [laneOffset];
    const rightOffsets = [laneOffset];
    let leftBoundary = laneOffset;
    let rightBoundary = laneOffset;
    const leftLanes = Array.isArray(section.leftLanes) ? section.leftLanes : [];
    const rightLanes = Array.isArray(section.rightLanes) ? section.rightLanes : [];
    leftLanes.forEach((lane) => {
      leftBoundary += laneWidthAt(lane, sValue, fallbackLeftWidth);
      leftOffsets.push(leftBoundary);
    });
    rightLanes.forEach((lane) => {
      rightBoundary -= laneWidthAt(lane, sValue, fallbackRightWidth);
      rightOffsets.push(rightBoundary);
    });
    return { laneOffset, leftOffsets, rightOffsets, leftBoundary, rightBoundary, section };
  }
  const leftCount = Number(road.leftLaneCount || 0);
  const rightCount = Number(road.rightLaneCount || 0);
  const leftOffsets = [laneOffset];
  const rightOffsets = [laneOffset];
  let leftBoundary = laneOffset;
  let rightBoundary = laneOffset;
  for (let i = 0; i < leftCount; i += 1) {
    leftBoundary += fallbackLeftWidth;
    leftOffsets.push(leftBoundary);
  }
  for (let i = 0; i < rightCount; i += 1) {
    rightBoundary -= fallbackRightWidth;
    rightOffsets.push(rightBoundary);
  }
  return { laneOffset, leftOffsets, rightOffsets, leftBoundary, rightBoundary, section: null };
}

function getLaneIdAtST(road, sValue, tValue) {
  const profile = getRoadProfileAtS(road, sValue);
  const section = profile.section;
  const t = Number(tValue);
  if (!Number.isFinite(t)) return '';
  const leftLanes = Array.isArray(section?.leftLanes) ? section.leftLanes : [];
  for (let i = 0; i < leftLanes.length; i += 1) {
    if (t >= profile.leftOffsets[i] - 1e-6 && t <= profile.leftOffsets[i + 1] + 1e-6) {
      return String(leftLanes[i]?.id ?? i + 1);
    }
  }
  const rightLanes = Array.isArray(section?.rightLanes) ? section.rightLanes : [];
  for (let i = 0; i < rightLanes.length; i += 1) {
    if (t <= profile.rightOffsets[i] + 1e-6 && t >= profile.rightOffsets[i + 1] - 1e-6) {
      return String(rightLanes[i]?.id ?? -(i + 1));
    }
  }
  const fallbackRightCount = Number(road.rightLaneCount || 0);
  if (fallbackRightCount && t <= profile.laneOffset + 1e-6 && t >= profile.rightBoundary - 1e-6) {
    return String(-Math.min(fallbackRightCount, Math.max(1, Math.ceil((profile.laneOffset - t) / Math.max(0.1, Number(road.rightLaneWidth || road.laneWidth || 3.5))))));
  }
  const fallbackLeftCount = Number(road.leftLaneCount || 0);
  if (fallbackLeftCount && t >= profile.laneOffset - 1e-6 && t <= profile.leftBoundary + 1e-6) {
    return String(Math.min(fallbackLeftCount, Math.max(1, Math.ceil((t - profile.laneOffset) / Math.max(0.1, Number(road.leftLaneWidth || road.laneWidth || 3.5))))));
  }
  return '';
}

function buildOffsetPath(road, selector) {
  if (!road.points || road.points.length < 2) return [];
  const out = [];
  for (let i = 0; i < road.points.length; i += 1) {
    const sample = road.points[i];
    const prev = road.points[Math.max(0, i - 1)];
    const next = road.points[Math.min(road.points.length - 1, i + 1)];
    const hdg = Number.isFinite(sample.hdg) ? sample.hdg : Math.atan2(next.y - prev.y, next.x - prev.x);
    const nx = -Math.sin(hdg);
    const ny = Math.cos(hdg);
    const profile = getRoadProfileAtS(road, Number(sample.s || 0));
    const offset = selector(profile);
    out.push({ x: sample.x + nx * offset, y: sample.y + ny * offset });
  }
  return out;
}

function buildLaneBoundaryPaths(road) {
  const leftCount = Math.max(0, Number(road.leftLaneCount || 0));
  const rightCount = Math.max(0, Number(road.rightLaneCount || 0));
  const paths = [];
  for (let i = 1; i < leftCount; i += 1) {
    paths.push({ laneId: String(i), points: buildOffsetPath(road, (profile) => profile.leftOffsets[i]) });
  }
  for (let i = 1; i < rightCount; i += 1) {
    paths.push({ laneId: String(-i), points: buildOffsetPath(road, (profile) => profile.rightOffsets[i]) });
  }
  return paths;
}

function getPrimaryLaneSection(road) {
  const sections = Array.isArray(road?.laneSections) ? road.laneSections : [];
  return sections.length ? sections[0] : null;
}

function resolveLaneForward(lane, side) {
  const travelDir = String(lane?.travelDir || '').trim().toLowerCase();
  if (travelDir === 'forward' || travelDir === 'forwards') return true;
  if (travelDir === 'backward' || travelDir === 'backwards' || travelDir === 'reverse') return false;
  return side === 'right';
}

function buildLaneArrowSeriesForRoad(road) {
  const section = getPrimaryLaneSection(road);
  const series = [];
  if (section) {
    const leftLanes = Array.isArray(section.leftLanes) ? section.leftLanes : [];
    leftLanes.forEach((lane, index) => {
      const laneIndex = index + 1;
      const path = buildOffsetPath(road, (profile) => (
        (Number(profile.leftOffsets[laneIndex - 1] ?? profile.laneOffset)
          + Number(profile.leftOffsets[laneIndex] ?? profile.leftBoundary)) * 0.5
      ));
      series.push({
        laneId: String(lane?.id ?? laneIndex),
        side: 'left',
        arrows: buildArrowSeries(path, resolveLaneForward(lane, 'left'))
      });
    });
    const rightLanes = Array.isArray(section.rightLanes) ? section.rightLanes : [];
    rightLanes.forEach((lane, index) => {
      const laneIndex = index + 1;
      const path = buildOffsetPath(road, (profile) => (
        (Number(profile.rightOffsets[laneIndex - 1] ?? profile.laneOffset)
          + Number(profile.rightOffsets[laneIndex] ?? profile.rightBoundary)) * 0.5
      ));
      series.push({
        laneId: String(lane?.id ?? -laneIndex),
        side: 'right',
        arrows: buildArrowSeries(path, resolveLaneForward(lane, 'right'))
      });
    });
    return series;
  }

  const leftCount = Math.max(0, Number(road.leftLaneCount || 0));
  const rightCount = Math.max(0, Number(road.rightLaneCount || 0));
  for (let i = 1; i <= leftCount; i += 1) {
    const path = buildOffsetPath(road, (profile) => (
      (Number(profile.leftOffsets[i - 1] ?? profile.laneOffset)
        + Number(profile.leftOffsets[i] ?? profile.leftBoundary)) * 0.5
    ));
    series.push({ laneId: String(i), side: 'left', arrows: buildArrowSeries(path, false) });
  }
  for (let i = 1; i <= rightCount; i += 1) {
    const path = buildOffsetPath(road, (profile) => (
      (Number(profile.rightOffsets[i - 1] ?? profile.laneOffset)
        + Number(profile.rightOffsets[i] ?? profile.rightBoundary)) * 0.5
    ));
    series.push({ laneId: String(-i), side: 'right', arrows: buildArrowSeries(path, true) });
  }
  return series;
}

function drawFilledBand(leftPath, rightPath, fillStyle) {
  if (!leftPath.length || !rightPath.length) return;
  host.ctx.beginPath();
  const p0 = worldToScreen(leftPath[0].x, leftPath[0].y);
  host.ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < leftPath.length; i += 1) {
    const p = worldToScreen(leftPath[i].x, leftPath[i].y);
    host.ctx.lineTo(p.x, p.y);
  }
  for (let i = rightPath.length - 1; i >= 0; i -= 1) {
    const p = worldToScreen(rightPath[i].x, rightPath[i].y);
    host.ctx.lineTo(p.x, p.y);
  }
  host.ctx.closePath();
  host.ctx.fillStyle = fillStyle;
  host.ctx.fill();
}

function drawNativeLaneMeshes(laneMeshes, fillStyle) {
  (Array.isArray(laneMeshes) ? laneMeshes : []).forEach((mesh) => {
    const outer = Array.isArray(mesh?.outer) ? mesh.outer : [];
    const inner = Array.isArray(mesh?.inner) ? mesh.inner : [];
    if (outer.length > 1 && inner.length > 1) {
      drawFilledBand(outer, inner, fillStyle);
    }
  });
}

host.DEFAULT_ROAD_RENDER_STYLE = {
  baseFill: 'rgba(58, 146, 255, 0.2)',
  baseEdge: 'rgba(182, 226, 255, 0.9)',
  baseLane: 'rgba(219, 241, 255, 0.82)',
  baseCenter: 'rgba(120, 208, 255, 0.95)',
  selectedFill: 'rgba(0, 214, 255, 0.55)',
  selectedEdge: 'rgba(244, 253, 255, 1)',
  selectedLane: 'rgba(222, 247, 255, 0.96)',
  selectedCenter: 'rgba(255, 244, 138, 1)',
  hoveredFill: 'rgba(214, 161, 102, 0.38)',
  hoveredEdge: 'rgba(241, 209, 170, 0.98)',
  hoveredLane: 'rgba(230, 198, 160, 0.9)',
  hoveredCenter: 'rgba(255, 232, 196, 1)'
};

function readRoadRenderCache(road) {
  return road?.[host.ROAD_RENDER_CACHE] || null;
}

function writeRoadRenderCache(road, cache) {
  Object.defineProperty(road, host.ROAD_RENDER_CACHE, {
    value: cache,
    writable: true,
    configurable: true
  });
}

function readRoadBoundsCache(road) {
  return road?.[host.ROAD_BOUNDS_CACHE] || null;
}

function writeRoadBoundsCache(road, cache) {
  Object.defineProperty(road, host.ROAD_BOUNDS_CACHE, {
    value: cache,
    writable: true,
    configurable: true
  });
}

function getRoadBounds(road) {
  if (!road) return null;
  const cache = readRoadBoundsCache(road);
  const pointsRef = road.points;
  const nativeLeftBoundaryRef = road.nativeLeftBoundary;
  const nativeRightBoundaryRef = road.nativeRightBoundary;
  const unchanged = cache
    && cache.pointsRef === pointsRef
    && cache.nativeLeftBoundaryRef === nativeLeftBoundaryRef
    && cache.nativeRightBoundaryRef === nativeRightBoundaryRef;
  if (unchanged) return cache.bounds;

  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  appendPointsBounds(bounds, pointsRef || []);
  appendPointsBounds(bounds, nativeLeftBoundaryRef || []);
  appendPointsBounds(bounds, nativeRightBoundaryRef || []);
  const finalized = finalizeBounds(bounds, pointsRef || []);
  writeRoadBoundsCache(road, {
    pointsRef,
    nativeLeftBoundaryRef,
    nativeRightBoundaryRef,
    bounds: finalized
  });
  return finalized;
}

function appendPointsBounds(bounds, points) {
  (points || []).forEach((pt) => {
    const x = Number(pt?.x);
    const y = Number(pt?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  });
}

function finalizeBounds(bounds, fallbackPoints = []) {
  if (Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY)
    && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY)) {
    return bounds;
  }
  const next = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  appendPointsBounds(next, fallbackPoints);
  if (!Number.isFinite(next.minX) || !Number.isFinite(next.minY)
    || !Number.isFinite(next.maxX) || !Number.isFinite(next.maxY)) {
    return null;
  }
  return next;
}

function buildArrowSeries(path, forward) {
  if (!path || path.length < 2) return [];
  let total = 0;
  const segments = [];
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    segments.push({ a, dx, dy, len, start: total, end: total + len });
    total += len;
  }
  if (!segments.length || total < 1e-6) return [];
  const count = Math.max(1, Math.min(24, Math.floor(total / 55)));
  const out = [];
  let segIdx = 0;
  for (let k = 1; k <= count; k += 1) {
    const d = (k * total) / (count + 1);
    while (segIdx < segments.length - 1 && d > segments[segIdx].end) segIdx += 1;
    const seg = segments[segIdx];
    const t = Math.max(0, Math.min(1, (d - seg.start) / seg.len));
    out.push({
      x: seg.a.x + seg.dx * t,
      y: seg.a.y + seg.dy * t,
      dirX: forward ? seg.dx : -seg.dx,
      dirY: forward ? seg.dy : -seg.dy
    });
  }
  return out;
}

function getPolylineMidpoint(points) {
  if (!Array.isArray(points) || !points.length) return null;
  if (points.length === 1) return points[0];
  let total = 0;
  const segments = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    segments.push({ a, dx, dy, len, start: total, end: total + len });
    total += len;
  }
  if (!segments.length) return points[Math.floor(points.length / 2)];
  const target = total * 0.5;
  let seg = segments[0];
  for (let i = 0; i < segments.length; i += 1) {
    if (target <= segments[i].end || i === segments.length - 1) {
      seg = segments[i];
      break;
    }
  }
  const t = Math.max(0, Math.min(1, (target - seg.start) / seg.len));
  return { x: seg.a.x + seg.dx * t, y: seg.a.y + seg.dy * t };
}

function getRoadRenderData(road) {
  if (!road) return null;
  const cache = readRoadRenderCache(road);
  const leftLaneCount = Number(road.leftLaneCount || 0);
  const rightLaneCount = Number(road.rightLaneCount || 0);
  const leftLaneWidth = Number(road.leftLaneWidth || road.laneWidth || 3.5);
  const rightLaneWidth = Number(road.rightLaneWidth || road.laneWidth || 3.5);
  const laneWidth = Number(road.laneWidth || 3.5);
  const pointsRef = road.points;
  const nativeLeftBoundaryRef = road.nativeLeftBoundary;
  const nativeRightBoundaryRef = road.nativeRightBoundary;
  const nativeLaneBoundariesRef = road.nativeLaneBoundaries;
  const nativeLaneMeshesRef = road.nativeLaneMeshes;
  const laneOffsetRecordsRef = road.laneOffsetRecords;
  const laneSectionsRef = road.laneSections;
  const unchanged = cache
    && cache.pointsRef === pointsRef
    && cache.nativeLeftBoundaryRef === nativeLeftBoundaryRef
    && cache.nativeRightBoundaryRef === nativeRightBoundaryRef
    && cache.nativeLaneBoundariesRef === nativeLaneBoundariesRef
    && cache.nativeLaneMeshesRef === nativeLaneMeshesRef
    && cache.laneOffsetRecordsRef === laneOffsetRecordsRef
    && cache.laneSectionsRef === laneSectionsRef
    && cache.leftLaneCount === leftLaneCount
    && cache.rightLaneCount === rightLaneCount
    && cache.leftLaneWidth === leftLaneWidth
    && cache.rightLaneWidth === rightLaneWidth
    && cache.laneWidth === laneWidth;
  if (unchanged) return cache.data;

  const hasNativeBoundaries = Array.isArray(road.nativeLeftBoundary) && road.nativeLeftBoundary.length > 1
    && Array.isArray(road.nativeRightBoundary) && road.nativeRightBoundary.length > 1;
  const hasNativeLaneMeshes = Array.isArray(road.nativeLaneMeshes)
    && road.nativeLaneMeshes.some((mesh) => Array.isArray(mesh?.outer) && mesh.outer.length > 1 && Array.isArray(mesh?.inner) && mesh.inner.length > 1);
  const data = {
    hasNativeBoundaries,
    hasNativeLaneMeshes,
    nativeLaneMeshes: hasNativeLaneMeshes ? road.nativeLaneMeshes : [],
    centerRef: hasNativeBoundaries ? road.points || [] : buildOffsetPath(road, (profile) => profile.laneOffset),
    leftBoundary: hasNativeBoundaries ? road.nativeLeftBoundary : buildOffsetPath(road, (profile) => profile.leftBoundary),
    rightBoundary: hasNativeBoundaries ? road.nativeRightBoundary : buildOffsetPath(road, (profile) => profile.rightBoundary),
    laneBoundaries: hasNativeBoundaries ? (road.nativeLaneBoundaries || []) : buildLaneBoundaryPaths(road),
    laneArrowSeries: buildLaneArrowSeriesForRoad(road),
    leftArrowPath: leftLaneCount > 0 ? buildOffsetPath(road, (p) => (p.laneOffset + p.leftBoundary) * 0.5) : [],
    rightArrowPath: rightLaneCount > 0 ? buildOffsetPath(road, (p) => (p.laneOffset + p.rightBoundary) * 0.5) : []
  };
  data.leftArrowSeries = buildArrowSeries(data.leftArrowPath, false);
  data.rightArrowSeries = buildArrowSeries(data.rightArrowPath, true);
  data.labelPoint = getPolylineMidpoint(data.centerRef) || getPolylineMidpoint(road.points || []);
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  appendPointsBounds(bounds, data.leftBoundary);
  appendPointsBounds(bounds, data.rightBoundary);
  appendPointsBounds(bounds, data.centerRef);
  data.bounds = finalizeBounds(bounds, road.points || []);

  writeRoadRenderCache(road, {
    pointsRef,
    nativeLeftBoundaryRef,
    nativeRightBoundaryRef,
    nativeLaneBoundariesRef,
    nativeLaneMeshesRef,
    laneOffsetRecordsRef,
    laneSectionsRef,
    leftLaneCount,
    rightLaneCount,
    leftLaneWidth,
    rightLaneWidth,
    laneWidth,
    data
  });
  return data;
}

function getActiveCanvas() {
  return host.activeRenderCanvas || host.canvasEl.value;
}

function getViewportBounds(marginPx = 80) {
  const canvas = getActiveCanvas();
  if (!canvas) return null;
  const worldMin = screenToWorld(-marginPx, -marginPx);
  const worldMax = screenToWorld(canvas.width + marginPx, canvas.height + marginPx);
  return {
    minX: Math.min(worldMin.x, worldMax.x),
    minY: Math.min(worldMin.y, worldMax.y),
    maxX: Math.max(worldMin.x, worldMax.x),
    maxY: Math.max(worldMin.y, worldMax.y)
  };
}

function boundsIntersect(a, b) {
  if (!a || !b) return true;
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function yieldToMain() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else window.setTimeout(resolve, 0);
  });
}

function copyPointsLight(points) {
  if (!Array.isArray(points) || !points.length) return [];
  return points.map((p) => ({
    x: Number(p.x),
    y: Number(p.y),
    s: Number(p.s),
    hdg: Number(p.hdg)
  }));
}

function copyBoundaryLight(points) {
  if (!Array.isArray(points) || !points.length) return [];
  return points.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
}

function roadNearWorldPoint(road, worldPoint, marginM = 0) {
  const bounds = getRoadBounds(road);
  if (!bounds) return true;
  return !(worldPoint.x < bounds.minX - marginM
    || worldPoint.x > bounds.maxX + marginM
    || worldPoint.y < bounds.minY - marginM
    || worldPoint.y > bounds.maxY + marginM);
}

function forEachRoadPointSample(roadList, onPoint) {
  const total = roadList.length;
  if (!total) return;
  const roadStep = total > host.FIT_VIEW_MAX_ROAD_SAMPLES
    ? Math.ceil(total / host.FIT_VIEW_MAX_ROAD_SAMPLES)
    : 1;
  for (let ri = 0; ri < total; ri += roadStep) {
    const road = roadList[ri];
    if (road?.visible === false) continue;
    const pts = road.points || [];
    if (!pts.length) continue;
    const pointStep = pts.length > host.FIT_VIEW_MAX_POINTS_PER_ROAD
      ? Math.ceil(pts.length / host.FIT_VIEW_MAX_POINTS_PER_ROAD)
      : 1;
    for (let pi = 0; pi < pts.length; pi += pointStep) {
      onPoint(pts[pi]);
    }
  }
}

function shouldDrawRoadLabels(visibleRoadCount) {
  return host.view.scale >= 0.65 && visibleRoadCount <= 220;
}

function shouldDrawLaneArrows(visibleRoadCount, visiblePointCount) {
  return host.view.scale >= 1.2 && visibleRoadCount <= 320 && visiblePointCount <= 18000;
}

function shouldUseOverviewRoadRendering(visibleRoadCount, visiblePointCount) {
  return host.view.scale < 0.42 || visibleRoadCount > 900 || visiblePointCount > 50000;
}

function drawRoadSurface(road, selected, renderData = null, options = {}) {
  if (!road.points || road.points.length < 2) return;
  const hovered = Boolean(options.hovered);
  const emphasized = selected || hovered;
  const edgeWidth = selected ? 2.2 : (hovered ? 2 : 1.6);
  const laneWidth = selected ? 1.4 : (hovered ? 1.2 : 1);
  const centerWidth = selected ? 2.8 : (hovered ? 2.2 : 1.6);
  const overviewWidth = selected ? 2.2 : (hovered ? 1.8 : 1.2);
  if (options.overview) {
    const overviewColor = options.palette?.center || (emphasized ? 'rgba(255, 244, 138, 0.98)' : 'rgba(120, 208, 255, 0.88)');
    const centerRef = options.allowFallbackCenterline
      ? (road.points || [])
      : (renderData?.centerRef || getRoadRenderData(road)?.centerRef || []);
    if (!centerRef.length) return;
    drawPolyline(
      centerRef,
      overviewColor,
      overviewWidth
    );
    return;
  }
  const resolvedRenderData = renderData || getRoadRenderData(road);
  if (!resolvedRenderData) return;
  const palette = options.palette || (selected
    ? {
        fill: host.DEFAULT_ROAD_RENDER_STYLE.selectedFill,
        edge: host.DEFAULT_ROAD_RENDER_STYLE.selectedEdge,
        lane: host.DEFAULT_ROAD_RENDER_STYLE.selectedLane,
        center: host.DEFAULT_ROAD_RENDER_STYLE.selectedCenter
      }
    : hovered
      ? {
          fill: host.DEFAULT_ROAD_RENDER_STYLE.hoveredFill,
          edge: host.DEFAULT_ROAD_RENDER_STYLE.hoveredEdge,
          lane: host.DEFAULT_ROAD_RENDER_STYLE.hoveredLane,
          center: host.DEFAULT_ROAD_RENDER_STYLE.hoveredCenter
        }
      : {
        fill: host.DEFAULT_ROAD_RENDER_STYLE.baseFill,
        edge: host.DEFAULT_ROAD_RENDER_STYLE.baseEdge,
        lane: host.DEFAULT_ROAD_RENDER_STYLE.baseLane,
        center: host.DEFAULT_ROAD_RENDER_STYLE.baseCenter
      });
  if (resolvedRenderData.hasNativeLaneMeshes) {
    drawNativeLaneMeshes(resolvedRenderData.nativeLaneMeshes, palette.fill);
  } else if (resolvedRenderData.hasNativeBoundaries) {
    drawFilledBand(resolvedRenderData.leftBoundary, resolvedRenderData.rightBoundary, palette.fill);
  } else {
    drawFilledBand(resolvedRenderData.leftBoundary, resolvedRenderData.rightBoundary, palette.fill);
  }

  if (resolvedRenderData.hasNativeBoundaries) {
    drawPolyline(resolvedRenderData.leftBoundary, palette.edge, edgeWidth);
    drawPolyline(resolvedRenderData.rightBoundary, palette.edge, edgeWidth);
    if (options.showLaneMarkings || emphasized) {
      resolvedRenderData.laneBoundaries.forEach((lane) => {
        if (lane?.points?.length > 1) drawPolyline(lane.points, palette.lane, laneWidth, true);
      });
    }
    if (!options.suppressCenterline || emphasized) {
      drawPolyline(resolvedRenderData.centerRef, palette.center, selected ? 2.4 : (hovered ? 2 : 1.2), true);
    }
    return;
  }
  drawPolyline(resolvedRenderData.leftBoundary, palette.edge, edgeWidth);
  drawPolyline(resolvedRenderData.rightBoundary, palette.edge, edgeWidth);
  if (options.showLaneMarkings || emphasized) {
    resolvedRenderData.laneBoundaries.forEach((lane) => {
      if (lane?.points?.length > 1) drawPolyline(lane.points, palette.lane, laneWidth, true);
    });
  }
  if (!options.suppressCenterline || emphasized) {
    drawPolyline(resolvedRenderData.centerRef, palette.center, centerWidth, true);
  }
}

function drawMeterGrid() {
  const canvas = getActiveCanvas();
  if (!host.ctx || !canvas) return;
  const roadCount = host.roads.value.length;
  if (roadCount > 2600 && host.view.scale < 1.6) {
    host.ctx.fillStyle = '#000000';
    host.ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const baseStepPx = host.GRID_BASE_M * host.view.scale;
  const skip = Math.max(1, Math.ceil(host.GRID_TARGET_PX / Math.max(0.0001, baseStepPx)));
  const stepM = host.GRID_BASE_M * skip;
  const majorEvery = roadCount > 1600 ? 20 : 10;
  const maxGridLines = roadCount > 1600 ? 900 : 3000;
  const worldMin = screenToWorld(0, 0);
  const worldMax = screenToWorld(canvas.width, canvas.height);
  const minX = Math.min(worldMin.x, worldMax.x);
  const maxX = Math.max(worldMin.x, worldMax.x);
  const minY = Math.min(worldMin.y, worldMax.y);
  const maxY = Math.max(worldMin.y, worldMax.y);

  host.ctx.fillStyle = '#000000';
  host.ctx.fillRect(0, 0, canvas.width, canvas.height);

  const startX = Math.floor(minX / stepM) * stepM;
  const endX = Math.ceil(maxX / stepM) * stepM;
  const startY = Math.floor(minY / stepM) * stepM;
  const endY = Math.ceil(maxY / stepM) * stepM;

  const drawLine = (isMajor) => {
    host.ctx.strokeStyle = isMajor ? 'rgba(130, 170, 206, 0.26)' : 'rgba(79, 103, 126, 0.2)';
    host.ctx.lineWidth = 1;
  };

  let xCount = 0;
  for (let x = startX; x <= endX; x += stepM) {
    xCount += 1;
    if (xCount > maxGridLines) break;
    const sx = x * host.view.scale + host.view.offsetX;
    const idx = Math.round(x / stepM);
    const isMajor = idx % majorEvery === 0;
    drawLine(isMajor);
    host.ctx.beginPath();
    host.ctx.moveTo(Math.round(sx) + 0.5, 0);
    host.ctx.lineTo(Math.round(sx) + 0.5, canvas.height);
    host.ctx.stroke();
  }

  let yCount = 0;
  for (let y = startY; y <= endY; y += stepM) {
    yCount += 1;
    if (yCount > maxGridLines) break;
    const sy = -y * host.view.scale + host.view.offsetY;
    const idx = Math.round(y / stepM);
    const isMajor = idx % majorEvery === 0;
    drawLine(isMajor);
    host.ctx.beginPath();
    host.ctx.moveTo(0, Math.round(sy) + 0.5);
    host.ctx.lineTo(canvas.width, Math.round(sy) + 0.5);
    host.ctx.stroke();
  }
}

function drawOriginAxes() {
  const canvas = getActiveCanvas();
  if (!host.ctx || !canvas) return;
  const origin = worldToScreen(0, 0);

  // Y axis (x = 0)
  if (origin.x >= -2 && origin.x <= canvas.width + 2) {
    host.ctx.strokeStyle = 'rgba(255, 132, 132, 0.9)';
    host.ctx.lineWidth = 1.6;
    host.ctx.beginPath();
    host.ctx.moveTo(Math.round(origin.x) + 0.5, 0);
    host.ctx.lineTo(Math.round(origin.x) + 0.5, canvas.height);
    host.ctx.stroke();
  }

  // X axis (y = 0)
  if (origin.y >= -2 && origin.y <= canvas.height + 2) {
    host.ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)';
    host.ctx.lineWidth = 1.6;
    host.ctx.beginPath();
    host.ctx.moveTo(0, Math.round(origin.y) + 0.5);
    host.ctx.lineTo(canvas.width, Math.round(origin.y) + 0.5);
    host.ctx.stroke();
  }

  // Origin marker
  if (origin.x >= -12 && origin.x <= canvas.width + 12 && origin.y >= -12 && origin.y <= canvas.height + 12) {
    host.ctx.beginPath();
    host.ctx.arc(origin.x, origin.y, 3.6, 0, Math.PI * 2);
    host.ctx.fillStyle = '#f7fbff';
    host.ctx.fill();
    host.ctx.strokeStyle = '#0f141a';
    host.ctx.lineWidth = 1;
    host.ctx.stroke();
  }
}

function drawArrowAtWorld(x, y, dirX, dirY, color) {
  const screenDirX = Number(dirX);
  const screenDirY = -Number(dirY);
  const dirLen = Math.hypot(screenDirX, screenDirY);
  if (dirLen < 1e-6) return;
  const ux = screenDirX / dirLen;
  const uy = screenDirY / dirLen;
  const nX = -uy;
  const nY = ux;
  const p = worldToScreen(x, y);
  const size = 7;
  const tail = { x: p.x - ux * size, y: p.y - uy * size };
  const left = { x: tail.x + nX * 3.2, y: tail.y + nY * 3.2 };
  const right = { x: tail.x - nX * 3.2, y: tail.y - nY * 3.2 };
  host.ctx.beginPath();
  host.ctx.moveTo(p.x, p.y);
  host.ctx.lineTo(left.x, left.y);
  host.ctx.lineTo(right.x, right.y);
  host.ctx.closePath();
  host.ctx.fillStyle = color;
  host.ctx.fill();
}

function drawLaneDirectionArrows(road, renderData = null) {
  if (!road.points || road.points.length < 2) return;
  const resolvedRenderData = renderData || getRoadRenderData(road);
  if (!resolvedRenderData) return;
  if (Array.isArray(resolvedRenderData.laneArrowSeries) && resolvedRenderData.laneArrowSeries.length) {
    resolvedRenderData.laneArrowSeries.forEach((laneSeries) => {
      const color = laneSeries.side === 'right' ? 'rgba(124, 240, 213, 0.92)' : 'rgba(255, 194, 124, 0.92)';
      (laneSeries.arrows || []).forEach((arrow) => {
        drawArrowAtWorld(arrow.x, arrow.y, arrow.dirX, arrow.dirY, color);
      });
    });
    return;
  }
  resolvedRenderData.rightArrowSeries.forEach((arrow) => {
    drawArrowAtWorld(arrow.x, arrow.y, arrow.dirX, arrow.dirY, 'rgba(124, 240, 213, 0.92)');
  });
  resolvedRenderData.leftArrowSeries.forEach((arrow) => {
    drawArrowAtWorld(arrow.x, arrow.y, arrow.dirX, arrow.dirY, 'rgba(255, 194, 124, 0.92)');
  });
}

function pickSelectedRoadEditPoint(screenX, screenY) {
  const roadIdx = host.selectedRoadIndex.value;
  if (roadIdx < 0) return null;
  const road = host.roads.value[roadIdx];
  if (!road) return null;
  let best = null;
  let bestDist = Infinity;
  host.getRoadEditPoints(road).forEach((handle, pointIdx) => {
    const p = worldToScreen(handle.x, handle.y);
    const d = Math.hypot(screenX - p.x, screenY - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = { roadIdx, pointIdx, x: handle.x, y: handle.y };
    }
  });
  return bestDist <= 10 ? best : null;
}

function drawSingleHandle(handle, radius, fill, stroke, strokeWidth = 1.4) {
  if (!handle) return;
  const p = worldToScreen(handle.x, handle.y);
  host.ctx.beginPath();
  host.ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  host.ctx.fillStyle = fill;
  host.ctx.fill();
  host.ctx.strokeStyle = stroke;
  host.ctx.lineWidth = strokeWidth;
  host.ctx.stroke();
}

function drawHandles() {
  if (host.mode.value === 'select') {
    const road = host.selectedRoad.value;
    const roadIdx = host.selectedRoadIndex.value;
    if (!road || roadIdx < 0) return;
    const anchors = host.getRoadEditPoints(road);
    anchors.forEach((handle, pointIdx) => {
      const active = host.endpointDrag.value
        && host.endpointDrag.value.roadIdx === roadIdx
        && host.endpointDrag.value.pointIdx === pointIdx;
      drawSingleHandle(
        handle,
        active ? 6.6 : 5.2,
        '#88d7ff',
        active ? '#f8fcff' : '#0f141a',
        active ? 2 : 1.2
      );
    });
    if (anchors.length >= 2 && typeof host.ensureRoadSegmentControls === 'function') {
      const controls = host.ensureRoadSegmentControls(road);
      const activeSegmentIndex = host.drawControlDrag.value?.roadIdx === roadIdx
        ? host.drawControlDrag.value.segmentIndex
        : -1;
      drawSegmentPenHandles(anchors, controls, activeSegmentIndex ?? -1, false);
    }
    return;
  }
  if (host.mode.value !== 'extend' && host.mode.value !== 'connect' && host.mode.value !== 'junction') return;
  host.getAllHandles().forEach((h) => {
    const p = worldToScreen(h.x, h.y);
    const chosenInConnect = host.mode.value === 'connect'
      && ((host.connectDraft.value.first
        && host.connectDraft.value.first.roadIdx === h.roadIdx
        && host.connectDraft.value.first.endpoint === h.endpoint)
      || (host.connectDraft.value.second
        && host.connectDraft.value.second.roadIdx === h.roadIdx
        && host.connectDraft.value.second.endpoint === h.endpoint));
    const chosenInJunction = host.mode.value === 'junction'
      && (host.junctionDraft.value.handles || []).some((it) => it.roadIdx === h.roadIdx && it.endpoint === h.endpoint);
    host.ctx.beginPath();
    host.ctx.arc(p.x, p.y, (chosenInConnect || chosenInJunction) ? 6.5 : 5, 0, Math.PI * 2);
    host.ctx.fillStyle = h.endpoint === 'start' ? '#6ad0ff' : '#ffd16a';
    host.ctx.fill();
    host.ctx.strokeStyle = (chosenInConnect || chosenInJunction) ? '#f8fcff' : '#0f141a';
    host.ctx.lineWidth = (chosenInConnect || chosenInJunction) ? 2 : 1.2;
    host.ctx.stroke();
  });
}

function drawPenControlHandle(ctrl, active = false) {
  const p = worldToScreen(ctrl.x, ctrl.y);
  const size = active ? 6.5 : 5.5;
  host.ctx.save();
  host.ctx.translate(p.x, p.y);
  host.ctx.rotate(Math.PI / 4);
  host.ctx.fillStyle = active ? '#ffe8a8' : '#ffb347';
  host.ctx.strokeStyle = active ? '#fff8e8' : '#1a1208';
  host.ctx.lineWidth = active ? 2 : 1.3;
  host.ctx.fillRect(-size, -size, size * 2, size * 2);
  host.ctx.strokeRect(-size, -size, size * 2, size * 2);
  host.ctx.restore();
}

function drawSegmentPenHandles(anchors, controls, activeSegmentIndex = -1, drawAnchors = false) {
  if (!anchors || anchors.length < 2) return;
  const segmentControls = Array.isArray(controls) ? controls : [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const ctrl = segmentControls[i];
    if (!ctrl) continue;
    const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    const midS = worldToScreen(mid.x, mid.y);
    const ctrlS = worldToScreen(ctrl.x, ctrl.y);
    const active = activeSegmentIndex === i;
    host.ctx.save();
    host.ctx.setLineDash([5, 4]);
    host.ctx.strokeStyle = active ? 'rgba(255, 220, 140, 0.95)' : 'rgba(255, 179, 71, 0.75)';
    host.ctx.lineWidth = 1.2;
    host.ctx.beginPath();
    host.ctx.moveTo(midS.x, midS.y);
    host.ctx.lineTo(ctrlS.x, ctrlS.y);
    host.ctx.stroke();
    host.ctx.setLineDash([]);
    host.ctx.restore();
    drawPenControlHandle(ctrl, active);
  }
  if (!drawAnchors) return;
  anchors.forEach((anchor, idx) => {
    const p = worldToScreen(anchor.x, anchor.y);
    const isEnd = idx === anchors.length - 1;
    host.ctx.beginPath();
    host.ctx.arc(p.x, p.y, isEnd ? 5.2 : 4.6, 0, Math.PI * 2);
    host.ctx.fillStyle = isEnd ? '#9be7ff' : '#6ad0ff';
    host.ctx.fill();
    host.ctx.strokeStyle = '#0f141a';
    host.ctx.lineWidth = 1.2;
    host.ctx.stroke();
  });
}

function drawDrawPenHandles() {
  if (host.drawForm.drawKind === 'line') return;
  const activeSegmentIndex = host.drawControlDrag.value?.roadIdx == null
    ? host.drawControlDrag.value?.segmentIndex
    : -1;
  drawSegmentPenHandles(
    host.drawingPoints.value,
    host.drawSegmentControls.value,
    activeSegmentIndex ?? -1,
    true
  );
}

function drawDraftRoadPreview() {
  if (!host.drawingPoints.value.length) return;
  if (host.drawingPoints.value.length === 1) {
    const p = worldToScreen(host.drawingPoints.value[0].x, host.drawingPoints.value[0].y);
    host.ctx.beginPath();
    host.ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    host.ctx.fillStyle = '#88d7ff';
    host.ctx.fill();
    return;
  }
  const source = host.selectedRoad.value || {};
  const previewShape = typeof host.buildRoadShapeFromDrawDraft === 'function'
    ? host.buildRoadShapeFromDrawDraft()
    : null;
  const draftRoad = {
    points: previewShape?.points?.length ? previewShape.points : host.drawingPoints.value,
    geometry: previewShape?.geometry || [],
    leftLaneCount: Number(source.leftLaneCount || 1),
    rightLaneCount: Number(source.rightLaneCount || 1),
    laneWidth: Number(source.laneWidth || 3.5),
    leftLaneWidth: Number(source.leftLaneWidth || source.laneWidth || 3.5),
    rightLaneWidth: Number(source.rightLaneWidth || source.laneWidth || 3.5),
    laneOffsetRecords: [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }]
  };
  drawRoadSurface(draftRoad, true);
  drawLaneDirectionArrows(draftRoad);
  drawPolyline(host.drawingPoints.value, '#9be7ff', 1.2, true, true);
  drawDrawPenHandles();
}

function getSelectedJunctionMesh() {
  const selectedId = String(host.selectedJunctionId?.value ?? '').trim();
  if (!selectedId) return null;
  return (host.junctionMeshes.value || []).find((mesh) => String(mesh.id) === selectedId) || null;
}

function drawJunctionMeshes() {
  const selectedId = String(host.selectedJunctionId?.value ?? '').trim();
  (host.junctionMeshes.value || []).forEach((mesh) => {
    const isSelected = selectedId && String(mesh.id) === selectedId;
    const guideStyle = getJunctionGuideStyle(host.roadColorConfig, isSelected);
    if (Array.isArray(mesh.polygon) && mesh.polygon.length >= 3) {
      const p0 = worldToScreen(mesh.polygon[0].x, mesh.polygon[0].y);
      host.ctx.beginPath();
      host.ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < mesh.polygon.length; i += 1) {
        const p = worldToScreen(mesh.polygon[i].x, mesh.polygon[i].y);
        host.ctx.lineTo(p.x, p.y);
      }
      host.ctx.closePath();
      host.ctx.fillStyle = guideStyle.polygonFill;
      host.ctx.strokeStyle = guideStyle.polygonStroke;
      host.ctx.lineWidth = isSelected ? 2.6 : 1.2;
      host.ctx.fill();
      host.ctx.stroke();
    }
    (mesh.approaches || []).forEach((a) => {
      if (a?.anchor && a?.boundary) {
        drawPolyline([a.anchor, a.boundary], guideStyle.approachLine, 1.8, true);
      }
    });
    (mesh.internalLaneCurves || []).forEach((curve) => {
      if (curve?.length > 1) {
        drawPolyline(curve, guideStyle.innerLane, 1.1, true);
      }
    });
    if (mesh.center) {
      const c = worldToScreen(mesh.center.x, mesh.center.y);
      host.ctx.beginPath();
      host.ctx.arc(c.x, c.y, isSelected ? 5.2 : 3.4, 0, Math.PI * 2);
      host.ctx.fillStyle = guideStyle.centerDot;
      host.ctx.strokeStyle = isSelected ? '#fff8e8' : 'transparent';
      host.ctx.lineWidth = isSelected ? 1.6 : 0;
      host.ctx.fill();
      if (isSelected) host.ctx.stroke();
    }
  });
}

function performRender(options = {}) {
  const canvas = getActiveCanvas();
  if (!host.ctx || !canvas) return;
  host.ctx.clearRect(0, 0, canvas.width, canvas.height);
  const exportMode = Boolean(options.exportMode);
  if (exportMode) {
    host.ctx.fillStyle = '#000000';
    host.ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    drawMeterGrid();
  }
  if (host.bgImage.value) {
    const res = Math.max(1e-6, Number(host.bgGeo.resolution || 1));
    const yaw = Number(host.bgGeo.yaw || 0);
    const image = host.bgImage.value.image || host.bgImage.value;
    const width = Number(host.bgImage.value.width || host.bgGeo.imageWidth || image.width || 0);
    const height = Number(host.bgImage.value.height || host.bgGeo.imageHeight || image.height || 0);
    const renderWidth = Number(host.bgImage.value.renderWidth || image.width || width);
    const renderHeight = Number(host.bgImage.value.renderHeight || image.height || height);
    const topLeftWorld = vecAdd(
      { x: Number(host.bgGeo.originX || 0), y: Number(host.bgGeo.originY || 0) },
      rotateVec({ x: 0, y: height * res }, yaw)
    );
    const ex = rotateVec({ x: res, y: 0 }, yaw);
    const ey = rotateVec({ x: 0, y: -res }, yaw);
    const p = worldToScreen(topLeftWorld.x, topLeftWorld.y);
    host.ctx.save();
    host.ctx.transform(
      ex.x * host.view.scale,
      -ex.y * host.view.scale,
      ey.x * host.view.scale,
      -ey.y * host.view.scale,
      p.x,
      p.y
    );
    host.ctx.drawImage(image, 0, 0, renderWidth, renderHeight, 0, 0, width, height);
    host.ctx.restore();
  }
  if (!exportMode) drawOriginAxes();
  drawJunctionMeshes();
  const selectedJunctionMesh = getSelectedJunctionMesh();
  const junctionRoadIds = selectedJunctionMesh && typeof host.getJunctionRelatedRoadIds === 'function'
    ? host.getJunctionRelatedRoadIds(selectedJunctionMesh)
    : null;
  const viewportBounds = getViewportBounds(120);
  const visibleRoads = [];
  let visiblePointCount = 0;
  host.roads.value.forEach((r, idx) => {
    if (r?.visible === false) return;
    const bounds = getRoadBounds(r);
    if (bounds && viewportBounds && !boundsIntersect(bounds, viewportBounds)) return;
    visibleRoads.push({ road: r, idx });
    visiblePointCount += Array.isArray(r.points) ? r.points.length : 0;
  });
  const drawLabels = !exportMode && host.roadColorConfig.showRoadLabels && shouldDrawRoadLabels(visibleRoads.length);
  const drawArrows = shouldDrawLaneArrows(visibleRoads.length, visiblePointCount);
  const overviewMode = shouldUseOverviewRoadRendering(visibleRoads.length, visiblePointCount);
  const suppressCenterline = exportMode ? false : (!overviewMode && (host.view.scale < 1.1 || visibleRoads.length > 220));
  const showLaneMarkings = exportMode ? visibleRoads.length <= 600 : (!overviewMode && host.view.scale >= 1.25 && visibleRoads.length <= 160);
  const drawRoadEntry = (entry, pass) => {
    const { road: r, idx } = entry;
    const junctionRelated = junctionRoadIds && junctionRoadIds.has(String(r.id));
    const sel = idx === host.selectedRoadIndex.value || junctionRelated;
    const hov = idx === host.hoveredRoadIndex.value && !sel;
    if (pass === 'base' && (sel || hov)) return;
    if (pass === 'hover' && !hov) return;
    if (pass === 'selected' && !sel) return;
    const emphasized = sel || hov;
    const needDetail = !overviewMode || emphasized || drawArrows || drawLabels;
    const renderData = needDetail ? getRoadRenderData(r) : null;
    const palette = computeRoadPaletteForRoad(r, sel, hov, host.roadColorConfig, host.DEFAULT_ROAD_RENDER_STYLE);
    drawRoadSurface(r, sel, renderData, {
      overview: overviewMode && !emphasized,
      hovered: hov,
      allowFallbackCenterline: true,
      suppressCenterline,
      showLaneMarkings,
      palette
    });
    if (drawArrows && !overviewMode) {
      drawLaneDirectionArrows(r, renderData);
    }
    if (drawLabels && !overviewMode) {
      const labelPoint = renderData?.labelPoint || (Array.isArray(r.points) ? r.points[0] : null);
      if (!labelPoint) return;
      const p = worldToScreen(labelPoint.x, labelPoint.y);
      host.ctx.fillStyle = String(host.roadColorConfig.roadLabelColor || '#111111');
      host.ctx.font = '12px sans-serif';
      host.ctx.fillText(`R${r.id}`, p.x + 7, p.y - 6);
    }
  };
  ['base', 'hover', 'selected'].forEach((pass) => {
    visibleRoads.forEach((entry) => drawRoadEntry(entry, pass));
  });
  if (!exportMode) {
    drawDraftRoadPreview();
    if (host.extendDraft.value) {
      drawPolyline([host.extendDraft.value.anchor, host.extendDraft.value.hover], '#77f2c8', 2, true);
    }
    drawMeasureOverlay();
    drawHandles();
  }
}

function render(force = false) {
  if (force) {
    if (host.renderFrame) {
      cancelAnimationFrame(host.renderFrame);
      host.renderFrame = 0;
    }
    performRender();
    return;
  }
  if (host.renderFrame) return;
  host.renderFrame = requestAnimationFrame(() => {
    host.renderFrame = 0;
    performRender();
  });
}

function resizeCanvas(keepWorldCenter = true) {
  if (!host.canvasEl.value || !host.canvasWrap.value) return;
  const rect = host.canvasWrap.value.getBoundingClientRect();
  const newWidth = Math.max(300, Math.floor(rect.width));
  const newHeight = Math.max(260, Math.floor(rect.height));
  if (newWidth === host.canvasEl.value.width && newHeight === host.canvasEl.value.height) return;
  const prevCenterWorld = keepWorldCenter ? screenToWorld(host.canvasEl.value.width / 2, host.canvasEl.value.height / 2) : { x: 0, y: 0 };
  host.canvasEl.value.width = newWidth;
  host.canvasEl.value.height = newHeight;
  if (keepWorldCenter) {
    host.view.offsetX = host.canvasEl.value.width / 2 - prevCenterWorld.x * host.view.scale;
    host.view.offsetY = host.canvasEl.value.height / 2 + prevCenterWorld.y * host.view.scale;
  }
  render();
}

function fitView() {
  if (!host.canvasEl.value) return;
  if (host.bgImage.value) {
    const res = Math.max(1e-6, Number(host.bgGeo.resolution || 1));
    const yaw = Number(host.bgGeo.yaw || 0);
    const width = Number(host.bgImage.value.width || host.bgGeo.imageWidth || 0);
    const height = Number(host.bgImage.value.height || host.bgGeo.imageHeight || 0);
    const origin = { x: Number(host.bgGeo.originX || 0), y: Number(host.bgGeo.originY || 0) };
    const corners = [
      origin,
      vecAdd(origin, rotateVec({ x: width * res, y: 0 }, yaw)),
      vecAdd(origin, rotateVec({ x: width * res, y: height * res }, yaw)),
      vecAdd(origin, rotateVec({ x: 0, y: height * res }, yaw))
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    corners.forEach((p) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    });
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const margin = 40;
    const sx = (host.canvasEl.value.width - margin * 2) / w;
    const sy = (host.canvasEl.value.height - margin * 2) / h;
    host.view.scale = Math.max(0.00001, Math.min(sx, sy));
    host.view.offsetX = margin - minX * host.view.scale + (host.canvasEl.value.width - margin * 2 - w * host.view.scale) / 2;
    host.view.offsetY = margin + maxY * host.view.scale + (host.canvasEl.value.height - margin * 2 - h * host.view.scale) / 2;
  } else if (host.roads.value.length) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    forEachRoadPointSample(host.roads.value, (p) => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
    if (Number.isFinite(minX)) {
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const margin = 40;
      const sx = (host.canvasEl.value.width - margin * 2) / w;
      const sy = (host.canvasEl.value.height - margin * 2) / h;
      host.view.scale = Math.max(0.00001, Math.min(sx, sy));
      host.view.offsetX = margin - minX * host.view.scale + (host.canvasEl.value.width - margin * 2 - w * host.view.scale) / 2;
      host.view.offsetY = margin + maxY * host.view.scale + (host.canvasEl.value.height - margin * 2 - h * host.view.scale) / 2;
    }
  } else {
    const defaultSpanM = 100;
    const shortSidePx = Math.max(1, Math.min(host.canvasEl.value.width, host.canvasEl.value.height));
    host.view.scale = shortSidePx / defaultSpanM;
    host.view.offsetX = host.canvasEl.value.width / 2;
    host.view.offsetY = host.canvasEl.value.height / 2;
  }
  render();
}

function centerViewOnRoad(index) {
  const road = host.roads.value[index];
  if (!road || !host.canvasEl.value) return;
  const points = Array.isArray(road.points) ? road.points : [];
  if (!points.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  points.forEach((p) => {
    minX = Math.min(minX, Number(p.x));
    minY = Math.min(minY, Number(p.y));
    maxX = Math.max(maxX, Number(p.x));
    maxY = Math.max(maxY, Number(p.y));
  });
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  host.view.offsetX = host.canvasEl.value.width * 0.5 - centerX * host.view.scale;
  host.view.offsetY = host.canvasEl.value.height * 0.5 + centerY * host.view.scale;
  render();
}

function centerViewOnJunction(junctionId) {
  if (!host.canvasEl.value) return;
  const mesh = (host.junctionMeshes.value || []).find((m) => String(m.id) === String(junctionId));
  if (!mesh) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (p) => {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  (mesh.polygon || []).forEach(extend);
  if (mesh.center) extend(mesh.center);
  (mesh.approaches || []).forEach((a) => {
    extend(a?.anchor);
    extend(a?.boundary);
  });
  (mesh.internalLaneCurves || []).forEach((curve) => {
    (curve || []).forEach(extend);
  });
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  host.view.offsetX = host.canvasEl.value.width * 0.5 - centerX * host.view.scale;
  host.view.offsetY = host.canvasEl.value.height * 0.5 + centerY * host.view.scale;
  render();
}

  Object.assign(host, {
    worldToScreen, screenToWorld, updateHoverRoadCoord, pickRoad, pickSelectedRoadEditPoint,
    performRender, render,
    resizeCanvas, fitView, centerViewOnRoad, centerViewOnJunction, getRoadRenderData, getRoadBounds,
    copyPointsLight, copyBoundaryLight, yieldToMain
  });

}
