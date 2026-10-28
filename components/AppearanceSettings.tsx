'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appearanceKey,
  defaultAppearance,
  parseAppearance,
  textSizeOptions,
  sourceWhitespaceOptions,
  activeProfile,
  appearanceSizes,
  appearanceVariables,
  profileColors,
  fontOptions,
  codeFontOptions,
  fontStyleOptions,
  presetOptions,
  type VisualProfile,
  type Appearance,
} from '@/lib/appearance';
import Select from './Select';
import { api } from '@/lib/bridge';
import { downloadText } from '@/lib/download';
import { Check, ChevronDown, Copy, Download, RotateCcw } from 'lucide-react';

function ModePreview({ mode }: { mode: Appearance['theme'] }) {
  return (
    <span className="appearance-preview" aria-hidden="true">
      {(mode === 'system' ? ['light', 'dark'] : [mode]).map((palette) => (
        <span className={`appearance-preview-surface ${palette}`} key={palette}>
          <span className="appearance-preview-rail">
            <i />
            <i />
            <i />
          </span>
          <span className="appearance-preview-chat">
            <i />
            <i />
            <i />
            <b />
          </span>
          <span className="appearance-preview-canvas">
            <i />
            <b />
          </span>
        </span>
      ))}
    </span>
  );
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(defaultAppearance);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const saves = useRef(Promise.resolve());
  const revision = useRef(0);
  const appliedVariables = useRef<string[]>([]);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = window.openpe
          ? await (await api('appearance')).text()
          : localStorage.getItem(appearanceKey);
        if (!cancelled) setAppearance(parseAppearance(raw));
      } catch {
        if (!cancelled)
          setError('Could not load appearance settings. Choose your preferences again.');
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const root = document.documentElement;
      const mode =
        appearance.theme === 'system' ? (system.matches ? 'dark' : 'light') : appearance.theme;
      root.dataset.theme = mode;
      setResolvedTheme(mode);
      root.dataset.textSize = appearance.textSize;
      root.dataset.motion = appearance.motion;
      root.dataset.sourceWhitespace = appearance.sourceWhitespace;
      root.dataset.translucentSidebar = String(appearance.translucentSidebar);
      root.dataset.fullWidth = String(appearance.fullWidth);
      root.dataset.smartPunctuation = String(appearance.smartPunctuation);
      root.dataset.uiStyle = activeProfile(appearance, mode).uiStyle;
      for (const key of appliedVariables.current) root.style.removeProperty(key);
      const variables = appearanceVariables(appearance, mode);
      for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
      appliedVariables.current = Object.keys(variables);
    };
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [appearance, ready]);
  const update = useCallback((next: Appearance) => {
    setAppearance(next);
    const currentRevision = ++revision.current;
    saves.current = saves.current.then(async () => {
      try {
        if (window.openpe) await api('appearance', { method: 'POST', body: JSON.stringify(next) });
        else localStorage.setItem(appearanceKey, JSON.stringify(next));
        if (currentRevision === revision.current) setError('');
      } catch {
        if (currentRevision === revision.current)
          setError('Appearance changed for this session, but could not be saved. Try again.');
      }
    });
  }, []);
  return useMemo(
    () => ({ appearance, update, error, ready, resolvedTheme }),
    [appearance, update, error, ready, resolvedTheme],
  );
}

function NumberSetting({
  label,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);
  function commit() {
    const n = Number(draft);
    if (!draft.trim() || !Number.isInteger(n) || n < 12 || n > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(n);
  }
  return (
    <div className="appearance-row">
      <span>{label}</span>
      <div className="appearance-number">
        <input
          type="number"
          aria-label={label}
          min={12}
          max={max}
          step={1}
          value={draft}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(String(value));
              setInvalid(false);
            }
          }}
        />
        <span>px</span>
        {invalid && <small role="alert">Use 12–{max} whole pixels.</small>}
      </div>
    </div>
  );
}

function ColorSetting({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(value);
    setInvalid(false);
  }, [value]);
  function commit() {
    if (!/^#[\da-f]{6}$/i.test(draft)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(draft.toLowerCase());
  }
  return (
    <div className="appearance-row">
      <span>{label}</span>
      <div className="appearance-color">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          aria-label={label}
          spellCheck={false}
          maxLength={7}
          value={draft}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(value);
              setInvalid(false);
            }
          }}
        />
        {invalid && <small role="alert">Use a color such as #202020.</small>}
      </div>
    </div>
  );
}

function ToggleSetting({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="appearance-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        className="appearance-toggle"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export default function AppearanceSettings({
  settings,
}: {
  settings: ReturnType<typeof useAppearance>;
}) {
  const { appearance, update, error, ready, resolvedTheme } = settings;
  const [editingMode, setEditingMode] = useState<'light' | 'dark' | null>(null);
  const [transferStatus, setTransferStatus] = useState('');
  const target = appearance.separateModes ? (editingMode ?? resolvedTheme) : 'shared';
  const profile = appearance.profiles[target];
  const colors = profileColors(profile, target === 'shared' ? resolvedTheme : target);
  const sizes = appearanceSizes(appearance);
  const customSizes =
    appearance.uiSize !== null || appearance.contentSize !== null || appearance.codeSize !== null;
  function changeProfile(changes: Partial<VisualProfile>) {
    update({
      ...appearance,
      profiles: { ...appearance.profiles, [target]: { ...profile, ...changes } },
    });
  }
  function profileSelect(
    label: string,
    key:
      'preset' | 'uiFont' | 'contentFont' | 'codeFont' | 'uiStyle' | 'contentStyle' | 'codeStyle',
    options: readonly { value: string; label: string }[],
  ) {
    return (
      <div className="appearance-row">
        <span>{label}</span>
        <Select
          label={label}
          disabled={!ready}
          value={profile[key]}
          options={[...options]}
          onChange={(value) =>
            changeProfile(
              key === 'preset'
                ? {
                    preset: value as VisualProfile['preset'],
                    accent: null,
                    background: null,
                    foreground: null,
                  }
                : { [key]: value },
            )
          }
        />
      </div>
    );
  }
  async function transfer(copy: boolean) {
    try {
      const text = JSON.stringify(appearance, null, 2);
      if (copy) await navigator.clipboard.writeText(text);
      else downloadText(text, 'openpe-appearance.json', 'application/json');
      setTransferStatus(copy ? 'Appearance copied.' : 'Appearance export requested.');
    } catch {
      setTransferStatus('Could not export appearance. Try again.');
    }
  }
  return (
    <section className="appearance-settings" aria-labelledby="appearance-heading">
      <h3 id="appearance-heading">Appearance</h3>
      <div className="appearance-card appearance-mode-row">
        <span>Mode</span>
        <div className="appearance-modes" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((theme) => (
            <label className="appearance-mode" key={theme}>
              <input
                type="radio"
                name="appearance-theme"
                value={theme}
                checked={appearance.theme === theme}
                disabled={!ready}
                onChange={() => update({ ...appearance, theme })}
              />
              <span className="appearance-mode-art">
                <ModePreview mode={theme} />
                {appearance.theme === theme && (
                  <Check className="appearance-mode-check" size={13} aria-hidden="true" />
                )}
              </span>
              <span>{theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="appearance-card appearance-group">
        {appearance.separateModes && (
          <div className="appearance-row">
            <span>Editing mode</span>
            <Select
              label="Editing mode"
              value={target}
              disabled={!ready}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              onChange={(value) => setEditingMode(value as 'light' | 'dark')}
            />
          </div>
        )}
        {profileSelect('Theme preset', 'preset', presetOptions)}
        <ColorSetting
          label="Accent color"
          value={colors.accent}
          disabled={!ready}
          onChange={(accent) => changeProfile({ accent })}
        />
        <ColorSetting
          label="Background"
          value={colors.background}
          disabled={!ready}
          onChange={(background) => changeProfile({ background })}
        />
        <ColorSetting
          label="Foreground"
          value={colors.foreground}
          disabled={!ready}
          onChange={(foreground) => changeProfile({ foreground })}
        />
        {profileSelect('Interface font', 'uiFont', fontOptions)}
      </div>
      <div className="appearance-card appearance-row">
        <span>Text size</span>
        <Select
          label="Text size"
          disabled={!ready}
          value={customSizes ? 'custom' : appearance.textSize}
          onChange={(textSize) =>
            textSize !== 'custom' &&
            update({
              ...appearance,
              textSize: textSize as Appearance['textSize'],
              uiSize: null,
              contentSize: null,
              codeSize: null,
            })
          }
          options={[
            ...textSizeOptions,
            ...(customSizes ? [{ value: 'custom', label: 'Custom' }] : []),
          ]}
        />
      </div>
      <details className="appearance-advanced">
        <summary>
          Advanced <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <div className="appearance-card appearance-group">
          <NumberSetting
            label="Interface text size"
            value={sizes.ui}
            max={20}
            disabled={!ready}
            onChange={(uiSize) => update({ ...appearance, uiSize })}
          />
          <NumberSetting
            label="Content text size"
            value={sizes.content}
            max={28}
            disabled={!ready}
            onChange={(contentSize) => update({ ...appearance, contentSize })}
          />
          <NumberSetting
            label="Code text size"
            value={sizes.code}
            max={28}
            disabled={!ready}
            onChange={(codeSize) => update({ ...appearance, codeSize })}
          />
        </div>
        <div className="appearance-card appearance-group">
          <div className="appearance-row">
            <span>Reduce motion</span>
            <div className="appearance-segments" role="radiogroup" aria-label="Motion">
              {(['system', 'reduced', 'full'] as const).map((motion) => (
                <label key={motion}>
                  <input
                    type="radio"
                    name="appearance-motion"
                    value={motion}
                    checked={appearance.motion === motion}
                    disabled={!ready}
                    onChange={() => update({ ...appearance, motion })}
                  />
                  <span>
                    {motion === 'system' ? 'System' : motion === 'reduced' ? 'On' : 'Off'}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <ToggleSetting
            label="Separate light and dark settings"
            checked={appearance.separateModes}
            disabled={!ready}
            onChange={(separateModes) => {
              setEditingMode(null);
              update({ ...appearance, separateModes });
            }}
          />
        </div>
        <div className="appearance-card appearance-group">
          {profileSelect('Interface font style', 'uiStyle', fontStyleOptions)}
          {profileSelect('Content font', 'contentFont', [
            { value: 'inherit', label: 'Same as interface' },
            ...fontOptions,
          ])}
          {profileSelect('Content font style', 'contentStyle', fontStyleOptions)}
          {profileSelect('Code font', 'codeFont', codeFontOptions)}
          {profileSelect('Code font style', 'codeStyle', fontStyleOptions)}
          <ToggleSetting
            label="Translucent sidebar"
            checked={appearance.translucentSidebar}
            disabled={!ready}
            onChange={(translucentSidebar) => update({ ...appearance, translucentSidebar })}
          />
          {appearance.translucentSidebar && (
            <div className="appearance-row">
              <span>Sidebar opacity</span>
              <div className="appearance-range">
                <input
                  aria-label="Sidebar opacity"
                  type="range"
                  min="40"
                  max="100"
                  value={appearance.sidebarOpacity}
                  disabled={!ready}
                  onChange={(e) =>
                    update({ ...appearance, sidebarOpacity: Number(e.target.value) })
                  }
                />
                <output>{appearance.sidebarOpacity}%</output>
              </div>
            </div>
          )}
          <div className="appearance-row">
            <span>Contrast</span>
            <div className="appearance-range">
              <input
                aria-label="Contrast"
                type="range"
                min="0"
                max="100"
                value={appearance.contrast}
                disabled={!ready}
                onChange={(e) => update({ ...appearance, contrast: Number(e.target.value) })}
              />
              <output>{appearance.contrast}</output>
            </div>
          </div>
        </div>
        <div className="appearance-card appearance-group">
          <ToggleSetting
            label="Smart punctuation"
            checked={appearance.smartPunctuation}
            disabled={!ready}
            onChange={(smartPunctuation) => update({ ...appearance, smartPunctuation })}
          />
          <ToggleSetting
            label="Full-width content"
            checked={appearance.fullWidth}
            disabled={!ready}
            onChange={(fullWidth) => update({ ...appearance, fullWidth })}
          />
          <div className="appearance-row">
            <span>Source indentation</span>
            <Select
              label="Source indentation"
              disabled={!ready}
              value={appearance.sourceWhitespace}
              onChange={(sourceWhitespace) =>
                update({
                  ...appearance,
                  sourceWhitespace: sourceWhitespace as Appearance['sourceWhitespace'],
                })
              }
              options={[...sourceWhitespaceOptions]}
            />
          </div>
        </div>
      </details>
      <div className="appearance-actions">
        <button
          className="dialog-button quiet"
          disabled={!ready}
          onClick={() => update(structuredClone(defaultAppearance))}
        >
          <RotateCcw size={14} /> Reset appearance
        </button>
        <button
          className="icon-button"
          disabled={!ready}
          aria-label="Copy appearance"
          title="Copy appearance"
          onClick={() => void transfer(true)}
        >
          <Copy size={16} />
        </button>
        <button
          className="icon-button"
          disabled={!ready}
          aria-label="Export appearance"
          title="Export appearance"
          onClick={() => void transfer(false)}
        >
          <Download size={16} />
        </button>
      </div>
      {transferStatus && (
        <p className="appearance-transfer-status" role="status">
          {transferStatus}
        </p>
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
