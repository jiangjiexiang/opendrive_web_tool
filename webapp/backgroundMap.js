import { parseMapYamlText, parsePgmToDataUrl } from './editorUtils.js';

const MAX_BACKGROUND_RENDER_PIXELS = 16000000;
const MAX_BACKGROUND_RENDER_SIDE = 8192;

function getRenderScale(width, height) {
  const w = Math.max(1, Number(width || 0));
  const h = Math.max(1, Number(height || 0));
  const pixelScale = Math.sqrt(MAX_BACKGROUND_RENDER_PIXELS / Math.max(1, w * h));
  const sideScale = MAX_BACKGROUND_RENDER_SIDE / Math.max(w, h);
  return Math.min(1, pixelScale, sideScale);
}

export function applyMapYamlToGeo(bgGeo, yamlText, fallback = {}) {
  const parsed = parseMapYamlText(yamlText, fallback);
  bgGeo.resolution = Math.max(1e-6, Number(parsed.resolution || fallback.resolution || 1));
  bgGeo.originX = Number(parsed.originX || 0);
  bgGeo.originY = Number(parsed.originY || 0);
  bgGeo.yaw = Number(parsed.yaw || 0);
  if (Number(parsed.imageWidth) > 0) bgGeo.imageWidth = Number(parsed.imageWidth);
  if (Number(parsed.imageHeight) > 0) bgGeo.imageHeight = Number(parsed.imageHeight);
}

export function loadBackgroundImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(createBackgroundImagePayload(img, img.naturalWidth || img.width, img.naturalHeight || img.height));
    img.onerror = () => reject(new Error('底图加载失败'));
    img.src = dataUrl;
  });
}

export function loadBackgroundImageFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(createBackgroundImagePayload(img, img.naturalWidth || img.width, img.naturalHeight || img.height));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('底图加载失败'));
    };
    img.src = objectUrl;
  });
}

export function createBackgroundImagePayload(image, sourceWidth, sourceHeight) {
  const originalWidth = Math.max(1, Number(sourceWidth || image?.naturalWidth || image?.width || 0));
  const originalHeight = Math.max(1, Number(sourceHeight || image?.naturalHeight || image?.height || 0));
  const scale = getRenderScale(originalWidth, originalHeight);
  if (scale >= 1) {
    return {
      image,
      width: originalWidth,
      height: originalHeight,
      renderWidth: Number(image?.width || originalWidth),
      renderHeight: Number(image?.height || originalHeight)
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(originalWidth * scale));
  canvas.height = Math.max(1, Math.floor(originalHeight * scale));
  const downsampleCtx = canvas.getContext('2d');
  if (!downsampleCtx) {
    return {
      image,
      width: originalWidth,
      height: originalHeight,
      renderWidth: Number(image?.width || originalWidth),
      renderHeight: Number(image?.height || originalHeight)
    };
  }
  downsampleCtx.imageSmoothingEnabled = true;
  downsampleCtx.imageSmoothingQuality = 'high';
  downsampleCtx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    image: canvas,
    width: originalWidth,
    height: originalHeight,
    renderWidth: canvas.width,
    renderHeight: canvas.height
  };
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export async function backgroundFileToDataUrl(file) {
  const lower = String(file?.name || '').toLowerCase();
  if (lower.endsWith('.pgm')) {
    const arr = await file.arrayBuffer();
    return parsePgmToDataUrl(arr, {
      maxPixels: MAX_BACKGROUND_RENDER_PIXELS,
      maxSide: MAX_BACKGROUND_RENDER_SIDE
    });
  }
  return fileToDataUrl(file);
}

export async function loadBackgroundFile(file) {
  const lower = String(file?.name || '').toLowerCase();
  if (lower.endsWith('.pgm')) {
    const parsed = await backgroundFileToDataUrl(file);
    const dataUrl = typeof parsed === 'string' ? parsed : parsed.dataUrl;
    const payload = await loadBackgroundImage(dataUrl);
    if (parsed && typeof parsed === 'object') {
      payload.width = Number(parsed.width || payload.width);
      payload.height = Number(parsed.height || payload.height);
    }
    return payload;
  }
  return loadBackgroundImageFile(file);
}

export function isYamlFile(file) {
  const lower = String(file?.name || '').toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}
