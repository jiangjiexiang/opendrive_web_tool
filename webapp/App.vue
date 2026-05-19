<template>
  <main class="layout layout-immersive" :class="{ 'left-collapsed': leftPanelCollapsed, 'right-collapsed': rightPanelCollapsed }">
    <section class="viewer center-stage">
      <div class="stage-shell">
        <div ref="canvasWrap" class="canvas-wrap" :class="{ 'is-hidden-viewer': viewerMode !== '2d' }">
          <canvas ref="canvasEl" class="canvas-el" width="1280" height="720" />
        </div>
        <ThreeRoadViewer
          v-if="viewerMode === '3d'"
          class="viewer-3d"
          :roads="roads"
          :point-cloud="pointCloud"
          :point-cloud-size="pointCloudForm.pointSize"
          :selected-road-id="selectedRoad ? String(selectedRoad.id) : ''"
          @select-road="selectRoadById"
        />
      </div>
      <div class="hud-metrics stage-metrics">
        <span>坐标 x={{ formatNum(mouseWorld.x, 2) }}</span>
        <span>坐标 y={{ formatYUp(mouseWorld.y) }}</span>
        <span>yaw={{ formatNum(bgGeo.yaw, 3) }}</span>
        <span v-if="measureStats.pointCount">测距 点={{ measureStats.pointCount }} | 段={{ measureStats.segmentCount }} | 总长={{ formatNum(measureStats.total, 3) }}m</span>
        <span v-if="viewerMode === '2d' && hoverRoadCoord.roadId">Road {{ hoverRoadCoord.roadId }} | Lane {{ hoverRoadCoord.laneId || '-' }} | s={{ formatNum(hoverRoadCoord.s, 2) }} | t={{ formatNum(hoverRoadCoord.t, 2) }}</span>
      </div>
      <div class="stage-tip">
        左键交互，滚轮缩放，空格+拖动平移；测距：左键加点，撤销/Backspace 删上一点，左侧列表可查看并清除
        | 原点: x={{ formatNum(bgGeo.originX, 2) }}, y={{ formatYUp(bgGeo.originY) }}, yaw={{ formatNum(bgGeo.yaw, 3) }}
      </div>
    </section>

    <header class="topbar overlay-panel">
      <div class="toolbar-strip">
        <section class="tool-cluster">
          <span class="cluster-label">模式</span>
          <div class="toolbar-group">
            <button type="button" class="mode-btn" :class="{ active: viewerMode === '2d' }" @click="setViewerMode('2d')">2D</button>
            <button type="button" class="mode-btn" :class="{ active: viewerMode === '3d' }" @click="setViewerMode('3d')">3D</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'draw' }" @click="requestDrawMode">绘制</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'select' }" @click="setMode('select')">选择</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'measure' }" @click="setMode('measure')">测距</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'connect' }" @click="setMode('connect')">弯道</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'extend' }" @click="setMode('extend')">延伸</button>
            <button type="button" class="mode-btn" :class="{ active: mode === 'junction' }" @click="setMode('junction')">路口</button>
          </div>
        </section>
        <section class="tool-cluster">
          <span class="cluster-label">编辑</span>
          <div class="toolbar-group">
            <button type="button" @click="finishRoad">完成</button>
            <button type="button" @click="undoPoint">撤销</button>
            <button type="button" @click="deleteRoad">删除</button>
            <button type="button" @click="fitView">适配</button>
          </div>
        </section>
        <section class="tool-cluster">
          <span class="cluster-label">XODR</span>
          <div class="toolbar-group">
            <button type="button" @click="runValidate">质检</button>
            <button type="button" @click="generateAndDownloadXodr">生成</button>
            <button type="button" :disabled="importStatus.loading" @click="pickXodrFile">
              {{ importStatus.loading ? '导入中…' : '导入' }}
            </button>
            <button type="button" :disabled="!selectedRoad" @click="roadCodeDialogVisible = true">代码</button>
          </div>
        </section>
        <section class="tool-cluster">
          <span class="cluster-label">底图</span>
          <div class="toolbar-group">
            <button type="button" @click="pickBgFile">上传</button>
            <button type="button" :disabled="!bgImage || !roads.length" @click="downloadBackgroundOverlayImage">叠加</button>
          </div>
        </section>
        <section class="tool-cluster">
          <span class="cluster-label">点云</span>
          <div class="toolbar-group">
            <button type="button" @click="pickPointCloudFile">导入</button>
            <button type="button" :disabled="!pointCloud" @click="clearPointCloud">清除</button>
          </div>
        </section>
        <section class="tool-cluster">
          <span class="cluster-label">显示</span>
          <div class="toolbar-group">
            <button type="button" @click="openRoadColorDialog">设置</button>
          </div>
        </section>
      </div>
    </header>

    <div class="rail-dock rail-dock-left overlay-panel">
      <div class="rail-dock-head">
        <h2 class="rail-title">列表</h2>
        <div class="panel-heading-actions">
          <span class="panel-badge">{{ roads.length }}</span>
          <button type="button" class="rail-toggle-btn" :aria-expanded="!leftPanelCollapsed" @click="toggleLeftPanel">
            {{ leftPanelCollapsed ? '展开' : '收起' }}
          </button>
        </div>
      </div>
    </div>

    <aside class="sidebar left-rail overlay-panel overlay-left" :aria-hidden="leftPanelCollapsed">
      <div class="side-panel-body">
      <nav class="side-panel-tabs" role="tablist" aria-label="列表分类">
        <button
          v-for="tab in leftPanelTabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="side-panel-tab"
          :class="{ active: leftPanelTab === tab.id }"
          :aria-selected="leftPanelTab === tab.id"
          @click="leftPanelTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
      <div class="side-panel-content">
      <div v-show="leftPanelTab === 'measure'" class="side-panel-tab-pane">
      <section class="panel measure-panel">
        <div class="panel-heading measure-panel-heading">
          <h2>测距信息</h2>
          <button
            v-if="measureStats.pointCount"
            type="button"
            class="measure-clear-btn"
            @click="clearMeasure"
          >
            清除
          </button>
        </div>
        <template v-if="measureStats.pointCount">
          <div class="measure-summary">
            <span>点 {{ measureStats.pointCount }}</span>
            <span>段 {{ measureStats.segmentCount }}</span>
            <span>总长 {{ formatNum(measureStats.total, 3) }} m</span>
          </div>
          <div class="measure-segments">
            <div
              v-for="(len, idx) in measureStats.segmentLengths"
              :key="`seg-${idx}`"
              class="measure-segment-row"
            >
              段 {{ idx + 1 }}：{{ formatNum(len, 3) }} m
            </div>
          </div>
        </template>
        <p v-else class="measure-empty">测距模式下在画布左键点击添加测量点</p>
      </section>

      </div>

      <div v-show="leftPanelTab === 'roads'" class="side-panel-tab-pane">
      <section class="panel road-panel">
        <div class="road-search-wrap">
          <input v-model="roadSearchQuery" type="search" placeholder="搜索 road id" class="road-search-input" />
        </div>
        <div v-if="importStatus.message" class="import-status" :class="importStatus.type">
          {{ importStatus.message }}
        </div>
        <div v-if="pointCloudStatus.message" class="import-status" :class="pointCloudStatus.type">
          {{ pointCloudStatus.message }}
          <div v-if="pointCloudStatus.type === 'loading' || pointCloudStatus.progress > 0" class="point-cloud-progress">
            <div class="point-cloud-progress-track">
              <div class="point-cloud-progress-fill" :style="{ width: `${formatPercent(pointCloudStatus.progress)}%` }"></div>
            </div>
            <span>{{ formatPercent(pointCloudStatus.progress) }}%</span>
          </div>
        </div>
        <div
          ref="roadListEl"
          class="road-list road-list-fill"
          @scroll="handleRoadListScroll"
          @mouseleave="clearHoveredRoadIndex"
        >
          <template v-if="useVirtualRoadList">
            <div class="road-list-spacer" :style="{ height: `${roadListTopPadding}px` }"></div>
            <div
              v-for="row in filteredVirtualRoadRows"
              :key="`vroad-${row.road?.id}-${row.index}`"
              class="road-item road-item-compact"
              :class="{
                selected: row.index === selectedRoadIndex,
                hovered: row.index === hoveredRoadIndex && row.index !== selectedRoadIndex,
                muted: !isRoadVisible(row.road)
              }"
              @mouseenter="setHoveredRoadIndex(row.index)"
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
          <template v-else-if="useRoadTreeList">
            <div v-for="row in filteredRoadTreeRows" :key="`${row.road.id}-${row.index}`" class="road-tree-item">
              <div
                class="road-item"
                :class="{
                  selected: row.index === selectedRoadIndex,
                  hovered: row.index === hoveredRoadIndex && row.index !== selectedRoadIndex,
                  muted: !isRoadVisible(row.road)
                }"
                @mouseenter="setHoveredRoadIndex(row.index)"
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
                  :class="{
                    selected: child.index === selectedRoadIndex,
                    hovered: child.index === hoveredRoadIndex && child.index !== selectedRoadIndex,
                    muted: !isRoadVisible(child.road)
                  }"
                  @mouseenter="setHoveredRoadIndex(child.index)"
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
      </div>

      <div v-show="leftPanelTab === 'junction'" class="side-panel-tab-pane">
      <section class="panel junction-list-panel">
        <div class="junction-list">
          <div
            v-for="mesh in junctionMeshes"
            :key="`junction-${mesh.id}`"
            class="road-item junction-item"
            :class="{
              selected: String(mesh.id) === String(selectedJunctionId),
              expanded: isJunctionListExpanded(mesh.id)
            }"
          >
            <div class="junction-item-header">
              <button
                type="button"
                class="junction-fold-btn"
                :aria-expanded="isJunctionListExpanded(mesh.id)"
                :title="isJunctionListExpanded(mesh.id) ? '收起' : '展开'"
                @click.stop="toggleJunctionListExpanded(mesh.id)"
              >
                {{ isJunctionListExpanded(mesh.id) ? '▾' : '▸' }}
              </button>
              <button type="button" class="road-item-select junction-item-select" @click="selectJunction(mesh.id)">
                <div class="junction-item-title">{{ mesh.name || `Junction ${mesh.id}` }}</div>
                <div class="meta junction-item-summary">
                  {{ getJunctionLinkRows(mesh).length }} 条
                  <template v-if="!isJunctionListExpanded(mesh.id) && getJunctionLinkRows(mesh).length">
                    · 点 ▸ 展开
                  </template>
                </div>
              </button>
            </div>
            <ul
              v-if="isJunctionListExpanded(mesh.id) && getJunctionLinkRows(mesh).length"
              class="junction-links junction-links-scroll"
            >
              <li
                v-for="row in getJunctionLinkRows(mesh)"
                :key="row.key"
                class="junction-link-row junction-link-row-compact"
              >
                <span class="junction-link-compact-main">
                  <span class="junction-link-label">入</span>
                  <button type="button" class="junction-link-btn" @click.stop="selectRoadById(row.incomingRoad)">
                    R{{ row.incomingRoad }}
                  </button>
                  <span class="junction-link-at">@{{ row.contactPoint }}</span>
                  <span class="junction-link-arrow">→</span>
                  <span class="junction-link-label">连</span>
                  <button type="button" class="junction-link-btn" @click.stop="selectRoadById(row.connectingRoad)">
                    R{{ row.connectingRoad }}
                  </button>
                </span>
                <span v-if="row.laneText" class="junction-link-lanes-inline">{{ row.laneText }}</span>
              </li>
            </ul>
            <div
              v-else-if="isJunctionListExpanded(mesh.id)"
              class="junction-link-empty meta"
            >
              无 connection
            </div>
          </div>
          <div v-if="!junctionMeshes.length" class="empty">暂无路口</div>
        </div>
      </section>
      </div>
      </div>
      </div>

      <input ref="xodrFileInput" type="file" accept=".xodr,.xml,text/xml,application/xml" class="hidden-file" @change="importXodr" />
      <input ref="mapYamlFileInput" type="file" accept=".yaml,.yml,text/yaml,text/plain" class="hidden-file" @change="importMapYaml" />
      <input ref="bgFileInput" type="file" accept="image/*,.pgm,.yaml,.yml,text/yaml,text/plain" multiple class="hidden-file" @change="uploadBackground" />
      <input ref="pointCloudFileInput" type="file" accept=".pcd,.xyz,.txt,.csv,text/plain,text/csv" class="hidden-file" @change="importPointCloud" />
    </aside>

    <div class="rail-dock rail-dock-right overlay-panel">
      <div class="rail-dock-head">
        <h2 class="rail-title">属性面板</h2>
        <button type="button" class="rail-toggle-btn" :aria-expanded="!rightPanelCollapsed" @click="toggleRightPanel">
          {{ rightPanelCollapsed ? '展开' : '收起' }}
        </button>
      </div>
    </div>

    <aside class="sidebar right-rail overlay-panel overlay-right" :aria-hidden="rightPanelCollapsed">
      <div class="side-panel-body">
      <nav class="side-panel-tabs" role="tablist" aria-label="属性面板分类">
        <button
          v-for="tab in rightPanelTabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="side-panel-tab"
          :class="{ active: rightPanelTab === tab.id }"
          :aria-selected="rightPanelTab === tab.id"
          @click="rightPanelTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>

      <div class="side-panel-content">
      <div v-show="rightPanelTab === 'road'" class="side-panel-tab-pane">
      <section v-if="mode === 'draw'" class="panel">
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
          <template v-if="selectedRoad && String(selectedRoad.junction || '-1') !== '-1'">
            <div style="grid-column: 1 / -1;" class="meta">车道连接（行驶方向：来向 pred → 去向 succ）</div>
            <template v-for="laneLink in roadForm.laneLinks" :key="laneLink.laneId">
              <label>lane {{ laneLink.laneId }} pred<input v-model="laneLink.predecessor" /></label>
              <label>lane {{ laneLink.laneId }} succ<input v-model="laneLink.successor" /></label>
            </template>
          </template>
          <div class="row" style="grid-column: 1 / -1; margin-top: 8px;">
            <button type="button" @click="applySelectedRoad">应用道路属性</button>
          </div>
          <div style="grid-column: 1 / -1; margin-top: 8px;" class="meta lane-section-label">车道列表</div>
          <div style="grid-column: 1 / -1;" class="lane-list">
            <template v-if="selectedRoadLaneIds.length">
              <div v-for="lid in selectedRoadLaneIds" :key="lid" class="lane-row">
                <span class="lane-id-badge" :class="Number(lid) > 0 ? 'left-lane' : 'right-lane'">
                  {{ Number(lid) > 0 ? '左' : '右' }} {{ lid }}
                </span>
                <span class="lane-side-hint">{{ Number(lid) > 0 ? '左侧' : '右侧' }}第 {{ Math.abs(Number(lid)) }} 条</span>
                <button type="button" class="lane-del-btn" title="删除此车道" @click="deleteLaneFromRoad(lid)">×</button>
              </div>
            </template>
            <div v-else class="empty" style="padding: 4px 0;">暂无车道数据</div>
          </div>
        </div>
        <div v-else class="empty">请先在列表或画布中选择道路</div>
      </section>

      <section v-if="mode === 'draw'" class="panel">
        <h2>绘制设置</h2>
        <div class="grid2">
          <label style="grid-column: 1 / -1;">弯道弧度（平滑度越高弧度越大）
            <input v-model.number="drawForm.smoothing" type="range" min="0.1" max="0.95" step="0.01" />
          </label>
          <label>数值<input v-model.number="drawForm.smoothing" type="number" min="0.1" max="0.95" step="0.01" /></label>
          <label style="display:flex; align-items:center; gap:8px; padding-top:22px;">
            <input v-model="drawForm.autoJunction" type="checkbox" />
            相交自动生成路口
          </label>
          <div style="grid-column: 1 / -1;" class="meta">钢笔式绘制：点击蓝色锚点定端点与起/止方向；拖橙色菱形只改中间弧度（line+arc+line，起止方向不变）。拖回弦中点附近为直线。移动端点请拖蓝色锚点。Enter 或「完成」结束。</div>
        </div>
      </section>

      <section v-if="selectedRoad?.connectorMeta" class="panel">
        <h2>弯道弧度</h2>
        <div class="grid2">
          <label style="grid-column: 1 / -1;">弧度（越大弯道越"鼓"）
            <input v-model.number="connectForm.smoothness" type="range" min="0.1" max="0.8" step="0.01" />
          </label>
          <label>数值<input v-model.number="connectForm.smoothness" type="number" min="0.1" max="0.8" step="0.01" /></label>
          <label>端点重叠(m)<input v-model.number="connectForm.overlap" type="number" min="0" max="6" step="0.1" /></label>
          <div v-if="connectorRebuildPending" class="meta" style="grid-column: 1 / -1; color: #f0c060;">正在应用…</div>
        </div>
      </section>
      </div>

      <div v-show="rightPanelTab === 'pointcloud'" class="side-panel-tab-pane">
      <section class="panel">
        <h2>点云</h2>
        <div class="grid2">
          <label style="grid-column: 1 / -1;">点大小
            <input v-model.number="pointCloudForm.pointSize" type="range" min="0.02" max="1.5" step="0.01" />
          </label>
          <div class="meta">点大小: {{ formatNum(pointCloudForm.pointSize, 2) }}</div>
          <label style="grid-column: 1 / -1;">保留比例 {{ formatNum(pointCloudForm.sampleRatio, 0) }}%
            <input v-model.number="pointCloudForm.sampleRatio" type="range" min="1" max="100" step="1" />
          </label>
          <label style="grid-column: 1 / -1;">最小高度 z {{ formatNum(pointCloudForm.minZ, 1) }}
            <input v-model.number="pointCloudForm.minZ" type="range" min="-50" max="50" step="0.1" />
          </label>
          <label style="grid-column: 1 / -1;">最大高度 z {{ formatNum(pointCloudForm.maxZ, 1) }}
            <input v-model.number="pointCloudForm.maxZ" type="range" min="-50" max="50" step="0.1" />
          </label>
          <div style="grid-column: 1 / -1;" class="meta">
            当前: {{ pointCloud ? `${formatNum(pointCloud.count, 0)} / ${formatNum(pointCloud.sourceCount || pointCloud.count, 0)} 点` : '未加载' }}
          </div>
          <div style="grid-column: 1 / -1;" class="meta">
            滑块会实时更新3D点云显示。
          </div>
          <div class="row" style="grid-column: 1 / -1; margin-top: 4px;">
            <button type="button" @click="pickPointCloudFile">导入点云</button>
            <button type="button" :disabled="!pointCloud" @click="clearPointCloud">清除点云</button>
          </div>
        </div>
      </section>
      </div>

      <div v-show="rightPanelTab === 'connect'" class="side-panel-tab-pane">
      <section class="panel">
        <h2>弯道连接</h2>
        <div class="grid2">
          <label style="grid-column: 1 / -1;">弧度（越大越"鼓"）
            <input v-model.number="connectForm.smoothness" type="range" min="0.1" max="0.8" step="0.01" />
          </label>
          <label>数值<input v-model.number="connectForm.smoothness" type="number" min="0.1" max="0.8" step="0.01" /></label>
          <label>端点重叠(m)<input v-model.number="connectForm.overlap" type="number" min="0" max="6" step="0.1" /></label>
          <div class="meta">点击两个端点小球自动生成弯道</div>
          <div style="grid-column: 1 / -1;" class="meta">第一点: {{ getConnectHandleText(connectDraft.first) }}</div>
          <div style="grid-column: 1 / -1;" class="meta">第二点: {{ getConnectHandleText(connectDraft.second) }}</div>
          <div class="row" style="grid-column: 1 / -1; margin-top: 4px;">
            <button type="button" @click="clearConnectDraft">清空端点选择</button>
          </div>
        </div>
      </section>
      </div>

      <div v-show="rightPanelTab === 'junction'" class="side-panel-tab-pane">
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
      </div>
      </div>
      </div>

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

    <div v-if="drawKindDialog.visible" class="dialog-mask" @click.self="cancelDrawKindDialog">
      <div class="dialog" style="max-width: 400px;">
        <div class="dialog-head">
          <h3>选择绘制类型</h3>
          <button type="button" class="dialog-close" @click="cancelDrawKindDialog">关闭</button>
        </div>
        <p class="meta" style="margin: 12px 0 16px;">请选择本次绘制方式，之后可在侧栏「重新选择」中切换。</p>
        <div class="row" style="gap: 10px; flex-wrap: wrap;">
          <button type="button" class="mode-btn" style="flex: 1; min-width: 120px;" @click="confirmDrawKind('line')">直线</button>
          <button type="button" class="mode-btn" style="flex: 1; min-width: 120px;" @click="confirmDrawKind('curve')">曲线</button>
        </div>
        <p class="meta" style="margin-top: 14px;">直线：相邻锚点连线。曲线：可拖橙色菱形调节弧度。</p>
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
import { useAppShell } from './useAppShell.js';
import ThreeRoadViewer from './ThreeRoadViewer.vue';

const app = useAppLogic();
const {
  mode,
  setMode,
  requestDrawMode,
  confirmDrawKind,
  cancelDrawKindDialog,
  drawKindDialog,
  finishRoad,
  undoPoint,
  clearMeasure,
  deleteRoad,
  fitView,
  runValidate,
  generateAndDownloadXodr,
  downloadBackgroundOverlayImage,
  pickXodrFile,
  pickBgFile,
  pickPointCloudFile,
  importStatus,
  pointCloud,
  bgImage,
  pointCloudStatus,
  pointCloudForm,
  clearPointCloud,
  openRoadColorDialog,
  roads,
  selectedRoadIndex,
  hoveredRoadIndex,
  setHoveredRoadIndex,
  clearHoveredRoadIndex,
  formatNum,
  formatPercent,
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
  useRoadTreeList,
  virtualRoadRows,
  roadListTopPadding,
  roadListBottomPadding,
  xodrFileInput,
  mapYamlFileInput,
  bgFileInput,
  pointCloudFileInput,
  importXodr,
  importMapYaml,
  uploadBackground,
  importPointCloud,
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
  junctionSpecs,
  selectedJunctionId,
  selectJunction,
  getJunctionLinkRows,
  isJunctionListExpanded,
  toggleJunctionListExpanded,
  centerViewOnJunction,
  generateJunctionFromDraft,
  clearJunctionDraft,
  roadForm,
  applySelectedRoad,
  deleteLaneFromRoad,
  validateDialog
} = app;

const {
  roadCodeDialogVisible,
  roadCodeEditorText,
  leftPanelCollapsed,
  rightPanelCollapsed,
  viewerMode,
  connectorRebuildPending,
  leftPanelTab,
  leftPanelTabs,
  rightPanelTab,
  rightPanelTabs,
  applyRoadCode,
  toggleLeftPanel,
  toggleRightPanel,
  setViewerMode,
  selectRoadById
} = useAppShell(app);
</script>
