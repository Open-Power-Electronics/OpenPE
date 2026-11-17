"""Independent source connectivity and real KiCad 10 PCB geometry checks.

Run with KiCad's bundled Python (pcbnew required). No GUI, solver, providers,
source-repository code, or user project files are launched or modified.
"""
import argparse
from copy import deepcopy
from fractions import Fraction
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

import pcbnew as pcb
import wx

# KiCad's repeated read-only loads re-register image handlers. Keep the check's
# output compact; exceptions and failed CLI return codes are still fatal.
QUIET_WX = wx.LogNull()

ROOT = Path(__file__).resolve().parents[1]
REFILLED_EXAMPLE = 'reference-tps61046-bga6-boost'


def connectivity(source):
    return sorted(tuple(sorted(f"{node.get('ref')}:{node.get('pin')}"
                              for node in net.findall('node')))
                  for net in ET.parse(source).findall('.//nets/net'))


def point(value):
    return [value.x, value.y]


def normalized_angle(value):
    return round(value % 360, 6) or 0


def sorted_geometry(values):
    return sorted(values, key=lambda row: json.dumps(row, sort_keys=True))


def ring(points):
    if points and points[0] == points[-1]:
        points = points[:-1]
    variants = []
    for sequence in [points, list(reversed(points))]:
        if sequence:
            minimum = min(sequence)
            variants.extend(sequence[i:] + sequence[:i] for i, p in enumerate(sequence) if p == minimum)
    return min(variants) if variants else []


def polygon_geometry(polygons):
    return [{'outline': ring([point(polygons.COutline(i).CPoint(j))
                             for j in range(polygons.COutline(i).PointCount())]),
             'holes': sorted(ring([point(polygons.CHole(i, h).CPoint(j))
                                    for j in range(polygons.CHole(i, h).PointCount())])
                             for h in range(polygons.HoleCount(i)))}
            for i in range(polygons.OutlineCount())]


def text_geometry(text, include_value=True):
    return {
        **({'text': text.GetText()} if include_value else {}),
        'position': point(text.GetPosition()), 'size': point(text.GetTextSize()),
        'rotation': normalized_angle(text.GetTextAngleDegrees()),
        'thickness': text.GetTextThickness(), 'visible': text.IsVisible(),
        'bold': text.IsBold(), 'italic': text.IsItalic(), 'mirror': text.IsMirrored(),
        'horizontal_justify': text.GetHorizJustify(), 'vertical_justify': text.GetVertJustify(),
    }


def graphic_geometry(graphic):
    result = {'type': graphic.GetClass(), 'layer': graphic.GetLayer()}
    if isinstance(graphic, pcb.PCB_SHAPE):
        result.update(shape=graphic.GetShape(), start=point(graphic.GetStart()),
                      end=point(graphic.GetEnd()), width=graphic.GetWidth(),
                      fill=graphic.GetFillMode())
        if graphic.GetShape() in [pcb.SHAPE_T_RECT, pcb.SHAPE_T_POLY]:
            result.pop('start')
            result.pop('end')
            result['shape'] = 'polygon'
            if graphic.GetShape() == pcb.SHAPE_T_RECT:
                a, b = point(graphic.GetStart()), point(graphic.GetEnd())
                result['polygons'] = [{'outline': ring([a, [b[0], a[1]], b, [a[0], b[1]]]), 'holes': []}]
            else:
                result['polygons'] = polygon_geometry(graphic.GetPolyShape())
        if graphic.GetShape() == pcb.SHAPE_T_ARC:
            result['mid'] = point(graphic.GetArcMid())
        if graphic.GetShape() == pcb.SHAPE_T_POLY:
            result['polygons'] = polygon_geometry(graphic.GetPolyShape())
    elif isinstance(graphic, pcb.PCB_DIMENSION_BASE):
        result.update(text_geometry(graphic))
        result.update(start=point(graphic.GetStart()), end=point(graphic.GetEnd()))
        methods = ['GetArrowDirection', 'GetArrowLength', 'GetExtensionOffset',
                   'GetKeepTextAligned', 'GetLineThickness', 'GetOverrideText',
                   'GetOverrideTextEnabled', 'GetPrecision', 'GetPrefix', 'GetSuffix',
                   'GetSuppressZeroes', 'GetTextPositionMode', 'GetUnitsFormat', 'GetUnitsMode']
        for name in methods + ['GetHeight', 'GetExtensionHeight', 'GetLeaderLength']:
            if hasattr(graphic, name):
                result[name] = getattr(graphic, name)()
    elif isinstance(graphic, pcb.PCB_TEXT):
        result.update(text_geometry(graphic))
    else:
        raise AssertionError(f'Add an independent check for graphic {graphic.GetClass()}')
    return result


def zone_geometry(zone):
    methods = ['GetAssignedPriority', 'GetDoNotAllowFootprints', 'GetDoNotAllowPads',
               'GetDoNotAllowTracks', 'GetDoNotAllowVias', 'GetDoNotAllowZoneFills',
               'GetFillMode', 'GetHatchStyle', 'GetIslandRemovalMode', 'GetMinIslandArea',
               'GetMinThickness', 'GetPadConnection', 'GetThermalReliefGap',
               'GetThermalReliefSpokeWidth', 'GetLocalClearance']
    return {
        'net': zone.GetNetname(),
        'rule_area': zone.GetIsRuleArea(), 'polygons': polygon_geometry(zone.Outline()),
        'settings': {name: getattr(zone, name)() for name in methods},
    }


def zones_geometry(zones):
    return sorted_geometry({**zone_geometry(z), 'layer': layer,
                            'filled': polygon_geometry(z.GetFilledPolysList(layer))}
                           for z in zones for layer in z.GetLayerSet().Seq())


def board_geometry(board):
    # Ignore generated UUIDs and native reference captions; include saved fills.
    # Everything electrically significant here comes from KiCad's actual reader.
    footprints = []
    for footprint in board.GetFootprints():
        pads = []
        for pad in footprint.Pads():
            pads.append({
                'number': pad.GetNumber(), 'net': pad.GetNetname(),
                'position': point(pad.GetPosition()), 'size': point(pad.GetSize()),
                'drill': point(pad.GetDrillSize()), 'shape': pad.GetShape(),
                'attribute': pad.GetAttribute(),
                'rotation': normalized_angle(pad.GetOrientationDegrees()),
                'layers': pad.GetLayerSet().FmtHex(),
                'roundrect': round(pad.GetRoundRectRadiusRatio(), 6),
                'chamfer': round(pad.GetChamferRectRatio(), 6),
                'chamfer_positions': pad.GetChamferPositions(),
                'drill_offset': point(pad.GetOffset()),
                # The build adapter materializes footprint-level overrides on
                # pads; compare the same inherited values on both sides.
                'mask_margin': (pad.GetLocalSolderMaskMargin() if pad.GetLocalSolderMaskMargin() is not None
                                else footprint.GetLocalSolderMaskMargin()),
                'paste_margin': (pad.GetLocalSolderPasteMargin() if pad.GetLocalSolderPasteMargin() is not None
                                 else footprint.GetLocalSolderPasteMargin()),
                'paste_ratio': (pad.GetLocalSolderPasteMarginRatio() if pad.GetLocalSolderPasteMarginRatio() is not None
                                else footprint.GetLocalSolderPasteMarginRatio()),
                'zone_connection': pad.GetLocalZoneConnection(),
                'thermal_spoke_angle': normalized_angle(pad.GetThermalSpokeAngleDegrees()),
            })
        footprints.append({
            'position': point(footprint.GetPosition()),
            'rotation': normalized_angle(footprint.GetOrientationDegrees()),
            'layer': footprint.GetLayer(),
            'pads': sorted_geometry(pads),
            'graphics': sorted_geometry(graphic_geometry(g) for g in footprint.GraphicalItems()),
            # Linked captions intentionally use the current schematic values.
            # Their source positions, font styles and visibility must survive.
            'reference_style': text_geometry(footprint.Reference(), include_value=False),
            'value_style': text_geometry(footprint.Value(), include_value=False),
            'zones': zones_geometry(footprint.Zones()),
        })
    tracks = []
    for track in board.GetTracks():
        row = {'type': track.GetClass(), 'start': point(track.GetStart()),
               'end': point(track.GetEnd()), 'net': track.GetNetname(),
               'layer': track.GetLayer(),
               'width': track.GetWidth(track.GetLayer()) if isinstance(track, pcb.PCB_VIA) else track.GetWidth()}
        if isinstance(track, pcb.PCB_VIA):
            row.update(drill=track.GetDrillValue(), layers=track.GetLayerSet().FmtHex())
        if isinstance(track, pcb.PCB_ARC):
            row['mid'] = point(track.GetMid())
        tracks.append(row)
    return {
        'copper_layers': board.GetCopperLayerCount(),
        'footprints': sorted_geometry(footprints),
        'tracks': sorted_geometry(tracks),
        'zones': zones_geometry(board.Zones()),
        'graphics': sorted_geometry(graphic_geometry(g) for g in board.GetDrawings()),
    }


def rectangle_bounds(outline):
    if len(outline) != 4 or len({tuple(p) for p in outline}) != 4:
        return None
    left, right = min(p[0] for p in outline), max(p[0] for p in outline)
    top, bottom = min(p[1] for p in outline), max(p[1] for p in outline)
    if left >= right or top >= bottom:
        return None
    if {tuple(p) for p in outline} != {(left, top), (right, top), (right, bottom), (left, bottom)}:
        return None
    if not all((a[0] == b[0]) != (a[1] == b[1])
               for a, b in zip(outline, outline[1:] + outline[:1])):
        return None
    return left, top, right, bottom


def inset_board_bounds(geometry):
    edges = [g for g in geometry['graphics'] if g['layer'] == pcb.Edge_Cuts]
    if (len(edges) != 1 or edges[0].get('shape') != 'polygon'
            or len(edges[0]['polygons']) != 1 or edges[0]['polygons'][0]['holes']):
        raise AssertionError('Expected one rectangular Reference board outline.')
    bounds = rectangle_bounds(edges[0]['polygons'][0]['outline'])
    if bounds is None:
        raise AssertionError('Reference board outline is not an axis-aligned rectangle.')
    left, top, right, bottom = bounds
    inset = pcb.FromMM(0.5)
    bounds = left + inset, top + inset, right - inset, bottom - inset
    if bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
        raise AssertionError('Reference board is too small for its copper-zone inset.')
    return bounds


def clipped_zone_ring(outline, bounds):
    # Independent rational Sutherland-Hodgman clipping. Native coordinates are
    # integer nanometres; only intersections need rounding at the final boundary.
    result = [list(map(Fraction, p)) for p in outline]
    left, top, right, bottom = bounds
    for axis, boundary, greater in [(0, left, True), (0, right, False),
                                    (1, top, True), (1, bottom, False)]:
        if not result:
            break
        clipped = []
        previous = result[-1]
        previous_inside = previous[axis] >= boundary if greater else previous[axis] <= boundary
        for current in result:
            current_inside = current[axis] >= boundary if greater else current[axis] <= boundary
            if previous_inside != current_inside:
                ratio = (Fraction(boundary) - previous[axis]) / (current[axis] - previous[axis])
                clipped.append([previous[i] + ratio * (current[i] - previous[i]) for i in range(2)])
            if current_inside:
                clipped.append(current)
            previous, previous_inside = current, current_inside
        result = clipped
    rounded = []
    for p in result:
        value = [round(p[0]), round(p[1])]
        if not rounded or rounded[-1] != value:
            rounded.append(value)
    if rounded and rounded[0] == rounded[-1]:
        rounded.pop()
    if len(rounded) < 3:
        raise AssertionError('Copper-zone inset would remove a source zone.')
    return ring(rounded)


def curated_board_geometry(source, refilled=False):
    expected = deepcopy(source)
    bounds = inset_board_bounds(source)
    for zone in expected['zones']:
        if zone['rule_area']:
            continue
        zone['polygons'] = [{**polygon, 'outline': clipped_zone_ring(polygon['outline'], bounds)}
                            for polygon in zone['polygons']]
        if refilled:
            zone['settings']['GetLocalClearance'] = max(
                zone['settings']['GetLocalClearance'], pcb.FromMM(0.25))
    return expected


def copper_identities(board):
    return {
        'footprints': sorted((f.m_Uuid.AsString(),
                              sorted(p.m_Uuid.AsString() for p in f.Pads()))
                             for f in board.GetFootprints()),
        'tracks': sorted(t.m_Uuid.AsString() for t in board.GetTracks()),
        'zones': sorted(z.m_Uuid.AsString() for z in board.Zones()),
    }


def tps_fill_records(board):
    return {(z.m_Uuid.AsString(), layer): sorted_geometry(
                {**polygon, 'island': bool(z.IsIsland(layer, index))}
                for index, polygon in enumerate(polygon_geometry(z.GetFilledPolysList(layer))))
            for z in board.Zones() for layer in z.GetLayerSet().Seq()}


def verify_tps_saved_fills(board, refilled):
    zones = list(board.Zones())
    if len(zones) != 3 or any(z.GetIsRuleArea() for z in zones):
        raise AssertionError('TPS61046 requires exactly three enabled copper zones.')
    saved_fills = tps_fill_records(board)
    if saved_fills != tps_fill_records(refilled):
        raise AssertionError('TPS61046 saved contours or island flags differ from the KiCad refill.')
    records = []
    for zone in zones:
        if zone.GetLocalClearance() < pcb.FromMM(0.25):
            raise AssertionError('TPS61046 filled zones require at least 0.25 mm clearance.')
        for layer in zone.GetLayerSet().Seq():
            if layer not in [pcb.F_Cu, pcb.B_Cu]:
                raise AssertionError('TPS61046 zone must be on an outer copper layer.')
            copper = pcb.SHAPE_POLY_SET(zone.GetFilledPolysList(layer))
            # Saved copper rounds to 0.1 micrometre; source outlines/cutouts retain
            # nanometres. Bound that rounding band against the actual polygon.
            owner = pcb.SHAPE_POLY_SET(zone.Outline())
            owner.Inflate(pcb.FromMM(0.0002), pcb.CORNER_STRATEGY_ROUND_ALL_CORNERS, 1)
            outside = pcb.SHAPE_POLY_SET(copper)
            outside.BooleanSubtract(owner)
            if outside.Area() >= 1:
                raise AssertionError('TPS61046 actual fill escapes its owner or enters a cutout.')
            for footprint in board.GetFootprints():
                for pad in footprint.Pads():
                    if pad.GetNetname() == zone.GetNetname() or not pad.GetLayerSet().Contains(layer):
                        continue
                    collision = pcb.SHAPE_POLY_SET(copper)
                    collision.BooleanIntersection(pad.GetEffectivePolygon(layer))
                    if collision.Area() >= 1:
                        raise AssertionError('TPS61046 actual fill overlaps a foreign-net pad.')
            records.append((zone, layer, copper))
    if len(records) != 3:
        raise AssertionError('TPS61046 fill must retain three single-layer zone owners.')
    for index, (left, layer, copper) in enumerate(records):
        for right, other_layer, other in records[index + 1:]:
            if layer != other_layer or left.GetNetname() == right.GetNetname():
                continue
            overlap = pcb.SHAPE_POLY_SET(copper)
            overlap.BooleanIntersection(other)
            if overlap.Area() >= 1:
                raise AssertionError('TPS61046 saved fills overlap across different nets.')
    return {'zones': len(records), 'minimumClearanceMm': 0.25,
            'exactKiCadRefill': True,
            'zonePolygons': [{'uuid': zone.m_Uuid.AsString(), 'net': zone.GetNetname(),
                              'layer': board.GetLayerName(layer), 'polygons': copper.OutlineCount()}
                             for zone, layer, copper in records],
            'filledAreaMm2': sum(copper.Area() for _, _, copper in records) / 1e12,
            'ownerAndCutoutsVerified': True, 'foreignPadAndZoneOverlapVerified': True}


def equivalent_ring(expected, actual, tolerance):
    if len(expected) != len(actual):
        return False
    if not expected:
        return True
    for sequence in [actual, list(reversed(actual))]:
        for offset in range(len(sequence)):
            shifted = sequence[offset:] + sequence[:offset]
            if all(abs(a[axis] - b[axis]) <= tolerance
                   for a, b in zip(expected, shifted) for axis in range(2)):
                return True
    return False


def equivalent_zone_polygons(expected, actual, tolerance):
    unmatched = list(actual)
    for polygon in expected:
        match = next((i for i, candidate in enumerate(unmatched)
                      if polygon['holes'] == candidate['holes']
                      and equivalent_ring(polygon['outline'], candidate['outline'], tolerance)), None)
        if match is None:
            return False
        unmatched.pop(match)
    return not unmatched


def equivalent_curated_zones(source, expected, actual, refilled=False):
    unmatched = list(actual)
    for original, zone in zip(source, expected):
        ignored = {'polygons', 'filled'} if refilled else {'polygons'}
        metadata = {key: value for key, value in zone.items() if key not in ignored}
        # TS generation rounds to six decimal millimetres. Permit one native
        # nanometre only on derived outer boundaries, never saved fills or holes.
        tolerance = 1 if zone['polygons'] != original['polygons'] else 0
        match = next((i for i, candidate in enumerate(unmatched)
                      if metadata == {key: value for key, value in candidate.items()
                                      if key not in ignored}
                      and equivalent_zone_polygons(zone['polygons'], candidate['polygons'], tolerance)), None)
        if match is None:
            return False
        unmatched.pop(match)
    return not unmatched


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', default=str(Path(sys.executable).with_name('kicad-cli.exe')))
    parser.add_argument('--id')
    args = parser.parse_args()
    output = ROOT / 'test-results' / 'reference-kicad'
    output.mkdir(parents=True, exist_ok=True)
    def run(arguments):
        result = subprocess.run([args.cli, *arguments], text=True, capture_output=True,
                                timeout=90, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise RuntimeError(f"KiCad failed: {arguments}\n{result.stdout}\n{result.stderr}")
        return result.stdout.strip()
    version = run(['--version'])
    if not version.startswith('10.'):
        raise RuntimeError(f'KiCad 10 required, found {version}')
    manifest = json.loads((ROOT / 'resources/example-catalog/manifest.json').read_text('utf-8'))
    results = []
    for entry in manifest['examples']:
        if args.id and entry['id'] != args.id:
            continue
        slug = entry['id']
        file_stem = entry['file']
        netlist = output / f'{slug}.xml'
        schematic = ROOT / 'examples' / file_stem / f'{file_stem}.kicad_sch'
        board = ROOT / 'examples' / file_stem / f'{file_stem}.kicad_pcb'
        run(['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', str(netlist), str(schematic)])
        original_netlist = output / f'{slug}-source.xml'
        run(['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', str(original_netlist),
             str(ROOT / entry['source']['schematic']['path'])])
        expected, actual = connectivity(original_netlist), connectivity(netlist)
        source_pins = {pin for group in expected for pin in group}
        source_partition = sorted(tuple(pin for pin in group if pin in source_pins)
                                  for group in actual if any(pin in source_pins for pin in group))
        if source_partition != expected:
            raise AssertionError(f'{slug}: schematic connectivity changed')
        physical = {pin for group in expected for pin in group}
        original_board = pcb.LoadBoard(str(ROOT / entry['source']['pcb']['path']))
        exported_board = pcb.LoadBoard(str(board))
        before, after = board_geometry(original_board), board_geometry(exported_board)
        refilled = slug == REFILLED_EXAMPLE
        expected_board = curated_board_geometry(before, refilled)
        fill_verification = None
        if refilled:
            if version != '10.0.1':
                raise RuntimeError(f'TPS61046 comparison requires KiCad 10.0.1, found {version}')
            if copper_identities(original_board) != copper_identities(exported_board):
                raise AssertionError(f'{slug}: source copper-object UUIDs changed')
            scratch = Path(tempfile.mkdtemp(prefix='tps61046-refill-', dir=output))
            comparison_board = scratch / board.name
            shutil.copyfile(board, comparison_board)
            shutil.copyfile(board.with_suffix('.kicad_pro'), comparison_board.with_suffix('.kicad_pro'))
            run(['pcb', 'drc', '--refill-zones', '--save-board', '--format', 'json',
                 '--all-track-errors', '--severity-all', '-o', str(scratch / 'drc.json'),
                 str(comparison_board)])
            fill_verification = verify_tps_saved_fills(exported_board, pcb.LoadBoard(str(comparison_board)))
        (output / f'{slug}-before.json').write_text(json.dumps(before, indent=2), 'utf-8')
        (output / f'{slug}-expected.json').write_text(json.dumps(expected_board, indent=2), 'utf-8')
        (output / f'{slug}-after.json').write_text(json.dumps(after, indent=2), 'utf-8')
        changed = [key for key in expected_board if expected_board[key] != after[key]]
        if 'zones' in changed and equivalent_curated_zones(before['zones'], expected_board['zones'], after['zones'], refilled):
            changed.remove('zones')
        if changed:
            raise AssertionError(f'{slug}: PCB geometry changed in {changed}; see {output}')
        run(['sch', 'export', 'svg', '-e', '-o', str(output / slug), str(schematic)])
        run(['pcb', 'export', 'svg', '--layers', 'F.Cu,B.Cu,Edge.Cuts', '--page-size-mode', '2',
             '--mode-single', '-o', str(output / f'{slug}-pcb.svg'), str(board)])
        results.append({'id': slug, 'physicalPins': len(physical), 'nets': len(expected),
                        'footprints': len(before['footprints']), 'copperLayers': before['copper_layers'],
                        'pads': sum(len(f['pads']) for f in before['footprints']),
                        'tracksAndVias': len(before['tracks']),
                        'zones': len(before['zones']) + sum(len(f['zones']) for f in before['footprints']),
                        'graphics': len(before['graphics']) + sum(len(f['graphics']) for f in before['footprints']),
                        **({'curatedFill': fill_verification} if fill_verification else {})})
        print(f'PASS {slug}: source connectivity, retained copper and curated zone boundaries', flush=True)
    (output / 'report.json').write_text(json.dumps({'kicadVersion': version, 'examples': results}, indent=2), 'utf-8')
    if not args.id and len(results) == 9:
        verification = {
            'kicadVersion': version,
            'checks': ['Source KiCad physical pin network partitions match exported KiCad schematic netlists.',
                       'KiCad PCB copper layers, pads, drill geometry, tracks and vias match pinned source boards.',
                       'Board and footprint artwork, ordinary text and caption styles match; rectangles normalize to exact polygons.',
                       'Copper-zone outer boundaries follow the 0.5 mm board inset; internal partitions, holes and unrelated rules retain source geometry.',
                       'Eight boards retain exact source fills. TPS61046 retains copper-object UUIDs and uses a 0.25 mm zone clearance. All three zones match an independent KiCad 10.0.1 refill exactly by layer, contour and island flag. Saved copper stays within its owner and avoids foreign-pad and zone overlap.',
                       'Schematic and PCB SVG exports completed with KiCad 10.'],
            'scope': 'Structural and connectivity verification only; not ERC, DRC, simulation or production qualification.',
            'examples': results,
        }
        (ROOT / 'resources/example-catalog/verification.json').write_text(json.dumps(verification, indent=2) + '\n', 'utf-8')
    print(f'PASS KiCad {version}: {len(results)} examples (structural/connectivity checks, not ERC/DRC or simulation).')


if __name__ == '__main__':
    main()
