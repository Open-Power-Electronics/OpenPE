import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Real Three/WebGL only: no Electron, destinations, providers, solver or network.
const bundle = await build({
  stdin: {
    contents: `
import * as THREE from 'three';
import {createProject,projectNativeFiles} from './lib/project';
import {createEmptyPCB} from './lib/pcb-layout';
import {uid} from './lib/circuit';
import {withModelCad} from './lib/model-cad';
import {modelCadMesh} from './components/model-cad-mesh';
import {disposeModelGroup} from './lib/model-mesh';

const check=(condition,message)=>{if(!condition)throw new Error(message);};
const project=createProject();project.pcb=createEmptyPCB();
project.pcb.graphics=[{id:uid(),kind:'polygon',layer:'Edge.Cuts',width:0.05,
  start:{x:0,y:0},points:[{x:100,y:0},{x:100,y:76}],end:{x:0,y:76}}];
const panel=(name,size,position,material='aluminium',opacity=1)=>({id:uid(),name,kind:'box',size,position,rotation:{x:0,y:0,z:0},material,opacity});
const assembly={version:1,objects:[
 panel('Base',{x:112,y:94,z:3},{x:50,y:38,z:-10.3}),
 panel('Front wall',{x:112,y:3,z:30},{x:50,y:-7.5,z:6.2}),
 panel('Back wall',{x:112,y:3,z:30},{x:50,y:83.5,z:6.2}),
 panel('Transparent cover',{x:112,y:94,z:3},{x:50,y:38,z:22.7},'pmma',0.3),
]};
const body={id:uid(),name:'PMMA block',kind:'box',position:{x:50,y:38,z:3},
  rotation:{x:0,y:0,z:0},size:{x:32,y:24,z:3},material:'pmma',opacity:0.3};
const saved=withModelCad(project,{version:1,objects:[body]});
const native=()=>JSON.stringify(projectNativeFiles(saved,'transparent.kicad_pro'));
const before=native();
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
renderer.setSize(700,600);renderer.setPixelRatio(1);renderer.setClearColor(0xffffff,1);
document.body.append(renderer.domElement);
const gl=renderer.getContext();
const scene=new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff,0x444444,3));
const lamp=new THREE.DirectionalLight(0xffffff,3);lamp.position.set(50,-70,100);scene.add(lamp);
const camera=new THREE.OrthographicCamera(-65,65,55.714,-55.714,1,500);
camera.up.set(0,1,0);

function exteriorFace(mesh,direction){
  const positions=mesh.geometry.getAttribute('position'),normals=mesh.geometry.getAttribute('normal');
  const points=[],vectors=[];
  for(let i=0;i<positions.count;i+=3){
    if(normals.getZ(i)*direction<0.99)continue;
    for(let j=0;j<3;j++){
      points.push(positions.getX(i+j),positions.getY(i+j),positions.getZ(i+j));
      vectors.push(normals.getX(i+j),normals.getY(i+j),normals.getZ(i+j));
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(vectors,3));
  const material=mesh.material.clone();material.side=THREE.FrontSide;
  const reference=new THREE.Mesh(geometry,material);
  reference.position.copy(mesh.position);reference.quaternion.copy(mesh.quaternion);reference.scale.copy(mesh.scale);
  return reference;
}
function pixel(point){
  const projected=point.clone().project(camera);
  const x=Math.round((projected.x+1)*350),y=Math.round((projected.y+1)*300);
  const values=new Uint8Array(3*3*4);gl.readPixels(x-1,y-1,3,3,gl.RGBA,gl.UNSIGNED_BYTE,values);
  return Array.from(values);
}
function frame(mesh,support,samples){
  const meshParent=mesh.parent,supportParent=support.parent;
  scene.add(support,mesh);renderer.render(scene,camera);
  const values=samples.map(pixel);scene.remove(support,mesh);
  meshParent?.add(mesh);supportParent?.add(support);return values;
}
function compare(actual,expected){
  let maximum=0,changed=0;
  for(let i=0;i<actual.length;i++)for(let j=0;j<actual[i].length;j++){
    if(j%4===3)continue;const difference=Math.abs(actual[i][j]-expected[i][j]);
    maximum=Math.max(maximum,difference);if(difference>2)changed++;
  }
  return {maximum,changed};
}
window.verifyTransparentSolids=baseline=>{
  const results=[],negativeControls=[],screenshots={};
  const panels=new THREE.Group();for(const object of assembly.objects)panels.add(modelCadMesh(object));
  const solids=assembly.objects.map(object=>({size:object.size,origin:{x:object.position.x-object.size.x/2,y:object.position.y-object.size.y/2,z:object.position.z-object.size.z/2}}));
  const enclosure={center:{x:assembly.objects[3].position.x,y:assembly.objects[3].position.y}};
  const cover=panels.children[3],wall=panels.children[1];
  const panelIds=panels.children.map(mesh=>mesh.uuid).sort().join(',');
  const reviewBoard=new THREE.Mesh(new THREE.BoxGeometry(100,76,project.pcb.thickness),new THREE.MeshStandardMaterial({color:0x397c58,roughness:0.6}));
  reviewBoard.position.set(50,-38,0);
  const captureAssembly=name=>{
    check(panels.children.length===4&&panels.children.map(mesh=>mesh.uuid).sort().join(',')===panelIds,'Review assembly lost an enclosure panel.');
    check(cover.parent===panels&&wall.parent===panels,'Contact checks must restore the original panel parents.');
    scene.add(panels,reviewBoard);renderer.render(scene,camera);screenshots[name]=renderer.domElement.toDataURL();scene.remove(panels,reviewBoard);
  };
  const wallSolid=solids[1],coverSolid=solids[3];
  check(Math.abs(wallSolid.origin.z+wallSolid.size.z-coverSolid.origin.z)<1e-9,'Fixture requires exact cover/wall contact.');
  const supportObject={...body,id:uid(),name:'Opaque support',material:'aluminium',opacity:1,
    position:{...body.position,z:body.position.z-body.size.z}};
  const glass=modelCadMesh(body),support=modelCadMesh(supportObject);
  const cases=[
    {name:'enclosure cover',mesh:cover,support:wall,center:new THREE.Vector3(enclosure.center.x,-enclosure.center.y,coverSolid.origin.z),
      top:coverSolid.origin.z+coverSolid.size.z,bottom:coverSolid.origin.z,
      samples:[-25,-10,10,25].map(dx=>new THREE.Vector3(enclosure.center.x+dx,-wallSolid.origin.y-wallSolid.size.y/2,coverSolid.origin.z))},
    {name:'PMMA CAD solid',mesh:glass,support,center:new THREE.Vector3(body.position.x,-body.position.y,body.position.z),
      top:body.position.z+body.size.z/2,bottom:body.position.z-body.size.z/2,
      samples:[-10,-6,6,10].map(dx=>new THREE.Vector3(body.position.x+dx,-body.position.y,body.position.z-body.size.z/2))}
  ];
  for(const item of cases){
    item.mesh.updateMatrixWorld(true);item.support.updateMatrixWorld(true);
    const originalBounds=JSON.stringify(new THREE.Box3().setFromObject(item.mesh,true));
    const side=item.mesh.material.side;
    const radians=THREE.MathUtils.degToRad(8);
    camera.position.copy(item.center).add(new THREE.Vector3(Math.sin(radians)*150,0,Math.cos(radians)*150));
    camera.lookAt(item.center);camera.updateMatrixWorld(true);camera.updateProjectionMatrix();
    const topReference=exteriorFace(item.mesh,1);
    item.mesh.material.side=THREE.DoubleSide;item.mesh.material.needsUpdate=true;
    // Separate only the negative control to expose interior paint independently of contact triangulation.
    const negativeSupport=item.support.clone();negativeSupport.position.z-=0.02;
    const doubled=frame(item.mesh,negativeSupport,item.samples),single=frame(topReference,negativeSupport,item.samples);
    const negative=compare(doubled,single);negativeControls.push({name:item.name,...negative});
    check(negative.maximum>2,item.name+' negative control must expose the former hidden-face blending.');
    if(item===cases[0])captureAssembly('before');
    disposeModelGroup(topReference);
    item.mesh.material.side=baseline?THREE.DoubleSide:side;item.mesh.material.needsUpdate=true;
    for(const direction of [1,-1]){
      const reference=exteriorFace(item.mesh,direction);
      for(const angle of [-0.06,-0.01,0,0.01,0.06]){
        const radians=THREE.MathUtils.degToRad(8+angle);
        camera.position.copy(item.center).add(new THREE.Vector3(Math.sin(radians)*150,0,direction*Math.cos(radians)*150));
        camera.lookAt(item.center);camera.updateMatrixWorld(true);camera.updateProjectionMatrix();
        // Below the cover use an interior sample, clear of the opaque walls.
        const samples=direction===1?item.samples:[item.center.clone().add(new THREE.Vector3(8,0,0))];
        const opaque=direction===1?item.support:new THREE.Group();
        const actual=frame(item.mesh,opaque,samples),expected=frame(reference,opaque,samples),difference=compare(actual,expected);
        results.push({name:item.name,direction,angle,...difference});
        check(difference.maximum<=2,item.name+' '+(direction===1?'top/contact':'bottom')+' at '+angle+' degrees draws hidden glass faces: '+JSON.stringify(difference));
      }
      disposeModelGroup(reference);
    }
    item.mesh.material.side=side;
    if(item===cases[0]){
      camera.position.copy(item.center).add(new THREE.Vector3(Math.sin(radians)*150,0,Math.cos(radians)*150));
      camera.lookAt(item.center);camera.updateMatrixWorld(true);camera.updateProjectionMatrix();
      captureAssembly('after');
    }
    check(JSON.stringify(new THREE.Box3().setFromObject(item.mesh,true))===originalBounds,item.name+' rendering changed geometry bounds.');
  }
  check(native()===before,'Transparency rendering changed native Source.');
  // Keep the primitive cover fixture visible for the review capture.
  camera.left=-80;camera.right=80;camera.top=68.571;camera.bottom=-68.571;
  camera.up.set(0,0,1);camera.position.set(180,-125,190);camera.lookAt(enclosure.center.x,-enclosure.center.y,8);camera.updateProjectionMatrix();
  captureAssembly('overview');
  scene.add(panels,reviewBoard);renderer.render(scene,camera);
  disposeModelGroup(glass);disposeModelGroup(support);
  return {results,negativeControls,screenshots};
};
`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 600 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body style="margin:0"></body></html>',
    }),
  );
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(
    (baseline) => window.verifyTransparentSolids(baseline),
    process.argv.includes('--baseline'),
  );
  assert.equal(results.results.length, 20);
  assert.equal(results.negativeControls.length, 2);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  for (const [name, data] of Object.entries(results.screenshots))
    await writeFile(
      `test-results/transparent-solids-${name}.png`,
      Buffer.from(data.split(',')[1], 'base64'),
    );
  await page.screenshot({ path: 'test-results/transparent-solids.png' });
  console.log(
    'PASS: transparent cover and PMMA CAD contact edges match exterior faces across small camera changes; underside, bounds and native Source remain intact.',
  );
} finally {
  await browser.close();
}
