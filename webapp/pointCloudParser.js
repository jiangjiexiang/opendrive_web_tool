function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampColor(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 255;
  return Math.max(0, Math.min(255, num));
}

function packedRgbToBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const packed = num > 1 && Number.isInteger(num) ? num : new Float32Array([num]).buffer;
  if (typeof packed !== 'number') {
    const uint = new Uint32Array(packed)[0];
    return [(uint >> 16) & 255, (uint >> 8) & 255, uint & 255];
  }
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

function packedUintToBytes(uint) {
  return [(uint >> 16) & 255, (uint >> 8) & 255, uint & 255];
}

function splitDataLine(line) {
  return line.trim().split(/[,\s]+/).filter(Boolean);
}

function normalizeParseOptions(options = {}) {
  const ratioValue = Number(options.sampleRatio ?? options.keepRatio);
  const sampleStep = Math.max(1, Math.floor(Number(options.sampleStep || 1)));
  const sampleRatio = Number.isFinite(ratioValue)
    ? Math.max(0.001, Math.min(1, ratioValue))
    : (1 / sampleStep);
  const minZ = Number(options.minZ);
  const maxZ = Number(options.maxZ);
  return {
    sampleStep,
    sampleRatio,
    minZ: Number.isFinite(minZ) ? minZ : -Infinity,
    maxZ: Number.isFinite(maxZ) ? maxZ : Infinity
  };
}

function shouldKeepSample(index, parseOptions) {
  if (parseOptions.sampleRatio >= 0.999) return true;
  const bucket = ((index * 2654435761) >>> 0) / 4294967296;
  return bucket < parseOptions.sampleRatio;
}

function parseAsciiRows(lines, options = {}) {
  const parseOptions = normalizeParseOptions(options);
  const points = [];
  const colors = [];
  let hasColor = false;
  const xIndex = options.xIndex ?? 0;
  const yIndex = options.yIndex ?? 1;
  const zIndex = options.zIndex ?? 2;
  const rIndex = options.rIndex;
  const gIndex = options.gIndex;
  const bIndex = options.bIndex;
  const rgbIndex = options.rgbIndex;

  let seenCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = splitDataLine(trimmed);
    const x = parseNumber(parts[xIndex]);
    const y = parseNumber(parts[yIndex]);
    const z = parseNumber(parts[zIndex]);
    if (x === null || y === null || z === null) continue;
    seenCount += 1;
    if (!shouldKeepSample(seenCount - 1, parseOptions)) continue;
    if (z < parseOptions.minZ || z > parseOptions.maxZ) continue;

    points.push({ x, y, z });

    let rgb = null;
    if (rIndex !== undefined && gIndex !== undefined && bIndex !== undefined) {
      rgb = [clampColor(parts[rIndex]), clampColor(parts[gIndex]), clampColor(parts[bIndex])];
    } else if (rgbIndex !== undefined) {
      rgb = packedRgbToBytes(parts[rgbIndex]);
    } else if (parts.length >= 6) {
      rgb = [clampColor(parts[3]), clampColor(parts[4]), clampColor(parts[5])];
    }

    if (rgb) {
      hasColor = true;
      colors.push({ r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 });
    } else {
      colors.push({ r: 0.72, g: 0.86, b: 1 });
    }
  }

  return { points, colors: hasColor ? colors : [] };
}

function parsePcdHeader(buffer) {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  let lineStart = 0;
  const lines = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 10) continue;
    const rawLine = decoder.decode(bytes.slice(lineStart, i)).replace(/\r$/, '');
    lines.push(rawLine);
    lineStart = i + 1;
    if (/^\s*DATA\s+/i.test(rawLine)) {
      return { lines, dataOffset: lineStart };
    }
    if (i > 1024 * 1024) break;
  }
  return null;
}

function readHeaderValues(lines, key) {
  const line = lines.find((item) => new RegExp(`^\\s*${key}\\s+`, 'i').test(item));
  return line ? line.trim().split(/\s+/).slice(1) : [];
}

function readDataViewValue(view, offset, type, size) {
  const normalizedType = String(type || 'F').toUpperCase();
  const byteSize = Number(size || 4);
  if (normalizedType === 'F') {
    if (byteSize === 4) return view.getFloat32(offset, true);
    if (byteSize === 8) return view.getFloat64(offset, true);
  }
  if (normalizedType === 'I') {
    if (byteSize === 1) return view.getInt8(offset);
    if (byteSize === 2) return view.getInt16(offset, true);
    if (byteSize === 4) return view.getInt32(offset, true);
  }
  if (normalizedType === 'U') {
    if (byteSize === 1) return view.getUint8(offset);
    if (byteSize === 2) return view.getUint16(offset, true);
    if (byteSize === 4) return view.getUint32(offset, true);
  }
  return NaN;
}

function buildPcdLayout(lines) {
  const fields = readHeaderValues(lines, 'FIELDS').map((field) => field.toLowerCase());
  const sizes = readHeaderValues(lines, 'SIZE').map((item) => Number(item));
  const types = readHeaderValues(lines, 'TYPE');
  const counts = readHeaderValues(lines, 'COUNT').map((item) => Math.max(1, Number(item) || 1));
  const pointsValue = Number(readHeaderValues(lines, 'POINTS')[0]);
  const widthValue = Number(readHeaderValues(lines, 'WIDTH')[0]);
  const heightValue = Number(readHeaderValues(lines, 'HEIGHT')[0]);
  if (!fields.length) throw new Error('PCD 文件缺少 FIELDS 字段');
  const offsets = [];
  let pointStep = 0;
  fields.forEach((field, index) => {
    offsets[index] = pointStep;
    pointStep += (sizes[index] || 4) * (counts[index] || 1);
  });
  const pointCount = Number.isFinite(pointsValue) && pointsValue > 0
    ? pointsValue
    : (Number.isFinite(widthValue) && Number.isFinite(heightValue) ? widthValue * heightValue : 0);
  return {
    fields,
    sizes,
    types,
    counts,
    offsets,
    pointStep,
    pointCount,
    xIndex: fields.indexOf('x'),
    yIndex: fields.indexOf('y'),
    zIndex: fields.indexOf('z'),
    rIndex: fields.indexOf('r'),
    gIndex: fields.indexOf('g'),
    bIndex: fields.indexOf('b'),
    rgbIndex: fields.indexOf('rgb') >= 0 ? fields.indexOf('rgb') : fields.indexOf('rgba')
  };
}

function parseAsciiPcd(text, options = {}) {
  const lines = text.split(/\r?\n/);
  const fieldsLine = lines.find((line) => /^\s*FIELDS\s+/i.test(line));
  const dataIndex = lines.findIndex((line) => /^\s*DATA\s+/i.test(line));
  if (dataIndex < 0) {
    return parseAsciiRows(lines, options);
  }
  const dataMode = lines[dataIndex].trim().split(/\s+/)[1] || '';
  if (dataMode.toLowerCase() !== 'ascii') {
    throw new Error('目前仅支持 ASCII PCD 点云');
  }
  const fields = fieldsLine ? fieldsLine.trim().split(/\s+/).slice(1).map((item) => item.toLowerCase()) : [];
  const xIndex = fields.indexOf('x');
  const yIndex = fields.indexOf('y');
  const zIndex = fields.indexOf('z');
  if (xIndex < 0 || yIndex < 0 || zIndex < 0) {
    return parseAsciiRows(lines.slice(dataIndex + 1), options);
  }
  const rIndex = fields.indexOf('r');
  const gIndex = fields.indexOf('g');
  const bIndex = fields.indexOf('b');
  const rgbIndex = fields.indexOf('rgb') >= 0 ? fields.indexOf('rgb') : fields.indexOf('rgba');
  return parseAsciiRows(lines.slice(dataIndex + 1), {
    xIndex,
    yIndex,
    zIndex,
    rIndex: rIndex >= 0 ? rIndex : undefined,
    gIndex: gIndex >= 0 ? gIndex : undefined,
    bIndex: bIndex >= 0 ? bIndex : undefined,
    rgbIndex: rgbIndex >= 0 ? rgbIndex : undefined,
    sampleStep: options.sampleStep,
    sampleRatio: options.sampleRatio,
    minZ: options.minZ,
    maxZ: options.maxZ
  });
}

function parseBinaryPcd(buffer, header, options = {}) {
  const parseOptions = normalizeParseOptions(options);
  const layout = buildPcdLayout(header.lines);
  if (layout.xIndex < 0 || layout.yIndex < 0 || layout.zIndex < 0) {
    throw new Error('PCD 文件缺少 x/y/z 字段');
  }
  if (!layout.pointStep) throw new Error('PCD 点步长无效');
  const view = new DataView(buffer);
  const availablePoints = Math.floor((buffer.byteLength - header.dataOffset) / layout.pointStep);
  const pointCount = layout.pointCount > 0 ? Math.min(layout.pointCount, availablePoints) : availablePoints;
  const maxKeptCount = Math.ceil(pointCount * parseOptions.sampleRatio);
  const positions = new Float32Array(maxKeptCount * 3);
  const colorValues = new Float32Array(maxKeptCount * 3);
  let hasColor = false;
  let validCount = 0;
  for (let i = 0; i < pointCount; i += 1) {
    const base = header.dataOffset + i * layout.pointStep;
    const x = readDataViewValue(view, base + layout.offsets[layout.xIndex], layout.types[layout.xIndex], layout.sizes[layout.xIndex]);
    const y = readDataViewValue(view, base + layout.offsets[layout.yIndex], layout.types[layout.yIndex], layout.sizes[layout.yIndex]);
    const z = readDataViewValue(view, base + layout.offsets[layout.zIndex], layout.types[layout.zIndex], layout.sizes[layout.zIndex]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (!shouldKeepSample(i, parseOptions)) continue;
    if (z < parseOptions.minZ || z > parseOptions.maxZ) continue;
    const out = validCount * 3;
    positions[out] = x;
    positions[out + 1] = y;
    positions[out + 2] = z;

    let rgb = null;
    if (layout.rIndex >= 0 && layout.gIndex >= 0 && layout.bIndex >= 0) {
      rgb = [
        clampColor(readDataViewValue(view, base + layout.offsets[layout.rIndex], layout.types[layout.rIndex], layout.sizes[layout.rIndex])),
        clampColor(readDataViewValue(view, base + layout.offsets[layout.gIndex], layout.types[layout.gIndex], layout.sizes[layout.gIndex])),
        clampColor(readDataViewValue(view, base + layout.offsets[layout.bIndex], layout.types[layout.bIndex], layout.sizes[layout.bIndex]))
      ];
    } else if (layout.rgbIndex >= 0) {
      const rgbOffset = base + layout.offsets[layout.rgbIndex];
      rgb = packedUintToBytes(view.getUint32(rgbOffset, true));
    }
    if (rgb) {
      hasColor = true;
      colorValues[out] = rgb[0] / 255;
      colorValues[out + 1] = rgb[1] / 255;
      colorValues[out + 2] = rgb[2] / 255;
    } else {
      colorValues[out] = 0.72;
      colorValues[out + 1] = 0.86;
      colorValues[out + 2] = 1;
    }
    validCount += 1;
  }
  return {
    positions: validCount === pointCount ? positions : positions.slice(0, validCount * 3),
    colors: hasColor ? (validCount === pointCount ? colorValues : colorValues.slice(0, validCount * 3)) : null,
    count: validCount
  };
}

export function parsePointCloudText(text, fileName = '', options = {}) {
  const isPcd = /\.pcd$/i.test(fileName) || /^\s*#?\s*\.?PCD\b/im.test(text);
  const parsed = isPcd ? parseAsciiPcd(text, options) : parseAsciiRows(text.split(/\r?\n/), options);
  if (!parsed.points.length) {
    throw new Error('没有解析到有效点，文件需要包含 x y z 三列');
  }
  return {
    name: fileName || 'point_cloud',
    points: parsed.points,
    colors: parsed.colors,
    count: parsed.points.length
  };
}

export function parsePointCloudBuffer(buffer, fileName = '', options = {}) {
  const header = parsePcdHeader(buffer);
  const decoder = new TextDecoder('utf-8');
  if (!header) {
    return parsePointCloudText(decoder.decode(buffer), fileName, options);
  }
  const dataLine = header.lines[header.lines.length - 1] || '';
  const dataMode = (dataLine.trim().split(/\s+/)[1] || '').toLowerCase();
  if (dataMode === 'ascii') {
    const text = decoder.decode(buffer);
    return parsePointCloudText(text, fileName, options);
  }
  if (dataMode === 'binary') {
    const parsed = parseBinaryPcd(buffer, header, options);
    if (!parsed.count) {
      throw new Error('没有解析到有效点，文件需要包含 x y z 字段');
    }
    return {
      name: fileName || 'point_cloud',
      positions: parsed.positions,
      colors: parsed.colors,
      count: parsed.count
    };
  }
  if (dataMode === 'binary_compressed') {
    throw new Error('暂不支持 binary_compressed PCD 点云');
  }
  return parsePointCloudText(decoder.decode(buffer), fileName, options);
}
