/** Model resources and execution logs are never Agent-readable project text. */
export function isAgentRestrictedFile(name: string): boolean {
  return /(?:^|\/)(?:models|3d|circuits|spice|thermal|logs?)(?:\/|$)|(?:^|\/)(?:logs?|stdout|stderr)(?:\.txt)?$|\.(?:lib|cir|spice|sub|mdl|model|mod|ckt|sp|inc|inp|s\d+p|step|stp|iges|igs|wrl|stl|obj|3mf|brep|glb|gltf|scad|geo|msh|mesh|sif|vtu|vtk|log|out|raw|trc|err|trace|stdout|stderr)(?:\.(?:txt|bak|backup|old|orig|\d+))*$/i.test(
    name,
  );
}
