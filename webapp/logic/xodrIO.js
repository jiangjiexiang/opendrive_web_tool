import { markRaw } from 'vue';
import { isConnectorRoad, stripLaneLinksFromSections } from '../laneLinkRules.js';
import { sanitizeGeometryTypes } from '../geometrySanitize.js';
import { rotateVec, vecAdd, polylineLength } from '../editorUtils.js';
import { parseXodrImportBundle, parseHeaderFromXodr, parseJunctionSpecsFromXodr, parseOpenDriveExtrasFromXodr, parseRoadDetailsFromXodr } from '../xodrParsers.js';
import { applyMapYamlToGeo, loadBackgroundFile, isYamlFile } from '../backgroundMap.js';
import { parsePointCloudBuffer } from '../pointCloudParser.js';
import { runQualityCheck } from '../qualityCheck.js';
import { MAX_EXPORT_IMAGE_PIXELS, MAX_EXPORT_IMAGE_SIDE, IMPORT_ROAD_CHUNK_SIZE } from './constants.js';

export function installXodrIO(host) {
function currentSpec() {
  const bounds = host.roads.value.reduce((acc, road) => {
    (Array.isArray(road?.points) ? road.points : []).forEach((point) => {
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
  const roadsForExport = host.roads.value.map((r) => {
    const roadId = String(r?.id ?? '').trim();
    return {
      ...r,
      length: polylineLength(r.points),
      rawRoadXml: host.rawRoadXmlById.value?.[roadId] || '',
      patchRawRoadXml: Boolean(host.dirtyRoadIds.value?.[roadId])
    };
  });
  const junctions = junctionsForExport();
  return {
    header: {
      name: host.headerForm.name,
      vendor: host.headerForm.vendor,
      north: hasBounds ? Number(bounds.maxY) : Number(host.headerForm.north),
      south: hasBounds ? Number(bounds.minY) : Number(host.headerForm.south),
      east: hasBounds ? Number(bounds.maxX) : Number(host.headerForm.east),
      west: hasBounds ? Number(bounds.minX) : Number(host.headerForm.west),
      rawHeaderXml: host.headerDirty.value ? undefined : (host.importedHeaderXml.value || undefined)
    },
    roads: roadsForExport,
    junctions,
    rawOpenDriveExtras: host.rawOpenDriveExtras.value
  };
}

async function runValidate() {
  await runQualityCheck({
    postJson: host.postJson,
    currentSpec,
    importedXodrTextRef: host.importedXodrText,
    dialog: host.validateDialog
  });
}

async function generateXodr() {
  const { xodr } = await host.postJson('/api/generate-xodr', currentSpec());
  host.lastXodr.value = xodr;
}

async function generateAndDownloadXodr() {
  try {
    await generateXodr();
    downloadXodr();
  } catch (error) {
    window.alert(`生成 XODR 失败：${host.formatErrorMessage(error)}`);
  }
}

function downloadXodr() {
  const content = host.lastXodr.value || host.importedXodrText.value;
  if (!content) {
    window.alert('没有可下载的 XODR，请先点击「生成」或先导入文件。');
    return;
  }
  const blob = new Blob([content], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${host.headerForm.name || 'map'}.xodr`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function getBackgroundWorldBounds() {
  if (!host.bgImage.value) return null;
  const res = Math.max(1e-6, Number(host.bgGeo.resolution || 1));
  const yaw = Number(host.bgGeo.yaw || 0);
  const width = Number(host.bgImage.value.width || host.bgGeo.imageWidth || 0);
  const height = Number(host.bgImage.value.height || host.bgGeo.imageHeight || 0);
  if (!(width > 0) || !(height > 0)) return null;
  const origin = { x: Number(host.bgGeo.originX || 0), y: Number(host.bgGeo.originY || 0) };
  const corners = [
    origin,
    vecAdd(origin, rotateVec({ x: width * res, y: 0 }, yaw)),
    vecAdd(origin, rotateVec({ x: width * res, y: height * res }, yaw)),
    vecAdd(origin, rotateVec({ x: 0, y: height * res }, yaw))
  ];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  corners.forEach((p) => {
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y);
    bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.maxY = Math.max(bounds.maxY, p.y);
  });
  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)
    || !Number.isFinite(bounds.maxX) || !Number.isFinite(bounds.maxY)) {
    return null;
  }
  return bounds;
}

function calculateExportSize(bounds) {
  const worldWidth = Math.max(1e-6, bounds.maxX - bounds.minX);
  const worldHeight = Math.max(1e-6, bounds.maxY - bounds.minY);
  const sourceWidth = Math.max(1, Number(host.bgImage.value?.width || host.bgGeo.imageWidth || 0));
  const sourceHeight = Math.max(1, Number(host.bgImage.value?.height || host.bgGeo.imageHeight || 0));
  const baseScale = Math.min(
    sourceWidth / worldWidth,
    sourceHeight / worldHeight
  );
  const rawWidth = Math.max(1, Math.ceil(worldWidth * baseScale));
  const rawHeight = Math.max(1, Math.ceil(worldHeight * baseScale));
  const pixelScale = Math.sqrt(host.MAX_EXPORT_IMAGE_PIXELS / Math.max(1, rawWidth * rawHeight));
  const sideScale = host.MAX_EXPORT_IMAGE_SIDE / Math.max(rawWidth, rawHeight);
  const scaleDown = Math.min(1, pixelScale, sideScale);
  return {
    width: Math.max(1, Math.floor(rawWidth * scaleDown)),
    height: Math.max(1, Math.floor(rawHeight * scaleDown))
  };
}

async function downloadBackgroundOverlayImage() {
  if (!host.bgImage.value) {
    window.alert('请先上传底图。');
    return;
  }
  if (!host.roads.value.length) {
    window.alert('请先导入或绘制OpenDRIVE道路。');
    return;
  }
  const bounds = getBackgroundWorldBounds();
  if (!bounds) {
    window.alert('底图范围无效，无法导出图像。');
    return;
  }
  const exportSize = calculateExportSize(bounds);
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = exportSize.width;
  exportCanvas.height = exportSize.height;
  const exportCtx = exportCanvas.getContext('2d');
  if (!exportCtx) {
    window.alert('当前浏览器无法创建导出画布。');
    return;
  }

  const prevCtx = host.ctx;
  const prevCanvas = host.activeRenderCanvas;
  const prevScale = host.view.scale;
  const prevOffsetX = host.view.offsetX;
  const prevOffsetY = host.view.offsetY;
  try {
    host.ctx = exportCtx;
    host.activeRenderCanvas = exportCanvas;
    const worldWidth = Math.max(1e-6, bounds.maxX - bounds.minX);
    const worldHeight = Math.max(1e-6, bounds.maxY - bounds.minY);
    host.view.scale = Math.min(exportCanvas.width / worldWidth, exportCanvas.height / worldHeight);
    host.view.offsetX = -bounds.minX * host.view.scale + (exportCanvas.width - worldWidth * host.view.scale) / 2;
    host.view.offsetY = bounds.maxY * host.view.scale + (exportCanvas.height - worldHeight * host.view.scale) / 2;
    performRender({ exportMode: true });
  } finally {
    host.ctx = prevCtx;
    host.activeRenderCanvas = prevCanvas;
    host.view.scale = prevScale;
    host.view.offsetX = prevOffsetX;
    host.view.offsetY = prevOffsetY;
    host.render();
  }

  const blob = await new Promise((resolve) => exportCanvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    window.alert('图像导出失败。');
    return;
  }
  downloadBlob(blob, `${host.headerForm.name || 'opendrive_map'}_overlay.png`);
}

function junctionsForExport() {
  const list = [];
  const used = new Set();
  const referencedByRoads = new Set(
    host.roads.value
      .map((r) => String(r?.junction ?? '').trim())
      .filter((id) => id && id !== '-1')
  );
  (host.junctionSpecs.value || []).forEach((j) => {
    const id = String(j?.id ?? '').trim();
    if (!id) return;
    if (referencedByRoads.size && !referencedByRoads.has(id)) return;
    used.add(id);
    list.push({
      ...j,
      id,
      rawJunctionXml: host.dirtyJunctionIds.value[id] ? '' : (host.rawJunctionXmlById.value[id] || j.rawJunctionXml || '')
    });
  });
  Object.entries(host.rawJunctionXmlById.value || {}).forEach(([id, raw]) => {
    const sid = String(id);
    if (used.has(sid)) return;
    if (referencedByRoads.size && !referencedByRoads.has(sid)) return;
    list.push({
      id: sid,
      name: `junction_${sid}`,
      connections: [],
      rawJunctionXml: String(raw || '')
    });
  });
  return list;
}

function applyHeaderFromXodr(xmlText) {
  const parsed = parseHeaderFromXodr(xmlText);
  host.importedHeaderXml.value = parsed.rawHeaderXml || '';
  if (parsed.name) host.headerForm.name = parsed.name;
  if (parsed.vendor) host.headerForm.vendor = parsed.vendor;
  if (Number.isFinite(parsed.north)) host.headerForm.north = parsed.north;
  if (Number.isFinite(parsed.south)) host.headerForm.south = parsed.south;
  if (Number.isFinite(parsed.east)) host.headerForm.east = parsed.east;
  if (Number.isFinite(parsed.west)) host.headerForm.west = parsed.west;
}

function normalizeImportedRoad(r, idx, importedRoadDetails = {}) {
  const points = host.copyPointsLight(Array.isArray(r.points) ? r.points : []);
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
    editPoints: Array.isArray(r.editPoints) && r.editPoints.length >= 2
      ? host.copyBoundaryLight(r.editPoints)
      : host.defaultEditPoints(points.length >= 2 ? [points[0], points[points.length - 1]] : points),
    points,
    nativeLeftBoundary: host.copyBoundaryLight(Array.isArray(r.nativeLeftBoundary) ? r.nativeLeftBoundary : []),
    nativeRightBoundary: host.copyBoundaryLight(Array.isArray(r.nativeRightBoundary) ? r.nativeRightBoundary : []),
    nativeLaneBoundaries: Array.isArray(r.nativeLaneBoundaries) ? r.nativeLaneBoundaries : [],
    nativeLaneMeshes: Array.isArray(r.nativeLaneMeshes) ? r.nativeLaneMeshes : [],
    visible: r.visible !== false,
    length: Number.isFinite(Number(r.length)) ? Number(r.length) : polylineLength(points),
    geometry: [],
    geometryDirty: false,
    typeRecords: [],
    elevationRecords: [],
    superelevationRecords: [],
    shapeRecords: []
  };
  const rid = String(road.id);
  const detail = importedRoadDetails[rid];
  if (detail) {
    road.predecessorType = detail.predecessorType || road.predecessorType;
    road.predecessorId = String(detail.predecessorId || road.predecessorId || '');
    road.predecessorContactPoint = detail.predecessorContactPoint || road.predecessorContactPoint;
    road.successorType = detail.successorType || road.successorType;
    road.successorId = String(detail.successorId || road.successorId || '');
    road.successorContactPoint = detail.successorContactPoint || road.successorContactPoint;
    if (Array.isArray(detail.geometry) && detail.geometry.length) {
      road.geometry = sanitizeGeometryTypes(detail.geometry.map((segment) => ({ ...segment })));
      road.geometryDirty = false;
      const geomLen = road.geometry.reduce((acc, g) => acc + Number(g.length || 0), 0);
      if (geomLen > 1e-6) road.length = Number(geomLen.toFixed(6));
    }
    if (Array.isArray(detail.typeRecords) && detail.typeRecords.length) {
      road.typeRecords = detail.typeRecords.map((record) => ({ ...record }));
    }
    if (Array.isArray(detail.elevationRecords) && detail.elevationRecords.length) {
      road.elevationRecords = detail.elevationRecords.map((record) => ({ ...record }));
    }
    if (Array.isArray(detail.superelevationRecords) && detail.superelevationRecords.length) {
      road.superelevationRecords = detail.superelevationRecords.map((record) => ({ ...record }));
    }
    if (Array.isArray(detail.shapeRecords) && detail.shapeRecords.length) {
      road.shapeRecords = detail.shapeRecords.map((record) => ({ ...record }));
    }
    if (Array.isArray(detail.laneOffsetRecords) && detail.laneOffsetRecords.length) {
      road.laneOffsetRecords = detail.laneOffsetRecords.map((record) => ({ ...record }));
    }
    if (Array.isArray(detail.laneSectionsSpec) && detail.laneSectionsSpec.length) {
      const cloneSection = (section) => ({
        ...section,
        leftLanes: Array.isArray(section?.leftLanes) ? section.leftLanes.map((lane) => ({ ...lane })) : [],
        rightLanes: Array.isArray(section?.rightLanes) ? section.rightLanes.map((lane) => ({ ...lane })) : [],
        laneLinks: { ...(section?.laneLinks || {}) }
      });
      road.laneSections = detail.laneSectionsSpec.map(cloneSection);
      road.laneSectionsSpec = detail.laneSectionsSpec.map(cloneSection);
      road.leftLaneCount = Math.max(road.leftLaneCount, ...road.laneSections.map((section) => section.leftLanes.length));
      road.rightLaneCount = Math.max(road.rightLaneCount, ...road.laneSections.map((section) => section.rightLanes.length));
      const firstLeft = road.laneSections.find((section) => section.leftLanes?.[0]?.widthProfile?.[0]);
      const firstRight = road.laneSections.find((section) => section.rightLanes?.[0]?.widthProfile?.[0]);
      const leftW = firstLeft?.leftLanes?.[0]?.widthProfile?.[0]?.a;
      const rightW = firstRight?.rightLanes?.[0]?.widthProfile?.[0]?.a;
      if (Number.isFinite(leftW) && leftW > 0) {
        road.leftLaneWidth = Math.max(0.5, leftW);
        road.laneWidth = road.leftLaneWidth;
      }
      if (Number.isFinite(rightW) && rightW > 0) {
        road.rightLaneWidth = Math.max(0.5, rightW);
      }
    }
  }
  host.getRoadBounds(road);
  if (!isConnectorRoad(road)) {
    stripLaneLinksFromSections(road);
  }
  return road;
}

function roadEndpointPoint(road, endpoint) {
  const pts = Array.isArray(road?.points) ? road.points : [];
  if (pts.length < 1) return null;
  const pick = String(endpoint || 'start').toLowerCase() === 'end'
    ? pts[pts.length - 1]
    : pts[0];
  const x = Number(pick?.x);
  const y = Number(pick?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** 从 XODR 解析的 junction spec + 已加载道路，生成侧栏/画布用的 mesh */
function buildJunctionMeshesFromImport(junctionSpecs, roads) {
  const roadById = new Map(
    (Array.isArray(roads) ? roads : []).map((road) => [String(road?.id ?? '').trim(), road])
  );
  return (Array.isArray(junctionSpecs) ? junctionSpecs : []).map((spec) => {
    const jid = String(spec?.id ?? '').trim();
    const connections = Array.isArray(spec?.connections) ? spec.connections : [];
    const connectorMeta = connections.map((conn, index) => ({
      id: String(conn?.id ?? index),
      fromRoadId: String(conn?.incomingRoad ?? ''),
      roadId: String(conn?.connectingRoad ?? ''),
      entryContactPoint: String(conn?.contactPoint || 'start'),
      laneMap: (Array.isArray(conn?.laneLinks) ? conn.laneLinks : []).map((link) => ({
        fromRoadLaneId: String(link?.from ?? ''),
        connectorLaneId: String(link?.to ?? '')
      }))
    })).filter((conn) => conn.roadId);

    const incomingIds = [...new Set(
      connections.map((conn) => String(conn?.incomingRoad ?? '').trim()).filter(Boolean)
    )];
    const approaches = [];
    const samplePoints = [];

    incomingIds.forEach((roadId) => {
      const road = roadById.get(roadId);
      if (!road) return;
      const conn = connections.find((c) => String(c?.incomingRoad ?? '').trim() === roadId);
      const endpoint = String(conn?.contactPoint || 'start').toLowerCase() === 'end' ? 'end' : 'start';
      const anchor = roadEndpointPoint(road, endpoint);
      if (!anchor) return;
      const boundary = roadEndpointPoint(road, endpoint === 'start' ? 'end' : 'start');
      approaches.push({
        roadId,
        endpoint,
        anchor: { ...anchor },
        boundary: boundary ? { ...boundary } : { ...anchor }
      });
      samplePoints.push(anchor);
    });

    connectorMeta.forEach((conn) => {
      const connectorRoad = roadById.get(String(conn.roadId));
      if (!connectorRoad) return;
      const start = roadEndpointPoint(connectorRoad, 'start');
      const end = roadEndpointPoint(connectorRoad, 'end');
      if (start) samplePoints.push(start);
      if (end) samplePoints.push(end);
    });

    let center = { x: 0, y: 0 };
    if (samplePoints.length) {
      center = {
        x: samplePoints.reduce((sum, pt) => sum + pt.x, 0) / samplePoints.length,
        y: samplePoints.reduce((sum, pt) => sum + pt.y, 0) / samplePoints.length
      };
    }

    let polygon = approaches.map((a) => ({ ...a.anchor }));
    if (polygon.length >= 3) {
      polygon = polygon
        .slice()
        .sort((p0, p1) => (
          Math.atan2(p0.y - center.y, p0.x - center.x) - Math.atan2(p1.y - center.y, p1.x - center.x)
        ));
    }

    return {
      id: jid,
      name: String(spec?.name || `junction_${jid}`),
      center,
      polygon,
      approaches,
      connectorMeta,
      internalLaneCurves: [],
      imported: true
    };
  }).filter((mesh) => mesh.id);
}

async function applyNativeRoads(parsedRoads, importedJunctions = [], importedRoadDetails = {}) {
  const source = Array.isArray(parsedRoads) ? parsedRoads : [];
  const total = source.length;
  const normalized = new Array(total);
  for (let start = 0; start < total; start += host.IMPORT_ROAD_CHUNK_SIZE) {
    const end = Math.min(total, start + host.IMPORT_ROAD_CHUNK_SIZE);
    for (let i = start; i < end; i += 1) {
      normalized[i] = normalizeImportedRoad(source[i], i, importedRoadDetails);
    }
    if (host.importStatus.type === 'loading') {
      host.importStatus.message = total > host.IMPORT_ROAD_CHUNK_SIZE
        ? `正在加载道路数据 ${end}/${total}...`
        : '正在加载道路数据...';
    }
    if (end < total) await host.yieldToMain();
  }
  host.roads.value = normalized;
  if (normalized.length > 500) {
    host.roadColorConfig.showRoadLabels = false;
  }
  host.junctionSpecs.value = Array.isArray(importedJunctions) ? importedJunctions.map((j) => ({ ...j })) : [];
  host.junctionMeshes.value = buildJunctionMeshesFromImport(host.junctionSpecs.value, normalized);
  host.selectedJunctionId.value = '';
  host.junctionExpandedById.value = {};
  host.drawingPoints.value = [];
  host.drawSegmentControls.value = [];
  host.drawSegmentHeadings.value = [];
  host.drawControlDrag.value = null;
  host.junctionDraft.value = { handles: [] };
  host.selectedRoadIndex.value = normalized.length ? 0 : -1;
  host.fitView();
  if (normalized.length > 800) {
    host.view.scale = Math.min(host.view.scale, 0.45);
  }
  host.render(true);
}

function pickXodrFile() {
  host.importStatus.message = '';
  host.importStatus.type = '';
  host.xodrFileInput.value?.click();
}

function pickMapYamlFile() {
  host.mapYamlFileInput.value?.click();
}

function pickBgFile() {
  host.bgFileInput.value?.click();
}

function pickPointCloudFile() {
  host.pointCloudStatus.message = '';
  host.pointCloudStatus.type = '';
  host.pointCloudStatus.progress = 0;
  host.pointCloudFileInput.value?.click();
}

function readFileBufferWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(72, Math.max(1, (event.loaded / event.total) * 72)));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(file);
  });
}

function sampledPointIndex(index, ratio) {
  if (ratio >= 0.999) return true;
  const bucket = ((index * 2654435761) >>> 0) / 4294967296;
  return bucket < ratio;
}

function filteredPackedPointCloud(source, ratio, minZ, maxZ) {
  const positions = source?.positions instanceof Float32Array ? source.positions : null;
  if (!positions?.length) return null;
  const packedColors = source?.colors instanceof Float32Array ? source.colors : null;
  const outPositions = new Float32Array(positions.length);
  const outColors = packedColors ? new Float32Array(packedColors.length) : null;
  let out = 0;
  for (let index = 0; index < positions.length / 3; index += 1) {
    const base = index * 3;
    const z = positions[base + 2];
    if (!sampledPointIndex(index, ratio) || z < minZ || z > maxZ) continue;
    outPositions[out] = positions[base];
    outPositions[out + 1] = positions[base + 1];
    outPositions[out + 2] = z;
    if (outColors) {
      outColors[out] = packedColors[base];
      outColors[out + 1] = packedColors[base + 1];
      outColors[out + 2] = packedColors[base + 2];
    }
    out += 3;
  }
  return {
    positions: out === outPositions.length ? outPositions : outPositions.slice(0, out),
    colors: outColors ? (out === outColors.length ? outColors : outColors.slice(0, out)) : null,
    count: Math.floor(out / 3)
  };
}

function filteredObjectPointCloud(source, ratio, minZ, maxZ) {
  const points = Array.isArray(source?.points) ? source.points : [];
  if (!points.length) return null;
  const sourceColors = Array.isArray(source?.colors) ? source.colors : [];
  const outPoints = [];
  const outColors = sourceColors.length ? [] : null;
  points.forEach((point, index) => {
    const z = Number(point?.z);
    if (!sampledPointIndex(index, ratio) || z < minZ || z > maxZ) return;
    outPoints.push(point);
    if (outColors) outColors.push(sourceColors[index] || { r: 0.72, g: 0.86, b: 1 });
  });
  return {
    points: outPoints,
    colors: outColors || [],
    count: outPoints.length
  };
}

function refreshPointCloudDisplay(options = {}) {
  const source = host.rawPointCloud.value;
  if (!source) {
    host.pointCloud.value = null;
    return;
  }
  const ratio = Math.max(1, Math.min(100, Number(host.pointCloudForm.sampleRatio) || 30)) / 100;
  const minZ = Number.isFinite(Number(host.pointCloudForm.minZ)) ? Number(host.pointCloudForm.minZ) : -Infinity;
  const maxZ = Number.isFinite(Number(host.pointCloudForm.maxZ)) ? Number(host.pointCloudForm.maxZ) : Infinity;
  if (options.sizeOnly && host.pointCloud.value) {
    host.pointCloud.value = markRaw({
      ...host.pointCloud.value,
      pointSize: Math.max(0.01, Number(host.pointCloudForm.pointSize) || 0.18)
    });
    return;
  }

  const filtered = source.positions instanceof Float32Array
    ? filteredPackedPointCloud(source, ratio, minZ, maxZ)
    : filteredObjectPointCloud(source, ratio, minZ, maxZ);
  const sourceCount = Number(source.sourceCount || source.count || 0);
  host.pointCloud.value = markRaw({
    ...(filtered || { points: [], colors: [], count: 0 }),
    name: source.name || 'point_cloud',
    sourceCount,
    pointSize: Math.max(0.01, Number(host.pointCloudForm.pointSize) || 0.18),
    sampleRatio: ratio,
    minZ,
    maxZ
  });
  if (host.pointCloudStatus.type === 'ok') {
    host.pointCloudStatus.message = `已显示 ${host.pointCloud.value.count}/${sourceCount} 点`;
  }
}

function schedulePointCloudFilterRefresh() {
  if (host.pointCloudRefreshTimer) {
    window.clearTimeout(host.pointCloudRefreshTimer);
  }
  host.pointCloudRefreshTimer = window.setTimeout(() => {
    host.pointCloudRefreshTimer = 0;
    refreshPointCloudDisplay();
  }, 160);
}

async function importXodr() {
  const file = host.xodrFileInput.value?.files?.[0];
  if (!file) return;
  host.importStatus.loading = true;
  host.importStatus.message = `正在导入 ${file.name || 'XODR 文件'}...`;
  host.importStatus.type = 'loading';
  try {
    const text = await file.text();
    host.suppressDetach.value = true;
    const parsedBundle = parseXodrImportBundle(text);
    const parsedHeader = parsedBundle?.header || parseHeaderFromXodr(text);
    host.importedHeaderXml.value = parsedHeader.rawHeaderXml || '';
    if (parsedHeader.name) host.headerForm.name = parsedHeader.name;
    if (parsedHeader.vendor) host.headerForm.vendor = parsedHeader.vendor;
    if (Number.isFinite(parsedHeader.north)) host.headerForm.north = parsedHeader.north;
    if (Number.isFinite(parsedHeader.south)) host.headerForm.south = parsedHeader.south;
    if (Number.isFinite(parsedHeader.east)) host.headerForm.east = parsedHeader.east;
    if (Number.isFinite(parsedHeader.west)) host.headerForm.west = parsedHeader.west;
    const { details, rawRoads } = parsedBundle.roadDetails;
    const { specs: parsedJunctions, rawById } = parsedBundle.junctions;
    const extras = parsedBundle.extras;
    host.rawRoadXmlById.value = rawRoads;
    host.rawJunctionXmlById.value = rawById;
    host.rawOpenDriveExtras.value = extras;
    host.dirtyRoadIds.value = {};
    host.dirtyJunctionIds.value = {};
    host.headerDirty.value = false;
    host.importStatus.message = '正在解析道路几何（服务端）...';
    const payload = await host.postJson('/api/import-xodr-native', { xml: text, eps: 0.2 });
    await applyNativeRoads(payload.roads || [], parsedJunctions, details);
    host.importedXodrText.value = text;
    host.lastXodr.value = '';
    const roadCount = Array.isArray(payload.roads) ? payload.roads.length : host.roads.value.length;
    const junctionCount = host.junctionMeshes.value.length;
    host.importStatus.message = junctionCount > 0
      ? `已导入 ${roadCount} 条道路、${junctionCount} 个路口`
      : `已导入 ${roadCount} 条道路`;
    host.importStatus.type = 'ok';
    await openSidePanels();
  } catch (error) {
    const message = host.formatErrorMessage(error);
    host.importStatus.message = `导入失败：${message}`;
    host.importStatus.type = 'error';
    window.alert(host.importStatus.message);
  } finally {
    host.suppressDetach.value = false;
    host.importStatus.loading = false;
    host.xodrFileInput.value.value = '';
  }
}

function applyMapYamlText(text, fallback = {}) {
  applyMapYamlToGeo(host.bgGeo, text, fallback);
}

async function openSidePanels() {
  if (host.leftPanelCollapsed) host.leftPanelCollapsed.value = false;
  if (host.rightPanelCollapsed) host.rightPanelCollapsed.value = false;
  if (typeof host.yieldToMain === 'function') await host.yieldToMain();
  window.setTimeout(() => {
    if (typeof host.fitView === 'function') host.fitView();
    if (typeof host.render === 'function') host.render(true);
  }, 280);
}

async function importMapYaml() {
  const file = host.mapYamlFileInput.value?.files?.[0];
  if (!file) return;
  const text = await file.text();
  applyMapYamlText(text, {
    imageWidth: host.bgImage.value?.width || host.bgGeo.imageWidth || 0,
    imageHeight: host.bgImage.value?.height || host.bgGeo.imageHeight || 0
  });
  host.mapYamlFileInput.value.value = '';
  await openSidePanels();
}

async function uploadBackground() {
  const files = Array.from(host.bgFileInput.value?.files || []);
  if (!files.length) return;
  try {
    for (const file of files) {
      if (isYamlFile(file)) {
        const yamlText = await file.text();
        applyMapYamlText(yamlText, {
          imageWidth: host.bgImage.value?.width || host.bgGeo.imageWidth || 0,
          imageHeight: host.bgImage.value?.height || host.bgGeo.imageHeight || 0
        });
        await openSidePanels();
        continue;
      }
      const imagePayload = await loadBackgroundFile(file);
      host.bgImage.value = imagePayload;
      host.bgGeo.imageWidth = Number(imagePayload.width || host.bgGeo.imageWidth || 0);
      host.bgGeo.imageHeight = Number(imagePayload.height || host.bgGeo.imageHeight || 0);
    }
    host.fitView();
    host.render();
  } catch (error) {
    const message = host.formatErrorMessage(error);
    host.importStatus.message = `底图加载失败：${message}`;
    host.importStatus.type = 'error';
    window.alert(host.importStatus.message);
  } finally {
    host.bgFileInput.value.value = '';
  }
}

async function importPointCloud() {
  const file = host.pointCloudFileInput.value?.files?.[0];
  if (!file) return;
  host.pointCloudStatus.message = `正在读取 ${file.name || '点云文件'}...`;
  host.pointCloudStatus.type = 'loading';
  host.pointCloudStatus.progress = 1;
  try {
    const buffer = await readFileBufferWithProgress(file, (progress) => {
      host.pointCloudStatus.progress = progress;
    });
    host.pointCloudStatus.message = `正在解析 ${file.name || '点云文件'}...`;
    host.pointCloudStatus.progress = Math.max(host.pointCloudStatus.progress, 78);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const parsed = parsePointCloudBuffer(buffer, file.name, {
      sampleRatio: 1,
      minZ: -Infinity,
      maxZ: Infinity
    });
    host.pointCloudStatus.message = `正在渲染点云 ${parsed.count} 点...`;
    host.pointCloudStatus.progress = 92;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    host.rawPointCloud.value = markRaw({
      ...parsed,
      sourceCount: parsed.count
    });
    refreshPointCloudDisplay();
    host.pointCloudStatus.progress = 100;
    host.pointCloudStatus.message = `已显示 ${host.pointCloud.value?.count || 0}/${parsed.count} 点，请切换到3D查看`;
    host.pointCloudStatus.type = 'ok';
  } catch (error) {
    host.rawPointCloud.value = null;
    host.pointCloud.value = null;
    host.pointCloudStatus.progress = 0;
    host.pointCloudStatus.message = `点云解析失败：${host.formatErrorMessage(error)}`;
    host.pointCloudStatus.type = 'error';
    window.alert(host.pointCloudStatus.message);
  } finally {
    host.pointCloudFileInput.value.value = '';
  }
}

function clearPointCloud() {
  host.rawPointCloud.value = null;
  host.pointCloud.value = null;
  host.pointCloudStatus.message = '';
  host.pointCloudStatus.type = '';
  host.pointCloudStatus.progress = 0;
}

  Object.assign(host, {
    currentSpec, runValidate, generateXodr, generateAndDownloadXodr, downloadXodr, downloadBlob,
    downloadBackgroundOverlayImage, pickXodrFile, pickMapYamlFile, pickBgFile, pickPointCloudFile,
    importXodr, applyMapYamlText, importMapYaml, uploadBackground, importPointCloud, clearPointCloud,
    refreshPointCloudDisplay, schedulePointCloudFilterRefresh
  });

}
