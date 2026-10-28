import { symbolRoleColors } from './symbol-role';
import {
  defaultLeftButtonDrag,
  leftButtonDragOptions,
  type LeftButtonDrag,
} from './selection-drag';
import {
  defaultLayoutGridSpacing,
  layoutGridSpacingOptions,
  type LayoutGridSpacing,
} from './layout-grid';
import {
  defaultSchematicLayers,
  validateSchematicLayers,
  schematicTextColors,
  gridSpacingOptions,
  type GridSpacing,
  type SchematicLayers,
} from './schematic-layers';

export const textSizeOptions = [
  { value: 'small', label: 'Small · 13 px' },
  { value: 'compact', label: 'Compact · 14 px' },
  { value: 'standard', label: 'Standard · 15 px' },
  { value: 'large', label: 'Large · 17 px' },
  { value: 'extra-large', label: 'Extra large · 19 px' },
] as const;

export const sourceWhitespaceOptions = [
  { value: 'guides', label: 'Colored lines' },
  { value: 'rainbow', label: 'Colored blocks' },
] as const;

export const fontOptions = [
  { value: 'system', label: 'System' },
  { value: 'technical', label: 'Technical · Bahnschrift' },
  { value: 'sans', label: 'Sans · Arial' },
  { value: 'serif', label: 'Serif · Georgia' },
] as const;
export const codeFontOptions = [
  { value: 'system', label: 'System monospace' },
  { value: 'consolas', label: 'Consolas' },
  { value: 'courier', label: 'Courier New' },
] as const;
export const fontStyleOptions = [
  { value: 'regular', label: 'Regular' },
  { value: 'medium', label: 'Medium' },
  { value: 'bold', label: 'Bold' },
  { value: 'italic', label: 'Italic' },
] as const;
export const presetOptions = [
  { value: 'openpe', label: 'OpenPE' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'paper', label: 'Paper' },
] as const;
export type VisualProfile = {
  preset: (typeof presetOptions)[number]['value'];
  accent: string | null;
  background: string | null;
  foreground: string | null;
  uiFont: (typeof fontOptions)[number]['value'];
  contentFont: 'inherit' | VisualProfile['uiFont'];
  codeFont: (typeof codeFontOptions)[number]['value'];
  uiStyle: (typeof fontStyleOptions)[number]['value'];
  contentStyle: VisualProfile['uiStyle'];
  codeStyle: VisualProfile['uiStyle'];
};
const defaultProfile: VisualProfile = {
  preset: 'openpe',
  accent: null,
  background: null,
  foreground: null,
  uiFont: 'system',
  contentFont: 'inherit',
  codeFont: 'system',
  uiStyle: 'regular',
  contentStyle: 'regular',
  codeStyle: 'regular',
};
export type Appearance = {
  leftButtonDrag: LeftButtonDrag;
  schematicLayers: SchematicLayers;
  gridSpacing: GridSpacing;
  layoutGridSpacing: LayoutGridSpacing;
  modelGridSpacing: GridSpacing;
  theme: 'light' | 'dark' | 'system';
  textSize: (typeof textSizeOptions)[number]['value'];
  motion: 'system' | 'reduced' | 'full';
  sourceWhitespace: (typeof sourceWhitespaceOptions)[number]['value'];
  uiSize: number | null;
  contentSize: number | null;
  codeSize: number | null;
  separateModes: boolean;
  profiles: { shared: VisualProfile; light: VisualProfile; dark: VisualProfile };
  translucentSidebar: boolean;
  sidebarOpacity: number;
  contrast: number;
  smartPunctuation: boolean;
  fullWidth: boolean;
};

export const appearanceKey = 'openpe.appearance.v1';
export const defaultAppearance: Appearance = {
  leftButtonDrag: defaultLeftButtonDrag,
  schematicLayers: { ...defaultSchematicLayers },
  gridSpacing: 2,
  layoutGridSpacing: defaultLayoutGridSpacing,
  modelGridSpacing: 0.5,
  theme: 'light',
  textSize: 'standard',
  motion: 'system',
  sourceWhitespace: 'rainbow',
  uiSize: null,
  contentSize: null,
  codeSize: null,
  separateModes: false,
  profiles: {
    shared: { ...defaultProfile },
    light: { ...defaultProfile },
    dark: { ...defaultProfile },
  },
  translucentSidebar: false,
  sidebarOpacity: 85,
  contrast: 60,
  smartPunctuation: false,
  fullWidth: false,
};

export function parseAppearance(raw: string | null): Appearance {
  if (raw === null) return structuredClone(defaultAppearance);
  return validateAppearance(JSON.parse(raw));
}

export function validateAppearance(value: unknown): Appearance {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid appearance settings');
  const settings = value as Record<string, unknown>;
  if (
    Object.keys(settings).length !== Object.keys(defaultAppearance).length ||
    Object.keys(settings).some((key) => !Object.hasOwn(defaultAppearance, key)) ||
    (Object.hasOwn(settings, 'leftButtonDrag') &&
      !leftButtonDragOptions.some((option) => option.value === settings.leftButtonDrag)) ||
    (Object.hasOwn(settings, 'gridSpacing') &&
      !gridSpacingOptions.some((spacing) => spacing === settings.gridSpacing)) ||
    (Object.hasOwn(settings, 'layoutGridSpacing') &&
      !layoutGridSpacingOptions.some((spacing) => spacing === settings.layoutGridSpacing)) ||
    (Object.hasOwn(settings, 'modelGridSpacing') &&
      !gridSpacingOptions.some((spacing) => spacing === settings.modelGridSpacing)) ||
    (Object.hasOwn(settings, 'sourceWhitespace') &&
      !sourceWhitespaceOptions.some((option) => option.value === settings.sourceWhitespace)) ||
    typeof settings.theme !== 'string' ||
    !['light', 'dark', 'system'].includes(settings.theme) ||
    typeof settings.textSize !== 'string' ||
    !textSizeOptions.some((option) => option.value === settings.textSize) ||
    typeof settings.motion !== 'string' ||
    !['system', 'reduced', 'full'].includes(settings.motion)
  )
    throw new Error('Invalid appearance settings');
  for (const key of ['uiSize', 'contentSize', 'codeSize']) {
    const size = settings[key];
    if (
      Object.hasOwn(settings, key) &&
      size !== null &&
      (typeof size !== 'number' ||
        !Number.isInteger(size) ||
        size < 12 ||
        size > (key === 'uiSize' ? 20 : 28))
    )
      throw new Error('Font size is outside the supported range');
  }
  for (const key of ['separateModes', 'translucentSidebar', 'smartPunctuation', 'fullWidth'])
    if (Object.hasOwn(settings, key) && typeof settings[key] !== 'boolean')
      throw new Error('Invalid appearance toggle');
  for (const key of ['sidebarOpacity', 'contrast'])
    if (
      Object.hasOwn(settings, key) &&
      (typeof settings[key] !== 'number' ||
        !Number.isInteger(settings[key]) ||
        settings[key] < (key === 'sidebarOpacity' ? 40 : 0) ||
        settings[key] > 100)
    )
      throw new Error('Invalid appearance range');
  const profiles = settings.profiles;
  if (
    !profiles ||
    typeof profiles !== 'object' ||
    Array.isArray(profiles) ||
    Object.keys(profiles).length !== 3 ||
    !['shared', 'light', 'dark'].every((key) => Object.hasOwn(profiles, key))
  )
    throw new Error('Invalid appearance profiles');
  const profileMap = profiles as Record<string, unknown>;
  return {
    ...settings,
    schematicLayers: validateSchematicLayers(settings.schematicLayers),
    theme: settings.theme as Appearance['theme'],
    textSize: settings.textSize as Appearance['textSize'],
    motion: settings.motion as Appearance['motion'],
    sourceWhitespace: settings.sourceWhitespace as Appearance['sourceWhitespace'],
    profiles: {
      shared: validateProfile(profileMap.shared),
      light: validateProfile(profileMap.light),
      dark: validateProfile(profileMap.dark),
    },
  } as Appearance;
}

function validateProfile(value: unknown): VisualProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid theme profile');
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).length !== Object.keys(defaultProfile).length ||
    Object.keys(p).some((key) => !Object.hasOwn(defaultProfile, key))
  )
    throw new Error('Invalid theme fields');
  for (const key of ['accent', 'background', 'foreground'])
    if (p[key] !== null && (typeof p[key] !== 'string' || !/^#[\da-f]{6}$/i.test(p[key])))
      throw new Error('Colors must be six-digit hex values');
  const oneOf = (key: string, values: readonly string[]) => {
    if (typeof p[key] !== 'string' || !values.includes(p[key]))
      throw new Error('Invalid theme choice');
  };
  oneOf(
    'preset',
    presetOptions.map((o) => o.value),
  );
  oneOf(
    'uiFont',
    fontOptions.map((o) => o.value),
  );
  oneOf('contentFont', ['inherit', ...fontOptions.map((o) => o.value)]);
  oneOf(
    'codeFont',
    codeFontOptions.map((o) => o.value),
  );
  for (const key of ['uiStyle', 'contentStyle', 'codeStyle'])
    oneOf(
      key,
      fontStyleOptions.map((o) => o.value),
    );
  return { ...p } as VisualProfile;
}

export function activeProfile(settings: Appearance, mode: 'light' | 'dark') {
  return settings.profiles[settings.separateModes ? mode : 'shared'];
}
export function appearanceSizes(settings: Appearance) {
  const base = { small: 13, compact: 14, standard: 15, large: 17, 'extra-large': 19 }[
    settings.textSize
  ];
  return {
    ui: settings.uiSize ?? base,
    content: settings.contentSize ?? base,
    code: settings.codeSize ?? base - 1,
  };
}
export function profileColors(profile: VisualProfile, mode: 'light' | 'dark') {
  const dark = mode === 'dark';
  const palettes = {
    openpe: dark ? ['#202020', '#f0f0f0', '#87ea5c'] : ['#ffffff', '#202020', '#007106'],
    graphite: dark ? ['#191c21', '#e4e8ef', '#8aadeb'] : ['#f4f6fa', '#273244', '#3865a0'],
    paper: dark ? ['#25221e', '#ebe5d8', '#b8c78d'] : ['#faf7ef', '#343328', '#5d742d'],
  };
  const [background, foreground, accent] = palettes[profile.preset];
  return {
    background: profile.background ?? background,
    foreground: profile.foreground ?? foreground,
    accent: profile.accent ?? accent,
  };
}

function mix(a: string, b: string, amount: number) {
  return (
    '#' +
    [1, 3, 5]
      .map((i) =>
        Math.round(
          parseInt(a.slice(i, i + 2), 16) * (1 - amount) + parseInt(b.slice(i, i + 2), 16) * amount,
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
const fontFamilies = {
  system: "'Segoe UI', 'Helvetica Neue', Arial, 'Microsoft YaHei', sans-serif",
  technical: "Bahnschrift, 'DIN Alternate', 'Arial Narrow', 'Microsoft YaHei', sans-serif",
  sans: "Arial, 'Microsoft YaHei', sans-serif",
  serif: "Georgia, 'Times New Roman', 'SimSun', serif",
};
const codeFamilies = {
  system: "'Cascadia Code', Consolas, monospace",
  consolas: 'Consolas, monospace',
  courier: "'Courier New', monospace",
};
export function appearanceVariables(
  settings: Appearance,
  mode: 'light' | 'dark',
): Record<string, string> {
  const profile = activeProfile(settings, mode);
  const size = appearanceSizes(settings);
  const background = profileColors(profile, mode).background;
  const luminance = [1, 3, 5].reduce(
    (sum, offset, index) =>
      sum +
      (parseInt(background.slice(offset, offset + 2), 16) / 255) * [0.2126, 0.7152, 0.0722][index],
    0,
  );
  const vars: Record<string, string> = {
    ...schematicTextColors[luminance < 0.5 ? 'dark' : 'light'],
    ...symbolRoleColors[luminance < 0.5 ? 'dark' : 'light'],
    '--agent-logo-filter': luminance < 0.5 ? 'invert(1)' : 'none',
    '--font-step': `${size.ui - 15}px`,
    '--content-size': `${size.content}px`,
    '--code-size': `${size.code}px`,
    '--ui-font': fontFamilies[profile.uiFont],
    '--content-font':
      fontFamilies[profile.contentFont === 'inherit' ? profile.uiFont : profile.contentFont],
    '--code-font': codeFamilies[profile.codeFont],
    '--sidebar-opacity': `${settings.sidebarOpacity}%`,
  };
  for (const [target, style] of [
    ['ui', profile.uiStyle],
    ['content', profile.contentStyle],
    ['code', profile.codeStyle],
  ]) {
    vars[`--${target}-weight`] = style === 'bold' ? '700' : style === 'medium' ? '500' : '400';
    vars[`--${target}-style`] = style === 'italic' ? 'italic' : 'normal';
  }
  if (
    profile.preset !== 'openpe' ||
    profile.accent ||
    profile.background ||
    profile.foreground ||
    settings.contrast !== 60
  ) {
    const { background: bg, foreground: fg, accent } = profileColors(profile, mode);
    const c = settings.contrast / 100;
    Object.assign(vars, {
      '--surface': bg,
      '--canvas': bg,
      '--shell': mix(bg, fg, 0.035),
      '--panel': mix(bg, fg, 0.025),
      '--text-strong': fg,
      '--text': mix(bg, fg, 0.72 + c * 0.28),
      '--muted': mix(bg, fg, 0.48 + c * 0.32),
      '--soft': mix(bg, fg, 0.38 + c * 0.32),
      '--faint': mix(bg, fg, 0.22 + c * 0.25),
      '--line': mix(bg, fg, 0.08 + c * 0.2),
      '--line-soft': mix(bg, fg, 0.04 + c * 0.12),
      '--border-strong': mix(bg, fg, 0.18 + c * 0.24),
      '--tint': mix(bg, fg, 0.08),
      '--accent': mix(bg, fg, 0.85),
      '--accent-strong': fg,
      '--on-accent': bg,
      '--brand': accent,
      '--brand-ink': accent,
      '--brand-soft': mix(bg, accent, 0.12),
      '--brand-surface': mix(bg, accent, 0.08),
    });
  }
  return vars;
}

/** Only transform the just-typed suffix in prose; pasted text, code and numeric units stay literal. */
export function smartPunctuationEdit(value: string, caret: number) {
  const before = value.slice(0, caret);
  if (
    (before.match(/```/g)?.length ?? 0) % 2 ||
    (before.split('\n').at(-1)?.match(/`/g)?.length ?? 0) % 2
  )
    return { value, caret };
  let replacement = before;
  if (before.endsWith('...')) replacement = before.slice(0, -3) + '…';
  else if (before.endsWith('--')) replacement = before.slice(0, -2) + '—';
  else if (before.endsWith('->')) replacement = before.slice(0, -2) + '→';
  else if (before.endsWith('<-')) replacement = before.slice(0, -2) + '←';
  else if (/["']$/.test(before) && !/\d["']$/.test(before)) {
    const opening = before.length === 1 || /[\s([{]["']$/.test(before);
    const quote = before.endsWith('"') ? (opening ? '“' : '”') : opening ? '‘' : '’';
    replacement = before.slice(0, -1) + quote;
  }
  return { value: replacement + value.slice(caret), caret: replacement.length };
}
