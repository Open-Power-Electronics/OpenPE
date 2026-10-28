'use client';
import { useId, useState } from 'react';
import { Bot, CheckCircle2, LoaderCircle, RotateCw, Sun, Unplug } from 'lucide-react';
import type { Agent } from './Chat';
import AppearanceSettings, { type useAppearance } from './AppearanceSettings';
import AgentLogo from './AgentLogo';
import Dialog from './Dialog';
import { agentProviders } from '@/lib/agent-providers';

export default function SettingsDialog({
  appearance,
  agents,
  detecting,
  error,
  onDetect,
  onClose,
}: {
  appearance: ReturnType<typeof useAppearance>;
  agents: Agent[];
  detecting: boolean;
  error: string;
  onDetect: () => Promise<void>;
  onClose: () => void;
}) {
  const [section, setSection] = useState('appearance');
  const id = useId();
  const sections = [
    { id: 'appearance', label: 'Appearance', icon: Sun },
    { id: 'agents', label: 'Agents', icon: Bot },
  ];
  return (
    <Dialog
      title="Settings"
      className="settings-dialog"
      onClose={onClose}
      footer={
        <button className="dialog-button primary" onClick={onClose}>
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
            setSection(sections[next].id);
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
              onClick={() => setSection(key)}
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
            <div className="agent-connections">
              {agentProviders.map(({ id, settingsName }) => {
                const a = agents.find((a) => a.id === id);
                const installed = a?.installed;
                return (
                  <div className="connection-item" key={id}>
                    <div className={`connection-icon ${id}`}>
                      <AgentLogo provider={id} size={24} />
                    </div>
                    <div>
                      <strong>{settingsName}</strong>
                      <span>
                        {detecting
                          ? 'Detecting…'
                          : a?.available
                            ? a.version || 'CLI detected'
                            : installed
                              ? 'CLI detected · unavailable'
                              : 'Not installed'}
                      </span>
                    </div>
                    {detecting ? (
                      <LoaderCircle size={18} className="spin muted" />
                    ) : a?.available ? (
                      <span role="img" aria-label="CLI detected; sign-in not verified">
                        <CheckCircle2 size={19} className="green" />
                      </span>
                    ) : (
                      <span
                        role="img"
                        aria-description={a?.error}
                        aria-label={installed ? 'CLI unavailable' : 'Not installed'}
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
