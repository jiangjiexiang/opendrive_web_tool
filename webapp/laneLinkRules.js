/** 主路 junction=-1 不写 lane link；仅路口连接路（junction≠-1）按行驶方向写 pred/succ */

export function isConnectorRoad(road) {
  const junction = String(road?.junction ?? '-1').trim();
  return junction !== '' && junction !== '-1';
}

export function isMainRoad(road) {
  return !isConnectorRoad(road);
}

export function stripLaneLinksFromSections(road) {
  const stripSection = (section) => {
    if (!section || typeof section !== 'object') return section;
    const next = { ...section, laneLinks: {} };
    if (Array.isArray(next.leftLanes)) {
      next.leftLanes = next.leftLanes.map((lane) => {
        const { predecessor, successor, ...rest } = lane || {};
        return { ...rest };
      });
    }
    if (Array.isArray(next.rightLanes)) {
      next.rightLanes = next.rightLanes.map((lane) => {
        const { predecessor, successor, ...rest } = lane || {};
        return { ...rest };
      });
    }
    return next;
  };
  if (Array.isArray(road?.laneSections)) {
    road.laneSections = road.laneSections.map(stripSection);
  }
  if (Array.isArray(road?.laneSectionsSpec)) {
    road.laneSectionsSpec = road.laneSectionsSpec.map(stripSection);
  }
  return road;
}

/** 路口连接路：pred=来向 lane id，succ=去向 lane id（行驶方向） */
export function buildConnectorLaneLinks(fromRoad, fromEndpoint, toRoad, toEndpoint, connectorRoad) {
  const links = {};
  const fromEp = String(fromEndpoint || 'end');
  const toEp = String(toEndpoint || 'start');

  const fromLeft = Math.max(0, Number(fromRoad?.leftLaneCount || 0));
  const fromRight = Math.max(0, Number(fromRoad?.rightLaneCount || 0));
  const toLeft = Math.max(0, Number(toRoad?.leftLaneCount || 0));
  const toRight = Math.max(0, Number(toRoad?.rightLaneCount || 0));

  const laneIdAtEndpoint = (road, endpoint, side, index) => {
    const n = Math.max(1, index);
    if (side === 'left') return endpoint === 'end' ? n : n;
    return endpoint === 'end' ? -n : -n;
  };

  const mapIndex = (idx, fromCount, toCount) => {
    if (fromCount <= 1 || toCount <= 1) return 1;
    return Math.max(1, Math.min(toCount, Math.round(1 + ((idx - 1) / (fromCount - 1)) * (toCount - 1))));
  };

  const leftCount = Math.max(0, Number(connectorRoad?.leftLaneCount || 0));
  const rightCount = Math.max(0, Number(connectorRoad?.rightLaneCount || 0));

  if (leftCount > 0 && fromLeft > 0 && toLeft > 0) {
    for (let i = 1; i <= leftCount; i += 1) {
      const mapped = mapIndex(i, leftCount, toLeft);
      const connectorLaneId = leftCount === 1 && rightCount === 0 ? 1 : i;
      links[String(connectorLaneId)] = {
        predecessor: String(laneIdAtEndpoint(fromRoad, fromEp, 'left', i)),
        successor: String(laneIdAtEndpoint(toRoad, toEp, 'left', mapped))
      };
    }
  }

  if (rightCount > 0 && fromRight > 0 && toRight > 0) {
    for (let i = 1; i <= rightCount; i += 1) {
      const mapped = mapIndex(i, rightCount, toRight);
      const connectorLaneId = rightCount === 1 && leftCount === 0 ? -1 : -i;
      links[String(connectorLaneId)] = {
        predecessor: String(laneIdAtEndpoint(fromRoad, fromEp, 'right', i)),
        successor: String(laneIdAtEndpoint(toRoad, toEp, 'right', mapped))
      };
    }
  }

  return links;
}

export function applyConnectorLaneLinksToRoad(connectorRoad, fromRoad, fromEndpoint, toRoad, toEndpoint) {
  if (!isConnectorRoad(connectorRoad)) return connectorRoad;
  const laneLinks = buildConnectorLaneLinks(fromRoad, fromEndpoint, toRoad, toEndpoint, connectorRoad);
  if (!Object.keys(laneLinks).length) return connectorRoad;

  const section = Array.isArray(connectorRoad.laneSectionsSpec) && connectorRoad.laneSectionsSpec.length
    ? { ...connectorRoad.laneSectionsSpec[0], laneLinks }
    : {
      s: 0,
      leftLaneCount: connectorRoad.leftLaneCount,
      rightLaneCount: connectorRoad.rightLaneCount,
      leftLaneWidth: connectorRoad.leftLaneWidth,
      rightLaneWidth: connectorRoad.rightLaneWidth,
      centerType: connectorRoad.centerType || 'none',
      laneLinks
    };
  connectorRoad.laneSectionsSpec = [section];
  if (Array.isArray(connectorRoad.laneSections) && connectorRoad.laneSections.length) {
    connectorRoad.laneSections = [{ ...connectorRoad.laneSections[0], laneLinks }];
  }
  return connectorRoad;
}
