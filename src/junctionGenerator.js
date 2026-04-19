'use strict';

function isIntegerLike(value) {
  return /^-?\d+$/.test(String(value ?? '').trim());
}

function nextNumericId(ids, fallback = 1) {
  const nums = (Array.isArray(ids) ? ids : [])
    .map((v) => String(v ?? '').trim())
    .filter((v) => isIntegerLike(v))
    .map((v) => Number(v));
  if (!nums.length) return String(fallback);
  return String(Math.max(...nums) + 1);
}

function randomHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return out;
}

function pseudoUuidV4() {
  const a = randomHex(4);
  const b = randomHex(2);
  const c = `4${randomHex(2).slice(1)}`;
  const d = `${((8 + Math.floor(Math.random() * 4)).toString(16))}${randomHex(2).slice(1)}`;
  const e = randomHex(6);
  return `${a}-${b}-${c}-${d}-${e}`;
}

function laneCountForRole(approach, role) {
  const leftCount = Math.max(0, Number(approach.leftLaneCount || 0));
  const rightCount = Math.max(0, Number(approach.rightLaneCount || 0));
  if (role === 'incoming') {
    return approach.endpoint === 'end' ? rightCount : leftCount;
  }
  return approach.endpoint === 'end' ? leftCount : rightCount;
}

function laneIdForRole(endpoint, role, laneIndex) {
  const idx = Math.max(1, Number(laneIndex || 1));
  if (role === 'incoming') {
    return endpoint === 'end' ? -idx : idx;
  }
  return endpoint === 'start' ? -idx : idx;
}

function mapLaneIndex(laneIdx, fromCount, toCount) {
  const fromN = Math.max(1, Number(fromCount || 1));
  const toN = Math.max(1, Number(toCount || 1));
  if (fromN === 1 || toN === 1) return 1;
  const t = (laneIdx - 1) / (fromN - 1);
  return Math.max(1, Math.min(toN, Math.round(1 + t * (toN - 1))));
}

function normalizeApproach(raw) {
  return {
    roadId: String(raw.roadId ?? raw.id ?? '').trim(),
    endpoint: String(raw.endpoint || 'end') === 'start' ? 'start' : 'end',
    leftLaneCount: Math.max(0, Number(raw.leftLaneCount || 0)),
    rightLaneCount: Math.max(0, Number(raw.rightLaneCount || 0))
  };
}

function validateApproaches(approaches) {
  if (!Array.isArray(approaches) || approaches.length < 3 || approaches.length > 4) {
    return 'approaches must contain 3 or 4 roads';
  }
  const ids = approaches.map((a) => String(a.roadId || '').trim());
  if (ids.some((id) => !id)) return 'roadId is required for each approach';
  if (new Set(ids).size !== ids.length) return 'roadId must be unique';
  return '';
}

function defaultMovementFilter(from, to) {
  return from.roadId !== to.roadId;
}

function buildLaneMap(from, to, connectorLaneSidePolicy = 'follow_incoming_side') {
  const fromCount = laneCountForRole(from, 'incoming');
  const toCount = laneCountForRole(to, 'outgoing');
  if (fromCount <= 0 || toCount <= 0) {
    return {
      fromCount,
      toCount,
      useLeftLanes: true,
      laneMap: []
    };
  }

  const useLeftLanes = connectorLaneSidePolicy === 'always_left'
    ? true
    : connectorLaneSidePolicy === 'always_right'
      ? false
      : from.endpoint === 'start';

  const laneMap = [];
  for (let lane = 1; lane <= fromCount; lane += 1) {
    const mappedTo = mapLaneIndex(lane, fromCount, toCount);
    const connectorLaneId = useLeftLanes ? lane : -lane;
    const fromRoadLaneId = laneIdForRole(from.endpoint, 'incoming', lane);
    const toRoadLaneId = laneIdForRole(to.endpoint, 'outgoing', mappedTo);
    laneMap.push({
      from: lane,
      to: mappedTo,
      fromRoadLaneId,
      toRoadLaneId,
      connectorLaneId
    });
  }

  return { fromCount, toCount, useLeftLanes, laneMap };
}

function generateJunctionFromApproaches(input) {
  const approaches = (Array.isArray(input?.approaches) ? input.approaches : []).map(normalizeApproach);
  const error = validateApproaches(approaches);
  if (error) {
    return { ok: false, reason: error };
  }

  const existingRoadIds = Array.isArray(input?.existingRoadIds) ? input.existingRoadIds : [];
  const existingJunctionIds = Array.isArray(input?.existingJunctionIds) ? input.existingJunctionIds : [];
  const movementFilter = typeof input?.movementFilter === 'function'
    ? input.movementFilter
    : defaultMovementFilter;
  const connectorLaneSidePolicy = String(input?.connectorLaneSidePolicy || 'follow_incoming_side');

  const junctionId = nextNumericId(existingJunctionIds, 1);
  let nextRoadIdNum = Number(nextNumericId(existingRoadIds, 1));
  let connectionId = 0;

  const internalRoads = [];
  const connections = [];

  for (const from of approaches) {
    for (const to of approaches) {
      if (!movementFilter(from, to)) continue;

      const internalRoadId = String(nextRoadIdNum);
      nextRoadIdNum += 1;

      const { fromCount, toCount, useLeftLanes, laneMap } = buildLaneMap(from, to, connectorLaneSidePolicy);
      if (!laneMap.length) continue;

      internalRoads.push({
        id: internalRoadId,
        junction: junctionId,
        predecessorType: 'road',
        predecessorId: from.roadId,
        predecessorContactPoint: from.endpoint,
        successorType: 'road',
        successorId: to.roadId,
        successorContactPoint: to.endpoint,
        connectorContact: {
          entering: 'start',
          leaving: 'end'
        },
        leftLaneCount: useLeftLanes ? fromCount : 0,
        rightLaneCount: useLeftLanes ? 0 : fromCount,
        laneLinkSpec: Object.fromEntries(
          laneMap.map((m) => [
            String(m.connectorLaneId),
            {
              predecessor: m.fromRoadLaneId,
              successor: m.toRoadLaneId
            }
          ])
        )
      });

      connections.push({
        id: String(connectionId),
        incomingRoad: from.roadId,
        connectingRoad: internalRoadId,
        contactPoint: 'start',
        laneLinks: laneMap.map((m) => ({
          from: String(m.fromRoadLaneId),
          to: String(m.connectorLaneId)
        })),
        meta: {
          outgoingRoad: to.roadId,
          outgoingContactPoint: 'end',
          sequentialLaneMap: laneMap.map((m) => ({
            fromIncomingLane: m.fromRoadLaneId,
            toOutgoingLane: m.toRoadLaneId
          }))
        }
      });

      connectionId += 1;
    }
  }

  const junction = {
    id: junctionId,
    name: `junction_${junctionId}`,
    vectorJunctionId: `{${pseudoUuidV4()}}`,
    connections
  };

  return {
    ok: true,
    junction,
    internalRoads,
    debug: {
      approachCount: approaches.length,
      connectionCount: connections.length
    }
  };
}

module.exports = {
  generateJunctionFromApproaches
};
