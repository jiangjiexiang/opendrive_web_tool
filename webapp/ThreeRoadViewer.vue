<template>
  <div ref="hostEl" class="three-viewer"></div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';

const props = defineProps({
  roads: {
    type: Array,
    default: () => []
  },
  selectedRoadId: {
    type: String,
    default: ''
  }
});
const emit = defineEmits(['select-road']);

const hostEl = ref(null);
let renderer = null;
let scene = null;
let camera = null;
let roadGroup = null;
let frame = 0;
let resizeObserver = null;
let dragging = false;
let lastPointer = { x: 0, y: 0 };
let yaw = -0.72;
let pitch = 0.88;
let distance = 120;
let target = new THREE.Vector3(0, 0, 0);
let pointerDown = { x: 0, y: 0 };
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

function roadMaterialState(roadId) {
  return {
    color: 0x2f3f3d,
    opacity: 0.46
  };
}

function finitePoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function roadWidth(road) {
  const left = Math.max(0, Number(road?.leftLaneCount || 0)) * Math.max(0.5, Number(road?.leftLaneWidth || road?.laneWidth || 3.5));
  const right = Math.max(0, Number(road?.rightLaneCount || 0)) * Math.max(0.5, Number(road?.rightLaneWidth || road?.laneWidth || 3.5));
  return Math.max(3.2, left + right || Number(road?.laneWidth || 3.5));
}

function roadLateralExtents(road) {
  const laneWidth = Math.max(0.5, Number(road?.laneWidth || 3.5));
  const leftWidth = Math.max(0.5, Number(road?.leftLaneWidth || laneWidth));
  const rightWidth = Math.max(0.5, Number(road?.rightLaneWidth || laneWidth));
  const leftCount = Math.max(0, Number(road?.leftLaneCount || 0));
  const rightCount = Math.max(0, Number(road?.rightLaneCount || 0));
  const left = leftCount * leftWidth;
  const right = rightCount * rightWidth;
  if (left > 0 || right > 0) {
    return { left, right };
  }
  return { left: laneWidth * 0.5, right: laneWidth * 0.5 };
}

function buildOffsetPath(points, offset) {
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    out.push({
      x: points[i].x - (dy / len) * offset,
      y: points[i].y + (dx / len) * offset
    });
  }
  return out;
}

function makeRoadMesh(road) {
  const points = (Array.isArray(road?.points) ? road.points : []).map(finitePoint).filter(Boolean);
  if (points.length < 2) return null;
  const half = roadWidth(road) * 0.5;
  const left = Array.isArray(road.nativeLeftBoundary) && road.nativeLeftBoundary.length > 1
    ? road.nativeLeftBoundary.map(finitePoint).filter(Boolean)
    : buildOffsetPath(points, half);
  const right = Array.isArray(road.nativeRightBoundary) && road.nativeRightBoundary.length > 1
    ? road.nativeRightBoundary.map(finitePoint).filter(Boolean)
    : buildOffsetPath(points, -half);
  const n = Math.min(left.length, right.length);
  if (n < 2) return null;
  const positions = [];
  const indices = [];
  for (let i = 0; i < n; i += 1) {
    positions.push(left[i].x, 0, -left[i].y, right[i].x, 0, -right[i].y);
    if (i < n - 1) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const state = roadMaterialState(road?.id);
  const material = new THREE.MeshStandardMaterial({
    color: state.color,
    transparent: true,
    opacity: state.opacity,
    roughness: 0.78,
    metalness: 0.02,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.roadId = String(road.id ?? '');
  return mesh;
}

function makeRoadHighlightMesh(road) {
  const points = (Array.isArray(road?.points) ? road.points : []).map(finitePoint).filter(Boolean);
  if (points.length < 2) return null;
  const extents = roadLateralExtents(road);
  const left = buildOffsetPath(points, extents.left);
  const right = buildOffsetPath(points, -extents.right);
  const positions = [];
  const indices = [];
  for (let i = 0; i < points.length; i += 1) {
    positions.push(left[i].x, 0, -left[i].y, right[i].x, 0, -right[i].y);
    if (i < points.length - 1) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xd6a166,
    transparent: true,
    opacity: 0.62,
    roughness: 0.78,
    metalness: 0.02,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.roadId = String(road.id ?? '');
  mesh.userData.kind = 'selection-highlight-surface';
  mesh.position.y = 0.055;
  mesh.renderOrder = 3;
  return mesh;
}

function makeLine(points, color, y = 0.035) {
  const clean = (Array.isArray(points) ? points : []).map(finitePoint).filter(Boolean);
  if (clean.length < 2) return null;
  const geometry = new THREE.BufferGeometry().setFromPoints(clean.map((p) => new THREE.Vector3(p.x, y, -p.y)));
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
}

function applySelectedRoadStyle() {
  if (!roadGroup) return;
  roadGroup.traverse((object) => {
    const roadId = object?.userData?.roadId;
    if (!roadId) return;
    const state = roadMaterialState(roadId);
    if (object.isMesh && object.material) {
      const selected = String(roadId) === String(props.selectedRoadId || '');
      const isHighlight = object.userData?.kind === 'selection-highlight-surface';
      object.visible = !isHighlight || selected;
      object.material.color.setHex(isHighlight ? 0xd6a166 : state.color);
      object.material.opacity = isHighlight ? 0.62 : state.opacity;
      object.material.needsUpdate = true;
    } else if (object.isLine && object.material) {
      const selected = String(roadId) === String(props.selectedRoadId || '');
      const isHighlight = object.userData?.kind === 'selection-highlight';
      object.visible = !isHighlight || selected;
      object.material.color.setHex(isHighlight ? 0xffcf5a : (selected ? 0xffe08a : 0x9bd3c8));
      object.material.opacity = isHighlight ? 1 : (selected ? 1 : 0.78);
      object.material.needsUpdate = true;
    }
  });
  renderOnce();
}

function clearRoadGroup() {
  if (!roadGroup) return;
  roadGroup.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    if (object.material) object.material.dispose();
  });
  scene.remove(roadGroup);
}

function rebuildRoads() {
  if (!scene) return;
  clearRoadGroup();
  roadGroup = new THREE.Group();
  const bounds = new THREE.Box3();
  let hasBounds = false;
  (props.roads || []).forEach((road) => {
    if (road?.visible === false) return;
    const roadId = String(road?.id ?? '');
    const mesh = makeRoadMesh(road);
    if (mesh) {
      roadGroup.add(mesh);
      bounds.expandByObject(mesh);
      hasBounds = true;
    }
    const highlightMesh = makeRoadHighlightMesh(road);
    if (highlightMesh) {
      highlightMesh.visible = roadId === String(props.selectedRoadId || '');
      roadGroup.add(highlightMesh);
    }
    const centerLine = makeLine(road?.points, roadId === String(props.selectedRoadId || '') ? 0xffe08a : 0x9bd3c8, 0.09);
    if (centerLine) {
      centerLine.userData.roadId = roadId;
      roadGroup.add(centerLine);
    }
    const highlightLine = makeLine(road?.points, 0xffcf5a, 0.18);
    if (highlightLine) {
      highlightLine.userData.roadId = roadId;
      highlightLine.userData.kind = 'selection-highlight';
      highlightLine.visible = roadId === String(props.selectedRoadId || '');
      roadGroup.add(highlightLine);
    }
    (Array.isArray(road?.nativeLaneBoundaries) ? road.nativeLaneBoundaries : []).forEach((lane) => {
      const laneLine = makeLine(lane?.points || lane, 0xcfd8d4, 0.08);
      if (laneLine) roadGroup.add(laneLine);
    });
  });
  scene.add(roadGroup);
  if (hasBounds) {
    bounds.getCenter(target);
    const size = bounds.getSize(new THREE.Vector3());
    distance = Math.max(30, Math.min(1800, Math.max(size.x, size.z) * 1.15));
  }
  updateCamera();
  renderOnce();
}

function updateCamera() {
  if (!camera) return;
  pitch = Math.max(0.2, Math.min(1.35, pitch));
  distance = Math.max(8, Math.min(3000, distance));
  const cp = Math.cos(pitch);
  camera.position.set(
    target.x + Math.cos(yaw) * cp * distance,
    target.y + Math.sin(pitch) * distance,
    target.z + Math.sin(yaw) * cp * distance
  );
  camera.lookAt(target);
}

function renderOnce() {
  if (!renderer || !scene || !camera) return;
  renderer.render(scene, camera);
}

function resize() {
  if (!hostEl.value || !renderer || !camera) return;
  const rect = hostEl.value.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderOnce();
}

function onPointerDown(event) {
  dragging = true;
  lastPointer = { x: event.clientX, y: event.clientY };
  pointerDown = { x: event.clientX, y: event.clientY };
  hostEl.value?.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  if (!dragging) return;
  const dx = event.clientX - lastPointer.x;
  const dy = event.clientY - lastPointer.y;
  lastPointer = { x: event.clientX, y: event.clientY };
  yaw += dx * 0.008;
  pitch += dy * 0.006;
  updateCamera();
  renderOnce();
}

function onPointerUp(event) {
  const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
  dragging = false;
  hostEl.value?.releasePointerCapture?.(event.pointerId);
  if (moved <= 4) {
    pickRoadAt(event.clientX, event.clientY);
  }
}

function onWheel(event) {
  event.preventDefault();
  distance *= event.deltaY > 0 ? 1.08 : 0.92;
  updateCamera();
  renderOnce();
}

function pickRoadAt(clientX, clientY) {
  if (!hostEl.value || !camera || !roadGroup) return;
  const rect = hostEl.value.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
  pointerNdc.y = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(roadGroup.children, true)
    .filter((hit) => hit.object?.userData?.roadId);
  if (!hits.length) return;
  emit('select-road', String(hits[0].object.userData.roadId));
}

onMounted(() => {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101817);
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 6000);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  hostEl.value.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xd8fff4, 0x1d2220, 1.7));
  const sun = new THREE.DirectionalLight(0xffddaa, 1.6);
  sun.position.set(80, 120, 60);
  scene.add(sun);
  const grid = new THREE.GridHelper(400, 40, 0x3f5f58, 0x253331);
  grid.position.y = -0.025;
  scene.add(grid);

  hostEl.value.addEventListener('pointerdown', onPointerDown);
  hostEl.value.addEventListener('pointermove', onPointerMove);
  hostEl.value.addEventListener('pointerup', onPointerUp);
  hostEl.value.addEventListener('pointercancel', onPointerUp);
  hostEl.value.addEventListener('wheel', onWheel, { passive: false });
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(hostEl.value);
  resize();
  rebuildRoads();
});

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  if (hostEl.value) {
    hostEl.value.removeEventListener('pointerdown', onPointerDown);
    hostEl.value.removeEventListener('pointermove', onPointerMove);
    hostEl.value.removeEventListener('pointerup', onPointerUp);
    hostEl.value.removeEventListener('pointercancel', onPointerUp);
    hostEl.value.removeEventListener('wheel', onWheel);
  }
  clearRoadGroup();
  renderer?.dispose();
});

watch(() => props.roads, () => {
  if (frame) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = 0;
    rebuildRoads();
  });
}, { deep: true });

watch(() => props.selectedRoadId, () => {
  applySelectedRoadStyle();
});
</script>
