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
        <button type="button" @click="runValidate">质检</button>
        <button type="button" @click="generateAndDownloadXodr">生成并下载XODR</button>
        <button type="button" @click="pickXodrFile">导入XODR</button>
        <button type="button" @click="pickBgFile">上传底图</button>
        <button type="button" @click="openRoadColorDialog">道路颜色</button>
      </div>
    </header>

    <aside class="sidebar left-rail">
      <h1>OpenDRIVE 编辑器</h1>
      <p class="desc">左侧道路区</p>
      <section class="panel road-panel">
        <h2>Roads ({{ roads.length }})</h2>
        <div ref="roadListEl" class="road-list road-list-fill" @scroll="handleRoadListScroll">
          <template v-if="useVirtualRoadList">
            <div class="road-list-spacer" :style="{ height: `${roadListTopPadding}px` }"></div>
            <button
              v-for="row in virtualRoadRows"
              :key="`vroad-${row.road?.id}-${row.index}`"
              type="button"
              class="road-item road-item-compact"
              :class="{ selected: row.index === selectedRoadIndex }"
              @click="selectRoad(row.index)"
            >
              <div>Road {{ row.road.id }} | len={{ formatNum(row.road.length, 2) }} | pts={{ row.road.points.length }}</div>
              <div class="meta">pred={{ row.road.predecessorId || '-' }} | succ={{ row.road.successorId || '-' }}</div>
            </button>
            <div class="road-list-spacer" :style="{ height: `${roadListBottomPadding}px` }"></div>
            <div class="meta road-list-hint">大地图模式：已启用虚拟列表，仅渲染可见道路项。</div>
          </template>
          <template v-else>
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
          </template>
          <div v-if="!roads.length" class="empty">暂无道路</div>
        </div>
      </section>
      <input ref="xodrFileInput" type="file" accept=".xodr,.xml,text/xml,application/xml" class="hidden-file" @change="importXodr" />
      <input ref="mapYamlFileInput" type="file" accept=".yaml,.yml,text/yaml,text/plain" class="hidden-file" @change="importMapYaml" />
      <input ref="bgFileInput" type="file" accept="image/*,.pgm,.yaml,.yml,text/yaml,text/plain" multiple class="hidden-file" @change="uploadBackground" />
    </aside>

    <section class="viewer center-stage">
      <div ref="canvasWrap" class="canvas-wrap">
        <canvas ref="canvasEl" class="canvas-el" width="1280" height="720" />
      </div>
      <div class="stage-tip">
        左键交互，滚轮缩放，空格+拖动平移，选择模式可拖当前道路控制点
        | 鼠标: x={{ formatNum(mouseWorld.x, 2) }}, y={{ formatYUp(mouseWorld.y) }}
        | 原点: x={{ formatNum(bgGeo.originX, 2) }}, y={{ formatYUp(bgGeo.originY) }}, yaw={{ formatNum(bgGeo.yaw, 3) }}
      </div>
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
        <h2>绘制优化</h2>
        <div class="grid2">
          <label style="grid-column: 1 / -1;">道路平滑度
            <input v-model.number="drawForm.smoothing" type="range" min="0.1" max="0.95" step="0.01" />
          </label>
          <label>数值<input v-model.number="drawForm.smoothing" type="number" min="0.1" max="0.95" step="0.01" /></label>
          <label style="display:flex; align-items:center; gap:8px; padding-top:22px;">
            <input v-model="drawForm.autoJunction" type="checkbox" />
            相交自动生成路口
          </label>
          <label style="display:flex; align-items:center; gap:8px; padding-top:22px;">
            <input v-model="renderOptions.showRoadLabels" type="checkbox" />
            显示道路编号
          </label>
          <div style="grid-column: 1 / -1;" class="meta">绘制完成后会把折线平滑成可导出的曲线，并在简单十字相交场景下自动拆分道路后生成 junction。</div>
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

      <section v-if="mode === 'junction'" class="panel">
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

    <div v-if="roadColorDialog.visible" class="dialog-mask" @click.self="closeRoadColorDialog">
      <div class="dialog" style="max-width: 420px;">
        <div class="dialog-head">
          <h3>道路颜色设置</h3>
          <button type="button" class="dialog-close" @click="closeRoadColorDialog">关闭</button>
        </div>
        <div class="grid2" style="margin-top: 8px;">
          <label>全部道路颜色
            <input v-model="roadColorDialog.allColor" type="color" />
          </label>
          <label>Junction道路颜色
            <input v-model="roadColorDialog.junctionColor" type="color" />
          </label>
          <div style="grid-column: 1 / -1;" class="meta">应用后：普通道路和 junction 道路会按两种颜色渲染。</div>
          <div class="row" style="grid-column: 1 / -1; margin-top: 6px;">
            <button type="button" @click="applyRoadColorDialog">应用</button>
            <button type="button" @click="resetRoadColorDialogDefaults">恢复默认</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="validateDialog.visible" class="dialog-mask" @click.self="validateDialog.visible = false">
      <div class="dialog">
        <div class="dialog-head">
          <h3>质检结果</h3>
          <button type="button" class="dialog-close" @click="validateDialog.visible = false">关闭</button>
        </div>
        <div v-if="validateDialog.checking" class="quality-progress-wrap">
          <p class="dialog-status">正在进行质检，请稍候...</p>
          <div class="quality-progress-bar">
            <div class="quality-progress-fill" :style="{ width: `${validateDialog.progress}%` }"></div>
          </div>
          <p class="quality-progress-text">{{ validateDialog.progressText }}（{{ Math.floor(validateDialog.progress) }}%）</p>
        </div>
        <div v-else>
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
            <details style="margin-top: 12px;">
              <summary>route_test 过程日志</summary>
              <pre style="white-space: pre-wrap; margin-top: 8px;">{{ validateDialog.routeOutput || '(无 route_test 输出)' }}</pre>
            </details>
            <details style="margin-top: 8px;">
              <summary>mapcheck 过程日志</summary>
              <pre style="white-space: pre-wrap; margin-top: 8px;">{{ validateDialog.mapcheckOutput || '(无 mapcheck 输出)' }}</pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup>
import { useAppLogic } from './appLogic.js';

const {
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
  renderOptions,
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
  junctionDraft,
  junctionMeshes,
  generateJunctionFromDraft,
  clearJunctionDraft,
  roadForm,
  applySelectedRoad,
  validateDialog
} = useAppLogic();
</script>
