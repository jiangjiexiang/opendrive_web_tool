import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { rotateVec } from './editorUtils.js';
import {
  parseHeaderFromXodr,
  parseRoadDetailsFromXodr,
  parseJunctionSpecsFromXodr,
  parseOpenDriveExtrasFromXodr,
  parseXodrImportBundle
} from './xodrParsers.js';
import {
  applyMapYamlToGeo,
  loadBackgroundImage,
  backgroundFileToDataUrl,
  isYamlFile
} from './backgroundMap.js';
import { createQualityDialogState, runQualityCheck } from './qualityCheck.js';
import {
  createRoadColorState,
  openRoadColorDialog as openRoadColorDialogAction,
  closeRoadColorDialog as closeRoadColorDialogAction,
  applyRoadColorDialog as applyRoadColorDialogAction,
  resetRoadColorDialogDefaults as resetRoadColorDialogDefaultsAction,
  getRoadPaletteForRoad as computeRoadPaletteForRoad,
  getJunctionGuideStyle
} from './roadColors.js';

export function useAppLogic() {
const canvasEl = ref(null);
const canvasWrap = ref(null);
const roadListEl = ref(null);
const xodrFileInput = ref(null);
const mapYamlFileInput = ref(null);
const bgFileInput = ref(null);

const roads = ref([]);
const selectedRoadIndex = ref(-1);
const mode = ref('select');
const drawingPoints = ref([]);
const connectDraft = ref({ first: null, second: null });
const extendDraft = ref(null);
const junctionDraft = ref({ handles: [] });
const junctionMeshes = ref([]);
const junctionSpecs = ref([]);
const bgImage = ref(null);
const mouseWorld = reactive({ x: 0, y: 0 });
const hoverRoadCoord = reactive({
  roadId: '',
  s: null,
  t: null,
  distance: null
});
const bgGeo = reactive({
  resolution: 1,
  originX: 0,
  originY: 0,
  yaw: 0,
  imageWidth: 0,
  imageHeight: 0
});
const lastXodr = ref('');
const importedXodrText = ref('');
const importedHeaderXml = ref('');
const rawRoadXmlById = ref({});
const rawJunctionXmlById = ref({});
const rawOpenDriveExtras = ref([]);
const dirtyRoadIds = ref({});
const dirtyJunctionIds = ref({});
const headerDirty = ref(false);
const suppressDetach = ref(false);
const endpointDrag = ref(null);
const suppressNextClick = ref(false);

const headerForm = reactive({
  name: 'web_editor_map',
  vendor: 'opendrive_web_tool',
  north: 0,
  south: 0,
  east: 0,
  west: 0
});

const roadForm = reactive({
  id: '',
  junction: '-1',
  leftLaneCount: 1,
  rightLaneCount: 1,
  leftLaneWidth: 3.5,
  rightLaneWidth: 3.5,
  length: 0,
  centerType: 'none',
  predecessorType: 'road',
  predecessorId: '',
  successorType: 'road',
  successorId: ''
});

const connectForm = reactive({
  smoothness: 0.35,
  overlap: 0
});

const drawForm = reactive({
  smoothing: 0.55,
  autoJunction: true
});

const junctionForm = reactive({
  edgePadding: 6,
  smoothness: 0.34,
  transitionLength: 16
});
const junctionUi = reactive({
  generating: false,
  status: '',
  lastError: '',
  lastGeneratedCount: 0,
  lastExpectedCount: 0
});

// Targeted tuning for problematic connectors (roadId+endpoint).
// Key format: "<fromRoadId>:<fromEndpoint>-><toRoadId>:<toEndpoint>"
const CONNECTOR_SAS_TUNE_OVERRIDES = {
  '2:end->3:start': { qPreferred: 1.35, qMin: 0.7, qMax: 2.1 },
  '3:start->2:end': { qPreferred: 0.75, qMin: 0.5, qMax: 1.4 }
};

const validateDialog = createQualityDialogState();
const { roadColorDialog, roadColorConfig } = createRoadColorState();

const view = reactive({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  panning: false,
  panStartX: 0,
  panStartY: 0,
  baseOffsetX: 0,
  baseOffsetY: 0,
  spaceDown: false
});

const GRID_BASE_M = 0.1;
const GRID_TARGET_PX = 9;
const ROAD_RENDER_CACHE = Symbol('roadRenderCache');
const ROAD_BOUNDS_CACHE = Symbol('roadBoundsCache');
const ROAD_LIST_ROW_HEIGHT = 56;
const ROAD_LIST_OVERSCAN = 8;

let ctx = null;
let resizeObserver = null;
let roadListResizeObserver = null;
let renderFrame = 0;
const roadListScrollTop = ref(0);
const roadListViewportHeight = ref(320);
const collapsedRoadGroups = ref({});

const selectedRoad = computed(() => roads.value[selectedRoadIndex.value] || null);
const useVirtualRoadList = computed(() => roads.value.length >= 500);
const roadListWindowCount = computed(() => {
  const base = Math.ceil(Math.max(120, roadListViewportHeight.value) / ROAD_LIST_ROW_HEIGHT);
  return base + ROAD_LIST_OVERSCAN * 2;
});
const roadListStartIndex = computed(() => {
  if (!useVirtualRoadList.value) return 0;
  return Math.max(0, Math.floor(roadListScrollTop.value / ROAD_LIST_ROW_HEIGHT) - ROAD_LIST_OVERSCAN);
});
const roadListEndIndex = computed(() => {
  if (!useVirtualRoadList.value) return roads.value.length;
  return Math.min(roads.value.length, roadListStartIndex.value + roadListWindowCount.value);
});
const virtualRoadRows = computed(() => {
  if (!useVirtualRoadList.value) return [];
  const out = [];
  for (let i = roadListStartIndex.value; i < roadListEndIndex.value; i += 1) {
    out.push({ index: i, road: roads.value[i] });
  }
  return out;
});
const roadListTopPadding = computed(() => {
  if (!useVirtualRoadList.value) return 0;
  return roadListStartIndex.value * ROAD_LIST_ROW_HEIGHT;
});
const roadListBottomPadding = computed(() => {
  if (!useVirtualRoadList.value) return 0;
  return Math.max(0, (roads.value.length - roadListEndIndex.value) * ROAD_LIST_ROW_HEIGHT);
});
const childRoadEntriesByParent = computed(() => {
  const map = Object.create(null);
  roads.value.forEach((r, index) => {
    const rid = String(r.id ?? '');
    const predId = String(r.predecessorId || '');
    const succId = String(r.successorId || '');
    if (predId && predId !== rid) {
      if (!map[predId]) map[predId] = [];
      map[predId].push({ road: r, index });
    }
    if (succId && succId !== rid && succId !== predId) {
      if (!map[succId]) map[succId] = [];
      map[succId].push({ road: r, index });
    }
  });
  return map;
});
const childRoadIds = computed(() => {
  const ids = new Set();
  Object.values(childRoadEntriesByParent.value).forEach((entries) => {
    (entries || []).forEach((entry) => {
      const id = String(entry?.road?.id ?? '');
      if (id) ids.add(id);
    });
  });
  return ids;
});
const roadTreeRows = computed(() => {
  const rows = roads.value
    .map((road, index) => ({ road, index }))
    .filter(({ road }) => !childRoadIds.value.has(String(road?.id ?? '')));
  return rows.length ? rows : roads.value.map((road, index) => ({ road, index }));
});

watch(selectedRoad, (road) => {
  if (!road) return;
  roadForm.id = road.id;
  roadForm.junction = road.junction;
  roadForm.leftLaneCount = Number(road.leftLaneCount || 0);
  roadForm.rightLaneCount = Number(road.rightLaneCount || 0);
  roadForm.leftLaneWidth = Number(road.leftLaneWidth || road.laneWidth || 3.5);
  roadForm.rightLaneWidth = Number(road.rightLaneWidth || road.laneWidth || 3.5);
  roadForm.length = Number(road.length || 0);
  roadForm.centerType = road.centerType || 'none';
  roadForm.predecessorType = road.predecessorType || 'road';
  roadForm.predecessorId = road.predecessorId || '';
  roadForm.successorType = road.successorType || 'road';
  roadForm.successorId = road.successorId || '';
  if (road.connectorMeta?.smoothness) {
    connectForm.smoothness = Number(road.connectorMeta.smoothness);
  }
  if (road.connectorMeta?.overlap !== undefined) {
    connectForm.overlap = Number(road.connectorMeta.overlap);
  }
});

watch(
  () => [headerForm.name, headerForm.vendor, headerForm.north, headerForm.south, headerForm.east, headerForm.west],
  () => detachImportedSource({ headerChanged: true })
);

function formatNum(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function formatYUp(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function getChildrenText(roadId) {
  const links = [];
  roads.value.forEach((r) => {
    if (String(r.id) === String(roadId)) return;
    if (String(r.predecessorId || '') === String(roadId) || String(r.successorId || '') === String(roadId)) {
      links.push(r.id);
    }
  });
  const uniq = [...new Set(links)];
  return uniq.length ? uniq.join(', ') : '无';
}

function getChildRoadEntries(roadId) {
  return childRoadEntriesByParent.value[String(roadId)] || [];
}

function hasChildRoadEntries(roadId) {
  return getChildRoadEntries(roadId).length > 0;
}

function isRoadChildrenExpanded(roadId) {
  return Boolean(collapsedRoadGroups.value[String(roadId)]);
}

function toggleRoadChildren(roadId) {
  const sid = String(roadId ?? '').trim();
  if (!sid || !hasChildRoadEntries(sid)) return;
  collapsedRoadGroups.value = {
    ...(collapsedRoadGroups.value || {}),
    [sid]: !isRoadChildrenExpanded(sid)
  };
}

function isRoadVisible(road) {
  return road?.visible !== false;
}

function toggleRoadVisibility(index) {
  const road = roads.value[index];
  if (!road) return;
  road.visible = road.visible === false;
  if (road.visible === false && selectedRoadIndex.value === index) {
    connectDraft.value = { first: null, second: null };
    extendDraft.value = null;
    junctionDraft.value = { handles: [] };
    endpointDrag.value = null;
  }
  render();
}

function getConnectHandleText(handle) {
  if (!handle) return '未选择';
  const road = roads.value[handle.roadIdx];
  if (!road) return '未选择';
  return `Road ${road.id} ${handle.endpoint === 'start' ? '起点' : '终点'}`;
}

function clearConnectDraft() {
  connectDraft.value = { first: null, second: null };
  render();
}

function clearJunctionDraft() {
  junctionDraft.value = { handles: [] };
  render();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function vecAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function vecSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function vecScale(v, s) {
  return { x: v.x * s, y: v.y * s };
}

function vecDot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function vecLen(v) {
  return Math.hypot(v.x, v.y);
}

function normalizeVec(v, fallback = { x: 1, y: 0 }) {
  const len = vecLen(v);
  if (len < 1e-8) return { ...fallback };
  return { x: v.x / len, y: v.y / len };
}

function perpLeft(v) {
  return { x: -v.y, y: v.x };
}

function convexHull(points) {
  const pts = (points || [])
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length <= 2) return pts;
  pts.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function solveVirtualIntersection(approaches) {
  if (!Array.isArray(approaches) || !approaches.length) return null;
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  let avgX = 0;
  let avgY = 0;
  approaches.forEach((a) => {
    const d = normalizeVec(a.dir);
    const p = a.pose;
    const m00 = 1 - d.x * d.x;
    const m01 = -d.x * d.y;
    const m11 = 1 - d.y * d.y;
    a11 += m00;
    a12 += m01;
    a22 += m11;
    b1 += m00 * p.x + m01 * p.y;
    b2 += m01 * p.x + m11 * p.y;
    avgX += p.x;
    avgY += p.y;
  });
  avgX /= approaches.length;
  avgY /= approaches.length;
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-6) return { x: avgX, y: avgY };
  return {
    x: (b1 * a22 - b2 * a12) / det,
    y: (a11 * b2 - a12 * b1) / det
  };
}

function addIdsToFlagMap(targetRef, ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const next = { ...(targetRef.value || {}) };
  ids.forEach((id) => {
    const sid = String(id ?? '').trim();
    if (!sid) return;
    next[sid] = true;
  });
  targetRef.value = next;
}

function detachImportedSource(options = {}) {
  if (suppressDetach.value) return;
  importedXodrText.value = '';

  if (options.headerChanged) {
    headerDirty.value = true;
  }

  const roadIds = Array.isArray(options.roadIds) ? options.roadIds : [];
  const junctionIds = Array.isArray(options.junctionIds) ? options.junctionIds : [];
  if (roadIds.length) addIdsToFlagMap(dirtyRoadIds, roadIds);
  if (junctionIds.length) addIdsToFlagMap(dirtyJunctionIds, junctionIds);
}

function postJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(async (res) => {
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  });
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

function worldToScreen(x, y) {
  return { x: x * view.scale + view.offsetX, y: -y * view.scale + view.offsetY };
}

function screenToWorld(x, y) {
  return { x: (x - view.offsetX) / view.scale, y: (view.offsetY - y) / view.scale };
}

function distPointToSeg(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
  const t = c1 / c2;
  const px = a.x + t * vx;
  const py = a.y + t * vy;
  return Math.hypot(p.x - px, p.y - py);
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
    const candidate = {
      roadId: String(road.id ?? ''),
      s: accS + projected.ratio * segLen,
      t: projected.signedOffset,
      distance: projected.distance
    };
    if (!best || candidate.distance < best.distance) {
      best = candidate;
    }
    accS += segLen;
  }
  return best;
}

function updateHoverRoadCoord(worldPoint) {
  const maxDistance = Math.max(2.5, 24 / Math.max(0.1, view.scale));
  let best = null;
  roads.value.forEach((road) => {
    if (road?.visible === false) return;
    const projected = projectPointToRoadST(worldPoint, road);
    if (!projected) return;
    if (!best || projected.distance < best.distance) best = projected;
  });
  if (!best || best.distance > maxDistance) {
    hoverRoadCoord.roadId = '';
    hoverRoadCoord.s = null;
    hoverRoadCoord.t = null;
    hoverRoadCoord.distance = null;
    return;
  }
  hoverRoadCoord.roadId = best.roadId;
  hoverRoadCoord.s = best.s;
  hoverRoadCoord.t = best.t;
  hoverRoadCoord.distance = best.distance;
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
  const nearMargin = 30 / Math.max(0.1, view.scale);
  roads.value.forEach((r, idx) => {
    if (r?.visible === false) return;
    if (!r.points || r.points.length < 2) return;
    const bounds = getRoadBounds(r);
    if (bounds) {
      if (worldPoint.x < bounds.minX - nearMargin || worldPoint.x > bounds.maxX + nearMargin
        || worldPoint.y < bounds.minY - nearMargin || worldPoint.y > bounds.maxY + nearMargin) {
        return;
      }
    }
    const renderData = getRoadRenderData(r);
    const centerLine = renderData?.centerRef?.length > 1 ? renderData.centerRef : r.points;
    const centerDist = distPointToPolyline(worldPoint, centerLine);
    const leftLaneCount = Math.max(0, Number(r.leftLaneCount || 0));
    const rightLaneCount = Math.max(0, Number(r.rightLaneCount || 0));
    const leftLaneWidth = Math.max(0.5, Number(r.leftLaneWidth || r.laneWidth || 3.5));
    const rightLaneWidth = Math.max(0.5, Number(r.rightLaneWidth || r.laneWidth || 3.5));
    const halfWidth = Math.max(1.8, leftLaneCount * leftLaneWidth * 0.5 + rightLaneCount * rightLaneWidth * 0.5);
    const clickPadding = 14 / Math.max(0.1, view.scale);
    let score = centerDist - (halfWidth + clickPadding);

    const leftPath = renderData?.leftBoundary || [];
    const rightPath = renderData?.rightBoundary || [];
    if (leftPath.length > 2 && rightPath.length > 2) {
      const bandPolygon = leftPath.concat([...rightPath].reverse());
      if (isPointInPolygon(worldPoint, bandPolygon)) {
        score = -2;
      }
    }

    if (score < best.score) best = { idx, score };
  });
  return best.score <= 0 ? best.idx : -1;
}

function drawPolyline(points, color, width, dashed = false, showPoints = false) {
  if (!points || !points.length) return;
  ctx.beginPath();
  const p0 = worldToScreen(points[0].x, points[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < points.length; i += 1) {
    const p = worldToScreen(points[i].x, points[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(dashed ? [10, 8] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  if (showPoints) {
    points.forEach((pt) => {
      const p = worldToScreen(pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
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

function getRoadProfileAtS(road, sValue) {
  const laneOffset = evaluateLinear(road.laneOffsetRecords || [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }], sValue, 0);
  const fallbackLeftWidth = Number(road.leftLaneWidth || road.laneWidth || 3.5);
  const fallbackRightWidth = Number(road.rightLaneWidth || road.laneWidth || 3.5);
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
  return { laneOffset, leftOffsets, rightOffsets, leftBoundary, rightBoundary };
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

function drawFilledBand(leftPath, rightPath, fillStyle) {
  if (!leftPath.length || !rightPath.length) return;
  ctx.beginPath();
  const p0 = worldToScreen(leftPath[0].x, leftPath[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < leftPath.length; i += 1) {
    const p = worldToScreen(leftPath[i].x, leftPath[i].y);
    ctx.lineTo(p.x, p.y);
  }
  for (let i = rightPath.length - 1; i >= 0; i -= 1) {
    const p = worldToScreen(rightPath[i].x, rightPath[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

const DEFAULT_ROAD_RENDER_STYLE = {
  baseFill: 'rgba(58, 146, 255, 0.2)',
  baseEdge: 'rgba(182, 226, 255, 0.9)',
  baseLane: 'rgba(219, 241, 255, 0.82)',
  baseCenter: 'rgba(120, 208, 255, 0.95)',
  selectedFill: 'rgba(0, 214, 255, 0.55)',
  selectedEdge: 'rgba(244, 253, 255, 1)',
  selectedLane: 'rgba(222, 247, 255, 0.96)',
  selectedCenter: 'rgba(255, 244, 138, 1)'
};

function readRoadRenderCache(road) {
  return road?.[ROAD_RENDER_CACHE] || null;
}

function writeRoadRenderCache(road, cache) {
  Object.defineProperty(road, ROAD_RENDER_CACHE, {
    value: cache,
    writable: true,
    configurable: true
  });
}

function readRoadBoundsCache(road) {
  return road?.[ROAD_BOUNDS_CACHE] || null;
}

function writeRoadBoundsCache(road, cache) {
  Object.defineProperty(road, ROAD_BOUNDS_CACHE, {
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
  const laneOffsetRecordsRef = road.laneOffsetRecords;
  const unchanged = cache
    && cache.pointsRef === pointsRef
    && cache.nativeLeftBoundaryRef === nativeLeftBoundaryRef
    && cache.nativeRightBoundaryRef === nativeRightBoundaryRef
    && cache.nativeLaneBoundariesRef === nativeLaneBoundariesRef
    && cache.laneOffsetRecordsRef === laneOffsetRecordsRef
    && cache.leftLaneCount === leftLaneCount
    && cache.rightLaneCount === rightLaneCount
    && cache.leftLaneWidth === leftLaneWidth
    && cache.rightLaneWidth === rightLaneWidth
    && cache.laneWidth === laneWidth;
  if (unchanged) return cache.data;

  const hasNativeBoundaries = Array.isArray(road.nativeLeftBoundary) && road.nativeLeftBoundary.length > 1
    && Array.isArray(road.nativeRightBoundary) && road.nativeRightBoundary.length > 1;
  const data = {
    hasNativeBoundaries,
    centerRef: hasNativeBoundaries ? road.points || [] : buildOffsetPath(road, (profile) => profile.laneOffset),
    leftBoundary: hasNativeBoundaries ? road.nativeLeftBoundary : buildOffsetPath(road, (profile) => profile.leftBoundary),
    rightBoundary: hasNativeBoundaries ? road.nativeRightBoundary : buildOffsetPath(road, (profile) => profile.rightBoundary),
    laneBoundaries: hasNativeBoundaries ? (road.nativeLaneBoundaries || []) : [],
    leftArrowPath: leftLaneCount > 0 ? buildOffsetPath(road, (p) => (p.laneOffset + p.leftBoundary) * 0.5) : [],
    rightArrowPath: rightLaneCount > 0 ? buildOffsetPath(road, (p) => (p.laneOffset + p.rightBoundary) * 0.5) : []
  };
  data.leftArrowSeries = buildArrowSeries(data.leftArrowPath, true);
  data.rightArrowSeries = buildArrowSeries(data.rightArrowPath, false);
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
    laneOffsetRecordsRef,
    leftLaneCount,
    rightLaneCount,
    leftLaneWidth,
    rightLaneWidth,
    laneWidth,
    data
  });
  return data;
}

function getViewportBounds(marginPx = 80) {
  if (!canvasEl.value) return null;
  const canvas = canvasEl.value;
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

function shouldDrawRoadLabels(visibleRoadCount) {
  return view.scale >= 0.65 && visibleRoadCount <= 220;
}

function shouldDrawLaneArrows(visibleRoadCount, visiblePointCount) {
  return view.scale >= 1.2 && visibleRoadCount <= 320 && visiblePointCount <= 18000;
}

function shouldUseOverviewRoadRendering(visibleRoadCount, visiblePointCount) {
  return view.scale < 0.42 || visibleRoadCount > 900 || visiblePointCount > 50000;
}

function drawRoadSurface(road, selected, renderData = null, options = {}) {
  if (!road.points || road.points.length < 2) return;
  if (options.overview) {
    const overviewColor = options.palette?.center || (selected ? 'rgba(255, 244, 138, 0.98)' : 'rgba(120, 208, 255, 0.88)');
    const centerRef = options.allowFallbackCenterline
      ? (road.points || [])
      : (renderData?.centerRef || getRoadRenderData(road)?.centerRef || []);
    if (!centerRef.length) return;
    drawPolyline(
      centerRef,
      overviewColor,
      selected ? 2.2 : 1.2
    );
    return;
  }
  const resolvedRenderData = renderData || getRoadRenderData(road);
  if (!resolvedRenderData) return;
  const palette = options.palette || (selected
    ? {
        fill: DEFAULT_ROAD_RENDER_STYLE.selectedFill,
        edge: DEFAULT_ROAD_RENDER_STYLE.selectedEdge,
        lane: DEFAULT_ROAD_RENDER_STYLE.selectedLane,
        center: DEFAULT_ROAD_RENDER_STYLE.selectedCenter
      }
    : {
        fill: DEFAULT_ROAD_RENDER_STYLE.baseFill,
        edge: DEFAULT_ROAD_RENDER_STYLE.baseEdge,
        lane: DEFAULT_ROAD_RENDER_STYLE.baseLane,
        center: DEFAULT_ROAD_RENDER_STYLE.baseCenter
      });
  if (resolvedRenderData.hasNativeBoundaries) {
    drawFilledBand(resolvedRenderData.leftBoundary, resolvedRenderData.rightBoundary, palette.fill);
    drawPolyline(resolvedRenderData.leftBoundary, palette.edge, selected ? 2.2 : 1.6);
    drawPolyline(resolvedRenderData.rightBoundary, palette.edge, selected ? 2.2 : 1.6);
    if (options.showLaneMarkings || selected) {
      resolvedRenderData.laneBoundaries.forEach((lane) => {
        if (lane?.points?.length > 1) drawPolyline(lane.points, palette.lane, selected ? 1.4 : 1, true);
      });
    }
    if (!options.suppressCenterline || selected) {
      drawPolyline(resolvedRenderData.centerRef, palette.center, selected ? 2.4 : 1.2, true);
    }
    return;
  }
  drawFilledBand(resolvedRenderData.leftBoundary, resolvedRenderData.rightBoundary, palette.fill);
  drawPolyline(resolvedRenderData.leftBoundary, palette.edge, selected ? 2.2 : 1.6);
  drawPolyline(resolvedRenderData.rightBoundary, palette.edge, selected ? 2.2 : 1.6);
  if (!options.suppressCenterline || selected) {
    drawPolyline(resolvedRenderData.centerRef, palette.center, selected ? 2.8 : 1.6, true);
  }
}

function drawMeterGrid() {
  if (!ctx || !canvasEl.value) return;
  const canvas = canvasEl.value;
  const roadCount = roads.value.length;
  if (roadCount > 2600 && view.scale < 1.6) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const baseStepPx = GRID_BASE_M * view.scale;
  const skip = Math.max(1, Math.ceil(GRID_TARGET_PX / Math.max(0.0001, baseStepPx)));
  const stepM = GRID_BASE_M * skip;
  const majorEvery = roadCount > 1600 ? 20 : 10;
  const maxGridLines = roadCount > 1600 ? 900 : 3000;
  const worldMin = screenToWorld(0, 0);
  const worldMax = screenToWorld(canvas.width, canvas.height);
  const minX = Math.min(worldMin.x, worldMax.x);
  const maxX = Math.max(worldMin.x, worldMax.x);
  const minY = Math.min(worldMin.y, worldMax.y);
  const maxY = Math.max(worldMin.y, worldMax.y);

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const startX = Math.floor(minX / stepM) * stepM;
  const endX = Math.ceil(maxX / stepM) * stepM;
  const startY = Math.floor(minY / stepM) * stepM;
  const endY = Math.ceil(maxY / stepM) * stepM;

  const drawLine = (isMajor) => {
    ctx.strokeStyle = isMajor ? 'rgba(130, 170, 206, 0.26)' : 'rgba(79, 103, 126, 0.2)';
    ctx.lineWidth = 1;
  };

  let xCount = 0;
  for (let x = startX; x <= endX; x += stepM) {
    xCount += 1;
    if (xCount > maxGridLines) break;
    const sx = x * view.scale + view.offsetX;
    const idx = Math.round(x / stepM);
    const isMajor = idx % majorEvery === 0;
    drawLine(isMajor);
    ctx.beginPath();
    ctx.moveTo(Math.round(sx) + 0.5, 0);
    ctx.lineTo(Math.round(sx) + 0.5, canvas.height);
    ctx.stroke();
  }

  let yCount = 0;
  for (let y = startY; y <= endY; y += stepM) {
    yCount += 1;
    if (yCount > maxGridLines) break;
    const sy = -y * view.scale + view.offsetY;
    const idx = Math.round(y / stepM);
    const isMajor = idx % majorEvery === 0;
    drawLine(isMajor);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(canvas.width, Math.round(sy) + 0.5);
    ctx.stroke();
  }
}

function drawOriginAxes() {
  if (!ctx || !canvasEl.value) return;
  const canvas = canvasEl.value;
  const origin = worldToScreen(0, 0);

  // Y axis (x = 0)
  if (origin.x >= -2 && origin.x <= canvas.width + 2) {
    ctx.strokeStyle = 'rgba(255, 132, 132, 0.9)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(Math.round(origin.x) + 0.5, 0);
    ctx.lineTo(Math.round(origin.x) + 0.5, canvas.height);
    ctx.stroke();
  }

  // X axis (y = 0)
  if (origin.y >= -2 && origin.y <= canvas.height + 2) {
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(origin.y) + 0.5);
    ctx.lineTo(canvas.width, Math.round(origin.y) + 0.5);
    ctx.stroke();
  }

  // Origin marker
  if (origin.x >= -12 && origin.x <= canvas.width + 12 && origin.y >= -12 && origin.y <= canvas.height + 12) {
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#f7fbff';
    ctx.fill();
    ctx.strokeStyle = '#0f141a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawArrowAtWorld(x, y, dirX, dirY, color) {
  const dirLen = Math.hypot(dirX, dirY);
  if (dirLen < 1e-6) return;
  const ux = dirX / dirLen;
  const uy = dirY / dirLen;
  const nX = -uy;
  const nY = ux;
  const p = worldToScreen(x, y);
  const size = 7;
  const tail = { x: p.x - ux * size, y: p.y - uy * size };
  const left = { x: tail.x + nX * 3.2, y: tail.y + nY * 3.2 };
  const right = { x: tail.x - nX * 3.2, y: tail.y - nY * 3.2 };
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawLaneDirectionArrows(road, renderData = null) {
  if (!road.points || road.points.length < 2) return;
  const resolvedRenderData = renderData || getRoadRenderData(road);
  if (!resolvedRenderData) return;
  resolvedRenderData.rightArrowSeries.forEach((arrow) => {
    drawArrowAtWorld(arrow.x, arrow.y, arrow.dirX, arrow.dirY, 'rgba(124, 240, 213, 0.92)');
  });
  resolvedRenderData.leftArrowSeries.forEach((arrow) => {
    drawArrowAtWorld(arrow.x, arrow.y, arrow.dirX, arrow.dirY, 'rgba(255, 194, 124, 0.92)');
  });
}

function drawSingleHandle(handle, radius, fill, stroke, strokeWidth = 1.4) {
  if (!handle) return;
  const p = worldToScreen(handle.x, handle.y);
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}

function drawHandles() {
  if (mode.value === 'select') {
    const road = selectedRoad.value;
    const roadIdx = selectedRoadIndex.value;
    if (!road || roadIdx < 0) return;
    getRoadEditPoints(road).forEach((handle, pointIdx) => {
      const active = endpointDrag.value
        && endpointDrag.value.roadIdx === roadIdx
        && endpointDrag.value.pointIdx === pointIdx;
      drawSingleHandle(
        handle,
        active ? 6.6 : 5.2,
        '#88d7ff',
        active ? '#f8fcff' : '#0f141a',
        active ? 2 : 1.2
      );
    });
    return;
  }
  if (mode.value !== 'extend' && mode.value !== 'connect' && mode.value !== 'junction') return;
  getAllHandles().forEach((h) => {
    const p = worldToScreen(h.x, h.y);
    const chosenInConnect = mode.value === 'connect'
      && ((connectDraft.value.first
        && connectDraft.value.first.roadIdx === h.roadIdx
        && connectDraft.value.first.endpoint === h.endpoint)
      || (connectDraft.value.second
        && connectDraft.value.second.roadIdx === h.roadIdx
        && connectDraft.value.second.endpoint === h.endpoint));
    const chosenInJunction = mode.value === 'junction'
      && (junctionDraft.value.handles || []).some((it) => it.roadIdx === h.roadIdx && it.endpoint === h.endpoint);
    ctx.beginPath();
    ctx.arc(p.x, p.y, (chosenInConnect || chosenInJunction) ? 6.5 : 5, 0, Math.PI * 2);
    ctx.fillStyle = h.endpoint === 'start' ? '#6ad0ff' : '#ffd16a';
    ctx.fill();
    ctx.strokeStyle = (chosenInConnect || chosenInJunction) ? '#f8fcff' : '#0f141a';
    ctx.lineWidth = (chosenInConnect || chosenInJunction) ? 2 : 1.2;
    ctx.stroke();
  });
}

function drawDraftRoadPreview() {
  if (!drawingPoints.value.length) return;
  if (drawingPoints.value.length === 1) {
    const p = worldToScreen(drawingPoints.value[0].x, drawingPoints.value[0].y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#88d7ff';
    ctx.fill();
    return;
  }
  const source = selectedRoad.value || {};
  const draftRoad = {
    points: drawingPoints.value,
    leftLaneCount: Number(source.leftLaneCount || 1),
    rightLaneCount: Number(source.rightLaneCount || 1),
    laneWidth: Number(source.laneWidth || 3.5),
    leftLaneWidth: Number(source.leftLaneWidth || source.laneWidth || 3.5),
    rightLaneWidth: Number(source.rightLaneWidth || source.laneWidth || 3.5),
    laneOffsetRecords: [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }]
  };
  drawRoadSurface(draftRoad, true);
  drawLaneDirectionArrows(draftRoad);
  drawPolyline(drawingPoints.value, '#9be7ff', 1.2, true, true);
}

function drawJunctionMeshes() {
  const guideStyle = getJunctionGuideStyle(roadColorConfig);
  (junctionMeshes.value || []).forEach((mesh) => {
    if (Array.isArray(mesh.polygon) && mesh.polygon.length >= 3) {
      const p0 = worldToScreen(mesh.polygon[0].x, mesh.polygon[0].y);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < mesh.polygon.length; i += 1) {
        const p = worldToScreen(mesh.polygon[i].x, mesh.polygon[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = guideStyle.polygonFill;
      ctx.strokeStyle = guideStyle.polygonStroke;
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
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
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = guideStyle.centerDot;
      ctx.fill();
    }
  });
}

function performRender() {
  if (!ctx || !canvasEl.value) return;
  const canvas = canvasEl.value;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawMeterGrid();
  if (bgImage.value) {
    const res = Math.max(1e-6, Number(bgGeo.resolution || 1));
    const yaw = Number(bgGeo.yaw || 0);
    const width = Number(bgImage.value.width || bgGeo.imageWidth || 0);
    const height = Number(bgImage.value.height || bgGeo.imageHeight || 0);
    const topLeftWorld = vecAdd(
      { x: Number(bgGeo.originX || 0), y: Number(bgGeo.originY || 0) },
      rotateVec({ x: 0, y: height * res }, yaw)
    );
    const ex = rotateVec({ x: res, y: 0 }, yaw);
    const ey = rotateVec({ x: 0, y: -res }, yaw);
    const p = worldToScreen(topLeftWorld.x, topLeftWorld.y);
    ctx.save();
    ctx.transform(
      ex.x * view.scale,
      -ex.y * view.scale,
      ey.x * view.scale,
      -ey.y * view.scale,
      p.x,
      p.y
    );
    ctx.drawImage(bgImage.value, 0, 0, width, height);
    ctx.restore();
  }
  drawOriginAxes();
  drawJunctionMeshes();
  const viewportBounds = getViewportBounds(120);
  const visibleRoads = [];
  let visiblePointCount = 0;
  roads.value.forEach((r, idx) => {
    if (r?.visible === false) return;
    const bounds = getRoadBounds(r);
    if (bounds && viewportBounds && !boundsIntersect(bounds, viewportBounds)) return;
    visibleRoads.push({ road: r, idx });
    visiblePointCount += Array.isArray(r.points) ? r.points.length : 0;
  });
  const drawLabels = roadColorConfig.showRoadLabels && shouldDrawRoadLabels(visibleRoads.length);
  const drawArrows = shouldDrawLaneArrows(visibleRoads.length, visiblePointCount);
  const overviewMode = shouldUseOverviewRoadRendering(visibleRoads.length, visiblePointCount);
  const suppressCenterline = !overviewMode && (view.scale < 1.1 || visibleRoads.length > 220);
  const showLaneMarkings = !overviewMode && view.scale >= 1.25 && visibleRoads.length <= 160;
  visibleRoads.forEach(({ road: r, idx }) => {
    const sel = idx === selectedRoadIndex.value;
    const needDetail = !overviewMode || sel || drawArrows || drawLabels;
    const renderData = needDetail ? getRoadRenderData(r) : null;
    const palette = computeRoadPaletteForRoad(r, sel, roadColorConfig, DEFAULT_ROAD_RENDER_STYLE);
    drawRoadSurface(r, sel, renderData, {
      overview: overviewMode && !sel,
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
      ctx.fillStyle = String(roadColorConfig.roadLabelColor || '#111111');
      ctx.font = '12px sans-serif';
      ctx.fillText(`R${r.id}`, p.x + 7, p.y - 6);
    }
  });
  drawDraftRoadPreview();
  if (extendDraft.value) {
    drawPolyline([extendDraft.value.anchor, extendDraft.value.hover], '#77f2c8', 2, true);
  }
  drawHandles();
}

function render(force = false) {
  if (force) {
    if (renderFrame) {
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
    performRender();
    return;
  }
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    performRender();
  });
}

function resizeCanvas(keepWorldCenter = true) {
  if (!canvasEl.value || !canvasWrap.value) return;
  const rect = canvasWrap.value.getBoundingClientRect();
  const newWidth = Math.max(300, Math.floor(rect.width));
  const newHeight = Math.max(260, Math.floor(rect.height));
  if (newWidth === canvasEl.value.width && newHeight === canvasEl.value.height) return;
  const prevCenterWorld = keepWorldCenter ? screenToWorld(canvasEl.value.width / 2, canvasEl.value.height / 2) : { x: 0, y: 0 };
  canvasEl.value.width = newWidth;
  canvasEl.value.height = newHeight;
  if (keepWorldCenter) {
    view.offsetX = canvasEl.value.width / 2 - prevCenterWorld.x * view.scale;
    view.offsetY = canvasEl.value.height / 2 + prevCenterWorld.y * view.scale;
  }
  render();
}

function fitView() {
  if (!canvasEl.value) return;
  if (bgImage.value) {
    const res = Math.max(1e-6, Number(bgGeo.resolution || 1));
    const yaw = Number(bgGeo.yaw || 0);
    const width = Number(bgImage.value.width || bgGeo.imageWidth || 0);
    const height = Number(bgImage.value.height || bgGeo.imageHeight || 0);
    const origin = { x: Number(bgGeo.originX || 0), y: Number(bgGeo.originY || 0) };
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
    const sx = (canvasEl.value.width - margin * 2) / w;
    const sy = (canvasEl.value.height - margin * 2) / h;
    view.scale = Math.max(0.00001, Math.min(sx, sy));
    view.offsetX = margin - minX * view.scale + (canvasEl.value.width - margin * 2 - w * view.scale) / 2;
    view.offsetY = margin + maxY * view.scale + (canvasEl.value.height - margin * 2 - h * view.scale) / 2;
  } else if (roads.value.length) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    roads.value.forEach((r) => {
      if (r?.visible === false) return;
      (r.points || []).forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });
    });
    if (Number.isFinite(minX)) {
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const margin = 40;
      const sx = (canvasEl.value.width - margin * 2) / w;
      const sy = (canvasEl.value.height - margin * 2) / h;
      view.scale = Math.max(0.00001, Math.min(sx, sy));
      view.offsetX = margin - minX * view.scale + (canvasEl.value.width - margin * 2 - w * view.scale) / 2;
      view.offsetY = margin + maxY * view.scale + (canvasEl.value.height - margin * 2 - h * view.scale) / 2;
    }
  } else {
    const defaultSpanM = 100;
    const shortSidePx = Math.max(1, Math.min(canvasEl.value.width, canvasEl.value.height));
    view.scale = shortSidePx / defaultSpanM;
    view.offsetX = canvasEl.value.width / 2;
    view.offsetY = canvasEl.value.height / 2;
  }
  render();
}

function nextRoadId() {
  let maxId = 0;
  roads.value.forEach((r) => {
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

function roadPoseAtEnd(road, atStart) {
  const pts = road.points || [];
  if (pts.length < 2) return null;
  const idx = atStart ? 0 : pts.length - 1;
  const p = pts[idx];
  let hdg;
  if (atStart) {
    const p1 = pts[1];
    hdg = Math.atan2(p1.y - p.y, p1.x - p.x);
  } else {
    const p0 = pts[pts.length - 2];
    hdg = Math.atan2(p.y - p0.y, p.x - p0.x);
  }
  if (!Number.isFinite(hdg)) {
    hdg = Number(p.hdg);
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

function sampleBezier(p0, p1, p2, p3, segments = 24) {
  const pts = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    });
  }
  return pts;
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

function bezierCoefficients1d(p0, p1, p2, p3) {
  return {
    a: p0,
    b: 3 * (p1 - p0),
    c: 3 * (p2 - 2 * p1 + p0),
    d: p3 - 3 * p2 + 3 * p1 - p0
  };
}

function sampleBezierCurve(curve) {
  const chord = Math.hypot(curve.p3.x - curve.p0.x, curve.p3.y - curve.p0.y);
  return sampleBezier(curve.p0, curve.p1, curve.p2, curve.p3, Math.max(10, Math.ceil(chord / 1.5)));
}

function bezierCurveLength(curve) {
  return polylineLength(sampleBezierCurve(curve));
}

function bezierCurveToGeometry(curve, startS = 0) {
  const tangent = vecSub(curve.p1, curve.p0);
  const hdg = Math.atan2(tangent.y, tangent.x);
  const c = Math.cos(-hdg);
  const s = Math.sin(-hdg);
  const toLocal = (pt) => {
    const rel = vecSub(pt, curve.p0);
    return {
      x: rel.x * c - rel.y * s,
      y: rel.x * s + rel.y * c
    };
  };
  const l0 = toLocal(curve.p0);
  const l1 = toLocal(curve.p1);
  const l2 = toLocal(curve.p2);
  const l3 = toLocal(curve.p3);
  const u = bezierCoefficients1d(l0.x, l1.x, l2.x, l3.x);
  const v = bezierCoefficients1d(l0.y, l1.y, l2.y, l3.y);
  return {
    s: startS,
    x: curve.p0.x,
    y: curve.p0.y,
    hdg,
    length: bezierCurveLength(curve),
    type: 'paramPoly3',
    pRange: 'normalized',
    aU: u.a,
    bU: u.b,
    cU: u.c,
    dU: u.d,
    aV: v.a,
    bV: v.b,
    cV: v.c,
    dV: v.d
  };
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
  const geometry = [];
  let s = 0;
  segments.forEach((segment, idx) => {
    const sampled = sampleBezierCurve(segment);
    sampled.forEach((pt, sampleIdx) => {
      if (idx > 0 && sampleIdx === 0) return;
      const last = points[points.length - 1];
      if (!last || Math.hypot(last.x - pt.x, last.y - pt.y) > 1e-4) {
        points.push({ x: pt.x, y: pt.y });
      }
    });
    const geometryRecord = bezierCurveToGeometry(segment, s);
    geometry.push(geometryRecord);
    s += geometryRecord.length;
  });
  return { points, geometry, length: s };
}

function buildRoadShapeFromPoints(points, smoothing = drawForm.smoothing) {
  const clean = sanitizePoints(points);
  if (clean.length < 2) return { points: clean, geometry: [], length: 0 };
  return buildRoadShapeFromBezierSegments(buildCatmullRomBezierSegments(clean, smoothing));
}

function applyRoadShape(road, points, options = {}) {
  const sourcePoints = defaultEditPoints(points);
  const shape = Array.isArray(options.bezierSegments) && options.bezierSegments.length
    ? buildRoadShapeFromBezierSegments(options.bezierSegments)
    : buildRoadShapeFromPoints(sourcePoints, options.smoothing ?? drawForm.smoothing);
  road.editPoints = sourcePoints.map((pt) => ({ x: pt.x, y: pt.y }));
  road.points = shape.points.length ? shape.points : sourcePoints;
  road.geometry = shape.geometry || [];
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
  (junctionSpecs.value || []).forEach((j) => {
    const n = Number.parseInt(j.id, 10);
    if (Number.isFinite(n)) maxId = Math.max(maxId, n);
  });
  (junctionMeshes.value || []).forEach((j) => {
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

  if (preferredRole === 'incoming') {
    if (incomingCount > 0) return { roleUsed: 'incoming', count: incomingCount, width: incomingWidth, fallbackUsed: false };
    if (outgoingCount > 0) return { roleUsed: 'outgoing', count: outgoingCount, width: outgoingWidth, fallbackUsed: true };
    return { roleUsed: 'incoming', count: 1, width: incomingWidth, fallbackUsed: true };
  }

  if (outgoingCount > 0) return { roleUsed: 'outgoing', count: outgoingCount, width: outgoingWidth, fallbackUsed: false };
  if (incomingCount > 0) return { roleUsed: 'incoming', count: incomingCount, width: incomingWidth, fallbackUsed: true };
  return { roleUsed: 'outgoing', count: 1, width: outgoingWidth, fallbackUsed: true };
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
  const road = roads.value[handle.roadIdx];
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
      // Keep endpoints exactly snapped to approach boundaries.
      // Using the guarded Bezier segment directly may extend p0/p3 slightly.
      bezierSegments: []
    };
  }
  return {
    points: [{ x: p0.x, y: p0.y }, { x: p3.x, y: p3.y }],
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

function dirAngle(a, b) {
  const ua = normalizeVec(a);
  const ub = normalizeVec(b);
  return Math.acos(clamp(vecDot(ua, ub), -1, 1));
}

function buildBezierWithRadiusGuard(p0, p3, d0, d3, smoothness, minRadius) {
  let start = { x: p0.x, y: p0.y };
  let end = { x: p3.x, y: p3.y };
  const angle = Math.max(0.02, dirAngle(d0, d3));
  const radius = Math.max(1, Number(minRadius || 1));
  let chord = Math.hypot(end.x - start.x, end.y - start.y);
  const minChord = Math.max(0.5, 2 * radius * Math.sin(angle * 0.5));
  if (chord < minChord) {
    const extra = (minChord - chord) * 0.5;
    start = vecSub(start, vecScale(d0, extra));
    end = vecAdd(end, vecScale(d3, extra));
    chord = Math.hypot(end.x - start.x, end.y - start.y);
  }

  const circularHandle = (4 / 3) * Math.tan(angle * 0.25) * radius;
  let handleLen = Math.max(4, chord * Number(smoothness || 0.34), circularHandle);
  handleLen = Math.min(handleLen, Math.max(8, chord * 1.2));

  const p1 = vecAdd(start, vecScale(d0, handleLen));
  const p2 = vecSub(end, vecScale(d3, handleLen));
  return {
    p0: start,
    p1,
    p2,
    p3: end,
    points: sampleBezier(start, p1, p2, end, Math.max(18, Math.ceil(chord / 1.8)))
  };
}

function wrapAngleRad(angle) {
  let out = Number(angle || 0);
  while (out > Math.PI) out -= Math.PI * 2;
  while (out < -Math.PI) out += Math.PI * 2;
  return out;
}

function connectorTuneKey(fromRoadId, fromEndpoint, toRoadId, toEndpoint) {
  return `${String(fromRoadId)}:${String(fromEndpoint)}->${String(toRoadId)}:${String(toEndpoint)}`;
}

function getConnectorSasTune(fromRoadId, fromEndpoint, toRoadId, toEndpoint) {
  const direct = CONNECTOR_SAS_TUNE_OVERRIDES[connectorTuneKey(fromRoadId, fromEndpoint, toRoadId, toEndpoint)];
  if (direct) return direct;
  return CONNECTOR_SAS_TUNE_OVERRIDES[connectorTuneKey(toRoadId, toEndpoint, fromRoadId, fromEndpoint)] || null;
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

  for (let r = 0.2; r <= 0.8 + 1e-6; r += 0.1) {
    for (let scale = 0.8; scale <= 2.8 + 1e-6; scale += 0.15) {
      for (let q = 0.6; q <= 1.8 + 1e-6; q += 0.2) {
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

  if (!best) return null;

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
  road.geometry = sas.geometry;
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
  const sas = buildSasGeometryBetweenPoses(startPose, endPose);
  if (!sas || !Array.isArray(sas.geometry) || sas.geometry.length < 3) return null;
  const g0 = sas.geometry[0];
  const g1 = sas.geometry[1];
  const g2 = sas.geometry[2];
  const geometry = [
    {
      s: 0,
      x: Number(g0.x || 0),
      y: Number(g0.y || 0),
      hdg: Number(g0.hdg || 0),
      length: Number(g0.length || 0),
      type: 'line'
    },
    {
      s: Number(g0.length || 0),
      x: Number(g1.x || 0),
      y: Number(g1.y || 0),
      hdg: Number(g1.hdg || 0),
      length: Number(g1.length || 0),
      type: 'arc',
      curvature: Number(g1.curvature || 0)
    },
    {
      s: Number((Number(g0.length || 0) + Number(g1.length || 0)).toFixed(6)),
      x: Number(g2.x || 0),
      y: Number(g2.y || 0),
      hdg: Number(g2.hdg || 0),
      length: Number(g2.length || 0),
      type: 'line'
    }
  ];
  const total = geometry.reduce((acc, g) => acc + Number(g.length || 0), 0);
  return {
    geometry,
    length: Number(total.toFixed(6))
  };
}

function applyConnectorGeometryToRoad(road, startPose, endPose) {
  const lal = buildLineArcLineGeometryBetweenPoses(startPose, endPose);
  if (!lal) return false;
  road.geometry = lal.geometry;
  road.length = lal.length;
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
  const road = roads.value[roadIndex];
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
  roads.value.splice(roadIndex + 1, 0, rightRoad);
  return {
    leftRoadId,
    rightRoadId: String(rightRoad.id)
  };
}

function maybeAutoGenerateJunctionForNewestRoad() {
  if (!drawForm.autoJunction || roads.value.length < 2) return false;
  const newRoadIndex = roads.value.length - 1;
  const newRoad = roads.value[newRoadIndex];
  if (!isStandaloneRoad(newRoad)) return false;
  let hitInfo = null;
  for (let i = 0; i < roads.value.length - 1; i += 1) {
    const other = roads.value[i];
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
  const shiftedNewIndex = roads.value.findIndex((road) => String(road.id) === String(newRoad.id));
  const newSplit = splitStandaloneRoadAtIntersection(shiftedNewIndex, hitInfo.firstSeg, hitInfo.point);
  if (!newSplit) return false;

  const handles = [
    { id: otherSplit.leftRoadId, endpoint: 'end' },
    { id: otherSplit.rightRoadId, endpoint: 'start' },
    { id: newSplit.leftRoadId, endpoint: 'end' },
    { id: newSplit.rightRoadId, endpoint: 'start' }
  ].map((item) => ({
    roadIdx: roads.value.findIndex((road) => String(road.id) === String(item.id)),
    endpoint: item.endpoint
  })).filter((item) => item.roadIdx >= 0);

  if (handles.length < 3) return false;
  const result = generateJunctionFromHandles(handles);
  if (!result.ok) return false;
  junctionDraft.value = { handles: [] };
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
    const road = roads.value[h.roadIdx];
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

  const edgePadding = Math.max(1, Number(junctionForm.edgePadding || 6));
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
  detachImportedSource({
    roadIds: touchedApproachRoadIds
  });
  const meshId = nextJunctionId();

  refined.forEach((a) => {
    a.road.junctionRefId = String(meshId);
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
      let centerline = buildConnectorCenterline(from, to, junctionForm.smoothness);
      if (!Array.isArray(centerline?.points) || centerline.points.length < 2) {
        centerline = {
          points: [
          { x: Number(from.boundary?.x ?? from.pose?.x ?? 0), y: Number(from.boundary?.y ?? from.pose?.y ?? 0) },
          { x: Number(to.boundary?.x ?? to.pose?.x ?? 0), y: Number(to.boundary?.y ?? to.pose?.y ?? 0) }
          ],
          bezierSegments: []
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

  const pairBuckets = new Map();
  directedFlows.forEach((flow) => {
    const key = [String(flow.from.road.id), String(flow.to.road.id)].sort().join('::');
    const list = pairBuckets.get(key) || [];
    list.push(flow);
    pairBuckets.set(key, list);
  });
  const expectedConnectorCount = pairBuckets.size;

  for (const flows of pairBuckets.values()) {
    if (!flows.length) continue;
    let primary = flows[0];
    let reverse = flows.length > 1 ? flows[1] : null;
    if (reverse && String(primary.from.road.id) > String(reverse.from.road.id)) {
      const tmp = primary;
      primary = reverse;
      reverse = tmp;
    }

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

    const leftSpec = primarySideLeft
      ? buildSideSpec(primary, true)
      : buildSideSpec(reverse, true);
    const rightSpec = primarySideLeft
      ? buildSideSpec(reverse, false)
      : buildSideSpec(primary, false);

    const connectorRoad = createRoadFromPoints(
      primary.centerline.points,
      {},
      {
        bezierSegments: primary.centerline.bezierSegments,
        smoothing: junctionForm.smoothness
      }
    );
    const sasApplied = applySasGeometryToRoadSafe(
      connectorRoad,
      {
        x: Number(primary.from.boundary?.x ?? primary.centerline.points[0]?.x ?? 0),
        y: Number(primary.from.boundary?.y ?? primary.centerline.points[0]?.y ?? 0),
        hdg: Math.atan2(primary.from.incomingDir?.y || 0, primary.from.incomingDir?.x || 1)
      },
      {
        x: Number(primary.to.boundary?.x ?? primary.centerline.points[primary.centerline.points.length - 1]?.x ?? 0),
        y: Number(primary.to.boundary?.y ?? primary.centerline.points[primary.centerline.points.length - 1]?.y ?? 0),
        hdg: Math.atan2(primary.to.outgoingDir?.y || 0, primary.to.outgoingDir?.x || 1)
      },
      getConnectorSasTune(primary.from.road.id, primary.from.handle.endpoint, primary.to.road.id, primary.to.handle.endpoint)
    );
    if (!sasApplied) sasFallbackCount += 1;
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
      bidirectional: Boolean(reverse),
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
          junctionForm.smoothness,
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
    roads.value.push(connectorRoad);
    generatedRoadIds.push(String(connectorRoad.id));

    const pushConnectionMeta = (spec) => {
      if (!spec) return;
      connectorMeta.push({
        roadId: String(connectorRoad.id),
        fromRoadId: String(spec.flow.from.road.id),
        toRoadId: String(spec.flow.to.road.id),
        entryContactPoint: spec.sideLeft ? 'end' : 'start',
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

  junctionMeshes.value.push({
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
  junctionSpecs.value.push({
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
    selectedRoadIndex.value = roads.value.findIndex((r) => String(r.id) === lastAddedRoadId);
  } else {
    selectedRoadIndex.value = refined.length ? refined[0].handle.roadIdx : -1;
  }
  render();
  return {
    ok: true,
    generatedCount: generatedRoadIds.length,
    expectedCount: expectedConnectorCount,
    sasFallbackCount
  };
}

function generateJunctionFromDraft() {
  if (junctionUi.generating) return;
  const handles = (junctionDraft.value.handles || []).slice();
  junctionUi.generating = true;
  junctionUi.status = '正在生成路口...';
  junctionUi.lastError = '';
  junctionUi.lastGeneratedCount = 0;
  junctionUi.lastExpectedCount = 0;
  render();
  try {
    const result = generateJunctionFromHandles(handles);
    junctionDraft.value = { handles: [] };
    if (!result?.ok) {
      junctionUi.lastError = result?.reason || '自动路口生成失败。';
      junctionUi.status = '';
      window.alert(junctionUi.lastError);
      return;
    }
    junctionUi.lastGeneratedCount = Number(result.generatedCount || 0);
    junctionUi.lastExpectedCount = Number(result.expectedCount || 0);
    const sasFallbackCount = Number(result.sasFallbackCount || 0);
    junctionUi.status = `已生成 ${junctionUi.lastGeneratedCount}/${junctionUi.lastExpectedCount} 条连接道路`;
    if (sasFallbackCount > 0) {
      junctionUi.status += `（${sasFallbackCount} 条使用了回退几何）`;
    }
  } catch (error) {
    const message = error?.message || String(error || '未知错误');
    junctionUi.lastError = `自动路口生成异常：${message}`;
    junctionUi.status = '';
    console.error('[junction] generate failed:', error);
    window.alert(junctionUi.lastError);
  } finally {
    junctionUi.generating = false;
    render();
  }
}

function buildBezierBetweenHandles(firstHandle, secondHandle, smoothness, overlapValue = connectForm.overlap) {
  const firstRoad = roads.value[firstHandle.roadIdx];
  const secondRoad = roads.value[secondHandle.roadIdx];
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

function connectRoadsWithBezier(firstHandle, secondHandle, smoothness) {
  if (!firstHandle || !secondHandle) return false;
  if (firstHandle.roadIdx === secondHandle.roadIdx) return false;
  const built = buildBezierBetweenHandles(firstHandle, secondHandle, smoothness);
  if (!built) return false;
  const { points, bezierSegments, firstRoad, secondRoad, overlap } = built;
  const existingIdx = roads.value.findIndex((r) => {
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
    ? roads.value[existingIdx]
    : createRoadFromPoints(points, {}, { bezierSegments });
  const profile = blendedConnectorProfile(firstRoad, firstHandle.endpoint, secondRoad, secondHandle.endpoint);
  applyRoadShape(targetRoad, points, { bezierSegments });
  const p0 = roadPoseAtEnd(firstRoad, firstHandle.endpoint === 'start');
  const p3 = roadPoseAtEnd(secondRoad, secondHandle.endpoint === 'start');
  if (p0 && p3) {
    const d0 = endpointDirection(firstHandle.endpoint, p0.hdg);
    const d3 = endpointFinalDirection(secondHandle.endpoint, p3.hdg);
    applySasGeometryToRoadSafe(
      targetRoad,
      { x: p0.x, y: p0.y, hdg: Math.atan2(d0.y, d0.x) },
      { x: p3.x, y: p3.y, hdg: Math.atan2(d3.y, d3.x) },
      getConnectorSasTune(firstRoad.id, firstHandle.endpoint, secondRoad.id, secondHandle.endpoint)
    );
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
  detachImportedSource({
    roadIds: [String(firstRoad.id), String(secondRoad.id), String(targetRoad.id)]
  });
  if (existingIdx < 0) {
    roads.value.push(targetRoad);
    selectedRoadIndex.value = roads.value.length - 1;
  } else {
    selectedRoadIndex.value = existingIdx;
  }
  render();
  return true;
}

function rebuildSelectedConnector() {
  const road = selectedRoad.value;
  if (!road?.connectorMeta) return;
  const fromIdx = roads.value.findIndex((r) => String(r.id) === String(road.connectorMeta.fromRoadId));
  const toIdx = roads.value.findIndex((r) => String(r.id) === String(road.connectorMeta.toRoadId));
  if (fromIdx < 0 || toIdx < 0) return;
  const firstHandle = { roadIdx: fromIdx, endpoint: road.connectorMeta.fromEndpoint };
  const secondHandle = { roadIdx: toIdx, endpoint: road.connectorMeta.toEndpoint };
  const built = buildBezierBetweenHandles(firstHandle, secondHandle, connectForm.smoothness, connectForm.overlap);
  if (!built) return;
  const profile = blendedConnectorProfile(roads.value[fromIdx], firstHandle.endpoint, roads.value[toIdx], secondHandle.endpoint);
  applyRoadShape(road, built.points, { bezierSegments: built.bezierSegments });
  const p0 = roadPoseAtEnd(roads.value[fromIdx], firstHandle.endpoint === 'start');
  const p3 = roadPoseAtEnd(roads.value[toIdx], secondHandle.endpoint === 'start');
  if (p0 && p3) {
    const d0 = endpointDirection(firstHandle.endpoint, p0.hdg);
    const d3 = endpointFinalDirection(secondHandle.endpoint, p3.hdg);
    applySasGeometryToRoadSafe(
      road,
      { x: p0.x, y: p0.y, hdg: Math.atan2(d0.y, d0.x) },
      { x: p3.x, y: p3.y, hdg: Math.atan2(d3.y, d3.x) },
      getConnectorSasTune(roads.value[fromIdx].id, firstHandle.endpoint, roads.value[toIdx].id, secondHandle.endpoint)
    );
  }
  road.leftLaneCount = profile.leftLaneCount;
  road.rightLaneCount = profile.rightLaneCount;
  road.leftLaneWidth = profile.leftLaneWidth;
  road.rightLaneWidth = profile.rightLaneWidth;
  road.laneWidth = (profile.leftLaneWidth + profile.rightLaneWidth) * 0.5;
  road.connectorMeta.smoothness = Number(connectForm.smoothness);
  road.connectorMeta.overlap = Number(connectForm.overlap || 0);
  detachImportedSource({
    roadIds: [String(road.id)]
  });
  render();
}

function rebuildConnectorRoadFromMeta(connectorRoad) {
  if (!connectorRoad?.connectorMeta) return false;
  const meta = connectorRoad.connectorMeta;
  const fromIdx = roads.value.findIndex((r) => String(r.id) === String(meta.fromRoadId));
  const toIdx = roads.value.findIndex((r) => String(r.id) === String(meta.toRoadId));
  if (fromIdx < 0 || toIdx < 0) return false;
  const firstHandle = { roadIdx: fromIdx, endpoint: meta.fromEndpoint };
  const secondHandle = { roadIdx: toIdx, endpoint: meta.toEndpoint };
  const smoothness = Number(meta.smoothness || 0.35);
  const overlap = Number(meta.overlap || 0);
  const built = buildBezierBetweenHandles(firstHandle, secondHandle, smoothness, overlap);
  if (!built) return false;
  const profile = blendedConnectorProfile(roads.value[fromIdx], firstHandle.endpoint, roads.value[toIdx], secondHandle.endpoint);
  applyRoadShape(connectorRoad, built.points, { bezierSegments: built.bezierSegments });
  const p0 = roadPoseAtEnd(roads.value[fromIdx], firstHandle.endpoint === 'start');
  const p3 = roadPoseAtEnd(roads.value[toIdx], secondHandle.endpoint === 'start');
  if (p0 && p3) {
    const d0 = endpointDirection(firstHandle.endpoint, p0.hdg);
    const d3 = endpointFinalDirection(secondHandle.endpoint, p3.hdg);
    applySasGeometryToRoadSafe(
      connectorRoad,
      { x: p0.x, y: p0.y, hdg: Math.atan2(d0.y, d0.x) },
      { x: p3.x, y: p3.y, hdg: Math.atan2(d3.y, d3.x) },
      getConnectorSasTune(roads.value[fromIdx].id, firstHandle.endpoint, roads.value[toIdx].id, secondHandle.endpoint)
    );
  }
  connectorRoad.leftLaneCount = profile.leftLaneCount;
  connectorRoad.rightLaneCount = profile.rightLaneCount;
  connectorRoad.leftLaneWidth = profile.leftLaneWidth;
  connectorRoad.rightLaneWidth = profile.rightLaneWidth;
  connectorRoad.laneWidth = (profile.leftLaneWidth + profile.rightLaneWidth) * 0.5;
  detachImportedSource({
    roadIds: [String(connectorRoad.id)]
  });
  return true;
}

function rebuildConnectorsLinkedToRoad(roadId) {
  const targetRoadId = String(roadId || '').trim();
  if (!targetRoadId) return false;
  let changed = false;
  roads.value.forEach((road) => {
    if (!road?.connectorMeta) return;
    if (String(road.connectorMeta.fromRoadId) !== targetRoadId
      && String(road.connectorMeta.toRoadId) !== targetRoadId) {
      return;
    }
    if (rebuildConnectorRoadFromMeta(road)) changed = true;
  });
  return changed;
}

function getAllHandles() {
  const handles = [];
  roads.value.forEach((road, roadIdx) => {
    if (road?.visible === false) return;
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
    const p = worldToScreen(h.x, h.y);
    const d = Math.hypot(screenX - p.x, screenY - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  });
  return bestDist <= 12 ? best : null;
}

function pickSelectedRoadEditPoint(screenX, screenY) {
  const road = selectedRoad.value;
  const roadIdx = selectedRoadIndex.value;
  if (!road || roadIdx < 0) return null;
  if (road.visible === false) return null;
  const editPoints = getRoadEditPoints(road);
  let best = null;
  let bestDist = Infinity;
  editPoints.forEach((pt, pointIdx) => {
    const p = worldToScreen(pt.x, pt.y);
    const d = Math.hypot(screenX - p.x, screenY - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = { roadIdx, pointIdx, x: pt.x, y: pt.y };
    }
  });
  return bestDist <= 12 ? best : null;
}

function completeExtend(toPoint) {
  if (!extendDraft.value) return;
  const fromRoad = roads.value[extendDraft.value.roadIdx];
  if (!fromRoad) { extendDraft.value = null; return; }
  const d = Math.hypot(toPoint.x - extendDraft.value.anchor.x, toPoint.y - extendDraft.value.anchor.y);
  if (d < 0.5) { extendDraft.value = null; return; }
  const newRoad = createRoadFromPoints([
    { x: extendDraft.value.anchor.x, y: extendDraft.value.anchor.y },
    { x: toPoint.x, y: toPoint.y }
  ]);
  if (extendDraft.value.endpoint === 'end') {
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
  detachImportedSource({
    roadIds: [String(fromRoad.id)]
  });
  roads.value.push(newRoad);
  selectedRoadIndex.value = roads.value.length - 1;
  extendDraft.value = null;
  render();
}

function setMode(next) {
  mode.value = next;
  connectDraft.value = { first: null, second: null };
  extendDraft.value = null;
  junctionDraft.value = { handles: [] };
  endpointDrag.value = null;
  render();
}

function selectRoad(i) {
  selectedRoadIndex.value = i;
  render();
}

function finishRoad() {
  if (drawingPoints.value.length < 2) return;
  detachImportedSource();
  roads.value.push(createRoadFromPoints(drawingPoints.value.slice()));
  selectedRoadIndex.value = roads.value.length - 1;
  drawingPoints.value = [];
  maybeAutoGenerateJunctionForNewestRoad();
  render();
}

function removeRawJunctionRecords(junctionIds) {
  if (!Array.isArray(junctionIds) || !junctionIds.length) return;
  const ids = new Set(junctionIds.map((id) => String(id ?? '').trim()).filter(Boolean));
  if (!ids.size) return;

  const nextRaw = { ...(rawJunctionXmlById.value || {}) };
  let rawChanged = false;
  Object.keys(nextRaw).forEach((id) => {
    if (!ids.has(id)) return;
    delete nextRaw[id];
    rawChanged = true;
  });
  if (rawChanged) rawJunctionXmlById.value = nextRaw;

  const nextDirty = { ...(dirtyJunctionIds.value || {}) };
  let dirtyChanged = false;
  Object.keys(nextDirty).forEach((id) => {
    if (!ids.has(id)) return;
    delete nextDirty[id];
    dirtyChanged = true;
  });
  if (dirtyChanged) dirtyJunctionIds.value = nextDirty;
}

function synchronizeTopologyAfterRoadRemoval(removedRoadId) {
  const removedId = String(removedRoadId ?? '').trim();
  if (!removedId) return;
  const existingRoadIds = new Set(
    roads.value.map((road) => String(road?.id ?? '').trim()).filter(Boolean)
  );

  roads.value.forEach((road) => {
    const ownId = String(road?.id ?? '').trim();
    if (!ownId) return;
    if (String(road.predecessorType || 'road') === 'road' && String(road.predecessorId || '').trim() === removedId) {
      road.predecessorId = ownId;
    }
    if (String(road.successorType || 'road') === 'road' && String(road.successorId || '').trim() === removedId) {
      road.successorId = ownId;
    }
  });

  const touchedJunctionIds = new Set();
  junctionSpecs.value = (junctionSpecs.value || []).map((junction) => {
    const junctionId = String(junction?.id ?? '').trim();
    const nextConnections = (Array.isArray(junction?.connections) ? junction.connections : []).filter((conn) => {
      const incomingRoad = String(conn?.incomingRoad ?? '').trim();
      const connectingRoad = String(conn?.connectingRoad ?? '').trim();
      return existingRoadIds.has(incomingRoad) && existingRoadIds.has(connectingRoad);
    });
    if (nextConnections.length !== (junction?.connections || []).length) {
      touchedJunctionIds.add(junctionId);
    }
    return {
      ...junction,
      id: junctionId,
      connections: nextConnections
    };
  });

  junctionMeshes.value = (junctionMeshes.value || []).map((mesh) => {
    const nextApproaches = (mesh?.approaches || []).filter((a) => existingRoadIds.has(String(a?.roadId ?? '').trim()));
    const nextConnectorMeta = (mesh?.connectorMeta || []).filter((conn) => (
      existingRoadIds.has(String(conn?.roadId ?? '').trim())
      && existingRoadIds.has(String(conn?.fromRoadId ?? '').trim())
      && existingRoadIds.has(String(conn?.toRoadId ?? '').trim())
    ));
    return {
      ...mesh,
      approaches: nextApproaches,
      connectorMeta: nextConnectorMeta
    };
  }).filter((mesh) => {
    const meshId = String(mesh?.id ?? '').trim();
    const hasSpec = (junctionSpecs.value || []).some((junction) => String(junction?.id ?? '').trim() === meshId);
    return hasSpec || (mesh?.approaches || []).length || (mesh?.connectorMeta || []).length;
  });

  const referencedJunctionIds = new Set(
    roads.value
      .map((road) => String(road?.junction ?? '').trim())
      .filter((id) => id && id !== '-1')
  );

  const removedJunctionIds = [];
  junctionSpecs.value = (junctionSpecs.value || []).filter((junction) => {
    const junctionId = String(junction?.id ?? '').trim();
    const keep = (junction?.connections || []).length > 0 || referencedJunctionIds.has(junctionId);
    if (!keep) removedJunctionIds.push(junctionId);
    return keep;
  });

  if (removedJunctionIds.length) {
    const removedSet = new Set(removedJunctionIds);
    junctionMeshes.value = (junctionMeshes.value || []).filter((mesh) => !removedSet.has(String(mesh?.id ?? '').trim()));
    removeRawJunctionRecords(removedJunctionIds);
  }

  const survivingJunctionIds = new Set(
    (junctionSpecs.value || []).map((junction) => String(junction?.id ?? '').trim()).filter(Boolean)
  );

  roads.value.forEach((road) => {
    const ownId = String(road?.id ?? '').trim();
    const junctionId = String(road?.junction ?? '').trim();
    if (junctionId && junctionId !== '-1' && !survivingJunctionIds.has(junctionId)) {
      road.junction = '-1';
      if (String(road.predecessorType || 'road') === 'junction' && String(road.predecessorId || '').trim() === junctionId) {
        road.predecessorType = 'road';
        road.predecessorId = ownId;
      }
      if (String(road.successorType || 'road') === 'junction' && String(road.successorId || '').trim() === junctionId) {
        road.successorType = 'road';
        road.successorId = ownId;
      }
    }
  });

  if (touchedJunctionIds.size) {
    detachImportedSource({ junctionIds: [...touchedJunctionIds] });
  }
}

function undoPoint() {
  if (!drawingPoints.value.length) return;
  drawingPoints.value.pop();
  render();
}

function deleteRoad() {
  if (selectedRoadIndex.value < 0) return;
  endpointDrag.value = null;
  const removedRoad = roads.value[selectedRoadIndex.value];
  detachImportedSource({
    roadIds: removedRoad ? [String(removedRoad.id)] : []
  });
  roads.value.splice(selectedRoadIndex.value, 1);
  if (removedRoad) {
    const removedId = String(removedRoad.id);
    if (rawRoadXmlById.value[removedId]) {
      const nextRaw = { ...(rawRoadXmlById.value || {}) };
      delete nextRaw[removedId];
      rawRoadXmlById.value = nextRaw;
    }
    if (dirtyRoadIds.value[removedId]) {
      const nextDirty = { ...(dirtyRoadIds.value || {}) };
      delete nextDirty[removedId];
      dirtyRoadIds.value = nextDirty;
    }
    synchronizeTopologyAfterRoadRemoval(removedId);
  }
  selectedRoadIndex.value = -1;
  render();
}

function applySelectedRoad() {
  const r = selectedRoad.value;
  if (!r) return;
  const oldRoadId = String(r.id);
  const nextRoadId = String(roadForm.id).trim();
  detachImportedSource({
    roadIds: oldRoadId === nextRoadId ? [oldRoadId] : [oldRoadId, nextRoadId]
  });
  r.id = String(roadForm.id).trim();
  r.junction = String(roadForm.junction).trim();
  r.leftLaneCount = Math.max(0, Number(roadForm.leftLaneCount || 0));
  r.rightLaneCount = Math.max(0, Number(roadForm.rightLaneCount || 0));
  r.centerType = roadForm.centerType;
  r.predecessorType = roadForm.predecessorType;
  r.predecessorId = String(roadForm.predecessorId || '').trim();
  r.successorType = roadForm.successorType;
  r.successorId = String(roadForm.successorId || '').trim();
  r.leftLaneWidth = Math.max(0.5, Number(roadForm.leftLaneWidth || r.leftLaneWidth || 3.5));
  r.rightLaneWidth = Math.max(0.5, Number(roadForm.rightLaneWidth || r.rightLaneWidth || 3.5));
  r.laneWidth = (r.leftLaneWidth + r.rightLaneWidth) / 2;
  const targetLength = Number(roadForm.length || r.length);
  const editPoints = getRoadEditPoints(r);
  if (Number.isFinite(targetLength) && targetLength > 0 && Math.abs(targetLength - r.length) > 1e-6) {
    const current = polylineLength(editPoints);
    if (current > 1e-6) {
      const ratio = targetLength / current;
      const out = [{ x: editPoints[0].x, y: editPoints[0].y }];
      for (let i = 1; i < editPoints.length; i += 1) {
        const p0 = editPoints[i - 1];
        const p1 = editPoints[i];
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const d = Math.hypot(dx, dy);
        const prev = out[out.length - 1];
        out.push(d > 1e-6 ? { x: prev.x + (dx / d) * d * ratio, y: prev.y + (dy / d) * d * ratio } : { ...prev });
      }
      r.editPoints = out;
    }
  }
  applyRoadShape(r, getRoadEditPoints(r));
  render();
}

function currentSpec() {
  const roadsForExport = roads.value.map((r) => {
    const rid = String(r.id);
    const rawRoadXml = dirtyRoadIds.value[rid] ? '' : (rawRoadXmlById.value[rid] || '');
    return {
      ...r,
      length: polylineLength(r.points),
      rawRoadXml
    };
  });
  const junctions = junctionsForExport();
  return {
    header: {
      name: headerForm.name,
      vendor: headerForm.vendor,
      north: Number(headerForm.north),
      south: Number(headerForm.south),
      east: Number(headerForm.east),
      west: Number(headerForm.west),
      rawHeaderXml: headerDirty.value ? undefined : (importedHeaderXml.value || undefined)
    },
    roads: roadsForExport,
    junctions,
    rawOpenDriveExtras: rawOpenDriveExtras.value
  };
}

async function runValidate() {
  await runQualityCheck({
    postJson,
    currentSpec,
    importedXodrTextRef: importedXodrText,
    dialog: validateDialog
  });
}

async function generateXodr() {
  const { xodr } = await postJson('/api/generate-xodr', currentSpec());
  lastXodr.value = xodr;
}

async function generateAndDownloadXodr() {
  await generateXodr();
  downloadXodr();
}

function downloadXodr() {
  const content = lastXodr.value || importedXodrText.value;
  if (!content) return;
  const blob = new Blob([content], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${headerForm.name || 'map'}.xodr`;
  a.click();
  URL.revokeObjectURL(url);
}

function junctionsForExport() {
  const list = [];
  const used = new Set();
  const referencedByRoads = new Set(
    roads.value
      .map((r) => String(r?.junction ?? '').trim())
      .filter((id) => id && id !== '-1')
  );
  (junctionSpecs.value || []).forEach((j) => {
    const id = String(j?.id ?? '').trim();
    if (!id) return;
    if (referencedByRoads.size && !referencedByRoads.has(id)) return;
    used.add(id);
    list.push({
      ...j,
      id,
      rawJunctionXml: dirtyJunctionIds.value[id] ? '' : (rawJunctionXmlById.value[id] || j.rawJunctionXml || '')
    });
  });
  Object.entries(rawJunctionXmlById.value || {}).forEach(([id, raw]) => {
    const sid = String(id);
    if (used.has(sid)) return;
    if (referencedByRoads.size && !referencedByRoads.has(sid)) return;
    list.push({
      id: sid,
      name: `junction_${sid}`,
      connections: [],
      rawJunctionXml: String(raw || '')
    });
  });
  return list;
}

function applyHeaderFromXodr(xmlText) {
  const parsed = parseHeaderFromXodr(xmlText);
  importedHeaderXml.value = parsed.rawHeaderXml || '';
  if (parsed.name) headerForm.name = parsed.name;
  if (parsed.vendor) headerForm.vendor = parsed.vendor;
  if (Number.isFinite(parsed.north)) headerForm.north = parsed.north;
  if (Number.isFinite(parsed.south)) headerForm.south = parsed.south;
  if (Number.isFinite(parsed.east)) headerForm.east = parsed.east;
  if (Number.isFinite(parsed.west)) headerForm.west = parsed.west;
}

function applyNativeRoads(parsedRoads, importedJunctions = [], importedRoadDetails = {}) {
  const normalized = (parsedRoads || []).map((r, idx) => ({
    id: String(r.id ?? idx + 1),
    junction: String(r.junction ?? '-1'),
    leftLaneCount: Math.max(0, Number(r.leftLaneCount || 0)),
    rightLaneCount: Math.max(0, Number(r.rightLaneCount || 0)),
    laneWidth: Math.max(0.5, Number(r.laneWidth || 3.5)),
    leftLaneWidth: Math.max(0.5, Number(r.leftLaneWidth || r.laneWidth || 3.5)),
    rightLaneWidth: Math.max(0.5, Number(r.rightLaneWidth || r.laneWidth || 3.5)),
    centerType: r.centerType || 'none',
    predecessorType: r.predecessorType || 'road',
    predecessorId: String(r.predecessorId ?? r.id ?? idx + 1),
    predecessorContactPoint: String(r.predecessorContactPoint || 'end'),
    successorType: r.successorType || 'road',
    successorId: String(r.successorId ?? r.id ?? idx + 1),
    successorContactPoint: String(r.successorContactPoint || 'start'),
    laneOffsetRecords: [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }],
    editPoints: Array.isArray(r.editPoints) && r.editPoints.length >= 2
      ? r.editPoints.map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      : defaultEditPoints(Array.isArray(r.points) && r.points.length >= 2
        ? [r.points[0], r.points[r.points.length - 1]]
        : r.points),
    points: Array.isArray(r.points) ? r.points.map((p) => ({ x: Number(p.x), y: Number(p.y), s: Number(p.s), hdg: Number(p.hdg) })) : [],
    nativeLeftBoundary: Array.isArray(r.nativeLeftBoundary) ? r.nativeLeftBoundary.map((p) => ({ x: Number(p.x), y: Number(p.y) })) : [],
    nativeRightBoundary: Array.isArray(r.nativeRightBoundary) ? r.nativeRightBoundary.map((p) => ({ x: Number(p.x), y: Number(p.y) })) : [],
    nativeLaneBoundaries: Array.isArray(r.nativeLaneBoundaries) ? r.nativeLaneBoundaries : [],
    visible: r.visible !== false,
    length: Number.isFinite(Number(r.length)) ? Number(r.length) : polylineLength(r.points || [])
  }));
  normalized.forEach((road) => {
    const rid = String(road.id);
    const detail = importedRoadDetails[rid];
    if (!detail) return;
    road.predecessorType = detail.predecessorType || road.predecessorType;
    road.predecessorId = String(detail.predecessorId || road.predecessorId || '');
    road.predecessorContactPoint = detail.predecessorContactPoint || road.predecessorContactPoint;
    road.successorType = detail.successorType || road.successorType;
    road.successorId = String(detail.successorId || road.successorId || '');
    road.successorContactPoint = detail.successorContactPoint || road.successorContactPoint;
    if (Array.isArray(detail.laneSectionsSpec) && detail.laneSectionsSpec.length) {
      road.laneSectionsSpec = detail.laneSectionsSpec.map((section) => ({
        ...section,
        laneLinks: { ...(section?.laneLinks || {}) }
      }));
    }
  });
  roads.value = normalized;
  if (normalized.length > 500) {
    roadColorConfig.showRoadLabels = false;
  }
  junctionSpecs.value = Array.isArray(importedJunctions) ? importedJunctions.map((j) => ({ ...j })) : [];
  drawingPoints.value = [];
  junctionDraft.value = { handles: [] };
  junctionMeshes.value = [];
  selectedRoadIndex.value = normalized.length ? 0 : -1;
  fitView();
  render();
}

function pickXodrFile() {
  xodrFileInput.value?.click();
}

function pickMapYamlFile() {
  mapYamlFileInput.value?.click();
}

function pickBgFile() {
  bgFileInput.value?.click();
}

async function importXodr() {
  const file = xodrFileInput.value?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    suppressDetach.value = true;
    const parsedBundle = parseXodrImportBundle(text);
    const parsedHeader = parsedBundle?.header || parseHeaderFromXodr(text);
    importedHeaderXml.value = parsedHeader.rawHeaderXml || '';
    if (parsedHeader.name) headerForm.name = parsedHeader.name;
    if (parsedHeader.vendor) headerForm.vendor = parsedHeader.vendor;
    if (Number.isFinite(parsedHeader.north)) headerForm.north = parsedHeader.north;
    if (Number.isFinite(parsedHeader.south)) headerForm.south = parsedHeader.south;
    if (Number.isFinite(parsedHeader.east)) headerForm.east = parsedHeader.east;
    if (Number.isFinite(parsedHeader.west)) headerForm.west = parsedHeader.west;
    const { details, rawRoads } = parsedBundle?.roadDetails || parseRoadDetailsFromXodr(text);
    const { specs: parsedJunctions, rawById } = parsedBundle?.junctions || parseJunctionSpecsFromXodr(text);
    const extras = parsedBundle?.extras || parseOpenDriveExtrasFromXodr(text);
    rawRoadXmlById.value = rawRoads;
    rawJunctionXmlById.value = rawById;
    rawOpenDriveExtras.value = extras;
    dirtyRoadIds.value = {};
    dirtyJunctionIds.value = {};
    headerDirty.value = false;
    const payload = await postJson('/api/import-xodr-native', { xml: text, eps: 0.2 });
    applyNativeRoads(payload.roads || [], parsedJunctions, details);
    importedXodrText.value = text;
    lastXodr.value = '';
  } finally {
    suppressDetach.value = false;
    xodrFileInput.value.value = '';
  }
}

function applyMapYamlText(text, fallback = {}) {
  applyMapYamlToGeo(bgGeo, text, fallback);
}

async function importMapYaml() {
  const file = mapYamlFileInput.value?.files?.[0];
  if (!file) return;
  const text = await file.text();
  applyMapYamlText(text, {
    imageWidth: bgImage.value?.width || bgGeo.imageWidth || 0,
    imageHeight: bgImage.value?.height || bgGeo.imageHeight || 0
  });
  mapYamlFileInput.value.value = '';
  fitView();
  render();
}

async function uploadBackground() {
  const files = Array.from(bgFileInput.value?.files || []);
  if (!files.length) return;
  for (const file of files) {
    if (isYamlFile(file)) {
      const yamlText = await file.text();
      applyMapYamlText(yamlText, {
        imageWidth: bgImage.value?.width || bgGeo.imageWidth || 0,
        imageHeight: bgImage.value?.height || bgGeo.imageHeight || 0
      });
      continue;
    }
    const dataUrl = await backgroundFileToDataUrl(file);
    const img = await loadBackgroundImage(dataUrl);
    bgImage.value = img;
    bgGeo.imageWidth = Number(img.width || bgGeo.imageWidth || 0);
    bgGeo.imageHeight = Number(img.height || bgGeo.imageHeight || 0);
  }
  fitView();
  render();
  bgFileInput.value.value = '';
}

function handleCanvasClick(e) {
  if (!canvasEl.value || view.panning || view.spaceDown) return;
  if (suppressNextClick.value) {
    suppressNextClick.value = false;
    return;
  }
  const rect = canvasEl.value.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const p = screenToWorld(sx, sy);

  if (mode.value === 'draw') {
    drawingPoints.value.push({ x: p.x, y: p.y });
    render();
    return;
  }
  if (mode.value === 'select') {
    selectedRoadIndex.value = pickRoad(p);
    render();
    return;
  }
  if (mode.value === 'connect') {
    const handle = pickHandle(sx, sy);
    if (!handle) return;
    if (!connectDraft.value.first) {
      connectDraft.value.first = { roadIdx: handle.roadIdx, endpoint: handle.endpoint };
      selectedRoadIndex.value = handle.roadIdx;
      render();
      return;
    }
    if (connectDraft.value.first.roadIdx === handle.roadIdx
      && connectDraft.value.first.endpoint === handle.endpoint) {
      connectDraft.value = { first: null, second: null };
      render();
      return;
    }
    connectDraft.value.second = { roadIdx: handle.roadIdx, endpoint: handle.endpoint };
    connectRoadsWithBezier(connectDraft.value.first, connectDraft.value.second, connectForm.smoothness);
    connectDraft.value = { first: null, second: null };
    return;
  }
  if (mode.value === 'junction') {
    const handle = pickHandle(sx, sy);
    if (!handle) return;
    const existsAt = (junctionDraft.value.handles || []).findIndex((h) => (
      h.roadIdx === handle.roadIdx && h.endpoint === handle.endpoint
    ));
    if (existsAt >= 0) {
      junctionDraft.value.handles.splice(existsAt, 1);
      render();
      return;
    }
    if ((junctionDraft.value.handles || []).some((h) => h.roadIdx === handle.roadIdx)) {
      window.alert('同一条道路只能选择一个端点，请改选其他道路。');
      return;
    }
    if ((junctionDraft.value.handles || []).length >= 4) {
      window.alert('最多选择 4 个端点。');
      return;
    }
    junctionDraft.value.handles.push({ roadIdx: handle.roadIdx, endpoint: handle.endpoint });
    selectedRoadIndex.value = handle.roadIdx;
    render();
    return;
  }
  if (mode.value === 'extend') {
    if (!extendDraft.value) {
      const handle = pickHandle(sx, sy);
      if (!handle) return;
      extendDraft.value = {
        roadIdx: handle.roadIdx,
        endpoint: handle.endpoint,
        anchor: { x: handle.x, y: handle.y },
        hover: { x: handle.x, y: handle.y }
      };
      selectedRoadIndex.value = handle.roadIdx;
      render();
      return;
    }
    completeExtend(p);
  }
}

function handleWheel(e) {
  if (!canvasEl.value) return;
  e.preventDefault();
  const rect = canvasEl.value.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const before = screenToWorld(mx, my);
  view.scale = Math.max(0.1, Math.min(20, view.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
  const after = worldToScreen(before.x, before.y);
  view.offsetX += mx - after.x;
  view.offsetY += my - after.y;
  render();
}

function handleMouseDown(e) {
  if (!canvasEl.value) return;
  const rect = canvasEl.value.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (!view.spaceDown && mode.value === 'select') {
    const picked = pickSelectedRoadEditPoint(sx, sy);
    if (picked) {
      endpointDrag.value = {
        kind: 'edit-point',
        roadIdx: picked.roadIdx,
        pointIdx: picked.pointIdx,
        moved: false
      };
      render();
      return;
    }
  }
  if (!view.spaceDown) return;
  view.panning = true;
  view.panStartX = e.clientX;
  view.panStartY = e.clientY;
  view.baseOffsetX = view.offsetX;
  view.baseOffsetY = view.offsetY;
}

function handleMouseMove(e) {
  if (endpointDrag.value && canvasEl.value && mode.value === 'select') {
    const rect = canvasEl.value.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const road = roads.value[endpointDrag.value.roadIdx];
    const editPoints = getRoadEditPoints(road);
    if (road && editPoints.length >= 2 && endpointDrag.value.pointIdx >= 0 && endpointDrag.value.pointIdx < editPoints.length) {
      editPoints[endpointDrag.value.pointIdx].x = world.x;
      editPoints[endpointDrag.value.pointIdx].y = world.y;
      applyRoadShape(road, editPoints, { smoothing: drawForm.smoothing });
      if (!endpointDrag.value.moved) {
        endpointDrag.value.moved = true;
        detachImportedSource({ roadIds: [road.id] });
      }
      roadForm.length = Number(road.length || 0);
    }
    render();
    return;
  }
  if (view.panning) {
    view.offsetX = view.baseOffsetX + (e.clientX - view.panStartX);
    view.offsetY = view.baseOffsetY + (e.clientY - view.panStartY);
    render();
  }
  if (canvasEl.value) {
    const rect = canvasEl.value.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    mouseWorld.x = world.x;
    mouseWorld.y = world.y;
    updateHoverRoadCoord(mouseWorld);
  }
  if (!canvasEl.value || !extendDraft.value || mode.value !== 'extend') return;
  const rect = canvasEl.value.getBoundingClientRect();
  extendDraft.value.hover = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  render();
}

function handleMouseUp() {
  if (endpointDrag.value) {
    const draggedRoad = roads.value[endpointDrag.value.roadIdx];
    if (endpointDrag.value.moved) {
      suppressNextClick.value = true;
      if (draggedRoad) {
        rebuildConnectorsLinkedToRoad(draggedRoad.id);
        roadForm.length = Number(draggedRoad.length || 0);
      }
    }
    endpointDrag.value = null;
    render();
  }
  view.panning = false;
}

function isEditableElement(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName?.toUpperCase?.() || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function handleKeyDown(e) {
  if (!isEditableElement(e.target) && e.key === 'Enter') {
    if (mode.value === 'draw' && drawingPoints.value.length >= 2) {
      e.preventDefault();
      finishRoad();
      return;
    }
  }
  if (!isEditableElement(e.target) && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (selectedRoadIndex.value >= 0) {
      e.preventDefault();
      deleteRoad();
    }
  }
  if (e.code === 'Space') view.spaceDown = true;
}

function handleKeyUp(e) {
  if (e.code === 'Space') view.spaceDown = false;
}

function syncRoadListViewport() {
  if (!roadListEl.value) return;
  roadListViewportHeight.value = Math.max(120, roadListEl.value.clientHeight || 0);
}

function handleRoadListScroll(e) {
  const el = e?.target || roadListEl.value;
  if (!el) return;
  roadListScrollTop.value = el.scrollTop || 0;
  if (!roadListViewportHeight.value) syncRoadListViewport();
}

function openRoadColorDialog() {
  openRoadColorDialogAction(roadColorDialog, roadColorConfig);
}

function closeRoadColorDialog() {
  closeRoadColorDialogAction(roadColorDialog);
}

function applyRoadColorDialog() {
  applyRoadColorDialogAction(roadColorDialog, roadColorConfig);
  render(true);
}

function resetRoadColorDialogDefaults() {
  resetRoadColorDialogDefaultsAction(roadColorDialog);
  render(true);
}

onMounted(() => {
  ctx = canvasEl.value?.getContext('2d');
  resizeCanvas(false);
  fitView();
  if (canvasEl.value) {
    canvasEl.value.addEventListener('click', handleCanvasClick);
    canvasEl.value.addEventListener('wheel', handleWheel, { passive: false });
    canvasEl.value.addEventListener('mousedown', handleMouseDown);
  }
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', handleMouseUp);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  if (canvasWrap.value) {
    resizeObserver = new ResizeObserver(() => resizeCanvas(true));
    resizeObserver.observe(canvasWrap.value);
  }
  syncRoadListViewport();
  if (roadListEl.value) {
    roadListResizeObserver = new ResizeObserver(() => syncRoadListViewport());
    roadListResizeObserver.observe(roadListEl.value);
  }
});

onBeforeUnmount(() => {
  if (renderFrame) {
    cancelAnimationFrame(renderFrame);
    renderFrame = 0;
  }
  if (canvasEl.value) {
    canvasEl.value.removeEventListener('click', handleCanvasClick);
    canvasEl.value.removeEventListener('wheel', handleWheel);
    canvasEl.value.removeEventListener('mousedown', handleMouseDown);
  }
  window.removeEventListener('mousemove', handleMouseMove);
  window.removeEventListener('mouseup', handleMouseUp);
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  if (resizeObserver) resizeObserver.disconnect();
  if (roadListResizeObserver) roadListResizeObserver.disconnect();
});

  return {
    mode,
    setMode,
    finishRoad,
    undoPoint,
    deleteRoad,
    fitView,
    runValidate,
    generateAndDownloadXodr,
    pickXodrFile,
    pickBgFile,
    openRoadColorDialog,
    roads,
    selectedRoadIndex,
    formatNum,
    getChildRoadEntries,
    hasChildRoadEntries,
    isRoadChildrenExpanded,
    toggleRoadChildren,
    isRoadVisible,
    toggleRoadVisibility,
    roadTreeRows,
    selectRoad,
    roadListEl,
    handleRoadListScroll,
    useVirtualRoadList,
    virtualRoadRows,
    roadListTopPadding,
    roadListBottomPadding,
    xodrFileInput,
    mapYamlFileInput,
    bgFileInput,
    importXodr,
    importMapYaml,
    uploadBackground,
    canvasWrap,
    canvasEl,
    mouseWorld,
    formatYUp,
    bgGeo,
    hoverRoadCoord,
    roadColorDialog,
    closeRoadColorDialog,
    applyRoadColorDialog,
    resetRoadColorDialogDefaults,
    headerForm,
    drawForm,
    connectForm,
    connectDraft,
    getConnectHandleText,
    clearConnectDraft,
    selectedRoad,
    rebuildSelectedConnector,
    junctionForm,
    junctionUi,
    junctionDraft,
    junctionMeshes,
    generateJunctionFromDraft,
    clearJunctionDraft,
    roadForm,
    applySelectedRoad,
    validateDialog
  };
}
