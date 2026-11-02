'use client';
import { useEffect, useRef, useState } from 'react';
import { Maximize2, RotateCw } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { modelMeshGroup, disposeModelGroup, type MeshData } from '@/lib/model-mesh';
import { api } from '@/lib/bridge';
import type { FootprintModel } from '@/lib/pcb';

function place(group: THREE.Group, model?: FootprintModel) {
  group.position.set(model?.offset.x ?? 0, model?.offset.y ?? 0, model?.offset.z ?? 0);
  group.scale.set(model?.scale.x ?? 1, model?.scale.y ?? 1, model?.scale.z ?? 1);
  group.rotation.set(
    -THREE.MathUtils.degToRad(model?.rotation.x ?? 0),
    -THREE.MathUtils.degToRad(model?.rotation.y ?? 0),
    -THREE.MathUtils.degToRad(model?.rotation.z ?? 0),
    'ZYX',
  );
  group.visible = !model?.hidden;
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      material.opacity = model?.opacity ?? 1;
      material.transparent = material.opacity < 1;
      material.depthWrite = material.opacity === 1;
    }
  });
}

export default function ModelPreview({
  id = '',
  index = 0,
  load,
  model,
}: {
  id?: string;
  index?: number;
  load?: (signal: AbortSignal) => Promise<MeshData[]>;
  model?: FootprintModel;
}) {
  const host = useRef<HTMLDivElement>(null);
  const currentModel = useRef(model);
  currentModel.current = model;
  const groupRef = useRef<THREE.Group | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState('Loading 3D model…');
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (groupRef.current) place(groupRef.current, model);
  }, [model]);
  useEffect(() => {
    const control = new AbortController();
    let cleanup = () => {};
    setStatus('Loading 3D model…');
    setFailed(false);
    void (async () => {
      const meshes: MeshData[] = load
        ? await load(control.signal)
        : (
            await (
              await api(`library-model?id=${encodeURIComponent(id)}&index=${index}`, {
                signal: control.signal,
              })
            ).json()
          ).meshes;
      if (control.signal.aborted || !host.current) return;
      if (!meshes.length) throw new Error('This model has no preview geometry.');
      const el = host.current;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.domElement.tabIndex = 0;
      renderer.domElement.setAttribute('aria-label', 'Rotate and zoom 3D preview');
      el.appendChild(renderer.domElement);
      const scene = new THREE.Scene(),
        group = modelMeshGroup(meshes);
      groupRef.current = group;
      place(group, currentModel.current);
      scene.add(group);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 3));
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(1, -1, 2);
      scene.add(light);
      const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 10000);
      camera.up.set(0, 0, 1);
      const orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = true;
      const axes = new THREE.AxesHelper(1);
      (axes.material as THREE.Material).depthTest = false;
      axes.renderOrder = 1000;
      axes.visible = !!currentModel.current;
      scene.add(axes);
      fit.current = () => {
        const bounds = new THREE.Box3().setFromObject(group);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3()).length() || 1;
        axes.scale.setScalar(size * 0.3);
        camera.near = size / 1000;
        camera.far = size * 100;
        camera.position.copy(center).add(new THREE.Vector3(size, -size, size * 0.8));
        orbit.target.copy(center);
        camera.updateProjectionMatrix();
        orbit.update();
      };
      fit.current();
      const resize = () => {
        const width = el.clientWidth,
          height = el.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(el);
      resize();
      renderer.setAnimationLoop(() => {
        orbit.update();
        renderer.render(scene, camera);
      });
      cleanup = () => {
        observer.disconnect();
        orbit.dispose();
        renderer.setAnimationLoop(null);
        disposeModelGroup(group);
        axes.geometry.dispose();
        (axes.material as THREE.Material).dispose();
        renderer.dispose();
        renderer.domElement.remove();
        groupRef.current = null;
        fit.current = null;
      };
      setStatus('');
    })().catch((e) => {
      if (!control.signal.aborted) {
        setStatus((e as Error).message);
        setFailed(true);
      }
    });
    return () => {
      control.abort();
      cleanup();
    };
  }, [id, index, load, retry]);
  return (
    <div
      className="model-preview"
      aria-label="Interactive 3D model"
      aria-busy={!!status && !failed}
    >
      <div className="model-preview-canvas" ref={host} />
      {status ? (
        <div className="model-preview-status" role={failed ? 'alert' : 'status'}>
          <span>{status}</span>
          {failed && (
            <button
              type="button"
              className="dialog-button secondary"
              onClick={() => setRetry((v) => v + 1)}
            >
              <RotateCw size={14} />
              Retry preview
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="icon-button model-preview-fit"
          aria-label="Fit model preview"
          title="Fit model preview"
          onClick={() => fit.current?.()}
        >
          <Maximize2 size={16} />
        </button>
      )}
      {!status && (
        <span className="model-preview-hint">
          {model?.hidden ? 'Model hidden' : 'Drag to rotate · Scroll to zoom'}
        </span>
      )}
    </div>
  );
}
