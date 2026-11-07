import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createModelRenderGuides } from './model-render-guides';

/** Spatial reconstruction of the accumulated image; never feeds filtered pixels back into tracing. */
export function createModelRenderDenoiser(renderer: THREE.WebGLRenderer) {
  const guides = createModelRenderGuides(renderer);
  const scratch = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  const material = new THREE.ShaderMaterial({
    name: 'OpenPE guided render denoising',
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      map: { value: null },
      original: { value: null },
      normalDepth: { value: null },
      albedo: { value: null },
      inverseProjection: { value: new THREE.Matrix4() },
      texel: { value: new THREE.Vector2() },
      stride: { value: 1 },
      colorSigma: { value: 0.18 },
      opticalSigma: { value: 0.08 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map, original, normalDepth, albedo;
      uniform mat4 inverseProjection;
      uniform vec2 texel;
      uniform float stride, colorSigma, opticalSigma;
      varying vec2 vUv;

      vec3 viewPosition( vec2 uv, float depth ) {
        vec4 position = inverseProjection * vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
        return position.xyz / position.w;
      }
      vec3 perceptual( vec3 color ) {
        color = max( color, vec3( 0.0 ) );
        return color / ( vec3( 1.0 ) + color );
      }
      float kernel( int offset ) {
        int distance = abs( offset );
        return distance == 0 ? 6.0 : ( distance == 1 ? 4.0 : 1.0 );
      }
      void main() {
        vec4 center = texture2D( map, vUv );
        vec4 surface = texture2D( normalDepth, vUv );
        // Empty background has no surface to reconstruct and is already noiseless.
        if ( dot( surface.xyz, surface.xyz ) < 0.5 ) {
          gl_FragColor = center;
          return;
        }
        vec3 normal = normalize( surface.xyz );
        vec3 position = viewPosition( vUv, surface.w );
        vec4 paint = texture2D( albedo, vUv );
        vec3 centerColor = perceptual( center.rgb );
        vec4 originalCenter = texture2D( original, vUv );
        vec3 originalColor = perceptual( originalCenter.rgb );
        float pixelSpan = max(
          length( viewPosition( vUv + vec2( texel.x, 0.0 ), surface.w ) - position ),
          length( viewPosition( vUv + vec2( 0.0, texel.y ), surface.w ) - position )
        );
        float planeTolerance = max( pixelSpan * 1.5, 0.00001 );
        // The tracer integrates subpixel coverage; unjittered raster guides do
        // not. Keep those original edge pixels instead of flattening them into
        // the nearest guide face and introducing stair-stepped silhouettes.
        for ( int edge = 0; edge < 4; edge++ ) {
          vec2 offset = edge == 0 ? vec2( 1.0, 0.0 ) : edge == 1 ? vec2( -1.0, 0.0 ) :
            edge == 2 ? vec2( 0.0, 1.0 ) : vec2( 0.0, -1.0 );
          vec2 uv = vUv + offset * texel;
          vec4 neighbourSurface = texture2D( normalDepth, uv );
          vec3 paintDelta = texture2D( albedo, uv ).rgb - paint.rgb;
          vec3 displacement = viewPosition( uv, neighbourSurface.w ) - position;
          if ( dot( neighbourSurface.xyz, neighbourSurface.xyz ) < 0.5 ||
               dot( normal, normalize( neighbourSurface.xyz ) ) < 0.8 ||
               abs( dot( normal, displacement ) ) > planeTolerance ||
               dot( paintDelta, paintDelta ) > 0.01 ) {
            gl_FragColor = originalCenter;
            return;
          }
        }
        vec3 sum = vec3( 0.0 );
        float total = 0.0;
        for ( int y = -2; y <= 2; y++ ) {
          for ( int x = -2; x <= 2; x++ ) {
            vec2 uv = vUv + vec2( float( x ), float( y ) ) * texel * stride;
            if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) continue;
            vec4 neighbourSurface = texture2D( normalDepth, uv );
            if ( dot( neighbourSurface.xyz, neighbourSurface.xyz ) < 0.5 ) continue;
            vec3 neighbourNormal = normalize( neighbourSurface.xyz );
            float alignment = max( dot( normal, neighbourNormal ), 0.0 );
            if ( alignment < 0.8 ) continue;
            vec3 displacement = viewPosition( uv, neighbourSurface.w ) - position;
            float separation = max( abs( dot( normal, displacement ) ), abs( dot( neighbourNormal, displacement ) ) );
            float depthWeight = exp( -pow( separation / planeTolerance, 2.0 ) );
            vec4 neighbourPaint = texture2D( albedo, uv );
            vec3 paintDelta = neighbourPaint.rgb - paint.rgb;
            float paintWeight = exp( -dot( paintDelta, paintDelta ) * 200.0 );
            vec4 neighbour = texture2D( map, uv );
            vec3 colorDelta = perceptual( neighbour.rgb ) - centerColor;
            // Raster guides describe the nearest optical surface only. A tighter
            // colour guard protects detail seen through a cover or lacquer.
            float optical = max( paint.a, neighbourPaint.a );
            float sigma = mix( colorSigma, opticalSigma, optical );
            float colorWeight = exp( -dot( colorDelta, colorDelta ) / ( 2.0 * sigma * sigma ) );
            vec3 originalDelta = perceptual( texture2D( original, uv ).rgb ) - originalColor;
            colorWeight *= mix( 1.0, exp( -dot( originalDelta, originalDelta ) / 0.0288 ), optical );
            float weight = kernel( x ) * kernel( y ) * pow( alignment, 32.0 ) * depthWeight * paintWeight * colorWeight;
            sum += neighbour.rgb * weight;
            total += weight;
          }
        }
        gl_FragColor = vec4( total > 0.0 ? sum / total : center.rgb, originalCenter.a );
      }
    `,
  });
  const quad = new FullScreenQuad(material);
  let disposed = false;
  return {
    invalidate() {
      guides.invalidate();
    },
    render(
      source: THREE.Texture,
      target: THREE.WebGLRenderTarget,
      scene: THREE.Scene,
      camera: THREE.Camera,
      samples: number,
    ) {
      if (disposed) throw new Error('The Model render denoiser has been disposed.');
      const { width, height } = target;
      const guide = guides.render(scene, camera, width, height);
      scratch.setSize(width, height);
      material.uniforms.normalDepth.value = guide.normalDepth;
      material.uniforms.original.value = source;
      material.uniforms.albedo.value = guide.albedo;
      material.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
      material.uniforms.texel.value.set(1 / width, 1 / height);
      const noiseScale = Math.min(3, Math.sqrt(64 / Math.max(1, samples)));
      const previousTarget = renderer.getRenderTarget();
      const previousToneMapping = renderer.toneMapping;
      try {
        renderer.toneMapping = THREE.NoToneMapping;
        let input = source;
        for (let pass = 0; pass < 3; pass++) {
          const output = pass === 1 ? scratch : target;
          material.uniforms.map.value = input;
          material.uniforms.stride.value = 1 << pass;
          material.uniforms.colorSigma.value = [0.18, 0.1, 0.06][pass] * noiseScale;
          material.uniforms.opticalSigma.value = [0.08, 0.055, 0.04][pass] * noiseScale;
          renderer.setRenderTarget(output);
          quad.render(renderer);
          input = output.texture;
        }
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.toneMapping = previousToneMapping;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      guides.dispose();
      scratch.dispose();
      material.dispose();
      quad.dispose();
    },
  };
}
