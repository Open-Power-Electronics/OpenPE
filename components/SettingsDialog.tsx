'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ClipboardCheck,
  LoaderCircle,
  RotateCw,
  Sun,
  Unplug,
} from 'lucide-react';
import type { Agent } from './Chat';
import AppearanceSettings, { type useAppearance } from './AppearanceSettings';
import AgentLogo from './AgentLogo';
import Dialog from './Dialog';
import { agentProviders } from '@/lib/agent-providers';
import { useAgentSettings } from './AgentSettings';
import Select from './Select';
import type { FollowUpMode } from '@/lib/agent-settings';
import RuleSettings, { type RuleSettingsActions, type RuleSettingsProps } from './RuleSettings';

export default function SettingsDialog({
  appearance,
  agents,
  detecting,
  error,
  onDetect,
  onClose,
  initialSection = 'appearance',
  ruleSettings,
}: {
  appearance: ReturnType<typeof useAppearance>;
  agents: Agent[];
  detecting: boolean;
  error: string;
  onDetect: () => Promise<void>;
  onClose: () => void;
  initialSection?: 'appearance' | 'agents' | 'rules';
  ruleSettings?: RuleSettingsProps;
}) {
  const [section, setSection] = useState<string>(initialSection);
  const [visitedRules, setVisitedRules] = useState(initialSection === 'rules');
  const ruleActions = useRef<RuleSettingsActions>(null);
  const [cursorKey, setCursorKey] = useState('');
  const [cursorCredential, setCursorCredential] = useState<{
    configured: boolean;
    suffix?: string;
  } | null>(null);
  const [cursorError, setCursorError] = useState('');
  const cursorComposing = useRef(false);
  useEffect(() => {
    const status = window.openpe?.cursorCredentialStatus;
    if (!status) {
      setCursorError('Cursor API key storage requires the desktop app.');
      return;
    }
    let active = true;
    void status()
      .then((value) => {
        if (active) setCursorCredential(value);
      })
      .catch((error: Error) => {
        if (active) setCursorError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  function selectSection(next: string) {
    if (next === 'rules') setVisitedRules(true);
    setSection(next);
  }
  const agentSettings = useAgentSettings();
  const id = useId();
  const sections = [
    { id: 'appearance', label: 'Appearance', icon: Sun },
    { id: 'rules', label: 'Rule', icon: ClipboardCheck },
    { id: 'agents', label: 'Agents', icon: Bot },
  ];
  return (
    <Dialog
      title="Settings"
      className="settings-dialog"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="dialog-button primary"
          onPointerDown={(event) => {
            if (section === 'rules' && ruleActions.current?.isComposing()) event.preventDefault();
          }}
          onClick={() => {
            if (section === 'rules' && ruleSettings && !ruleActions.current?.apply()) return;
            onClose();
          }}
        >
          Done
        </button>
      }
    >
      <div className="settings-layout">
        <nav
          className="settings-sidebar"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = sections.findIndex((item) => item.id === section);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? sections.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + sections.length) %
                    sections.length;
            selectSection(sections[next].id);
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {sections.map(({ id: key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={id + '-' + key + '-tab'}
              aria-controls={id + '-' + key}
              aria-selected={section === key}
              tabIndex={section === key ? 0 : -1}
              onClick={() => selectSection(key)}
            >
              <Icon size={18} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <div
          className="settings-pane"
          role="tabpanel"
          id={id + '-appearance'}
          aria-labelledby={id + '-appearance-tab'}
          hidden={section !== 'appearance'}
          tabIndex={0}
        >
          <div className="settings-pane-content">
            <AppearanceSettings settings={appearance} />
          </div>
        </div>
        <div
          className="settings-pane"
          role="tabpanel"
          id={id + '-rules'}
          aria-labelledby={id + '-rules-tab'}
          hidden={section !== 'rules'}
          tabIndex={0}
        >
          <div className="settings-pane-content">
            {visitedRules &&
              (ruleSettings ? (
                <RuleSettings {...ruleSettings} ref={ruleActions} />
              ) : (
                <>
                  <h3 className="settings-section-heading">Rule</h3>
                  <p>Open a project to configure its design rules.</p>
                </>
              ))}
          </div>
        </div>
        <div
          className="settings-pane"
          role="tabpanel"
          id={id + '-agents'}
          aria-labelledby={id + '-agents-tab'}
          hidden={section !== 'agents'}
          tabIndex={0}
        >
          <div className="settings-pane-content">
            <div className="settings-section-header">
              <h3 className="settings-section-heading">Agents</h3>
              <button
                className="icon-button"
                aria-label="Detect agents"
                title="Detect agents"
                onClick={() => void onDetect()}
                disabled={detecting}
              >
                {detecting ? <LoaderCircle className="spin" size={17} /> : <RotateCw size={17} />}
              </button>
            </div>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="settings-field">
              <span>Messages sent while the Agent is running</span>
              <Select
                label="Messages sent while running"
                value={agentSettings.settings.followUpMode}
                disabled={!agentSettings.ready}
                onChange={(value) => agentSettings.update({ followUpMode: value as FollowUpMode })}
                options={[
                  { value: 'queue', label: 'Queue' },
                  { value: 'steer', label: 'Steer' },
                ]}
              />
              {agentSettings.error && (
                <p className="dialog-error" role="alert">
                  {agentSettings.error}
                </p>
              )}
            </div>
            <div className="agent-connections">
              {agentProviders.map(({ id, settingsName }) => {
                const a = agents.find((a) => a.id === id);
                const installed = a?.installed;
                const cursorStatus = !cursorCredential
                  ? 'Checking API key…'
                  : cursorCredential.configured
                    ? `API key configured · ${cursorCredential.suffix}`
                    : 'API key not configured';
                return (
                  <div className="connection-item" key={id}>
                    <div className={`connection-icon ${id}`}>
                      <AgentLogo provider={id} size={24} />
                    </div>
                    <div>
                      <strong>{settingsName}</strong>
                      <span>
                        {id === 'cursor'
                          ? detecting
                            ? 'Detecting…'
                            : a?.available
                              ? a.version
                                ? `SDK ${a.version}`
                                : cursorStatus
                              : a?.error || cursorStatus
                          : detecting
                            ? 'Detecting…'
                            : a?.available
                              ? a.version || 'CLI detected'
                              : installed
                                ? 'CLI detected · unavailable'
                                : 'Not installed'}
                      </span>
                      {id === 'cursor' && (
                        <form
                          className="cursor-key"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (cursorComposing.current) return;
                            const store = window.openpe?.cursorCredentialStore;
                            if (!store) {
                              setCursorError('Cursor API key storage requires the desktop app.');
                              return;
                            }
                            void store(cursorKey)
                              .then(async (value) => {
                                setCursorCredential(value);
                                setCursorKey('');
                                setCursorError('');
                                await onDetect();
                              })
                              .catch((error: Error) => setCursorError(error.message));
                          }}
                        >
                          <label>
                            Cursor API key
                            <input
                              type="password"
                              autoComplete="off"
                              spellCheck={false}
                              value={cursorKey}
                              onChange={(event) => setCursorKey(event.target.value)}
                              onCompositionStart={() => {
                                cursorComposing.current = true;
                              }}
                              onCompositionEnd={() => {
                                cursorComposing.current = false;
                              }}
                              onKeyDown={(event) => {
                                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                                  event.preventDefault();
                              }}
                            />
                          </label>
                          <div className="cursor-key-actions">
                            <button className="dialog-button primary" type="submit">
                              Save key
                            </button>
                            <button
                              className="dialog-button"
                              type="button"
                              disabled={!cursorCredential?.configured}
                              onClick={() => {
                                if (cursorComposing.current) return;
                                const remove = window.openpe?.cursorCredentialRemove;
                                if (!remove) {
                                  setCursorError('Cursor API key storage requires the desktop app.');
                                  return;
                                }
                                void remove()
                                  .then(async (value) => {
                                    setCursorCredential(value);
                                    setCursorError('');
                                    await onDetect();
                                  })
                                  .catch((error: Error) => setCursorError(error.message));
                              }}
                            >
                              Remove key
                            </button>
                          </div>
                          {cursorError && (
                            <p className="dialog-error" role="alert">
                              {cursorError}
                            </p>
                          )}
                        </form>
                      )}
                    </div>
                    {detecting ? (
                      <LoaderCircle size={18} className="spin muted" />
                    ) : a?.available ? (
                      <span
                        role="img"
                        aria-label={
                          id === 'cursor'
                            ? 'Cursor API key configured; sign-in not verified'
                            : 'CLI detected; sign-in not verified'
                        }
                      >
                        <CheckCircle2 size={19} className="green" />
                      </span>
                    ) : (
                      <span
                        role="img"
                        aria-description={id === 'cursor' ? a?.error || cursorError : a?.error}
                        aria-label={
                          id === 'cursor'
                            ? 'Cursor API key not configured'
                            : installed
                              ? 'CLI unavailable'
                              : 'Not installed'
                        }
                      >
                        <Unplug size={19} className="muted" />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
