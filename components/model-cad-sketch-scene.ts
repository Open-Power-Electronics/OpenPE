import * as THREE from 'three';
import type { ModelCadSketch, ModelCadSketchPlane } from './ModelCadSketchPanel';
import { createModelGridScene } from './model-grid-scene';

/** Workplanes use native PCB axes; the Model renderer reflects native Y. */
export function modelCadSketchFrame(plane: ModelCadSketchPlane, origin: ModelCadSketch['origin']) {
  const center = new THREE.Vector3(origin.x, -origin.y, origin.z);
  const u = plane === 'YZ' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(1, 0, 0);
  const v = plane === 'XY' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, 1);
  const normal =
    plane === 'XY'
      ? new THREE.Vector3(0, 0, 1)
      : plane === 'XZ'
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
  return { center, u, v, normal };
}

/** Transient sketch lines share the PCB scene/camera and never enter design data. */
export function createModelCadSketchScene(root: THREE.Group, extent: number) {
  const grid = createModelGridScene(root);
  grid.lines.removeFromParent();
  const span = Math.max(60, extent);
  let current: ModelCadSketch | null = null;
  let dark = false;
  let options = { visible: true, spacing: 0.5 };
  let view: { camera: THREE.Camera; width: number; height: number } | null = null;
  const raycaster = new THREE.Raycaster();
  const updateGrid = () => {
    if (current?.phase !== 'sketch') return;
    const { center, u, v, normal } = modelCadSketchFrame(current.plane, current.origin);
    grid.lines.matrixAutoUpdate = false;
    grid.lines.matrix.makeBasis(u, v, u.clone().cross(v)).setPosition(center);
    grid.lines.matrixWorldNeedsUpdate = true;
    let bounds = { minX: -span, maxX: span, minY: -span, maxY: span };
    let pixelsPerUnit = 1;
    if (view) {
      const { camera, width, height } = view;
      camera.updateMatrixWorld(true);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center);
      const corners: THREE.Vector2[] = [];
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
        const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (!point) continue;
        point.sub(center);
        const local = new THREE.Vector2(point.dot(u), point.dot(v));
        if (Number.isFinite(local.x) && Number.isFinite(local.y) && local.length() <= 1e7)
          corners.push(local);
      }
      if (corners.length === 4)
        bounds = {
          minX: Math.min(...corners.map((point) => point.x)),
          maxX: Math.max(...corners.map((point) => point.x)),
          minY: Math.min(...corners.map((point) => point.y)),
          maxY: Math.max(...corners.map((point) => point.y)),
        };
      const anchor = center
        .clone()
        .addScaledVector(u, (bounds.minX + bounds.maxX) / 2)
        .addScaledVector(v, (bounds.minY + bounds.maxY) / 2);
      const projected = anchor.clone().project(camera);
      const screenVector = (axis: THREE.Vector3) => {
        const point = anchor.clone().add(axis).project(camera).sub(projected);
        return new THREE.Vector2((point.x * width) / 2, (point.y * height) / 2);
      };
      const screenU = screenVector(u),
        screenV = screenVector(v);
      // Distance between the projected parallel lines, including plane foreshortening.
      pixelsPerUnit =
        Math.abs(screenU.cross(screenV)) / Math.max(screenU.length(), screenV.length());
    }
    grid.update({ ...options, dark, pixelsPerUnit, bounds });
  };
  const clear = () => {
    root.traverse((object) => {
      if (object === grid.lines) return;
      if (!(object instanceof THREE.Line || object instanceof THREE.Points)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        material.dispose();
    });
    root.clear();
  };
  return {
    update(
      sketch: ModelCadSketch | null,
      nextDark: boolean,
      nextOptions = { visible: true, spacing: 0.5 },
    ) {
      clear();
      current = sketch;
      dark = nextDark;
      options = nextOptions;
      if (!sketch) return;
      const { center, u, v } = modelCadSketchFrame(sketch.plane, sketch.origin);
      const world = (point: { x: number; y: number }) =>
        center.clone().addScaledVector(u, point.x).addScaledVector(v, point.y);
      const drawing = sketch.phase === 'sketch';
      if (drawing) {
        root.add(grid.lines);
        updateGrid();
      }
      if (sketch.phase === 'plane' || drawing) {
        const boundary = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(
            [
              { x: -span, y: -span },
              { x: span, y: -span },
              { x: span, y: -span },
              { x: span, y: span },
              { x: span, y: span },
              { x: -span, y: span },
              { x: -span, y: span },
              { x: -span, y: -span },
              { x: -span, y: 0 },
              { x: span, y: 0 },
              { x: 0, y: -span },
              { x: 0, y: span },
            ].map(world),
          ),
          new THREE.LineBasicMaterial({
            color: dark ? 0xaeb7bd : 0x6f7e88,
            transparent: true,
            opacity: 0.4,
            depthTest: false,
            depthWrite: false,
          }),
        );
        boundary.renderOrder = 21;
        boundary.userData.modelCadSketchPlane = true;
        root.add(boundary);
      }
      let points = [...sketch.points];
      if (sketch.shape === 'rectangle' && points.length === 2) {
        const [a, b] = points;
        points = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
      } else if (sketch.shape === 'circle' && points.length === 2) {
        const [a, b] = points,
          radius = Math.hypot(b.x - a.x, b.y - a.y);
        points = Array.from({ length: 97 }, (_, i) => ({
          x: a.x + radius * Math.cos((i * Math.PI) / 48),
          y: a.y + radius * Math.sin((i * Math.PI) / 48),
        }));
      } else if (sketch.shape === 'polygon') {
        if (sketch.closed && points.length > 2) points.push(points[0]);
        else if (drawing && sketch.cursor) points.push(sketch.cursor);
      }
      const color = dark ? 0x82c1ff : 0x2684d9;
      if (points.length > 1) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points.map(world)),
          new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false }),
        );
        line.renderOrder = 22;
        line.userData.modelCadSketch = true;
        root.add(line);
      }
      if (drawing && sketch.points.length) {
        const vertices = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints(sketch.points.map(world)),
          new THREE.PointsMaterial({
            color,
            size: 6,
            sizeAttenuation: false,
            depthTest: false,
            depthWrite: false,
          }),
        );
        vertices.renderOrder = 23;
        vertices.userData.modelCadSketch = true;
        root.add(vertices);
      }
    },
    updateGrid(nextView: { camera: THREE.Camera; width: number; height: number }) {
      view = nextView;
      updateGrid();
    },
    dispose() {
      clear();
      grid.dispose();
    },
  };
}
