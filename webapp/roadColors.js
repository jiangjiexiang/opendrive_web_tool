import { reactive } from 'vue';

export function createRoadColorState() {
  return {
    roadColorDialog: reactive({
      visible: false,
      allColor: '#3a92ff',
      junctionColor: '#ff9b42',
      junctionGuideColor: '#ffdd9b',
      showRoadLabels: true,
      roadLabelColor: '#d62828'
    }),
    roadColorConfig: reactive({
      allColor: '#3a92ff',
      junctionColor: '#ff9b42',
      junctionGuideColor: '#ffdd9b',
      showRoadLabels: true,
      roadLabelColor: '#d62828'
    })
  };
}

export function openRoadColorDialog(dialog, config) {
  dialog.allColor = config.allColor;
  dialog.junctionColor = config.junctionColor;
  dialog.junctionGuideColor = config.junctionGuideColor;
  dialog.showRoadLabels = Boolean(config.showRoadLabels);
  dialog.roadLabelColor = config.roadLabelColor;
  dialog.visible = true;
}

export function closeRoadColorDialog(dialog) {
  dialog.visible = false;
}

export function applyRoadColorDialog(dialog, config) {
  config.allColor = dialog.allColor;
  config.junctionColor = dialog.junctionColor;
  config.junctionGuideColor = dialog.junctionGuideColor;
  config.showRoadLabels = Boolean(dialog.showRoadLabels);
  config.roadLabelColor = dialog.roadLabelColor;
  dialog.visible = false;
}

export function resetRoadColorDialogDefaults(dialog) {
  dialog.allColor = '#3a92ff';
  dialog.junctionColor = '#ff9b42';
  dialog.junctionGuideColor = '#ffdd9b';
  dialog.showRoadLabels = true;
  dialog.roadLabelColor = '#d62828';
}

function hexToRgba(hex, alpha) {
  const h = String(hex || '').trim();
  const a = Math.max(0, Math.min(1, Number(alpha)));
  const short = /^#([0-9a-fA-F]{3})$/;
  const full = /^#([0-9a-fA-F]{6})$/;
  if (short.test(h)) {
    const raw = h.slice(1);
    const r = Number.parseInt(raw[0] + raw[0], 16);
    const g = Number.parseInt(raw[1] + raw[1], 16);
    const b = Number.parseInt(raw[2] + raw[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  if (full.test(h)) {
    const raw = h.slice(1);
    const r = Number.parseInt(raw.slice(0, 2), 16);
    const g = Number.parseInt(raw.slice(2, 4), 16);
    const b = Number.parseInt(raw.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return '';
}

function isJunctionRoad(road) {
  return String(road?.junction ?? '-1') !== '-1';
}

export function getRoadPaletteForRoad(road, selected, roadColorConfig, defaultRoadRenderStyle) {
  if (selected) {
    return {
      fill: defaultRoadRenderStyle.selectedFill,
      edge: defaultRoadRenderStyle.selectedEdge,
      lane: defaultRoadRenderStyle.selectedLane,
      center: defaultRoadRenderStyle.selectedCenter
    };
  }
  const color = isJunctionRoad(road) ? roadColorConfig.junctionColor : roadColorConfig.allColor;
  const fill = hexToRgba(color, 0.22);
  const edge = hexToRgba(color, 0.95);
  const lane = hexToRgba(color, 0.72);
  const center = hexToRgba(color, 1);
  if (fill && edge && lane && center) return { fill, edge, lane, center };
  return {
    fill: defaultRoadRenderStyle.baseFill,
    edge: defaultRoadRenderStyle.baseEdge,
    lane: defaultRoadRenderStyle.baseLane,
    center: defaultRoadRenderStyle.baseCenter
  };
}

export function getJunctionGuideStyle(roadColorConfig) {
  const base = String(roadColorConfig?.junctionGuideColor || '#ffdd9b');
  return {
    polygonFill: hexToRgba(base, 0.22) || 'rgba(238, 181, 98, 0.22)',
    polygonStroke: hexToRgba(base, 0.78) || 'rgba(255, 221, 155, 0.78)',
    approachLine: hexToRgba(base, 0.7) || 'rgba(118, 251, 209, 0.7)',
    innerLane: hexToRgba(base, 0.65) || 'rgba(255, 246, 166, 0.65)',
    centerDot: hexToRgba(base, 1) || '#fff4be'
  };
}
