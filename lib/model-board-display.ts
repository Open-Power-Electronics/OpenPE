import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MultiplyBlending,
  type BufferGeometry,
  type Object3D,
} from 'three';

/** The material palette and independently visible physical surfaces in Model. */
export const modelBoardDisplayLayers = [
  { key: 'substrate', label: 'Board body', color: 0xb6ad7b, order: 0 },
  { key: 'copper', label: 'Copper', color: 0xc3a15f, order: 0 },
  { key: 'mask', label: 'Solder mask', color: 0x418c7c, order: 1 },
  { key: 'silkscreen', label: 'Silkscreen', color: 0xf2f2f0, order: 2 },
] as const;
export type ModelBoardDisplayKey = (typeof modelBoardDisplayLayers)[number]['key'];
export type ModelBoardDisplay = Record<ModelBoardDisplayKey, boolean>;
export type ModelBoardDisplayGroups = Record<ModelBoardDisplayKey, Group>;
export const modelBoardDisplayColors = Object.fromEntries(
  modelBoardDisplayLayers.map(({ key, color }) => [key, color]),
) as Record<ModelBoardDisplayKey, number>;
export const componentModelEstimateColor = 0x666b72;

/** Keep the assembled lacquer/light response, with a matching backing for detached inspection. */
export function createModelSolderMaskSurface(geometry: BufferGeometry) {
  const material = new MeshBasicMaterial({
    color: modelBoardDisplayColors.mask,
    transparent: true,
    opacity: 0.9,
    blending: MultiplyBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    side: DoubleSide,
    forceSinglePass: true,
    toneMapped: false,
  });
  const coating = new Mesh(geometry, material);
  coating.userData.modelSolderMask = true;
  const backing = new Mesh(
    geometry,
    new MeshStandardMaterial({
      color: modelBoardDisplayColors.substrate,
      roughness: 0.8,
      side: DoubleSide,
    }),
  );
  backing.userData.modelSolderMaskBacking = true;
  backing.visible = false;
  // The coating owns picking; its backing only supplies opaque colour/depth.
  backing.raycast = () => {};
  coating.add(backing);
  return coating;
}

/** Retain the same lacquer shader and geometry across assembly/explosion, avoiding a colour jump. */
export function applyModelSolderMaskExplosion(group: Group, exploded: boolean) {
  group.traverse((object) => {
    if (object.userData.modelSolderMaskBacking) object.visible = exploded;
  });
}

export function defaultModelBoardDisplay(): ModelBoardDisplay {
  return {
    substrate: true,
    copper: true,
    mask: true,
    silkscreen: true,
  };
}

/** Keep mask and silk compositing ahead of transparent component/CAD assemblies. */
export function createModelBoardDisplayGroups(
  root: Object3D,
  display: ModelBoardDisplay,
): ModelBoardDisplayGroups {
  return Object.fromEntries(
    modelBoardDisplayLayers.map(({ key, order }) => {
      const group = new Group();
      group.name = key;
      group.renderOrder = order;
      group.visible = display[key];
      group.userData.modelBoard = true;
      root.add(group);
      return [key, group];
    }),
  ) as ModelBoardDisplayGroups;
}

/** Presentation only: do not rebuild, recolour or move any accepted geometry. */
export function applyModelBoardDisplay(
  groups: ModelBoardDisplayGroups,
  display: ModelBoardDisplay,
) {
  for (const { key } of modelBoardDisplayLayers) groups[key].visible = display[key];
}
