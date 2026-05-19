import {
  openRoadColorDialog as openRoadColorDialogAction,
  closeRoadColorDialog as closeRoadColorDialogAction,
  applyRoadColorDialog as applyRoadColorDialogAction,
  resetRoadColorDialogDefaults as resetRoadColorDialogDefaultsAction
} from '../roadColors.js';
export function installCanvasInput(host) {
function handleCanvasClick(e) {
  if (!host.canvasEl.value || host.view.panning || host.view.spaceDown) return;
  if (host.suppressNextClick.value) {
    host.suppressNextClick.value = false;
    return;
  }
  const rect = host.canvasEl.value.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const p = host.screenToWorld(sx, sy);

  if (host.mode.value === 'draw') {
    if (!host.drawForm.drawKind) {
      if (typeof host.requestDrawMode === 'function') host.requestDrawMode();
      return;
    }
    host.appendDrawAnchor(p);
    host.render();
    return;
  }
  if (host.mode.value === 'measure') {
    host.measurePoints.value.push({ x: p.x, y: p.y });
    host.render();
    return;
  }
  if (host.mode.value === 'select') {
    host.selectedRoadIndex.value = host.pickRoad(p);
    if (host.selectedRoadIndex.value >= 0 && typeof host.prepareRoadPenEdit === 'function') {
      const road = host.roads.value[host.selectedRoadIndex.value];
      if (road) host.prepareRoadPenEdit(road);
    }
    host.render();
    return;
  }
  if (host.mode.value === 'connect') {
    const handle = host.pickHandle(sx, sy);
    if (!handle) return;
    if (!host.connectDraft.value.first) {
      host.connectDraft.value.first = { roadIdx: handle.roadIdx, endpoint: handle.endpoint };
      host.selectedRoadIndex.value = handle.roadIdx;
      host.render();
      return;
    }
    if (host.connectDraft.value.first.roadIdx === handle.roadIdx
      && host.connectDraft.value.first.endpoint === handle.endpoint) {
      host.connectDraft.value = { first: null, second: null };
      host.render();
      return;
    }
    host.connectDraft.value.second = { roadIdx: handle.roadIdx, endpoint: handle.endpoint };
    host.connectRoadsWithBezier(host.connectDraft.value.first, host.connectDraft.value.second, host.connectForm.smoothness);
    host.connectDraft.value = { first: null, second: null };
    return;
  }
  if (host.mode.value === 'junction') {
    const handle = host.pickHandle(sx, sy);
    if (!handle) return;
    const existsAt = (host.junctionDraft.value.handles || []).findIndex((h) => (
      h.roadIdx === handle.roadIdx && h.endpoint === handle.endpoint
    ));
    if (existsAt >= 0) {
      host.junctionDraft.value.handles.splice(existsAt, 1);
      host.render();
      return;
    }
    if ((host.junctionDraft.value.handles || []).some((h) => h.roadIdx === handle.roadIdx)) {
      window.alert('同一条道路只能选择一个端点，请改选其他道路。');
      return;
    }
    if ((host.junctionDraft.value.handles || []).length >= 4) {
      window.alert('最多选择 4 个端点。');
      return;
    }
    host.junctionDraft.value.handles.push({ roadIdx: handle.roadIdx, endpoint: handle.endpoint });
    host.selectedRoadIndex.value = handle.roadIdx;
    host.render();
    return;
  }
  if (host.mode.value === 'extend') {
    if (!host.extendDraft.value) {
      const handle = host.pickHandle(sx, sy);
      if (!handle) return;
      host.extendDraft.value = {
        roadIdx: handle.roadIdx,
        endpoint: handle.endpoint,
        anchor: { x: handle.x, y: handle.y },
        hover: { x: handle.x, y: handle.y }
      };
      host.selectedRoadIndex.value = handle.roadIdx;
      host.render();
      return;
    }
    host.completeExtend(p);
  }
}

function handleWheel(e) {
  if (!host.canvasEl.value) return;
  e.preventDefault();
  const rect = host.canvasEl.value.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const before = host.screenToWorld(mx, my);
  host.view.scale = Math.max(0.1, Math.min(300, host.view.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
  const after = host.worldToScreen(before.x, before.y);
  host.view.offsetX += mx - after.x;
  host.view.offsetY += my - after.y;
  host.render();
}

function handleMouseDown(e) {
  if (!host.canvasEl.value) return;
  const rect = host.canvasEl.value.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (!host.view.spaceDown && host.mode.value === 'draw'
    && host.drawForm.drawKind === 'curve'
    && host.drawingPoints.value.length >= 2) {
    const pickedControl = host.pickDrawCurveControl(sx, sy);
    if (pickedControl) {
      host.drawControlDrag.value = {
        segmentIndex: pickedControl.segmentIndex,
        moved: false
      };
      host.render();
      return;
    }
  }
  if (!host.view.spaceDown && host.mode.value === 'select' && host.selectedRoadIndex.value >= 0) {
    const pickedCurve = host.pickRoadCurveControl(sx, sy, host.selectedRoadIndex.value);
    if (pickedCurve) {
      const road = host.roads.value[pickedCurve.roadIdx];
      if (road && typeof host.prepareRoadPenEdit === 'function') {
        host.prepareRoadPenEdit(road);
      }
      host.drawControlDrag.value = {
        roadIdx: pickedCurve.roadIdx,
        segmentIndex: pickedCurve.segmentIndex,
        moved: false
      };
      host.render();
      return;
    }
    const picked = host.pickSelectedRoadEditPoint(sx, sy);
    if (picked) {
      host.endpointDrag.value = {
        kind: 'edit-point',
        roadIdx: picked.roadIdx,
        pointIdx: picked.pointIdx,
        moved: false
      };
      host.render();
      return;
    }
  }
  if (!host.view.spaceDown) return;
  host.view.panning = true;
  host.view.panStartX = e.clientX;
  host.view.panStartY = e.clientY;
  host.view.baseOffsetX = host.view.offsetX;
  host.view.baseOffsetY = host.view.offsetY;
}

function handleMouseMove(e) {
  if (host.drawControlDrag.value && host.canvasEl.value) {
    const rect = host.canvasEl.value.getBoundingClientRect();
    const world = host.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const idx = host.drawControlDrag.value.segmentIndex;
    if (host.mode.value === 'draw' && host.drawControlDrag.value.roadIdx == null) {
      if (idx >= 0 && idx < host.drawSegmentControls.value.length) {
        const nextControls = host.drawSegmentControls.value.slice();
        nextControls[idx] = { x: world.x, y: world.y };
        host.drawSegmentControls.value = nextControls;
        host.drawControlDrag.value.moved = true;
      }
      host.render();
      return;
    }
    if (host.mode.value === 'select' && host.drawControlDrag.value.roadIdx != null) {
      const road = host.roads.value[host.drawControlDrag.value.roadIdx];
      if (road && idx >= 0) {
        if (idx < road.segmentControls.length) {
          const nextControls = road.segmentControls.slice();
          nextControls[idx] = { x: world.x, y: world.y };
          road.segmentControls = nextControls;
          host.applyRoadFromSegmentControls(road);
          if (!host.drawControlDrag.value.moved) {
            host.detachImportedSource({ roadIds: [road.id] });
          }
          host.drawControlDrag.value.moved = true;
          host.roadForm.length = Number(road.length || 0);
        }
      }
      host.render();
      return;
    }
  }
  if (host.endpointDrag.value && host.canvasEl.value && host.mode.value === 'select') {
    const rect = host.canvasEl.value.getBoundingClientRect();
    const world = host.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const road = host.roads.value[host.endpointDrag.value.roadIdx];
    const editPoints = host.getRoadEditPoints(road);
    if (road && editPoints.length >= 2 && host.endpointDrag.value.pointIdx >= 0 && host.endpointDrag.value.pointIdx < editPoints.length) {
      editPoints[host.endpointDrag.value.pointIdx].x = world.x;
      editPoints[host.endpointDrag.value.pointIdx].y = world.y;
      road.editPoints = editPoints.map((pt) => ({ x: pt.x, y: pt.y }));
      host.ensureRoadSegmentControls(road);
      host.applyRoadFromSegmentControls(road, host.drawForm.smoothing, { recomputeHeadings: true });
      if (!host.endpointDrag.value.moved) {
        host.endpointDrag.value.moved = true;
        host.detachImportedSource({ roadIds: [road.id] });
      }
      host.roadForm.length = Number(road.length || 0);
    }
    host.render();
    return;
  }
  if (host.view.panning) {
    host.view.offsetX = host.view.baseOffsetX + (e.clientX - host.view.panStartX);
    host.view.offsetY = host.view.baseOffsetY + (e.clientY - host.view.panStartY);
    host.render();
  }
  if (host.canvasEl.value) {
    const rect = host.canvasEl.value.getBoundingClientRect();
    const world = host.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    host.mouseWorld.x = world.x;
    host.mouseWorld.y = world.y;
    host.updateHoverRoadCoord(host.mouseWorld);
    if (host.mode.value === 'measure') {
      host.measureHoverPoint.value = { x: world.x, y: world.y };
      host.render();
    } else if (host.measureHoverPoint.value) {
      host.measureHoverPoint.value = null;
    }
  }
  if (!host.canvasEl.value || !host.extendDraft.value || host.mode.value !== 'extend') return;
  const rect = host.canvasEl.value.getBoundingClientRect();
  host.extendDraft.value.hover = host.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  host.render();
}

function handleMouseUp() {
  if (host.drawControlDrag.value) {
    if (host.drawControlDrag.value.moved) {
      host.suppressNextClick.value = true;
      if (host.drawControlDrag.value.roadIdx != null) {
        const draggedRoad = host.roads.value[host.drawControlDrag.value.roadIdx];
        if (draggedRoad) {
          host.rebuildConnectorsLinkedToRoad(draggedRoad.id);
          host.roadForm.length = Number(draggedRoad.length || 0);
        }
      }
    }
    host.drawControlDrag.value = null;
    host.render();
  }
  if (host.endpointDrag.value) {
    const draggedRoad = host.roads.value[host.endpointDrag.value.roadIdx];
    if (host.endpointDrag.value.moved) {
      host.suppressNextClick.value = true;
      if (draggedRoad) {
        host.rebuildConnectorsLinkedToRoad(draggedRoad.id);
        host.roadForm.length = Number(draggedRoad.length || 0);
      }
    }
    host.endpointDrag.value = null;
    host.render();
  }
  host.view.panning = false;
}

function isEditableElement(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName?.toUpperCase?.() || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function handleKeyDown(e) {
  if (!isEditableElement(e.target) && e.key === 'Escape') {
    e.preventDefault();
    if (host.measurePoints.value.length > 0) {
      host.clearMeasure();
      return;
    }
    host.setMode('select');
    host.render();
    return;
  }
  if (!isEditableElement(e.target) && e.key === 'q') {
    e.preventDefault();
    host.setMode('draw');
    host.render();
    return;
  }
  if (!isEditableElement(e.target) && e.key === 'Enter') {
    if (host.mode.value === 'draw' && host.drawingPoints.value.length >= 2) {
      e.preventDefault();
      host.finishRoad();
      return;
    }
  }
  if (!isEditableElement(e.target) && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (host.mode.value === 'measure' && host.measurePoints.value.length > 0) {
      e.preventDefault();
      host.measurePoints.value.pop();
      host.render();
      return;
    }
    if (host.selectedRoadIndex.value >= 0) {
      e.preventDefault();
      host.deleteRoad();
    }
  }
  if (e.code === 'Space') host.view.spaceDown = true;
}

function handleKeyUp(e) {
  if (e.code === 'Space') host.view.spaceDown = false;
}

function syncRoadListViewport() {
  if (!host.roadListEl.value) return;
  host.roadListViewportHeight.value = Math.max(120, host.roadListEl.value.clientHeight || 0);
}

function handleRoadListScroll(e) {
  const el = e?.target || host.roadListEl.value;
  if (!el) return;
  host.roadListScrollTop.value = el.scrollTop || 0;
  if (!host.roadListViewportHeight.value) syncRoadListViewport();
}

function openRoadColorDialog() {
  openRoadColorDialogAction(host.roadColorDialog, host.roadColorConfig);
}

function closeRoadColorDialog() {
  closeRoadColorDialogAction(host.roadColorDialog);
}

function applyRoadColorDialog() {
  applyRoadColorDialogAction(host.roadColorDialog, host.roadColorConfig);
  host.render(true);
}

function resetRoadColorDialogDefaults() {
  resetRoadColorDialogDefaultsAction(host.roadColorDialog);
  host.render(true);
}

  Object.assign(host, {
    handleCanvasClick, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp,
    handleKeyDown, handleKeyUp, syncRoadListViewport, handleRoadListScroll,
    openRoadColorDialog, closeRoadColorDialog, applyRoadColorDialog, resetRoadColorDialogDefaults
  });

}
