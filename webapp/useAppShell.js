import { computed, nextTick, ref, unref, watch } from 'vue';

/** 顶栏/侧栏布局、2D/3D 切换、道路代码对话框等 UI 状态 */
export function useAppShell(app) {
  const {
    mode,
    roads,
    selectedRoad,
    selectedRoadCode,
    applySelectedRoadCode,
    rebuildSelectedConnector,
    connectForm,
    junctionMeshes,
    junctionSpecs,
    fitView,
    selectRoad
  } = app;

  const roadCodeDialogVisible = ref(false);
  const roadCodeEditorText = ref('');
  const leftPanelCollapsed = app.leftPanelCollapsed ?? ref(true);
  const rightPanelCollapsed = app.rightPanelCollapsed ?? ref(true);
  const viewerMode = ref('2d');
  const connectorRebuildPending = ref(false);
  const leftPanelTab = ref('roads');
  const leftPanelTabs = [
    { id: 'roads', label: '道路' },
    { id: 'measure', label: '测距' },
    { id: 'junction', label: '路口' }
  ];

  const rightPanelTab = ref('road');

  const rightPanelTabs = computed(() => {
    const tabs = [
      { id: 'road', label: '道路' },
      { id: 'pointcloud', label: '点云' }
    ];
    if (mode.value === 'connect') tabs.push({ id: 'connect', label: '连接' });
    if (mode.value === 'junction') tabs.push({ id: 'junction', label: '路口' });
    return tabs;
  });

  watch(mode, (next) => {
    if (next === 'measure') leftPanelTab.value = 'measure';
    if (next === 'connect') rightPanelTab.value = 'connect';
    else if (next === 'junction') rightPanelTab.value = 'junction';
    else if (!rightPanelTabs.value.some((tab) => tab.id === rightPanelTab.value)) {
      rightPanelTab.value = 'road';
    }
  });

  watch(rightPanelTabs, (tabs) => {
    if (!tabs.some((tab) => tab.id === rightPanelTab.value)) {
      rightPanelTab.value = tabs[0]?.id || 'road';
    }
  });

  let connectorRebuildTimer = null;
  watch(
    () => [connectForm.smoothness, connectForm.overlap],
    () => {
      if (!selectedRoad.value?.connectorMeta) return;
      connectorRebuildPending.value = true;
      clearTimeout(connectorRebuildTimer);
      connectorRebuildTimer = setTimeout(() => {
        rebuildSelectedConnector();
        connectorRebuildPending.value = false;
      }, 1000);
    }
  );

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

  async function refreshCanvasAfterLayoutChange() {
    await nextTick();
    window.setTimeout(() => {
      fitView();
    }, 280);
  }

  async function toggleLeftPanel() {
    leftPanelCollapsed.value = !unref(leftPanelCollapsed);
    await refreshCanvasAfterLayoutChange();
  }

  async function toggleRightPanel() {
    rightPanelCollapsed.value = !unref(rightPanelCollapsed);
    await refreshCanvasAfterLayoutChange();
  }

  async function openSidePanels() {
    let changed = false;
    if (unref(leftPanelCollapsed)) {
      leftPanelCollapsed.value = false;
      changed = true;
    }
    if (unref(rightPanelCollapsed)) {
      rightPanelCollapsed.value = false;
      changed = true;
    }
    if (changed) await refreshCanvasAfterLayoutChange();
  }

  async function setViewerMode(nextMode) {
    viewerMode.value = nextMode === '3d' ? '3d' : '2d';
    if (viewerMode.value === '2d') {
      await refreshCanvasAfterLayoutChange();
    }
  }

  function selectRoadById(roadId) {
    const index = roads.value.findIndex((road) => String(road?.id ?? '') === String(roadId));
    if (index >= 0) selectRoad(index);
  }

  return {
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
    openSidePanels,
    setViewerMode,
    selectRoadById
  };
}
