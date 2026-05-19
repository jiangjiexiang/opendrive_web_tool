import { computed, reactive, ref, shallowRef } from 'vue';
import { createQualityDialogState } from '../qualityCheck.js';
import { createRoadColorState } from '../roadColors.js';

/** 创建编辑器共享状态（host 对象的基础字段） */
export function createEditorState() {
  const canvasEl = ref(null);
  const canvasWrap = ref(null);
  const roadListEl = ref(null);
  const xodrFileInput = ref(null);
  const mapYamlFileInput = ref(null);
  const bgFileInput = ref(null);
  const pointCloudFileInput = ref(null);

  const roads = ref([]);
  const selectedRoadIndex = ref(-1);
  const hoveredRoadIndex = ref(-1);
  const mode = ref('select');
  const leftPanelCollapsed = ref(true);
  const rightPanelCollapsed = ref(true);
  const drawingPoints = ref([]);
  /** 绘制模式：每段锚点之间的弧度控制点（长度 = drawingPoints.length - 1） */
  const drawSegmentControls = ref([]);
  /** 每段固定起/止切线方向（弧度），拖动菱形时不改 */
  const drawSegmentHeadings = ref([]);
  const drawControlDrag = ref(null);
  const measurePoints = ref([]);
  const measureHoverPoint = ref(null);
  const connectDraft = ref({ first: null, second: null });
  const extendDraft = ref(null);
  const junctionDraft = ref({ handles: [] });
  const junctionMeshes = ref([]);
  const junctionSpecs = ref([]);
  const selectedJunctionId = ref('');
  /** 路口列表展开状态（默认收起，仅记录展开的 id） */
  const junctionExpandedById = ref({});
  const bgImage = ref(null);
  const rawPointCloud = shallowRef(null);
  const pointCloud = shallowRef(null);
  const pointCloudStatus = reactive({
    message: '',
    type: '',
    progress: 0
  });
  const pointCloudForm = reactive({
    pointSize: 0.18,
    sampleRatio: 30,
    minZ: -10,
    maxZ: 10
  });
  const mouseWorld = reactive({ x: 0, y: 0 });
  const hoverRoadCoord = reactive({
    roadId: '',
    laneId: '',
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
  const importStatus = reactive({
    loading: false,
    message: '',
    type: ''
  });
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
    successorId: '',
    laneLinks: []
  });

  const connectForm = reactive({
    smoothness: 0.35,
    overlap: 0
  });

  const drawForm = reactive({
    smoothing: 0.55,
    autoJunction: false,
    /** 'line' | 'curve'，进入绘制前在弹窗中选择 */
    drawKind: null
  });

  const drawKindDialog = reactive({
    visible: false
  });

  const junctionForm = reactive({
    edgePadding: 6,
    smoothness: 0.34,
    transitionLength: 16,
    debugEndpointLines: false
  });

  const junctionUi = reactive({
    generating: false,
    status: '',
    lastError: '',
    lastGeneratedCount: 0,
    lastExpectedCount: 0
  });

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

  let ctx = null;
  let resizeObserver = null;
  let roadListResizeObserver = null;
  let renderFrame = 0;
  let pointCloudRefreshTimer = 0;
  let activeRenderCanvas = null;

  const roadListScrollTop = ref(0);
  const roadListViewportHeight = ref(320);
  const collapsedRoadGroups = ref({});
  const roadSearchQuery = ref('');

  return {
    canvasEl,
    canvasWrap,
    roadListEl,
    xodrFileInput,
    mapYamlFileInput,
    bgFileInput,
    pointCloudFileInput,
    roads,
    selectedRoadIndex,
    hoveredRoadIndex,
    mode,
    leftPanelCollapsed,
    rightPanelCollapsed,
    drawingPoints,
    drawSegmentControls,
    drawSegmentHeadings,
    drawControlDrag,
    measurePoints,
    measureHoverPoint,
    connectDraft,
    extendDraft,
    junctionDraft,
    junctionMeshes,
    junctionSpecs,
    selectedJunctionId,
    junctionExpandedById,
    bgImage,
    rawPointCloud,
    pointCloud,
    pointCloudStatus,
    pointCloudForm,
    mouseWorld,
    hoverRoadCoord,
    bgGeo,
    lastXodr,
    importedXodrText,
    importedHeaderXml,
    rawRoadXmlById,
    rawJunctionXmlById,
    rawOpenDriveExtras,
    dirtyRoadIds,
    dirtyJunctionIds,
    headerDirty,
    importStatus,
    suppressDetach,
    endpointDrag,
    suppressNextClick,
    headerForm,
    roadForm,
    connectForm,
    drawForm,
    drawKindDialog,
    junctionForm,
    junctionUi,
    validateDialog,
    roadColorDialog,
    roadColorConfig,
    view,
    ctx,
    resizeObserver,
    roadListResizeObserver,
    renderFrame,
    pointCloudRefreshTimer,
    activeRenderCanvas,
    roadListScrollTop,
    roadListViewportHeight,
    collapsedRoadGroups,
    roadSearchQuery
  };
}
