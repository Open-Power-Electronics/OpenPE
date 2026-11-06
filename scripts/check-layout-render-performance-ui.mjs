import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { openVisualization, toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));

// Real EMC geometry in an isolated renderer. No Electron, services, models,
// providers, user files or design writes are involved.
const bundle = await build({
  stdin: {
    contents: `import React,{Suspense,startTransition,useMemo,useState,useRef,useLayoutEffect} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
      import LayoutEditor from './components/LayoutEditor';
      import {ownProjectData} from './lib/immutable-project';
      import {flushLayoutCamera} from './lib/layout-camera-presentation';
      window.flushLayoutCamera=flushLayoutCamera;
      import {analyzePCBConnectivity} from './lib/pcb-connectivity';import {invalidatePCBFill} from './lib/pcb';
      import {captureLayoutPNG} from './lib/drawing-export';import {pcbBounds} from './lib/pcb-layout';
      import {LayoutTrackDrawing} from './components/LayoutBoardDrawing';
      import {createLayoutSelection} from './components/LayoutSelection';
      import useRetainedElements from './components/useRetainedElements';
      import useRetainedElementBatches from './components/useRetainedElementBatches';
      function Fixture(){
        const [,setCameraReplay]=useState(0);window.commitCameraReplay=()=>setCameraReplay(value=>value+1);
        const [project]=useState(()=>ownProjectData(window.fixture));
        const [board,setBoard]=useState(project.pcb),[schematic,setSchematic]=useState(project.schematic),[visible,setVisible]=useState(true);const [context,setContext]=useState(()=>({current:null}));window.layoutContext=()=>context.current;
        window.replaceLayoutCameraContext=()=>setContext({current:null});
        window.setLayoutVisible=setVisible;
        window.replaceLayoutBoard=setBoard;
        window.expectedNetEdgeCount=()=>analyzePCBConnectivity(board).edges.length;
        window.extendTrackFar=()=>setBoard(previous=>invalidatePCBFill(previous,{...previous,tracks:previous.tracks.map((track,index)=>index?track:
          {...track,end:{x:track.end.x+200,y:track.end.y}})}));
        window.captionFootprint=window.fixture.pcb.footprints.find(footprint=>footprint.symbolId&&footprint.pads.length);
        window.changeSchematicPose=()=>setSchematic(previous=>({...previous,parts:previous.parts.map(part=>part.id===window.captionFootprint.symbolId?{...part,x:part.x+1.27}:part)}));
        window.changeSchematicValue=()=>setSchematic(previous=>({...previous,parts:previous.parts.map(part=>part.id===window.captionFootprint.symbolId?{...part,value:'LATESTVALUE'}:part)}));
        window.changeHiddenSchematic=()=>setSchematic(previous=>({...previous,parts:previous.parts.map(part=>part.id===window.captionFootprint.symbolId?{...part,ref:'HIDDENLATEST'}:part)}));
        window.changeLayoutBoard=()=>setBoard(previous=>({...previous,footprints:previous.footprints.map(
          (footprint,index)=>index?footprint:{...footprint,x:footprint.x+1})}));
        window.changeLayoutTrack=()=>setBoard(previous=>{
          const track=previous.tracks.find(track=>track.layer==='F.Cu');
          window.editedTrackId=track.id;
          return ownProjectData({...previous,tracks:previous.tracks.map(candidate=>candidate===track?
            {...track,end:{...track.end,x:track.end.x+0.5}}:candidate)},previous);
        });
        window.changeCameraTrackWidth=()=>setBoard(previous=>ownProjectData({...previous,
          tracks:previous.tracks.map(track=>track.id===window.editedTrackId?
            {...track,width:track.width+0.1}:track)},previous));
        window.appendCameraTrack=()=>setBoard(previous=>{
          const added={...previous.tracks[0],id:crypto.randomUUID()};window.appendedCameraTrackId=added.id;
          return ownProjectData({...previous,tracks:[...previous.tracks,added]},previous);
        });
        window.captureLayout=()=>captureLayoutPNG(document.querySelector('[data-testid="layout-canvas"]'),pcbBounds(board));
        window.layoutBoard=board;
        return <LayoutEditor leftButtonDrag="drag-any" board={board} schematic={schematic} active={visible} visible={visible} agentContextRef={context}
          onCommit={()=>{window.commits++;return false}}
          annotations={[]} annotationSessionId="layout-performance" onAnnotationsChange={()=>{}}/>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
      const replayTracks=ownProjectData(window.fixture.pcb.tracks.slice(0,65).map((track,index)=>({...track,
        id:'replay-'+index,layer:'F.Cu'})));
      const initialReplay={tracks:replayTracks,layers:{'F.Cu':true,'B.Cu':true},netName:'Committed'};
      const never=new Promise(()=>{});
      function ReplayTracks({state}){
        const [selection]=useState(createLayoutSelection),[highlightNets]=useState(()=>new Set());
        const retain=useRetainedElements(state.tracks,[state.tracks,state.layers,state.netName]);
        const retainBatches=useRetainedElementBatches([state.tracks,state.layers,state.netName]);
        const nodes=useMemo(()=>['B.Cu','F.Cu'].map(layer=>{const children=state.tracks.filter(track=>state.layers[layer]&&track.layer===layer).map(track=>retain({
          key:track.id,track,netName:state.netName,selection,highlightNets},({key,...props})=>
          <LayoutTrackDrawing key={key} {...props}/>));
          return {layer,children,batches:retainBatches('replay:'+layer,children)};
        }),[state.tracks,state.layers,state.netName]);
        useLayoutEffect(()=>{window.replayBatches=nodes.flatMap(node=>node.batches);window.replayChildren=nodes.flatMap(node=>node.children);window.replayCallerArrays=nodes.map(node=>node.children);});
        window.selectReplay=id=>selection.update(new Set(id?[id]:[]),new Set());
        return <svg data-testid="layout-retention-replay">{nodes.map(node=><g key={node.layer} data-replay-layer={node.layer}>{node.batches}</g>)}</svg>;
      }
      function PauseReplay({state}){if(state.suspend){window.replaySuspended++;throw never;}return null;}
      function ReplayFixture(){const [state,setState]=useState(initialReplay);
        window.interruptReplay=()=>startTransition(()=>setState({...initialReplay,
          layers:{'F.Cu':false,'B.Cu':true},netName:'Abandoned',suspend:true}));
        window.cancelReplay=()=>flushSync(()=>setState(initialReplay));
        window.refreshReplay=()=>flushSync(()=>setState({...initialReplay,tracks:[...replayTracks]}));
        window.toggleReplayLayer=visible=>flushSync(()=>setState(previous=>({...previous,
          layers:{...previous.layers,'F.Cu':visible}})));
        window.editReplayTrack=index=>flushSync(()=>setState(previous=>({...previous,tracks:previous.tracks.map((track,i)=>i===index?{...track,end:{...track.end,x:track.end.x+0.5}}:track)})));
        window.appendReplay=()=>flushSync(()=>setState(previous=>({...previous,tracks:[...previous.tracks,{...replayTracks[0],id:'replay-65'}]})));
        window.removeReplay=()=>flushSync(()=>setState(previous=>({...previous,tracks:previous.tracks.slice(0,-1)})));
        window.reorderReplay=()=>flushSync(()=>setState(previous=>({...previous,tracks:[previous.tracks.at(-1),...previous.tracks.slice(1,-1),previous.tracks[0]]})));
        window.moveReplayLayer=()=>flushSync(()=>setState(previous=>({...previous,tracks:previous.tracks.map((track,index)=>index===0?{...track,layer:'B.Cu'}:track)})));
        return <Suspense fallback={<span>Waiting</span>}><ReplayTracks state={state}/><PauseReplay state={state}/></Suspense>;
      }
      window.mountReplay=()=>{const host=document.createElement('div');host.style.cssText='position:fixed;left:-1000px';
        document.body.append(host);window.replaySuspended=0;
        createRoot(host).render(<React.StrictMode><ReplayFixture/></React.StrictMode>);};`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.OPENPE_RENDER_MODE || 'production'),
  },
  plugins: [
    {
      name: 'count-layout-work',
      setup(plugin) {
        plugin.onLoad(
          {
            filter:
              /[\\/](LayoutEditor\.tsx|LayoutFootprint\.tsx|LayoutBoardDrawing\.tsx|LayoutCamera\.tsx|LayoutAppearancePanel\.tsx|PCBSelectionPaint\.tsx|useRetainedElements\.ts|useRetainedElementBatches\.ts|pcb-display\.ts|pcb-polygons\.ts)$/,
          },
          async ({ path: file }) => {
            let contents = await readFile(file, 'utf8');
            if (path.basename(file) === 'useRetainedElementBatches.ts') {
              const expression = '      const element = createElement(Fragment, { key }, ordered);';
              assert.ok(
                contents.includes(expression),
                'Instrumentation finds actual Fragment batch creation.',
              );
              contents = contents.replace(
                expression,
                `window.layoutWork.batches++;if(!scope.startsWith('replay:'))window.layoutWork.trackBatches++;\n${expression}`,
              );
              contents = contents.replace(
                '    return batches;',
                '    window.batchFrames[scope]={children:[...children],batches:[...batches]};\n    return batches;',
              );
              return { contents, loader: 'ts', resolveDir: path.dirname(file) };
            }
            if (path.basename(file) === 'useRetainedElements.ts') {
              const expression = '    const element = render(props);';
              assert.ok(
                contents.includes(expression),
                'Instrumentation finds retained JSX creation.',
              );
              contents = contents.replace(
                expression,
                `window.layoutWork.elements++;
                if('track' in props)window.layoutWork.trackElements++;
                if('footprint' in props)window.layoutWork.footprintElements++;
                if('via' in props)window.layoutWork.viaElements++;
                if('graphic' in props)window.layoutWork.graphicElements++;
                ${expression}`,
              );
              return { contents, loader: 'ts', resolveDir: path.dirname(file) };
            }
            const marker = {
              'LayoutEditor.tsx': '  const pcb = board ?? empty;',
              'LayoutFootprint.tsx': '  const visibleLayer =',
              'LayoutAppearancePanel.tsx': '  const id = useId();',
              'PCBSelectionPaint.tsx': '  return (',
              'LayoutBoardDrawing.tsx': '  return (',
              'LayoutCamera.tsx': '  const scale = view.width / size.width;',
              'pcb-display.ts': '  if (!visible.footprints) return null;',
              'pcb-polygons.ts': '  polygons\n    .flatMap((p) => [p.outer, ...p.holes])',
            }[path.basename(file)];
            assert.ok(contents.includes(marker), `Instrumentation finds ${path.basename(file)}.`);
            contents = contents.replaceAll(
              marker,
              path.basename(file) === 'pcb-polygons.ts'
                ? '  (window.layoutWork.paths++, polygons)\n    .flatMap((p) => [p.outer, ...p.holes])'
                : `window.layoutWork.${{ 'LayoutEditor.tsx': 'renders', 'LayoutFootprint.tsx': 'footprints', 'LayoutAppearancePanel.tsx': 'appearance', 'PCBSelectionPaint.tsx': 'paint', 'LayoutBoardDrawing.tsx': 'boardRecords', 'LayoutCamera.tsx': 'cameraHits', 'pcb-display.ts': 'bounds' }[path.basename(file)]}++;\n${marker}`,
            );
            if (path.basename(file) === 'LayoutFootprint.tsx')
              contents = contents.replaceAll(
                'window.layoutWork.footprints++;',
                'window.layoutWork.footprints++;window.layoutWork.footprintOwners.push(f.id);',
              );
            if (path.basename(file) === 'LayoutAppearancePanel.tsx') {
              const expression = 'const body = useMemo(\n    () => (';
              assert.ok(
                contents.includes(expression),
                'Instrumentation finds retained Appearance controls.',
              );
              contents = contents.replace(
                expression,
                expression + '\n      window.layoutWork.appearanceBodies++,',
              );
            }
            if (path.basename(file) === 'LayoutCamera.tsx') {
              contents = contents.replace(
                '  return children({ width });',
                '  window.layoutWork.cameraScaleRenders++;\n  return children({ width });',
              );
              contents = contents.replace(
                'function cameraTargets(svg: SVGSVGElement, hits = true) {',
                'function cameraTargets(svg: SVGSVGElement, hits = true) {\n  window.layoutWork.cameraBindings++;',
              );
              const refreshEntry = '    refreshTracks() {';
              assert.equal(
                contents.split(refreshEntry).length - 1,
                1,
                'Instrumentation finds the single refreshTracks invocation entry.',
              );
              contents = contents.replace(
                refreshEntry,
                `${refreshEntry}\n      window.layoutWork.trackRefreshes++;`,
              );
            }
            if (path.basename(file) === 'LayoutEditor.tsx') {
              const cameraCommit = '    committedCameraApply.current?.();';
              assert.ok(
                contents.includes(cameraCommit),
                'Instrumentation finds the committed camera guard.',
              );
              contents = contents.replace(
                cameraCommit,
                '    window.replayCameraCommit?.();\n' + cameraCommit,
              );
              const body = '  function footprintBody(f: Footprint) {';
              assert.ok(contents.includes(body), 'Instrumentation finds footprint body targets.');
              contents = contents.replace(body, `${body}\n    window.layoutWork.bodyTargets++;`);
              for (const [name, counter] of [
                ['copperDrawing', 'copperTrees'],
                ['detailDrawing', 'detailTrees'],
                ['footprintDrawing', 'footprintTrees'],
                ['captionDrawing', 'captionTrees'],
                ['viaDrawing', 'viaTrees'],
                ['graphicDrawing', 'graphicTrees'],
                ['airwireDrawing', 'airwireTrees'],
              ]) {
                const expression = new RegExp(`const ${name} = useMemo\\(\\s*\\(\\) => ([({])`);
                assert.match(contents, expression, `Instrumentation finds ${name}.`);
                contents = contents.replace(
                  expression,
                  (matched, opening) =>
                    `${matched}\n      window.layoutWork.${counter}++${opening === '{' ? ';' : ','}`,
                );
              }
            }
            return {
              contents,
              loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
              resolveDir: path.dirname(file),
            };
          },
        );
      },
    },
  ],
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((fixture) => {
    window.fixture = fixture;
    window.commits = 0;
    window.batchFrames = {};
    window.layoutWork = {
      boardRecords: 0,
      renders: 0,
      bounds: 0,
      paths: 0,
      footprints: 0,
      footprintOwners: [],
      paint: 0,
      appearance: 0,
      appearanceBodies: 0,
      cameraHits: 0,
      cameraBindings: 0,
      trackRefreshes: 0,
      cameraScaleRenders: 0,
      copperTrees: 0,
      detailTrees: 0,
      footprintTrees: 0,
      captionTrees: 0,
      viaTrees: 0,
      graphicTrees: 0,
      airwireTrees: 0,
      bodyTargets: 0,
      elements: 0,
      trackElements: 0,
      batches: 0,
      trackBatches: 0,
      footprintElements: 0,
      viaElements: 0,
      graphicElements: 0,
    };
  }, project);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content: 'html,body,#root,.layout-editor{height:100%;margin:0}#root{width:calc(100% - .375px)}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  const currentView = () =>
    canvas.evaluate(
      (svg) => svg.getAttribute('data-layout-camera-view') ?? svg.getAttribute('viewBox'),
    );
  await canvas.waitFor();
  await page.waitForTimeout(100);
  const nextFrame = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const wheelZoom = async (direction) => {
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, direction === 'in' ? -120 : 120);
    await nextFrame();
  };
  const wheelBehavior = await canvas.evaluate(async (svg) => {
    const currentView = () =>
      svg.getAttribute('data-layout-camera-view') ?? svg.getAttribute('viewBox');
    const presentedFrame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = currentView().split(' ').map(Number);
    const bounds = svg.getBoundingClientRect();
    const at = {
      x: Math.floor(bounds.x + bounds.width * 0.31),
      y: Math.floor(bounds.y + bounds.height * 0.67),
    };
    const anchor = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM().inverse());
    const wheel = (deltaY, deltaX = 0) => {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: at.x,
        clientY: at.y,
        deltaX,
        deltaY,
      });
      svg.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const verticalPrevented = wheel(-50);
    const immediateZoomed = currentView().split(' ').map(Number);
    const immediateViewport = structuredClone(window.layoutContext().viewport);
    await presentedFrame();
    const zoomed = currentView().split(' ').map(Number);
    const projected = anchor.matrixTransform(svg.getScreenCTM());
    const horizontalBefore = currentView();
    const horizontalPrevented = wheel(0, 50);
    await presentedFrame();
    const horizontalUnchanged = currentView() === horizontalBefore;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    const overlayPrevented = wheel(-50);
    await presentedFrame();
    const overlayUnchanged = currentView() === horizontalBefore;
    dialog.remove();
    // Removing the overlay in this same turn must immediately restore input.
    const resumedPrevented = wheel(50);
    await presentedFrame();
    const restored = currentView().split(' ').map(Number);
    return {
      before,
      immediateZoomed,
      immediateViewport,
      zoomed,
      verticalPrevented,
      anchorError: Math.hypot(projected.x - at.x, projected.y - at.y),
      horizontalPrevented,
      horizontalUnchanged,
      overlayPrevented,
      overlayUnchanged,
      resumedPrevented,
      restored,
      unitsPerPixel: before[2] / bounds.width,
    };
  });
  console.log(JSON.stringify({ wheelPresentation: wheelBehavior }));
  assert.ok(
    Math.abs(wheelBehavior.immediateViewport.width - wheelBehavior.before[2] / 1.12) < 1e-10,
    'One wheel immediately updates the exact numerical camera by one zoom increment.',
  );
  assert.ok(
    Math.abs(wheelBehavior.zoomed[2] - wheelBehavior.before[2] / 1.12) < 1e-10,
    'One wheel applies exactly one zoom increment.',
  );
  assert.ok(
    wheelBehavior.anchorError < 1e-4,
    'Native wheel zoom retains its actual SVG pointer anchor.',
  );
  assert.equal(
    wheelBehavior.horizontalPrevented,
    false,
    'Horizontal-only wheels remain unconsumed.',
  );
  assert.equal(
    wheelBehavior.horizontalUnchanged,
    true,
    'Horizontal-only wheels retain the camera.',
  );
  assert.equal(wheelBehavior.overlayPrevented, false, 'Open overlays retain their wheel input.');
  assert.equal(wheelBehavior.overlayUnchanged, true, 'Open overlays block camera zoom.');
  wheelBehavior.restored.forEach((value, index) =>
    assert.ok(
      Math.abs(value - wheelBehavior.before[index]) <
        (index < 2 ? wheelBehavior.unitsPerPixel * 1e-4 : 1e-10),
      'Opposite wheel increments restore the camera within subpixel SVG matrix precision.',
    ),
  );
  await nextFrame();
  await canvas.press('Home');
  await nextFrame();
  const hoverTrack = await canvas.evaluate((svg) => {
    const id = '55e76c6c-a882-41a3-85b9-455b1a2d200e';
    const line = svg.querySelector(`[data-selection-id="${id}"] [data-layout-track-target]`);
    const point = new DOMPoint(
      (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2,
      (Number(line.getAttribute('y1')) + Number(line.getAttribute('y2'))) / 2,
    ).matrixTransform(svg.getScreenCTM());
    return { id, x: point.x, y: point.y };
  });
  await page.mouse.move(hoverTrack.x, hoverTrack.y);
  await canvas.evaluate((svg) =>
    svg.addEventListener(
      'keydown',
      (event) => {
        if (event.key.toLowerCase() === 'd')
          window.hoverDWasTransient = svg.hasAttribute('data-layout-camera-view');
      },
      { capture: true, once: true },
    ),
  );
  await page.mouse.wheel(0, -50);
  await page.mouse.move(hoverTrack.x, hoverTrack.y);
  await page.keyboard.press('d');
  assert.equal(
    await page.evaluate(() => window.hoverDWasTransient),
    true,
    'Real hover-D executes immediately after wheel zoom, before native idle rebase.',
  );
  assert.deepEqual(
    await page.evaluate(() => window.layoutContext().connectedTrackDrag?.trackIds),
    [hoverTrack.id],
    'A same-position hover retains exact keyboard pickup after zoom.',
  );
  await canvas.press('Escape');
  await canvas.press('Escape');
  await page.mouse.wheel(0, 50);
  await canvas.evaluate(
    (svg, point) =>
      svg.dispatchEvent(
        new PointerEvent('pointerout', {
          bubbles: true,
          clientX: point.x,
          clientY: point.y,
          relatedTarget: svg.parentElement,
        }),
      ),
    hoverTrack,
  );
  await page.keyboard.press('d');
  assert.deepEqual(
    await page.evaluate(() => window.layoutContext().connectedTrackDrag?.trackIds),
    [hoverTrack.id],
    'A border-box leave inside the actual drawing viewport retains hover.',
  );
  await canvas.press('Escape');
  await canvas.press('Escape');
  const outsideHover = await page.locator('.layout-canvas').boundingBox();
  await page.mouse.move(
    outsideHover.x + outsideHover.width + 10,
    outsideHover.y + outsideHover.height / 2,
  );
  await canvas.press('d');
  assert.equal(
    await page.evaluate(() => window.layoutContext().connectedTrackDrag),
    null,
    'Leaving the actual viewport for the dock cannot pick a stale hovered track.',
  );
  await canvas.press('Escape');
  // Reveal real copper beyond the transient SVG's shrunken CSS border box.
  // Native mouse input must still reach the editor and flush exact picking.
  await canvas.press('Home');
  await nextFrame();
  const edgeTrack = await canvas.evaluate((svg) => {
    const id = '55e76c6c-a882-41a3-85b9-455b1a2d200e';
    const line = svg.querySelector(`[data-selection-id="${id}"] [data-layout-track-target]`);
    const point = new DOMPoint(
      (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2,
      (Number(line.getAttribute('y1')) + Number(line.getAttribute('y2'))) / 2,
    ).matrixTransform(svg.getScreenCTM());
    const bounds = svg.parentElement.getBoundingClientRect();
    return {
      id,
      y: point.y,
      dx: bounds.right + 25 - point.x,
      x: bounds.x + bounds.width / 2,
      panY: bounds.y + bounds.height / 2,
    };
  });
  await page.mouse.move(edgeTrack.x, edgeTrack.panY);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(edgeTrack.x + edgeTrack.dx, edgeTrack.panY);
  await page.mouse.up({ button: 'middle' });
  await nextFrame();
  await waitForAsync(
    page,
    () =>
      !document
        .querySelector('[data-testid="layout-canvas"]')
        .hasAttribute('data-layout-camera-view'),
    undefined,
    { timeout: 5000, polling: 10 },
  );
  const edgePoint = await canvas.evaluate(async (svg, track) => {
    const frame = svg.parentElement.getBoundingClientRect();
    const wheelAt = performance.now();
    svg.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: Math.floor(frame.left + 1),
        clientY: Math.floor(track.y),
        deltaY: 50,
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const line = svg.querySelector(`[data-selection-id="${track.id}"] [data-layout-track-target]`);
    const point = new DOMPoint(
      (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2,
      (Number(line.getAttribute('y1')) + Number(line.getAttribute('y2'))) / 2,
    ).matrixTransform(svg.getScreenCTM());
    const transientBox = svg.getBoundingClientRect();
    svg.addEventListener(
      'pointerdown',
      () => {
        window.edgePickWasTransient = svg.hasAttribute('data-layout-camera-view');
      },
      { capture: true, once: true },
    );
    return {
      x: point.x,
      y: point.y,
      transient: svg.hasAttribute('data-layout-camera-view'),
      sinceWheelMs: performance.now() - wheelAt,
      rootRight: transientBox.right,
      viewportRight: frame.right,
      outsideRoot: point.x > transientBox.right + 1,
      insideViewport: point.x < frame.right - 1 && point.y > frame.top && point.y < frame.bottom,
    };
  }, edgeTrack);
  console.log(JSON.stringify({ overflowPresentation: edgePoint }));
  assert.equal(
    edgePoint.transient,
    true,
    'Overflow geometry is observed before native idle rebase.',
  );
  assert.ok(
    edgePoint.sinceWheelMs < 120,
    'Overflow geometry is observed inside the 120 ms transient interval.',
  );
  assert.equal(
    edgePoint.outsideRoot && edgePoint.insideViewport,
    true,
    'The real EMC target is visible through SVG overflow beyond its transient border box.',
  );
  await page.mouse.click(edgePoint.x, edgePoint.y);
  assert.equal(
    await page.evaluate(() => window.edgePickWasTransient),
    true,
    'A real pointer reaches visible overflow before idle rebase.',
  );
  assert.deepEqual(
    await page.evaluate(() => window.layoutContext().selection),
    [{ kind: 'track', id: edgeTrack.id }],
    'Immediate overflow picking selects the exact native track.',
  );
  assert.equal(
    await canvas.getAttribute('data-layout-camera-view'),
    null,
    'Actual picking flushes native camera geometry.',
  );
  assert.equal(
    await page.evaluate(() => window.commits),
    0,
    'Navigation and picking never commit PCB data.',
  );
  await canvas.press('Escape');
  await runCanvasAction(page, 'Fit board to canvas');
  await nextFrame();
  const heldPanLifecycles = [];
  for (const finish of ['release', 'cancel', 'lostcapture', 'blur', 'deactivate', 'rebind']) {
    if (finish === 'blur') {
      const anchor = await canvas.evaluate((svg, id) => {
        const line = svg.querySelector(`[data-selection-id="${id}"] [data-layout-track-target]`);
        const point = new DOMPoint(
          Number(line.getAttribute('x1')),
          Number(line.getAttribute('y1')),
        ).matrixTransform(svg.getScreenCTM());
        return { x: point.x, y: point.y };
      }, edgeTrack.id);
      await page.mouse.move(anchor.x, anchor.y);
      await canvas.press('x');
      await waitForAsync(page, () => Boolean(document.querySelector('[data-route-preview]')));
    }
    const position = await canvas.evaluate((svg) => {
      svg.addEventListener(
        'pointerdown',
        (event) => {
          window.heldPanPointer = event.pointerId;
        },
        { capture: true, once: true },
      );
      const rect = svg.parentElement.getBoundingClientRect();
      return { x: rect.left + rect.width * 0.46, y: rect.top + rect.height * 0.52 };
    });
    await page.mouse.move(position.x, position.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(position.x + 12, position.y + 8);
    await nextFrame();
    await page.waitForTimeout(160);
    assert.notEqual(
      await canvas.getAttribute('data-layout-camera-view'),
      null,
      `A real held pan remains in the compositor beyond idle before ${finish}.`,
    );
    if (finish === 'rebind') {
      await page.evaluate(() => window.replaceLayoutCameraContext());
      await nextFrame();
      assert.equal(
        await canvas.getAttribute('data-layout-camera-view'),
        null,
        'A binding replacement settles its old held camera before drawing.',
      );
      await page.mouse.move(position.x + 19, position.y + 11);
      await nextFrame();
      await page.waitForTimeout(160);
      assert.notEqual(
        await canvas.getAttribute('data-layout-camera-view'),
        null,
        'The still-captured pointer receives a valid lease from its new binding.',
      );
    }
    if (finish === 'release' || finish === 'rebind') {
      await page.mouse.up({ button: 'middle' });
    } else if (finish === 'cancel') {
      await canvas.evaluate((svg) =>
        svg.dispatchEvent(
          new PointerEvent('pointercancel', {
            bubbles: true,
            pointerId: window.heldPanPointer,
            pointerType: 'mouse',
          }),
        ),
      );
    } else if (finish === 'lostcapture') {
      await canvas.evaluate((svg) => svg.releasePointerCapture(window.heldPanPointer));
      await page.mouse.move(position.x + 13, position.y + 9);
    } else if (finish === 'blur') {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    } else {
      await page.evaluate(() => window.setLayoutVisible(false));
    }
    await nextFrame();
    assert.equal(
      await canvas.getAttribute('data-layout-camera-view'),
      null,
      `${finish} consumes the latest pose and restores the native camera.`,
    );
    if (finish === 'blur') {
      assert.equal(
        await canvas.locator('[data-route-preview]').count(),
        1,
        'Pan blur retains an unrelated in-progress route draft.',
      );
      assert.equal(await page.evaluate(() => window.layoutContext().tool), 'route');
    }
    if (finish !== 'release' && finish !== 'rebind') await page.mouse.up({ button: 'middle' });
    if (finish === 'deactivate') {
      await page.evaluate(() => window.setLayoutVisible(true));
      await canvas.waitFor({ state: 'visible' });
      await nextFrame();
    }
    assert.equal(
      await canvas.evaluate((svg) => svg.parentElement.classList.contains('is-panning')),
      false,
      `${finish} clears only the completed pointer pan state.`,
    );
    heldPanLifecycles.push(finish);
    // The blur case intentionally retains routing. Exit that draft before V,
    // which otherwise requests a via and leaks route previews into the next case.
    await canvas.press('Escape');
    await canvas.press('v');
    await nextFrame();
    assert.equal(await page.evaluate(() => window.layoutContext().tool), 'select');
    await runCanvasAction(page, 'Fit board to canvas');
    await nextFrame();
  }
  assert.equal(
    await page.evaluate(() => window.commits),
    0,
    'Held pan lifecycle changes remain presentation-only.',
  );
  const work = () => page.evaluate(() => structuredClone(window.layoutWork));
  const before = await work();
  const rectangle = await canvas.boundingBox();
  let at;
  for (let index = 0; index < 16; index++) {
    at = { x: rectangle.x + 30 + index * 17, y: rectangle.y + rectangle.height / 2 };
    await page.mouse.move(at.x, at.y);
    await nextFrame();
  }
  assert.deepEqual(
    await work(),
    before,
    'Idle pointer motion only renders the coordinate readout.',
  );
  const expectedCoordinates = await canvas.evaluate((svg, at) => {
    const point = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM().inverse());
    const snap = (n) => Number((Math.round(n / 0.5) * 0.5).toFixed(4));
    return `X ${snap(point.x).toFixed(2)} Y ${snap(point.y).toFixed(2)} mm`;
  }, at);
  assert.equal(
    (await page.locator('.status-coordinate').innerText()).split(' · ')[0],
    expectedCoordinates,
  );

  const originalView = await currentView();
  await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(
    rectangle.x + rectangle.width / 2 + 50,
    rectangle.y + rectangle.height / 2 + 25,
    { steps: 12 },
  );
  await page.mouse.up({ button: 'middle' });
  await nextFrame();
  assert.notEqual(await currentView(), originalView, 'Pan moves the camera.');
  const panned = await work();
  assert.equal(
    panned.footprints,
    before.footprints,
    'Pan retains footprint artwork and pad captions.',
  );
  assert.equal(panned.paint, before.paint, 'Pan retains the copper, via and graphic drawing tree.');
  assert.equal(
    panned.cameraScaleRenders,
    before.cameraScaleRenders,
    'Pure pan does not render scale-only overlays.',
  );
  assert.equal(panned.cameraBindings, before.cameraBindings, 'Pan retains its bound DOM targets.');
  assert.equal(
    await page.locator('.layout-canvas').evaluate((el) => el.classList.contains('is-panning')),
    false,
    'Pointer release clears the pan cursor without a parent render.',
  );
  assert.equal(
    panned.appearance,
    before.appearance,
    'Pan retains the unchanged Appearance controls.',
  );

  for (let index = 0; index < 3; index++) {
    await wheelZoom('in');
    await wheelZoom('out');
  }
  await nextFrame();
  const zoomed = await work();
  assert.equal(zoomed.renders, before.renders, 'Pan and zoom do not render the board editor.');
  assert.equal(zoomed.paths, before.paths, 'Zoom reuses saved copper SVG paths.');
  assert.equal(
    zoomed.appearance,
    before.appearance,
    'Zoom retains the unchanged Appearance controls.',
  );
  assert.equal(
    zoomed.footprints,
    before.footprints,
    'Zoom retains footprint artwork and pad captions.',
  );
  assert.equal(zoomed.bounds, before.bounds, 'Zoom reuses footprint body geometry.');
  assert.equal(
    zoomed.cameraBindings,
    before.cameraBindings,
    'Zoom does not rescan the drawing targets.',
  );

  await wheelZoom('in');
  await nextFrame();
  await canvas.evaluate((svg) => window.flushLayoutCamera(svg));
  const cameraGeometry = await canvas.evaluate((svg) => {
    const [x, y, width, height] = svg.getAttribute('viewBox').split(' ').map(Number);
    const scale = width / svg.getBoundingClientRect().width;
    const track = svg.querySelector('[data-layout-track-target]');
    const via = svg.querySelector('[data-layout-via-target]');
    const body = svg.querySelector('[data-layout-body-bounds]');
    const bounds = body.dataset.layoutBodyBounds.split(' ').map(Number);
    return {
      viewport: { x, y, width, height },
      observed: window.layoutContext().viewport,
      track: Number(track.getAttribute('stroke-width')),
      trackExpected:
        track.dataset.layoutFixedTrack === 'true'
          ? 7
          : Math.max(Number(track.dataset.layoutTrackTarget), scale * 7),
      via: Number(via.getAttribute('r')),
      viaExpected: Math.max(Number(via.dataset.layoutViaTarget), scale * 4),
      bodyX: Number(body.getAttribute('x')),
      bodyExpectedX: bounds[0] - (body.dataset.layoutFixedBody === 'true' ? 0.5 : scale * 2),
      fixed: track.dataset.layoutFixedTrack === 'true' && body.dataset.layoutFixedBody === 'true',
    };
  });
  assert.deepEqual(
    cameraGeometry.observed,
    cameraGeometry.viewport,
    'Agent context observes the current camera without an editor render.',
  );
  assert.equal(
    cameraGeometry.track,
    cameraGeometry.trackExpected,
    'Zoom retains exact track hit padding.',
  );
  assert.equal(cameraGeometry.fixed, true, 'Real EMC camera uses fixed screen hit targets.');
  assert.equal(
    cameraGeometry.via,
    cameraGeometry.viaExpected,
    'Zoom retains exact via hit padding.',
  );
  assert.equal(
    cameraGeometry.bodyX,
    cameraGeometry.bodyExpectedX,
    'Zoom retains exact footprint hit padding.',
  );
  assert.equal(
    await page.locator('.zoom-controls').count(),
    0,
    'Layout camera navigation has no floating zoom controls.',
  );
  assert.equal(
    (await work()).renders,
    before.renders,
    'Camera updates never render the board editor.',
  );
  const beforeCameraReplay = await work();
  const currentCameraBox = await currentView();
  const cameraFrames = () =>
    canvas.evaluate((svg) =>
      [
        ...svg.querySelectorAll(
          '[data-layout-background], [data-layout-grid], [data-layout-interaction-surface]',
        ),
      ].map((node) =>
        ['x', 'y', 'width', 'height'].map((name) => node.getAttribute(name)).join(' '),
      ),
    );
  const currentCameraFrames = await cameraFrames();
  await page.evaluate((oldBox) => {
    window.replayCameraCommit = () => {
      delete window.replayCameraCommit;
      const svg = document.querySelector('[data-testid="layout-canvas"]');
      const [x, y, width, height] = oldBox.split(' ');
      svg.setAttribute('viewBox', oldBox);
      for (const node of svg.querySelectorAll(
        '[data-layout-background], [data-layout-grid], [data-layout-interaction-surface]',
      ))
        for (const [name, value] of Object.entries({ x, y, width, height }))
          node.setAttribute(name, value);
    };
    window.commitCameraReplay();
  }, originalView);
  await nextFrame();
  assert.equal(
    await currentView(),
    currentCameraBox,
    'An unrelated commit restores the latest camera after stale viewport props.',
  );
  assert.deepEqual(
    await cameraFrames(),
    currentCameraFrames,
    'The same commit restores the retained clipped background/grid/interaction reserve.',
  );
  assert.equal(
    (await work()).cameraBindings,
    beforeCameraReplay.cameraBindings,
    'Camera commit recovery retains its exact bound targets.',
  );

  const savedFillPaths = () =>
    canvas
      .locator('[data-copper-fill] > path')
      .evaluateAll((paths) => paths.map((path) => path.getAttribute('d')).filter(Boolean));
  const originalFills = await savedFillPaths();
  assert.ok(
    originalFills.some((path) => path?.length > 100),
    'The EMC board has real saved pours.',
  );
  const vbus = project.pcb.tracks.find(
    (track) => track.id === '55e76c6c-a882-41a3-85b9-455b1a2d200e',
  );
  const dragOrigin = { x: (vbus.start.x + vbus.end.x) / 2, y: vbus.start.y };
  const moveTrackCursor = async (delta) => {
    const point = await canvas.evaluate(
      (svg, point) => {
        const mapped = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM());
        return { x: mapped.x, y: mapped.y };
      },
      { x: dragOrigin.x, y: dragOrigin.y + delta },
    );
    // The native pickup is off-grid. Bypass snapping for these exact poses so
    // returning to delta zero is a real no-op rather than a nearby grid point.
    await page.keyboard.down('Control');
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await page.keyboard.up('Control');
    await nextFrame();
  };
  await moveTrackCursor(0);
  const beforeDragAppearanceBody = (await work()).appearanceBodies;
  await canvas.press('d');
  await nextFrame();
  assert.deepEqual(await savedFillPaths(), originalFills, 'An unmoved pickup retains saved pours.');
  await page.evaluate(() => {
    window.previewBatchFrames = { ...window.batchFrames };
  });
  await moveTrackCursor(0.5);
  const previewBatchRetention = await page.evaluate(() => {
    let retained = 0,
      changed = 0;
    for (const [scope, current] of Object.entries(window.batchFrames)) {
      const before = window.previewBatchFrames[scope];
      if (!before || scope.startsWith('replay:')) continue;
      for (let index = 0; index < current.batches.length; index++) {
        const a = before.children.slice(index * 32, index * 32 + 32),
          b = current.children.slice(index * 32, index * 32 + 32);
        const equal = a.length === b.length && a.every((child, j) => child === b[j]);
        if (equal) {
          if (before.batches[index] !== current.batches[index])
            throw new Error('An unchanged preview batch was rebuilt.');
          retained++;
        } else {
          if (before.batches[index] === current.batches[index])
            throw new Error('A changed preview batch stayed stale.');
          changed++;
        }
      }
    }
    return { retained, changed };
  });
  assert.ok(
    previewBatchRetention.retained > 0,
    'An actual connected-track preview retains unrelated EMC batches.',
  );
  assert.ok(
    previewBatchRetention.changed > 0,
    'An actual preview refreshes exact changed batch children.',
  );
  const beforePreviewPan = await work();
  const previewGeometry = () =>
    canvas
      .locator('[data-layout-track-target]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ['x1', 'y1', 'x2', 'y2'].map((name) => node.getAttribute(name))),
      );
  const beforePreviewPanGeometry = await previewGeometry();
  const beforePreviewPanView = await currentView();
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(
    rectangle.x + rectangle.width / 2 + 25,
    rectangle.y + rectangle.height / 2 + 15,
    { steps: 4 },
  );
  await page.mouse.up({ button: 'middle' });
  await nextFrame();
  assert.notEqual(
    await currentView(),
    beforePreviewPanView,
    'An active D preview permits camera panning.',
  );
  assert.deepEqual(
    await previewGeometry(),
    beforePreviewPanGeometry,
    'Panning retains the complete exact connected-track world preview.',
  );
  assert.equal(
    (await work()).renders,
    beforePreviewPan.renders,
    'Panning an active preview does not render the board editor.',
  );
  assert.equal(
    (await work()).cameraScaleRenders,
    beforePreviewPan.cameraScaleRenders,
    'Panning an active preview does not render scale overlays.',
  );
  const movedFillWork = await work();
  for (const delta of [0, -0.5, 0, 0.5, 0]) {
    await moveTrackCursor(delta);
    assert.deepEqual(
      await savedFillPaths(),
      originalFills,
      'Origin crossings retain saved fill paths while conservative masks follow the current drag.',
    );
    if (delta !== 0)
      assert.ok(
        (await canvas.locator('[data-copper-fill] mask path[fill="black"]').count()) > 0,
        'A moved pose masks its current changed-copper clearance.',
      );
  }
  assert.equal(
    (await work()).paths,
    movedFillWork.paths,
    'Origin crossings never regenerate saved copper paths.',
  );
  // CDP round-tripping through screen coordinates can leave a subpixel delta
  // from the exact native pickup. Exercise the no-op without another move.
  await canvas.press('Escape');
  await moveTrackCursor(0);
  await canvas.press('d');
  await nextFrame();
  await canvas.press('Enter');
  await nextFrame();
  assert.deepEqual(
    await savedFillPaths(),
    originalFills,
    'Placing an unmoved pickup retains exact saved pours.',
  );
  assert.equal(
    (await work()).paths,
    movedFillWork.paths,
    'A no-op placement reuses the original copper path cache.',
  );
  assert.equal(
    await page.evaluate(() => window.commits),
    0,
    'An unmoved pickup creates no design transaction.',
  );
  assert.equal(
    (await work()).appearanceBodies,
    beforeDragAppearanceBody,
    'Inspector hide/reveal during a drag retains Appearance controls.',
  );
  await canvas.press('Escape');
  await moveTrackCursor(0);
  await canvas.press('d');
  await moveTrackCursor(0.5);
  await canvas.press('Escape');
  await canvas.press('Escape');
  await nextFrame();
  assert.deepEqual(await savedFillPaths(), originalFills, 'Cancelling restores exact saved pours.');
  assert.deepEqual(await page.evaluate(() => window.layoutBoard), project.pcb);

  const beforeLayerToggle = await work();
  await toggleLayoutVisualization(page, 'Visible layers');
  await page.evaluate(() => {
    window.beforeLayerSelection = window.layoutContext().selection;
  });
  await page.getByRole('checkbox', { name: 'F.SilkS', exact: true }).uncheck();
  await toggleLayoutVisualization(page, 'Visible layers');
  await nextFrame();
  const hiddenLayer = await work();
  assert.equal(
    await page.evaluate(() => window.beforeLayerSelection === window.layoutContext().selection),
    true,
    'Layer pruning retains the selection array when no selected item becomes ineligible.',
  );
  assert.ok(hiddenLayer.bounds > zoomed.bounds, 'Layer changes invalidate footprint hit geometry.');
  assert.ok(
    hiddenLayer.footprints > zoomed.footprints,
    'Layer visibility invalidates footprint artwork.',
  );
  assert.equal(
    hiddenLayer.paths,
    beforeLayerToggle.paths,
    'Silkscreen visibility preserves copper paths.',
  );

  const coordinatesBeforeTool = (await page.locator('.status-coordinate').innerText()).split(
    ' · ',
  )[0];
  await page.getByRole('button', { name: 'Place through via', exact: true }).click();
  const via = canvas.locator('[data-annotation-overlay] > circle').first();
  const initialPreview = await via.evaluate((circle) => ({
    x: Number(circle.getAttribute('cx')),
    y: Number(circle.getAttribute('cy')),
  }));
  assert.equal(
    `X ${initialPreview.x.toFixed(2)} Y ${initialPreview.y.toFixed(2)} mm`,
    coordinatesBeforeTool,
    'Tool activation picks up the latest idle pointer position.',
  );
  at = { x: rectangle.x + rectangle.width * 0.6, y: rectangle.y + rectangle.height * 0.6 };
  await page.mouse.move(at.x, at.y);
  await nextFrame();
  const preview = await via.evaluate((circle) => ({
    x: Number(circle.getAttribute('cx')),
    y: Number(circle.getAttribute('cy')),
  }));
  assert.equal(
    (await page.locator('.status-coordinate').innerText()).split(' · ')[0],
    `X ${preview.x.toFixed(2)} Y ${preview.y.toFixed(2)} mm`,
    'Active tools keep their preview and coordinate readout together.',
  );
  await canvas.press('Escape');
  assert.equal(await canvas.locator('[data-annotation-overlay] > circle').count(), 0);
  assert.deepEqual(
    await page.evaluate(() => window.layoutBoard),
    project.pcb,
    'Hover, navigation, layer visibility and cancelled tools preserve the board.',
  );
  assert.equal(await page.evaluate(() => window.commits), 0);

  const beforePose = await work();
  await page.evaluate(() => window.changeSchematicPose());
  await nextFrame();
  const pose = await work();
  for (const name of ['footprints', 'boardRecords', 'paint', 'bounds', 'cameraHits', 'appearance'])
    assert.equal(pose[name], beforePose[name], `Schematic pose changes retain Layout ${name}.`);
  await page.evaluate(() => window.changeSchematicValue());
  await nextFrame();
  const caption = await work();
  assert.deepEqual(
    [...new Set(caption.footprintOwners.slice(pose.footprintOwners.length))],
    [await page.evaluate(() => window.captionFootprint.id)],
    'A value change refreshes only the linked owner across base and priority drawing passes.',
  );
  assert.equal(
    caption.boardRecords,
    pose.boardRecords,
    'Caption changes retain copper, vias and graphics.',
  );
  assert.equal(caption.cameraHits, pose.cameraHits, 'Caption changes retain exact hit geometry.');

  const beforeTrack = await work();
  await page.evaluate(() => {
    window.beforeTrackSelection = window.layoutContext().selection;
  });
  const trackViewport = await currentView();
  const originalTrackBoard = await page.evaluate(() => structuredClone(window.layoutBoard));
  const beforeTrackImage = await page.evaluate(() => window.captureLayout());
  await canvas.evaluate((svg) => {
    window.trackDOMBefore = [...svg.querySelectorAll('[data-layout-track-target]')];
    window.trackOrderBefore = window.trackDOMBefore.map(
      (node) => node.parentElement.dataset.selectionId,
    );
    window.trackElementCountBefore = svg.querySelectorAll('*').length;
  });
  await page.evaluate(() => window.changeLayoutTrack());
  await nextFrame();
  const trackEdit = await work();
  assert.equal(
    trackEdit.cameraBindings,
    beforeTrack.cameraBindings,
    'An owned coordinate-only track edit retains the committed camera target packet and compositor binding.',
  );
  assert.equal(
    trackEdit.trackRefreshes,
    beforeTrack.trackRefreshes,
    'A coordinate-only edit needs no track target metadata refresh.',
  );
  assert.equal(
    trackEdit.renders - beforeTrack.renders,
    1,
    'A track edit needs only one Layout render; selection pruning does not schedule another.',
  );
  assert.equal(
    await page.evaluate(() => window.beforeTrackSelection === window.layoutContext().selection),
    true,
    'Board pruning retains the exact selection array when all selected records survive.',
  );
  assert.equal(
    trackEdit.trackElements - beforeTrack.trackElements,
    1,
    'One immutable track edit creates only that track JSX element.',
  );
  assert.equal(
    trackEdit.trackBatches - beforeTrack.trackBatches,
    1,
    'One immutable track edit rebuilds only its32track Fragment batch.',
  );
  assert.deepEqual(
    await canvas.evaluate((svg) => {
      const nodes = [...svg.querySelectorAll('[data-layout-track-target]')];
      return {
        sameNodes: nodes.every((node, index) => node === window.trackDOMBefore[index]),
        sameOrder: nodes.every(
          (node, index) =>
            node.parentElement.dataset.selectionId === window.trackOrderBefore[index],
        ),
        sameElementCount: svg.querySelectorAll('*').length === window.trackElementCountBefore,
      };
    }),
    { sameNodes: true, sameOrder: true, sameElementCount: true },
    'Retained Fragments add no SVG nodes and preserve the actual DOM, paint order and hit targets.',
  );
  assert.equal(
    trackEdit.elements - beforeTrack.elements,
    1,
    'A track-only edit retains every unchanged copper, zone and detail JSX element.',
  );
  for (const name of [
    'footprintElements',
    'viaElements',
    'graphicElements',
    'footprints',
    'bounds',
    'bodyTargets',
    'appearance',
    'footprintTrees',
    'captionTrees',
    'viaTrees',
    'graphicTrees',
  ])
    assert.equal(trackEdit[name], beforeTrack[name], `Track-only edits retain unrelated ${name}.`);
  const currentTrack = await canvas.evaluate((svg) => {
    const track = window.layoutBoard.tracks.find((track) => track.id === window.editedTrackId);
    const line = svg.querySelector(
      '[data-selection-id="' + track.id + '"] [data-layout-track-target]',
    );
    return {
      actual: [
        line.getAttribute('x1'),
        line.getAttribute('y1'),
        line.getAttribute('x2'),
        line.getAttribute('y2'),
      ].map(Number),
      expected: [track.start.x, track.start.y, track.end.x, track.end.y],
      context: window.layoutContext().viewport,
    };
  });
  assert.deepEqual(
    currentTrack.actual,
    currentTrack.expected,
    'The retained tree displays current track endpoint geometry.',
  );
  assert.equal(await currentView(), trackViewport, 'Track-only edits preserve the camera.');
  assert.deepEqual(
    currentTrack.context,
    Object.fromEntries(
      ['x', 'y', 'width', 'height'].map((key, index) => [
        key,
        trackViewport.split(' ').map(Number)[index],
      ]),
    ),
  );
  const trackImage = await page.evaluate(() => window.captureLayout());
  assert.equal(trackImage.width, beforeTrackImage.width);
  assert.equal(trackImage.height, beforeTrackImage.height);
  assert.notEqual(
    trackImage.dataUrl,
    beforeTrackImage.dataUrl,
    'Clean PNG export reflects the changed track geometry.',
  );
  assert.deepEqual(
    await page.evaluate(() => window.layoutBoard.footprints),
    originalTrackBoard.footprints,
  );

  await page.evaluate(() => {
    window.beforeCameraTargetEdits = window.layoutBoard;
  });
  const beforeWidth = await work();
  await page.evaluate(() => window.changeCameraTrackWidth());
  await nextFrame();
  const widthWork = await work();
  assert.equal(
    widthWork.cameraBindings - beforeWidth.cameraBindings,
    0,
    'A changed native track width retains the complete camera binding.',
  );
  assert.equal(
    widthWork.trackRefreshes - beforeWidth.trackRefreshes,
    1,
    'A changed native track width invokes one committed track target refresh.',
  );
  assert.equal(
    await canvas.evaluate((svg) => {
      const track = window.layoutBoard.tracks.find((track) => track.id === window.editedTrackId);
      const target = svg.querySelector(
        `[data-selection-id="${track.id}"] [data-layout-track-target]`,
      );
      const visible = target?.parentElement.querySelector('line:not([data-layout-track-target])');
      return (
        target === window.trackDOMBefore[window.trackOrderBefore.indexOf(track.id)] &&
        Number(target.getAttribute('data-layout-track-target')) === track.width &&
        target.getAttribute('data-layout-fixed-track') === 'true' &&
        target.getAttribute('stroke-width') === '7' &&
        Number(visible?.getAttribute('stroke-width')) === track.width
      );
    }),
    true,
    'The retained hit node and visible copper use the new native width with current camera padding.',
  );
  await page.evaluate(() => window.appendCameraTrack());
  await nextFrame();
  const appendedWork = await work();
  assert.equal(
    appendedWork.cameraBindings - widthWork.cameraBindings,
    0,
    'A new track ID retains the complete camera binding.',
  );
  assert.equal(
    appendedWork.trackRefreshes - widthWork.trackRefreshes,
    1,
    'A new track ID invokes one refresh for the newly committed hit node.',
  );
  assert.equal(
    await canvas.evaluate((svg) => {
      const target = svg.querySelector(
        `[data-selection-id="${window.appendedCameraTrackId}"] [data-layout-track-target]`,
      );
      return (
        target?.getAttribute('data-layout-fixed-track') === 'true' &&
        target.getAttribute('stroke-width') === '7'
      );
    }),
    true,
    'A newly inserted actual DOM hit target receives current camera padding.',
  );
  await page.evaluate(() => {
    window.replaceLayoutBoard(window.beforeCameraTargetEdits);
    delete window.beforeCameraTargetEdits;
  });
  await nextFrame();
  await openVisualization(page);
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  await canvas.evaluate((svg) => {
    window.beforePriorityTrack = svg.querySelector(
      '[data-selection-id="55e76c6c-a882-41a3-85b9-455b1a2d200e"] [data-layout-track-target]',
    );
  });
  const beforePriority = await work();
  await page.getByRole('button', { name: 'B.Cu', exact: true }).click();
  await nextFrame();
  assert.equal(
    (await work()).cameraBindings - beforePriority.cameraBindings,
    1,
    'Changing the prioritized complete layer pass creates one fresh camera binding.',
  );
  assert.equal(
    await canvas.evaluate((svg) => {
      const target = svg.querySelector(
        '[data-selection-id="55e76c6c-a882-41a3-85b9-455b1a2d200e"] [data-layout-track-target]',
      );
      return (
        target === window.beforePriorityTrack &&
        target.getAttribute('data-layout-fixed-track') === 'true' &&
        target.getAttribute('stroke-width') === '7'
      );
    }),
    true,
    'Reordering complete layer passes retains the copper target with current camera padding.',
  );
  await page.getByRole('button', { name: 'F.Cu', exact: true }).click();
  await nextFrame();

  // Revealed Nets and canvas fit actions must use the latest board geometry.
  const fitBasis = await page.evaluate(() => structuredClone(window.layoutBoard));
  await page.evaluate(() => window.extendTrackFar());
  await nextFrame();
  await openVisualization(page);
  await page.getByRole('tab', { name: 'Nets', exact: true }).click();
  await nextFrame();
  assert.ok((await page.evaluate(() => window.expectedNetEdgeCount())) > 0);
  assert.equal(
    await page
      .locator('.layout-net-count')
      .evaluateAll((counts) =>
        counts.reduce((total, count) => total + Number(count.textContent), 0),
      ),
    await page.evaluate(() => window.expectedNetEdgeCount()),
    'Revealing Nets reads the current board connectivity.',
  );
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  await canvas.press('ControlOrMeta+Home');
  await nextFrame();
  const fittedFarTrack = await canvas.evaluate((svg) => {
    const view = svg.getAttribute('viewBox').split(' ').map(Number);
    const end = window.layoutBoard.tracks[0].end;
    return end.x > view[0] && end.x < view[0] + view[2];
  });
  assert.ok(fittedFarTrack, 'The canvas Fit action uses the latest changed board.');
  await page.evaluate((basis) => window.replaceLayoutBoard(basis), fitBasis);
  await runCanvasAction(page, 'Fit board to canvas');
  await nextFrame();

  const beforeEdit = await work();
  await page.evaluate(() => window.changeLayoutBoard());
  await nextFrame();
  const edited = await work();
  assert.ok(edited.bounds > beforeEdit.bounds, 'Document previews invalidate body geometry.');
  assert.deepEqual(
    [...new Set(edited.footprintOwners.slice(beforeEdit.footprintOwners.length))],
    [await page.evaluate(() => window.layoutBoard.footprints[0].id)],
    'A footprint edit rebuilds only its own base and priority artwork and captions.',
  );
  assert.ok(edited.paths > beforeEdit.paths, 'Document previews invalidate copper paths.');
  await page.evaluate(() => window.setLayoutVisible(false));
  await nextFrame();
  const hiddenWork = await work();
  const hiddenWheel = await canvas.evaluate(async (svg) => {
    const before = svg.getAttribute('viewBox');
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -50 });
    svg.dispatchEvent(event);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { prevented: event.defaultPrevented, unchanged: svg.getAttribute('viewBox') === before };
  });
  assert.deepEqual(
    hiddenWheel,
    { prevented: false, unchanged: true },
    'Hidden Layout releases its native wheel listener.',
  );
  assert.equal(
    await page.evaluate(() => window.layoutContext()),
    null,
    'Hidden Layout does not expose stale presentation context.',
  );
  await page.evaluate(() => {
    window.changeLayoutBoard();
    window.changeHiddenSchematic();
  });
  await nextFrame();
  assert.deepEqual(
    await work(),
    hiddenWork,
    'Hidden Layout defers board, schematic and callback updates.',
  );
  await page.evaluate(() => window.setLayoutVisible(true));
  await nextFrame();
  const revealed = await canvas.evaluate((svg) => {
    const footprint = window.layoutBoard.footprints[0];
    return {
      transform: svg
        .querySelector('[data-footprint-body="' + footprint.id + '"]')
        .getAttribute('transform'),
      expected:
        'translate(' + footprint.x + ' ' + footprint.y + ') rotate(' + -footprint.rotation + ')',
      reference: svg
        .querySelector('[data-selection-id="' + window.captionFootprint.id + '"] [data-pad-id]')
        .getAttribute('aria-label'),
      context: window.layoutContext(),
    };
  });
  assert.equal(revealed.transform, revealed.expected, 'Reveal applies the latest board position.');
  assert.ok(
    revealed.reference.includes('HIDDENLATEST'),
    'Reveal applies the latest schematic fields.',
  );
  assert.equal(
    revealed.context.boardId,
    project.pcb.id,
    'Revealing Layout restores current presentation context.',
  );
  const pickAt = await canvas.evaluate((svg) => {
    const frame = svg.getBoundingClientRect();
    for (const pad of svg.querySelectorAll('[data-pad-id]')) {
      const bounds = pad.getBoundingClientRect(),
        x = bounds.x + bounds.width / 2,
        y = bounds.y + bounds.height / 2;
      if (
        bounds.width > 0 &&
        bounds.height > 0 &&
        x > frame.left + 10 &&
        x < frame.right - 10 &&
        y > frame.top + 10 &&
        y < frame.bottom - 10
      )
        return {
          x,
          y,
          owner: pad.closest('[data-selection-id]').getAttribute('data-selection-id'),
        };
    }
  });
  assert.ok(pickAt, 'The real EMC board has a visible pad for pointer selection.');
  const beforePick = await work();
  const cursorBeforePick = await canvas.evaluate((svg) => getComputedStyle(svg).cursor);
  await page.mouse.move(pickAt.x, pickAt.y);
  await page.mouse.down();
  await nextFrame();
  const picked = await work();
  assert.equal(
    await canvas.evaluate((svg) => svg.parentElement.classList.contains('is-moving')),
    false,
    'Ordinary selection does not activate the inherited moving cursor.',
  );
  assert.equal(await canvas.evaluate((svg) => getComputedStyle(svg).cursor), cursorBeforePick);
  assert.equal(
    picked.bodyTargets,
    beforePick.bodyTargets,
    'Picking retains every footprint body target.',
  );
  assert.equal(
    picked.copperTrees,
    beforePick.copperTrees,
    'Picking retains the entire copper drawing tree.',
  );
  assert.equal(
    picked.detailTrees,
    beforePick.detailTrees,
    'Picking retains the entire footprint/detail drawing tree.',
  );
  assert.ok(
    picked.boardRecords - beforePick.boardRecords <= 4,
    'Picking redraws only affected copper or artwork records.',
  );
  assert.equal(
    picked.cameraHits,
    beforePick.cameraHits,
    'Selection paint retains the current camera hit targets.',
  );
  await page.mouse.up();
  await nextFrame();
  assert.equal(
    (await work()).boardRecords,
    picked.boardRecords,
    'Pointer release retains an unchanged selection drawing.',
  );
  await canvas.press('Escape');
  await nextFrame();
  const cleared = await work();
  assert.equal(
    cleared.bodyTargets,
    picked.bodyTargets,
    'Clearing selection retains every body target.',
  );
  assert.equal(
    cleared.copperTrees,
    picked.copperTrees,
    'Clearing selection retains the entire copper drawing tree.',
  );
  assert.equal(
    cleared.detailTrees,
    picked.detailTrees,
    'Clearing selection retains the entire footprint/detail drawing tree.',
  );
  assert.ok(
    cleared.boardRecords - picked.boardRecords <= 4,
    'Clearing selection redraws only affected records.',
  );
  assert.deepEqual(
    [...new Set(cleared.footprintOwners.slice(picked.footprintOwners.length))],
    [],
    'Clearing selection updates paint subscribers without rerendering footprint geometry.',
  );
  assert.equal(
    cleared.appearance,
    picked.appearance,
    'Clearing an empty net highlight retains Appearance controls.',
  );
  assert.equal(
    cleared.cameraHits,
    picked.cameraHits,
    'Clearing selection retains the camera hit targets.',
  );
  await canvas.press('Escape');
  await nextFrame();
  const clearedAgain = await work();
  assert.equal(
    clearedAgain.bodyTargets,
    cleared.bodyTargets,
    'Repeated clear retains body targets.',
  );
  assert.equal(
    clearedAgain.boardRecords,
    cleared.boardRecords,
    'Repeated clear retains drawing records.',
  );
  assert.equal(
    clearedAgain.footprints,
    cleared.footprints,
    'Repeated clear retains footprint artwork and captions.',
  );
  assert.equal(
    clearedAgain.appearance,
    cleared.appearance,
    'Repeated clear retains Appearance controls.',
  );
  assert.equal(
    await page.evaluate(() => window.commits),
    0,
    'Picking and clearing never edit the board.',
  );
  const previewBoard = await page.evaluate(() => structuredClone(window.layoutBoard));
  await page.mouse.move(pickAt.x, pickAt.y);
  await page.mouse.down();
  await nextFrame();
  assert.equal(
    await canvas.evaluate((svg) => svg.parentElement.classList.contains('is-moving')),
    false,
  );
  await page.mouse.move(pickAt.x + 24, pickAt.y + 18, { steps: 4 });
  await nextFrame();
  assert.equal(
    await canvas.evaluate((svg) => svg.parentElement.classList.contains('is-moving')),
    true,
    'A displaced pointer preview activates the moving cursor.',
  );
  await canvas.press('Escape');
  await page.mouse.up();
  await nextFrame();
  assert.equal(
    await canvas.evaluate((svg) => svg.parentElement.classList.contains('is-moving')),
    false,
  );
  await canvas.press('m');
  await nextFrame();
  assert.equal(
    await canvas.evaluate((svg) => svg.parentElement.classList.contains('is-moving')),
    true,
    'Explicit Move activates its cursor immediately.',
  );
  await canvas.press('Escape');
  await nextFrame();
  assert.equal(
    await page.evaluate(() => window.commits),
    0,
    'Cancelling motion and explicit Move preserves the document.',
  );
  assert.deepEqual(await page.evaluate(() => window.layoutBoard), previewBoard);

  await page.evaluate(() => window.mountReplay());
  const replay = page.getByTestId('layout-retention-replay');
  await replay.waitFor({ state: 'attached' });
  await nextFrame();
  assert.equal(await replay.locator('[data-layout-track-target]').count(), 65);
  await page.evaluate(() => {
    window.replayInitialBatches = [...window.replayBatches];
  });
  assert.equal(
    await page.evaluate(() => window.replayBatches.length),
    3,
    '65tracks span three32record batches.',
  );
  assert.equal(
    await page.evaluate(() =>
      window.replayBatches.every((batch) => Object.isFrozen(batch.props.children)),
    ),
    true,
    'Every cached Fragment owns its frozen ordered children.',
  );
  await page.evaluate(() => window.replayCallerArrays.forEach((children) => children.reverse()));
  assert.equal(
    await replay
      .locator('[data-layout-track-target]')
      .first()
      .evaluate((node) => node.parentElement.dataset.selectionId),
    'replay-0',
    'Mutating a caller presentation array cannot change cached Fragment child order.',
  );
  await page.evaluate(() => window.interruptReplay());
  await page.waitForFunction(() => window.replaySuspended > 0);
  assert.equal(
    await replay.locator('[data-layout-track-target]').count(),
    65,
    'An interrupted layer filter cannot remove committed tracks.',
  );
  assert.ok(
    (await replay.locator('title').allTextContents()).every((text) => text.includes('Committed')),
  );
  await page.evaluate(() => window.cancelReplay());
  await nextFrame();
  const beforeReplayRefresh = await work();
  await page.evaluate(() => window.refreshReplay());
  await nextFrame();
  assert.equal(
    (await work()).trackElements,
    beforeReplayRefresh.trackElements,
    'StrictMode and abandoned layer/filter props cannot poison retained track JSX.',
  );
  assert.equal(
    await page.evaluate(() =>
      window.replayBatches.every((batch, index) => batch === window.replayInitialBatches[index]),
    ),
    true,
    'Interrupted layer/filter work cannot poison committed batch identities.',
  );
  const replayOrder = () =>
    replay
      .locator('[data-layout-track-target]')
      .evaluateAll((nodes) => nodes.map((node) => node.parentElement.dataset.selectionId));
  assert.deepEqual(
    await replayOrder(),
    Array.from({ length: 65 }, (_, index) => 'replay-' + index),
  );
  const beforeReplaySelection = await work();
  await page.evaluate(() => window.selectReplay('replay-33'));
  await nextFrame();
  assert.equal(
    await replay.locator('[data-selection-id="replay-33"] [data-selection-only]').count(),
    1,
    'A selected record updates through an unchanged Fragment batch.',
  );
  assert.equal((await work()).trackElements, beforeReplaySelection.trackElements);
  assert.equal(
    await page.evaluate(() =>
      window.replayBatches.every((batch, index) => batch === window.replayInitialBatches[index]),
    ),
    true,
  );
  await page.evaluate(() => window.selectReplay(''));
  await nextFrame();
  await page.evaluate(() => window.editReplayTrack(33));
  await nextFrame();
  assert.deepEqual(
    await page.evaluate(() =>
      window.replayBatches.map((batch, index) => batch === window.replayInitialBatches[index]),
    ),
    [true, false, true],
    'A one-record preview changes only its exact middle batch.',
  );
  await page.evaluate(() => {
    window.replayBeforeAppend = [...window.replayBatches];
    window.appendReplay();
  });
  await nextFrame();
  assert.deepEqual(
    await page.evaluate(() =>
      window.replayBatches.map((batch, index) => batch === window.replayBeforeAppend[index]),
    ),
    [true, true, false],
  );
  assert.deepEqual(
    await replayOrder(),
    Array.from({ length: 66 }, (_, index) => 'replay-' + index),
  );
  await page.evaluate(() => window.removeReplay());
  await nextFrame();
  await page.evaluate(() => {
    window.replayBeforeRemove = [...window.replayBatches];
    window.removeReplay();
  });
  await nextFrame();
  assert.equal(await page.evaluate(() => window.replayBatches.length), 2);
  assert.equal(
    await page.evaluate(() =>
      window.replayBatches.every((batch, index) => batch === window.replayBeforeRemove[index]),
    ),
    true,
    'Removing the final batch retains every earlier batch.',
  );
  await page.evaluate(() => window.appendReplay());
  await nextFrame();
  await page.evaluate(() => {
    window.replayBeforeReorder = [...window.replayBatches];
    window.reorderReplay();
  });
  await nextFrame();
  assert.deepEqual(
    await page.evaluate(() =>
      window.replayBatches.map((batch, index) => batch === window.replayBeforeReorder[index]),
    ),
    [false, true, false],
    'Reordering exact children invalidates only batches whose ordered element identities differ.',
  );
  const reordered = [
    'replay-65',
    ...Array.from({ length: 63 }, (_, index) => 'replay-' + (index + 1)),
    'replay-0',
  ];
  assert.deepEqual(await replayOrder(), reordered);
  await page.evaluate(() => window.moveReplayLayer());
  await nextFrame();
  assert.deepEqual(
    await replayOrder(),
    reordered,
    'Layer migration preserves current layer/record paint order.',
  );
  assert.equal(
    await replay.locator('[data-replay-layer="B.Cu"] [data-layout-track-target]').count(),
    1,
  );
  await page.evaluate(() => {
    window.replayUnchangedLayerBatch = window.replayBatches[0];
  });
  await page.evaluate(() => window.toggleReplayLayer(false));
  await nextFrame();
  assert.equal(await replay.locator('[data-layout-track-target]').count(), 1);
  assert.equal(
    await page.evaluate(() => window.replayBatches[0] === window.replayUnchangedLayerBatch),
    true,
    'Hiding F.Cu retains the unchanged visible B.Cu batch.',
  );
  await page.evaluate(() => window.toggleReplayLayer(true));
  await nextFrame();
  assert.equal(
    await replay.locator('[data-layout-track-target]').count(),
    65,
    'Committed layer changes still hide and restore exact retained tracks.',
  );
  assert.equal(
    await page.evaluate(() => window.replayBatches[0] === window.replayUnchangedLayerBatch),
    true,
    'Revealing F.Cu leaves the visible B.Cu batch intact.',
  );
  assert.deepEqual(await replayOrder(), reordered);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      example: 'EMC Flyback',
      footprints: project.pcb.footprints.length,
      tracks: project.pcb.tracks.length,
      idlePointerEvents: 16,
      idleBoardRenders: 0,
      zoomActions: 6,
      panDrawingRebuilds: 0,
      zoomFootprintRenders: 0,
      zoomBodyRebuilds: 0,
      zoomCopperPathRebuilds: 0,
      trackEditElements: trackEdit.elements - beforeTrack.elements,
      trackEditBatches: trackEdit.trackBatches - beforeTrack.trackBatches,
      trackEditBoardRenders: trackEdit.renders - beforeTrack.renders,
      trackEditTargetRefreshes: trackEdit.trackRefreshes - beforeTrack.trackRefreshes,
      widthCameraBindings: widthWork.cameraBindings - beforeWidth.cameraBindings,
      widthTrackRefreshes: widthWork.trackRefreshes - beforeWidth.trackRefreshes,
      appendedCameraBindings: appendedWork.cameraBindings - widthWork.cameraBindings,
      appendedTrackRefreshes: appendedWork.trackRefreshes - widthWork.trackRefreshes,
      trackEditUnrelatedTrees: ['footprintTrees', 'captionTrees', 'viaTrees', 'graphicTrees'].map(
        (name) => trackEdit[name] - beforeTrack[name],
      ),
      trackEditFootprintElements: trackEdit.footprintElements - beforeTrack.footprintElements,
      trackEditBodyRebuilds: trackEdit.bounds - beforeTrack.bounds,
      originCrossingCopperPathRebuilds: 0,
      interruptedLayerReplay: 'passed',
      batchSelectionAppendRemoveReorder: 'passed',
      heldPanLifecycles,
    }),
  );
} finally {
  await browser.close();
}
