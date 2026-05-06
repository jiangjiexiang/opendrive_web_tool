<template>
  <main class="layout">
    <header class="topbar">
      <div class="toolbar-strip">
        <section class="tool-cluster">
          <span class="cluster-label">模式</span>
          <div class="toolbar-group">
            <button type="button" class="mode-btn" :class="{ active: mode === 'draw' }" @click="setMode('draw')">绘制</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'select' }" @click="setMode('select')">选择</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'measure' }" @click="setMode('measure')">测距</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'connect' }" @click="setMode('connect')">生成弯道</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'extend' }" @click="setMode('extend')">延伸</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'junction' }" @click="setMode('junction')">自动生成junction</button>
          </div>
        </section>
        <section class="tool-cluster">
          <span class="cluster-label">编辑</span>
          <div class="toolbar-group">
            <button type="button" @click="finishRoad">完成道路</button>
            <button type="button" @click="undoPoint">撤销点</button>
            <button type="button" @click="deleteRoad">删除选中</button>
            <button type="button" @click="fitView">适配视图</button>
          </div>
        </section>
        <section class="tool-cluster">
          <span class="cluster-label">数据</span>
          <div class="toolbar-group">
            <button type="button" @click="runValidate">质检</button>
            <button type="button" @click="generateAndDownloadXodr">生成并下载XODR</button>
            <button type="button" :disabled="importStatus.loading" @click="pickXodrFile">
              {{ importStatus.loading ? '导入中...' : '导入XODR' }}
            </button>
            <button type="button" @click="pickBgFile">上传底图</button>
            <button type="button" :disabled="!selectedRoad" @click="roadCodeDialogVisible = true">查看OpenDRIVE代码</button>
            <button type="button" @click="openRoadColorDialog">显示设置</button>
          </div>
        </section>
      </div>
      <div class="topbar-status">
        <span class="status-chip">
          <span class="status-label">模式</span>
          <strong>{{ mode }}</strong>
        </span>
        <span class="status-chip">
          <span class="status-label">道路</span>
          <strong>{{ roads.length }}</strong>
        </span>
        <span class="status-chip">
          <span class="status-label">选中</span>
          <strong>{{ selectedRoad ? selectedRoad.id : '-' }}</strong>
        </span>
      </div>
    </header>

    <aside class="sidebar left-rail">
      <div class="rail-header">
        <p class="eyebrow">Road Index</p>
        <h2 class="rail-title">道路列表</h2>
      </div>
      <section class="panel road-panel">
        <div class="panel-heading">
          <h2>Roads</h2>
          <span class="panel-badge">{{ roads.length }}</span>
        </div>
        <div class="road-search-wrap">
          <input v-model="roadSearchQuery" type="search" placeholder="搜索 road id" class="road-search-input" />
        </div>
        <div v-if="importStatus.message" class="import-status" :class="importStatus.type">
          {{ importStatus.message }}
        </div>
        <div ref="roadListEl" class="road-list road-list-fill" @scroll="handleRoadListScroll">
          <template v-if="useVirtualRoadList">
            <div class="road-list-spacer" :style="{ height: `${roadListTopPadding}px` }"></div>
            <div
              v-for="row in filteredVirtualRoadRows"
              :key="`vroad-${row.road?.id}-${row.index}`"
              class="road-item road-item-compact"
              :class="{ selected: row.index === selectedRoadIndex, muted: !isRoadVisible(row.road) }"
            >
              <div class="road-item-main">
                <button type="button" class="road-item-select" @click="selectRoad(row.index, { center: true })">
                  <div>Road {{ row.road.id }} | len={{ formatNum(row.road.length, 2) }}</div>
                  <div class="meta">pred={{ row.road.predecessorId || '-' }} | succ={{ row.road.successorId || '-' }}</div>
                </button>
                <button type="button" class="road-ctrl-btn" @click.stop="toggleRoadVisibility(row.index)">
                  {{ isRoadVisible(row.road) ? '显示' : '隐藏' }}
                </button>
              </div>
            </div>
            <div class="road-list-spacer" :style="{ height: `${roadListBottomPadding}px` }"></div>
            <div class="meta road-list-hint">大地图模式：已启用虚拟列表，仅渲染可见道路项。</div>
          </template>
          <template v-else>
            <div v-for="row in filteredRoadTreeRows" :key="`${row.road.id}-${row.index}`" class="road-tree-item">
              <div
                class="road-item"
                :class="{ selected: row.index === selectedRoadIndex, muted: !isRoadVisible(row.road) }"
              >
                <button type="button" class="road-item-select" @click="selectRoad(row.index, { center: true })">
                  <div>Road {{ row.road.id }} | len={{ formatNum(row.road.length, 2) }}</div>
                  <div class="meta">pred={{ row.road.predecessorId || '-' }} | succ={{ row.road.successorId || '-' }}</div>
                </button>
                <div class="road-item-actions">
                  <button
                    v-if="hasChildRoadEntries(row.road.id)"
                    type="button"
                    class="road-ctrl-btn"
                    @click.stop="toggleRoadChildren(row.road.id)"
                  >
                    {{ isRoadChildrenExpanded(row.road.id) ? '收起' : `子路(${getChildRoadEntries(row.road.id).length})` }}
                  </button>
                  <button type="button" class="road-ctrl-btn" @click.stop="toggleRoadVisibility(row.index)">
                    {{ isRoadVisible(row.road) ? '显示' : '隐藏' }}
                  </button>
                </div>
              </div>
              <div
                v-if="hasChildRoadEntries(row.road.id) && isRoadChildrenExpanded(row.road.id)"
                class="child-road-list"
              >
                <div
                  v-for="child in getChildRoadEntries(row.road.id)"
                  :key="`child-${row.road.id}-${child.index}`"
                  class="child-road-item"
                  :class="{ selected: child.index === selectedRoadIndex, muted: !isRoadVisible(child.road) }"
                >
                  <button type="button" class="road-item-select" @click="selectRoad(child.index, { center: true })">
                    <div>Road {{ child.road.id }} | len={{ formatNum(child.road.length, 2) }}</div>
                  </button>
                  <button type="button" class="road-ctrl-btn" @click.stop="toggleRoadVisibility(child.index)">
                    {{ isRoadVisible(child.road) ? '显示' : '隐藏' }}
                  </button>
                </div>
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
      <div class="stage-shell">
        <div class="stage-head">
          <div>
            <p class="eyebrow">Workspace</p>
            <h2>道路画布</h2>
          </div>
          <div class="stage-metrics">
            <span>坐标 x={{ formatNum(mouseWorld.x, 2) }}</span>
            <span>坐标 y={{ formatYUp(mouseWorld.y) }}</span>
            <span>yaw={{ formatNum(bgGeo.yaw, 3) }}</span>
            <span v-if="measureStats.pointCount">测距 点={{ measureStats.pointCount }} | 段={{ measureStats.segmentCount }} | 总长={{ formatNum(measureStats.total, 3) }}m</span>
            <span v-if="hoverRoadCoord.roadId">Road {{ hoverRoadCoord.roadId }} | Lane {{ hoverRoadCoord.laneId || '-' }} | s={{ formatNum(hoverRoadCoord.s, 2) }} | t={{ formatNum(hoverRoadCoord.t, 2) }}</span>
          </div>
        </div>
        <div ref="canvasWrap" class="canvas-wrap">
          <canvas ref="canvasEl" class="canvas-el" width="1280" height="720" />
        </div>
      </div>
      <div class="stage-tip">
        左键交互，滚轮缩放，空格+拖动平移，选择模式可拖当前道路控制点，测距模式可多点测量(米)
        | 原点: x={{ formatNum(bgGeo.originX, 2) }}, y={{ formatYUp(bgGeo.originY) }}, yaw={{ formatNum(bgGeo.yaw, 3) }}
      </div>
    </section>

    <aside class="sidebar right-rail">
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
        <h2>选中道路属性</h2>
        <div v-if="selectedRoad" class="grid2">
          <label>road id<input v-model="roadForm.id" /></label>
          <label>junction<input v-model="roadForm.junction" /></label>
          <label>left lanes<input v-model.number="roadForm.leftLaneCount" type="number" min="0" /></label>
          <label>right lanes<input v-model.number="roadForm.rightLaneCount" type="number" min="0" /></label>
          <label style="grid-column: 1 / -1;">lane id<input :value="selectedRoadLaneIds.length ? selectedRoadLaneIds.join(', ') : '-'" readonly /></label>
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
          <div style="grid-column: 1 / -1;" class="meta">lane links</div>
          <template v-for="laneLink in roadForm.laneLinks" :key="laneLink.laneId">
            <label>lane {{ laneLink.laneId }} pred<input v-model="laneLink.predecessor" /></label>
            <label>lane {{ laneLink.laneId }} succ<input v-model="laneLink.successor" /></label>
          </template>
          <div class="row" style="grid-column: 1 / -1; margin-top: 8px;">
            <button type="button" @click="applySelectedRoad">应用道路属性</button>
          </div>
        </div>
        <div v-else class="empty">请先在列表或画布中选择道路</div>
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
          <div style="grid-column: 1 / -1;" class="meta">开启后：完成道路时会先做平滑，再尝试在简单十字相交场景自动拆分并生成路口；关闭后只做道路完成，不触发自动路口。</div>
        </div>
      </section>

      <section v-if="mode === 'connect'" class="panel">
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
            <button v-if="selectedRoad?.connectorMeta" type="button" @click="rebuildSelectedConnector">重建选中弯道</button>
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
          <div style="grid-column: 1 / -1;" class="meta">当前选择端点: {{ junctionDraft.handles.length }}/4</div>
          <div v-if="junctionUi.status" style="grid-column: 1 / -1;" class="meta ok-text">{{ junctionUi.status }}</div>
          <div v-if="junctionUi.lastError" style="grid-column: 1 / -1;" class="meta err-text">{{ junctionUi.lastError }}</div>
          <div class="row" style="grid-column: 1 / -1; margin-top: 4px;">
            <button type="button" :disabled="junctionDraft.handles.length < 3 || junctionUi.generating" @click="generateJunctionFromDraft">
              {{ junctionUi.generating ? '生成中...' : '生成路口' }}
            </button>
            <button type="button" @click="clearJunctionDraft">清空路口端点选择</button>
          </div>
        </div>
      </section>

    </aside>

    <div v-if="roadCodeDialogVisible" class="dialog-mask" @click.self="roadCodeDialogVisible = false">
      <div class="dialog">
        <div class="dialog-head">
          <h3>Road {{ selectedRoad ? selectedRoad.id : '' }} OpenDRIVE</h3>
          <button type="button" class="dialog-close" @click="roadCodeDialogVisible = false">关闭</button>
        </div>
        <div class="dialog-raw road-code-panel" style="margin-top: 10px;">
          <textarea v-model="roadCodeEditorText" class="road-code-editor" spellcheck="false"></textarea>
        </div>
        <div class="row" style="margin-top: 10px;">
          <button type="button" @click="applyRoadCode">应用代码</button>
          <button type="button" @click="roadCodeEditorText = selectedRoadCode">重置</button>
        </div>
      </div>
    </div>

    <div v-if="roadColorDialog.visible" class="dialog-mask" @click.self="closeRoadColorDialog">
      <div class="dialog" style="max-width: 420px;">
        <div class="dialog-head">
          <h3>显示设置</h3>
          <button type="button" class="dialog-close" @click="closeRoadColorDialog">关闭</button>
        </div>
        <div class="grid2 settings-grid" style="margin-top: 8px;">
          <label class="color-setting">全部道路颜色
            <input v-model="roadColorDialog.allColor" type="color" />
          </label>
          <label class="color-setting">Junction道路颜色
            <input v-model="roadColorDialog.junctionColor" type="color" />
          </label>
          <label class="color-setting color-setting-wide">Junction区域辅助线颜色
            <input v-model="roadColorDialog.junctionGuideColor" type="color" />
          </label>
          <label class="color-setting">道路编号颜色
            <input v-model="roadColorDialog.roadLabelColor" type="color" />
          </label>
          <label class="toggle-setting">
            <input v-model="roadColorDialog.showRoadLabels" type="checkbox" />
            显示道路编号
          </label>
          <div class="meta settings-note">这里统一控制道路、路口、路口辅助线以及道路编号的显示效果。</div>
          <div class="row settings-actions">
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
            route rules:
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
              <summary>route rules 过程日志</summary>
              <pre style="white-space: pre-wrap; margin-top: 8px;">{{ validateDialog.routeOutput || '(无 route rules 输出)' }}</pre>
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
  importStatus,
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
  roadSearchQuery,
  filteredVirtualRoadRows,
  filteredRoadTreeRows,
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
  measureStats,
  connectForm,
  connectDraft,
  getConnectHandleText,
  clearConnectDraft,
  selectedRoad,
  selectedRoadLaneIds,
  selectedRoadCode,
  applySelectedRoadCode,
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
} = useAppLogic();

import { ref, watch } from 'vue';
const roadCodeDialogVisible = ref(false);
const roadCodeEditorText = ref('');

watch(selectedRoadCode, (value) => {
  roadCodeEditorText.value = value || '';
}, { immediate: true });

function applyRoadCode() {
  try {
    applySelectedRoadCode(roadCodeEditorText.value);
    roadCodeDialogVisible.value = false;
  } catch (error) {
    window.alert(String(error?.message || error));
  }
}
</script>
