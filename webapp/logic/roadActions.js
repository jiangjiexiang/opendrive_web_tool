import { polylineLength } from '../editorUtils.js';
import { selectedRoadToOpenDriveXml } from '../roadOpenDriveXml.js';
import { parseXodrDoc, parseRoadDetailsFromXodr } from '../xodrParsers.js';

export function installRoadActions(host) {
function clearDrawDraft() {
  host.drawingPoints.value = [];
  host.drawSegmentControls.value = [];
  host.drawSegmentHeadings.value = [];
  host.drawControlDrag.value = null;
}

function requestDrawMode() {
  if (host.mode.value === 'draw' && host.drawingPoints.value.length > 0) {
    clearDrawDraft();
    host.mode.value = 'select';
  }
  host.drawKindDialog.visible = true;
}

function confirmDrawKind(kind) {
  const next = String(kind || '').toLowerCase();
  if (next !== 'line' && next !== 'curve') return;
  host.drawForm.drawKind = next;
  host.drawKindDialog.visible = false;
  clearDrawDraft();
  host.mode.value = 'draw';
  host.connectDraft.value = { first: null, second: null };
  host.extendDraft.value = null;
  host.junctionDraft.value = { handles: [] };
  host.endpointDrag.value = null;
  host.measureHoverPoint.value = null;
  host.render();
}

function cancelDrawKindDialog() {
  host.drawKindDialog.visible = false;
}

function setMode(next) {
  if (host.mode.value === 'draw' && next !== 'draw' && host.drawingPoints.value.length > 0) {
    if (host.drawingPoints.value.length >= 2) {
      finishRoad();
    } else {
      host.drawingPoints.value = [];
      host.drawSegmentControls.value = [];
      host.drawSegmentHeadings.value = [];
      host.drawControlDrag.value = null;
    }
  }
  host.mode.value = next;
  if (next !== 'draw') {
    host.drawSegmentHeadings.value = [];
  }
  if (next === 'junction') {
    host.drawForm.autoJunction = true;
  }
  host.connectDraft.value = { first: null, second: null };
  host.extendDraft.value = null;
  host.junctionDraft.value = { handles: [] };
  host.endpointDrag.value = null;
  host.drawControlDrag.value = null;
  host.drawSegmentControls.value = [];
  host.drawSegmentHeadings.value = [];
  host.measureHoverPoint.value = null;
  host.render();
}

function selectRoad(i, options = {}) {
  host.selectedJunctionId.value = '';
  host.selectedRoadIndex.value = i;
  if (i >= 0 && typeof host.prepareRoadPenEdit === 'function') {
    const road = host.roads.value[i];
    if (road) host.prepareRoadPenEdit(road);
  }
  if (options.center) host.centerViewOnRoad(i);
  host.render();
}

function getJunctionRelatedRoadIds(mesh) {
  const ids = new Set();
  if (!mesh) return ids;
  (mesh.connectorMeta || []).forEach((conn) => {
    const fromId = String(conn?.fromRoadId ?? '').trim();
    const connId = String(conn?.roadId ?? '').trim();
    if (fromId) ids.add(fromId);
    if (connId) ids.add(connId);
  });
  (mesh.approaches || []).forEach((a) => {
    const roadId = String(a?.roadId ?? '').trim();
    if (roadId) ids.add(roadId);
  });
  return ids;
}

function getJunctionLinkRows(mesh) {
  if (!mesh) return [];
  const jid = String(mesh.id ?? '').trim();
  let connections = Array.isArray(mesh.connectorMeta) ? mesh.connectorMeta : [];
  if (!connections.length && jid) {
    const spec = (host.junctionSpecs.value || []).find((j) => String(j?.id ?? '').trim() === jid);
    connections = (spec?.connections || []).map((conn, index) => ({
      id: String(conn?.id ?? index),
      fromRoadId: String(conn?.incomingRoad ?? ''),
      roadId: String(conn?.connectingRoad ?? ''),
      entryContactPoint: String(conn?.contactPoint || 'start'),
      laneMap: (Array.isArray(conn?.laneLinks) ? conn.laneLinks : []).map((link) => ({
        fromRoadLaneId: String(link?.from ?? ''),
        connectorLaneId: String(link?.to ?? '')
      }))
    }));
  }
  return connections
    .filter((conn) => String(conn?.fromRoadId ?? '').trim() || String(conn?.roadId ?? '').trim())
    .map((conn, index) => {
      const incoming = String(conn.fromRoadId ?? '').trim();
      const connecting = String(conn.roadId ?? '').trim();
      const contact = String(conn.entryContactPoint || 'start');
      const laneMap = Array.isArray(conn.laneMap) ? conn.laneMap : [];
      const laneLinks = laneMap.length
        ? laneMap.map((link) => ({
          from: String(link.fromRoadLaneId ?? link.from ?? ''),
          to: String(link.connectorLaneId ?? link.to ?? '')
        }))
        : [];
      const laneText = laneLinks.length
        ? laneLinks.map((link) => `${link.from} → ${link.to}`).join(', ')
        : '';
      return {
        key: `${jid}-${incoming}-${connecting}-${index}`,
        connectionId: String(conn?.id ?? index),
        incomingRoad: incoming,
        connectingRoad: connecting,
        contactPoint: contact,
        laneLinks,
        laneText
      };
    });
}

function setJunctionListExpanded(junctionId, expanded) {
  const id = String(junctionId ?? '').trim();
  if (!id) return;
  const next = { ...(host.junctionExpandedById?.value || {}) };
  if (expanded) next[id] = true;
  else delete next[id];
  host.junctionExpandedById.value = next;
}

function toggleJunctionListExpanded(junctionId) {
  const id = String(junctionId ?? '').trim();
  if (!id) return;
  const cur = Boolean(host.junctionExpandedById?.value?.[id]);
  setJunctionListExpanded(id, !cur);
}

function isJunctionListExpanded(junctionId) {
  const id = String(junctionId ?? '').trim();
  return Boolean(host.junctionExpandedById?.value?.[id]);
}

function selectJunction(junctionId) {
  const id = String(junctionId ?? '').trim();
  if (!id) {
    host.selectedJunctionId.value = '';
    host.render();
    return;
  }
  host.selectedJunctionId.value = id;
  setJunctionListExpanded(id, true);
  host.selectedRoadIndex.value = -1;
  if (typeof host.centerViewOnJunction === 'function') {
    host.centerViewOnJunction(id);
  } else {
    host.render();
  }
}

function setHoveredRoadIndex(index) {
  const next = Number(index);
  if (!Number.isFinite(next) || next < 0) {
    clearHoveredRoadIndex();
    return;
  }
  if (host.hoveredRoadIndex.value === next) return;
  host.hoveredRoadIndex.value = next;
  host.render();
}

function clearHoveredRoadIndex() {
  if (host.hoveredRoadIndex.value < 0) return;
  host.hoveredRoadIndex.value = -1;
  host.render();
}

function finishRoad() {
  if (host.drawingPoints.value.length < 2) return;
  host.detachImportedSource();
  const anchors = host.drawingPoints.value.slice();
  const drawKind = host.drawForm.drawKind || 'curve';
  const controls = drawKind === 'line' ? [] : host.drawSegmentControls.value.slice();
  const headings = drawKind === 'line' ? [] : host.drawSegmentHeadings.value.slice();
  host.roads.value.push(host.createRoadFromDrawDraft(anchors, controls, { drawKind }, headings));
  host.selectedRoadIndex.value = host.roads.value.length - 1;
  host.drawingPoints.value = [];
  host.drawSegmentControls.value = [];
  host.drawSegmentHeadings.value = [];
  host.drawControlDrag.value = null;
  host.maybeAutoGenerateJunctionForNewestRoad();
  host.render();
}

function removeRawJunctionRecords(junctionIds) {
  if (!Array.isArray(junctionIds) || !junctionIds.length) return;
  const ids = new Set(junctionIds.map((id) => String(id ?? '').trim()).filter(Boolean));
  if (!ids.size) return;

  const nextRaw = { ...(host.rawJunctionXmlById.value || {}) };
  let rawChanged = false;
  Object.keys(nextRaw).forEach((id) => {
    if (!ids.has(id)) return;
    delete nextRaw[id];
    rawChanged = true;
  });
  if (rawChanged) host.rawJunctionXmlById.value = nextRaw;

  const nextDirty = { ...(host.dirtyJunctionIds.value || {}) };
  let dirtyChanged = false;
  Object.keys(nextDirty).forEach((id) => {
    if (!ids.has(id)) return;
    delete nextDirty[id];
    dirtyChanged = true;
  });
  if (dirtyChanged) host.dirtyJunctionIds.value = nextDirty;
}

function synchronizeTopologyAfterRoadRemoval(removedRoadId) {
  const removedId = String(removedRoadId ?? '').trim();
  if (!removedId) return;
  const existingRoadIds = new Set(
    host.roads.value.map((road) => String(road?.id ?? '').trim()).filter(Boolean)
  );

  host.roads.value.forEach((road) => {
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
  host.junctionSpecs.value = (host.junctionSpecs.value || []).map((junction) => {
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

  host.junctionMeshes.value = (host.junctionMeshes.value || []).map((mesh) => {
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
    const hasSpec = (host.junctionSpecs.value || []).some((junction) => String(junction?.id ?? '').trim() === meshId);
    return hasSpec || (mesh?.approaches || []).length || (mesh?.connectorMeta || []).length;
  });

  const referencedJunctionIds = new Set(
    host.roads.value
      .map((road) => String(road?.junction ?? '').trim())
      .filter((id) => id && id !== '-1')
  );

  const removedJunctionIds = [];
  host.junctionSpecs.value = (host.junctionSpecs.value || []).filter((junction) => {
    const junctionId = String(junction?.id ?? '').trim();
    const keep = (junction?.connections || []).length > 0 || referencedJunctionIds.has(junctionId);
    if (!keep) removedJunctionIds.push(junctionId);
    return keep;
  });

  if (removedJunctionIds.length) {
    const removedSet = new Set(removedJunctionIds);
    host.junctionMeshes.value = (host.junctionMeshes.value || []).filter((mesh) => !removedSet.has(String(mesh?.id ?? '').trim()));
    removeRawJunctionRecords(removedJunctionIds);
  }

  const survivingJunctionIds = new Set(
    (host.junctionSpecs.value || []).map((junction) => String(junction?.id ?? '').trim()).filter(Boolean)
  );

  host.roads.value.forEach((road) => {
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
    host.detachImportedSource({ junctionIds: [...touchedJunctionIds] });
  }
}

function undoPoint() {
  if (host.mode.value === 'measure') {
    if (!host.measurePoints.value.length) return;
    host.measurePoints.value.pop();
    host.render();
    return;
  }
  if (!host.drawingPoints.value.length) return;
  host.drawingPoints.value.pop();
  host.syncDrawSegmentControls();
  host.syncDrawSegmentHeadings();
  host.drawControlDrag.value = null;
  host.render();
}

function clearMeasure() {
  if (!host.measurePoints.value.length) return;
  host.measurePoints.value = [];
  host.measureHoverPoint.value = null;
  host.render();
}

function deleteRoad() {
  if (host.selectedRoadIndex.value < 0) return;
  host.endpointDrag.value = null;
  const removedRoad = host.roads.value[host.selectedRoadIndex.value];
  host.detachImportedSource({
    roadIds: removedRoad ? [String(removedRoad.id)] : []
  });
  host.roads.value.splice(host.selectedRoadIndex.value, 1);
  if (removedRoad) {
    const removedId = String(removedRoad.id);
    if (host.rawRoadXmlById.value[removedId]) {
      const nextRaw = { ...(host.rawRoadXmlById.value || {}) };
      delete nextRaw[removedId];
      host.rawRoadXmlById.value = nextRaw;
    }
    if (host.dirtyRoadIds.value[removedId]) {
      const nextDirty = { ...(host.dirtyRoadIds.value || {}) };
      delete nextDirty[removedId];
      host.dirtyRoadIds.value = nextDirty;
    }
    synchronizeTopologyAfterRoadRemoval(removedId);
  }
  host.selectedRoadIndex.value = -1;
  host.render();
}

function deleteLaneFromRoad(laneIdStr) {
  const road = host.selectedRoad.value;
  if (!road) return;
  const laneId = Number(laneIdStr);
  if (!Number.isFinite(laneId) || laneId === 0) return;

  host.detachImportedSource({ roadIds: [String(road.id)] });

  const isLeft = laneId > 0;
  const absId = Math.abs(laneId);

  if (isLeft) {
    if ((road.leftLaneCount || 0) < 1) return;
    if (Array.isArray(road.nativeLaneMeshes)) {
      road.nativeLaneMeshes = road.nativeLaneMeshes
        .filter((m) => Number(m.laneId) !== laneId)
        .map((m) => {
          const mid = Number(m.laneId);
          if (mid > absId) return { ...m, laneId: mid - 1 };
          return m;
        });
    }
    [road.laneSectionsSpec, road.laneSections].forEach((sections) => {
      if (!Array.isArray(sections)) return;
      sections.forEach((section) => {
        if (!Array.isArray(section.leftLanes)) return;
        section.leftLanes = section.leftLanes
          .filter((lane) => Number(lane.id) !== laneId)
          .map((lane) => {
            const lid = Number(lane.id);
            return lid > absId ? { ...lane, id: lid - 1 } : lane;
          });
        section.leftLaneCount = section.leftLanes.length;
      });
    });
    road.leftLaneCount = Math.max(0, (road.leftLaneCount || 0) - 1);
  } else {
    if ((road.rightLaneCount || 0) < 1) return;
    if (Array.isArray(road.nativeLaneMeshes)) {
      road.nativeLaneMeshes = road.nativeLaneMeshes
        .filter((m) => Number(m.laneId) !== laneId)
        .map((m) => {
          const mid = Number(m.laneId);
          if (mid < laneId) return { ...m, laneId: mid + 1 };
          return m;
        });
    }
    [road.laneSectionsSpec, road.laneSections].forEach((sections) => {
      if (!Array.isArray(sections)) return;
      sections.forEach((section) => {
        if (!Array.isArray(section.rightLanes)) return;
        section.rightLanes = section.rightLanes
          .filter((lane) => Number(lane.id) !== laneId)
          .map((lane) => {
            const lid = Number(lane.id);
            return lid < laneId ? { ...lane, id: lid + 1 } : lane;
          });
        section.rightLaneCount = section.rightLanes.length;
      });
    });
    road.rightLaneCount = Math.max(0, (road.rightLaneCount || 0) - 1);
  }

  if (Array.isArray(road.nativeLaneBoundaries)) {
    road.nativeLaneBoundaries = [];
  }

  host.roadForm.leftLaneCount = road.leftLaneCount;
  host.roadForm.rightLaneCount = road.rightLaneCount;
  host.roadForm.laneLinks = host.laneLinkRowsForRoadForm(road);

  host.applyRoadShape(road, host.getRoadEditPoints(road));
  host.render();
}

function applySelectedRoad() {
  const r = host.selectedRoad.value;
  if (!r) return;
  const oldRoadId = String(r.id);
  const nextRoadId = String(host.roadForm.id).trim();
  const oldRawRoadXml = host.rawRoadXmlById.value?.[oldRoadId] || '';
  host.detachImportedSource({
    roadIds: oldRoadId === nextRoadId ? [oldRoadId] : [oldRoadId, nextRoadId]
  });
  if (oldRoadId !== nextRoadId && oldRawRoadXml) {
    const nextRaw = { ...(host.rawRoadXmlById.value || {}) };
    nextRaw[nextRoadId] = oldRawRoadXml;
    delete nextRaw[oldRoadId];
    host.rawRoadXmlById.value = nextRaw;
  }
  r.id = String(host.roadForm.id).trim();
  r.junction = String(host.roadForm.junction).trim();
  r.leftLaneCount = Math.max(0, Number(host.roadForm.leftLaneCount || 0));
  r.rightLaneCount = Math.max(0, Number(host.roadForm.rightLaneCount || 0));
  r.centerType = host.roadForm.centerType;
  r.predecessorType = host.roadForm.predecessorType;
  r.predecessorId = String(host.roadForm.predecessorId || '').trim();
  r.successorType = host.roadForm.successorType;
  r.successorId = String(host.roadForm.successorId || '').trim();
  r.leftLaneWidth = Math.max(0.5, Number(host.roadForm.leftLaneWidth || r.leftLaneWidth || 3.5));
  r.rightLaneWidth = Math.max(0.5, Number(host.roadForm.rightLaneWidth || r.rightLaneWidth || 3.5));
  r.laneWidth = (r.leftLaneWidth + r.rightLaneWidth) / 2;
  applyRoadFormLaneLinks(r);
  const targetLength = Number(host.roadForm.length || r.length);
  const editPoints = host.getRoadEditPoints(r);
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
  host.applyRoadShape(r, host.getRoadEditPoints(r));
  host.render();
}

function applySelectedRoadCode(codeText) {
  const road = host.selectedRoad.value;
  if (!road) throw new Error('请先选择道路');
  const source = String(codeText || '').trim();
  if (!source) throw new Error('代码内容不能为空');

  const currentId = String(road.id ?? '').trim();
  if (!currentId) throw new Error('当前道路缺少 id');

  if (source.startsWith('<road')) {
    const wrapped = `<OpenDRIVE>${source}</OpenDRIVE>`;
    const { doc } = parseXodrDoc(wrapped);
    const roadEl = doc.querySelector('OpenDRIVE > road');
    if (!roadEl) throw new Error('XML 中缺少 <road> 节点');
    const xmlRoadId = String(roadEl.getAttribute('id') || '').trim();
    if (xmlRoadId && xmlRoadId !== currentId) {
      throw new Error(`XML 中的 road id (${xmlRoadId}) 必须与当前道路 id (${currentId}) 一致`);
    }

    host.rawRoadXmlById.value = {
      ...(host.rawRoadXmlById.value || {}),
      [currentId]: source
    };
    const nextDirty = { ...(host.dirtyRoadIds.value || {}) };
    delete nextDirty[currentId];
    host.dirtyRoadIds.value = nextDirty;

    const roadDetails = parseRoadDetailsFromXodr(wrapped).details?.[currentId];
    if (roadDetails) {
      road.predecessorType = roadDetails.predecessorType || road.predecessorType;
      road.predecessorId = String(roadDetails.predecessorId || road.predecessorId || '');
      road.predecessorContactPoint = roadDetails.predecessorContactPoint || road.predecessorContactPoint;
      road.successorType = roadDetails.successorType || road.successorType;
      road.successorId = String(roadDetails.successorId || road.successorId || '');
      road.successorContactPoint = roadDetails.successorContactPoint || road.successorContactPoint;
      if (Array.isArray(roadDetails.laneOffsetRecords) && roadDetails.laneOffsetRecords.length) {
        road.laneOffsetRecords = roadDetails.laneOffsetRecords.map((record) => ({ ...record }));
      }
      if (Array.isArray(roadDetails.laneSectionsSpec) && roadDetails.laneSectionsSpec.length) {
        road.laneSections = roadDetails.laneSectionsSpec.map((section) => ({
          ...section,
          leftLanes: Array.isArray(section?.leftLanes) ? section.leftLanes.map((lane) => ({ ...lane })) : [],
          rightLanes: Array.isArray(section?.rightLanes) ? section.rightLanes.map((lane) => ({ ...lane })) : [],
          laneLinks: { ...(section?.laneLinks || {}) }
        }));
        road.laneSectionsSpec = roadDetails.laneSectionsSpec.map((section) => ({
          ...section,
          laneLinks: { ...(section?.laneLinks || {}) }
        }));
      }
    }
    if (roadEl.hasAttribute('junction')) {
      road.junction = String(roadEl.getAttribute('junction') || road.junction || '-1');
    }
    host.render();
    return;
  }

  let payload = null;
  try {
    payload = JSON.parse(source);
  } catch {
    throw new Error('请输入有效的 JSON 或 <road> XML');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('JSON 必须是对象');
  }
  if (payload.id !== undefined && String(payload.id) !== currentId) {
    throw new Error(`JSON 中的 id (${payload.id}) 必须与当前道路 id (${currentId}) 一致`);
  }

  if (payload.junction !== undefined) road.junction = String(payload.junction);
  if (payload.predecessorType !== undefined) road.predecessorType = String(payload.predecessorType || 'road');
  if (payload.predecessorId !== undefined) road.predecessorId = String(payload.predecessorId || '');
  if (payload.successorType !== undefined) road.successorType = String(payload.successorType || 'road');
  if (payload.successorId !== undefined) road.successorId = String(payload.successorId || '');
  if (payload.leftLaneCount !== undefined) road.leftLaneCount = Math.max(0, Number(payload.leftLaneCount || 0));
  if (payload.rightLaneCount !== undefined) road.rightLaneCount = Math.max(0, Number(payload.rightLaneCount || 0));
  if (payload.leftLaneWidth !== undefined) road.leftLaneWidth = Math.max(0.5, Number(payload.leftLaneWidth || road.leftLaneWidth || 3.5));
  if (payload.rightLaneWidth !== undefined) road.rightLaneWidth = Math.max(0.5, Number(payload.rightLaneWidth || road.rightLaneWidth || 3.5));
  if (payload.centerType !== undefined) road.centerType = String(payload.centerType || 'none');
  road.laneWidth = (Number(road.leftLaneWidth || 3.5) + Number(road.rightLaneWidth || 3.5)) / 2;

  if (Array.isArray(payload.points) && payload.points.length >= 2) {
    road.editPoints = payload.points.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
    host.applyRoadShape(road, host.getRoadEditPoints(road), { smoothing: host.drawForm.smoothing });
  }
  if (Array.isArray(payload.geometry) && payload.geometry.length) {
    road.geometry = payload.geometry.map((g) => ({ ...g }));
    if (payload.length !== undefined) road.length = Number(payload.length || road.length || 0);
  }
  if (Array.isArray(payload.laneSectionsSpec)) {
    road.laneSections = payload.laneSectionsSpec.map((section) => ({
      ...section,
      leftLanes: Array.isArray(section?.leftLanes) ? section.leftLanes.map((lane) => ({ ...lane })) : [],
      rightLanes: Array.isArray(section?.rightLanes) ? section.rightLanes.map((lane) => ({ ...lane })) : [],
      laneLinks: { ...(section?.laneLinks || {}) }
    }));
    road.laneSectionsSpec = payload.laneSectionsSpec.map((section) => ({
      ...section,
      laneLinks: { ...(section?.laneLinks || {}) }
    }));
  }

  const nextDirty = { ...(host.dirtyRoadIds.value || {}) };
  nextDirty[currentId] = true;
  host.dirtyRoadIds.value = nextDirty;
  host.render();
}

  Object.assign(host, {
    setMode, requestDrawMode, confirmDrawKind, cancelDrawKindDialog,
    selectRoad, selectJunction, getJunctionLinkRows, getJunctionRelatedRoadIds,
    isJunctionListExpanded, toggleJunctionListExpanded, setJunctionListExpanded,
    setHoveredRoadIndex, clearHoveredRoadIndex, finishRoad, undoPoint,
    clearMeasure, deleteRoad, deleteLaneFromRoad, applySelectedRoad, applySelectedRoadCode
  });

}
