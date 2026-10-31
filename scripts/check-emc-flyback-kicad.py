"""Explicit, headless KiCad 10 connectivity and copper-preservation check."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET
import pcbnew as pcb
import wx

QUIET_WX = wx.LogNull()
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results/emc-kicad10/verify'
OUT.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('--cli', default=str(Path(sys.executable).with_name('kicad-cli.exe')))
args = parser.parse_args()
assert pcb.GetBuildVersion().startswith('10.'), 'Use KiCad 10 Python.'
original = ROOT / 'resources/example-catalog/sources/emc-flyback/design/emc_flyback'
converted = ROOT / 'examples/emc-flyback/emc-flyback'

def connections(stem, name):
    destination = OUT / f'{name}.net'
    env = dict(os.environ, KICAD_CONFIG_HOME=str(OUT / 'config'))
    subprocess.run([args.cli, 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o',
                    str(destination), str(stem.with_suffix('.kicad_sch'))], check=True, env=env)
    return [tuple(sorted((n.get('ref'), n.get('pin')) for n in net.findall('node')))
            for net in ET.parse(destination).findall('.//nets/net')]

bench = {'V1', 'R21', 'V2', 'R22', 'I1'}
original_nets = connections(original, 'original')
converted_nets = connections(converted, 'converted')
physical_nets = [tuple(pin for pin in net if pin[0] not in bench) for net in converted_nets]
assert sorted(original_nets) == sorted(net for net in physical_nets if net), 'Original native schematic connectivity changed.'
def net_for(ref, pin):
    matches = [index for index, net in enumerate(converted_nets) if (ref, pin) in net]
    assert len(matches) == 1, f'Missing or duplicate testbench terminal {ref}.{pin}'
    return matches[0]
for a, b in [(('V1', '1'), ('R21', '1')), (('R21', '2'), ('T1', '1')),
             (('V1', '2'), ('U1', '5')), (('V2', '1'), ('U1', '7')),
             (('V2', '2'), ('U1', '5')), (('R22', '1'), ('D3', '1')),
             (('I1', '1'), ('D3', '1')), (('R22', '2'), ('U3', '3')),
             (('I1', '2'), ('U3', '3'))]:
    assert net_for(*a) == net_for(*b), f'Incorrect testbench connection {a} / {b}'
assert net_for('V1', '2') != net_for('R22', '2'), 'Native PGND and SGND must remain separate.'
before = pcb.LoadBoard(str(original.with_suffix('.kicad_pcb')))
after = pcb.LoadBoard(str(converted.with_suffix('.kicad_pcb')))
point = lambda p: (p.x, p.y)

def tracks(board):
    return sorted((t.m_Uuid.AsString(), point(t.GetStart()), point(t.GetEnd()), t.GetWidth(pcb.F_Cu) if isinstance(t, pcb.PCB_VIA) else t.GetWidth(),
                   t.GetLayer(), t.GetNetname(), t.IsLocked(),
                   t.GetDrillValue() if isinstance(t, pcb.PCB_VIA) else None)
                  for t in board.GetTracks())

assert tracks(before) == tracks(after), 'Copper tracks, vias, UUIDs or locks changed.'
def footprints(board, source_values=False):
    def nominal(f):
        ref = f.GetReference()
        return f.GetValue().split()[0] if source_values and ref[:1] in ('R', 'C', 'L') and ref[1:].isdigit() else f.GetValue()
    return sorted((f.m_Uuid.AsString(), f.GetReference(), nominal(f), point(f.GetPosition()),
                   f.GetOrientationDegrees(), f.GetLayer()) for f in board.GetFootprints())
assert footprints(before, source_values=True) == footprints(after), 'Footprint positions/identity or nominal values changed.'

def pads(board):
    groups = {}
    for f in board.GetFootprints():
        for p in f.Pads():
            key = (f.GetReference(), p.GetNumber(), p.GetNetname())
            shape = p.GetEffectivePolygon(p.GetLayer())
            if key in groups:
                groups[key].BooleanAdd(shape)
            else:
                groups[key] = pcb.SHAPE_POLY_SET(shape)
    return groups

old_pads, new_pads = pads(before), pads(after)
assert old_pads.keys() == new_pads.keys(), 'Pad references/nets changed.'
for key in old_pads:
    delta = pcb.SHAPE_POLY_SET(old_pads[key])
    delta.BooleanXor(new_pads[key])
    assert delta.Area() < 1, f'Pad copper changed: {key}, {delta.Area()} nm²'

summary = {'kicad': pcb.GetBuildVersion(), 'footprints': len(after.GetFootprints()),
           'tracksAndVias': len(after.GetTracks()), 'padGroups': len(new_pads),
           'zones': len(after.Zones()), 'nativeConnectivityEqual': True, 'padCopperEqual': True}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
