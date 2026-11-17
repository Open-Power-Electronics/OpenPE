import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Allocate silhouette passes only while an annotation actually selects visible packages. */
export function createModelAnnotationOutline() {
  let state:
    | {
        composer: EffectComposer;
        outline: OutlinePass;
        output: OutputPass;
        camera: THREE.Camera;
        width: number;
        height: number;
      }
    | undefined;
  const dispose = () => {
    state?.outline.dispose();
    state?.output.dispose();
    state?.composer.dispose();
    state = undefined;
  };
  return {
    render(
      renderer: THREE.WebGLRenderer,
      scene: THREE.Scene,
      camera: THREE.Camera,
      objects: THREE.Object3D[],
    ) {
      if (!objects.length) {
        dispose();
        renderer.render(scene, camera);
        return;
      }
      if (state?.camera !== camera) dispose();
      const size = renderer.getSize(new THREE.Vector2());
      if (!state) {
        const composer = new EffectComposer(renderer);
        const outline = new OutlinePass(size, scene, camera);
        outline.visibleEdgeColor.set('#528bff');
        outline.hiddenEdgeColor.set(0x000000);
        outline.edgeGlow = 0;
        outline.edgeStrength = 3;
        const output = new OutputPass();
        composer.addPass(new RenderPass(scene, camera));
        composer.addPass(outline);
        composer.addPass(output);
        state = { composer, outline, output, camera, width: size.x, height: size.y };
      }
      if (state.width !== size.x || state.height !== size.y) {
        state.composer.setSize(size.x, size.y);
        state.width = size.x;
        state.height = size.y;
      }
      state.outline.selectedObjects = objects;
      state.composer.render();
    },
    dispose,
  };
}
