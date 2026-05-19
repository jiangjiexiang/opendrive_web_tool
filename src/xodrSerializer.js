'use strict';

const { buildLanes, buildGeometryFromPoints, polylineLength } = require('./vtsRules');
const { sanitizeGeometryTypes } = require('./geometrySanitize.cjs');

function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function relativeWidthRecord(record, sectionS) {
  const s0 = num(sectionS, 0);
  const sOffset = num(record?.sOffset, 0);
  if (s0 <= 0 || sOffset < s0 - 1e-6) {
    return {
      sOffset,
      a: num(record?.a, 0),
      b: num(record?.b, 0),
      c: num(record?.c, 0),
      d: num(record?.d, 0)
    };
  }
  const a = num(record?.a, 0);
  const b = num(record?.b, 0);
  const c = num(record?.c, 0);
  const d = num(record?.d, 0);
  return {
    sOffset: Math.max(0, sOffset - s0),
    a: a + b * s0 + c * s0 * s0 + d * s0 * s0 * s0,
    b: b + 2 * c * s0 + 3 * d * s0 * s0,
    c: c + 3 * d * s0,
    d
  };
}

function widthRecordsXml(widthSpec, fallbackWidth, sectionS = 0) {
  if (Array.isArray(widthSpec) && widthSpec.length) {
    return widthSpec.map((record) => {
      const rel = relativeWidthRecord(record, sectionS);
      return `            <width sOffset="${Number(rel.sOffset || 0).toFixed(3)}" a="${Number(rel.a || fallbackWidth || 0).toFixed(3)}" b="${Number(rel.b || 0).toFixed(6)}" c="${Number(rel.c || 0).toFixed(6)}" d="${Number(rel.d || 0).toFixed(6)}"/>`;
    }).join('\n');
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

function roadMarksXml(lane) {
  const marks = Array.isArray(lane?.roadMarks) && lane.roadMarks.length
    ? lane.roadMarks
    : (lane?.roadMark ? [lane.roadMark] : []);
  if (!marks.length) {
    return '            <roadMark sOffset="0" type="solid" weight="standard" color="standard" width="0.15"/>';
  }
  return marks.map((mark) => (
    `            <roadMark sOffset="${Number(mark.sOffset || 0).toFixed(6)}" type="${esc(mark.type || 'solid')}" weight="${esc(mark.weight || 'standard')}" color="${esc(mark.color || 'standard')}" width="${Number(mark.width ?? 0.15).toFixed(6)}" material="${esc(mark.material || 'standard')}" laneChange="${esc(mark.laneChange || 'none')}"/>`
  )).join('\n');
}

function speedsXml(lane) {
  const speeds = Array.isArray(lane?.speeds) && lane.speeds.length
    ? lane.speeds
    : (lane?.speed ? [lane.speed] : []);
  if (!speeds.length) return '';
  return speeds.map((speed) => (
    `            <speed sOffset="${Number(speed.sOffset || 0).toFixed(6)}" max="${esc(speed.max ?? '35')}" unit="${esc(speed.unit || 'mph')}"/>`
  )).join('\n');
}

function laneXml(lane, widthSpec, fallbackWidth, linkSpec, sectionS = 0) {
  const laneLink = laneLinkXml(linkSpec);
  const isCenter = Number(lane.id) === 0;
  const level = String(lane.level ?? 'false');
  return [
    `          <lane id="${esc(lane.id)}" type="${esc(lane.type || (isCenter ? 'none' : 'driving'))}" level="${esc(level)}">`,
    laneLink,
    isCenter ? '' : widthRecordsXml(widthSpec, fallbackWidth, sectionS),
    isCenter ? '' : roadMarksXml(lane),
    isCenter ? '' : speedsXml(lane),
    '          </lane>'
  ].filter(Boolean).join('\n');
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
  const sanitized = sanitizeGeometryTypes(rawGeometry);
  const normalized = [];
  let s = 0;
  for (const g of sanitized) {
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
      curvStart: num(g.curvStart, 0),
      curvEnd: num(g.curvEnd, 0),
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

function mapLaneForExport(lane, side) {
  return {
    id: lane.id,
    side,
    type: lane.type || 'driving',
    level: lane.level || 'false',
    widthProfile: lane.widthProfile || null,
    roadMarks: Array.isArray(lane.roadMarks) ? lane.roadMarks.map((mark) => ({ ...mark })) : [],
    speeds: Array.isArray(lane.speeds) ? lane.speeds.map((speed) => ({ ...speed })) : []
  };
}

function lanesForSection(section) {
  const leftLanes = Array.isArray(section?.leftLanes) && section.leftLanes.length
    ? section.leftLanes.map((lane) => mapLaneForExport(lane, 1))
    : null;
  const rightLanes = Array.isArray(section?.rightLanes) && section.rightLanes.length
    ? section.rightLanes.map((lane) => mapLaneForExport(lane, -1))
    : null;
  if (leftLanes || rightLanes) {
    return [
      ...(leftLanes || []),
      { id: 0, side: 0, type: section?.centerType || 'none' },
      ...(rightLanes || [])
    ];
  }
  return buildLanes(section.leftLaneCount, section.rightLaneCount, section.centerType);
}

function isConnectorRoad(road) {
  const junction = String(road?.junction ?? '-1').trim();
  return junction !== '' && junction !== '-1';
}

function laneSectionXml(section, road, roadIndex) {
  const lanes = lanesForSection(section);
  const laneWidth = Number(section.laneWidth || road.laneWidth || 3.5);
  const leftLaneWidth = Number(section.leftLaneWidth || laneWidth || 3.5);
  const rightLaneWidth = Number(section.rightLaneWidth || laneWidth || 3.5);
  const leftWidthRecords = section.leftWidthRecords || road.leftWidthRecords || null;
  const rightWidthRecords = section.rightWidthRecords || road.rightWidthRecords || null;
  const sectionS = Number(section.s || 0);
  const connector = isConnectorRoad(road);
  const laneLinks = {};
  if (connector && section.laneLinks && typeof section.laneLinks === 'object') {
    Object.entries(section.laneLinks).forEach(([laneId, linkSpec]) => {
      if (!linkSpec || typeof linkSpec !== 'object') return;
      const pred = linkSpec.predecessor ?? linkSpec.predecessorId;
      const succ = linkSpec.successor ?? linkSpec.successorId;
      const hasPred = pred !== undefined && String(pred).trim() !== '';
      const hasSucc = succ !== undefined && String(succ).trim() !== '';
      if (!hasPred && !hasSucc) return;
      laneLinks[laneId] = {
        ...(hasPred ? { predecessor: pred } : {}),
        ...(hasSucc ? { successor: succ } : {})
      };
    });
  }
  const leftLanes = lanes.filter((l) => l.side === 1);
  const rightLanes = lanes.filter((l) => l.side === -1);
  const singleSide = String(section.singleSide || '').toLowerCase() === 'true'
    || ((leftLanes.length === 0) !== (rightLanes.length === 0));
  const left = leftLanes.map((l) => laneXml(l, l.widthProfile || leftWidthRecords, leftLaneWidth, laneLinks[l.id], sectionS)).join('\n');
  const center = lanes.filter((l) => l.side === 0).map((l) => laneXml(l, null, 0, laneLinks[l.id], sectionS)).join('\n');
  const right = rightLanes.map((l) => laneXml(l, l.widthProfile || rightWidthRecords, rightLaneWidth, laneLinks[l.id], sectionS)).join('\n');
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
  const fallbackLeftLaneCount = Number(road.leftLaneCount || 0);
  const fallbackRightLaneCount = Number(road.rightLaneCount || 0);
  const useSingleLaneFallback = fallbackLeftLaneCount <= 0 && fallbackRightLaneCount <= 0;
  const sections = Array.isArray(road.laneSectionsSpec) && road.laneSectionsSpec.length
    ? road.laneSectionsSpec
    : Array.isArray(road.laneSections) && road.laneSections.length
      ? road.laneSections
      : [{
      s: 0,
      leftLaneCount: useSingleLaneFallback ? 0 : fallbackLeftLaneCount,
      rightLaneCount: useSingleLaneFallback ? 1 : fallbackRightLaneCount,
      leftLaneWidth: road.leftLaneWidth,
      rightLaneWidth: road.rightLaneWidth,
      centerType: road.centerType || 'none',
      leftWidthRecords: road.leftWidthRecords || null,
      rightWidthRecords: road.rightWidthRecords || null
    }];
  const normalizedSections = [...sections]
    .map((section) => ({
      ...section,
      leftLaneCount: Number(section.leftLaneCount || 0) <= 0 && Number(section.rightLaneCount || 0) <= 0
        ? 0
        : Number(section.leftLaneCount || 0),
      rightLaneCount: Number(section.leftLaneCount || 0) <= 0 && Number(section.rightLaneCount || 0) <= 0
        ? 1
        : Number(section.rightLaneCount || 0),
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
    if (type === 'spiral') {
      geomTag = `        <spiral curvStart="${Number(g.curvStart || 0).toFixed(12)}" curvEnd="${Number(g.curvEnd || 0).toFixed(12)}"/>`;
    } else if (type === 'arc') {
      geomTag = `        <arc curvature="${Number(g.curvature || 0).toFixed(12)}"/>`;
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

function readTagName(xml, ltIndex) {
  const match = String(xml || '').slice(ltIndex).match(/^<\/?\s*([A-Za-z_][\w:.-]*)/);
  return match ? match[1] : '';
}

function findTagEnd(xml, ltIndex) {
  let quote = '';
  for (let i = ltIndex + 1; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function splitRoadXml(rawXml) {
  const source = String(rawXml || '').trim();
  const openStart = source.search(/<road\b/i);
  const closeStart = source.lastIndexOf('</road>');
  if (openStart < 0 || closeStart < 0) return null;
  const openEnd = findTagEnd(source, openStart);
  if (openEnd < 0 || openEnd >= closeStart) return null;
  return {
    openTag: source.slice(openStart, openEnd + 1),
    inner: source.slice(openEnd + 1, closeStart),
    closeTag: source.slice(closeStart, closeStart + '</road>'.length)
  };
}

function topLevelXmlBlocks(innerXml) {
  const blocks = [];
  const xml = String(innerXml || '');
  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf('<', i);
    if (start < 0) break;
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      if (end < 0) break;
      blocks.push({ tag: '#comment', xml: xml.slice(start, end + 3) });
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) break;
      blocks.push({ tag: '#cdata', xml: xml.slice(start, end + 3) });
      i = end + 3;
      continue;
    }
    const tag = readTagName(xml, start);
    if (!tag || xml[start + 1] === '/') {
      i = start + 1;
      continue;
    }

    let depth = 0;
    let cursor = start;
    let endOfBlock = -1;
    while (cursor < xml.length) {
      const lt = xml.indexOf('<', cursor);
      if (lt < 0) break;
      if (xml.startsWith('<!--', lt)) {
        const commentEnd = xml.indexOf('-->', lt + 4);
        if (commentEnd < 0) break;
        cursor = commentEnd + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const cdataEnd = xml.indexOf(']]>', lt + 9);
        if (cdataEnd < 0) break;
        cursor = cdataEnd + 3;
        continue;
      }
      const gt = findTagEnd(xml, lt);
      if (gt < 0) break;
      const isClosing = xml[lt + 1] === '/';
      const isSelfClosing = xml[gt - 1] === '/';
      if (!isClosing) {
        depth += 1;
        if (isSelfClosing) depth -= 1;
      } else {
        depth -= 1;
      }
      cursor = gt + 1;
      if (depth <= 0) {
        endOfBlock = cursor;
        break;
      }
    }
    if (endOfBlock < 0) break;
    blocks.push({ tag, xml: xml.slice(start, endOfBlock) });
    i = endOfBlock;
  }
  return blocks;
}

function generatedRoadSections(generatedRoadXml) {
  const split = splitRoadXml(generatedRoadXml);
  if (!split) return null;
  const sections = {};
  topLevelXmlBlocks(split.inner).forEach((block) => {
    if (!sections[block.tag]) sections[block.tag] = [];
    sections[block.tag].push(block.xml.trim());
  });
  return { openTag: split.openTag, sections };
}

function patchRawRoadXml(rawRoadXml, generatedXml, road = null) {
  const raw = splitRoadXml(rawRoadXml);
  const generated = generatedRoadSections(generatedXml);
  if (!raw || !generated) return generatedXml;
  const managedTags = new Set(['link', 'type', 'planView', 'elevationProfile', 'lateralProfile', 'lanes']);
  const unknownBlocks = topLevelXmlBlocks(raw.inner)
    .filter((block) => !managedTags.has(block.tag))
    .map((block) => block.xml.trim())
    .filter(Boolean);
  const preserveImportedGeometry = road && road.geometryDirty === false
    && Array.isArray(road.geometry) && road.geometry.length;
  const rawBlocksByTag = {};
  topLevelXmlBlocks(raw.inner).forEach((block) => {
    if (!rawBlocksByTag[block.tag]) rawBlocksByTag[block.tag] = [];
    rawBlocksByTag[block.tag].push(block.xml.trim());
  });
  const managedOrder = ['link', 'type', 'planView', 'elevationProfile', 'lateralProfile', 'lanes'];
  const managedBlocks = managedOrder.flatMap((tag) => {
    if (tag === 'planView' && preserveImportedGeometry && rawBlocksByTag.planView?.length) {
      return rawBlocksByTag.planView;
    }
    return generated.sections[tag] || [];
  });
  return [
    generated.openTag,
    ...managedBlocks.map((block) => block.replace(/^/gm, '  ')),
    ...unknownBlocks.map((block) => block.replace(/^/gm, '  ')),
    '  </road>'
  ].join('\n');
}

function generatedRoadXml(rawRoad, roadIndex) {
  const road = { ...rawRoad };
  delete road.rawRoadXml;
  delete road.patchRawRoadXml;
  const hasImportedGeometry = road.geometryDirty === false
    && Array.isArray(road.geometry) && road.geometry.length;
  const sourceGeometry = hasImportedGeometry
    ? road.geometry
    : (Array.isArray(road.geometry) && road.geometry.length
      ? road.geometry
      : buildGeometryFromPoints(road.points));
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
  let predecessorId = road.predecessorId === undefined || road.predecessorId === null
    ? ''
    : String(road.predecessorId).trim();
  let successorId = road.successorId === undefined || road.successorId === null
    ? ''
    : String(road.successorId).trim();
  const predecessorType = String(road.predecessorType || 'road');
  const successorType = String(road.successorType || 'road');
  const predecessorContactPoint = String(road.predecessorContactPoint || 'end');
  const successorContactPoint = String(road.successorContactPoint || 'start');
  if (predecessorType === 'road' && predecessorId === rid) predecessorId = '';
  if (successorType === 'road' && successorId === rid) successorId = '';
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
    `  <road name="road${esc(rid)}" length="${length.toFixed(6)}" id="${esc(rid)}" junction="${esc(junction)}">`,
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

function roadXml(rawRoad, roadIndex) {
  const rawRoadXml = String(rawRoad?.rawRoadXml || '').trim();
  if (rawRoadXml && !rawRoad?.patchRawRoadXml) {
    return rawRoadXml;
  }
  const generated = generatedRoadXml(rawRoad, roadIndex);
  if (rawRoadXml && rawRoad?.patchRawRoadXml) {
    return patchRawRoadXml(rawRoadXml, generated, rawRoad);
  }
  return generated;
}

function buildXodr(spec) {
  const header = spec.header || {};
  const roads = Array.isArray(spec.roads) ? spec.roads : [];
  const junctions = Array.isArray(spec.junctions) ? spec.junctions : [];
  const rawOpenDriveExtras = Array.isArray(spec.rawOpenDriveExtras) ? spec.rawOpenDriveExtras : [];
  const roadIndex = new Map(roads.map((road) => [String(road.id), road]));
  const bounds = roads.reduce((acc, road) => {
    const points = Array.isArray(road?.points) ? road.points : [];
    points.forEach((point) => {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      acc.minX = Math.min(acc.minX, x);
      acc.maxX = Math.max(acc.maxX, x);
      acc.minY = Math.min(acc.minY, y);
      acc.maxY = Math.max(acc.maxY, y);
    });
    return acc;
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const hasBounds = Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxY);
  const north = hasBounds ? bounds.maxY : Number(header.north || 0);
  const south = hasBounds ? bounds.minY : Number(header.south || 0);
  const east = hasBounds ? bounds.maxX : Number(header.east || 0);
  const west = hasBounds ? bounds.minX : Number(header.west || 0);

  const rawHeaderXml = String(header.rawHeaderXml || '').trim();
  const headerXml = rawHeaderXml || [
    `  <header revMajor="1" revMinor="4" name="${esc(header.name || 'web_editor_map')}" version="1" date="${esc(header.date || new Date().toISOString())}" north="${north}" south="${south}" east="${east}" west="${west}" >`,
    '    <geoReference><![CDATA[]]></geoReference>',
    '    <userData>',
    '      <vectorScene program="web_editor_map"/>',
    '    </userData>',
    '  </header>'
  ].join('\n');

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
