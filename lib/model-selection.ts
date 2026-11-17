import * as THREE from 'three';

type Mesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
type Paint = { original: Mesh['material']; selected: Mesh['material'] };

/** Presentation-only material copies: cached templates and other instances stay untouched. */
export function createModelSelection(root: THREE.Group, identity = 'footprintId') {
  const paints = new Map<Mesh, Paint>();
  const materials = (value: Mesh['material']) => (Array.isArray(value) ? value : [value]);
  const restore = (mesh: Mesh, paint: Paint) => {
    mesh.material = paint.original;
    materials(paint.selected).forEach((material) => material.dispose());
    paints.delete(mesh);
  };
  return {
    update(ids: ReadonlySet<string>, dark: boolean) {
      const tone = new THREE.Color(dark ? 0xffffff : 0x000000);
      for (const object of root.children) {
        const selected = root.visible && object.visible && ids.has(object.userData[identity]);
        object.traverse((node) => {
          if (!(node instanceof THREE.Mesh)) return;
          const mesh = node as Mesh;
          let paint = paints.get(mesh);
          if (!selected) {
            if (paint) restore(mesh, paint);
            return;
          }
          if (!paint) {
            const original = mesh.material;
            paint = {
              original,
              selected: Array.isArray(original)
                ? original.map((material) => material.clone())
                : original.clone(),
            };
            paints.set(mesh, paint);
          }
          materials(paint.selected).forEach((material, index) => {
            const original = materials(paint!.original)[index];
            if (
              'color' in material &&
              material.color instanceof THREE.Color &&
              'color' in original &&
              original.color instanceof THREE.Color
            )
              material.color
                .copy(original.color)
                .convertLinearToSRGB()
                .lerp(tone, 0.55)
                .convertSRGBToLinear();
          });
          mesh.material = paint.selected;
        });
      }
    },
    withoutSelection<T>(capture: () => T): T {
      for (const [mesh, paint] of paints) mesh.material = paint.original;
      try {
        return capture();
      } finally {
        for (const [mesh, paint] of paints) mesh.material = paint.selected;
      }
    },
    dispose() {
      for (const [mesh, paint] of paints) restore(mesh, paint);
    },
  };
}
