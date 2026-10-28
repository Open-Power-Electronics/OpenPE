"""Reproduce the ten checked-in PEBench EAGLE schematic conversions offline.

This is a build-time, allowlisted source converter, not an application importer.
Upstream symbols and net geometry are retained, including device/gate pad maps.
Filled curved logo polygons are tessellated with a documented 0.005 mm error.
Run with --collect F:/PEBench once to copy the provenance snapshots; normal runs
only read the checked-in upstream snapshots.
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'tests' / 'fixtures' / 'pebench'
SELECTION = [
    (1, 'pebench-sunny-buddy', 'Sunny Buddy', 'LT3652 solar battery charger.'),
    (3, 'pebench-buck-boost', 'Buck-Boost TPS63070', 'TPS63070 adjustable buck-boost regulator.'),
    (4, 'pebench-buck-ap63357', 'Buck AP63357', 'AP63357 fixed-output buck regulator.'),
    (5, 'pebench-big-easy-driver', 'Big Easy Driver', 'A4988 bipolar stepper motor driver.'),
    (6, 'pebench-tb6612fng', 'Dual TB6612FNG', 'Dual H-bridge DC motor driver.'),
    (7, 'pebench-powerboost-1000c', 'PowerBoost 1000C', 'USB battery charger and 5 V boost supply.'),
    (8, 'pebench-motor-shield-v2', 'Motor Shield V2', 'PCA9685-controlled dual motor shield.'),
    (9, 'pebench-drv8871', 'DRV8871 Motor Driver', 'Single brushed DC motor driver.'),
    (10, 'pebench-tps61023', 'MiniBoost TPS61023', 'Compact 5 V boost regulator.'),
    (19, 'pebench-autodriver-l6470', 'AutoDriver L6470', 'SPI-controlled bipolar stepper driver.'),
]
TOLERANCE = 0.005
# Each selected source has a fixed namespace for deterministic native identities.
CONVERSION_NAMESPACES = {
    'pebench-sunny-buddy': '20dd8f05-29ad-5045-95f7-1ec5259aec91',
    'pebench-buck-boost': 'c60d11dd-f5d0-5f90-ab53-11c5ddafeaa9',
    'pebench-buck-ap63357': '8439387f-d33e-50ac-80a1-dca708a28f71',
    'pebench-big-easy-driver': '7be38780-85b6-5859-87b6-1331850dafbb',
    'pebench-tb6612fng': '6796584a-4a2b-50fd-973b-91a3ef0a5b55',
    'pebench-powerboost-1000c': 'bdabf4e6-dbb5-58d4-8623-7a94e011cfb2',
    'pebench-motor-shield-v2': '4da553d9-fd19-57ff-a75a-c52dbe7e4006',
    'pebench-drv8871': 'b460af5f-9a29-5966-8283-6e2032fe07af',
    'pebench-tps61023': 'b16b2768-7fc1-5f43-aa53-d67c40ea5b24',
    'pebench-autodriver-l6470': 'd1ab08ce-44a9-5ee6-a914-9e313aba377c',
}

def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def q(value):
    return json.dumps(str(value), ensure_ascii=False)

def f(value):
    value = round(float(value), 4)
    return str(int(value)) if value == int(value) else str(value)

def xy(x, y):
    return f(x) + ' ' + f(y)

def attr(node, key, default=0):
    return float(node.get(key, default))

def rotation(node):
    raw = node.get('rot', 'R0')
    return float(raw.split('R')[-1]), 'M' in raw

def transform(x, y, angle=0, mirror=False):
    a = math.radians(angle)
    x,y = x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)
    return (-x if mirror else x), y

def label_on_wire(label, segment):
    x,y=attr(label,'x'),attr(label,'y')
    for wire in segment.findall('wire'):
        x1,y1,x2,y2=[attr(wire,k) for k in ['x1','y1','x2','y2']]
        if abs(math.hypot(x-x1,y-y1)+math.hypot(x-x2,y-y2)-math.hypot(x2-x1,y2-y1))<0.00001:
            return True
    return False

def arc_points(a, b, degrees):
    angle = math.radians(degrees)
    dx, dy = b[0] - a[0], b[1] - a[1]
    chord = math.hypot(dx, dy)
    if not chord or abs(angle) < 1e-10:
        return None
    distance = chord / (2 * math.tan(angle / 2))
    center = ((a[0] + b[0]) / 2 - dy / chord * distance,
              (a[1] + b[1]) / 2 + dx / chord * distance)
    radius = math.hypot(a[0] - center[0], a[1] - center[1])
    start = math.atan2(a[1] - center[1], a[0] - center[0])
    point = lambda t: (center[0] + radius * math.cos(start + angle * t),
                       center[1] + radius * math.sin(start + angle * t))
    return radius, angle, point

def collect(root):
    prior_path = DEST / 'upstream-index.json'
    prior_entries = ({entry['id']: entry for entry in json.loads(prior_path.read_text(encoding='utf-8'))}
                     if prior_path.exists() else {})
    result = []
    for number, slug, title, description in SELECTION:
        matches = list((root / 'boards').glob(f'{number:03}_*')) + list((root / 'excluded/2026-10-15-complexity').glob(f'{number:03}_*'))
        if len(matches) != 1:
            raise ValueError(f'Expected one source for {number}: {matches}')
        board = matches[0]
        meta = json.loads((board / 'metadata.json').read_text(encoding='utf-8'))
        folder = DEST / 'upstream' / slug
        folder.mkdir(parents=True, exist_ok=True)
        source = board / meta.get('source_root', 'source')
        files = [
            ('source.sch', source / meta['selected_source_schematic']),
            ('source.brd', source / meta['selected_source_pcb']),
            ('board.kicad_pcb', board / 'kicad10/board.kicad_pcb'),
            ('metadata.json', board / 'metadata.json'),
        ]
        for local, original in files:
            shutil.copyfile(original, folder / local)
        for name in ['eagle_source_audit.json', 'source_to_output_audit.json', 'conversion.json']:
            original = board / 'validation' / name
            if original.exists():
                shutil.copyfile(original, folder / name)
        notices = []
        for name in ['README.md', 'LICENSE.md', 'License.md', 'LICENSE', 'LICENSE.txt']:
            original = source / name
            if original.exists():
                target = 'upstream-' + name
                # Windows is case-insensitive; do not copy the same notice twice.
                if target.lower() in [x.lower() for x in notices]:
                    continue
                shutil.copyfile(original, folder / target)
                notices.append(target)
        # Supplemental legal texts may have been pinned after the initial
        # collection. They are part of the checked-in source package, so a
        # source refresh must preserve their entries and verify their bytes.
        prior = prior_entries.get(slug, {})
        supplemental = []
        known_hashes = {notice['file']: notice['sha256']
                       for notice in prior.get('supplementalNotices', [])}
        for name in prior.get('notices', []):
            if name.lower() in [notice.lower() for notice in notices]:
                continue
            if not name.startswith('upstream-') or '/' in name or '\\' in name:
                raise ValueError(f'Invalid supplemental notice name: {name}')
            notice = folder / name
            if not notice.is_file():
                raise ValueError(f'Missing pinned supplemental notice: {notice}')
            checksum = digest(notice)
            if name in known_hashes and checksum != known_hashes[name]:
                raise ValueError(f'Supplemental notice checksum mismatch: {notice}')
            notices.append(name)
            supplemental.append({'file': name, 'sha256': checksum})
        license_name = meta.get('hardware_license') or ('CC-BY-SA-4.0' if number == 19 else None)
        if not license_name:
            raise ValueError(f'License must be established for {slug}')
        entry = {'id': slug, 'title': title, 'description': description, 'pebenchId': board.name,
                 'repository': meta['source_url'], 'commit': meta['commit_sha'],
                 'license': license_name, 'notices': notices,
                 'sourceDirectory': str(board.relative_to(root)).replace('\\', '/'),
                 'schematic': {'file': 'source.sch', 'path': meta['selected_source_schematic'], 'sha256': digest(folder/'source.sch')},
                 'pcb': {'file': 'source.brd', 'path': meta['selected_source_pcb'], 'sha256': digest(folder/'source.brd')},
                 'convertedPCB': {'file': 'board.kicad_pcb', 'sha256': digest(folder/'board.kicad_pcb')},
                 'acceptance': meta.get('acceptance_review'), 'drc': meta.get('drc'),
                 'qualification': 'Educational source example; not a qualified PEBench production or zero-DRC sample.'}
        if supplemental:
            entry['supplementalNotices'] = supplemental
        result.append(entry)
    dump(DEST / 'upstream-index.json', result)
    return result

class Converter:
    def __init__(self, entry):
        self.entry = entry
        self.slug = entry['id']
        self.namespace = uuid.UUID(CONVERSION_NAMESPACES[self.slug])
        folder = DEST / 'upstream' / self.slug
        path = folder / 'source.sch'
        if digest(path) != entry['schematic']['sha256']:
            raise ValueError('Source hash mismatch: ' + str(path))
        self.source = ET.parse(path).find('./drawing/schematic')
        if self.source is None:
            raise ValueError('Only EAGLE XML schematics are supported.')
        if len(self.source.findall('sheets/sheet')) != 1:
            raise ValueError('These examples require exactly one schematic sheet.')
        self.sheet = self.source.find('sheets/sheet')
        self.libraries = {lib.get('name'): lib for lib in self.source.findall('libraries/library')}
        self.parts = {part.get('name'): part for part in self.source.findall('parts/part')}
        self.instances = self.sheet.findall('instances/instance')
        self.gate_instances = {(i.get('part'), i.get('gate')): i for i in self.instances}
        self.y_origin = 20 + max([attr(i, 'y') for i in self.instances] + [0])
        self.annotations = []
        self.audit = {'id': self.slug, 'sourceSha256': entry['schematic']['sha256'],
                      'coordinateTransform': {'xOffset': 20, 'yOrigin': self.y_origin, 'sourceYUp': True},
                      'symbols': [], 'nets': [], 'tessellatedPolygons': [],
                      'preservedSourceFiles': ['source.sch', 'source.brd', 'board.kicad_pcb'],
                      'notes': ['Original EAGLE symbols, gate identities and physical pad mappings are retained.',
                                'Source frame objects and decorative sheet graphics are expanded into pinless annotation symbols.',
                                'A net label is attached to every disconnected named source segment to retain EAGLE net identity.']}
        self.output_libraries = {}
        self.device_data = {}
        self.pin_maps = {}

    def uid(self, key):
        return str(uuid.uuid5(self.namespace, key))

    def point(self, x, y):
        return xy(x + 20, self.y_origin - y)

    def stroke(self, width):
        return f'(stroke (width {f(width)}) (type default))'

    def line(self, a, b, width=0.1524):
        return f'(polyline (pts (xy {xy(*a)}) (xy {xy(*b)})) {self.stroke(width)} (fill (type none)))'

    def effects(self, size, align='bottom-left', mirror=False):
        justify = []
        if 'left' in align: justify.append('left')
        elif 'right' in align: justify.append('right')
        if 'top' in align: justify.append('top')
        elif 'bottom' in align: justify.append('bottom')
        if mirror: justify.append('mirror')
        return f'(effects (font (size {f(size)} {f(size)}))' + (f' (justify {" ".join(justify)}))' if justify else ')')

    def text(self, content, x, y, size, angle=0, align='bottom-left', mirror=False):
        return f'(text {q(content)} (at {xy(x,y)} {f(angle)}) {self.effects(size,align,mirror)})'

    def graphics(self, nodes, context):
        result = []
        nodes = list(nodes)
        # EAGLE logos frequently use thousands of adjacent scanline rectangles.
        # Union only rectangles with exactly equal boundaries: no rasterization
        # or contour approximation is introduced by this size reduction.
        groups = collections.defaultdict(list)
        remaining = []
        for node in nodes:
            if node.tag == 'rectangle' and rotation(node) == (0, False):
                x1,x2=sorted([attr(node,'x1'),attr(node,'x2')])
                y1,y2=sorted([attr(node,'y1'),attr(node,'y2')])
                groups[(y1,y2,node.get('layer'))].append((x1,x2))
            else:
                remaining.append(node)
        vertical = collections.defaultdict(list)
        for (y1,y2,layer), intervals in groups.items():
            merged=[]
            for x1,x2 in sorted(intervals):
                if merged and x1 <= merged[-1][1]:
                    merged[-1]=(merged[-1][0], max(merged[-1][1], x2))
                else:
                    merged.append((x1,x2))
            for x1,x2 in merged:
                vertical[(x1,x2,layer)].append((y1,y2))
        for (x1,x2,layer), intervals in vertical.items():
            merged=[]
            for y1,y2 in sorted(intervals):
                if merged and y1 <= merged[-1][1]:
                    merged[-1]=(merged[-1][0], max(merged[-1][1],y2))
                else:
                    merged.append((y1,y2))
            for y1,y2 in merged:
                remaining.append(ET.Element('rectangle', {'x1':str(x1),'x2':str(x2),'y1':str(y1),'y2':str(y2),'layer':layer}))
        nodes = remaining
        for index, node in enumerate(nodes):
            kind = node.tag
            if kind in ['description', 'pin']:
                continue
            if kind == 'wire':
                a, b = (attr(node,'x1'),attr(node,'y1')), (attr(node,'x2'),attr(node,'y2'))
                curve = attr(node, 'curve')
                arc = arc_points(a,b,curve) if curve else None
                if arc:
                    mid = arc[2](0.5)
                    result.append(f'(arc (start {xy(*a)}) (mid {xy(*mid)}) (end {xy(*b)}) {self.stroke(attr(node,"width"))} (fill (type none)))')
                else:
                    result.append(self.line(a,b,attr(node,'width')))
            elif kind == 'rectangle':
                a, b = (attr(node,'x1'),attr(node,'y1')), (attr(node,'x2'),attr(node,'y2'))
                angle, mirror = rotation(node)
                if angle or mirror:
                    center = ((a[0]+b[0])/2,(a[1]+b[1])/2)
                    corners = [(a[0],a[1]),(b[0],a[1]),(b[0],b[1]),(a[0],b[1]),(a[0],a[1])]
                    corners = [(center[0]+p[0],center[1]+p[1]) for p in [transform(x-center[0],y-center[1],angle,mirror) for x,y in corners]]
                    result.append('(polyline (pts '+ ' '.join(f'(xy {xy(*p)})' for p in corners) + f') {self.stroke(0)} (fill (type outline)))')
                else:
                    result.append(f'(rectangle (start {xy(*a)}) (end {xy(*b)}) {self.stroke(0)} (fill (type outline)))')
            elif kind == 'circle':
                result.append(f'(circle (center {xy(attr(node,"x"),attr(node,"y"))}) (radius {f(attr(node,"radius"))}) {self.stroke(attr(node,"width"))} (fill (type {"outline" if attr(node,"width")==0 else "none"})))')
            elif kind == 'polygon':
                vertices = list(node)
                points = []
                tessellated = False
                for j,v in enumerate(vertices):
                    a = (attr(v,'x'),attr(v,'y'))
                    b = (attr(vertices[(j+1)%len(vertices)],'x'),attr(vertices[(j+1)%len(vertices)],'y'))
                    points.append(a)
                    curve = attr(v,'curve')
                    if curve:
                        arc = arc_points(a,b,curve)
                        if arc:
                            radius,angle,point = arc
                            steps = max(2,math.ceil(abs(angle)/(2*math.acos(max(-1,1-TOLERANCE/radius)))))
                            points.extend(point(k/steps) for k in range(1,steps))
                            tessellated = True
                points.append(points[0])
                result.append('(polyline (pts '+' '.join(f'(xy {xy(*p)})' for p in points)+f') {self.stroke(attr(node,"width"))} (fill (type outline)))')
                if tessellated:
                    self.audit['tessellatedPolygons'].append({'context': context, 'index': index, 'maxSagittaMm':TOLERANCE, 'vertices':len(points)})
            elif kind == 'text':
                text = node.text or ''
                if text.upper() in ['>NAME','>VALUE']:
                    continue
                text=text.replace('>DRAWING_NAME',Path(self.entry['schematic']['path']).stem).replace('>SHEET','1/1')
                angle,mirror = rotation(node)
                result.append(self.text(text,attr(node,'x'),attr(node,'y'),attr(node,'size',1.27),angle,node.get('align','bottom-left'),mirror))
            elif kind == 'frame':
                x1,y1,x2,y2 = [attr(node,k) for k in ['x1','y1','x2','y2']]
                cols,rows = int(node.get('columns')),int(node.get('rows'))
                # EAGLE's frame grid has a 5 mm border and numbered columns.
                for a,b in [((x1,y1),(x2,y1)),((x2,y1),(x2,y2)),((x2,y2),(x1,y2)),((x1,y2),(x1,y1)),((x1+5,y1+5),(x2-5,y1+5)),((x2-5,y1+5),(x2-5,y2-5)),((x2-5,y2-5),(x1+5,y2-5)),((x1+5,y2-5),(x1+5,y1+5))]:
                    result.append(self.line(a,b))
                for j in range(cols):
                    x=x1+(x2-x1)*(j+.5)/cols
                    result.extend([self.text(str(j+1),x,y1+2.5,2,align='center'),self.text(str(j+1),x,y2-2.5,2,align='center')])
                    if j:
                        x=x1+(x2-x1)*j/cols
                        result.extend([self.line((x,y1),(x,y1+5)),self.line((x,y2-5),(x,y2))])
                for j in range(rows):
                    y=y2-(y2-y1)*(j+.5)/rows
                    result.extend([self.text(chr(65+j),x1+2.5,y,2,align='center'),self.text(chr(65+j),x2-2.5,y,2,align='center')])
            else:
                raise ValueError(f'Unsupported EAGLE symbol primitive {kind}: {context}')
        return result

    def device(self, part):
        key = (part.get('library'),part.get('deviceset'),part.get('device'))
        if key in self.device_data:
            return self.device_data[key]
        lib = self.libraries[key[0]]
        ds = next(d for d in lib.findall('devicesets/deviceset') if d.get('name')==key[1])
        dev = next(d for d in ds.findall('devices/device') if d.get('name')==key[2])
        gates = ds.findall('gates/gate')
        identity = 'PEBench:' + re.sub(r'[^A-Za-z0-9_.+\-/]', '_', '/'.join(key))
        maps = {(c.get('gate'),c.get('pin')):c.get('pad').split() for c in dev.findall('connects/connect')}
        units = []
        symbols = {}
        for unit,gate in enumerate(gates,1):
            sym = next(s for s in lib.findall('symbols/symbol') if s.get('name')==gate.get('symbol'))
            symbols[gate.get('name')] = sym
            graphic = self.graphics(sym,identity+':'+gate.get('name'))
            for pin in sym.findall('pin'):
                name = pin.get('name')
                # One EAGLE logical pin may drive several physical pads.
                numbers = maps.get((gate.get('name'),name),[name])
                length = {'point':0,'short':2.54,'middle':5.08,'long':7.62}[pin.get('length','long')]
                angle,mirror=rotation(pin)
                # EAGLE controls pin-name/pad-number visibility per pin. KiCad
                # controls it per symbol, so retain the visible source captions
                # as library text and hide its automatic generated captions.
                visible=pin.get('visible','both')
                caption_angle=angle if angle in [0,90] else angle-180
                if visible in ['both','pin']:
                    dx,dy=transform(length+1.016,0,angle)
                    shown_name=name.split('@',1)[0]
                    graphic.append(self.text(shown_name,attr(pin,'x')+dx,attr(pin,'y')+dy,1.016,caption_angle,'center-right' if angle in [180,270] else 'center-left'))
                if visible in ['both','pad'] and maps.get((gate.get('name'),name)):
                    dx,dy=transform(length/2,0.508,angle)
                    graphic.append(self.text(' '.join(numbers),attr(pin,'x')+dx,attr(pin,'y')+dy,1.016,caption_angle,'bottom-center'))
                for number in numbers:
                    if mirror: raise ValueError('Mirrored pin is unsupported')
                    # EAGLE NC direction does not suppress explicit net membership.
                    # KiCad no_connect does, so passive retains the original nets.
                    direction = {'nc':'passive','in':'input','out':'output','io':'bidirectional','oc':'open_collector','hiz':'tri_state','pas':'passive','pwr':'power_in','sup':'power_out'}.get(pin.get('direction','io'))
                    if pin.get('direction') == 'nc':
                        self.audit['notes'].append(f'{identity} {gate.get("name")} {name}: EAGLE NC pin rendered passive because explicit source nets remain authoritative; no ERC equivalence is claimed.')
                    if not direction: raise ValueError('Unsupported pin direction')
                    shape = {'none':'line','dot':'inverted','clk':'clock','dotclk':'inverted_clock'}.get(pin.get('function','none'))
                    if not shape: raise ValueError('Unsupported pin function')
                    graphic.append(f'(pin {direction} {shape} (at {xy(attr(pin,"x"),attr(pin,"y"))} {f(angle)}) (length {f(length)}) (name {q(name)} (effects (font (size 1.016 1.016)))) (number {q(number)} (effects (font (size 1.016 1.016)))))')
            units.append(f'(symbol {q(identity.split(":",1)[1]+"_"+str(unit)+"_1")} {" ".join(graphic)})')
        libsource = f'(symbol {q(identity)} (pin_numbers hide) (pin_names (offset 1.016) hide) (in_bom {"yes" if dev.get("package") else "no"}) (on_board {"yes" if dev.get("package") else "no"}) (property "Reference" {q(ds.get("prefix","U"))} (at 0 2.54 0) (effects (font (size 1.27 1.27)))) (property "Value" {q(key[1])} (at 0 -2.54 0) (effects (font (size 1.27 1.27)))) {" ".join(units)})'
        self.output_libraries[identity] = libsource
        data = {'id':identity,'gates':gates,'symbols':symbols,'maps':maps,'device':dev}
        self.device_data[key] = data
        return data

    def property(self, name, text, x, y, angle=0, hide=False, size=1.27):
        return f'(property {q(name)} {q(text)} (at {self.point(x,y)} {f(angle)}) (effects (font (size {f(size)} {f(size)})){" (hide yes)" if hide else ""}))'

    def convert(self):
        instances=[]
        for instance in self.instances:
            reference,gate=instance.get('part'),instance.get('gate')
            part=self.parts[reference]
            data=self.device(part)
            unit=next(i for i,g in enumerate(data['gates'],1) if g.get('name')==gate)
            symbol=data['symbols'][gate]
            angle,mirror=rotation(instance)
            value=part.get('value') or part.get('deviceset')+part.get('device')
            x,y=attr(instance,'x'),attr(instance,'y')
            properties=[]
            for name,macro,text in [('Reference','>NAME',reference),('Value','>VALUE',value)]:
                field=next((n for n in symbol.findall('text') if (n.text or '').upper()==macro),None)
                override=next((a for a in instance.findall('attribute') if a.get('name').upper()==name.upper().replace('REFERENCE','NAME')),None)
                if override is not None:
                    fx,fy=attr(override,'x'),attr(override,'y')
                    fa,_=rotation(override)
                elif field is not None:
                    fx,fy=transform(attr(field,'x'),attr(field,'y'),angle,mirror)
                    fx,fy=x+fx,y+fy
                    fa=(rotation(field)[0]+angle)%360
                else:
                    fx,fy,fa=x,y,0
                # EAGLE keeps field captions readable unless the explicit spin
                # rotation flag is present; component rotation alone does not
                # turn a 180-degree caption upside down.
                if 'S' not in instance.get('rot',''):
                    fa=fa%180
                properties.append(self.property(name,text,fx,fy,fa,field is None,attr(override if override is not None else field,'size',1.27) if field is not None else 1.27))
            if data['device'].get('package'):
                properties.append(self.property('Footprint','PEBench:'+part.get('library')+'/'+data['device'].get('package'),x,y,hide=True))
            for attribute in part.findall('attribute'):
                if attribute.get('name') not in ['NAME','VALUE']:
                    properties.append(self.property(attribute.get('name'),attribute.get('value',''),x,y,hide=True))
            symbol_id=self.uid('part:'+reference+':'+gate)
            schematic_rotation=angle%360
            instances.append(f'(symbol (lib_id {q(data["id"])}) (at {self.point(x,y)} {f(schematic_rotation)})'+(' (mirror y)' if mirror else '')+f' (unit {unit}) (in_bom {"yes" if data["device"].get("package") else "no"}) (on_board {"yes" if data["device"].get("package") else "no"}) (dnp no) (uuid {q(symbol_id)}) {" ".join(properties)} (instances (project {q(self.slug)} (path {q("/"+self.uid("schematic"))} (reference {q(reference)}) (unit {unit})))))')
            pins={p.get('name'):data['maps'].get((gate,p.get('name')),[p.get('name')]) for p in symbol.findall('pin')}
            self.pin_maps[(reference,gate)]=pins
            self.audit['symbols'].append({'reference':reference,'gate':gate,'unit':unit,'id':symbol_id,'libraryId':data['id'],'pads':pins,'package':data['device'].get('package')})
        # Decorative source graphics are isolated from electrical wire topology.
        decorative=list(self.sheet.findall('plain/*'))
        for net in self.sheet.findall('nets/net'):
            for segment in net.findall('segment'):
                for label in segment.findall('label'):
                    if not label_on_wire(label,segment):
                        node=ET.Element('text',label.attrib)
                        node.text=net.get('name')
                        decorative.append(node)
        for bus in self.sheet.findall('busses/bus'):
            decorative.extend(bus.findall('segment/wire'))
            self.audit['notes'].append('Source bus '+bus.get('name')+' retained as decorative wiring; individual named nets preserve all electrical connections.')
        if decorative:
            identity='PEBench:Source_Annotations'
            source=self.graphics(decorative,identity)
            self.output_libraries[identity]=f'(symbol {q(identity)} (in_bom no) (on_board no) (property "Reference" "#GRAPHICS" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes))) (property "Value" "Source annotations" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes))) (symbol "Source_Annotations_1_1" {" ".join(source)}))'
            instances.append(f'(symbol (lib_id {q(identity)}) (at {self.point(0,0)} 0) (unit 1) (in_bom no) (on_board no) (dnp no) (uuid {q(self.uid("annotations"))}) {self.property("Reference","#GRAPHICS",0,0,hide=True)} {self.property("Value","Source annotations",0,0,hide=True)} (instances (project {q(self.slug)} (path {q("/"+self.uid("schematic"))} (reference "#GRAPHICS") (unit 1)))))')
        wires=[];junctions=[];labels=[]
        for net in self.sheet.findall('nets/net'):
            name=net.get('name')
            expected=[]
            for segment_index,segment in enumerate(net.findall('segment')):
                key='net:'+name+':'+str(segment_index)
                for pin in segment.findall('pinref'):
                    reference,gate,pin_name=[pin.get(k) for k in ['part','gate','pin']]
                    for number in self.pin_maps[(reference,gate)][pin_name]:
                        expected.append({'reference':reference,'pin':number,'gate':gate,'sourcePin':pin_name})
                for i,wire in enumerate(segment.findall('wire')):
                    if attr(wire,'curve'):
                        raise ValueError('Curved electrical wire requires a supported path model.')
                    wires.append(f'(wire (pts (xy {self.point(attr(wire,"x1"),attr(wire,"y1"))}) (xy {self.point(attr(wire,"x2"),attr(wire,"y2"))})) (stroke (width 0) (type default)) (uuid {q(self.uid(key+":wire:"+str(i)))}))')
                for i,j in enumerate(segment.findall('junction')):
                    junctions.append(f'(junction (at {self.point(attr(j,"x"),attr(j,"y"))}) (diameter 0) (color 0 0 0 0) (uuid {q(self.uid(key+":junction:"+str(i)))}))')
                source_labels=[label for label in segment.findall('label') if label_on_wire(label,segment)]
                if not source_labels:
                    first=segment.find('wire')
                    if first is not None:
                        source_labels=[ET.Element('label',{'x':first.get('x1'),'y':first.get('y1'),'size':'0.762'})]
                    else:
                        pin=segment.find('pinref')
                        if pin is not None:
                            reference,gate,pn=[pin.get(k) for k in ['part','gate','pin']]
                            ins=self.gate_instances[(reference,gate)]
                            sym=self.device(self.parts[reference])['symbols'][gate]
                            p=next(p for p in sym.findall('pin') if p.get('name')==pn)
                            dx,dy=transform(attr(p,'x'),attr(p,'y'),*rotation(ins))
                            source_labels=[ET.Element('label',{'x':f(attr(ins,'x')+dx),'y':f(attr(ins,'y')+dy),'size':'0.762'})]
                for i,label in enumerate(source_labels):
                    angle,_=rotation(label)
                    labels.append(f'(label {q(name)} (at {self.point(attr(label,"x"),attr(label,"y"))} {f(angle)}) (effects (font (size {f(attr(label,"size",1.27))} {f(attr(label,"size",1.27))})) (justify left bottom)) (uuid {q(self.uid(key+":label:"+str(i)))}))')
            self.audit['nets'].append({'name':name,'pins':expected})
        self.audit['counts']={'sourceParts':len(self.parts),'sourceInstances':len(self.instances),'generatedInstances':len(instances),'wires':len(wires),'junctions':len(junctions),'labels':len(labels),'embeddedSymbols':len(self.output_libraries)}
        result=f'(kicad_sch (version 20260306) (generator "openpe_pebench") (uuid {q(self.uid("schematic"))}) (title_block (title {q(self.entry["title"])}))\n(lib_symbols\n'+ '\n'.join(self.output_libraries.values()) + ')\n' + '\n'.join(wires+junctions+labels+instances) + '\n(embedded_fonts no))\n'
        folder=DEST/'converted'
        folder.mkdir(parents=True,exist_ok=True)
        (folder/(self.slug+'.kicad_sch')).write_text(result,encoding='utf-8')
        dump(folder/(self.slug+'.audit.json'),self.audit)
        print(self.slug,self.audit['counts'])

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collect',type=Path)
    parser.add_argument('--only')
    args=parser.parse_args()
    entries=collect(args.collect) if args.collect else json.loads((DEST/'upstream-index.json').read_text(encoding='utf-8'))
    for entry in entries:
        if args.only and args.only != entry['id']:
            continue
        Converter(entry).convert()

if __name__ == '__main__':
    main()
