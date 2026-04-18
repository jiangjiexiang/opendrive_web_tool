'use strict';

const { buildLanes, buildGeometryFromPoints, polylineLength } = require('./vtsRules');

function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function laneXml(lane, laneWidth) {
  return [
    `          <lane id="${lane.id}" type="${esc(lane.type)}" level="false">`,
    `            <width sOffset="0" a="${Number(laneWidth || 3.5).toFixed(3)}" b="0" c="0" d="0"/>`,
    '            <roadMark sOffset="0" type="solid" weight="standard" color="standard" width="0.15"/>',
    '          </lane>'
  ].join('\n');
}

function lanesBlockXml(road) {
  const lanes = buildLanes(road.leftLaneCount, road.rightLaneCount, road.centerType);
  const laneWidth = Number(road.laneWidth || 3.5);
  const leftLaneWidth = Number(road.leftLaneWidth || laneWidth || 3.5);
  const rightLaneWidth = Number(road.rightLaneWidth || laneWidth || 3.5);
  const left = lanes.filter((l) => l.side === 1).map((l) => laneXml(l, leftLaneWidth)).join('\n');
  const center = lanes.filter((l) => l.side === 0).map((l) => laneXml(l, 0)).join('\n');
  const right = lanes.filter((l) => l.side === -1).map((l) => laneXml(l, rightLaneWidth)).join('\n');

  return [
    '    <lanes>',
    '      <laneSection s="0" singleSide="false">',
    '        <left>',
    left,
    '        </left>',
    '        <center>',
    center,
    '        </center>',
    '        <right>',
    right,
    '        </right>',
    '      </laneSection>',
    '    </lanes>'
  ].join('\n');
}

function geometryXml(road) {
  const geometry = Array.isArray(road.geometry) && road.geometry.length
    ? road.geometry
    : buildGeometryFromPoints(road.points);

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

  return geometry.map((g) => [
    `      <geometry s="${Number(g.s).toFixed(3)}" x="${Number(g.x).toFixed(3)}" y="${Number(g.y).toFixed(3)}" hdg="${Number(g.hdg).toFixed(6)}" length="${Number(g.length).toFixed(3)}">`,
    '        <line/>',
    '      </geometry>'
  ].join('\n')).join('\n');
}

function roadXml(rawRoad) {
  const road = { ...rawRoad };
  if (Array.isArray(road.points) && road.points.length >= 2) {
    road.length = Number(polylineLength(road.points).toFixed(3));
    road.geometry = buildGeometryFromPoints(road.points);
    road.x = road.points[0].x;
    road.y = road.points[0].y;
    road.hdg = road.geometry[0]?.hdg || 0;
  }

  const rid = String(road.id);
  const junction = String(road.junction ?? '-1');
  const length = Number(road.length || 1);

  return [
    `  <road name="road_${esc(rid)}" length="${length.toFixed(3)}" id="${esc(rid)}" junction="${esc(junction)}">`,
    '    <link>',
    `      <predecessor elementType="${esc(road.predecessorType || 'road')}" elementId="${esc(road.predecessorId ?? rid)}" contactPoint="end"/>`,
    `      <successor elementType="${esc(road.successorType || 'road')}" elementId="${esc(road.successorId ?? rid)}" contactPoint="start"/>`,
    '    </link>',
    '    <planView>',
    geometryXml(road),
    '    </planView>',
    lanesBlockXml(road),
    '  </road>'
  ].join('\n');
}

function buildXodr(spec) {
  const header = spec.header || {};
  const roads = Array.isArray(spec.roads) ? spec.roads : [];

  const headerXml = `  <header revMajor="1" revMinor="4" name="${esc(header.name || 'web_generated_map')}" version="1.00" date="${esc(header.date || new Date().toISOString())}" north="${Number(header.north || 0)}" south="${Number(header.south || 0)}" east="${Number(header.east || 0)}" west="${Number(header.west || 0)}" vendor="${esc(header.vendor || 'opendrive_web_tool')}"/>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenDRIVE>',
    headerXml,
    roads.map(roadXml).join('\n'),
    '</OpenDRIVE>',
    ''
  ].join('\n');
}

module.exports = {
  buildXodr
};
