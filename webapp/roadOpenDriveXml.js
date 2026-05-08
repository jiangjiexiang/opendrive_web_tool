function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizePoints(points, minStep = 0.05) {
  const out = [];
  (Array.isArray(points) ? points : []).forEach((pt) => {
    const next = { x: Number(pt?.x), y: Number(pt?.y) };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return;
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - next.x, last.y - next.y) >= minStep) {
      out.push(next);
    }
  });
  return out;
}

function buildGeometryFromPoints(points) {
  const pts = sanitizePoints(points, 0.05);
  const geometry = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (length <= 1e-8) continue;
    geometry.push({
      s,
      x: p0.x,
      y: p0.y,
      hdg: Math.atan2(p1.y - p0.y, p1.x - p0.x),
      length,
      type: 'line'
    });
    s += length;
  }
  return geometry;
}

function normalizeGeometry(road) {
  const source = Array.isArray(road?.geometry) && road.geometry.length
    ? road.geometry
    : buildGeometryFromPoints(road?.points || []);
  const geometry = [];
  let s = 0;
  (Array.isArray(source) ? source : []).forEach((raw) => {
    const length = num(raw?.length, 0);
    if (length <= 1e-8) return;
    geometry.push({
      ...raw,
      s: Number(s.toFixed(6)),
      x: num(raw?.x, 0),
      y: num(raw?.y, 0),
      hdg: num(raw?.hdg, 0),
      length: Number(length.toFixed(6)),
      type: String(raw?.type || 'line')
    });
    s += length;
  });
  return {
    geometry,
    length: Number(s.toFixed(6))
  };
}

function geometryXml(road) {
  const { geometry } = normalizeGeometry(road);
  if (!geometry.length) {
    return [
      `      <geometry s="0.000000" x="${num(road?.x, 0).toFixed(6)}" y="${num(road?.y, 0).toFixed(6)}" hdg="${num(road?.hdg, 0).toFixed(6)}" length="${num(road?.length, 1).toFixed(6)}">`,
      '        <line/>',
      '      </geometry>'
    ].join('\n');
  }
  return geometry.map((g) => {
    const type = String(g.type || 'line').toLowerCase();
    let tag = '        <line/>';
    if (type === 'arc') {
      tag = `        <arc curvature="${num(g.curvature, 0).toFixed(12)}"/>`;
    } else if (type === 'spiral') {
      tag = `        <spiral curvStart="${num(g.curvStart, 0).toFixed(12)}" curvEnd="${num(g.curvEnd, 0).toFixed(12)}"/>`;
    } else if (type === 'parampoly3') {
      tag = `        <paramPoly3 aU="${num(g.aU, 0).toFixed(12)}" bU="${num(g.bU, 0).toFixed(12)}" cU="${num(g.cU, 0).toFixed(12)}" dU="${num(g.dU, 0).toFixed(12)}" aV="${num(g.aV, 0).toFixed(12)}" bV="${num(g.bV, 0).toFixed(12)}" cV="${num(g.cV, 0).toFixed(12)}" dV="${num(g.dV, 0).toFixed(12)}" pRange="${esc(g.pRange || 'normalized')}"/>`;
    }
    return [
      `      <geometry s="${num(g.s, 0).toFixed(6)}" x="${num(g.x, 0).toFixed(6)}" y="${num(g.y, 0).toFixed(6)}" hdg="${num(g.hdg, 0).toFixed(6)}" length="${num(g.length, 0).toFixed(6)}">`,
      tag,
      '      </geometry>'
    ].join('\n');
  }).join('\n');
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

function widthXml(records, fallbackWidth, sectionS = 0) {
  if (Array.isArray(records) && records.length) {
    return records.map((record) => {
      const rel = relativeWidthRecord(record, sectionS);
      return `            <width sOffset="${num(rel.sOffset, 0).toFixed(3)}" a="${num(rel.a, fallbackWidth).toFixed(3)}" b="${num(rel.b, 0).toFixed(6)}" c="${num(rel.c, 0).toFixed(6)}" d="${num(rel.d, 0).toFixed(6)}"/>`;
    }).join('\n');
  }
  return `            <width sOffset="0.000" a="${num(fallbackWidth, 3.5).toFixed(3)}" b="0.000000" c="0.000000" d="0.000000"/>`;
}

function laneXml(id, type, widthRecords, fallbackWidth, linkSpec = null, sectionS = 0) {
  const linkLines = [];
  if (linkSpec && (linkSpec.predecessor !== undefined || linkSpec.successor !== undefined)) {
    linkLines.push('            <link>');
    if (linkSpec.predecessor !== undefined) {
      linkLines.push(`              <predecessor id="${esc(linkSpec.predecessor)}"/>`);
    }
    if (linkSpec.successor !== undefined) {
      linkLines.push(`              <successor id="${esc(linkSpec.successor)}"/>`);
    }
    linkLines.push('            </link>');
  }
  return [
    `          <lane id="${esc(id)}" type="${esc(type || 'driving')}" level="false">`,
    ...linkLines,
    Number(id) === 0 ? '' : widthXml(widthRecords, fallbackWidth, sectionS),
    Number(id) === 0 ? '' : '            <roadMark sOffset="0" type="solid" weight="standard" color="standard" width="0.15"/>',
    '          </lane>'
  ].filter(Boolean).join('\n');
}

function laneSectionXml(section, road) {
  const leftLanes = Array.isArray(section?.leftLanes) && section.leftLanes.length
    ? section.leftLanes
    : Array.from({ length: Math.max(0, Number(section?.leftLaneCount ?? road?.leftLaneCount ?? 0)) }, (_, i) => ({ id: i + 1, type: section?.centerType || road?.centerType || 'driving' }));
  const rightLanes = Array.isArray(section?.rightLanes) && section.rightLanes.length
    ? section.rightLanes
    : Array.from({ length: Math.max(0, Number(section?.rightLaneCount ?? road?.rightLaneCount ?? 0)) }, (_, i) => ({ id: -(i + 1), type: 'driving' }));
  const laneLinks = section?.laneLinks || {};
  const sectionS = num(section?.s, 0);
  const leftWidth = num(section?.leftLaneWidth ?? road?.leftLaneWidth ?? road?.laneWidth, 3.5);
  const rightWidth = num(section?.rightLaneWidth ?? road?.rightLaneWidth ?? road?.laneWidth, 3.5);
  const singleSide = (leftLanes.length === 0) !== (rightLanes.length === 0);
  return [
    `      <laneSection s="${num(section?.s, 0).toFixed(3)}" singleSide="${singleSide ? 'true' : 'false'}">`,
    '        <left>',
    leftLanes.map((lane) => laneXml(lane.id, lane.type || 'driving', lane.widthProfile || section?.leftWidthRecords || road?.leftWidthRecords, leftWidth, laneLinks[lane.id], sectionS)).join('\n'),
    '        </left>',
    '        <center>',
    laneXml(0, section?.centerType === 'none' ? 'none' : (section?.centerType || road?.centerType || 'none'), null, 0, laneLinks[0], sectionS),
    '        </center>',
    '        <right>',
    rightLanes.map((lane) => laneXml(lane.id, lane.type || 'driving', lane.widthProfile || section?.rightWidthRecords || road?.rightWidthRecords, rightWidth, laneLinks[lane.id], sectionS)).join('\n'),
    '        </right>',
    '      </laneSection>'
  ].join('\n');
}

function lanesXml(road) {
  const sections = Array.isArray(road?.laneSectionsSpec) && road.laneSectionsSpec.length
    ? road.laneSectionsSpec
    : Array.isArray(road?.laneSections) && road.laneSections.length
      ? road.laneSections
      : [{
        s: 0,
        leftLaneCount: num(road?.leftLaneCount, 1),
        rightLaneCount: num(road?.rightLaneCount, 1),
        leftLaneWidth: num(road?.leftLaneWidth ?? road?.laneWidth, 3.5),
        rightLaneWidth: num(road?.rightLaneWidth ?? road?.laneWidth, 3.5),
        centerType: road?.centerType || 'none'
      }];
  const laneOffsets = Array.isArray(road?.laneOffsetRecords) && road.laneOffsetRecords.length
    ? road.laneOffsetRecords
    : [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }];
  return [
    '    <lanes>',
    laneOffsets.map((record) => (
      `      <laneOffset s="${num(record?.sOffset, 0).toFixed(6)}" a="${num(record?.a, 0).toFixed(6)}" b="${num(record?.b, 0).toFixed(6)}" c="${num(record?.c, 0).toFixed(6)}" d="${num(record?.d, 0).toFixed(6)}"/>`
    )).join('\n'),
    sections.map((section) => laneSectionXml(section, road)).join('\n'),
    '    </lanes>'
  ].join('\n');
}

export function selectedRoadToOpenDriveXml(road) {
  const { length } = normalizeGeometry(road);
  const rid = String(road?.id ?? '').trim();
  const junction = String(road?.junction ?? '-1');
  const predecessorId = String(road?.predecessorId ?? '').trim();
  const successorId = String(road?.successorId ?? '').trim();
  const predecessorType = String(road?.predecessorType || 'road');
  const successorType = String(road?.successorType || 'road');
  const linkLines = [];
  if ((predecessorId && predecessorId !== rid) || (successorId && successorId !== rid)) {
    linkLines.push('    <link>');
    if (predecessorId && predecessorId !== rid) {
      linkLines.push(`      <predecessor elementType="${esc(predecessorType)}" elementId="${esc(predecessorId)}" contactPoint="${esc(road?.predecessorContactPoint || 'end')}"/>`);
    }
    if (successorId && successorId !== rid) {
      linkLines.push(`      <successor elementType="${esc(successorType)}" elementId="${esc(successorId)}" contactPoint="${esc(road?.successorContactPoint || 'start')}"/>`);
    }
    linkLines.push('    </link>');
  }
  return [
    `  <road name="road_${esc(rid)}" length="${num(length || road?.length, 1).toFixed(6)}" id="${esc(rid)}" junction="${esc(junction)}">`,
    ...linkLines,
    '    <type s="0.000000" type="town">',
    '      <speed max="35" unit="mph"/>',
    '    </type>',
    '    <planView>',
    geometryXml(road),
    '    </planView>',
    '    <elevationProfile>',
    '      <elevation s="0.000000" a="0.000000" b="0.000000" c="0.000000" d="0.000000"/>',
    '    </elevationProfile>',
    '    <lateralProfile>',
    '      <superelevation s="0.000000" a="0.000000" b="0.000000" c="0.000000" d="0.000000"/>',
    '    </lateralProfile>',
    lanesXml(road),
    '  </road>'
  ].join('\n');
}
