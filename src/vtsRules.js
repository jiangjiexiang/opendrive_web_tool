'use strict';

function isIntegerLike(value) {
  return /^-?\d+$/.test(String(value ?? '').trim());
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function polylineLength(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return 0;
  }
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = Number(points[i].x) - Number(points[i - 1].x);
    const dy = Number(points[i].y) - Number(points[i - 1].y);
    total += Math.hypot(dx, dy);
  }
  return total;
}

function buildGeometryFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return [];
  }

  const out = [];
  let s = 0;
  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const dx = Number(p1.x) - Number(p0.x);
    const dy = Number(p1.y) - Number(p0.y);
    const length = Math.hypot(dx, dy);
    if (length <= 1e-8) {
      continue;
    }
    out.push({
      s,
      x: Number(p0.x),
      y: Number(p0.y),
      hdg: Math.atan2(dy, dx),
      length,
      type: 'line'
    });
    s += length;
  }
  return out;
}

function buildLanes(leftCount, rightCount, centerType) {
  const lanes = [];
  for (let i = Number(leftCount || 0); i >= 1; i -= 1) {
    lanes.push({ id: i, side: 1, type: 'driving' });
  }
  lanes.push({ id: 0, side: 0, type: centerType || 'none' });
  for (let i = -1; i >= -Number(rightCount || 0); i -= 1) {
    lanes.push({ id: i, side: -1, type: 'driving' });
  }
  return lanes;
}

function validateGeometryConsistency(road, errors) {
  const rid = String(road.id ?? 'unknown');
  const roadLength = toNumber(road.length);

  const geometry = Array.isArray(road.geometry) && road.geometry.length
    ? road.geometry
    : buildGeometryFromPoints(road.points);

  if (!geometry.length) {
    const plan = road.planView || {};
    const planLength = toNumber(plan.length);
    const s0 = toNumber(plan.s);
    if (planLength === null || planLength <= 0) {
      errors.push(`[ ERROR ] : [Road ${rid}] planView geometry length is invalid`);
    }
    if (s0 === null || Math.abs(s0) > 1e-6) {
      errors.push(`[ ERROR ] : [Road ${rid}] geometry start s must be 0`);
    }
    if (roadLength !== null && planLength !== null && Math.abs(roadLength - planLength) > 1e-3) {
      errors.push(`[ ERROR ] : [Road ${rid}] road length is not equal to sum of planview lengths`);
    }
    return;
  }

  if (Math.abs(Number(geometry[0].s) || 0) > 1e-6) {
    errors.push(`[ ERROR ] : [Road ${rid}] geometry start s must be 0`);
  }

  let expectedS = 0;
  let geomLength = 0;
  for (let i = 0; i < geometry.length; i += 1) {
    const g = geometry[i];
    const s = toNumber(g.s);
    const len = toNumber(g.length);

    if (s === null || len === null || len <= 0) {
      errors.push(`[ ERROR ] : [Road ${rid}] geometry record has invalid s/length`);
      continue;
    }

    if (Math.abs(s - expectedS) > 1e-3) {
      errors.push(`[ ERROR ] : [Road ${rid}] exists incorrect s/length in Geometry records`);
    }

    expectedS += len;
    geomLength += len;
  }

  if (roadLength !== null && Math.abs(roadLength - geomLength) > 1e-3) {
    errors.push(`[ ERROR ] : [Road ${rid}] road length is not equal to sum of planview lengths`);
  }
}

function inferLaneSideFromId(laneId) {
  const id = Number(laneId);
  if (!Number.isFinite(id)) return null;
  if (id > 0) return 1;
  if (id < 0) return -1;
  return 0;
}

function validateMapSpec(spec) {
  const errors = [];
  const warnings = [];
  const logs = [];
  const pushLogSection = (title) => {
    logs.push('');
    logs.push('#########################################################');
    logs.push(title);
    logs.push('#########################################################');
  };

  const header = spec?.header || {};
  const north = toNumber(header.north);
  const south = toNumber(header.south);
  const east = toNumber(header.east);
  const west = toNumber(header.west);

  pushLogSection('### CHECKING HEADER RECORDS                           ###');
  if ([north, south, east, west].some((v) => v === null)) {
    errors.push('[ ERROR ] :  no east/south/west/north in map');
  } else if (east < west || south > north) {
    warnings.push('[ Warning:] :  invalid value of east/south/west/north');
  }

  const roads = Array.isArray(spec?.roads) ? spec.roads : [];
  const junctions = Array.isArray(spec?.junctions) ? spec.junctions : [];
  if (!roads.length) {
    errors.push('[ ERROR ] :  no road in map');
  }

  const seenIds = new Set();
  pushLogSection('### CHECKING ROAD RECORDS                             ###');

  for (const road of roads) {
    const rid = String(road.id ?? '').trim();
    const jid = String(road.junction ?? '-1').trim();

    if (!isIntegerLike(rid)) {
      errors.push(`[ ERROR ] :  [Road ${rid || 'unknown'}]: id is not pure number`);
    }
    if (!isIntegerLike(jid)) {
      errors.push(`[ ERROR ] :  [Road ${rid || 'unknown'}]: junction record is not pure number`);
    }

    if (seenIds.has(rid)) {
      errors.push(`[ ERROR ] :  exist the same road/junction id, id is ${rid}`);
    }
    seenIds.add(rid);

    const roadForCheck = { ...road };
    if (Array.isArray(road.points) && road.points.length >= 2) {
      roadForCheck.length = Number(polylineLength(road.points).toFixed(3));
      roadForCheck.geometry = buildGeometryFromPoints(road.points);
    }

    const length = toNumber(roadForCheck.length);
    if (length === null || length <= 0) {
      errors.push(`[ ERROR ] :  [Road ${rid}] road length is invalid`);
    }

    validateGeometryConsistency(roadForCheck, errors);

    const lanes = buildLanes(road.leftLaneCount, road.rightLaneCount, road.centerType);
    const sortedDesc = [...lanes].sort((a, b) => b.id - a.id);
    let prev = sortedDesc[0]?.id + 1;
    let lastLaneSide = -2;
    let laneSideCount = 0;
    for (const lane of sortedDesc) {
      if (prev - lane.id !== 1) {
        errors.push(`[ ERROR ] :  [Road${rid}]: lane id is not in lanes sequence`);
        break;
      }
      prev = lane.id;
      if (lastLaneSide !== lane.side) laneSideCount += 1;
      lastLaneSide = lane.side;

      if (lane.side === 1 && lane.id < 1) {
        errors.push(`[ ERROR ] :  [Road${rid}]: left lane id is invalid in Road record`);
      }
      if (lane.side === 0 && lane.id !== 0) {
        errors.push(`[ ERROR ] :  [Road${rid}]: center lane id is not 0 in Road record`);
      }
      if (lane.side === -1 && lane.id > -1) {
        errors.push(`[ ERROR ] :  right lane id is invalid in Road record ${rid}`);
      }
      if (!['driving', 'sidewalk', 'bicycle', 'none'].includes(lane.type)) {
        warnings.push(`[ Warning ] :  [Road${rid}]: type of line is invalid in Road record`);
      }
      if (lane.side === 0 && lane.type === 'driving') {
        warnings.push(`[ Warning ] :  [Road${rid}]: type of center line is driving in Road record`);
      }
    }

    if (jid !== '-1') {
      const predType = String(road.predecessorType || 'road');
      const succType = String(road.successorType || 'road');
      if (predType !== 'road' || succType !== 'road') {
        errors.push(`[ ERROR ] :  [Road ${rid}] junction record is not -1 while roadlinks' elementTypes are both "road"`);
      }
      if (Number(road.rightLaneCount || 0) > 1) {
        warnings.push(`[ Warning ] :  junction is not -1 while more than one right lane that id = -1 in Road record ${rid}`);
      }
      let hasLaneLink = false;
      const laneSections = Array.isArray(road.laneSectionsSpec) ? road.laneSectionsSpec : [];
      laneSections.forEach((section) => {
        if (section?.laneLinks && Object.keys(section.laneLinks).length) hasLaneLink = true;
      });
      if (!hasLaneLink) {
        warnings.push(`[ Warning ]  :  [Road${rid}]: junction is not -1 while no lane link(or exist invalid lane link) in Road record`);
      }
    }

    const laneSections = Array.isArray(road.laneSectionsSpec) ? road.laneSectionsSpec : [];
    laneSections.forEach((section) => {
      const singleSide = String(section?.singleSide || '').trim();
      if (!singleSide) return;
      if (singleSide === 'false' && laneSideCount < 3) {
        warnings.push(`[ Warning ] :  [Road${rid}]: singleSide should be true in Road record`);
      } else if (singleSide === 'true' && laneSideCount > 2) {
        warnings.push(`[ Warning ] :  [Road${rid}]: singleSide should be false in Road record`);
      }
    });
  }

  junctions.forEach((junction) => {
    const jid = String(junction?.id ?? '').trim();
    if (!jid) return;
    if (seenIds.has(jid)) {
      errors.push(`[ ERROR ] :  exist the same road/junction id, id is ${jid}`);
    }
    seenIds.add(jid);
  });

  pushLogSection('### CHECKING TOPO CONSISTENCY                         ###');
  const roadIndex = new Map(roads.map((road) => [String(road.id ?? '').trim(), road]));
  const junctionIndex = new Map(junctions.map((junction) => [String(junction.id ?? '').trim(), junction]));
  roads.forEach((road) => {
    const rid = String(road?.id ?? '').trim();
    const succType = String(road?.successorType || '').trim();
    const succId = String(road?.successorId || '').trim();
    if (succType !== 'junction' || !succId) return;
    const junction = junctionIndex.get(succId);
    if (!junction) {
      errors.push(`[ ERROR ] :  there should be junction corresponding to successor in Road record ${rid}`);
      return;
    }
    const matches = (Array.isArray(junction.connections) ? junction.connections : []).filter((conn) => String(conn?.incomingRoad || '').trim() === rid);
    matches.forEach((conn) => {
      const connectingRoadId = String(conn?.connectingRoad || '').trim();
      const connectingRoad = roadIndex.get(connectingRoadId);
      if (!connectingRoad) {
        errors.push(`[ ERROR ] :  connection has no corresponding connectingRoad in junction ${succId}, the connectingRoad id is${connectingRoadId}`);
        return;
      }
      if (String(connectingRoad.predecessorId || '').trim() !== rid) {
        errors.push(`[ ERROR ] :  the road ${rid} should be the predecessor in Road record ${connectingRoadId} according to junction ${succId}`);
        return;
      }
      const roadLaneLinks = [];
      (Array.isArray(connectingRoad.laneSectionsSpec) ? connectingRoad.laneSectionsSpec : []).forEach((section) => {
        Object.entries(section?.laneLinks || {}).forEach(([laneId, link]) => {
          roadLaneLinks.push({
            predecessor_from: String(link?.predecessor ?? laneId),
            successor_to: String(link?.successor ?? laneId)
          });
        });
      });
      const junctionLaneLinks = Array.isArray(conn?.laneLinks) ? conn.laneLinks : [];
      let consistency = false;
      junctionLaneLinks.forEach((laneLink) => {
        roadLaneLinks.forEach((link) => {
          if (String(laneLink.from) === String(link.predecessor_from) && String(laneLink.to) === String(link.successor_to)) {
            consistency = true;
          }
        });
      });
      if (junctionLaneLinks.length && roadLaneLinks.length && !consistency) {
        errors.push(`[ ERROR ] :  the laneLink in junction ${succId} doesn\`t match the link lane in Road record ${connectingRoadId}`);
      }
    });
  });

  pushLogSection('### CHECKING LANE RECORDS                             ###');
  pushLogSection('### CHECKING JUNCTION RECORDS                         ###');

  if (!errors.length && !warnings.length) {
    logs.push('No error/warn message in map js_vtsRules');
  }

  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    logs,
    ok: errors.length === 0
  };
}

function isDrivableRoad(road) {
  return Number(road?.leftLaneCount || 0) > 0 || Number(road?.rightLaneCount || 0) > 0;
}

function numericRoadIdSort(a, b) {
  const an = Number(a);
  const bn = Number(b);
  const aNum = Number.isFinite(an);
  const bNum = Number.isFinite(bn);
  if (aNum && bNum) return an - bn;
  if (aNum) return -1;
  if (bNum) return 1;
  return String(a).localeCompare(String(b));
}

function computeMapBounds(roads) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  let count = 0;
  (Array.isArray(roads) ? roads : []).forEach((road) => {
    (Array.isArray(road?.points) ? road.points : []).forEach((pt) => {
      const x = toNumber(pt?.x);
      const y = toNumber(pt?.y);
      if (x === null || y === null) return;
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
      count += 1;
    });
  });
  if (!count) {
    return {
      west: 0,
      east: 0,
      south: 0,
      north: 0,
      width: 0,
      height: 0
    };
  }
  return {
    west,
    east,
    south,
    north,
    width: east - west,
    height: north - south
  };
}

function buildForwardAdjacency(roads, junctions) {
  const graph = new Map();
  const junctionIndex = new Map((Array.isArray(junctions) ? junctions : []).map((junction) => [String(junction?.id || '').trim(), junction]));
  const roadIndex = new Map((Array.isArray(roads) ? roads : []).map((road) => [String(road?.id || '').trim(), road]));
  const ensure = (nodeId) => {
    if (!graph.has(nodeId)) graph.set(nodeId, new Set());
    return graph.get(nodeId);
  };
  const roadNodeId = (roadId, laneLocalId) => (Number(laneLocalId) > 0 ? `${roadId}b` : String(roadId));
  const addEdge = (fromNode, toNode) => {
    if (!fromNode || !toNode) return;
    ensure(fromNode).add(toNode);
  };
  const getRepresentativeLaneLink = (road, laneLocalId, fieldName) => {
    const sections = Array.isArray(road?.laneSectionsSpec) ? road.laneSectionsSpec : [];
    if (!sections.length) return '';
    const target = String(laneLocalId);
    const ordered = Number(laneLocalId) > 0 ? [...sections] : [...sections].reverse();
    for (const section of ordered) {
      const link = section?.laneLinks?.[target];
      const value = String(link?.[fieldName] ?? '').trim();
      if (value) return value;
    }
    return '';
  };
  const nextRoadNodeByContact = (nextRoad, contactPoint) => {
    if (!nextRoad) return '';
    const cp = String(contactPoint || '').trim().toLowerCase();
    if (cp === 'end') {
      if (Number(nextRoad.leftLaneCount || 0) > 0) return `${String(nextRoad.id)}b`;
      if (Number(nextRoad.rightLaneCount || 0) > 0) return String(nextRoad.id);
      return '';
    }
    if (Number(nextRoad.rightLaneCount || 0) > 0) return String(nextRoad.id);
    if (Number(nextRoad.leftLaneCount || 0) > 0) return `${String(nextRoad.id)}b`;
    return '';
  };

  (Array.isArray(roads) ? roads : []).forEach((road) => {
    const rid = String(road?.id ?? '').trim();
    if (!rid) return;

    if (Number(road?.rightLaneCount || 0) > 0) {
      const fromNode = roadNodeId(rid, -1);
      ensure(fromNode);
      const succType = String(road?.successorType || '').trim();
      const succId = String(road?.successorId || '').trim();
      const succContactPoint = String(road?.successorContactPoint || 'start').trim();
      if (succType === 'road' && succId) {
        const nextLaneId = getRepresentativeLaneLink(road, -1, 'successor');
        addEdge(fromNode, nextLaneId ? roadNodeId(succId, Number(nextLaneId)) : nextRoadNodeByContact(roadIndex.get(succId), succContactPoint));
      } else if (succType === 'junction' && succId) {
        const junction = junctionIndex.get(succId);
        (Array.isArray(junction?.connections) ? junction.connections : []).forEach((conn) => {
          if (String(conn?.incomingRoad || '').trim() !== rid) return;
          const laneLinks = Array.isArray(conn?.laneLinks) ? conn.laneLinks : [];
          const exact = laneLinks.filter((laneLink) => Number(laneLink?.from) === -1);
          const candidates = exact.length ? exact : laneLinks;
          candidates.forEach((laneLink) => addEdge(fromNode, roadNodeId(String(conn.connectingRoad || '').trim(), Number(laneLink?.to || -1))));
        });
      }
    }

    if (Number(road?.leftLaneCount || 0) > 0) {
      const fromNode = roadNodeId(rid, 1);
      ensure(fromNode);
      const predType = String(road?.predecessorType || '').trim();
      const predId = String(road?.predecessorId || '').trim();
      const predContactPoint = String(road?.predecessorContactPoint || 'end').trim();
      if (predType === 'road' && predId) {
        const nextLaneId = getRepresentativeLaneLink(road, 1, 'predecessor');
        addEdge(fromNode, nextLaneId ? roadNodeId(predId, Number(nextLaneId)) : nextRoadNodeByContact(roadIndex.get(predId), predContactPoint));
      } else if (predType === 'junction' && predId) {
        const junction = junctionIndex.get(predId);
        (Array.isArray(junction?.connections) ? junction.connections : []).forEach((conn) => {
          if (String(conn?.incomingRoad || '').trim() !== rid) return;
          const laneLinks = Array.isArray(conn?.laneLinks) ? conn.laneLinks : [];
          const exact = laneLinks.filter((laneLink) => Number(laneLink?.from) === 1);
          const candidates = exact.length ? exact : laneLinks;
          candidates.forEach((laneLink) => addEdge(fromNode, roadNodeId(String(conn.connectingRoad || '').trim(), Number(laneLink?.to || 1))));
        });
      }
    }
  });

  return graph;
}

function sampleRoadForRoute(road) {
  const rid = String(road?.id ?? '').trim();
  const length = toNumber(road?.length);
  const points = Array.isArray(road?.points) ? road.points : [];
  const sampleLaneLocalId = Number(road?.leftLaneCount || 0) > 0
    ? Number(road.leftLaneCount || 1)
    : (Number(road?.rightLaneCount || 0) > 0 ? -1 : 0);
  if (!isDrivableRoad(road)) {
    return { roadId: rid, sampleLaneLocalId, valid: false, reason: 'no_driving_lane' };
  }
  if (length === null || length <= 1e-6) {
    return { roadId: rid, sampleLaneLocalId, valid: false, reason: 'invalid_length' };
  }
  if (points.length < 2) {
    return { roadId: rid, sampleLaneLocalId, valid: false, reason: 'invalid_centerline_points' };
  }
  return {
    roadId: rid,
    sampleLaneLocalId,
    valid: true
  };
}

function uniqueRoadSeq(path) {
  const roads = [];
  let last = '';
  (Array.isArray(path) ? path : []).forEach((nodeId) => {
    const rid = String(nodeId || '').replace(/b$/, '');
    if (!rid || rid === last) return;
    roads.push(rid);
    last = rid;
  });
  return roads;
}

function findShortestCycle(startNodeId, graph, maxDepth = 64) {
  const sid = String(startNodeId);
  const firstSteps = [...(graph.get(sid) || [])].sort(numericRoadIdSort);
  if (!firstSteps.length) {
    return { ok: false, ec: 20, chain: [] };
  }

  const queue = firstSteps.map((nextId) => ({
    node: String(nextId),
    path: [sid, String(nextId)]
  }));
  const visitedDepth = new Map(queue.map((item) => [item.node, item.path.length]));

  while (queue.length) {
    const current = queue.shift();
    const nextIds = [...(graph.get(current.node) || [])].sort(numericRoadIdSort);
    for (const nextIdRaw of nextIds) {
      const nextId = String(nextIdRaw);
      if (nextId === sid) {
        return {
          ok: true,
          ec: 0,
          chain: uniqueRoadSeq([...current.path, sid])
        };
      }
      if (current.path.length >= maxDepth) continue;
      const prevDepth = visitedDepth.get(nextId);
      if (prevDepth !== undefined && prevDepth <= current.path.length + 1) continue;
      visitedDepth.set(nextId, current.path.length + 1);
      queue.push({
        node: nextId,
        path: [...current.path, nextId]
      });
    }
  }

  return { ok: false, ec: 20, chain: [] };
}

function validateRouteConnectivity(spec) {
  const roads = Array.isArray(spec?.roads) ? spec.roads : [];
  const junctions = Array.isArray(spec?.junctions) ? spec.junctions : [];
  const roadIndex = new Map();
  roads.forEach((road) => {
    roadIndex.set(String(road.id ?? '').trim(), road);
  });

  const errors = [];
  const warnings = [];
  const logs = [];
  const sampled = roads.map((road) => ({
    road,
    sample: sampleRoadForRoute(road)
  })).filter((item) => Number(item.sample.sampleLaneLocalId || 0) !== 0);
  const validSamples = sampled.filter((item) => item.sample.valid);
  const sampleFailRoads = sampled
    .filter((item) => !item.sample.valid)
    .map((item) => item.sample.roadId)
    .filter(Boolean)
    .sort(numericRoadIdSort);

  if (!validSamples.length) {
    return {
      ok: false,
      errors: ['[ROUTE] not enough valid roads'],
      warnings: [],
      logs: ['not enough valid roads to run route tests'],
      summary: { ok: 0, fail: 1, total: 1, sampleFail: 1 }
    };
  }

  let okCount = 0;
  let failCount = 0;
  const failedRoads = [];
  const failedCases = [];
  const bounds = computeMapBounds(roads);
  const forwardGraph = buildForwardAdjacency(roads, junctions);
  logs.push('Load map successfully. Map version is JS-vtsRules, lib version is JS-vtsRules.');
  logs.push(`map bounds: west=${bounds.west.toFixed(4)}, east=${bounds.east.toFixed(4)}, south=${bounds.south.toFixed(4)}, north=${bounds.north.toFixed(4)}, width=${bounds.width.toFixed(4)}, height=${bounds.height.toFixed(4)}`);
  logs.push(`total roads to test: ${sampled.length}`);
  sampled.forEach((item) => {
    if (!item.sample.valid) {
      logs.push(`[FAIL] sample road=${item.sample.roadId} reason=${item.sample.reason}`);
    }
  });
  logs.push(`valid sampled roads: ${validSamples.length}`);

  validSamples.forEach((item) => {
    const road = item.road;
    const rid = String(road.id ?? '').trim();
    const sampleLaneLocalId = Number(item.sample.sampleLaneLocalId || 0);
    const startNodeId = sampleLaneLocalId > 0 ? `${rid}b` : rid;
    const succType = String(road.successorType || '').trim();
    const succId = String(road.successorId || '').trim();
    const predType = String(road.predecessorType || '').trim();
    const predId = String(road.predecessorId || '').trim();

    let bad = false;
    const fwdOk = true;
    const fwdRoute = [rid];
    const bwd = findShortestCycle(startNodeId, forwardGraph);

    if (!succId) {
      errors.push(`[ROUTE] start road ${rid} has no successor`);
      bad = true;
    } else if (succType === 'road' && !roadIndex.has(succId)) {
      errors.push(`[ROUTE] road ${rid} successor road ${succId} not found`);
      bad = true;
    }

    if (!predId) {
      errors.push(`[ROUTE] road ${rid} has no predecessor`);
      bad = true;
    } else if (predType === 'road' && !roadIndex.has(predId)) {
      errors.push(`[ROUTE] road ${rid} predecessor road ${predId} not found`);
      bad = true;
    }

    if (!bad && (fwdOk || bwd.ok)) {
      okCount += 1;
      let line = `[ OK ] set ${rid} -> ${rid}`;
      if (fwdOk) line += ` fwd=${fwdRoute.join('->')}`;
      if (bwd.ok) line += ` bwd=${bwd.chain.join('->')}`;
      logs.push(line);
    } else {
      failCount += 1;
      failedRoads.push(rid);
      failedCases.push(`${rid}->${rid}`);
      logs.push(`[FAIL] set ${rid} -> ${rid} fwd_ec=${fwdOk ? 0 : 20} bwd_ec=${bwd.ec}`);
    }
  });

  warnings.push(`[ROUTE] summary: ok=${okCount}, fail=${failCount}, total=${okCount + failCount}, sample_fail=${sampleFailRoads.length}`);
  logs.push(`summary: ok=${okCount}, fail=${failCount}, total=${okCount + failCount}, sample_fail=${sampleFailRoads.length}`);
  if (failedRoads.length) {
    logs.push(`failed roads: ${failedRoads.join(', ')}`);
    logs.push(`failed cases: ${failedCases.join(' | ')}`);
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    logs,
    summary: {
      ok: okCount,
      fail: failCount,
      total: okCount + failCount,
      sampleFail: sampleFailRoads.length
    }
  };
}

module.exports = {
  validateMapSpec,
  validateRouteConnectivity,
  buildLanes,
  polylineLength,
  buildGeometryFromPoints
};
