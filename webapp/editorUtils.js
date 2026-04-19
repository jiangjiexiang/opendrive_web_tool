export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function vecAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vecSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vecScale(v, s) {
  return { x: v.x * s, y: v.y * s };
}

export function vecDot(a, b) {
  return a.x * b.x + a.y * b.y;
}

export function vecLen(v) {
  return Math.hypot(v.x, v.y);
}

export function normalizeVec(v, fallback = { x: 1, y: 0 }) {
  const len = vecLen(v);
  if (len < 1e-8) return { ...fallback };
  return { x: v.x / len, y: v.y / len };
}

export function perpLeft(v) {
  return { x: -v.y, y: v.x };
}

export function rotateVec(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: v.x * c - v.y * s,
    y: v.x * s + v.y * c
  };
}

export function convexHull(points) {
  const pts = (points || [])
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length <= 2) return pts;
  pts.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function solveVirtualIntersection(approaches) {
  if (!Array.isArray(approaches) || !approaches.length) return null;
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  let avgX = 0;
  let avgY = 0;
  approaches.forEach((a) => {
    const d = normalizeVec(a.dir);
    const p = a.pose;
    const m00 = 1 - d.x * d.x;
    const m01 = -d.x * d.y;
    const m11 = 1 - d.y * d.y;
    a11 += m00;
    a12 += m01;
    a22 += m11;
    b1 += m00 * p.x + m01 * p.y;
    b2 += m01 * p.x + m11 * p.y;
    avgX += p.x;
    avgY += p.y;
  });
  avgX /= approaches.length;
  avgY /= approaches.length;
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-6) return { x: avgX, y: avgY };
  return {
    x: (b1 * a22 - b2 * a12) / det,
    y: (a11 * b2 - a12 * b1) / det
  };
}

export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function distPointToSeg(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
  const t = c1 / c2;
  const px = a.x + t * vx;
  const py = a.y + t * vy;
  return Math.hypot(p.x - px, p.y - py);
}

export function sampleBezier(p0, p1, p2, p3, segments = 24) {
  const pts = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    });
  }
  return pts;
}

export function dirAngle(a, b) {
  const ua = normalizeVec(a);
  const ub = normalizeVec(b);
  return Math.acos(clamp(vecDot(ua, ub), -1, 1));
}

export function buildBezierWithRadiusGuard(p0, p3, d0, d3, smoothness, minRadius) {
  let start = { x: p0.x, y: p0.y };
  let end = { x: p3.x, y: p3.y };
  const angle = Math.max(0.02, dirAngle(d0, d3));
  const radius = Math.max(1, Number(minRadius || 1));
  let chord = Math.hypot(end.x - start.x, end.y - start.y);
  const minChord = Math.max(0.5, 2 * radius * Math.sin(angle * 0.5));
  if (chord < minChord) {
    const extra = (minChord - chord) * 0.5;
    start = vecSub(start, vecScale(d0, extra));
    end = vecAdd(end, vecScale(d3, extra));
    chord = Math.hypot(end.x - start.x, end.y - start.y);
  }

  const circularHandle = (4 / 3) * Math.tan(angle * 0.25) * radius;
  let handleLen = Math.max(4, chord * Number(smoothness || 0.34), circularHandle);
  handleLen = Math.min(handleLen, Math.max(8, chord * 1.2));

  const p1 = vecAdd(start, vecScale(d0, handleLen));
  const p2 = vecSub(end, vecScale(d3, handleLen));
  return sampleBezier(start, p1, p2, end, Math.max(18, Math.ceil(chord / 1.8)));
}

export function parseMapYamlText(text, fallback = {}) {
  const yaml = String(text || '');
  const readValue = (key) => {
    const match = yaml.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)\\s*$`, 'm'));
    return match ? match[1].trim() : '';
  };
  const parseNum = (value, fallbackValue = 0) => {
    const n = Number(String(value || '').replace(/[,\\]]+$/g, '').trim());
    return Number.isFinite(n) ? n : fallbackValue;
  };
  const originMatch = yaml.match(/^\s*origin\s*:\s*\[\s*([^,\]]+)\s*,\s*([^,\]]+)\s*,\s*([^\]]+)\s*\]\s*$/m);
  return {
    resolution: parseNum(readValue('resolution'), fallback.resolution || 1),
    originX: originMatch ? parseNum(originMatch[1], 0) : parseNum(readValue('origin_x'), 0),
    originY: originMatch ? parseNum(originMatch[2], 0) : parseNum(readValue('origin_y'), 0),
    yaw: originMatch ? parseNum(originMatch[3], 0) : 0,
    imageWidth: parseNum(readValue('image_width'), fallback.imageWidth || 0),
    imageHeight: parseNum(readValue('image_height'), fallback.imageHeight || 0)
  };
}

export function parsePgmToDataUrl(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let i = 0;
  const isSpace = (c) => c === 9 || c === 10 || c === 13 || c === 32;
  const skipWhitespaceAndComments = () => {
    while (i < bytes.length) {
      if (bytes[i] === 35) {
        while (i < bytes.length && bytes[i] !== 10) i += 1;
      } else if (isSpace(bytes[i])) {
        i += 1;
      } else {
        break;
      }
    }
  };
  const readToken = () => {
    skipWhitespaceAndComments();
    const start = i;
    while (i < bytes.length && !isSpace(bytes[i]) && bytes[i] !== 35) i += 1;
    return new TextDecoder().decode(bytes.slice(start, i));
  };

  const magic = readToken();
  if (magic !== 'P5' && magic !== 'P2') {
    throw new Error('只支持 PGM(P5/P2) 格式');
  }
  const width = Number(readToken());
  const height = Number(readToken());
  const maxVal = Number(readToken());
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('PGM 宽高解析失败');
  }
  if (!Number.isFinite(maxVal) || maxVal <= 0) {
    throw new Error('PGM 灰度范围解析失败');
  }

  skipWhitespaceAndComments();
  const gray = new Uint8ClampedArray(width * height);
  if (magic === 'P5') {
    const expected = width * height;
    const body = bytes.slice(i, i + expected);
    if (body.length < expected) throw new Error('PGM 数据长度不足');
    for (let k = 0; k < expected; k += 1) {
      gray[k] = Math.round((body[k] / maxVal) * 255);
    }
  } else {
    for (let k = 0; k < gray.length; k += 1) {
      gray[k] = Math.round((Number(readToken()) / maxVal) * 255);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const pgmCtx = canvas.getContext('2d');
  if (!pgmCtx) throw new Error('无法创建 PGM 渲染上下文');
  const imageData = pgmCtx.createImageData(width, height);
  for (let p = 0; p < gray.length; p += 1) {
    const v = gray[p];
    const idx = p * 4;
    imageData.data[idx] = v;
    imageData.data[idx + 1] = v;
    imageData.data[idx + 2] = v;
    imageData.data[idx + 3] = 255;
  }
  pgmCtx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}
