'use client';
import { useLayoutEffect, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { modelScaleLength } from './model-scale';

export function modelScaleAxes(camera: THREE.Camera) {
  const inverse = camera.quaternion.clone().invert();
  return [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, 1],
  ].map((axis) => {
    const point = new THREE.Vector3(...axis).applyQuaternion(inverse);
    return { x: Math.round(point.x * 10000) / 10000, y: Math.round(-point.y * 10000) / 10000 };
  });
}

export default function ModelSpatialScale({
  update,
  read,
}: {
  update: RefObject<() => void>;
  read: RefObject<() => { spacing: number; axes: { x: number; y: number }[] }>;
}) {
  const [view, setView] = useState({
    length: 1,
    width: 20,
    axes: [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ],
  });
  useLayoutEffect(() => {
    const refresh = () => {
      const { spacing, axes } = read.current();
      if (!(spacing > 0) || !Number.isFinite(spacing)) return;
      const length = modelScaleLength(spacing);
      if (!length) return;
      const next = { length, width: length / spacing, axes };
      setView((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    update.current = refresh;
    refresh();
    return () => {
      update.current = () => {};
    };
  }, [update, read]);
  return (
    <svg
      className="model-spatial-scale"
      width="112"
      height="116"
      viewBox="-56 -48 112 116"
      role="img"
      aria-label={`3D scale: X, Y and Z axes, ${view.length} mm at the camera target`}
    >
      {view.axes.map((axis, index) => {
        const size = Math.hypot(axis.x, axis.y);
        const x = axis.x * view.width,
          y = axis.y * view.width;
        const labelX = size > 0.1 ? x : 12;
        const labelY = size > 0.1 ? y : -12;
        return (
          <g key={index} className={`model-scale-axis model-scale-axis-${index}`}>
            <line x1="0" y1="0" x2={x} y2={y} />
            <circle className="model-scale-endpoint" cx={labelX} cy={labelY} r="5.5" />
            <text x={labelX} y={labelY}>
              {['X', 'Y', 'Z'][index]}
            </text>
          </g>
        );
      })}
      <circle className="model-scale-origin" r="2" />
      <text className="model-scale-value" x="0" y="54">
        {view.length} mm
      </text>
    </svg>
  );
}
