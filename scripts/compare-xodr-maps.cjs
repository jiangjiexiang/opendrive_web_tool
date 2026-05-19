#!/usr/bin/env node
/**
 * Compare reference OpenDRIVE vs tool round-trip export.
 * Usage: node scripts/compare-xodr-maps.cjs [path/to/map.xodr ...]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const execFileAsync = promisify(execFile);
const root = path.join(__dirname, '..');
const { buildXodr } = require(path.join(root, 'src/xodrSerializer.js'));
const { validateMapSpec, validateRouteConnectivity } = require(path.join(root, 'src/vtsRules.js'));

const nativeParserPath = path.join(root, 'native', 'bin', 'odr_json_parser');

const DEFAULT_FILES = [
  '/mnt/c/Users/jiang/Desktop/standard_opendrive_maps_jili.xodr',
  path.join(root, 'src/jili_west.xodr')
];

function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    len += Math.hypot(dx, dy);
  }
  return len;
}

function childElements(el, tag) {
  return Array.from(el.childNodes || []).filter(
    (n) => n.nodeType === 1 && (!tag || n.nodeName === tag)
  );
}

function parseDoc(xmlText) {
  const doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML parse error');
  const rootEl = doc.getElementsByTagName('OpenDRIVE')[0];
  if (!rootEl) throw new Error('Not OpenDRIVE');
  return { doc, root: rootEl };
}

function parseAttrNum(node, name, fallback = 0) {
  if (!node || !node.hasAttribute(name)) return fallback;
  const value = Number(node.getAttribute(name));
  return Number.isFinite(value) ? value : fallback;
}

function parsePlanViewGeometry(roadEl) {
  const segments = [];
  const planView = childElements(roadEl, 'planView')[0];
  if (!planView) return segments;
  childElements(planView, 'geometry').forEach((geomEl) => {
    const segment = {
      s: parseAttrNum(geomEl, 's', 0),
      x: parseAttrNum(geomEl, 'x', 0),
      y: parseAttrNum(geomEl, 'y', 0),
      hdg: parseAttrNum(geomEl, 'hdg', 0),
      length: parseAttrNum(geomEl, 'length', 0),
      type: 'line',
      curvature: 0,
      curvStart: 0,
      curvEnd: 0
    };
    const arc = childElements(geomEl, 'arc')[0];
    const spiral = childElements(geomEl, 'spiral')[0];
    if (arc) {
      segment.type = 'arc';
      segment.curvature = parseAttrNum(arc, 'curvature', 0);
    } else if (spiral) {
      segment.type = 'spiral';
      segment.curvStart = parseAttrNum(spiral, 'curvStart', 0);
      segment.curvEnd = parseAttrNum(spiral, 'curvEnd', 0);
    }
    if (segment.length > 1e-8) segments.push(segment);
  });
  return segments;
}

function parseImportBundle(xmlText) {
  const { doc, root } = parseDoc(xmlText);
  const serializer = new XMLSerializer();
  const headerEl = childElements(root, 'header')[0];
  const header = headerEl ? {
    rawHeaderXml: serializer.serializeToString(headerEl),
    name: headerEl.getAttribute('name') || '',
    vendor: headerEl.getAttribute('vendor') || ''
  } : { rawHeaderXml: '', name: '', vendor: '' };

  const rawRoads = {};
  const details = {};
  const roads = childElements(root, 'road');
  roads.forEach((roadEl) => {
    const rid = String(roadEl.getAttribute('id') || '').trim();
    if (!rid) return;
    const junctionAttr = String(roadEl.getAttribute('junction') ?? '-1').trim();
    const isConnector = junctionAttr !== '' && junctionAttr !== '-1';
    rawRoads[rid] = serializer.serializeToString(roadEl);

    const detail = {
      predecessorType: 'road',
      predecessorId: '',
      predecessorContactPoint: 'end',
      successorType: 'road',
      successorId: '',
      successorContactPoint: 'start',
      laneOffsetRecords: [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }],
      laneSectionsSpec: []
    };
    const linkEl = childElements(roadEl, 'link')[0];
    const pred = linkEl ? childElements(linkEl, 'predecessor')[0] : null;
    const succ = linkEl ? childElements(linkEl, 'successor')[0] : null;
    if (pred) {
      detail.predecessorType = pred.getAttribute('elementType') || 'road';
      detail.predecessorId = pred.getAttribute('elementId') || '';
      detail.predecessorContactPoint = pred.getAttribute('contactPoint') || detail.predecessorContactPoint;
    }
    if (succ) {
      detail.successorType = succ.getAttribute('elementType') || 'road';
      detail.successorId = succ.getAttribute('elementId') || '';
      detail.successorContactPoint = succ.getAttribute('contactPoint') || detail.successorContactPoint;
    }

    const lanesEl = childElements(roadEl, 'lanes')[0];
    const laneOffsetEl = lanesEl ? childElements(lanesEl, 'laneOffset') : [];
    if (laneOffsetEl.length) detail.laneOffsetRecords = [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }];

    const sections = lanesEl ? childElements(lanesEl, 'laneSection') : [];
    detail.laneSectionsSpec = sections.map((sectionEl) => {
      const sectionS = Number(sectionEl.getAttribute('s') || 0);
      const laneLinks = {};
      const parseLanes = (sideEl, side) => {
        if (!sideEl) return [];
        return childElements(sideEl, 'lane')
          .map((laneEl) => {
            const laneId = String(laneEl.getAttribute('id') || '').trim();
            const link = childElements(laneEl, 'link')[0];
            const predL = link ? childElements(link, 'predecessor')[0] : null;
            const succL = link ? childElements(link, 'successor')[0] : null;
            if (isConnector && laneId && laneId !== '0' && (predL || succL)) {
              laneLinks[laneId] = {
                predecessor: predL?.getAttribute('id') ?? '',
                successor: succL?.getAttribute('id') ?? ''
              };
            }
            return {
              id: laneId,
              type: laneEl.getAttribute('type') || 'none',
              widthProfile: [{ sOffset: sectionS, a: 3.5, b: 0, c: 0, d: 0 }],
              predecessor: predL?.getAttribute('id') ?? '',
              successor: succL?.getAttribute('id') ?? ''
            };
          })
          .filter((l) => l.id && (side === 'left' ? Number(l.id) > 0 : Number(l.id) < 0));
      };
      const leftEl = childElements(sectionEl, 'left')[0];
      const rightEl = childElements(sectionEl, 'right')[0];
      const centerEl = childElements(sectionEl, 'center')[0];
      return {
        s: sectionS,
        centerType: centerEl ? (childElements(centerEl, 'lane')[0]?.getAttribute('type') || 'none') : 'none',
        leftLanes: parseLanes(leftEl, 'left'),
        rightLanes: parseLanes(rightEl, 'right'),
        laneLinks: isConnector ? laneLinks : {}
      };
    });

    if (!isConnector) {
      detail.laneSectionsSpec = detail.laneSectionsSpec.map((section) => ({
        ...section,
        laneLinks: {},
        leftLanes: section.leftLanes.map(({ predecessor, successor, ...lane }) => lane),
        rightLanes: section.rightLanes.map(({ predecessor, successor, ...lane }) => lane)
      }));
    }
    detail.geometry = parsePlanViewGeometry(roadEl);
    details[rid] = detail;
  });

  const junctions = [];
  childElements(root, 'junction').forEach((junctionEl) => {
    const jid = String(junctionEl.getAttribute('id') || '').trim();
    if (!jid) return;
    const connections = childElements(junctionEl, 'connection').map((connEl, idx) => ({
      id: String(connEl.getAttribute('id') || idx),
      incomingRoad: String(connEl.getAttribute('incomingRoad') || ''),
      connectingRoad: String(connEl.getAttribute('connectingRoad') || ''),
      contactPoint: String(connEl.getAttribute('contactPoint') || 'start'),
      laneLinks: childElements(connEl, 'laneLink').map((laneEl) => ({
        from: String(laneEl.getAttribute('from') || ''),
        to: String(laneEl.getAttribute('to') || '')
      }))
    }));
    junctions.push({
      id: jid,
      name: String(junctionEl.getAttribute('name') || `junction_${jid}`),
      connections,
      rawJunctionXml: serializer.serializeToString(junctionEl)
    });
  });

  const extras = [];
  const known = new Set(['header', 'road', 'junction']);
  childElements(root).forEach((child) => {
    const tag = String(child.nodeName || '').toLowerCase();
    if (!known.has(tag)) extras.push(serializer.serializeToString(child));
  });

  return { header, roadDetails: { details, rawRoads }, junctions: { specs: junctions }, extras };
}

function auditXodr(xmlText) {
  const { root } = parseDoc(xmlText);
  const roads = childElements(root, 'road');
  const junctions = childElements(root, 'junction');

  const stats = {
    roads: roads.length,
    mainRoads: 0,
    connectorRoads: 0,
    roadIds: [],
    roadWithLink: 0,
    roadLinkPred: 0,
    roadLinkSucc: 0,
    laneLinkOnMain: 0,
    laneLinkOnConnector: 0,
    junctions: junctions.length,
    junctionConnections: 0,
    junctionLaneLinks: 0,
    geometry: { line: 0, arc: 0, spiral: 0, paramPoly3: 0, other: 0 },
    laneSections: 0,
    laneOffset: 0,
    objects: 0,
    signals: 0,
    elev: 0,
    lateralProfile: 0,
    extras: []
  };

  roads.forEach((roadEl) => {
    const rid = String(roadEl.getAttribute('id') || '').trim();
    const junction = String(roadEl.getAttribute('junction') ?? '-1').trim();
    const isConnector = junction !== '' && junction !== '-1';
    stats.roadIds.push(rid);
    if (isConnector) stats.connectorRoads += 1;
    else stats.mainRoads += 1;

    const linkEl = childElements(roadEl, 'link')[0];
    if (linkEl) {
      stats.roadWithLink += 1;
      if (childElements(linkEl, 'predecessor').length) stats.roadLinkPred += 1;
      if (childElements(linkEl, 'successor').length) stats.roadLinkSucc += 1;
    }

    const geomTags = ['line', 'arc', 'spiral', 'paramPoly3'];
    geomTags.forEach((tag) => {
      const nodes = roadEl.getElementsByTagName(tag);
      const n = nodes.length || 0;
      for (let i = 0; i < n; i += 1) {
        if (nodes[i].parentNode?.nodeName === 'geometry') stats.geometry[tag] += 1;
      }
    });
    stats.laneSections += roadEl.getElementsByTagName('laneSection').length || 0;
    if (childElements(roadEl, 'lanes').some((l) => childElements(l, 'laneOffset').length)) stats.laneOffset += 1;
    if (childElements(roadEl, 'objects').length) stats.objects += 1;
    if (childElements(roadEl, 'signals').length) stats.signals += 1;
    if (childElements(roadEl, 'elevationProfile').length) stats.elev += 1;
    if (childElements(roadEl, 'lateralProfile').length) stats.lateralProfile += 1;

    const laneNodes = roadEl.getElementsByTagName('lane');
    const laneCount = laneNodes.length || 0;
    for (let li = 0; li < laneCount; li += 1) {
      const laneEl = laneNodes[li];
      const pName = laneEl.parentNode?.nodeName;
      if (pName !== 'left' && pName !== 'right' && pName !== 'center') continue;
      const laneLink = childElements(laneEl, 'link')[0];
      if (!laneLink) continue;
      const pred = childElements(laneLink, 'predecessor')[0];
      const succ = childElements(laneLink, 'successor')[0];
      if (!pred && !succ) continue;
      if (isConnector) stats.laneLinkOnConnector += 1;
      else stats.laneLinkOnMain += 1;
    }
  });

  junctions.forEach((jEl) => {
    const conns = childElements(jEl, 'connection');
    stats.junctionConnections += conns.length;
    conns.forEach((c) => {
      stats.junctionLaneLinks += childElements(c, 'laneLink').length;
    });
  });

  const known = new Set(['header', 'road', 'junction']);
  childElements(root).forEach((child) => {
    const tag = String(child.nodeName || '').toLowerCase();
    if (!known.has(tag)) stats.extras.push(tag);
  });

  return stats;
}

function diffStats(ref, gen) {
  const diffs = [];
  const keys = [
    'roads', 'mainRoads', 'connectorRoads', 'roadWithLink', 'roadLinkPred', 'roadLinkSucc',
    'laneLinkOnMain', 'laneLinkOnConnector', 'junctions', 'junctionConnections', 'junctionLaneLinks',
    'laneSections', 'laneOffset', 'objects', 'signals', 'elev', 'lateralProfile'
  ];
  keys.forEach((k) => {
    if (ref[k] !== gen[k]) diffs.push({ key: k, ref: ref[k], gen: gen[k] });
  });
  ['line', 'arc', 'spiral', 'paramPoly3'].forEach((k) => {
    if (ref.geometry[k] !== gen.geometry[k]) {
      diffs.push({ key: `geometry.${k}`, ref: ref.geometry[k], gen: gen.geometry[k] });
    }
  });
  const missing = ref.roadIds.filter((id) => !gen.roadIds.includes(id));
  const extra = gen.roadIds.filter((id) => !ref.roadIds.includes(id));
  if (missing.length) diffs.push({ key: 'missingRoadIds', ref: missing.join(','), gen: '' });
  if (extra.length) diffs.push({ key: 'extraRoadIds', ref: '', gen: extra.join(',') });
  return diffs;
}

async function parseXodrNative(xmlText, eps = 0.2) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odr-parse-'));
  const tempFile = path.join(tempDir, 'map.xodr');
  fs.writeFileSync(tempFile, xmlText, 'utf8');
  try {
    const { stdout } = await execFileAsync(nativeParserPath, [tempFile, String(eps)], {
      maxBuffer: 50 * 1024 * 1024
    });
    return JSON.parse(stdout || '{}');
  } finally {
    try { fs.unlinkSync(tempFile); } catch (_) {}
    try { fs.rmdirSync(tempDir); } catch (_) {}
  }
}

function isConnectorRoad(road) {
  const junction = String(road?.junction ?? '-1').trim();
  return junction !== '' && junction !== '-1';
}

function stripLaneLinksFromSections(road) {
  if (!Array.isArray(road?.laneSections)) return road;
  road.laneSections = road.laneSections.map((section) => {
    const next = { ...section, laneLinks: {} };
    if (Array.isArray(next.leftLanes)) {
      next.leftLanes = next.leftLanes.map(({ predecessor, successor, ...rest }) => rest);
    }
    if (Array.isArray(next.rightLanes)) {
      next.rightLanes = next.rightLanes.map(({ predecessor, successor, ...rest }) => rest);
    }
    return next;
  });
  return road;
}

function normalizeImportedRoad(r, idx, importedRoadDetails = {}) {
  const points = (Array.isArray(r.points) ? r.points : []).map((p) => ({ x: p.x, y: p.y }));
  const road = {
    id: String(r.id ?? idx + 1),
    junction: String(r.junction ?? '-1'),
    leftLaneCount: Math.max(0, Number(r.leftLaneCount || 0)),
    rightLaneCount: Math.max(0, Number(r.rightLaneCount || 0)),
    laneWidth: Math.max(0.5, Number(r.laneWidth || 3.5)),
    leftLaneWidth: Math.max(0.5, Number(r.leftLaneWidth || r.laneWidth || 3.5)),
    rightLaneWidth: Math.max(0.5, Number(r.rightLaneWidth || r.laneWidth || 3.5)),
    centerType: r.centerType || 'none',
    predecessorType: r.predecessorType || 'road',
    predecessorId: String(r.predecessorId ?? r.id ?? idx + 1),
    predecessorContactPoint: String(r.predecessorContactPoint || 'end'),
    successorType: r.successorType || 'road',
    successorId: String(r.successorId ?? r.id ?? idx + 1),
    successorContactPoint: String(r.successorContactPoint || 'start'),
    laneOffsetRecords: [{ sOffset: 0, a: 0, b: 0, c: 0, d: 0 }],
    laneSections: [],
    points,
    visible: r.visible !== false,
    length: Number.isFinite(Number(r.length)) ? Number(r.length) : polylineLength(points)
  };
  const detail = importedRoadDetails[String(road.id)];
  if (detail) {
    road.predecessorType = detail.predecessorType || road.predecessorType;
    road.predecessorId = String(detail.predecessorId || road.predecessorId || '');
    road.predecessorContactPoint = detail.predecessorContactPoint || road.predecessorContactPoint;
    road.successorType = detail.successorType || road.successorType;
    road.successorId = String(detail.successorId || road.successorId || '');
    road.successorContactPoint = detail.successorContactPoint || road.successorContactPoint;
    if (Array.isArray(detail.laneOffsetRecords) && detail.laneOffsetRecords.length) {
      road.laneOffsetRecords = detail.laneOffsetRecords.map((record) => ({ ...record }));
    }
    if (Array.isArray(detail.geometry) && detail.geometry.length) {
      road.geometry = detail.geometry.map((segment) => ({ ...segment }));
      road.geometryDirty = false;
    }
    if (Array.isArray(detail.laneSectionsSpec) && detail.laneSectionsSpec.length) {
      const cloneSection = (section) => ({
        ...section,
        leftLanes: (section.leftLanes || []).map((lane) => ({ ...lane })),
        rightLanes: (section.rightLanes || []).map((lane) => ({ ...lane })),
        laneLinks: { ...(section.laneLinks || {}) }
      });
      road.laneSections = detail.laneSectionsSpec.map(cloneSection);
      road.laneSectionsSpec = detail.laneSectionsSpec.map(cloneSection);
    }
  }
  if (!isConnectorRoad(road)) stripLaneLinksFromSections(road);
  return road;
}

function buildSpecFromImport(nativePayload, bundle) {
  const { details, rawRoads } = bundle.roadDetails;
  const parsedRoads = nativePayload?.host?.roads || nativePayload?.roads || [];
  const roads = parsedRoads.map((r, i) => {
    const road = normalizeImportedRoad(r, i, details);
    const roadId = String(road.id);
    return {
      ...road,
      length: polylineLength(road.points),
      rawRoadXml: rawRoads[roadId] || '',
      patchRawRoadXml: false
    };
  });
  return {
    header: {
      name: bundle.header?.name || 'imported',
      vendor: bundle.header?.vendor || '',
      rawHeaderXml: bundle.header?.rawHeaderXml || undefined
    },
    roads,
    junctions: bundle.junctions.specs.map((j) => ({
      ...j,
      rawJunctionXml: j.rawJunctionXml || ''
    })),
    rawOpenDriveExtras: bundle.extras || []
  };
}

function printStats(s) {
  console.log(`  roads: ${s.roads} (main=${s.mainRoads}, connector=${s.connectorRoads})`);
  console.log(`  road links: ${s.roadWithLink} (pred=${s.roadLinkPred}, succ=${s.roadLinkSucc})`);
  console.log(`  lane links: main=${s.laneLinkOnMain} connector=${s.laneLinkOnConnector}`);
  console.log(`  junctions: ${s.junctions} connections=${s.junctionConnections} junctionLaneLinks=${s.junctionLaneLinks}`);
  console.log(`  geometry: line=${s.geometry.line} arc=${s.geometry.arc} spiral=${s.geometry.spiral} paramPoly3=${s.geometry.paramPoly3}`);
  console.log(`  laneSections=${s.laneSections} laneOffsetRoads=${s.laneOffset} objects=${s.objects} signals=${s.signals}`);
  if (s.extras.length) console.log(`  extra top-level tags: ${[...new Set(s.extras)].join(', ')}`);
}

async function analyzeFile(filePath) {
  const name = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    console.log(`\n[SKIP] ${name} — file not found`);
    return;
  }
  const xmlText = fs.readFileSync(filePath, 'utf8');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`MAP: ${filePath}`);
  console.log(`${'='.repeat(60)}`);

  const refStats = auditXodr(xmlText);
  console.log('\n--- Reference (original) ---');
  printStats(refStats);

  let bundle;
  let nativePayload;
  try {
    bundle = parseImportBundle(xmlText);
    nativePayload = await parseXodrNative(xmlText, 0.2);
  } catch (err) {
    console.log(`\nImport failed: ${err.message}`);
    return;
  }

  const spec = buildSpecFromImport(nativePayload, bundle);
  const mapcheck = validateMapSpec(spec);
  const route = validateRouteConnectivity(spec);
  console.log('\n--- Spec validation (after import) ---');
  console.log(`  mapcheck: ${mapcheck.ok ? 'OK' : 'FAIL'} errors=${(mapcheck.errors || []).length} warnings=${(mapcheck.warnings || []).length}`);
  if (!mapcheck.ok && mapcheck.errors?.length) {
    mapcheck.errors.slice(0, 8).forEach((e) => console.log(`    [ERR] ${e}`));
  }
  console.log(`  route: ${route.ok ? 'OK' : 'FAIL'} errors=${(route.errors || []).length}`);
  if (!route.ok && route.errors?.length) {
    route.errors.slice(0, 5).forEach((e) => console.log(`    [ERR] ${e}`));
  }

  const generatedRaw = buildXodr(spec);
  const genRawStats = auditXodr(generatedRaw);
  console.log('\n--- Generated (preserve original road/junction XML) ---');
  printStats(genRawStats);

  const diffsRaw = diffStats(refStats, genRawStats);
  console.log('\n--- Reference vs preserve-raw export ---');
  if (!diffsRaw.length) console.log('  Structural counts match.');
  else diffsRaw.forEach((d) => console.log(`  Δ ${d.key}: ref=${d.ref} → gen=${d.gen}`));

  const specRegen = {
    ...spec,
    roads: spec.roads.map((r) => ({ ...r, rawRoadXml: '', patchRawRoadXml: false })),
    junctions: spec.junctions.map((j) => ({ ...j, rawJunctionXml: '' }))
  };
  const generatedFresh = buildXodr(specRegen);
  const genFreshStats = auditXodr(generatedFresh);
  console.log('\n--- Generated (full serializer regen, no raw XML) ---');
  printStats(genFreshStats);

  const diffsFresh = diffStats(refStats, genFreshStats);
  console.log('\n--- Reference vs serializer regen (what editor exports when roads edited) ---');
  if (!diffsFresh.length) console.log('  Structural counts match.');
  else {
    diffsFresh.forEach((d) => console.log(`  Δ ${d.key}: ref=${d.ref} → gen=${d.gen}`));
  }

  if (refStats.laneLinkOnConnector !== genFreshStats.laneLinkOnConnector) {
    console.log(`  ⚠ connector lane links: ref=${refStats.laneLinkOnConnector} regen=${genFreshStats.laneLinkOnConnector}`);
  }
  if (genFreshStats.laneLinkOnMain > 0) {
    console.log(`  WARN: regen has ${genFreshStats.laneLinkOnMain} lane link(s) on main roads (should be 0).`);
  }
  if (refStats.elev !== genFreshStats.elev) {
    console.log(`  ⚠ elevationProfile: ref=${refStats.elev} regen=${genFreshStats.elev}`);
  }
  if (refStats.lateralProfile !== genFreshStats.lateralProfile) {
    console.log(`  ⚠ lateralProfile: ref=${refStats.lateralProfile} regen=${genFreshStats.lateralProfile}`);
  }

  const outDir = path.join(root, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `roundtrip-raw-${name}`), generatedRaw, 'utf8');
  fs.writeFileSync(path.join(outDir, `roundtrip-regen-${name}`), generatedFresh, 'utf8');
  console.log(`\n  Wrote: tmp/roundtrip-raw-${name}, tmp/roundtrip-regen-${name}`);
}

(async () => {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;
  for (const f of files) await analyzeFile(f);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
