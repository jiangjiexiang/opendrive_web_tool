import { computed } from 'vue';
import { selectedRoadToOpenDriveXml } from '../roadOpenDriveXml.js';
import {
  VIRTUAL_ROAD_LIST_THRESHOLD,
  LARGE_MAP_TREE_THRESHOLD,
  LARGE_MAP_CHILD_INDEX_THRESHOLD,
  ROAD_LIST_ROW_HEIGHT,
  ROAD_LIST_OVERSCAN
} from './constants.js';

export function installRoadList(host) {
const selectedRoad = computed(() => host.roads.value[host.selectedRoadIndex.value] || null);
const selectedRoadLaneIds = computed(() => {
  const road = selectedRoad.value;
  if (!road) return [];
  const ids = new Set();
  (Array.isArray(road.laneSections) ? road.laneSections : []).forEach((section) => {
    (Array.isArray(section.leftLanes) ? section.leftLanes : []).forEach((lane) => {
      const id = String(lane?.id ?? '').trim();
      if (id) ids.add(id);
    });
    (Array.isArray(section.rightLanes) ? section.rightLanes : []).forEach((lane) => {
      const id = String(lane?.id ?? '').trim();
      if (id) ids.add(id);
    });
  });
  if (ids.size) return [...ids].sort((a, b) => Number(a) - Number(b));
  const leftCount = Math.max(0, Number(road.leftLaneCount || 0));
  const rightCount = Math.max(0, Number(road.rightLaneCount || 0));
  for (let i = 1; i <= leftCount; i += 1) ids.add(String(i));
  for (let i = 1; i <= rightCount; i += 1) ids.add(String(-i));
  return [...ids].sort((a, b) => Number(a) - Number(b));
});

const selectedRoadCode = computed(() => {
  const road = selectedRoad.value;
  if (!road) return '';
  const roadId = String(road.id ?? '').trim();
  const importedRaw = String(host.rawRoadXmlById.value?.[roadId] || '').trim();
  const isDirty = Boolean(host.dirtyRoadIds.value?.[roadId]);
  if (importedRaw && !isDirty) return importedRaw;
  return selectedRoadToOpenDriveXml(road);
});
const useVirtualRoadList = computed(() => host.roads.value.length >= VIRTUAL_ROAD_LIST_THRESHOLD);
const useRoadTreeList = computed(() => host.roads.value.length < LARGE_MAP_TREE_THRESHOLD);
const roadListWindowCount = computed(() => {
  const base = Math.ceil(Math.max(120, host.roadListViewportHeight.value) / ROAD_LIST_ROW_HEIGHT);
  return base + ROAD_LIST_OVERSCAN * 2;
});
const roadListStartIndex = computed(() => {
  if (!useVirtualRoadList.value) return 0;
  return Math.max(0, Math.floor(host.roadListScrollTop.value / ROAD_LIST_ROW_HEIGHT) - ROAD_LIST_OVERSCAN);
});
const roadListEndIndex = computed(() => {
  if (!useVirtualRoadList.value) return host.roads.value.length;
  return Math.min(host.roads.value.length, roadListStartIndex.value + roadListWindowCount.value);
});
const virtualRoadRows = computed(() => {
  if (!useVirtualRoadList.value) return [];
  const out = [];
  for (let i = roadListStartIndex.value; i < roadListEndIndex.value; i += 1) {
    out.push({ index: i, road: host.roads.value[i] });
  }
  return out;
});
const roadListTopPadding = computed(() => {
  if (!useVirtualRoadList.value) return 0;
  return roadListStartIndex.value * ROAD_LIST_ROW_HEIGHT;
});
const roadListBottomPadding = computed(() => {
  if (!useVirtualRoadList.value) return 0;
  return Math.max(0, (host.roads.value.length - roadListEndIndex.value) * ROAD_LIST_ROW_HEIGHT);
});
const childRoadEntriesByParent = computed(() => {
  if (host.roads.value.length > LARGE_MAP_CHILD_INDEX_THRESHOLD) return Object.create(null);
  const map = Object.create(null);
  host.roads.value.forEach((r, index) => {
    const rid = String(r.id ?? '');
    const predId = String(r.predecessorId || '');
    const succId = String(r.successorId || '');
    if (predId && predId !== rid) {
      if (!map[predId]) map[predId] = [];
      map[predId].push({ road: r, index });
    }
    if (succId && succId !== rid && succId !== predId) {
      if (!map[succId]) map[succId] = [];
      map[succId].push({ road: r, index });
    }
  });
  return map;
});
const childRoadIds = computed(() => {
  const ids = new Set();
  Object.values(childRoadEntriesByParent.value).forEach((entries) => {
    (entries || []).forEach((entry) => {
      const id = String(entry?.road?.id ?? '');
      if (id) ids.add(id);
    });
  });
  return ids;
});
const roadTreeRows = computed(() => {
  const rows = host.roads.value
    .map((road, index) => ({ road, index }))
    .filter(({ road }) => !childRoadIds.value.has(String(road?.id ?? '')));
  return rows.length ? rows : host.roads.value.map((road, index) => ({ road, index }));
});
const normalizedRoadSearchQuery = computed(() => String(host.roadSearchQuery.value || '').trim().toLowerCase());
const filteredVirtualRoadRows = computed(() => {
  const query = normalizedRoadSearchQuery.value;
  if (!query) return virtualRoadRows.value;
  return virtualRoadRows.value.filter((row) => String(row?.road?.id ?? '').toLowerCase().includes(query));
});
const filteredRoadTreeRows = computed(() => {
  const query = normalizedRoadSearchQuery.value;
  if (!query) return roadTreeRows.value;
  return roadTreeRows.value.filter((row) => {
    const roadId = String(row?.road?.id ?? '').toLowerCase();
    const children = host.getChildRoadEntries(String(row?.road?.id ?? ''));
    return roadId.includes(query)
      || children.some((child) => String(child?.road?.id ?? '').toLowerCase().includes(query));
  });
});

  Object.assign(host, {
    selectedRoad, selectedRoadLaneIds, selectedRoadCode,
    useVirtualRoadList, useRoadTreeList, roadListWindowCount, roadListStartIndex, roadListEndIndex,
    virtualRoadRows, roadListTopPadding, roadListBottomPadding, childRoadEntriesByParent, childRoadIds,
    roadTreeRows, normalizedRoadSearchQuery, filteredVirtualRoadRows, filteredRoadTreeRows
  });

}
