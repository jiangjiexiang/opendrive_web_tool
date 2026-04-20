'use strict';

const { buildLanes, buildGeometryFromPoints, polylineLength } = require('./vtsRules');

function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function widthRecordsXml(widthSpec, fallbackWidth) {
  if (Array.isArray(widthSpec) && widthSpec.length) {
    return widthSpec.map((record) => (
      `            <width sOffset="${Number(record.sOffset || 0).toFixed(3)}" a="${Number(record.a || 0).toFixed(3)}" b="${Number(record.b || 0).toFixed(6)}" c="${Number(record.c || 0).toFixed(6)}" d="${Number(record.d || 0).toFixed(6)}"/>`
    )).join('\n');
  }
  return `            <width sOffset="0" a="${Number(fallbackWidth || 3.5).toFixed(3)}" b="0" c="0" d="0"/>`;
}

function laneLinkXml(linkSpec) {
  if (!linkSpec || (!linkSpec.predecessor && !linkSpec.successor && linkSpec.predecessor !== 0 && linkSpec.successor !== 0)) {
    return '';
  }
  const out = ['            <link>'];
  if (linkSpec.predecessor || linkSpec.predecessor === 0) {
    out.push(`              <predecessor id="${esc(linkSpec.predecessor)}"/>`);
  }
  if (linkSpec.successor || linkSpec.successor === 0) {
    out.push(`              <successor id="${esc(linkSpec.successor)}"/>`);
  }
  out.push('            </link>');
  return out.join('\n');
}

function laneXml(lane, widthSpec, fallbackWidth, linkSpec) {
  const laneLink = laneLinkXml(linkSpec);
  return [
    `          <lane id="${lane.id}" type="${esc(lane.type)}" level="false">`,
    laneLink,
    widthRecordsXml(widthSpec, fallbackWidth),
    '            <roadMark sOffset="0" type="solid" weight="standard" color="standard" width="0.15"/>',
    '          </lane>'
  ].filter(Boolean).join('\n');
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function laneCountForRole(road, endpoint, role) {
  const leftCount = Math.max(0, Number(road?.leftLaneCount || 0));
  const rightCount = Math.max(0, Number(road?.rightLaneCount || 0));
  if (role === 'incoming') {
    return endpoint === 'end' ? rightCount : leftCount;
  }
  return endpoint === 'end' ? leftCount : rightCount;
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

function addLaneLinks(targetLinks, ownEndpoint, ownRole, otherRoad, otherEndpoint, otherRole, fieldName) {
  if (!otherRoad) return;
  const ownCount = laneCountForRole(targetLinks.__road, ownEndpoint, ownRole);
  const otherCount = laneCountForRole(otherRoad, otherEndpoint, otherRole);
  if (ownCount <= 0 || otherCount <= 0) return;

  for (let lane = 1; lane <= ownCount; lane += 1) {
    const otherLane = mapLaneIndex(lane, ownCount, otherCount);
    const ownLaneId = laneIdForRole(ownEndpoint, ownRole, lane);
    const otherLaneId = laneIdForRole(otherEndpoint, otherRole, otherLane);
    const existing = targetLinks[ownLaneId] || {};
    targetLinks[ownLaneId] = {
      ...existing,
      [fieldName]: otherLaneId
    };
  }
}

function inferRoadLaneLinks(road, roadIndex) {
  if (!road || road.laneLinkSpec) {
    return road?.laneLinkSpec || {};
  }

  const laneLinks = { __road: road };
  const predecessorId = road.predecessorId === undefined || road.predecessorId === null
    ? ''
    : String(road.predecessorId).trim();
  const successorId = road.successorId === undefined || road.successorId === null
    ? ''
    : String(road.successorId).trim();
  const predecessorType = String(road.predecessorType || 'road');
  const successorType = String(road.successorType || 'road');
  const predecessorContactPoint = String(road.predecessorContactPoint || 'end');
  const successorContactPoint = String(road.successorContactPoint || 'start');

  if (predecessorType === 'road' && predecessorId) {
    addLaneLinks(
      laneLinks,
      'start',
      'outgoing',
      roadIndex.get(predecessorId),
      predecessorContactPoint,
      'outgoing',
      'predecessor'
    );
    addLaneLinks(
      laneLinks,
      'start',
      'incoming',
      roadIndex.get(predecessorId),
      predecessorContactPoint,
      'incoming',
      'successor'
    );
  }

  if (successorType === 'road' && successorId) {
    addLaneLinks(
      laneLinks,
      'end',
      'outgoing',
      roadIndex.get(successorId),
      successorContactPoint,
      'incoming',
      'successor'
    );
    addLaneLinks(
      laneLinks,
      'end',
      'incoming',
      roadIndex.get(successorId),
      successorContactPoint,
      'outgoing',
      'predecessor'
    );
  }

  delete laneLinks.__road;
  return laneLinks;
}

function normalizeGeometry(rawGeometry) {
  const normalized = [];
  let s = 0;
  for (const g of rawGeometry || []) {
    const length = num(g.length, 0);
    if (length <= 1e-8) continue;
    const roundedLength = Number(length.toFixed(6));
    normalized.push({
      s: Number(s.toFixed(6)),
      x: num(g.x, 0),
      y: num(g.y, 0),
      hdg: num(g.hdg, 0),
      length: roundedLength,
      type: g.type || 'line',
      curvature: num(g.curvature, 0),
      pRange: g.pRange || 'normalized',
      aU: num(g.aU, 0),
      bU: num(g.bU, 0),
      cU: num(g.cU, 0),
      dU: num(g.dU, 0),
      aV: num(g.aV, 0),
      bV: num(g.bV, 0),
      cV: num(g.cV, 0),
      dV: num(g.dV, 0)
    });
    s += roundedLength;
  }
  return {
    geometry: normalized,
    totalLength: Number(s.toFixed(6))
  };
}

function laneSectionXml(section, road, roadIndex) {
  const lanes = buildLanes(section.leftLaneCount, section.rightLaneCount, section.centerType);
  const laneWidth = Number(section.laneWidth || road.laneWidth || 3.5);
  const leftLaneWidth = Number(section.leftLaneWidth || laneWidth || 3.5);
  const rightLaneWidth = Number(section.rightLaneWidth || laneWidth || 3.5);
  const leftWidthRecords = section.leftWidthRecords || road.leftWidthRecords || null;
  const rightWidthRecords = section.rightWidthRecords || road.rightWidthRecords || null;
  const inferredLaneLinks = inferRoadLaneLinks(road, roadIndex);
  const laneLinks = { ...inferredLaneLinks };
  if (section.laneLinks && typeof section.laneLinks === 'object') {
    Object.entries(section.laneLinks).forEach(([laneId, linkSpec]) => {
      const inferred = laneLinks[laneId] || {};
      laneLinks[laneId] = { ...inferred, ...(linkSpec || {}) };
    });
  }
  // Ensure each non-center lane has a complete <link> with predecessor/successor.
  // When one side cannot be inferred (e.g. junction-boundary road), use same-lane fallback.
  lanes.forEach((lane) => {
    if (lane.side === 0) return;
    const laneId = String(lane.id);
    const current = laneLinks[laneId] || {};
    const hasPred = current.predecessor || current.predecessor === 0;
    const hasSucc = current.successor || current.successor === 0;
    laneLinks[laneId] = {
      predecessor: hasPred ? current.predecessor : lane.id,
      successor: hasSucc ? current.successor : lane.id
    };
  });
  const singleSide = (Number(section.leftLaneCount || 0) === 0) !== (Number(section.rightLaneCount || 0) === 0);
  const left = lanes.filter((l) => l.side === 1).map((l) => laneXml(l, leftWidthRecords, leftLaneWidth, laneLinks[l.id])).join('\n');
  const center = lanes.filter((l) => l.side === 0).map((l) => laneXml(l, [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }], 0, laneLinks[l.id])).join('\n');
  const right = lanes.filter((l) => l.side === -1).map((l) => laneXml(l, rightWidthRecords, rightLaneWidth, laneLinks[l.id])).join('\n');
  return [
    `      <laneSection s="${Number(section.s || 0).toFixed(3)}" singleSide="${singleSide ? 'true' : 'false'}">`,
    '        <left>',
    left,
    '        </left>',
    '        <center>',
    center,
    '        </center>',
    '        <right>',
    right,
    '        </right>',
    '      </laneSection>'
  ].join('\n');
}

function lanesBlockXml(road, roadIndex) {
  const sections = Array.isArray(road.laneSectionsSpec) && road.laneSectionsSpec.length
    ? road.laneSectionsSpec
    : [{
      s: 0,
      leftLaneCount: road.leftLaneCount,
      rightLaneCount: road.rightLaneCount,
      leftLaneWidth: road.leftLaneWidth,
      rightLaneWidth: road.rightLaneWidth,
      centerType: road.centerType || 'none',
      leftWidthRecords: road.leftWidthRecords || null,
      rightWidthRecords: road.rightWidthRecords || null
    }];
  const normalizedSections = [...sections]
    .map((section) => ({
      ...section,
      s: Number(section.s || 0)
    }))
    .sort((a, b) => a.s - b.s);

  return [
    '    <lanes>',
    ...(Array.isArray(road.laneOffsetRecords) && road.laneOffsetRecords.length
      ? road.laneOffsetRecords.map((r) => (
        `      <laneOffset s="${Number(r.sOffset || 0).toFixed(6)}" a="${Number(r.a || 0).toFixed(6)}" b="${Number(r.b || 0).toFixed(6)}" c="${Number(r.c || 0).toFixed(6)}" d="${Number(r.d || 0).toFixed(6)}"/>`
      ))
      : ['      <laneOffset s="0.000000" a="0.000000" b="0.000000" c="0.000000" d="0.000000"/>']),
    normalizedSections.map((section) => laneSectionXml(section, road, roadIndex)).join('\n'),
    '    </lanes>'
  ].join('\n');
}

function geometryXml(road) {
  const sourceGeometry = Array.isArray(road.geometry) && road.geometry.length
    ? road.geometry
    : buildGeometryFromPoints(road.points);
  const { geometry } = normalizeGeometry(sourceGeometry);

  if (!geometry.length) {
    const x = Number(road.x || 0);
    const y = Number(road.y || 0);
    const hdg = Number(road.hdg || 0);
    const length = Number(road.length || 1);
    return [
      `      <geometry s="0" x="${x.toFixed(3)}" y="${y.toFixed(3)}" hdg="${hdg.toFixed(6)}" length="${length.toFixed(3)}">`,
      '        <line/>',
      '      </geometry>'
    ].join('\n');
  }

  return geometry.map((g) => {
    const type = String(g.type || 'line').toLowerCase();
    let geomTag = '        <line/>';
    if (type === 'arc') {
      geomTag = `        <arc curvature="${Number(g.curvature || 0).toFixed(12)}"/>`;
    } else if (type === 'parampoly3') {
      geomTag = `        <paramPoly3 aU="${Number(g.aU || 0).toFixed(12)}" bU="${Number(g.bU || 0).toFixed(12)}" cU="${Number(g.cU || 0).toFixed(12)}" dU="${Number(g.dU || 0).toFixed(12)}" aV="${Number(g.aV || 0).toFixed(12)}" bV="${Number(g.bV || 0).toFixed(12)}" cV="${Number(g.cV || 0).toFixed(12)}" dV="${Number(g.dV || 0).toFixed(12)}" pRange="${esc(g.pRange || 'normalized')}"/>`;
    }
    return [
      `      <geometry s="${Number(g.s).toFixed(6)}" x="${Number(g.x).toFixed(6)}" y="${Number(g.y).toFixed(6)}" hdg="${Number(g.hdg).toFixed(6)}" length="${Number(g.length).toFixed(6)}">`,
      geomTag,
      '      </geometry>'
    ].join('\n');
  }).join('\n');
}

function junctionXml(junction) {
  if (junction && typeof junction.rawJunctionXml === 'string' && junction.rawJunctionXml.trim()) {
    return junction.rawJunctionXml.trim();
  }
  const id = String(junction.id);
  const name = String(junction.name || `junction_${id}`);
  const connections = Array.isArray(junction.connections) ? junction.connections : [];
  const vectorJunctionId = String(junction.vectorJunctionId || '').trim();
  return [
    `  <junction id="${esc(id)}" name="${esc(name)}">`,
    connections.map((conn, idx) => {
      const laneLinks = Array.isArray(conn.laneLinks) ? conn.laneLinks : [];
      return [
        `    <connection id="${esc(conn.id ?? idx)}" incomingRoad="${esc(conn.incomingRoad)}" connectingRoad="${esc(conn.connectingRoad)}" contactPoint="${esc(conn.contactPoint || 'start')}">`,
        laneLinks.map((link) => `      <laneLink from="${esc(link.from)}" to="${esc(link.to)}"/>`).join('\n'),
        '    </connection>'
      ].join('\n');
    }).join('\n'),
    vectorJunctionId
      ? [
        '    <userData>',
        `      <vectorJunction junctionId="${esc(vectorJunctionId)}"/>`,
        '    </userData>'
      ].join('\n')
      : '',
    '  </junction>'
  ].join('\n');
}

function roadXml(rawRoad, roadIndex) {
  if (rawRoad && typeof rawRoad.rawRoadXml === 'string' && rawRoad.rawRoadXml.trim()) {
    return rawRoad.rawRoadXml.trim();
  }
  const road = { ...rawRoad };
  const sourceGeometry = Array.isArray(road.geometry) && road.geometry.length
    ? road.geometry
    : buildGeometryFromPoints(road.points);
  const normalized = normalizeGeometry(sourceGeometry);
  if (normalized.geometry.length) {
    road.geometry = normalized.geometry;
    road.length = normalized.totalLength;
  }
  if (Array.isArray(road.points) && road.points.length >= 2) {
    if (!normalized.geometry.length) {
      road.length = Number(polylineLength(road.points).toFixed(6));
      road.geometry = buildGeometryFromPoints(road.points);
    }
    road.x = road.points[0].x;
    road.y = road.points[0].y;
    road.hdg = road.geometry[0]?.hdg || 0;
  }

  const rid = String(road.id);
  const junction = String(road.junction ?? '-1');
  const length = Number(road.length || 1);
  const predecessorId = road.predecessorId === undefined || road.predecessorId === null
    ? ''
    : String(road.predecessorId).trim();
  const successorId = road.successorId === undefined || road.successorId === null
    ? ''
    : String(road.successorId).trim();
  const predecessorType = String(road.predecessorType || 'road');
  const successorType = String(road.successorType || 'road');
  const predecessorContactPoint = String(road.predecessorContactPoint || 'end');
  const successorContactPoint = String(road.successorContactPoint || 'start');
  const linkLines = [];
  if (predecessorId || successorId) {
    linkLines.push('    <link>');
    if (predecessorId) {
      linkLines.push(
        `      <predecessor elementType="${esc(predecessorType)}" elementId="${esc(predecessorId)}" contactPoint="${esc(predecessorContactPoint)}"/>`
      );
    }
    if (successorId) {
      linkLines.push(
        `      <successor elementType="${esc(successorType)}" elementId="${esc(successorId)}" contactPoint="${esc(successorContactPoint)}"/>`
      );
    }
    linkLines.push('    </link>');
  }

  const typeRecords = Array.isArray(road.typeRecords) && road.typeRecords.length
    ? road.typeRecords
    : [{ s: 0, type: 'town', speedMax: '35', speedUnit: 'mph' }];
  const elevationRecords = Array.isArray(road.elevationRecords) && road.elevationRecords.length
    ? road.elevationRecords
    : [{ s: 0, a: 0, b: 0, c: 0, d: 0 }];
  const superelevationRecords = Array.isArray(road.superelevationRecords) && road.superelevationRecords.length
    ? road.superelevationRecords
    : [{ s: 0, a: 0, b: 0, c: 0, d: 0 }];
  const shapeRecords = Array.isArray(road.shapeRecords) && road.shapeRecords.length
    ? road.shapeRecords
    : [{ s: 0, t: -Number(road.rightLaneWidth || road.laneWidth || 3.5), a: 0, b: 0, c: 0, d: 0 }];

  return [
    `  <road name="road_${esc(rid)}" length="${length.toFixed(6)}" id="${esc(rid)}" junction="${esc(junction)}">`,
    ...linkLines,
    typeRecords.map((t) => [
      `    <type s="${Number(t.s || 0).toFixed(6)}" type="${esc(t.type || 'town')}">`,
      `      <speed max="${esc(t.speedMax ?? '35')}" unit="${esc(t.speedUnit || 'mph')}"/>`,
      '    </type>'
    ].join('\n')).join('\n'),
    '    <planView>',
    geometryXml(road),
    '    </planView>',
    '    <elevationProfile>',
    elevationRecords.map((e) => (
      `      <elevation s="${Number(e.s || 0).toFixed(6)}" a="${Number(e.a || 0).toFixed(6)}" b="${Number(e.b || 0).toFixed(6)}" c="${Number(e.c || 0).toFixed(6)}" d="${Number(e.d || 0).toFixed(6)}"/>`
    )).join('\n'),
    '    </elevationProfile>',
    '    <lateralProfile>',
    superelevationRecords.map((s) => (
      `      <superelevation s="${Number(s.s || 0).toFixed(6)}" a="${Number(s.a || 0).toFixed(6)}" b="${Number(s.b || 0).toFixed(6)}" c="${Number(s.c || 0).toFixed(6)}" d="${Number(s.d || 0).toFixed(6)}"/>`
    )).join('\n'),
    shapeRecords.map((s) => (
      `      <shape s="${Number(s.s || 0).toFixed(6)}" t="${Number(s.t || 0).toFixed(6)}" a="${Number(s.a || 0).toFixed(6)}" b="${Number(s.b || 0).toFixed(6)}" c="${Number(s.c || 0).toFixed(6)}" d="${Number(s.d || 0).toFixed(6)}"/>`
    )).join('\n'),
    '    </lateralProfile>',
    lanesBlockXml(road, roadIndex),
    '  </road>'
  ].join('\n');
}

function buildXodr(spec) {
  const header = spec.header || {};
  const roads = Array.isArray(spec.roads) ? spec.roads : [];
  const junctions = Array.isArray(spec.junctions) ? spec.junctions : [];
  const rawOpenDriveExtras = Array.isArray(spec.rawOpenDriveExtras) ? spec.rawOpenDriveExtras : [];
  const roadIndex = new Map(roads.map((road) => [String(road.id), road]));

  const headerXml = (typeof header.rawHeaderXml === 'string' && header.rawHeaderXml.trim())
    ? header.rawHeaderXml.trim()
    : `  <header revMajor="1" revMinor="4" name="${esc(header.name || 'web_generated_map')}" version="1.00" date="${esc(header.date || new Date().toISOString())}" north="${Number(header.north || 0)}" south="${Number(header.south || 0)}" east="${Number(header.east || 0)}" west="${Number(header.west || 0)}" vendor="${esc(header.vendor || 'opendrive_web_tool')}"/>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenDRIVE>',
    headerXml,
    roads.map((road) => roadXml(road, roadIndex)).join('\n'),
    junctions.map(junctionXml).join('\n'),
    rawOpenDriveExtras.map((x) => String(x || '').trim()).filter(Boolean).join('\n'),
    '</OpenDRIVE>',
    ''
  ].join('\n');
}

module.exports = {
  buildXodr
};
