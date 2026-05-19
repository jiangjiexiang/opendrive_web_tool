import { watch } from 'vue';
import { isConnectorRoad } from '../laneLinkRules.js';

export function installRoadForm(host) {
function laneLinkRowsForRoadForm(road) {
  if (!isConnectorRoad(road)) return [];
  const section = Array.isArray(road?.laneSectionsSpec) && road.laneSectionsSpec.length
    ? road.laneSectionsSpec[0]
    : Array.isArray(road?.laneSections) && road.laneSections.length
      ? road.laneSections[0]
      : null;
  const laneLinks = section?.laneLinks && typeof section.laneLinks === 'object'
    ? section.laneLinks
    : {};
  const laneIds = new Set();
  (Array.isArray(section?.leftLanes) ? section.leftLanes : []).forEach((lane) => laneIds.add(String(lane.id)));
  (Array.isArray(section?.rightLanes) ? section.rightLanes : []).forEach((lane) => laneIds.add(String(lane.id)));
  if (!laneIds.size) {
    const leftCount = Math.max(0, Number(road?.leftLaneCount || 0));
    const rightCount = Math.max(0, Number(road?.rightLaneCount || 0));
    for (let i = 1; i <= leftCount; i += 1) laneIds.add(String(i));
    for (let i = 1; i <= rightCount; i += 1) laneIds.add(String(-i));
  }
  Object.keys(laneLinks).forEach((laneId) => laneIds.add(String(laneId)));
  return [...laneIds]
    .filter((laneId) => laneId !== '0')
    .sort((a, b) => Number(a) - Number(b))
    .map((laneId) => ({
      laneId,
      predecessor: laneLinks[laneId]?.predecessor ?? '',
      successor: laneLinks[laneId]?.successor ?? ''
    }));
}

function applyRoadFormLaneLinks(road) {
  if (!isConnectorRoad(road)) {
    if (Array.isArray(road.laneSectionsSpec) && road.laneSectionsSpec.length) {
      road.laneSectionsSpec = road.laneSectionsSpec.map((section) => ({ ...section, laneLinks: {} }));
    }
    if (Array.isArray(road.laneSections) && road.laneSections.length) {
      road.laneSections = road.laneSections.map((section) => ({ ...section, laneLinks: {} }));
    }
    return;
  }
  const laneLinks = {};
  (Array.isArray(host.roadForm.laneLinks) ? host.roadForm.laneLinks : []).forEach((row) => {
    const laneId = String(row?.laneId ?? '').trim();
    if (!laneId || laneId === '0') return;
    const predecessor = String(row?.predecessor ?? '').trim();
    const successor = String(row?.successor ?? '').trim();
    if (!predecessor && !successor) return;
    laneLinks[laneId] = {};
    if (predecessor) laneLinks[laneId].predecessor = predecessor;
    if (successor) laneLinks[laneId].successor = successor;
  });
  const sectionBase = Array.isArray(road.laneSectionsSpec) && road.laneSectionsSpec.length
    ? { ...road.laneSectionsSpec[0] }
    : Array.isArray(road.laneSections) && road.laneSections.length
      ? { ...road.laneSections[0] }
      : {
        s: 0,
        leftLaneCount: road.leftLaneCount,
        rightLaneCount: road.rightLaneCount,
        leftLaneWidth: road.leftLaneWidth,
        rightLaneWidth: road.rightLaneWidth,
        centerType: road.centerType
      };
  const nextSection = {
    ...sectionBase,
    laneLinks
  };
  road.laneSectionsSpec = [nextSection];
  road.laneSections = [{
    ...nextSection,
    leftLanes: Array.isArray(nextSection.leftLanes) ? nextSection.leftLanes.map((lane) => ({ ...lane })) : [],
    rightLanes: Array.isArray(nextSection.rightLanes) ? nextSection.rightLanes.map((lane) => ({ ...lane })) : []
  }];
}

watch(host.selectedRoad, (road) => {
  if (!road) return;
  host.roadForm.id = road.id;
  host.roadForm.junction = road.junction;
  host.roadForm.leftLaneCount = Number(road.leftLaneCount || 0);
  host.roadForm.rightLaneCount = Number(road.rightLaneCount || 0);
  host.roadForm.leftLaneWidth = Number(road.leftLaneWidth || road.laneWidth || 3.5);
  host.roadForm.rightLaneWidth = Number(road.rightLaneWidth || road.laneWidth || 3.5);
  host.roadForm.length = Number(road.length || 0);
  host.roadForm.centerType = road.centerType || 'none';
  host.roadForm.predecessorType = road.predecessorType || 'road';
  host.roadForm.predecessorId = road.predecessorId || '';
  host.roadForm.successorType = road.successorType || 'road';
  host.roadForm.successorId = road.successorId || '';
  host.roadForm.laneLinks = laneLinkRowsForRoadForm(road);
  if (road.connectorMeta?.smoothness) {
    host.connectForm.smoothness = Number(road.connectorMeta.smoothness);
  }
  if (road.connectorMeta?.overlap !== undefined) {
    host.connectForm.overlap = Number(road.connectorMeta.overlap);
  }
});

watch(
  () => [host.roadForm.leftLaneCount, host.roadForm.rightLaneCount],
  () => {
    const existing = new Map((Array.isArray(host.roadForm.laneLinks) ? host.roadForm.laneLinks : [])
      .map((row) => [String(row.laneId), row]));
    const rows = [];
    const leftCount = Math.max(0, Number(host.roadForm.leftLaneCount || 0));
    const rightCount = Math.max(0, Number(host.roadForm.rightLaneCount || 0));
    for (let i = rightCount; i >= 1; i -= 1) {
      const laneId = String(-i);
      rows.push(existing.get(laneId) || { laneId, predecessor: '', successor: '' });
    }
    for (let i = 1; i <= leftCount; i += 1) {
      const laneId = String(i);
      rows.push(existing.get(laneId) || { laneId, predecessor: '', successor: '' });
    }
    host.roadForm.laneLinks = rows;
  }
);

watch(
  () => [host.headerForm.name, host.headerForm.vendor, host.headerForm.north, host.headerForm.south, host.headerForm.east, host.headerForm.west],
  () => host.detachImportedSource({ headerChanged: true })
);

watch(
  () => [host.pointCloudForm.sampleRatio, host.pointCloudForm.minZ, host.pointCloudForm.maxZ],
  () => host.schedulePointCloudFilterRefresh()
);

  host.laneLinkRowsForRoadForm = laneLinkRowsForRoadForm;
  host.applyRoadFormLaneLinks = applyRoadFormLaneLinks;
}
