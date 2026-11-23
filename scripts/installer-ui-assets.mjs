import { writeFile } from 'node:fs/promises';
import { NtExecutable, NtExecutableResource } from 'resedit';

const button = 0x80;
const edit = 0x81;
const label = 0x82;
const outer = 0x80ca0848;
const page = 0x40000448;
const visibleLabel = 0x50020000;

// These are the standard NSIS control IDs. Coordinates are in dialog units,
// so Windows lays out the controls against the wizard font and display DPI.
const dialogs = [
  {
    id: 105, // IDD_INST
    style: outer,
    size: [250, 108],
    controls: [
      [3, button, 0x50030000, 96, 91, 45, 11], // Back
      [1, button, 0x50010000, 146, 91, 45, 11], // Next / Install / Finish
      [2, button, 0x50010000, 196, 91, 45, 11], // Cancel
      [1018, label, 0x40020004, 11, 31, 228, 50], // Standard pages
      [1044, label, 0x40020004, 0, 0, 250, 85], // Welcome and finish pages
      [1035, label, 0x50020010, 6, 85, 238, 1],
      [1036, label, 0x50020010, 0, 25, 250, 1],
      [1045, label, 0x40020010, 0, 85, 250, 1],
      [1256, label, visibleLabel, 6, 85, 238, 1],
      [1028, label, 0x58020000, 6, 85, 238, 1],
      [1034, label, visibleLabel, 0, 0, 250, 25], // Header background
      [1037, label, visibleLabel, 11, 4, 174, 9], // Header title
      [1038, label, visibleLabel, 11, 13, 174, 10], // Header guidance
      [1039, label, 0x50000203, 213, 0, 30, 25], // Centered icon
    ],
  },
  {
    id: 103, // IDD_DIR
    style: page,
    size: [228, 50],
    controls: [
      [1019, edit, 0x50810080, 7, 24, 176, 11],
      [1001, button, 0x50010000, 188, 24, 35, 11],
      [1024, label, 0x5000000c, 0, 42, 112, 8],
      [1008, button, 0x40010003, 116, 42, 112, 8],
      [1023, label, 0x5000000c, 0, 42, 112, 8],
      [1006, label, 0x50000000, 0, 1, 228, 11], // Folder guidance
      [1020, button, 0x50000007, 0, 15, 228, 27], // Folder group
    ],
  },
  {
    id: 106, // IDD_INSTFILES
    style: page,
    size: [228, 50],
    controls: [
      [1027, button, 0x50000000, 0, 24, 65, 11],
      [1004, 'msctls_progress32', 0x50800000, 0, 13, 228, 7],
      [1006, label, 0x5000008c, 0, 0, 228, 8],
      [1016, 'SysListView32', 0x40814005, 0, 24, 228, 26],
    ],
  },
];

function words(...values) {
  const binary = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => binary.writeUInt16LE(value, index * 2));
  return binary;
}

function dwords(...values) {
  const binary = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => binary.writeUInt32LE(value, index * 4));
  return binary;
}

function wide(value) {
  return Buffer.from(`${value}\0`, 'utf16le');
}

function dialogTemplate({ style, size, controls }) {
  const parts = [
    dwords(style, 0),
    words(controls.length, 0, 0, ...size, 0, 0, 0, 9),
    wide('Segoe UI'),
  ];
  let length = parts.reduce((sum, part) => sum + part.length, 0);
  for (const [id, type, controlStyle, ...bounds] of controls) {
    const item = Buffer.concat([
      Buffer.alloc((4 - (length % 4)) % 4),
      dwords(controlStyle, 0),
      words(...bounds, id),
      typeof type === 'string' ? wide(type) : words(0xffff, type),
      words(0, 0), // Empty caption and creation data
    ]);
    length += item.length;
    parts.push(item);
  }
  return Buffer.concat(parts, length);
}

export async function writeInstallerUi(destination) {
  const executable = NtExecutable.createEmpty(true, true);
  const resources = NtExecutableResource.from(executable);
  for (const dialog of dialogs) {
    resources.entries.push({
      type: 5, // RT_DIALOG
      id: dialog.id,
      lang: 1033,
      codepage: 1200,
      bin: Uint8Array.from(dialogTemplate(dialog)).buffer,
    });
  }
  resources.outputResource(executable);
  await writeFile(destination, Buffer.from(executable.generate()));
}
