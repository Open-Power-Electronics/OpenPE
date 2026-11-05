import * as THREE from 'three';
import { modelCameraClipping } from '@/lib/model-camera-clipping';

/** Finite reference plane, separate from physical geometry and all picking. */
export function createModelGroundScene(root: THREE.Group) {
  const surfaceMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), surfaceMaterial);
  const materials = [0.16, 0.3].map(
    (opacity) => new THREE.LineBasicMaterial({ transparent: true, opacity, depthWrite: false }),
  );
  const lines = materials.map(
    (material) =>
      new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute(
          'position',
          new THREE.Float32BufferAttribute([], 3),
        ),
        material,
      ),
  );
  // Flat strips give the axes real width on WebGL, where line widths are fixed.
  const axes = [0, 1].map((index) => {
    const axis = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    axis.name = `model-ground-axis-${index === 0 ? 'x' : 'y'}`;
    axis.renderOrder = 1;
    return axis;
  });
  root.name = 'model-ground';
  root.matrixAutoUpdate = false;
  root.matrix.makeScale(1, -1, -1);
  root.add(surface, ...lines, ...axes);
  root.traverse((node) => {
    node.raycast = () => {};
  });
  let retained = '';
  let disposed = false;
  const sphere = new THREE.Sphere();
  return {
    clippingRange(camera: THREE.Camera, target: THREE.Vector3) {
      return root.visible && retained
        ? modelCameraClipping({ position: camera.position, target, bounds: sphere })
        : null;
    },
    update({
      bounds,
      boardThickness,
      boardCenter,
      spacing,
      unitsPerPixel,
      dark,
      visible,
      gridVisible,
    }: {
      bounds: THREE.Box3;
      boardThickness: number;
      boardCenter: { x: number; y: number };
      spacing: number;
      unitsPerPixel: number;
      dark: boolean;
      visible: boolean;
      gridVisible: boolean;
    }) {
      if (disposed) return;
      root.visible = visible && unitsPerPixel > 0 && Number.isFinite(unitsPerPixel);
      if (!root.visible) return;
      lines.forEach((line) => {
        line.visible = gridVisible;
      });
      surfaceMaterial.color.set(dark ? 0x65717b : 0xc1c9cf);
      materials[0].color.set(dark ? 0xa0adb8 : 0x667783);
      materials[1].color.copy(materials[0].color);
      axes[0].material.color.set(dark ? 0xc77c7c : 0xa75555);
      axes[1].material.color.set(dark ? 0x74af90 : 0x478264);
      const size = bounds.isEmpty()
        ? 50
        : Math.max(50, bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
      const step =
        spacing *
        2 **
          Math.max(
            0,
            Math.ceil(Math.log2(Math.max((8 * unitsPerPixel) / spacing, size / spacing / 128))),
          );
      if (!(step > 0) || !Number.isFinite(step)) {
        root.visible = false;
        return;
      }
      const span = size * 0.8;
      const minX = -span,
        maxX = span,
        minY = -span,
        maxY = span;
      // Reflect native Y and keep the floor below back-side coatings.
      const center = new THREE.Vector3(boardCenter.x, -boardCenter.y, -boardThickness / 2 - 0.05);
      root.matrix.setPosition(center);
      root.matrixWorldNeedsUpdate = true;
      sphere.center.copy(center);
      sphere.radius = Math.SQRT2 * span;
      const width = Math.min(span / 20, unitsPerPixel * 4);
      axes[0].scale.set(span * 2, width, 1);
      axes[1].scale.set(width, span * 2, 1);
      const key = [step, span].join(':');
      if (key === retained) return;
      retained = key;
      surface.scale.set(maxX - minX, maxY - minY, 1);
      const positions: number[][] = [[], []];
      const intervals = Math.floor(span / step);
      for (let index = -intervals; index <= intervals; index++) {
        const x = index * step;
        positions[index % 5 === 0 ? 1 : 0].push(x, minY, 0, x, maxY, 0);
      }
      for (let index = -intervals; index <= intervals; index++) {
        const y = index * step;
        positions[index % 5 === 0 ? 1 : 0].push(minX, y, 0, maxX, y, 0);
      }
      positions[1].push(
        minX,
        minY,
        0,
        maxX,
        minY,
        0,
        maxX,
        minY,
        0,
        maxX,
        maxY,
        0,
        maxX,
        maxY,
        0,
        minX,
        maxY,
        0,
        minX,
        maxY,
        0,
        minX,
        minY,
        0,
      );
      lines.forEach((line, index) => {
        line.geometry.dispose();
        line.geometry = new THREE.BufferGeometry();
        line.geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(positions[index], 3),
        );
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.clear();
      surface.geometry.dispose();
      surfaceMaterial.dispose();
      lines.forEach((line) => {
        line.geometry.dispose();
      });
      axes.forEach((axis) => {
        axis.geometry.dispose();
        axis.material.dispose();
      });
      materials.forEach((material) => material.dispose());
    },
  };
}
