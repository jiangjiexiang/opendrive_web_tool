export const CONNECTOR_SAS_TUNE_OVERRIDES = {
  '2:end->3:start': { qPreferred: 1.35, qMin: 0.7, qMax: 2.1 },
  '3:start->2:end': { qPreferred: 0.75, qMin: 0.5, qMax: 1.4 }
};

export const GRID_BASE_M = 0.1;
export const GRID_TARGET_PX = 9;
export const MAX_EXPORT_IMAGE_PIXELS = 16000000;
export const MAX_EXPORT_IMAGE_SIDE = 8192;
export const ROAD_RENDER_CACHE = Symbol('roadRenderCache');
export const ROAD_BOUNDS_CACHE = Symbol('roadBoundsCache');
export const ROAD_LIST_ROW_HEIGHT = 56;
export const ROAD_LIST_OVERSCAN = 8;
export const VIRTUAL_ROAD_LIST_THRESHOLD = 120;
export const LARGE_MAP_TREE_THRESHOLD = 400;
export const LARGE_MAP_CHILD_INDEX_THRESHOLD = 800;
export const IMPORT_ROAD_CHUNK_SIZE = 120;
export const FIT_VIEW_MAX_ROAD_SAMPLES = 2400;
export const FIT_VIEW_MAX_POINTS_PER_ROAD = 48;
/** 两点绘制：平滑度最高时，弦长达到该值（米）才弯成弧线 */
export const DRAW_MIN_CHORD_FOR_CURVE_AT_MAX_SMOOTH_M = 2;
/** 两点绘制：平滑度最低时，弦长需达到该值（米）才弯成弧线 */
export const DRAW_MIN_CHORD_FOR_CURVE_AT_MIN_SMOOTH_M = 12;
