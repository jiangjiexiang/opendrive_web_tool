import { onBeforeUnmount, onMounted } from 'vue';
import * as constants from './constants.js';
import { formatNum, formatPercent, formatYUp } from './formatters.js';
import { createEditorState } from './editorState.js';
import { installImportApi } from './importApi.js';
import { installRoadList } from './roadlist.js';
import { installRoadForm } from './roadForm.js';
import { installRoadListUi } from './roadListUi.js';
import { installMeasure } from './measure.js';
import { installCanvas } from './canvas.js';
import { installRoadCore } from './roadCore.js';
import { installRoadActions } from './roadActions.js';
import { installXodrIO } from './xodrIO.js';
import { installCanvasInput } from './canvasInput.js';

export function useAppLogic() {
  const host = {
    ...createEditorState(),
    ...constants,
    render: () => {}
  };

  installImportApi(host);
  installRoadList(host);
  installRoadForm(host);
  installRoadListUi(host);
  installMeasure(host);
  installCanvas(host);
  installRoadCore(host);
  installRoadActions(host);
  installXodrIO(host);
  installCanvasInput(host);

  onMounted(() => {
    host.ctx = host.canvasEl.value?.getContext('2d');
    host.resizeCanvas(false);
    host.fitView();
    if (host.canvasEl.value) {
      host.canvasEl.value.addEventListener('click', host.handleCanvasClick);
      host.canvasEl.value.addEventListener('wheel', host.handleWheel, { passive: false });
      host.canvasEl.value.addEventListener('mousedown', host.handleMouseDown);
    }
    window.addEventListener('mousemove', host.handleMouseMove);
    window.addEventListener('mouseup', host.handleMouseUp);
    window.addEventListener('keydown', host.handleKeyDown);
    window.addEventListener('keyup', host.handleKeyUp);
    if (host.canvasWrap.value) {
      host.resizeObserver = new ResizeObserver(() => host.resizeCanvas(true));
      host.resizeObserver.observe(host.canvasWrap.value);
    }
    host.syncRoadListViewport();
    if (host.roadListEl.value) {
      host.roadListResizeObserver = new ResizeObserver(() => host.syncRoadListViewport());
      host.roadListResizeObserver.observe(host.roadListEl.value);
    }
  });

  onBeforeUnmount(() => {
    if (host.renderFrame) {
      cancelAnimationFrame(host.renderFrame);
      host.renderFrame = 0;
    }
    if (host.pointCloudRefreshTimer) {
      window.clearTimeout(host.pointCloudRefreshTimer);
      host.pointCloudRefreshTimer = 0;
    }
    if (host.canvasEl.value) {
      host.canvasEl.value.removeEventListener('click', host.handleCanvasClick);
      host.canvasEl.value.removeEventListener('wheel', host.handleWheel);
      host.canvasEl.value.removeEventListener('mousedown', host.handleMouseDown);
    }
    window.removeEventListener('mousemove', host.handleMouseMove);
    window.removeEventListener('mouseup', host.handleMouseUp);
    window.removeEventListener('keydown', host.handleKeyDown);
    window.removeEventListener('keyup', host.handleKeyUp);
    if (host.resizeObserver) host.resizeObserver.disconnect();
    if (host.roadListResizeObserver) host.roadListResizeObserver.disconnect();
  });

  return {
    mode: host.mode,
    leftPanelCollapsed: host.leftPanelCollapsed,
    rightPanelCollapsed: host.rightPanelCollapsed,
    setMode: host.setMode,
    requestDrawMode: host.requestDrawMode,
    confirmDrawKind: host.confirmDrawKind,
    cancelDrawKindDialog: host.cancelDrawKindDialog,
    drawKindDialog: host.drawKindDialog,
    finishRoad: host.finishRoad,
    undoPoint: host.undoPoint,
    clearMeasure: host.clearMeasure,
    deleteRoad: host.deleteRoad,
    fitView: host.fitView,
    runValidate: host.runValidate,
    generateAndDownloadXodr: host.generateAndDownloadXodr,
    downloadBackgroundOverlayImage: host.downloadBackgroundOverlayImage,
    pickXodrFile: host.pickXodrFile,
    pickBgFile: host.pickBgFile,
    pickPointCloudFile: host.pickPointCloudFile,
    importStatus: host.importStatus,
    pointCloud: host.pointCloud,
    pointCloudStatus: host.pointCloudStatus,
    pointCloudForm: host.pointCloudForm,
    clearPointCloud: host.clearPointCloud,
    bgImage: host.bgImage,
    openRoadColorDialog: host.openRoadColorDialog,
    roads: host.roads,
    selectedRoadIndex: host.selectedRoadIndex,
    hoveredRoadIndex: host.hoveredRoadIndex,
    setHoveredRoadIndex: host.setHoveredRoadIndex,
    clearHoveredRoadIndex: host.clearHoveredRoadIndex,
    formatNum,
    formatPercent,
    formatYUp,
    getChildRoadEntries: host.getChildRoadEntries,
    hasChildRoadEntries: host.hasChildRoadEntries,
    isRoadChildrenExpanded: host.isRoadChildrenExpanded,
    toggleRoadChildren: host.toggleRoadChildren,
    isRoadVisible: host.isRoadVisible,
    toggleRoadVisibility: host.toggleRoadVisibility,
    roadTreeRows: host.roadTreeRows,
    roadSearchQuery: host.roadSearchQuery,
    filteredVirtualRoadRows: host.filteredVirtualRoadRows,
    filteredRoadTreeRows: host.filteredRoadTreeRows,
    selectRoad: host.selectRoad,
    roadListEl: host.roadListEl,
    handleRoadListScroll: host.handleRoadListScroll,
    useVirtualRoadList: host.useVirtualRoadList,
    useRoadTreeList: host.useRoadTreeList,
    virtualRoadRows: host.virtualRoadRows,
    roadListTopPadding: host.roadListTopPadding,
    roadListBottomPadding: host.roadListBottomPadding,
    xodrFileInput: host.xodrFileInput,
    mapYamlFileInput: host.mapYamlFileInput,
    bgFileInput: host.bgFileInput,
    pointCloudFileInput: host.pointCloudFileInput,
    importXodr: host.importXodr,
    importMapYaml: host.importMapYaml,
    uploadBackground: host.uploadBackground,
    importPointCloud: host.importPointCloud,
    canvasWrap: host.canvasWrap,
    canvasEl: host.canvasEl,
    mouseWorld: host.mouseWorld,
    bgGeo: host.bgGeo,
    hoverRoadCoord: host.hoverRoadCoord,
    roadColorDialog: host.roadColorDialog,
    closeRoadColorDialog: host.closeRoadColorDialog,
    applyRoadColorDialog: host.applyRoadColorDialog,
    resetRoadColorDialogDefaults: host.resetRoadColorDialogDefaults,
    headerForm: host.headerForm,
    drawForm: host.drawForm,
    measureStats: host.measureStats,
    connectForm: host.connectForm,
    connectDraft: host.connectDraft,
    getConnectHandleText: host.getConnectHandleText,
    clearConnectDraft: host.clearConnectDraft,
    selectedRoad: host.selectedRoad,
    selectedRoadLaneIds: host.selectedRoadLaneIds,
    selectedRoadCode: host.selectedRoadCode,
    rebuildSelectedConnector: host.rebuildSelectedConnector,
    junctionForm: host.junctionForm,
    junctionUi: host.junctionUi,
    junctionDraft: host.junctionDraft,
    junctionMeshes: host.junctionMeshes,
    junctionSpecs: host.junctionSpecs,
    selectedJunctionId: host.selectedJunctionId,
    selectJunction: host.selectJunction,
    getJunctionLinkRows: host.getJunctionLinkRows,
    isJunctionListExpanded: host.isJunctionListExpanded,
    toggleJunctionListExpanded: host.toggleJunctionListExpanded,
    centerViewOnJunction: host.centerViewOnJunction,
    generateJunctionFromDraft: host.generateJunctionFromDraft,
    clearJunctionDraft: host.clearJunctionDraft,
    roadForm: host.roadForm,
    applySelectedRoad: host.applySelectedRoad,
    deleteLaneFromRoad: host.deleteLaneFromRoad,
    applySelectedRoadCode: host.applySelectedRoadCode,
    validateDialog: host.validateDialog
  };
}
