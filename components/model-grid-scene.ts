import * as THREE from 'three';
import { gridSpacingOptions } from '@/lib/schematic-layers';

type GridBounds = { minX: number; maxX: number; minY: number; maxY: number };

/** Retained display lines in workplane coordinates; these never provide snap geometry. */
export function createModelGridScene(root: THREE.Group) {
  const material = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.17,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), material);
  lines.renderOrder = 20;
  lines.name = 'model-sketch-grid';
  lines.userData.modelCadSketchGrid = true;
  lines.visible = false;
  root.add(lines);
  let retained = '';
  let disposed = false;
  let revision = 0;
  return {
    lines,
    update({
      visible,
      dark,
      spacing,
      pixelsPerUnit,
      bounds,
    }: {
      visible: boolean;
      dark: boolean;
      spacing: number;
      pixelsPerUnit: number;
      bounds: GridBounds;
    }) {
      if (disposed) return;
      const selected = gridSpacingOptions.some((option) => option === spacing) ? spacing : 0.5;
      lines.userData.modelGridSpacing = selected;
      material.color.set(dark ? 0xaeb7bd : 0x6f7e88);
      lines.visible =
        visible &&
        pixelsPerUnit > 0 &&
        Number.isFinite(pixelsPerUnit) &&
        Object.values(bounds).every((value) => Number.isFinite(value) && Math.abs(value) <= 1e12) &&
        bounds.maxX > bounds.minX &&
        bounds.maxY > bounds.minY;
      if (!lines.visible) return;
      // At most 256 intervals per axis, even for a near edge-on workplane.
      const minimum = Math.max(
        selected,
        6 / pixelsPerUnit,
        (bounds.maxX - bounds.minX) / 254,
        (bounds.maxY - bounds.minY) / 254,
      );
      const step = selected * 2 ** Math.ceil(Math.log2(minimum / selected));
      if (!Number.isFinite(step) || step > 1e12) {
        lines.visible = false;
        return;
      }
      const minX = Math.floor(bounds.minX / step) * step;
      const maxX = Math.ceil(bounds.maxX / step) * step;
      const minY = Math.floor(bounds.minY / step) * step;
      const maxY = Math.ceil(bounds.maxY / step) * step;
      const key = `${step}:${minX}:${maxX}:${minY}:${maxY}`;
      lines.userData.modelGridDisplaySpacing = step;
      lines.userData.modelGridBounds = { minX, maxX, minY, maxY };
      if (retained === key) return;
      retained = key;
      const positions: number[] = [];
      const columns = Math.round((maxX - minX) / step);
      const rows = Math.round((maxY - minY) / step);
      for (let i = 0; i <= columns; i++) {
        const x = minX + i * step;
        positions.push(x, minY, 0, x, maxY, 0);
      }
      for (let i = 0; i <= rows; i++) {
        const y = minY + i * step;
        positions.push(minX, y, 0, maxX, y, 0);
      }
      const previous = lines.geometry;
      lines.geometry = new THREE.BufferGeometry();
      lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      previous.dispose();
      lines.userData.modelGridGeometryRevision = ++revision;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lines.removeFromParent();
      lines.geometry.dispose();
      material.dispose();
    },
  };
}
