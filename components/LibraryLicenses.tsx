'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import styles from './LibraryLicenses.module.css';

const sources = [
  ['kicad-libraries', 'KiCad libraries', '/licenses/kicad-libraries.txt'],
  ['kicad-demos/NOTICE', 'KiCad demo notices', '/licenses/kicad-demos/NOTICE.txt'],
  ['kicad-demos/LICENSE', 'KiCad demo license', '/licenses/kicad-demos/LICENSE.txt'],
  ['reference/NOTICE', 'Reference circuit notices', '/licenses/reference/NOTICE.txt'],
  ['emc-flyback/NOTICE', 'EMC Flyback notices', '/licenses/emc-flyback/NOTICE.txt'],
  ['emc-flyback/LICENSE', 'EMC Flyback license', '/licenses/emc-flyback/LICENSE.txt'],
  ['ti-models', 'Texas Instruments models', '/licenses/ti-models.txt'],
  ['example-models', 'Example models', '/licenses/example-models.txt'],
  ['ngspice', 'ngspice', '/licenses/ngspice.txt'],
  ['thermal', 'Thermal tools', '/licenses/thermal.txt'],
  ['ai-pcb-layout', 'PE Layout Skill', '/licenses/ai-pcb-layout.txt'],
  ['occt-import-js', 'STEP parser', '/licenses/occt-import-js.txt'],
  ['opencascade', 'Open CASCADE', '/licenses/opencascade.txt'],
  ['three', 'Three.js', '/licenses/three.txt'],
  ['three-gpu-pathtracer', 'three-gpu-pathtracer', '/licenses/three-gpu-pathtracer.txt'],
  ['glsl-smart-denoise', 'glslSmartDeNoise', '/licenses/glsl-smart-denoise.txt'],
  ['three-mesh-bvh', 'three-mesh-bvh', '/licenses/three-mesh-bvh.txt'],
  ['xatlas-web', 'xatlas-web', '/licenses/xatlas-web.txt'],
  ['vscode-codicons', 'VS Code Codicons', '/licenses/vscode-codicons.txt'],
  ['kicad-icons', 'KiCad icons', '/licenses/kicad-icons.txt'],
  ['clipper', 'Clipper', '/licenses/clipper.txt'],
  ['newstroke', 'Newstroke font', '/licenses/newstroke.txt'],
  ['Agent product marks', 'Agent product marks', '/agents/README.txt'],
  ['DeepSeek Harness icon', 'DeepSeek Harness icon', '/agents/LICENSE-deepseek'],
  ['Pi icon', 'Pi icon', '/agents/LICENSE-pi'],
] as const;

export default function LibraryLicenses() {
  const [requested, setRequested] = useState(false);
  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!requested) return;
    const control = new AbortController();
    for (const [id, , url] of sources)
      void fetch(url, { signal: control.signal })
        .then((response) => {
          if (!response.ok) throw new Error('License file is unavailable.');
          return response.text();
        })
        .then((text) => {
          if (!control.signal.aborted) setTexts((previous) => ({ ...previous, [id]: text }));
        })
        .catch((error: unknown) => {
          if (!control.signal.aborted)
            setTexts((previous) => ({
              ...previous,
              [id]: error instanceof Error ? error.message : 'License file is unavailable.',
            }));
        });
    return () => control.abort();
  }, [requested]);
  return (
    <details
      className={styles.licenses}
      onToggle={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.open) setRequested(true);
      }}
    >
      <summary className={styles.summary}>
        <FileText size={17} aria-hidden="true" />
        <span>Third-party licenses</span>
        <ChevronRight className={styles.chevron} size={16} aria-hidden="true" />
      </summary>
      {requested && (
        <div className={styles.content}>
          <div className={styles.attribution}>
            <p>
              KiCad library data © KiCad library contributors. OpenPE is an independent application.
            </p>
            <p>
              Original symbol, footprint and model files retain their license. OpenPE adds a search
              index and generates display meshes.
            </p>
            <p>
              The STEP parser is unmodified and replaceable in the installed
              resources/app.asar.unpacked/node_modules/occt-import-js directory. Corresponding
              source archives and build instructions are included in resources/third-party-source.
              Reverse engineering for debugging modifications to these LGPL libraries is permitted.
            </p>
          </div>
          <div className={styles.list}>
            {sources.map(([id, label]) => (
              <details className={styles.entry} key={id} data-license={id}>
                <summary className={styles.entrySummary}>
                  <span>{label}</span>
                  <ChevronRight className={styles.chevron} size={15} aria-hidden="true" />
                </summary>
                <pre className={styles.text} aria-busy={texts[id] === undefined}>
                  {texts[id] ?? 'Loading license…'}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}
    </details>
  );
}
