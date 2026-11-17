import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The editable mark is the only source for icon geometry. All exports retain
// transparency; the presentation sheet alone supplies light and dark surfaces.
const root = new URL('../', import.meta.url);
const at = (name) => fileURLToPath(new URL(name, root));
const master = await readFile(at('public/brand/openpe-mark.svg'), 'utf8');
const paths = (svg) => svg.match(/<path\b[^>]*\/>/g)?.join('\n');
const geometry = paths(master);
if (!geometry || !master.includes('data-role="body"') || !master.includes('data-role="signal"'))
  throw new Error('The OpenPE logo master must contain body and signal SVG paths.');
const signal = geometry.match(/<path\b[^>]*data-role="signal"[^>]*\/>/)?.[0];
if (!signal) throw new Error('The OpenPE logo master must contain a signal path.');
await writeFile(
  at('public/brand/openpe-signal.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">\n  <title>OpenPE — Loading signal</title>\n  ${signal}\n</svg>\n`,
);

const charcoal = '#292929';
const green = '#87ea5c';
const mono = master
  .replace(/(<path data-role="body"[^>]*?) stroke="[^"]*" stroke-width="[^"]*" stroke-linejoin="[^"]*" paint-order="[^"]*"/, '$1')
  .replaceAll(green, charcoal)
  .replace('</title>', ', monochrome</title>');
await writeFile(at('public/brand/openpe-mark-mono.svg'), mono);

function lockup(markPaths, foreground, secondary) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="104" viewBox="0 0 360 104">
  <title>OpenPE — Electrical Engineering Studio</title>
  <g transform="translate(8 8) scale(1.375)">${markPaths}</g>
  <text x="112" y="61" font-family="Segoe UI,Arial,sans-serif" font-weight="600" font-size="51" letter-spacing="-2.2" fill="${foreground}">OpenPE</text>
  <text x="115" y="82" font-family="Segoe UI,Arial,sans-serif" font-size="11" letter-spacing="1.5" fill="${secondary}">ELECTRICAL ENGINEERING STUDIO</text>
</svg>
`;
}
await writeFile(at('public/brand/openpe-lockup.svg'), lockup(geometry, charcoal, '#666666'));
await mkdir(at('build'), { recursive: true });
await sharp(Buffer.from(master)).resize(512, 512).png().toFile(at('public/brand/openpe-icon.png'));
await sharp(at('public/brand/openpe-lockup.svg')).resize(1080, 312).png().toFile(at('public/brand/openpe-lockup.png'));

const sizes = [16, 24, 32, 48, 64, 128, 256];
async function writeIcon(svg, file) {
  const images = [];
  for (const size of sizes)
    images.push(await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const base = 6 + i * 16;
    header[base] = size === 256 ? 0 : size;
    header[base + 1] = header[base];
    header.writeUInt16LE(1, base + 4);
    header.writeUInt16LE(32, base + 6);
    header.writeUInt32LE(images[i].length, base + 8);
    header.writeUInt32LE(offset, base + 12);
    offset += images[i].length;
  });
  await writeFile(at(file), Buffer.concat([header, ...images]));
}
// Native chrome supplies surrounding spacing, so use a tighter square crop.
const windowIcon = master.replace('viewBox="0 0 64 64"', 'viewBox="4 4 56 56"');
await writeIcon(windowIcon, 'build/openpe.ico');
await writeIcon(windowIcon, 'public/brand/openpe-window.ico');
const icnsTypes = [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
];
const icnsChunks = [];
for (const [size, type] of icnsTypes) {
  const png = await sharp(Buffer.from(windowIcon)).resize(size, size).png().toBuffer();
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(png.length + 8, 4);
  icnsChunks.push(header, png);
}
const icnsBody = Buffer.concat(icnsChunks);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 'ascii');
icnsHeader.writeUInt32BE(icnsBody.length + 8, 4);
await writeFile(at('build/openpe.icns'), Buffer.concat([icnsHeader, icnsBody]));

await mkdir(at('references'), { recursive: true });
const actualSizes = [16, 24, 32, 48];
const sizeSamples = actualSizes.map((size, index) => {
  const x = 853 + index * 90;
  return `<g transform="translate(${x - size / 2} ${675 - size / 2}) scale(${size / 64})">${geometry}</g><text x="${x}" y="732" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="11" fill="#737373">${size} px</text>`;
}).join('\n');
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#f6f6f4"/>
  <text x="56" y="63" font-family="Segoe UI,Arial,sans-serif" font-size="24" font-weight="600" letter-spacing="-.5" fill="${charcoal}">OpenPE</text>
  <text x="1224" y="61" text-anchor="end" font-family="Segoe UI,Arial,sans-serif" font-size="12" letter-spacing="1.4" fill="#777777">SIGNAL E / BRAND IDENTITY</text>
  <path d="M56 89h1168" stroke="#dcdcd8"/>
  <rect x="56" y="122" width="568" height="454" rx="24" fill="#ffffff"/>
  <rect x="648" y="122" width="576" height="454" rx="24" fill="#222423"/>
  <g transform="translate(244 174) scale(3)">${geometry}</g>
  <g transform="translate(840 174) scale(3)">${geometry}</g>
  <text x="340" y="431" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-weight="600" font-size="64" letter-spacing="-2.7" fill="${charcoal}">OpenPE</text>
  <text x="340" y="464" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="13" letter-spacing=".4" fill="#777777">Electrical Engineering Studio</text>
  <text x="936" y="464" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="13" letter-spacing=".4" fill="#b6b9b6">Electrical Engineering Studio</text>
  <text x="84" y="548" font-family="Segoe UI,Arial,sans-serif" font-size="10" letter-spacing="1.3" fill="#8a8a86">LIGHT SURFACE</text>
  <text x="676" y="548" font-family="Segoe UI,Arial,sans-serif" font-size="10" letter-spacing="1.3" fill="#979c98">DARK SURFACE</text>
  <path d="M56 614h1168" stroke="#dcdcd8"/>
  <rect x="56" y="651" width="44" height="44" rx="13" fill="${charcoal}"/>
  <text x="115" y="669" font-family="Segoe UI,Arial,sans-serif" font-size="13" font-weight="600" fill="${charcoal}">Charcoal</text>
  <text x="115" y="690" font-family="Segoe UI,Arial,sans-serif" font-size="12" fill="#777777">#292929</text>
  <rect x="268" y="651" width="44" height="44" rx="13" fill="${green}"/>
  <text x="327" y="669" font-family="Segoe UI,Arial,sans-serif" font-size="13" font-weight="600" fill="${charcoal}">Signal green</text>
  <text x="327" y="690" font-family="Segoe UI,Arial,sans-serif" font-size="12" fill="#777777">#87EA5C</text>
  <text x="56" y="746" font-family="Segoe UI,Arial,sans-serif" font-size="11" fill="#888883">Smooth contours. Transparent master. One continuous signal.</text>
  ${sizeSamples}
</svg>
`;
await writeFile(at('references/openpe-logo-preview.svg'), preview);
await sharp(Buffer.from(preview)).png().toFile(at('references/openpe-logo-preview.png'));
const titlebarPreview = `<svg xmlns="http://www.w3.org/2000/svg" width="880" height="176" viewBox="0 0 880 176">
  <rect width="880" height="176" fill="#fafafa"/>
  <text x="20" y="27" font-family="Segoe UI,Arial,sans-serif" font-size="12" fill="#666666">Native window identity</text>
  <rect x="16" y="44" width="848" height="40" rx="6" fill="#ffffff" stroke="#dbdbdb"/>
  <text x="28" y="69" font-family="Segoe UI,Arial,sans-serif" font-size="13" fill="${charcoal}">OpenPE · Electrical Engineering Studio</text>
  <rect x="16" y="104" width="848" height="40" rx="6" fill="${charcoal}"/>
  <text x="28" y="129" font-family="Segoe UI,Arial,sans-serif" font-size="13" fill="#fafafa">OpenPE · Electrical Engineering Studio</text>
</svg>
`;
await sharp(Buffer.from(titlebarPreview)).png().toFile(at('references/openpe-titlebar-preview.png'));
console.log('Generated dark OpenPE Signal E marks, transparent PNGs, Windows and macOS icons and identity previews.');
