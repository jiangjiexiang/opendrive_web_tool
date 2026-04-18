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

function validateMapSpec(spec) {
  const errors = [];
  const warnings = [];

  const header = spec?.header || {};
  const north = toNumber(header.north);
  const south = toNumber(header.south);
  const east = toNumber(header.east);
  const west = toNumber(header.west);

  if ([north, south, east, west].some((v) => v === null)) {
    errors.push('[ ERROR ] : no east/south/west/north in map header');
  } else if (east < west || south > north) {
    warnings.push('[ Warning ] : invalid value of east/south/west/north');
  }

  const roads = Array.isArray(spec?.roads) ? spec.roads : [];
  if (!roads.length) {
    errors.push('[ ERROR ] : no road in map');
  }

  const seenIds = new Set();

  for (const road of roads) {
    const rid = String(road.id ?? '').trim();
    const jid = String(road.junction ?? '-1').trim();

    if (!isIntegerLike(rid)) {
      errors.push(`[ ERROR ] : [Road ${rid || 'unknown'}]: id is not pure number`);
    }
    if (!isIntegerLike(jid)) {
      errors.push(`[ ERROR ] : [Road ${rid || 'unknown'}]: junction record is not pure number`);
    }

    if (seenIds.has(rid)) {
      errors.push(`[ ERROR ] : exist duplicated road id ${rid}`);
    }
    seenIds.add(rid);

    if (Array.isArray(road.points) && road.points.length >= 2) {
      road.length = Number(polylineLength(road.points).toFixed(3));
      road.geometry = buildGeometryFromPoints(road.points);
    }

    const length = toNumber(road.length);
    if (length === null || length <= 0) {
      errors.push(`[ ERROR ] : [Road ${rid}] road length is invalid`);
    }

    validateGeometryConsistency(road, errors);

    const lanes = buildLanes(road.leftLaneCount, road.rightLaneCount, road.centerType);
    const sortedDesc = [...lanes].sort((a, b) => b.id - a.id);
    let prev = sortedDesc[0]?.id + 1;
    for (const lane of sortedDesc) {
      if (prev - lane.id !== 1) {
        errors.push(`[ ERROR ] : [Road ${rid}]: lane id is not in lanes sequence`);
        break;
      }
      prev = lane.id;

      if (lane.side === 1 && lane.id < 1) {
        errors.push(`[ ERROR ] : [Road ${rid}]: left lane id is invalid`);
      }
      if (lane.side === 0 && lane.id !== 0) {
        errors.push(`[ ERROR ] : [Road ${rid}]: center lane id is not 0`);
      }
      if (lane.side === -1 && lane.id > -1) {
        errors.push(`[ ERROR ] : [Road ${rid}]: right lane id is invalid`);
      }
      if (!['driving', 'sidewalk', 'bicycle', 'none'].includes(lane.type)) {
        warnings.push(`[ Warning ] : [Road ${rid}]: type of line is invalid`);
      }
      if (lane.side === 0 && lane.type === 'driving') {
        warnings.push(`[ Warning ] : [Road ${rid}]: type of center line is driving`);
      }
    }

    if (jid !== '-1') {
      const predType = String(road.predecessorType || 'road');
      const succType = String(road.successorType || 'road');
      if (predType !== 'road' || succType !== 'road') {
        errors.push(`[ ERROR ] : [Road ${rid}] junction record is not -1 while roadlinks' elementTypes are not both road`);
      }
      if (Number(road.rightLaneCount || 0) > 1) {
        warnings.push(`[ Warning ] : [Road ${rid}] in junction usually keep one center lane and one right lane(id=-1)`);
      }
    }
  }

  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    ok: errors.length === 0
  };
}

module.exports = {
  validateMapSpec,
  buildLanes,
  polylineLength,
  buildGeometryFromPoints
};
