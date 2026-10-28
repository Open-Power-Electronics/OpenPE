'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/bridge';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { modelMeshGroup, disposeModelGroup, type MeshData } from '@/lib/model-mesh';
export default function ModelPreview({ id, index }: { id: string; index: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Loading 3D model…');
  useEffect(() => {
    const control = new AbortController();
    let cleanup = () => {};
    setStatus('Loading 3D model…');
    void (async () => {
      const data: { meshes: MeshData[] } = await (
        await api(`library-model?id=${encodeURIComponent(id)}&index=${index}`, {
          signal: control.signal,
        })
      ).json();
      if (control.signal.aborted || !host.current) return;
      const el = host.current;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      el.appendChild(renderer.domElement);
      const scene = new THREE.Scene(),
        group = modelMeshGroup(data.meshes);
      const bounds = new THREE.Box3().setFromObject(group),
        center = bounds.getCenter(new THREE.Vector3()),
        size = bounds.getSize(new THREE.Vector3()).length() || 1;
      group.position.sub(center);
      scene.add(group);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 3));
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(size, -size, size * 2);
      scene.add(light);
      const camera = new THREE.PerspectiveCamera(40, 1, size / 1000, size * 100);
      camera.up.set(0, 0, 1);
      camera.position.set(size, -size, size * 0.8);
      const orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = true;
      const observer = new ResizeObserver(() => {
        const width = el.clientWidth,
          height = el.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      });
      observer.observe(el);
      renderer.setAnimationLoop(() => {
        orbit.update();
        renderer.render(scene, camera);
      });
      cleanup = () => {
        observer.disconnect();
        orbit.dispose();
        renderer.setAnimationLoop(null);
        disposeModelGroup(group);
        renderer.dispose();
        renderer.domElement.remove();
      };
      setStatus('');
    })().catch((e) => {
      if (!control.signal.aborted) setStatus((e as Error).message);
    });
    return () => {
      control.abort();
      cleanup();
    };
  }, [id, index]);
  return (
    <div className="model-preview" aria-label="Interactive 3D model">
      <div className="model-preview-canvas" ref={host} />
      {status && <p role="status">{status}</p>}
    </div>
  );
}
