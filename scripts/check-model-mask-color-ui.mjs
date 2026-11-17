import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Pixel comparison of actual Three materials, isolated from Electron, files and services.
const bundle = await build({
  stdin: {
    contents: `
import * as THREE from 'three';
import { createModelSolderMaskSurface, createModelBoardDisplayGroups, defaultModelBoardDisplay, modelBoardDisplayColors } from './lib/model-board-display';
import { createModelExplodedView } from './lib/model-exploded-view';
import { createEmptyPCB } from './lib/pcb-layout';
window.checkMaskColors=()=>{
 const results=[];
 const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(160,160);renderer.setPixelRatio(1);document.body.append(renderer.domElement);
 for(const side of [1,-1])for(const background of [0xffffff,0x202020]){
  const scene=new THREE.Scene();scene.background=new THREE.Color(background);
  scene.add(new THREE.AmbientLight(0xffffff,2.5));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(50,-70,100);scene.add(light);
  const root=new THREE.Group();scene.add(root);const groups=createModelBoardDisplayGroups(root,defaultModelBoardDisplay());
  const shape=new THREE.Shape().moveTo(-5,-5).lineTo(5,-5).lineTo(5,5).lineTo(-5,5).closePath();
  const laminate=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:1.6,bevelEnabled:false}),new THREE.MeshStandardMaterial({color:modelBoardDisplayColors.substrate,roughness:.8}));laminate.position.z=-.8;groups.substrate.add(laminate);
  const mask=createModelSolderMaskSurface(new THREE.ShapeGeometry(shape));mask.position.z=side*.82;mask.userData.modelExplosionLayer=side>0?'F.Mask':'B.Mask';groups.mask.add(mask);
  const explosion=createModelExplodedView(createEmptyPCB(),new THREE.Group(),new THREE.Group(),groups);
  const camera=new THREE.OrthographicCamera(-7,7,7,-7,.1,1000);camera.position.set(0,0,side*100);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
  const sample=()=>{renderer.render(scene,camera);const color=new Uint8Array(4);const gl=renderer.getContext();gl.readPixels(90,90,1,1,gl.RGBA,gl.UNSIGNED_BYTE,color);return [...color];};
  explosion.apply({distance:0,direction:'vertical'},[]);const assembled=sample();
  explosion.apply({distance:3,direction:'vertical'},[]);groups.substrate.visible=false;const exploded=sample();
  explosion.apply({distance:0,direction:'vertical'},[]);groups.substrate.visible=true;const restored=sample();
  results.push({side,background,assembled,exploded,restored});
  root.traverse(object=>{if(object.isMesh){object.geometry.dispose();object.material.dispose();}});
 }
 renderer.dispose();return results;
};`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'browser',
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(() => window.checkMaskColors());
  for (const result of results) {
    for (const key of ['exploded', 'restored'])
      for (let channel = 0; channel < 4; channel++)
        assert.ok(
          Math.abs(result[key][channel] - result.assembled[channel]) <= 1,
          `Mask color changed on side ${result.side}: ${JSON.stringify(result)}`,
        );
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
  console.log(
    'Solder-mask pixel colors match assembled/exploded/restored on both sides and light/dark backgrounds.',
  );
} finally {
  await browser.close();
}
