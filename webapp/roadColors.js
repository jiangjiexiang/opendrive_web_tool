import { reactive } from 'vue';

export function createRoadColorState() {
  return {
    roadColorDialog: reactive({
      visible: false,
      allColor: '#3a92ff',
      junctionColor: '#ff9b42'
    }),
    roadColorConfig: reactive({
      allColor: '#3a92ff',
      junctionColor: '#ff9b42'
    })
  };
}

export function openRoadColorDialog(dialog, config) {
  dialog.allColor = config.allColor;
  dialog.junctionColor = config.junctionColor;
  dialog.visible = true;
}

export function closeRoadColorDialog(dialog) {
  dialog.visible = false;
}

export function applyRoadColorDialog(dialog, config) {
  config.allColor = dialog.allColor;
  config.junctionColor = dialog.junctionColor;
  dialog.visible = false;
}

export function resetRoadColorDialogDefaults(dialog) {
  dialog.allColor = '#3a92ff';
  dialog.junctionColor = '#ff9b42';
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
