import { computed } from 'vue';

export function installMeasure(host) {
function buildMeasureStats(includeHover = false) {
  const points = [];
  (host.measurePoints.value || []).forEach((pt) => {
    points.push({ x: Number(pt.x), y: Number(pt.y) });
  });
  if (includeHover && host.mode.value === 'measure' && host.measureHoverPoint.value && points.length > 0) {
    points.push({ x: Number(host.measureHoverPoint.value.x), y: Number(host.measureHoverPoint.value.y) });
  }
  const segmentLengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segmentLengths.push(len);
    total += len;
  }
  return {
    pointCount: host.measurePoints.value.length,
    segmentCount: Math.max(0, host.measurePoints.value.length - 1),
    total,
    segmentLengths
  };
}

const measureStats = computed(() => buildMeasureStats(false));

function drawMeasureLabel(text, sx, sy) {
  const label = String(text);
  host.ctx.save();
  host.ctx.font = '12px sans-serif';
  const w = host.ctx.measureText(label).width;
  const padX = 6;
  const h = 18;
  const x = sx - w / 2 - padX;
  const y = sy - h - 10;
  host.ctx.fillStyle = 'rgba(7, 14, 26, 0.78)';
  host.ctx.fillRect(x, y, w + padX * 2, h);
  host.ctx.strokeStyle = 'rgba(120, 210, 255, 0.85)';
  host.ctx.lineWidth = 1;
  host.ctx.strokeRect(x + 0.5, y + 0.5, w + padX * 2 - 1, h - 1);
  host.ctx.fillStyle = '#eaf6ff';
  host.ctx.fillText(label, sx - w / 2, y + 13);
  host.ctx.restore();
}

function drawMeasureOverlay() {
  if (!host.measurePoints.value.length && !(host.mode.value === 'measure' && host.measureHoverPoint.value)) return;
  const renderPoints = (host.measurePoints.value || []).map((pt) => ({ x: Number(pt.x), y: Number(pt.y) }));
  if (host.mode.value === 'measure' && host.measureHoverPoint.value && renderPoints.length > 0) {
    renderPoints.push({
      x: Number(host.measureHoverPoint.value.x),
      y: Number(host.measureHoverPoint.value.y)
    });
  }
  if (renderPoints.length >= 2) {
    drawPolyline(renderPoints, '#ffe28a', 2.2, false, false);
  }

  for (let i = 0; i < host.measurePoints.value.length; i += 1) {
    const pt = host.measurePoints.value[i];
    const p = worldToScreen(pt.x, pt.y);
    host.ctx.beginPath();
    host.ctx.arc(p.x, p.y, 4.6, 0, Math.PI * 2);
    host.ctx.fillStyle = '#fff3b8';
    host.ctx.fill();
    host.ctx.strokeStyle = '#1b2430';
    host.ctx.lineWidth = 1.2;
    host.ctx.stroke();
  }

  const fullStats = buildMeasureStats(true);
  if (renderPoints.length >= 2) {
    for (let i = 1; i < renderPoints.length; i += 1) {
      const a = renderPoints[i - 1];
      const b = renderPoints[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const mid = worldToScreen((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
      drawMeasureLabel(`${segLen.toFixed(3)} m`, mid.x, mid.y);
    }
    const last = renderPoints[renderPoints.length - 1];
    const lastS = worldToScreen(last.x, last.y);
    drawMeasureLabel(`总长 ${fullStats.total.toFixed(3)} m`, lastS.x + 6, lastS.y - 8);
  }
}


  host.buildMeasureStats = buildMeasureStats;
  host.measureStats = computed(() => buildMeasureStats(false));
  host.drawMeasureOverlay = drawMeasureOverlay;

}
