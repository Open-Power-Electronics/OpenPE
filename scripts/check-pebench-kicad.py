"""Independent EAGLE connectivity and real KiCad 10 PCB geometry checks.

Run with KiCad's bundled Python (pcbnew required). No GUI, solver, providers,
source-repository code, or user project files are launched or modified.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

import pcbnew as pcb
import wx

# KiCad's repeated read-only loads re-register image handlers. Keep the check's
# output compact; exceptions and failed CLI return codes are still fatal.
QUIET_WX = wx.LogNull()

ROOT = Path(__file__).resolve().parents[1]


def expected_connectivity(source):
    schematic = ET.parse(source).find('.//schematic')
    libraries = {n.get('name'): n for n in schematic.findall('libraries/library')}
    part_pads = {}
    physical = set()
    for part in schematic.findall('parts/part'):
        library = libraries[part.get('library')]
        ds = next(n for n in library.findall('devicesets/deviceset') if n.get('name') == part.get('deviceset'))
        device = next(n for n in ds.findall('devices/device') if n.get('name', '') == part.get('device', ''))
        connections = {}
        for connection in device.findall('connects/connect'):
            pads = connection.get('pad', '').split()
            connections[(connection.get('gate'), connection.get('pin'))] = pads
            physical.update(f"{part.get('name')}:{pad}" for pad in pads)
        part_pads[part.get('name')] = connections
    nets = {}
    for net in schematic.findall('sheets/sheet/nets/net'):
        pins = nets.setdefault(net.get('name'), set())
        for node in net.findall('segment/pinref'):
            pins.update(f"{node.get('part')}:{pad}" for pad in part_pads[node.get('part')].get((node.get('gate'), node.get('pin')), []))
    return sorted(tuple(sorted(pins)) for pins in nets.values() if pins), physical


def actual_connectivity(source, physical):
    nets = []
    for net in ET.parse(source).findall('.//nets/net'):
        pins = {f"{node.get('ref')}:{node.get('pin')}" for node in net.findall('node')} & physical
        if pins:
            nets.append(tuple(sorted(pins)))
    return sorted(nets)


def point(value):
    return [value.x, value.y]


def normalized_angle(value):
    return round(value % 360, 6) or 0


def sorted_geometry(values):
    return sorted(values, key=lambda row: json.dumps(row, sort_keys=True))


def polygon_geometry(polygons):
    return [{
        'outline': [point(polygons.COutline(i).CPoint(j))
                    for j in range(polygons.COutline(i).PointCount())],
        'holes': [[point(polygons.CHole(i, h).CPoint(j))
                   for j in range(polygons.CHole(i, h).PointCount())]
                  for h in range(polygons.HoleCount(i))],
    } for i in range(polygons.OutlineCount())]


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
        'net': zone.GetNetname(), 'layers': zone.GetLayerSet().FmtHex(),
        'rule_area': zone.GetIsRuleArea(), 'polygons': polygon_geometry(zone.Outline()),
        'settings': {name: getattr(zone, name)() for name in methods},
    }


def board_geometry(board):
    # Ignore generated UUIDs, native reference captions and cached zone fills.
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
                'mask_margin': pad.GetLocalSolderMaskMargin(),
                'paste_margin': pad.GetLocalSolderPasteMargin(),
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
            'zones': sorted_geometry(zone_geometry(z) for z in footprint.Zones()),
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
        'zones': sorted_geometry(zone_geometry(z) for z in board.Zones()),
        'graphics': sorted_geometry(graphic_geometry(g) for g in board.GetDrawings()),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', default=str(Path(sys.executable).with_name('kicad-cli.exe')))
    parser.add_argument('--id')
    args = parser.parse_args()
    output = ROOT / 'test-results' / 'pebench-kicad'
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
    manifest = json.loads((ROOT / 'tests/fixtures/pebench/manifest.json').read_text('utf-8'))
    results = []
    for entry in manifest['examples']:
        if args.id and entry['id'] != args.id:
            continue
        slug = entry['id']
        netlist = output / f'{slug}.xml'
        schematic = ROOT / 'tests/fixtures/pebench' / f'{slug}.kicad_sch'
        board = ROOT / 'tests/fixtures/pebench' / f'{slug}.kicad_pcb'
        run(['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', str(netlist), str(schematic)])
        expected, physical = expected_connectivity(ROOT / entry['source']['schematic']['path'])
        actual = actual_connectivity(netlist, physical)
        wired = {pin for group in expected for pin in group}
        # KiCad emits standalone nets for intentionally unused physical pins.
        # Only those exact isolated source pins may be ignored; merging one with
        # another pin remains a connectivity failure.
        actual = [group for group in actual if len(group) != 1 or group[0] in wired]
        if actual != expected:
            missing = Counter(expected) - Counter(actual)
            extra = Counter(actual) - Counter(expected)
            raise AssertionError(f'{slug}: schematic connectivity changed\nmissing={list(missing)}\nextra={list(extra)}')
        original_board = pcb.LoadBoard(str(ROOT / entry['source']['convertedPCB']['path']))
        exported_board = pcb.LoadBoard(str(board))
        before, after = board_geometry(original_board), board_geometry(exported_board)
        (output / f'{slug}-before.json').write_text(json.dumps(before, indent=2), 'utf-8')
        (output / f'{slug}-after.json').write_text(json.dumps(after, indent=2), 'utf-8')
        if before != after:
            changed = [key for key in before if before[key] != after[key]]
            raise AssertionError(f'{slug}: PCB geometry changed in {changed}; see {output}')
        run(['sch', 'export', 'svg', '-e', '-o', str(output / slug), str(schematic)])
        run(['pcb', 'export', 'svg', '--layers', 'F.Cu,B.Cu,Edge.Cuts', '--page-size-mode', '2',
             '--mode-single', '-o', str(output / f'{slug}-pcb.svg'), str(board)])
        results.append({'id': slug, 'physicalPins': len(physical), 'nets': len(expected),
                        'footprints': len(before['footprints']), 'copperLayers': before['copper_layers'],
                        'pads': sum(len(f['pads']) for f in before['footprints']),
                        'tracksAndVias': len(before['tracks']),
                        'zones': len(before['zones']) + sum(len(f['zones']) for f in before['footprints']),
                        'graphics': len(before['graphics']) + sum(len(f['graphics']) for f in before['footprints'])})
        print(f'PASS {slug}: source connectivity, pads/copper, artwork, holes and zone settings', flush=True)
    (output / 'report.json').write_text(json.dumps({'kicadVersion': version, 'examples': results}, indent=2), 'utf-8')
    if not args.id and len(results) == 10:
        verification = {
            'kicadVersion': version,
            'checks': ['Source EAGLE physical pin network partitions match exported KiCad schematic netlists.',
                       'KiCad PCB copper layers, pads, drill geometry, tracks and vias match pinned source boards.',
                       'Board and footprint artwork geometry, ordinary text and caption styles match pinned source boards.',
                       'Board and footprint zone boundaries, holes, keepout restrictions and thermal/island settings match pinned source boards.',
                       'Schematic and PCB SVG exports completed with KiCad 10.'],
            'scope': 'Structural and connectivity verification only; not ERC, DRC, simulation or production qualification.',
            'examples': results,
        }
        (ROOT / 'tests/fixtures/pebench/verification.json').write_text(json.dumps(verification, indent=2) + '\n', 'utf-8')
    print(f'PASS KiCad {version}: {len(results)} examples (structural/connectivity checks, not ERC/DRC or simulation).')


if __name__ == '__main__':
    main()
