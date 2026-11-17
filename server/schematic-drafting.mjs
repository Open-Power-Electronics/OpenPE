const sharedInstructions = `For creation or a requested redraw, state a short functional-block plan. Preserve the drawing for value, model or simulation tuning. Respect the requested destination and preserve IDs, pin mappings and electrical requirements outside the edit.
Arrange flow left to right with supplies above returns. Group related parts and keep bypass, bootstrap and feedback parts near their pins. Use short orthogonal wires for local connections and clear trunks and junctions. Reserve labels for power, interfaces or distant nets, preserving legitimate net names. Keep routes clear of unrelated pins, symbols and fields, and keep reference/value fields legible. Use the grid for new placement and bends while retaining exact existing anchors. Crossings alone do not join nets. Recheck readability and connectivity separately from ERC or simulation.`;

const liveInstructions = `Query schematic.drafting for transformed pin anchors, symbol bounds, advisory label islands and canonical field IDs for schematic.text.position. Use schematic.wire or schematic.wires for explicit polylines. OpenPE does not autoroute them. Recheck the drawing and connectivity, explain intentional local label islands and use schematic.erc separately when needed. Prefer targeted commands to whole-project replacement. Summarize applied changes and actual checks without raw coordinates or tool arguments.`;

const contextOnlyInstructions = `Describe a placement and wiring plan and state any missing geometry. The proposal format cannot wire, label or redraw a schematic. Describe supported proposals separately from the work that still requires workbench tools.`;

/** Fixed Agent methodology, independent of optional PCB plugin lifecycle. */
export function schematicDraftingInstructions(capabilities) {
  return `${sharedInstructions}\n${capabilities ? liveInstructions : contextOnlyInstructions}`;
}
