import { formatNum } from './formatters.js';

export function installRoadListUi(host) {
function getChildrenText(roadId) {
  const links = [];
  host.roads.value.forEach((r) => {
    if (String(r.id) === String(roadId)) return;
    if (String(r.predecessorId || '') === String(roadId) || String(r.successorId || '') === String(roadId)) {
      links.push(r.id);
    }
  });
  const uniq = [...new Set(links)];
  return uniq.length ? uniq.join(', ') : '无';
}

function getChildRoadEntries(roadId) {
  return host.childRoadEntriesByParent.value[String(roadId)] || [];
}

function hasChildRoadEntries(roadId) {
  return getChildRoadEntries(roadId).length > 0;
}

function isRoadChildrenExpanded(roadId) {
  return Boolean(host.collapsedRoadGroups.value[String(roadId)]);
}

function toggleRoadChildren(roadId) {
  const sid = String(roadId ?? '').trim();
  if (!sid || !hasChildRoadEntries(sid)) return;
  host.collapsedRoadGroups.value = {
    ...(host.collapsedRoadGroups.value || {}),
    [sid]: !isRoadChildrenExpanded(sid)
  };
}

function isRoadVisible(road) {
  return road?.visible !== false;
}

function toggleRoadVisibility(index) {
  const road = host.roads.value[index];
  if (!road) return;
  road.visible = road.visible === false;
  if (road.visible === false && host.selectedRoadIndex.value === index) {
    host.connectDraft.value = { first: null, second: null };
    host.extendDraft.value = null;
    host.junctionDraft.value = { handles: [] };
    host.endpointDrag.value = null;
  }
  host.render();
}

function getConnectHandleText(handle) {
  if (!handle) return '未选择';
  const road = host.roads.value[handle.roadIdx];
  if (!road) return '未选择';
  return `Road ${road.id} ${handle.endpoint === 'start' ? '起点' : '终点'}`;
}

function clearConnectDraft() {
  host.connectDraft.value = { first: null, second: null };
  host.render();
}

function clearJunctionDraft() {
  host.junctionDraft.value = { handles: [] };
  host.render();
}

  Object.assign(host, {
    getChildRoadEntries, hasChildRoadEntries, isRoadChildrenExpanded, toggleRoadChildren,
    isRoadVisible, toggleRoadVisibility, getConnectHandleText, clearConnectDraft, clearJunctionDraft
  });

}
