'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, Blocks, FolderPlus, FolderOpen, Home as HomeIcon } from 'lucide-react';
import {
  homeExampleCatalog,
  homeExampleSections,
  type HomeExampleId as ExampleId,
} from '@/lib/home-examples';
import ExamplePreview from './ExamplePreview';
import HomeHeroBackdrop from './HomeHeroBackdrop';
import AgentComposer, { type AgentComposerProps } from './AgentComposer';
import NavigationButton from './NavigationButton';
import SettingsMenu from './SettingsMenu';
import AgentPicker, { type AgentPickerProps } from './AgentPicker';
import ProjectNavigation, {
  type ProjectNavigationItem,
  type ProjectAction,
} from './ProjectNavigation';
import type { Circuit } from '@/lib/circuit';

// Preview circuits are read-only and separate from fresh project instances.
const previewCache = new Map<ExampleId, Circuit>();

export default function Home({
  active,
  brief,
  setBrief,
  projects,
  error,
  onNew,
  onOpen,
  onExample,
  onResume,
  onProjectAction,
  onSettings,
  onAbout,
  onPlugins,
  composer,
  agentPicker,
}: {
  active: boolean;
  brief: string;
  setBrief: (value: string) => void;
  projects: readonly ProjectNavigationItem[];
  error: string;
  onNew: (brief?: string) => void;
  onOpen: () => void;
  onExample: (id: ExampleId) => void;
  onResume: (id: string) => void;
  onProjectAction: (id: string, action: ProjectAction) => void;
  onSettings: () => void;
  onAbout: () => void;
  onPlugins: () => void;
  agentPicker: AgentPickerProps;
  composer: Pick<
    AgentComposerProps,
    | 'provider'
    | 'available'
    | 'agentSupportsEffort'
    | 'effort'
    | 'setEffort'
    | 'approvalMode'
    | 'setApprovalMode'
    | 'model'
    | 'setModel'
    | 'observedModel'
  >;
}) {
  const [previews, setPreviews] = useState(() => new Map(previewCache));
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    if (!active || previewError) return;
    const next = homeExampleCatalog.find((entry) => !previews.has(entry.id));
    if (!next) return;
    // Yield between previews so the hero, input and navigation can paint first.
    // Detached Home instances do no preview work during project recovery.
    let cancelled = false;
    const idle = window.requestIdleCallback(
      () => {
        void (async () => {
          const { createHomeExample } = await import('@/lib/create-home-example');
          if (cancelled) return;
          const circuit = previewCache.get(next.id) ?? createHomeExample(next.id).schematic;
          previewCache.set(next.id, circuit);
          setPreviews((current) => new Map(current).set(next.id, circuit));
        })().catch(() => {
          if (!cancelled) setPreviewError('Could not load example previews. Retry to load them.');
        });
      },
      { timeout: 500 },
    );
    return () => {
      cancelled = true;
      window.cancelIdleCallback(idle);
    };
  }, [active, previews, previewError]);
  return (
    <div className="home-layout">
      <nav className="home-sidebar" aria-label="Home navigation">
        <NavigationButton compact icon={HomeIcon} label="Home" active />
        <NavigationButton compact icon={FolderPlus} label="New project" onClick={() => onNew()} />
        <NavigationButton compact icon={FolderOpen} label="Open project" onClick={onOpen} />
        <NavigationButton compact icon={Blocks} label="Plugins" onClick={onPlugins} />
        <ProjectNavigation
          active={active}
          projects={projects}
          onSelect={onResume}
          onAction={onProjectAction}
        />
        <div className="rail-spacer" />
        <AgentPicker {...agentPicker} compact />
        <SettingsMenu active={active} onSettings={onSettings} onAbout={onAbout} />
      </nav>
      <section className="home-surface" aria-label="Welcome to OpenPE">
        <div className="home-content">
          <div className="home-intro">
            <HomeHeroBackdrop />
            <div className="home-hero">
              <div className="home-brand">
                <img src="/brand/openpe-mark.svg" width="48" height="48" alt="" draggable={false} />
                <span>
                  Open<span className="home-brand-ee">PE</span>
                </span>
              </div>
              <h1>
                What will you <span>Power</span> next, <span>Engineer?</span>
              </h1>
            </div>
            {error && (
              <p className="home-recovery-error" role="alert">
                {error}
              </p>
            )}
            {previewError && (
              <p role="alert">
                {previewError}{' '}
                <button className="secondary" onClick={() => setPreviewError('')}>
                  Retry previews
                </button>
              </p>
            )}
            <AgentComposer
              {...composer}
              className="home-composer"
              input={brief}
              setInput={setBrief}
              inputLabel="Describe your circuit"
              submitLabel="Start project"
              maxLength={16000}
              onSubmit={() => onNew(brief.trim())}
            />
          </div>
          {homeExampleSections.map((section) => (
            <section key={section.id} className="home-examples" aria-labelledby={section.id}>
              <div className="home-section-heading">
                <h2 id={section.id}>{section.title}</h2>
              </div>
              <div className="home-example-list">
                {section.examples.map((example) => (
                  <button
                    key={example.id}
                    className="home-example"
                    onClick={() => onExample(example.id)}
                    aria-label={`Open ${example.title} example`}
                  >
                    <div className="home-example-preview" aria-hidden="true">
                      {previews.has(example.id) && (
                        <ExamplePreview circuit={previews.get(example.id)!} />
                      )}
                    </div>
                    <div className="home-example-description">
                      <div className="home-example-heading">
                        <h3>{example.title}</h3>
                        <ArrowRight size={18} className="home-example-arrow" aria-hidden="true" />
                      </div>
                      <small>{example.description}</small>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
