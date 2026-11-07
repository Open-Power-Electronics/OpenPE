'use client';
import { useEffect, useState } from 'react';
import { Blocks, FolderPlus, FolderOpen, Home as HomeIcon, Settings } from 'lucide-react';
import { homeExampleCatalog, type HomeExampleId as ExampleId } from '@/lib/home-examples';
import HomeProjectCard from './HomeProjectCard';
import HomeProjectSection from './HomeProjectSection';
import HomeHeroBackdrop from './HomeHeroBackdrop';
import AgentComposer, { type AgentComposerProps } from './AgentComposer';
import NavigationButton from './NavigationButton';
import AgentPicker, { type AgentPickerProps } from './AgentPicker';
import ProjectNavigation, {
  type ProjectNavigationItem,
  type ProjectAction,
} from './ProjectNavigation';
import type { Circuit } from '@/lib/circuit';
import type { useExampleList } from './useExampleList';

// Preview circuits are read-only and separate from fresh project instances.
const previewCache = new Map<ExampleId, Circuit>();

export default function Home({
  active,
  exampleList,
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
  onPlugins,
  composer,
  agentPicker,
}: {
  active: boolean;
  exampleList: ReturnType<typeof useExampleList>;
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
  const [actionError, setActionError] = useState('');
  const { sections, error: discoveryError, revision } = exampleList;
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
        <NavigationButton compact icon={Settings} label="Settings" onClick={onSettings} />
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
            {discoveryError && <p role="alert">{discoveryError}</p>}
            {actionError && <p role="alert">{actionError}</p>}
            <AgentComposer
              {...composer}
              requiresAgent={false}
              className="home-composer"
              input={brief}
              setInput={setBrief}
              inputLabel="Describe your circuit"
              submitLabel="Start project"
              maxLength={16000}
              onSubmit={() => onNew(brief.trim())}
            />
          </div>
          {sections.map((section) => (
            <HomeProjectSection key={section.id} title={section.title}>
              {(expanded) =>
                section.examples.map((example) => (
                  <HomeProjectCard
                    key={example.id}
                    entry={example}
                    active={active && expanded}
                    recent={section.id === 'recent-heading'}
                    revision={revision}
                    preview={previews.get(example.id)}
                    onOpen={onExample}
                    onError={setActionError}
                  />
                ))
              }
            </HomeProjectSection>
          ))}
        </div>
      </section>
    </div>
  );
}
