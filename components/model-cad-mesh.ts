import * as THREE from 'three';
import { modelCadRequiresPreparation, type ModelCadObject } from '@/lib/model-cad';
import type { MeshData } from '@/lib/model-mesh';
import { disposeModelGroup } from '@/lib/model-mesh';

/** Apply the native-axis pose without rebuilding a solid's local geometry. */
export function setModelCadPose(
  mesh: THREE.Object3D,
  object: Pick<ModelCadObject, 'position' | 'rotation'>,
) {
  mesh.position.set(object.position.x, -object.position.y, object.position.z);
  mesh.rotation.set(
    (-object.rotation.x * Math.PI) / 180,
    (object.rotation.y * Math.PI) / 180,
    (-object.rotation.z * Math.PI) / 180,
    'XYZ',
  );
}

/** Native PCB axes are reflected across Y for the existing Three scene. */
export function modelCadMesh(object: ModelCadObject, preview = false) {
  if (modelCadRequiresPreparation(object))
    throw new Error('Prepare this CAD feature with the geometry kernel before displaying it.');
  const { size } = object;
  const outline = new THREE.Shape();
  if (object.kind === 'cylinder') outline.absarc(0, 0, size.x / 2, 0, 2 * Math.PI, false);
  else {
    outline.moveTo(-size.x / 2, -size.y / 2);
    outline.lineTo(size.x / 2, -size.y / 2);
    outline.lineTo(size.x / 2, size.y / 2);
    outline.lineTo(-size.x / 2, size.y / 2);
    outline.closePath();
  }
  for (const hole of object.holes) {
    const cut = new THREE.Path();
    cut.absarc(hole.x, -hole.y, hole.diameterMm / 2, 0, 2 * Math.PI, false);
    outline.holes.push(cut);
  }
  const geometry = new THREE.ExtrudeGeometry(outline, {
    depth: size.z,
    bevelEnabled: false,
    curveSegments: 48,
  });
  geometry.translate(0, 0, -size.z / 2);
  const opacity = preview ? Math.min(object.opacity, 0.45) : object.opacity;
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color:
        object.material === 'pmma' ? 0xdcecef : object.material === 'plastic' ? 0x777c82 : 0xbfc3c6,
      metalness: object.material === 'aluminium' ? 0.82 : 0.05,
      roughness: object.material === 'pmma' ? 0.16 : 0.34,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity === 1,
      // Extrusion already supplies every exterior face, including hole walls.
      side: THREE.FrontSide,
    }),
  );
  mesh.name = object.name;
  setModelCadPose(mesh, object);
  mesh.userData.modelCadId = object.id;
  mesh.userData.modelCadPreview = preview;
  return mesh;
}

/** The fixed kernel's local STEP faces, reflected into the same scene axes as primitives. */
export function modelCadKernelMesh(
  object: ModelCadObject,
  meshes: readonly MeshData[],
  preview = false,
): THREE.Group {
  const group = new THREE.Group();
  const opacity = preview ? Math.min(object.opacity, 0.45) : object.opacity;
  try {
    for (const source of meshes) {
      const positions = [...source.attributes.position.array];
      const normals = source.attributes.normal ? [...source.attributes.normal.array] : null;
      for (let i = 1; i < positions.length; i += 3) positions[i] = -positions[i];
      if (normals) for (let i = 1; i < normals.length; i += 3) normals[i] = -normals[i];
      const indices = [...source.index.array];
      for (let i = 0; i < indices.length; i += 3)
        [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      if (normals) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      else geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color:
            object.material === 'pmma'
              ? 0xdcecef
              : object.material === 'plastic'
                ? 0x777c82
                : 0xbfc3c6,
          metalness: object.material === 'aluminium' ? 0.82 : 0.05,
          roughness: object.material === 'pmma' ? 0.16 : 0.34,
          transparent: opacity < 1,
          opacity,
          depthWrite: opacity === 1,
          side: THREE.FrontSide,
        }),
      );
      mesh.userData.modelCadId = object.id;
      mesh.userData.modelCadPreview = preview;
      group.add(mesh);
    }
    group.name = object.name;
    group.userData.modelCadId = object.id;
    group.userData.modelCadPreview = preview;
    setModelCadPose(group, object);
    return group;
  } catch (error) {
    disposeModelGroup(group);
    throw error;
  }
}
