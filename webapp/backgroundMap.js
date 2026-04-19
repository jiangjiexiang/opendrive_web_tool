import { parseMapYamlText, parsePgmToDataUrl } from './editorUtils.js';

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
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('底图加载失败'));
    img.src = dataUrl;
  });
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
    return parsePgmToDataUrl(arr);
  }
  return fileToDataUrl(file);
}

export function isYamlFile(file) {
  const lower = String(file?.name || '').toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}
