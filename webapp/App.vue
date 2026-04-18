<template>
  <main class="layout">
    <header class="topbar">
      <div class="toolbar-group">
        <button type="button" class="mode-btn" :class="{ active: mode === 'draw' }" @click="setMode('draw')">绘制</button>
        <button type="button" class="mode-btn" :class="{ active: mode === 'select' }" @click="setMode('select')">选择</button>
        <button type="button" class="mode-btn" :class="{ active: mode === 'connect' }" @click="setMode('connect')">连接</button>
        <button type="button" class="mode-btn" :class="{ active: mode === 'extend' }" @click="setMode('extend')">延伸</button>
        <button type="button" class="mode-btn" :class="{ active: mode === 'junction' }" @click="setMode('junction')">路口</button>
      </div>
      <div class="toolbar-group">
        <button type="button" @click="finishRoad">完成道路</button>
        <button type="button" @click="undoPoint">撤销点</button>
        <button type="button" @click="deleteRoad">删除选中</button>
        <button type="button" @click="fitView">适配视图</button>
      </div>
      <div class="toolbar-group">
        <button type="button" @click="runValidate">校验</button>
        <button type="button" @click="generateXodr">生成XODR</button>
        <button type="button" @click="downloadXodr">下载</button>
        <button type="button" @click="pickXodrFile">导入XODR</button>
        <button type="button" @click="pickBgFile">上传底图</button>
      </div>
    </header>

    <aside class="sidebar left-rail">
      <h1>OpenDRIVE 编辑器</h1>
      <p class="desc">左侧道路区</p>
      <section class="panel road-panel">
        <h2>Roads ({{ roads.length }})</h2>
        <div class="road-list road-list-fill">
          <div v-for="(road, i) in roads" :key="`${road.id}-${i}`" class="road-tree-item">
            <button
              type="button"
              class="road-item"
              :class="{ selected: i === selectedRoadIndex }"
              @click="selectRoad(i)"
            >
              <div>Road {{ road.id }} | len={{ formatNum(road.length, 2) }} | pts={{ road.points.length }}</div>
              <div class="meta">pred={{ road.predecessorId || '-' }} | succ={{ road.successorId || '-' }}</div>
            </button>
            <div v-if="getChildRoadEntries(road.id).length" class="child-road-list">
              <button
                v-for="child in getChildRoadEntries(road.id)"
                :key="`child-${road.id}-${child.index}`"
                type="button"
                class="child-road-item"
                :class="{ selected: child.index === selectedRoadIndex }"
                @click="selectRoad(child.index)"
              >
                ↳ Road {{ child.road.id }} | len={{ formatNum(child.road.length, 2) }} | pts={{ child.road.points.length }}
              </button>
            </div>
          </div>
          <div v-if="!roads.length" class="empty">暂无道路</div>
        </div>
      </section>
      <input ref="xodrFileInput" type="file" accept=".xodr,.xml,text/xml,application/xml" class="hidden-file" @change="importXodr" />
      <input ref="bgFileInput" type="file" accept="image/*" class="hidden-file" @change="uploadBackground" />
    </aside>

    <section class="viewer center-stage">
      <div ref="canvasWrap" class="canvas-wrap">
        <canvas ref="canvasEl" class="canvas-el" width="1280" height="720" />
      </div>
      <div class="stage-tip">左键交互，滚轮缩放，空格+拖动平移</div>
    </section>

    <aside class="sidebar right-rail">
      <p class="desc">右侧属性区</p>
      <section class="panel">
        <h2>Header</h2>
        <div class="grid2">
          <label>name<input v-model="headerForm.name" /></label>
          <label>vendor<input v-model="headerForm.vendor" /></label>
          <label>north<input v-model.number="headerForm.north" type="number" /></label>
          <label>south<input v-model.number="headerForm.south" type="number" /></label>
          <label>east<input v-model.number="headerForm.east" type="number" /></label>
          <label>west<input v-model.number="headerForm.west" type="number" /></label>
        </div>
      </section>

      <section class="panel">
        <h2>弯道连接</h2>
        <div class="grid2">
          <label style="grid-column: 1 / -1;">贴合强度(越大弯道越“鼓”)
            <input v-model.number="connectForm.smoothness" type="range" min="0.1" max="0.8" step="0.01" />
          </label>
          <label>数值<input v-model.number="connectForm.smoothness" type="number" min="0.1" max="0.8" step="0.01" /></label>
          <label>端点重叠(m)<input v-model.number="connectForm.overlap" type="number" min="0" max="6" step="0.1" /></label>
          <div class="meta">连接模式下点击两个端点小球自动生成弯道</div>
          <div style="grid-column: 1 / -1;" class="meta">第一点: {{ getConnectHandleText(connectDraft.first) }}</div>
          <div style="grid-column: 1 / -1;" class="meta">第二点: {{ getConnectHandleText(connectDraft.second) }}</div>
          <div class="row" style="grid-column: 1 / -1; margin-top: 4px;">
            <button type="button" @click="clearConnectDraft">清空端点选择</button>
            <button type="button" :disabled="!selectedRoad?.connectorMeta" @click="rebuildSelectedConnector">重建选中弯道</button>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>自动路口生成</h2>
        <div class="grid2">
          <label>边缘留白(m)
            <input v-model.number="junctionForm.edgePadding" type="number" min="1" step="0.5" />
          </label>
          <label>内部平滑度
            <input v-model.number="junctionForm.smoothness" type="number" min="0.1" max="0.9" step="0.01" />
          </label>
          <label style="grid-column: 1 / -1;">车道过渡长度(m)
            <input v-model.number="junctionForm.transitionLength" type="number" min="3" step="1" />
          </label>
          <div style="grid-column: 1 / -1;" class="meta">路口模式下，依次点击 3~4 条彼此分离道路的端点，小球选择逻辑与弯道模式一致。</div>
          <div style="grid-column: 1 / -1;" class="meta">点1: {{ getConnectHandleText(junctionDraft.handles[0]) }}</div>
          <div style="grid-column: 1 / -1;" class="meta">点2: {{ getConnectHandleText(junctionDraft.handles[1]) }}</div>
          <div style="grid-column: 1 / -1;" class="meta">点3: {{ getConnectHandleText(junctionDraft.handles[2]) }}</div>
          <div style="grid-column: 1 / -1;" class="meta">点4(可选): {{ getConnectHandleText(junctionDraft.handles[3]) }}</div>
          <div style="grid-column: 1 / -1;" class="meta">已生成路口: {{ junctionMeshes.length }}</div>
          <div class="row" style="grid-column: 1 / -1; margin-top: 4px;">
            <button type="button" :disabled="junctionDraft.handles.length < 3" @click="generateJunctionFromDraft">生成路口</button>
            <button type="button" @click="clearJunctionDraft">清空路口端点选择</button>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>选中道路属性</h2>
        <div v-if="selectedRoad" class="grid2">
          <label>road id<input v-model="roadForm.id" /></label>
          <label>junction<input v-model="roadForm.junction" /></label>
          <label>left lanes<input v-model.number="roadForm.leftLaneCount" type="number" min="0" /></label>
          <label>right lanes<input v-model.number="roadForm.rightLaneCount" type="number" min="0" /></label>
          <label>left width<input v-model.number="roadForm.leftLaneWidth" type="number" min="0.5" step="0.1" /></label>
          <label>right width<input v-model.number="roadForm.rightLaneWidth" type="number" min="0.5" step="0.1" /></label>
          <label>length(m)<input v-model.number="roadForm.length" type="number" min="0.1" step="0.1" /></label>
          <label>center type
            <select v-model="roadForm.centerType">
              <option value="none">none</option>
              <option value="driving">driving</option>
              <option value="sidewalk">sidewalk</option>
              <option value="bicycle">bicycle</option>
            </select>
          </label>
          <label>pred type
            <select v-model="roadForm.predecessorType">
              <option value="road">road</option>
              <option value="junction">junction</option>
            </select>
          </label>
          <label>pred id<input v-model="roadForm.predecessorId" /></label>
          <label>succ type
            <select v-model="roadForm.successorType">
              <option value="road">road</option>
              <option value="junction">junction</option>
            </select>
          </label>
          <label>succ id<input v-model="roadForm.successorId" /></label>
          <div class="row" style="grid-column: 1 / -1; margin-top: 8px;">
            <button type="button" @click="applySelectedRoad">应用道路属性</button>
          </div>
        </div>
        <div v-else class="empty">请先在列表或画布中选择道路</div>
      </section>
    </aside>

    <div v-if="validateDialog.visible" class="dialog-mask" @click.self="validateDialog.visible = false">
      <div class="dialog">
        <div class="dialog-head">
          <h3>校验结果</h3>
          <button type="button" class="dialog-close" @click="validateDialog.visible = false">关闭</button>
        </div>
        <p class="dialog-status">
          status:
          <b :class="validateDialog.ok ? 'ok-text' : 'err-text'">{{ validateDialog.ok ? 'PASS' : 'FAIL' }}</b>
          | error: <b class="err-text">{{ validateDialog.errorCount }}</b>
          | warning: <b class="warn-text">{{ validateDialog.warningCount }}</b>
        </p>
        <p class="dialog-status">
          route_test:
          <b :class="validateDialog.routeOk ? 'ok-text' : 'err-text'">{{ validateDialog.routeStatus }}</b>
          <template v-if="validateDialog.routeSummary">
            | ok: <b class="ok-text">{{ validateDialog.routeSummary.ok }}</b>
            | fail: <b class="err-text">{{ validateDialog.routeSummary.fail }}</b>
            | total: <b>{{ validateDialog.routeSummary.total }}</b>
            | sample_fail: <b>{{ validateDialog.routeSummary.sampleFail }}</b>
          </template>
        </p>
        <div class="dialog-list">
          <p v-if="!validateDialog.errors.length && !validateDialog.warnings.length">没有错误或警告</p>
          <template v-else>
            <p v-for="(e, i) in validateDialog.errors" :key="`e-${i}`" class="err-text">[ERROR] {{ e }}</p>
            <p v-for="(w, i) in validateDialog.warnings" :key="`w-${i}`" class="warn-text">[WARN] {{ w }}</p>
          </template>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

const canvasEl = ref(null);
const canvasWrap = ref(null);
const xodrFileInput = ref(null);
const bgFileInput = ref(null);

const roads = ref([]);
const selectedRoadIndex = ref(-1);
const mode = ref('select');
const drawingPoints = ref([]);
const connectDraft = ref({ first: null, second: null });
const extendDraft = ref(null);
const junctionDraft = ref({ handles: [] });
const junctionMeshes = ref([]);
const bgImage = ref(null);
const lastXodr = ref('');
const importedXodrText = ref('');
const suppressDetach = ref(false);

const headerForm = reactive({
  name: 'web_editor_map',
  vendor: 'opendrive_web_tool',
  north: 1000,
  south: 0,
  east: 1000,
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
  overlap: 1.2
});

const junctionForm = reactive({
  edgePadding: 6,
  smoothness: 0.34,
  transitionLength: 16
});

const validateDialog = reactive({
  visible: false,
  ok: false,
  errorCount: 0,
  warningCount: 0,
  errors: [],
  warnings: [],
  routeOk: false,
  routeStatus: 'NOT_RUN',
  routeSummary: null
});

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

let ctx = null;
let resizeObserver = null;

const selectedRoad = computed(() => roads.value[selectedRoadIndex.value] || null);

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
  () => detachImportedSource()
);

function formatNum(v, digits = 2) {
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
  const out = [];
  roads.value.forEach((r, index) => {
    if (String(r.id) === String(roadId)) return;
    const linkedByPred = String(r.predecessorId || '') === String(roadId);
    const linkedBySucc = String(r.successorId || '') === String(roadId);
    if (linkedByPred || linkedBySucc) {
      out.push({ road: r, index });
    }
  });
  return out;
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

function detachImportedSource() {
  if (suppressDetach.value) return;
  importedXodrText.value = '';
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
  return { x: x * view.scale + view.offsetX, y: y * view.scale + view.offsetY };
}

function screenToWorld(x, y) {
  return { x: (x - view.offsetX) / view.scale, y: (y - view.offsetY) / view.scale };
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

function pickRoad(worldPoint) {
  let best = { idx: -1, d: Infinity };
  roads.value.forEach((r, idx) => {
    if (!r.points || r.points.length < 2) return;
    for (let i = 1; i < r.points.length; i += 1) {
      const d = distPointToSeg(worldPoint, r.points[i - 1], r.points[i]);
      if (d < best.d) best = { idx, d };
    }
  });
  return best.d <= 14 / view.scale ? best.idx : -1;
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

function drawRoadSurface(road, selected) {
  if (!road.points || road.points.length < 2) return;
  if (Array.isArray(road.nativeLeftBoundary) && road.nativeLeftBoundary.length > 1 &&
      Array.isArray(road.nativeRightBoundary) && road.nativeRightBoundary.length > 1) {
    drawFilledBand(road.nativeLeftBoundary, road.nativeRightBoundary, selected ? '#6b7280' : '#4b5563');
    drawPolyline(road.nativeLeftBoundary, '#dce4ef', 1.6);
    drawPolyline(road.nativeRightBoundary, '#dce4ef', 1.6);
    (road.nativeLaneBoundaries || []).forEach((lane) => {
      if (lane?.points?.length > 1) drawPolyline(lane.points, '#eef3f9', 1, true);
    });
    drawPolyline(road.points, selected ? '#ffd089' : '#8fd8ff', 1.2, true);
    return;
  }
  const leftBoundary = buildOffsetPath(road, (profile) => profile.leftBoundary);
  const rightBoundary = buildOffsetPath(road, (profile) => profile.rightBoundary);
  drawFilledBand(leftBoundary, rightBoundary, selected ? '#6b7280' : '#4b5563');
  drawPolyline(leftBoundary, '#dce4ef', 1.6);
  drawPolyline(rightBoundary, '#dce4ef', 1.6);
  const centerRef = buildOffsetPath(road, (profile) => profile.laneOffset);
  drawPolyline(centerRef, selected ? '#ffd089' : '#8fd8ff', 1.6, true);
}

function drawMeterGrid() {
  if (!ctx || !canvasEl.value) return;
  const canvas = canvasEl.value;
  const baseStepPx = GRID_BASE_M * view.scale;
  const skip = Math.max(1, Math.ceil(GRID_TARGET_PX / Math.max(0.0001, baseStepPx)));
  const stepM = GRID_BASE_M * skip;
  const majorEvery = 10;
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
    if (xCount > 3000) break;
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
    if (yCount > 3000) break;
    const sy = y * view.scale + view.offsetY;
    const idx = Math.round(y / stepM);
    const isMajor = idx % majorEvery === 0;
    drawLine(isMajor);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(canvas.width, Math.round(sy) + 0.5);
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

function drawLaneDirectionArrows(road) {
  if (!road.points || road.points.length < 2) return;
  const rightCount = Number(road.rightLaneCount || 0);
  const leftCount = Number(road.leftLaneCount || 0);
  const rightPath = rightCount > 0 ? buildOffsetPath(road, (p) => (p.laneOffset + p.rightBoundary) * 0.5) : [];
  const leftPath = leftCount > 0 ? buildOffsetPath(road, (p) => (p.laneOffset + p.leftBoundary) * 0.5) : [];
  const drawSeries = (path, forward, color) => {
    if (!path || path.length < 2) return;
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
    if (!segments.length || total < 1e-6) return;
    const count = Math.max(1, Math.min(24, Math.floor(total / 55)));
    let segIdx = 0;
    for (let k = 1; k <= count; k += 1) {
      const d = (k * total) / (count + 1);
      while (segIdx < segments.length - 1 && d > segments[segIdx].end) segIdx += 1;
      const seg = segments[segIdx];
      const t = Math.max(0, Math.min(1, (d - seg.start) / seg.len));
      const x = seg.a.x + seg.dx * t;
      const y = seg.a.y + seg.dy * t;
      drawArrowAtWorld(x, y, forward ? seg.dx : -seg.dx, forward ? seg.dy : -seg.dy, color);
    }
  };
  drawSeries(rightPath, false, 'rgba(124, 240, 213, 0.92)');
  drawSeries(leftPath, true, 'rgba(255, 194, 124, 0.92)');
}

function drawHandles() {
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
      ctx.fillStyle = 'rgba(238, 181, 98, 0.22)';
      ctx.strokeStyle = 'rgba(255, 221, 155, 0.78)';
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
    }
    (mesh.approaches || []).forEach((a) => {
      if (a?.anchor && a?.boundary) {
        drawPolyline([a.anchor, a.boundary], 'rgba(118, 251, 209, 0.7)', 1.8, true);
      }
    });
    (mesh.internalLaneCurves || []).forEach((curve) => {
      if (curve?.length > 1) {
        drawPolyline(curve, 'rgba(255, 246, 166, 0.65)', 1.1, true);
      }
    });
    if (mesh.center) {
      const c = worldToScreen(mesh.center.x, mesh.center.y);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff4be';
      ctx.fill();
    }
  });
}

function render() {
  if (!ctx || !canvasEl.value) return;
  const canvas = canvasEl.value;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawMeterGrid();
  if (bgImage.value) {
    const p = worldToScreen(0, 0);
    ctx.drawImage(bgImage.value, p.x, p.y, bgImage.value.width * view.scale, bgImage.value.height * view.scale);
  }
  drawJunctionMeshes();
  roads.value.forEach((r, idx) => {
    const sel = idx === selectedRoadIndex.value;
    drawRoadSurface(r, sel);
    drawLaneDirectionArrows(r);
    if (r.points?.length) {
      const p = worldToScreen(r.points[0].x, r.points[0].y);
      ctx.fillStyle = sel ? '#ffc08a' : '#b8ffe9';
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
    view.offsetY = canvasEl.value.height / 2 - prevCenterWorld.y * view.scale;
  }
  render();
}

function fitView() {
  if (!canvasEl.value) return;
  if (bgImage.value) {
    const sx = canvasEl.value.width / bgImage.value.width;
    const sy = canvasEl.value.height / bgImage.value.height;
    view.scale = Math.min(sx, sy);
    view.offsetX = (canvasEl.value.width - bgImage.value.width * view.scale) / 2;
    view.offsetY = (canvasEl.value.height - bgImage.value.height * view.scale) / 2;
  } else if (roads.value.length) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    roads.value.forEach((r) => {
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
      view.offsetY = margin - minY * view.scale + (canvasEl.value.height - margin * 2 - h * view.scale) / 2;
    }
  } else {
    view.scale = 1;
    view.offsetX = 0;
    view.offsetY = 0;
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
    points,
    laneOffsetRecords: [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }],
    nativeLeftBoundary: null,
    nativeRightBoundary: null,
    nativeLaneBoundaries: null,
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
  let hdg = Number(p.hdg);
  if (!Number.isFinite(hdg)) {
    if (atStart) {
      const p1 = pts[1];
      hdg = Math.atan2(p1.y - p.y, p1.x - p.x);
    } else {
      const p0 = pts[pts.length - 2];
      hdg = Math.atan2(p.y - p0.y, p.x - p0.x);
    }
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

function nextJunctionId() {
  let maxId = 0;
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

function laneCenterOffset(laneIdx, laneCount, laneWidth) {
  const n = Math.max(1, Number(laneCount || 1));
  const w = Math.max(0.5, Number(laneWidth || 3.5));
  return (laneIdx - (n + 1) / 2) * w;
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
  const incomingCount = handle.endpoint === 'end' ? leftLaneCount : rightLaneCount;
  const outgoingCount = handle.endpoint === 'end' ? rightLaneCount : leftLaneCount;
  const incomingWidth = handle.endpoint === 'end' ? leftLaneWidth : rightLaneWidth;
  const outgoingWidth = handle.endpoint === 'end' ? rightLaneWidth : leftLaneWidth;
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

function buildConnectorCenterline(fromApproach, toApproach, smoothness) {
  const p0 = fromApproach.boundary;
  const p3 = toApproach.boundary;
  const d0 = normalizeVec(fromApproach.incomingDir || fromApproach.dir);
  const d3 = normalizeVec(toApproach.outgoingDir || vecScale(toApproach.dir, -1));
  const minRadius = Math.max(3, Number(fromApproach.halfWidth || 0) + Number(toApproach.halfWidth || 0) + 1.2);
  return buildBezierWithRadiusGuard(p0, p3, d0, d3, smoothness, minRadius);
}

function buildInternalLaneCurve(fromApproach, toApproach, fromLane, toLane, smoothness) {
  const startOffset = laneCenterOffset(fromLane, fromApproach.incomingCount, fromApproach.incomingWidth);
  const endOffset = laneCenterOffset(toLane, toApproach.outgoingCount, toApproach.outgoingWidth);
  const p0 = vecAdd(fromApproach.boundary, vecScale(fromApproach.incomingNormal || fromApproach.normal, startOffset));
  const p3 = vecAdd(toApproach.boundary, vecScale(toApproach.outgoingNormal || vecScale(toApproach.normal, -1), endOffset));
  const d0 = normalizeVec(fromApproach.incomingDir || fromApproach.dir);
  const d3 = normalizeVec(toApproach.outgoingDir || vecScale(toApproach.dir, -1));
  const minRadius = Math.max(2, Math.max(Math.abs(startOffset), Math.abs(endOffset)) + 0.8);
  return buildBezierWithRadiusGuard(p0, p3, d0, d3, smoothness, minRadius);
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
  return sampleBezier(start, p1, p2, end, Math.max(18, Math.ceil(chord / 1.8)));
}

function extendRoadEndpointToBoundary(road, endpoint, boundary) {
  const pts = road?.points || [];
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
  road.length = polylineLength(pts);
  clearNativeGeometry(road);
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
    const boundary = vecAdd(a.pose, vecScale(a.dir, advance));
    const normal = perpLeft(a.dir);
    const leftEdge = vecAdd(boundary, vecScale(normal, a.halfWidth));
    const rightEdge = vecAdd(boundary, vecScale(normal, -a.halfWidth));
    const radial = normalizeVec(vecSub(boundary, center), vecScale(a.dir, -1));
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

  detachImportedSource();

  refined.forEach((a) => {
    extendRoadEndpointToBoundary(a.road, a.handle.endpoint, a.boundary);
  });

  const generatedRoadIds = [];
  const laneCurves = [];
  const connectorMeta = [];
  for (const from of refined) {
    if (from.incomingCount <= 0) continue;
    for (const to of refined) {
      if (to === from || to.outgoingCount <= 0) continue;
      const centerline = buildConnectorCenterline(from, to, junctionForm.smoothness);
      if (!centerline || centerline.length < 2) continue;

      const transitionType = from.incomingCount === to.outgoingCount
        ? 'match'
        : (from.incomingCount > to.outgoingCount ? 'merge' : 'split');
      const laneMap = [];
      const fromCount = Math.max(1, Number(from.incomingCount || 1));
      const toCount = Math.max(1, Number(to.outgoingCount || 1));
      for (let lane = 1; lane <= fromCount; lane += 1) {
        const mapped = mapLaneIndex(lane, fromCount, toCount);
        laneMap.push({ from: lane, to: mapped });
      }

      const connectorRoad = defaultRoadFromPoints(centerline);
      connectorRoad.points = centerline;
      connectorRoad.length = polylineLength(centerline);
      connectorRoad.leftLaneCount = fromCount;
      connectorRoad.rightLaneCount = 0;
      connectorRoad.leftLaneWidth = Math.max(0.5, Number(from.incomingWidth || 3.5));
      connectorRoad.rightLaneWidth = connectorRoad.leftLaneWidth;
      connectorRoad.laneWidth = connectorRoad.leftLaneWidth;
      connectorRoad.centerType = 'none';
      connectorRoad.predecessorType = 'road';
      connectorRoad.predecessorId = String(from.road.id);
      connectorRoad.successorType = 'road';
      connectorRoad.successorId = String(to.road.id);
      connectorRoad.connectorMeta = {
        kind: 'junction_internal',
        fromRoadId: String(from.road.id),
        toRoadId: String(to.road.id),
        fromEndpoint: from.handle.endpoint,
        toEndpoint: to.handle.endpoint
      };
      connectorRoad.transitionMeta = {
        type: transitionType,
        fromLaneCount: fromCount,
        toLaneCount: toCount,
        fromLaneWidth: Number(from.incomingWidth || 3.5),
        toLaneWidth: Number(to.outgoingWidth || 3.5),
        transitionLength: Math.max(3, Number(junctionForm.transitionLength || 16)),
        laneMap
      };
      connectorRoad.internalLaneCurves = laneMap.map((m) => buildInternalLaneCurve(
        from,
        to,
        m.from,
        m.to,
        junctionForm.smoothness
      ));
      connectorRoad.internalLaneCurves.forEach((curve) => laneCurves.push(curve));
      clearNativeGeometry(connectorRoad);
      roads.value.push(connectorRoad);
      generatedRoadIds.push(String(connectorRoad.id));
      connectorMeta.push({
        roadId: String(connectorRoad.id),
        fromRoadId: String(from.road.id),
        toRoadId: String(to.road.id),
        transition: transitionType
      });
    }
  }

  const meshId = nextJunctionId();
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

  if (generatedRoadIds.length) {
    const lastAddedRoadId = generatedRoadIds[generatedRoadIds.length - 1];
    selectedRoadIndex.value = roads.value.findIndex((r) => String(r.id) === lastAddedRoadId);
  } else {
    selectedRoadIndex.value = refined.length ? refined[0].handle.roadIdx : -1;
  }
  render();
  return { ok: true };
}

function generateJunctionFromDraft() {
  const handles = (junctionDraft.value.handles || []).slice();
  const result = generateJunctionFromHandles(handles);
  junctionDraft.value = { handles: [] };
  if (!result.ok) {
    window.alert(result.reason || '自动路口生成失败。');
    render();
  }
}

function buildBezierBetweenHandles(firstHandle, secondHandle, smoothness) {
  const firstRoad = roads.value[firstHandle.roadIdx];
  const secondRoad = roads.value[secondHandle.roadIdx];
  if (!firstRoad || !secondRoad) return null;
  const p0 = roadPoseAtEnd(firstRoad, firstHandle.endpoint === 'start');
  const p3 = roadPoseAtEnd(secondRoad, secondHandle.endpoint === 'start');
  if (!p0 || !p3) return null;
  const overlap = clamp(Number(connectForm.overlap || 0), 0, 6);
  const d0 = endpointDirection(firstHandle.endpoint, p0.hdg);
  const d3 = endpointFinalDirection(secondHandle.endpoint, p3.hdg);

  // Geometry-level stitching: move curve ends slightly into both roads to create physical overlap.
  const start = { x: p0.x - d0.x * overlap, y: p0.y - d0.y * overlap };
  const end = { x: p3.x + d3.x * overlap, y: p3.y + d3.y * overlap };
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const handleLen = Math.max(4, Math.min(120, dist * Number(smoothness || 0.35)));
  const p1 = { x: start.x + d0.x * handleLen, y: start.y + d0.y * handleLen };
  const p2 = { x: end.x - d3.x * handleLen, y: end.y - d3.y * handleLen };
  const points = sampleBezier(start, p1, p2, end, Math.max(16, Math.ceil(dist / 2)));
  return { points, firstRoad, secondRoad, overlap };
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
  const { points, firstRoad, secondRoad, overlap } = built;
  const newRoad = defaultRoadFromPoints(points);
  const profile = blendedConnectorProfile(firstRoad, firstHandle.endpoint, secondRoad, secondHandle.endpoint);
  newRoad.points = points;
  newRoad.length = polylineLength(points);
  newRoad.leftLaneCount = profile.leftLaneCount;
  newRoad.rightLaneCount = profile.rightLaneCount;
  newRoad.leftLaneWidth = profile.leftLaneWidth;
  newRoad.rightLaneWidth = profile.rightLaneWidth;
  newRoad.laneWidth = (profile.leftLaneWidth + profile.rightLaneWidth) * 0.5;
  newRoad.connectorMeta = {
    fromRoadId: String(firstRoad.id),
    toRoadId: String(secondRoad.id),
    fromEndpoint: firstHandle.endpoint,
    toEndpoint: secondHandle.endpoint,
    smoothness: Number(smoothness || 0.35),
    overlap: Number(overlap || 0)
  };
  newRoad.predecessorType = 'road';
  newRoad.predecessorId = String(firstRoad.id);
  newRoad.successorType = 'road';
  newRoad.successorId = String(secondRoad.id);
  if (firstHandle.endpoint === 'end') {
    firstRoad.successorType = 'road';
    firstRoad.successorId = newRoad.id;
  } else {
    firstRoad.predecessorType = 'road';
    firstRoad.predecessorId = newRoad.id;
  }
  if (secondHandle.endpoint === 'start') {
    secondRoad.predecessorType = 'road';
    secondRoad.predecessorId = newRoad.id;
  } else {
    secondRoad.successorType = 'road';
    secondRoad.successorId = newRoad.id;
  }
  clearNativeGeometry(firstRoad);
  clearNativeGeometry(secondRoad);
  detachImportedSource();
  roads.value.push(newRoad);
  selectedRoadIndex.value = roads.value.length - 1;
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
  const built = buildBezierBetweenHandles(firstHandle, secondHandle, connectForm.smoothness);
  if (!built) return;
  const profile = blendedConnectorProfile(roads.value[fromIdx], firstHandle.endpoint, roads.value[toIdx], secondHandle.endpoint);
  road.points = built.points;
  road.length = polylineLength(road.points);
  road.leftLaneCount = profile.leftLaneCount;
  road.rightLaneCount = profile.rightLaneCount;
  road.leftLaneWidth = profile.leftLaneWidth;
  road.rightLaneWidth = profile.rightLaneWidth;
  road.laneWidth = (profile.leftLaneWidth + profile.rightLaneWidth) * 0.5;
  road.connectorMeta.smoothness = Number(connectForm.smoothness);
  road.connectorMeta.overlap = Number(connectForm.overlap || 0);
  clearNativeGeometry(road);
  detachImportedSource();
  render();
}

function getAllHandles() {
  const handles = [];
  roads.value.forEach((road, roadIdx) => {
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
  return bestDist <= 10 ? best : null;
}

function completeExtend(toPoint) {
  if (!extendDraft.value) return;
  const fromRoad = roads.value[extendDraft.value.roadIdx];
  if (!fromRoad) { extendDraft.value = null; return; }
  const d = Math.hypot(toPoint.x - extendDraft.value.anchor.x, toPoint.y - extendDraft.value.anchor.y);
  if (d < 0.5) { extendDraft.value = null; return; }
  const newRoad = defaultRoadFromPoints([
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
  detachImportedSource();
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
  render();
}

function selectRoad(i) {
  selectedRoadIndex.value = i;
  render();
}

function finishRoad() {
  if (drawingPoints.value.length < 2) return;
  detachImportedSource();
  roads.value.push(defaultRoadFromPoints(drawingPoints.value.slice()));
  selectedRoadIndex.value = roads.value.length - 1;
  drawingPoints.value = [];
  render();
}

function undoPoint() {
  if (!drawingPoints.value.length) return;
  drawingPoints.value.pop();
  render();
}

function deleteRoad() {
  if (selectedRoadIndex.value < 0) return;
  detachImportedSource();
  const removedRoad = roads.value[selectedRoadIndex.value];
  roads.value.splice(selectedRoadIndex.value, 1);
  if (removedRoad) {
    const removedId = String(removedRoad.id);
    junctionMeshes.value = (junctionMeshes.value || []).filter((mesh) => {
      const relatedApproach = (mesh.approaches || []).some((a) => String(a.roadId) === removedId);
      const relatedConnector = (mesh.connectorMeta || []).some((c) => (
        String(c.roadId) === removedId
        || String(c.fromRoadId) === removedId
        || String(c.toRoadId) === removedId
      ));
      return !relatedApproach && !relatedConnector;
    });
  }
  selectedRoadIndex.value = -1;
  render();
}

function applySelectedRoad() {
  const r = selectedRoad.value;
  if (!r) return;
  detachImportedSource();
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
  if (Number.isFinite(targetLength) && targetLength > 0 && Math.abs(targetLength - r.length) > 1e-6) {
    const current = polylineLength(r.points);
    if (current > 1e-6) {
      const ratio = targetLength / current;
      const out = [{ x: r.points[0].x, y: r.points[0].y }];
      for (let i = 1; i < r.points.length; i += 1) {
        const p0 = r.points[i - 1];
        const p1 = r.points[i];
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const d = Math.hypot(dx, dy);
        const prev = out[out.length - 1];
        out.push(d > 1e-6 ? { x: prev.x + (dx / d) * d * ratio, y: prev.y + (dy / d) * d * ratio } : { ...prev });
      }
      r.points = out;
    }
  }
  clearNativeGeometry(r);
  r.length = polylineLength(r.points);
  render();
}

function currentSpec() {
  return {
    header: {
      name: headerForm.name,
      vendor: headerForm.vendor,
      north: Number(headerForm.north),
      south: Number(headerForm.south),
      east: Number(headerForm.east),
      west: Number(headerForm.west)
    },
    roads: roads.value.map((r) => ({ ...r, length: polylineLength(r.points) }))
  };
}

async function runValidate() {
  try {
    const payload = currentSpec();
    if (importedXodrText.value) {
      payload.xodr = importedXodrText.value;
    }
    const result = await postJson('/api/validate', payload);
    validateDialog.visible = true;
    validateDialog.ok = Boolean(result.ok);
    validateDialog.errorCount = Number(result.errorCount || 0);
    validateDialog.warningCount = Number(result.warningCount || 0);
    validateDialog.errors = Array.isArray(result.errors) ? result.errors : [];
    validateDialog.warnings = Array.isArray(result.warnings) ? result.warnings : [];
    validateDialog.routeSummary = result.routeSummary || null;
    if (validateDialog.routeSummary) {
      validateDialog.routeOk = Number(validateDialog.routeSummary.fail || 0) === 0;
      validateDialog.routeStatus = validateDialog.routeOk ? 'PASS' : 'FAIL';
    } else {
      validateDialog.routeOk = false;
      validateDialog.routeStatus = 'NO_SUMMARY';
    }
  } catch (err) {
    validateDialog.visible = true;
    validateDialog.ok = false;
    validateDialog.errorCount = 1;
    validateDialog.warningCount = 0;
    validateDialog.errors = [String(err.message || err)];
    validateDialog.warnings = [];
    validateDialog.routeOk = false;
    validateDialog.routeStatus = 'ERROR';
    validateDialog.routeSummary = null;
  }
}

async function generateXodr() {
  const { xodr } = await postJson('/api/generate-xodr', currentSpec());
  lastXodr.value = xodr;
}

function downloadXodr() {
  if (!lastXodr.value) return;
  const blob = new Blob([lastXodr.value], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${headerForm.name || 'map'}.xodr`;
  a.click();
  URL.revokeObjectURL(url);
}

function applyHeaderFromXodr(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parserErr = doc.querySelector('parsererror');
  if (parserErr) throw new Error('XODR/XML 解析失败，请检查文件格式');
  const root = doc.querySelector('OpenDRIVE');
  if (!root) throw new Error('不是有效的 OpenDRIVE 文件');
  const header = root.querySelector(':scope > header');
  if (!header) return;
  headerForm.name = header.getAttribute('name') || headerForm.name;
  headerForm.vendor = header.getAttribute('vendor') || headerForm.vendor;
  if (header.hasAttribute('north')) headerForm.north = Number(header.getAttribute('north'));
  if (header.hasAttribute('south')) headerForm.south = Number(header.getAttribute('south'));
  if (header.hasAttribute('east')) headerForm.east = Number(header.getAttribute('east'));
  if (header.hasAttribute('west')) headerForm.west = Number(header.getAttribute('west'));
}

function applyNativeRoads(parsedRoads) {
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
    successorType: r.successorType || 'road',
    successorId: String(r.successorId ?? r.id ?? idx + 1),
    laneOffsetRecords: [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }],
    points: Array.isArray(r.points) ? r.points.map((p) => ({ x: Number(p.x), y: Number(p.y), s: Number(p.s), hdg: Number(p.hdg) })) : [],
    nativeLeftBoundary: Array.isArray(r.nativeLeftBoundary) ? r.nativeLeftBoundary.map((p) => ({ x: Number(p.x), y: Number(p.y) })) : [],
    nativeRightBoundary: Array.isArray(r.nativeRightBoundary) ? r.nativeRightBoundary.map((p) => ({ x: Number(p.x), y: Number(p.y) })) : [],
    nativeLaneBoundaries: Array.isArray(r.nativeLaneBoundaries) ? r.nativeLaneBoundaries : [],
    length: Number.isFinite(Number(r.length)) ? Number(r.length) : polylineLength(r.points || [])
  }));
  roads.value = normalized;
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

function pickBgFile() {
  bgFileInput.value?.click();
}

async function importXodr() {
  const file = xodrFileInput.value?.files?.[0];
  if (!file) return;
  const text = await file.text();
  suppressDetach.value = true;
  applyHeaderFromXodr(text);
  const payload = await postJson('/api/import-xodr-native', { xml: text, eps: 0.2 });
  applyNativeRoads(payload.roads || []);
  suppressDetach.value = false;
  importedXodrText.value = text;
  xodrFileInput.value.value = '';
}

async function uploadBackground() {
  const file = bgFileInput.value?.files?.[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
  await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      bgImage.value = img;
      fitView();
      resolve();
    };
    img.onerror = () => reject(new Error('底图加载失败'));
    img.src = dataUrl;
  });
  bgFileInput.value.value = '';
}

function handleCanvasClick(e) {
  if (!canvasEl.value || view.panning || view.spaceDown) return;
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
    if (junctionDraft.value.handles.length === 4) {
      generateJunctionFromDraft();
      return;
    }
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
  if (!view.spaceDown) return;
  view.panning = true;
  view.panStartX = e.clientX;
  view.panStartY = e.clientY;
  view.baseOffsetX = view.offsetX;
  view.baseOffsetY = view.offsetY;
}

function handleMouseMove(e) {
  if (view.panning) {
    view.offsetX = view.baseOffsetX + (e.clientX - view.panStartX);
    view.offsetY = view.baseOffsetY + (e.clientY - view.panStartY);
    render();
  }
  if (!canvasEl.value || !extendDraft.value || mode.value !== 'extend') return;
  const rect = canvasEl.value.getBoundingClientRect();
  extendDraft.value.hover = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  render();
}

function handleMouseUp() {
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
});

onBeforeUnmount(() => {
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
});
</script>
