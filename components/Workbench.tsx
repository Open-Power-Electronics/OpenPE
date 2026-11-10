'use client';
import PropertyDeleteButton from './PropertyDeleteButton';
import { NumberField } from './LayoutPropertyFields';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ProjectCore } from '@/core/project-core';
import { createNativeProjectDirtyChecker } from '@/lib/native-project-dirty';
import { createBlankProject, DEFAULT_PROJECT_FILENAME } from '@/lib/create-blank-project';
import { projectMetadataEqual } from '@/lib/project-metadata-equal';
import { modelCadFromProject, MODEL_CAD_EXTENSION } from '@/lib/model-cad';
import { prepareModelCadObjects } from './model-cad-preparation';
import { createCapabilityHost } from '@/api/capabilities';
import { registerProjectCapabilities } from '@/core/register-project';
import {
  registerWorkbenchCapabilities,
  type WorkbenchCapabilityPorts,
} from '@/lib/workbench-capabilities';
import { registerProviderPluginCapabilities } from '@/lib/provider-plugin-capabilities';
import {
  registerLibraryCapabilities,
  type LibraryCapabilityPorts,
} from '@/lib/library-capabilities';
import {
  registerProjectFileCapabilities,
  type ProjectFileCapabilityPorts,
} from '@/lib/project-file-capabilities';
import type { AgentThermalContext } from '@/context/agent-thermal-context';
import ThermalField, { ThermalFieldMarkers } from './ThermalField';
import ThermalComponentHighlight from './ThermalComponentHighlight';
import { GitIcon, SymbolIcon, WireIcon } from './EditorIcons';
import ThermalLayoutResults, { type ThermalLayoutPresentation } from './ThermalLayoutResults';
import {
  AlertCircle,
  Blocks,
  FolderPlus,
  FolderOpen,
  Grid3X3,
  MessageSquareText,
  Home as HomeIcon,
  List,
  MousePointer2,
  PencilRuler,
  Redo2,
  RotateCw,
  Settings,
  SlidersHorizontal,
  Tag,
  Undo2,
  X,
} from 'lucide-react';
import { circuitFingerprint, labelShapes, fmt, type Circuit, type Point } from '@/lib/circuit';
import { api } from '@/lib/bridge';
import { downloadBytes, downloadText } from '@/lib/download';
import { projectExportFormats, type ProjectExportFormat } from '@/lib/export-formats';
import { projectPCBDesignRules } from '@/lib/kicad-project';
import {
  importDocument,
  parseProject,
  serializeProject,
  projectNativeFiles,
  projectFilename,
  projectFromNativeFiles,
  projectSchematics,
  findSchematic,
  schematicSnapshot,
  schematicFileFingerprint,
  MAX_SCHEMATIC_FILES,
  type Project,
} from '@/lib/project';
import { applyProposal, type Operation } from '@/lib/proposals';
import {
  selectedField,
  objectPosition,
  moveText,
  duplicateSelection,
  pasteSchematicSelection,
  removeSelection,
  transformSelection,
  simplifyWires,
  saveAnnotation,
  saveLabel,
} from '@/lib/schematic-edit';
import Select from './Select';
import SidebarToggle from './SidebarToggle';
import PluginLogo from './PluginLogo';
import EditorDisplayDrawer from './EditorDisplayDrawer';
import SchematicSelectionFilters from './SchematicSelectionFilters';
import Canvas, {
  type Tool,
  type CanvasViewport,
  type SchematicMoveRequest,
  type SchematicNavigationRequest,
} from './Canvas';
import CanvasCoordinates, { createCanvasCoordinates } from './CanvasCoordinates';
import ModelSketchCoordinates, { createModelSketchCoordinates } from './ModelSketchCoordinates';
import { MeasurementReadout } from './CanvasMeasurement';
import { createCanvasMeasurement } from '@/lib/canvas-measurement';
import type { Agent } from './Chat';
import ConversationSession from './ConversationSession';
import {
  createSession,
  openNewSession,
  renameSession,
  sessionTitle,
  updateSession,
  type SessionAction,
  type SessionState,
  type ChatSession,
} from '@/lib/chat-sessions';
import { agentCapabilitiesForHost, type ReasoningEffort } from '@/lib/chat-stream';
import PartIdentity from './PartIdentity';
import Logo from './Logo';
import NavigationButton from './NavigationButton';
import EditorViewSwitch, { type EditorView } from './EditorViewSwitch';
import RevealButton from './RevealButton';
import EditorStatusBar from './EditorStatusBar';
import RuleStatus from './RuleStatus';
const LayoutEditor = lazy(() => import('./LayoutEditor'));
import type { PCB3DViewState } from './PCBModelPreview';
import type { ModelCheckIssue, ModelCheckFocus, ModelCheckReport } from './model-checks';
import type { RuleCheckKind } from './RuleCheckPanel';
import type { RuleSettingsDraft } from './RuleSettings';
const PCBModelPreview = lazy(() => import('./PCBModelPreview'));
import { type PCB, type Footprint } from '@/lib/pcb';
import { findPCBGraphic } from '@/lib/pcb-layout';
import { PCBProjectSync, type LayoutSyncStatus, type SyncedProject } from '@/lib/pcb-project-sync';
import SchematicLayers from './SchematicLayers';
import { visibleSchematicIds } from '@/lib/schematic-view';
import {
  defaultSchematicSelectionFilters,
  selectableSchematicIds,
} from '@/lib/schematic-selection-filters';
import { gridSpacingOptions } from '@/lib/schematic-layers';
import { layoutGridSpacingOptions } from '@/lib/layout-grid';
import AgentPicker from './AgentPicker';
import Home from './Home';
import { useExampleList } from './useExampleList';
import { homeExampleCatalog, type HomeExampleId as ExampleId } from '@/lib/home-examples';
import { hasOpenOverlay } from './Dialog';
import DeferredDialog from './DeferredDialog';
import DesktopTitlebar, {
  titlebarMenuOptions,
  runTitlebarMenuAction,
  type TitlebarMenu,
} from './DesktopTitlebar';
import WorkspaceDivider from './WorkspaceDivider';
import type { useAppearance } from './AppearanceSettings';
import PartsList from './PartsList';
import PropertiesEmptyState from './PropertiesEmptyState';
import ConfirmationDialog, { type ConfirmationKind } from './ConfirmationDialog';
import RenameDialog from './RenameDialog';
import type { FootprintDetail } from './LibraryChooser';
import PartProperties from './PartProperties';
import FootprintModels, { UnassignedModelField } from './FootprintModels';
import FieldProperties from './FieldProperties';
import InspectorResize, { type InspectorSize } from './InspectorResize';
import BottomPanelResize from './BottomPanelResize';
import type { ProbeTarget } from '@/lib/spice';
import AnnotationDialog from './AnnotationDialog';
import { validateAnnotations, type AgentAnnotation } from '@/lib/agent-annotations';
import { captureAgentPresentation } from '@/context/agent-presentation';
import { agentSource, type AgentWorkspaceContext } from '@/context/agent-workspace-context';
import { agentProject, assertAgentSourceDraftSafe } from '@/lib/agent-project-access';
import type { AgentSimulationContext } from '@/context/agent-simulation-context';
import {
  LAYOUT_PARASITICS_PLUGIN_ID,
  SPICE_PLUGIN_ID,
  THERMAL_PLUGIN_ID,
  useWorkbenchPlugins,
  registerLayoutParasiticsCapability,
  registerWorkbenchPluginCapabilities,
} from '@/lib/workbench-plugins';
import { schematicTexts } from '@/lib/schematic-text';
import { displayPartValue, partFields } from '@/lib/library';
import { preparePartGeometry, preparePartProperties } from '@/lib/part-properties';
import { val, type SExpr } from '@/lib/sexpr';
import ProjectNavigation, {
  type ProjectNavigationItem,
  type ProjectFileAction,
  type ProjectAction,
} from './ProjectNavigation';
import { emptyWorkspaceProjects } from './WorkspacePresentation';
import SchematicFileTabs from './SchematicFileTabs';
import type { AgentPreferences, DocumentState } from '@/lib/workspace-state';
import { useProjectDirectory } from './useProjectDirectory';
import { isCloseSnapshotUnsaved, type CloseSnapshot } from '@/lib/workspace-close';
import type { DocumentController, DocumentUpdate } from './DesktopWorkspace';
import {
  pcbDesignRuleLimitKeys,
  type PCBDesignRuleConfig,
  type PCBDesignRuleLimit,
  type RuleCheckFocus,
  type RuleCheckIssue,
  type RuleCheckResult,
  type SchematicRuleSeverities,
} from '@/lib/design-rule-checks';

const SourceEditor = lazy(() => import('./SourceEditor'));
const SimulationDialog = lazy(() => import('./SimulationDialog'));
const ThermalSimulation = lazy(() => import('./ThermalSimulation'));
const LayoutParasiticsPanel = lazy(() => import('./LayoutParasiticsPanel'));
const RuleCheckPanel = lazy(() => import('./RuleCheckPanel'));
const LibraryChooser = lazy(() => import('./LibraryChooser'));
const ComponentDrawingEditor = lazy(() => import('./ComponentDrawingEditor'));
const ProjectHistoryView = lazy(() => import('./ProjectHistoryView'));
const PluginsPage = lazy(() => import('./PluginsPage'));
const SettingsDialog = lazy(() => import('./SettingsDialog'));
const AboutDialog = lazy(() => import('./AboutDialog'));
const SchematicCanvas = memo(Canvas);
const RetainedLayoutEditor = memo(LayoutEditor);
const RetainedModelPreview = memo(PCBModelPreview);
const RetainedSourceEditor = memo(SourceEditor);
const RetainedProjectHistory = memo(
  ProjectHistoryView,
  (previous, next) => !previous.visible && !next.visible,
);
const emptySelection: string[] = [];
const emptyAnnotations: AgentAnnotation[] = [];

type StoredRuleReport = {
  result: RuleCheckResult;
  basis: string;
};

// Synchronous editor actions read the latest committed workbench state without
// changing their prop identity on unrelated conversation/status updates. Async
// annotation/viewport callbacks remain explicitly bound to their origin below.
function useEditorAction<Args extends unknown[], Result>(action: (...args: Args) => Result) {
  const latest = useRef(action);
  useLayoutEffect(() => {
    latest.current = action;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}

const RetainedSchematicToolbar = memo(
  function RetainedSchematicToolbar({ children }: { visible: boolean; children: () => ReactNode }) {
    return children();
  },
  // The first hidden render deactivates menus. Later hidden design updates do
  // not build toolbar JSX; revealing always receives current props/actions.
  (previous, next) => !previous.visible && !next.visible,
);
type Modal =
  | 'power'
  | 'library'
  | 'settings'
  | 'agent-settings'
  | 'erc-settings'
  | 'drc-settings'
  | 'about'
  | 'parts'
  | 'annotation'
  | 'history'
  | 'drawing'
  | null;
type Confirmation = {
  kind: ConfirmationKind;
  action: (saveFirst?: boolean) => void | Promise<void>;
};
function ToolButton({
  label,
  hint = label,
  active,
  disabled,
  buttonRef,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      className={`tool-button ${active ? 'active' : ''}`}
      aria-label={label}
      title={hint}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export default function Workbench({
  documentId,
  active,
  initialState: providedInitialState,
  getInitialState,
  getInitialProject,
  fileId,
  initiallyDirty,
  recovered,
  initialNotice,
  projects = emptyWorkspaceProjects,
  getProjects,
  onSelectProject,
  onNewProjectSession,
  onProjectSessionAction,
  onSelectFile,
  onSelectExample,
  onAddProject,
  onCloseProject,
  onProjectAction,
  onDocumentChange,
  registerController,
  preferences,
  agents,
  detecting,
  agentError,
  detectAgents,
  setPreferences,
  appearanceSettings,
  startupError,
  draftStatus,
}: {
  documentId: string;
  active: boolean;
  initialState?: DocumentState;
  getInitialState?: (id: string) => DocumentState | undefined;
  getInitialProject?: (id: string, source: string) => Project | undefined;
  fileId?: string;
  initiallyDirty: boolean;
  recovered: boolean;
  initialNotice?: string;
  projects?: readonly ProjectNavigationItem[];
  getProjects?: () => ProjectNavigationItem[];
  onSelectProject: (id: string, sessionId?: string) => void;
  onNewProjectSession: (id: string) => void;
  onProjectSessionAction: (projectId: string, sessionId: string, action: SessionAction) => void;
  onSelectFile: (fileId: string) => void;
  onSelectExample: (key: string) => boolean;
  onAddProject: (
    project: Project | (() => Promise<Project>),
    name: string,
    dirty: boolean,
    brief?: string,
    fileId?: string,
    notice?: string,
    openKey?: string,
  ) => Promise<void>;
  onCloseProject: (id: string) => Promise<boolean>;
  onProjectAction: (id: string, action: ProjectAction) => void;
  onDocumentChange: (id: string, state: DocumentUpdate) => void;
  registerController: (id: string, controller: DocumentController | null) => void;
  preferences: AgentPreferences;
  agents: Agent[];
  detecting: boolean;
  agentError: string;
  detectAgents: () => Promise<void>;
  setPreferences: React.Dispatch<React.SetStateAction<AgentPreferences>>;
  appearanceSettings: ReturnType<typeof useAppearance>;
  startupError: string;
  draftStatus?: string;
}) {
  // Workspace supplies a stable accessor so recovery reports do not become
  // render props or retain a second initial conversation/source snapshot.
  const initialState = getInitialState?.(documentId) ?? providedInitialState;
  const prepareProject = useRef<(next: Project) => Project>((next) => next);
  const [core] = useState(
    () =>
      new ProjectCore(
        initialState
          ? (getInitialProject?.(documentId, initialState.source) ??
              importDocument(initialState.source))
          : null,
        {
          draft: initialState?.sourceDraft,
          nativeEntryName: initialState ? projectFilename(initialState.filename) : undefined,
          prepare: (next) => prepareProject.current(next),
        },
      ),
  );
  const coreSnapshot = useSyncExternalStore(
    useCallback((listener) => core.subscribe(listener), [core]),
    () => core.getSnapshot(),
    () => core.getSnapshot(),
  );
  const { project, sourceDraft, sourceError } = coreSnapshot;
  const [renameTarget, setRenameTarget] = useState<
    { kind: 'project'; name: string } | { kind: 'conversation'; id: string; name: string } | null
  >(null);
  const modelCad = useMemo(
    () => (project ? modelCadFromProject(project) : null),
    [project?.extensions[MODEL_CAD_EXTENSION]],
  );
  const [capabilityHost] = useState(() =>
    createCapabilityHost({ revision: () => String(core.getSnapshot().revision) }),
  );
  const resourcePorts = useRef<LibraryCapabilityPorts>({});
  const projectFilePorts = useRef<ProjectFileCapabilityPorts>(null!);
  const listedExampleIds = useRef(new Set(homeExampleCatalog.map((entry) => entry.id)));
  const originRef = useRef({ active, fileId });
  originRef.current = { active, fileId };
  const [activeSchematicId, setActiveSchematicId] = useState(
    initialState?.activeSchematicId ?? project?.schematic.id ?? '',
  );
  const [closedSchematics, setClosedSchematics] = useState<string[]>(
    initialState?.closedSchematicIds ?? [],
  );
  const schematicFiles = useMemo(() => (project ? projectSchematics(project) : []), [project]);
  const openSchematicFiles = useMemo(() => {
    const visible = schematicFiles.filter((file) => !closedSchematics.includes(file.id));
    return visible.length ? visible : schematicFiles.slice(0, 1);
  }, [schematicFiles, closedSchematics]);
  const doc =
    openSchematicFiles.find((file) => file.id === activeSchematicId) ??
    openSchematicFiles[0] ??
    null;
  const closedSchematicIds = useMemo(
    () =>
      schematicFiles.filter((file) => !openSchematicFiles.includes(file)).map((file) => file.id),
    [schematicFiles, openSchematicFiles],
  );
  const closedSchematicIdsRef = useRef(closedSchematicIds);
  closedSchematicIdsRef.current = closedSchematicIds;
  const activeSchematicRef = useRef(doc?.id);
  activeSchematicRef.current = doc?.id;
  const projectRef = useRef(project);
  projectRef.current = project;
  const source = coreSnapshot.source;
  const sourceDraftRef = useRef(sourceDraft);
  sourceDraftRef.current = sourceDraft;
  const sourcePending = sourceDraft !== null && sourceDraft !== source;
  const [selectedSourceFile, setSelectedSourceFile] = useState('');
  const [datasheetReader, setDatasheetReader] = useState<
    typeof import('@/lib/example-datasheets') | null
  >(null);
  const [screen, setScreen] = useState<'home' | 'workspace' | 'plugins'>(
    initialState ? 'workspace' : 'home',
  );
  const exampleList = useExampleList(active, screen);
  const beforePlugins = useRef<'home' | 'workspace'>(initialState ? 'workspace' : 'home');
  const [homeBrief, setHomeBrief] = useState('');
  function openPlugins() {
    cancelPendingNavigation();
    if (screen !== 'plugins') beforePlugins.current = screen;
    setModal(null);
    setScreen('plugins');
  }
  const documentKey = documentId;
  const contextActive = useRef(active);
  contextActive.current = active;
  const [fileSelections, setFileSelections] = useState<Record<string, string[]>>({});
  const selection = fileSelections[doc?.id ?? ''] ?? emptySelection;
  const setCanvasSelection = useCallback((next: string[] | ((current: string[]) => string[])) => {
    const id = activeSchematicRef.current;
    if (!id) return;
    setFileSelections((previous) => {
      const current = previous[id] ?? emptySelection;
      const value = typeof next === 'function' ? next(current) : next;
      return value === current ||
        (value.length === current.length && value.every((item, index) => item === current[index]))
        ? previous
        : { ...previous, [id]: value };
    });
  }, []);
  const [inspectedPartId, setInspectedPartId] = useState<string | null>(null);
  const [explicitPropertiesId, setExplicitPropertiesId] = useState<string | null>(null);
  const [propertiesDismissed, setPropertiesDismissed] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [modelMode, setModelMode] = useState('Interaction mode');
  const [modelErrorTarget, setModelErrorTarget] = useState<HTMLSpanElement | null>(null);
  const moveRequestSequence = useRef(0);
  const [schematicMoveMode, setSchematicMoveMode] = useState<'move' | 'drag' | null>(null);
  const [schematicMoveRequest, setSchematicMoveRequest] = useState<SchematicMoveRequest | null>(
    null,
  );
  const navigationRequestSequence = useRef(0);
  const [schematicNavigationRequest, setSchematicNavigationRequest] = useState<
    (SchematicNavigationRequest & { revision: number }) | null
  >(null);
  useEffect(() => {
    setSchematicMoveRequest((request) => (request?.schematicId === doc?.id ? request : null));
  }, [doc?.id]);
  const setSelection = useCallback(
    (next: string[] | ((current: string[]) => string[])) => {
      setPropertiesDismissed(false);
      setInspectedPartId(null);
      setExplicitPropertiesId(null);
      setCanvasSelection(next);
    },
    [setCanvasSelection],
  );
  const activeSelection = selection.at(-1) || null;
  const selected = inspectedPartId || selectedField(activeSelection)?.id || activeSelection;
  const setSelected = useCallback(
    (id: string | null) => setSelection(id ? [id] : emptySelection),
    [setSelection],
  );
  const clipboard = useRef<{ doc: Circuit; ids: string[] } | null>(null);
  const [probe, setProbe] = useState<ProbeTarget | null>(null);
  const [simulationEnabled, setSimulationEnabled] = useState(false);
  const workbenchPlugins = useWorkbenchPlugins();
  const spiceAvailable = !!workbenchPlugins.catalog?.plugins.some(
    (plugin) => plugin.id === SPICE_PLUGIN_ID && plugin.installed && plugin.enabled,
  );
  const thermalAvailable = !!workbenchPlugins.catalog?.plugins.some(
    (plugin) => plugin.id === THERMAL_PLUGIN_ID && plugin.installed && plugin.enabled,
  );
  const parasiticsAvailable = !!workbenchPlugins.catalog?.plugins.some(
    (plugin) => plugin.id === LAYOUT_PARASITICS_PLUGIN_ID && plugin.installed && plugin.enabled,
  );
  const [layoutAnalysis, setLayoutAnalysis] = useState<'thermal' | 'parasitics' | null>(null);
  const thermalEnabled = layoutAnalysis === 'thermal';
  const parasiticsButton = useRef<HTMLButtonElement>(null);
  const closeThermal = useCallback(
    () => setLayoutAnalysis((current) => (current === 'thermal' ? null : current)),
    [],
  );
  const [thermalOpened, setThermalOpened] = useState(false);
  const [thermalPresentation, setThermalPresentation] = useState<ThermalLayoutPresentation | null>(
    null,
  );
  const [thermalSelectedFootprint, setThermalSelectedFootprint] = useState<Footprint | null>(null);
  const [layoutAnalysisPanelTarget, setLayoutAnalysisPanelTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const layoutAnalysisPanelMount = useMemo(
    () => <div style={{ display: 'contents' }} ref={setLayoutAnalysisPanelTarget} />,
    [],
  );
  const thermalAgentContext = useRef<(() => AgentThermalContext) | null>(null);
  const thermalLocateRef = useRef<((footprintId: string) => boolean) | null>(null);
  useEffect(() => {
    if (!thermalAvailable) closeThermal();
  }, [thermalAvailable, closeThermal]);
  useEffect(() => {
    if (spiceAvailable) return;
    setSimulationEnabled(false);
    setWaveformRequested(false);
    setProbe(null);
  }, [spiceAvailable]);
  // Keep simulation state resident after first use without preparing a netlist on startup.
  const [simulationOpened, setSimulationOpened] = useState(false);
  const simulationAgentContext = useRef<(() => AgentSimulationContext) | null>(null);
  const simulationSettingsHost = useRef<HTMLDivElement>(null);
  const waveformHost = useRef<HTMLDivElement>(null);
  const [waveformRequested, setWaveformRequested] = useState(false);
  const simulationProject = useMemo(
    () =>
      spiceAvailable && simulationOpened && project && doc
        ? schematicSnapshot(project, doc.id)
        : null,
    [spiceAvailable, simulationOpened, project, doc],
  );
  const [placement, setPlacement] = useState<{ symbol: SExpr; unit: number }>();
  const [modal, setModal] = useState<Modal>(null);
  const [annotationTarget, setAnnotationTarget] = useState<(Point & { id?: string }) | null>(null);
  const propertiesInspector = useRef<HTMLElement>(null);
  const propertiesDock = useRef<HTMLDivElement>(null);
  const [propertiesFocusRequest, setPropertiesFocusRequest] = useState<{
    schematicId: string;
    objectId: string;
  } | null>(null);
  const [inspectorSize, setInspectorSize] = useState<InspectorSize>({});
  const [propertiesExpanded, setPropertiesExpanded] = useState(true);
  const [partsSize, setPartsSize] = useState<InspectorSize>({});
  const [schematicVisualizationOpen, setSchematicVisualizationOpen] = useState(true);
  const [selectionFilters, setSelectionFilters] = useState(defaultSchematicSelectionFilters);
  const [hasNativeTitlebar, setHasNativeTitlebar] = useState(true);
  useEffect(() => {
    setHasNativeTitlebar(window.openpe?.titleBarOverlay === true);
  }, []);
  const schematicTabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active && screen === 'workspace')
      schematicTabs.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, screen, doc?.id]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationRef = useRef(confirmation);
  confirmationRef.current = confirmation;
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const nativeFileBusy = useRef(false);
  const confirmBusyRef = useRef(false);
  const [view, setView] = useState<EditorView>(sourceDraft !== null ? 'source' : 'canvas');
  const canShowParasitics =
    active &&
    screen === 'workspace' &&
    view === 'layout' &&
    parasiticsAvailable &&
    !sourcePending &&
    !coreSnapshot.editingBlocked &&
    Boolean(project?.pcb);
  useEffect(() => {
    if (!canShowParasitics)
      setLayoutAnalysis((current) => (current === 'parasitics' ? null : current));
  }, [canShowParasitics]);
  // Source stays mounted after first use, retaining its text history across views.
  const [sourceOpened, setSourceOpened] = useState(sourceDraft !== null);
  const [gitOpened, setGitOpened] = useState(false);
  const [gitDestination, setGitDestination] = useState(0);
  const sourceVisible = active && screen === 'workspace' && view === 'source';
  const retainedNativeSource = useRef<ReturnType<ProjectCore['getNativeFiles']>>({
    entry: '',
    files: [],
  });
  const nativeSource = useMemo(() => {
    if (!project) return { entry: '', files: [] };
    if (sourceVisible || sourceDraft !== null) return core.getNativeFiles();
    // Hidden editors keep their presentation snapshot. Reveal reads the current
    // Core synchronously, before CodeMirror's layout-effect synchronization.
    return retainedNativeSource.current;
  }, [core, project, sourceDraft, sourceVisible]);
  useLayoutEffect(() => {
    // An abandoned render cannot publish an uncommitted Source baseline.
    retainedNativeSource.current = nativeSource;
  }, [nativeSource]);
  const sourceFileFrom = (files: ReturnType<ProjectCore['getNativeFiles']>['files']) =>
    files.find((file) => file.name === selectedSourceFile) ?? files[0];
  const [layoutOpened, setLayoutOpened] = useState(false);
  const [objectOpened, setObjectOpened] = useState(false);
  const [modelDrawingBlocked, setModelDrawingBlocked] = useState(false);
  const pcb3DView = useRef<PCB3DViewState | null>(null);
  const layoutAgentContext = useRef<Record<string, unknown> | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const toggleSidebar = useCallback(() => setSidebarVisible((value) => !value), []);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  const showRightSidebar = useCallback(() => setRightSidebarVisible(true), []);
  const toggleRightSidebar = useCallback(() => setRightSidebarVisible((value) => !value), []);
  const schematicNavigationEligible = Boolean(
    schematicNavigationRequest &&
    active &&
    screen === 'workspace' &&
    view === 'canvas' &&
    !modal &&
    !confirmation &&
    sourceDraft === null &&
    !coreSnapshot.editingBlocked &&
    schematicNavigationRequest.revision === coreSnapshot.revision &&
    schematicNavigationRequest.basis === doc &&
    schematicNavigationRequest.tool === tool,
  );
  useLayoutEffect(() => {
    if (schematicNavigationRequest && !schematicNavigationEligible)
      setSchematicNavigationRequest(null);
  }, [schematicNavigationRequest, schematicNavigationEligible]);
  function queueSchematicNavigation(nextTool: Tool, partId?: string, cancelPending = false) {
    const snapshot = core.getSnapshot();
    const basis = snapshot.project
      ? findSchematic(snapshot.project, activeSchematicRef.current ?? '')
      : null;
    if (
      !active ||
      screen !== 'workspace' ||
      !basis ||
      snapshot.sourceDraft !== null ||
      snapshot.editingBlocked ||
      (partId && !basis.parts.some((part) => part.id === partId))
    )
      return;
    setPropertiesFocusRequest(null);
    setSchematicNavigationRequest({
      id: ++navigationRequestSequence.current,
      basis,
      revision: snapshot.revision,
      tool: nextTool,
      ...(partId ? { partId } : {}),
      ...(cancelPending ? { cancelPending } : {}),
    });
  }
  const rightSidebarAvailable =
    screen === 'workspace' &&
    Boolean(doc) &&
    view !== 'source' &&
    (view !== '3d' || Boolean(project?.pcb));
  const simulationVisible = spiceAvailable && simulationEnabled && view === 'canvas';
  const thermalVisible = thermalAvailable && thermalEnabled && view === 'layout';
  const parasiticsVisible = canShowParasitics && layoutAnalysis === 'parasitics';
  const [parasiticsTerminals, setParasiticsTerminals] = useState<
    readonly { id: string; netId: string }[]
  >([]);
  const parasiticsComposing = useRef(false);
  useLayoutEffect(() => {
    setParasiticsTerminals((current) => (current.length ? [] : current));
  }, [parasiticsVisible, coreSnapshot.revision]);
  const layoutAnalysisVisible = thermalVisible || parasiticsVisible;
  const showLayoutSidebar = useCallback(() => {
    setLayoutAnalysis(null);
    showRightSidebar();
  }, [showRightSidebar]);
  const showSchematicSidebar = useCallback(() => {
    setSimulationEnabled(false);
    showRightSidebar();
  }, [showRightSidebar]);
  const ordinarySidebarVisible =
    rightSidebarVisible && !layoutAnalysisVisible && !simulationVisible;
  const toggleCurrentRightSidebar = layoutAnalysisVisible
    ? showLayoutSidebar
    : simulationVisible
      ? showSchematicSidebar
      : toggleRightSidebar;
  const ruleKind: RuleCheckKind = view === '3d' ? 'model' : view === 'layout' ? 'drc' : 'erc';
  const [openRuleView, setOpenRuleView] = useState<EditorView | null>(null);
  const rulesOpen = openRuleView === view ? ruleKind : null;
  const rulePanelId = useId();
  const ruleStatusButton = useRef<HTMLButtonElement>(null);
  const ruleOpenRefresh = useRef<EditorView | null>(null);
  const [ruleDRCDraftPending, setRuleDRCDraftPending] = useState(false);
  const rulePanelVisible =
    rulesOpen !== null && active && screen === 'workspace' && !modal && !confirmation;
  const [modelCheckReport, setModelCheckReport] = useState<ModelCheckReport | null>(null);
  const [modelCheckFocus, setModelCheckFocus] = useState<ModelCheckFocus | null>(null);
  const onModelChecksChange = useEditorAction((report: ModelCheckReport) => {
    const current = core.getSnapshot().project;
    if (report.board === current?.pcb && report.schematic === current?.schematic)
      setModelCheckReport(report);
  });
  const currentModelCheckReport =
    modelCheckReport?.board === project?.pcb && modelCheckReport?.schematic === project?.schematic
      ? modelCheckReport
      : null;
  const [ruleReports, setRuleReports] = useState<Record<'erc' | 'drc', StoredRuleReport | null>>({
    erc: null,
    drc: null,
  });
  const [ruleBusy, setRuleBusy] = useState<{ kind: 'erc' | 'drc'; automatic: boolean } | null>(
    null,
  );
  const [ruleErrors, setRuleErrors] = useState({ erc: '', drc: '' });
  const ruleFailureBasis = useRef<{ erc: string | null; drc: string | null }>({
    erc: null,
    drc: null,
  });
  const [drcSeverities, setDRCSeverities] = useState<PCBDesignRuleConfig['severities']>({});
  const nativeFiles = project?.nativeFiles;
  const drcSettings = useMemo(
    () => ({ ...projectPCBDesignRules(nativeFiles), severities: drcSeverities }),
    [nativeFiles, drcSeverities],
  );
  const [ercSeverities, setERCSeverities] = useState<SchematicRuleSeverities>({});
  const ruleSettingsDraft = useRef<RuleSettingsDraft | null>(null);
  const retainedDRCQuickLimits = useRef<readonly PCBDesignRuleLimit[]>([]);
  const ruleBases = useMemo(
    () => ({
      erc: JSON.stringify([coreSnapshot.revision, doc?.id, ercSeverities]),
      drc: JSON.stringify([coreSnapshot.revision, project?.pcb?.id, drcSettings]),
    }),
    [coreSnapshot.revision, doc?.id, ercSeverities, project?.pcb?.id, drcSettings],
  );
  const applyBasicDRCSettings = useEditorAction((settings: PCBDesignRuleConfig) => {
    const snapshot = core.getSnapshot();
    if (
      !active ||
      screen !== 'workspace' ||
      !snapshot.project ||
      snapshot.sourceDraft !== null ||
      snapshot.editingBlocked
    )
      return false;
    const thresholds = Object.fromEntries(
      pcbDesignRuleLimitKeys
        .filter((key) => settings[key] !== drcSettings[key])
        .map((key) => [key, settings[key]]),
    );
    if (!Object.keys(thresholds).length) return true;
    try {
      core.execute('layout.drc.settings', { boardId: snapshot.project.pcb?.id, thresholds });
    } catch (error) {
      notify((error as Error).message);
      return false;
    }
    const retained = ruleSettingsDraft.current;
    if (retained && !retained.resetToDefault) {
      const limits = { ...retained.limits };
      for (const key of pcbDesignRuleLimitKeys)
        if (Number(limits[key]) === drcSettings[key] && limits[key].trim())
          limits[key] = String(settings[key]);
      ruleSettingsDraft.current = { ...retained, limits };
    }
    return true;
  });
  const applyRuleSettings = useEditorAction(
    (erc: SchematicRuleSeverities, drc: PCBDesignRuleConfig) => {
      const snapshot = core.getSnapshot();
      if (
        !active ||
        screen !== 'workspace' ||
        !snapshot.project ||
        snapshot.sourceDraft !== null ||
        snapshot.editingBlocked
      )
        return false;
      if (!applyBasicDRCSettings(drc)) return false;
      setERCSeverities(erc);
      setDRCSeverities(drc.severities);
      return true;
    },
  );
  const [ruleFocus, setRuleFocus] = useState<(RuleCheckFocus & { kind: 'erc' | 'drc' }) | null>(
    null,
  );
  const ruleFocusSequence = useRef(0);
  const ruleWork = useRef<AbortController | null>(null);
  const ruleInput = useRef({
    lastActivity: -Infinity,
    heldPointers: new Set<number>(),
    resume: null as (() => void) | null,
  });
  useEffect(() => {
    if (!active || screen !== 'workspace') return;
    const input = ruleInput.current;
    const noteActivity = () => {
      input.lastActivity = performance.now();
    };
    const startPointer = (event: PointerEvent) => {
      input.heldPointers.add(event.pointerId);
      noteActivity();
    };
    const endPointer = (event: PointerEvent) => {
      input.heldPointers.delete(event.pointerId);
      noteActivity();
      if (!input.heldPointers.size) input.resume?.();
    };
    const resetPointers = () => {
      input.heldPointers.clear();
      noteActivity();
      input.resume?.();
    };
    const activityEvents = ['pointermove', 'wheel', 'keydown', 'keyup', 'input'] as const;
    for (const event of activityEvents)
      window.addEventListener(event, noteActivity, { capture: true, passive: true });
    window.addEventListener('pointerdown', startPointer, true);
    window.addEventListener('pointerup', endPointer, true);
    window.addEventListener('pointercancel', endPointer, true);
    window.addEventListener('blur', resetPointers);
    return () => {
      for (const event of activityEvents) window.removeEventListener(event, noteActivity, true);
      window.removeEventListener('pointerdown', startPointer, true);
      window.removeEventListener('pointerup', endPointer, true);
      window.removeEventListener('pointercancel', endPointer, true);
      window.removeEventListener('blur', resetPointers);
      resetPointers();
    };
  }, [active, screen]);
  const ruleLifetime = useRef({ active, screen, view, schematicId: doc?.id });
  ruleLifetime.current = { active, screen, view, schematicId: doc?.id };
  useEffect(() => {
    ruleWork.current?.abort();
    ruleWork.current = null;
    setRuleBusy(null);
    if (!active || screen !== 'workspace') {
      ruleOpenRefresh.current = null;
      setOpenRuleView(null);
    }
    return () => ruleWork.current?.abort();
  }, [active, screen, view, project, sourceDraft, doc?.id, coreSnapshot.editingBlocked]);
  useEffect(() => {
    setRuleFocus(null);
    setModelCheckFocus(null);
  }, [active, screen, project, sourceDraft, doc?.id, coreSnapshot.editingBlocked]);
  useEffect(() => {
    if (ruleOpenRefresh.current !== view) ruleOpenRefresh.current = null;
    setOpenRuleView((current) => (current === view ? current : null));
    if (view !== '3d') {
      setModelCheckFocus(null);
    }
    setRuleFocus((focus) =>
      focus && view === (focus.kind === 'erc' ? 'canvas' : 'layout') ? focus : null,
    );
  }, [view]);
  const currentRuleReport = rulesOpen && rulesOpen !== 'model' ? ruleReports[rulesOpen] : null;
  const ruleReportStale =
    rulesOpen && rulesOpen !== 'model'
      ? !!currentRuleReport && currentRuleReport.basis !== ruleBases[rulesOpen]
      : false;
  const closeRuleChecks = useCallback(() => {
    ruleOpenRefresh.current = null;
    ruleWork.current?.abort();
    ruleWork.current = null;
    setRuleBusy(null);
    setOpenRuleView(null);
    setRuleFocus(null);
  }, []);
  const dismissRulePanel = useCallback(() => {
    closeRuleChecks();
    ruleStatusButton.current?.focus({ preventScroll: true });
  }, [closeRuleChecks]);
  useEffect(() => {
    if (rulesOpen && (modal || confirmation)) closeRuleChecks();
  }, [rulesOpen, modal, confirmation, closeRuleChecks]);
  const openRuleChecks = useEditorAction(() => {
    const snapshot = core.getSnapshot();
    if (
      !active ||
      screen !== 'workspace' ||
      modal ||
      confirmation ||
      snapshot.sourceDraft !== null ||
      snapshot.editingBlocked ||
      (ruleKind !== 'erc' && !snapshot.project?.pcb)
    )
      return;
    ruleWork.current?.abort();
    ruleWork.current = null;
    setRuleBusy(null);
    ruleOpenRefresh.current = ruleKind === 'model' ? null : view;
    setRuleDRCDraftPending(false);
    setOpenRuleView(view);
    setRuleFocus(null);
  });
  async function runRuleChecks(
    kind: 'erc' | 'drc',
    settings?: PCBDesignRuleConfig,
    automatic = false,
  ) {
    const before = core.getSnapshot();
    if (!ruleLifetime.current.active || ruleLifetime.current.screen !== 'workspace') return;
    if (!before.project || !doc || ruleWork.current) return;
    if (before.sourceDraft !== null || before.editingBlocked) return;
    if (kind === 'drc' && settings && !applyBasicDRCSettings(settings)) return;
    const snapshot = core.getSnapshot();
    if (!snapshot.project) return;
    const config = {
      ...projectPCBDesignRules(snapshot.project.nativeFiles),
      severities: drcSeverities,
    };
    const basis =
      kind === 'erc'
        ? JSON.stringify([snapshot.revision, doc.id, ercSeverities])
        : JSON.stringify([snapshot.revision, snapshot.project.pcb?.id, config]);
    ruleOpenRefresh.current = null;
    const controller = new AbortController();
    ruleWork.current = controller;
    setRuleBusy({ kind, automatic });
    setRuleErrors((current) => ({ ...current, [kind]: '' }));
    ruleFailureBasis.current[kind] = null;
    if (!automatic) setRuleFocus(null);
    const schematicId = doc.id;
    const isCurrent = () => {
      const lifetime = ruleLifetime.current;
      return (
        !controller.signal.aborted &&
        ruleWork.current === controller &&
        lifetime.active &&
        lifetime.screen === 'workspace' &&
        lifetime.view === view &&
        lifetime.schematicId === schematicId &&
        core.getSnapshot().revision === snapshot.revision
      );
    };
    try {
      if (kind === 'drc' && (layoutSyncStatus.pending || layoutSyncStatus.error))
        throw new Error(
          layoutSyncStatus.error || 'Wait for footprint synchronization before running DRC.',
        );
      const result = (await capabilityHost.query(
        kind === 'erc' ? 'schematic.erc' : 'layout.drc',
        kind === 'erc'
          ? { schematicId, settings: { severities: ercSeverities } }
          : { boardId: snapshot.project.pcb?.id, settings: { severities: drcSeverities } },
        { signal: controller.signal },
      )) as RuleCheckResult;
      if (!isCurrent()) return;
      setRuleReports((current) => ({
        ...current,
        [kind]: {
          result,
          basis,
        },
      }));
    } catch (error) {
      if (isCurrent()) {
        ruleFailureBasis.current[kind] = basis;
        setRuleErrors((current) => ({ ...current, [kind]: (error as Error).message }));
      }
    } finally {
      if (ruleWork.current === controller) {
        ruleWork.current = null;
        setRuleBusy(null);
      }
    }
  }
  const requestRuleCheck = useEditorAction((kind: 'erc' | 'drc', queuedView: EditorView) => {
    if (view !== queuedView || modal || confirmation) return;
    if (
      kind === 'drc' &&
      (layoutSyncStatus.pending || layoutSyncStatus.error || (rulesOpen && ruleDRCDraftPending))
    )
      return;
    void runRuleChecks(kind, undefined, true);
  });
  async function locateRuleIssue(issue: RuleCheckIssue) {
    if (
      !rulesOpen ||
      rulesOpen === 'model' ||
      ruleReportStale ||
      sourcePending ||
      coreSnapshot.editingBlocked
    )
      return;
    const kind = rulesOpen;
    const targetView = kind === 'erc' ? 'canvas' : 'layout';
    const panel = document.getElementById(rulePanelId);
    const revision = coreSnapshot.revision;
    const schematicId = doc?.id;
    if (!(await changeView(targetView))) return;
    if (
      core.getSnapshot().revision !== revision ||
      core.getSnapshot().sourceDraft !== null ||
      core.getSnapshot().editingBlocked ||
      activeSchematicRef.current !== schematicId ||
      !ruleLifetime.current.active ||
      ruleLifetime.current.screen !== 'workspace'
    )
      return;
    if (kind === 'erc') {
      setTool('select');
      const selectable = selectableSchematicIds(doc!, layers, selectionFilters);
      setSelection(issue.objectIds.filter((id) => selectable.has(id)));
      setPropertiesDismissed(true);
    }
    setRuleFocus({
      kind,
      request: ++ruleFocusSequence.current,
      objectIds: issue.objectIds,
      occludedWidth: panel ? panel.offsetWidth + panel.offsetLeft : 0,
      ...(issue.location ? { location: issue.location } : {}),
    });
    if (view !== targetView) setOpenRuleView(targetView);
  }
  async function locateModelCheckIssue(issue: ModelCheckIssue) {
    const report = currentModelCheckReport;
    const snapshot = core.getSnapshot();
    if (
      rulesOpen !== 'model' ||
      !active ||
      screen !== 'workspace' ||
      !report ||
      report.state !== 'ready' ||
      !report.canLocate ||
      !issue.footprintId ||
      !report.issues.includes(issue) ||
      snapshot.sourceDraft !== null ||
      snapshot.editingBlocked ||
      report.board !== snapshot.project?.pcb ||
      report.schematic !== snapshot.project?.schematic
    )
      return;
    if (!(await changeView('3d'))) return;
    const latest = core.getSnapshot();
    if (
      latest.revision !== snapshot.revision ||
      latest.sourceDraft !== null ||
      latest.editingBlocked ||
      !ruleLifetime.current.active ||
      ruleLifetime.current.screen !== 'workspace' ||
      latest.project?.pcb !== report.board
    )
      return;
    setModelCheckFocus({
      request: ++ruleFocusSequence.current,
      board: report.board,
      footprintId: issue.footprintId,
    });
  }

  const [navigation, setNavigation] = useState<{
    documentKey: string;
    entries: { screen: 'home' | 'workspace' | 'plugins'; view: EditorView }[];
    index: number;
  }>({ documentKey, entries: [{ screen: 'home', view: 'canvas' }], index: 0 });
  useEffect(() => {
    setNavigation((current) => {
      const next = { screen, view };
      if (current.documentKey !== documentKey) return { documentKey, entries: [next], index: 0 };
      const entry = current.entries[current.index];
      if (entry.screen === screen && (screen !== 'workspace' || entry.view === view))
        return current;
      const entries = [...current.entries.slice(0, current.index + 1), next].slice(-40);
      return { documentKey, entries, index: entries.length - 1 };
    });
  }, [screen, view, documentKey]);
  async function navigateHistory(delta: number) {
    const index = navigation.index + delta;
    const target = navigation.entries[index];
    if (!target || (target.screen === 'workspace' && (!doc || !(await changeView(target.view)))))
      return;
    if (target.screen !== 'workspace') cancelPendingNavigation();
    setNavigation((current) => ({ ...current, index }));
    setScreen(target.screen);
  }

  const { provider, effort, approvalMode, models } = preferences;
  const setProvider = useCallback(
    (provider: string) => setPreferences((p) => ({ ...p, provider })),
    [setPreferences],
  );
  const setEffort = useCallback(
    (effort: ReasoningEffort) => setPreferences((p) => ({ ...p, effort })),
    [setPreferences],
  );
  const setApprovalMode = useCallback(
    (approvalMode: 'review' | 'auto') => setPreferences((p) => ({ ...p, approvalMode })),
    [setPreferences],
  );
  const setModels = useCallback(
    (update: (models: Record<string, string>) => Record<string, string>) =>
      setPreferences((p) => ({ ...p, models: update(p.models) })),
    [setPreferences],
  );
  const [sessionState, setSessionState] = useState<SessionState>(() => {
    const sessions = initialState?.sessions ?? [createSession()];
    return { sessions, activeSessionId: initialState?.activeSessionId ?? sessions[0].id };
  });
  const { sessions, activeSessionId } = sessionState;
  const setSessions = useCallback((update: React.SetStateAction<ChatSession[]>) => {
    setSessionState((current) => {
      const sessions = typeof update === 'function' ? update(current.sessions) : update;
      return sessions === current.sessions ? current : { ...current, sessions };
    });
  }, []);
  const setActiveSessionId = useCallback((id: string) => {
    setSessionState((current) =>
      current.activeSessionId === id ? current : { ...current, activeSessionId: id },
    );
  }, []);
  const [runningSessions, setRunningSessions] = useState<Record<string, boolean>>({});
  const onRunningChange = useCallback((id: string, running: boolean) => {
    setRunningSessions((current) => {
      if (Boolean(current[id]) === running) return current;
      const next = { ...current };
      if (running) next[id] = true;
      else delete next[id];
      return next;
    });
  }, []);
  const [filename, setFilename] = useState(initialState?.filename ?? DEFAULT_PROJECT_FILENAME);
  const [localExample, setLocalExample] = useState(initialState?.localExample);
  const [cleanSource, setCleanSource] = useState<string | null>(initiallyDirty ? null : source);
  const cleanSourceRef = useRef(cleanSource);
  cleanSourceRef.current = cleanSource;
  const filenameRef = useRef(filename);
  filenameRef.current = filename;
  const directoryObservation = useProjectDirectory(
    fileId,
    filename,
    sourceVisible,
    nativeSource.files.some((file) => file.name === selectedSourceFile) ? '' : selectedSourceFile,
  );
  const sourceFiles = useMemo(() => {
    const nativeNames = new Set(nativeSource.files.map((file) => file.name));
    return [
      ...nativeSource.files,
      ...directoryObservation.files.filter((file) => !nativeNames.has(file.name)),
    ];
  }, [nativeSource.files, directoryObservation.files]);
  const activeSourceFile = sourceFileFrom(sourceFiles);
  const sourceReadOnly =
    !!activeSourceFile && 'readOnly' in activeSourceFile && activeSourceFile.readOnly;
  const diskObservationSelected =
    directoryObservation.files.some((file) => file.name === selectedSourceFile) &&
    !nativeSource.files.some((file) => file.name === selectedSourceFile);
  const [nativeProjectDirty] = useState(createNativeProjectDirtyChecker);
  const dirty = useMemo(
    () => nativeProjectDirty(project, cleanSource, filename),
    [project, cleanSource, filename],
  );
  const unsaved = dirty || sourcePending || directoryObservation.pending;
  const savedProject = useMemo(() => {
    if (!cleanSource) return null;
    const current = core.getSnapshot();
    // The same validated Core snapshot is already the exact saved baseline.
    // Retain it until the baseline changes, independently of later live edits.
    return current.source === cleanSource ? current.project : parseProject(cleanSource);
  }, [core, cleanSource]);
  const savedSchematics = useMemo(
    () =>
      savedProject
        ? new Map(
            projectSchematics(savedProject).map((file) => [
              file.id,
              schematicFileFingerprint(savedProject, file.id),
            ]),
          )
        : new Map<string, string>(),
    [savedProject],
  );
  const currentSchematics = useMemo(
    () =>
      new Map(schematicFiles.map((file) => [file.id, schematicFileFingerprint(project!, file.id)])),
    [project, schematicFiles],
  );
  const projectMetadataDirty = useMemo(
    () => !!project && !projectMetadataEqual(project, savedProject),
    [project?.name, project?.pcb, project?.extensions, savedProject],
  );
  const [toast, setToast] = useState<{ text: string; dismissible: boolean } | null>(null);
  const layers = useMemo(
    () => ({
      ...appearanceSettings.appearance.schematicLayers,
      symbols: true,
      wires: true,
      labels: true,
      noConnects: true,
    }),
    [appearanceSettings.appearance.schematicLayers],
  );
  const grid = layers.grid;
  const gridSpacing = appearanceSettings.appearance.gridSpacing;
  const layoutGridSpacing = appearanceSettings.appearance.layoutGridSpacing;
  const modelGridSpacing = appearanceSettings.appearance.modelGridSpacing;
  const selectableIds = useMemo(
    () => (doc ? selectableSchematicIds(doc, layers, selectionFilters) : null),
    [doc, layers, selectionFilters],
  );
  useEffect(() => {
    if (!selectableIds) return;
    setCanvasSelection((current) =>
      current.some((id) => !selectableIds.has(id))
        ? current.filter((id) => selectableIds.has(id))
        : current,
    );
  }, [selectableIds, selection, setCanvasSelection]);
  const [fitKey, setFitKey] = useState(1);
  const [coordinates] = useState(createCanvasCoordinates);
  const [modelSketchCoordinates] = useState(createModelSketchCoordinates);
  const [modelMeasurement] = useState(createCanvasMeasurement);
  const [pcbSynchronizer] = useState(() => new PCBProjectSync(project));
  const pcbSync = useRef(pcbSynchronizer);
  const [layoutRetry, setLayoutRetry] = useState(0);
  const [layoutSyncStatus, updateLayoutSyncStatus] = useState<LayoutSyncStatus>({
    pending: false,
    error: '',
    warnings: [],
  });
  const setLayoutSyncStatus = useCallback((update: React.SetStateAction<LayoutSyncStatus>) => {
    updateLayoutSyncStatus((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      return current.pending === next.pending &&
        current.error === next.error &&
        current.warnings.length === next.warnings.length &&
        current.warnings.every((warning, index) => warning === next.warnings[index])
        ? current
        : next;
    });
  }, []);
  prepareProject.current = (next) => {
    try {
      const synced = pcbSync.current.prepare(next);
      if (synced) {
        setLayoutSyncStatus({ pending: false, error: '', warnings: synced.warnings });
        return synced.project;
      }
    } catch (error) {
      setLayoutSyncStatus({
        pending: false,
        error: `Layout: ${(error as Error).message}`,
        warnings: [],
      });
    }
    return next;
  };
  const pcbSyncTask = useRef<{
    basis: Project;
    promise: Promise<SyncedProject>;
    controller: AbortController;
  } | null>(null);
  const adoptedLayoutResults = useRef(new WeakMap<SyncedProject, Project>());
  function acceptSyncedProject(basis: Project, result: SyncedProject) {
    if (
      projectRef.current !== basis ||
      sourceDraftRef.current !== null ||
      core.getSnapshot().editingBlocked !== null
    )
      return false;
    const next = result.project;
    if (next !== basis) {
      // Library materialization is part of the originating edit, not a second
      // undo action. Loading a clean document establishes its materialized baseline.
      const wasClean = !nativeProjectDirty(basis, cleanSourceRef.current, filenameRef.current);
      if (!core.materialize(basis, next)) return false;
      if (wasClean) {
        const clean = core.getSnapshot().source;
        cleanSourceRef.current = clean;
        setCleanSource(clean);
      }
      const owned = core.getSnapshot().project!;
      projectRef.current = owned;
      current.current = findSchematic(owned, activeSchematicRef.current ?? '') ?? owned.schematic;
    }
    adoptedLayoutResults.current.set(result, core.getSnapshot().project!);
    setLayoutSyncStatus({ pending: false, error: '', warnings: result.warnings });
    return true;
  }
  useEffect(() => {
    if (!project || sourceDraft !== null) return;
    const controller = new AbortController();
    try {
      const ready = pcbSync.current.prepare(project);
      if (ready) {
        const promise = Promise.resolve(ready);
        pcbSyncTask.current = { basis: project, promise, controller };
        acceptSyncedProject(project, ready);
        return () => controller.abort();
      }
    } catch (error) {
      pcbSyncTask.current = null;
      setLayoutSyncStatus({
        pending: false,
        error: `Layout: ${(error as Error).message}`,
        warnings: [],
      });
      return () => controller.abort();
    }
    const promise = pcbSync.current.resolve(
      project,
      async (id, signal) =>
        (await api(`libraries/footprints?id=${encodeURIComponent(id)}`, { signal })).json(),
      controller.signal,
    );
    pcbSyncTask.current = { basis: project, promise, controller };
    setLayoutSyncStatus((s) => ({ ...s, pending: true, error: '' }));
    void promise
      .then((result) => {
        if (!controller.signal.aborted) acceptSyncedProject(project, result);
      })
      .catch((error) => {
        if (!controller.signal.aborted && projectRef.current === project) {
          if (pcbSyncTask.current?.promise === promise) pcbSyncTask.current = null;
          setLayoutSyncStatus({ pending: false, error: `Layout: ${error.message}`, warnings: [] });
        }
      });
    return () => controller.abort();
  }, [project, sourceDraft, layoutRetry]);
  async function completeLayout(snapshot: Project) {
    const task = pcbSyncTask.current;
    const result =
      task?.basis === snapshot && !task.controller.signal.aborted
        ? await task.promise
        : await pcbSync.current.resolve(
            snapshot,
            async (id, signal) =>
              (await api(`libraries/footprints?id=${encodeURIComponent(id)}`, { signal })).json(),
            new AbortController().signal,
          );
    if (core.getSnapshot().sourceDraft !== null)
      throw new Error('Source changed while loading footprints. Apply it before saving.');
    if (
      projectRef.current !== result.project &&
      adoptedLayoutResults.current.get(result) !== projectRef.current &&
      !acceptSyncedProject(snapshot, result)
    )
      throw new Error('The project changed while loading footprints. Try again.');
    return core.getSnapshot().project!;
  }
  const fileInput = useRef<HTMLInputElement>(null);
  const closingDocument = useRef(false);
  const current = useRef<Circuit | null>(doc);
  current.current = doc;
  const fileViewports = useRef(new Map<string, CanvasViewport>());
  useLayoutEffect(
    () =>
      core.subscribe((event) => {
        const snapshot = core.getSnapshot();
        projectRef.current = snapshot.project;
        sourceDraftRef.current = snapshot.sourceDraft;
        current.current = snapshot.project
          ? (findSchematic(snapshot.project, activeSchematicRef.current ?? '') ??
            snapshot.project.schematic)
          : null;
        if (event.type === 'history.changed' || event.type === 'source.applied') {
          setSelected(null);
          setTool('select');
        }
      }),
    [core],
  );
  useEffect(() => {
    const disposeCore = registerProjectCapabilities(capabilityHost, core, {
      prepareModelCad: (objects, signal) => prepareModelCadObjects(core, objects, signal),
    });
    const disposePlugins = registerWorkbenchPluginCapabilities(capabilityHost);
    const disposeParasitics = registerLayoutParasiticsCapability(capabilityHost, core.getSnapshot);
    const disposeProviderPlugins = registerProviderPluginCapabilities(capabilityHost);
    const disposeLibraries = registerLibraryCapabilities(capabilityHost, core, {
      available: () => resourcePorts.current.available?.() ?? false,
      spiceAvailable: () => resourcePorts.current.spiceAvailable?.() ?? false,
      getFileId: () => resourcePorts.current.getFileId?.(),
      get chooseComponentModel() {
        return resourcePorts.current.chooseComponentModel;
      },
      get chooseSpiceModel() {
        return resourcePorts.current.chooseSpiceModel;
      },
      get inspectSpiceModel() {
        return resourcePorts.current.inspectSpiceModel;
      },
    });
    const disposeFiles = registerProjectFileCapabilities(
      capabilityHost,
      () => projectFilePorts.current,
    );
    return () => {
      disposeFiles();
      disposeLibraries();
      disposeProviderPlugins();
      disposeParasitics();
      disposePlugins();
      disposeCore();
    };
  }, [core, capabilityHost]);
  useEffect(() => {
    setInspectedPartId(null);
    setExplicitPropertiesId(null);
    setPropertiesDismissed(false);
    setTool('select');
    setPlacement(undefined);
    setModal(null);
  }, [doc?.id]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string, kind: 'standard' | 'recovery' = 'standard') => {
    setToast({ text, dismissible: kind === 'standard' });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), kind === 'recovery' ? 1800 : 5500);
  }, []);
  const cancelAppClose = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (active) setScreen(projectRef.current ? 'workspace' : 'home');
    if (!active) setModal(null);
  }, [active]);
  useEffect(() => {
    if (doc)
      onDocumentChange(documentId, {
        source,
        sourceDraft,
        dirty,
        sessions,
        activeSessionId,
        filename,
        localExample,
        title: project!.name ?? project!.schematic.title,
        activeSchematicId: doc.id,
        closedSchematicIds,
        unsaved,
      });
  }, [
    source,
    sourceDraft,
    sessions,
    activeSessionId,
    filename,
    localExample,
    unsaved,
    dirty,
    doc?.id,
    closedSchematicIds,
    documentId,
    onDocumentChange,
  ]);
  const fileActionRef = useRef(handleFileAction);
  fileActionRef.current = handleFileAction;
  const directoryEditorRef = useRef(directoryObservation);
  directoryEditorRef.current = directoryObservation;
  const readCloseSnapshot = useCallback((): CloseSnapshot => {
    const current = core.getSnapshot();
    return {
      native: {
        source: current.source,
        sourceDraft: current.sourceDraft,
        dirty: nativeProjectDirty(current.project, cleanSourceRef.current, filenameRef.current),
        closedSchematicIds: closedSchematicIdsRef.current,
        activeSchematicId: current.project
          ? (
              findSchematic(current.project, activeSchematicRef.current ?? '') ??
              current.project.schematic
            ).id
          : undefined,
      },
      ordinaryDraftRevision: directoryEditorRef.current.pendingRevision(),
    };
  }, [core, nativeProjectDirty]);
  useEffect(() => {
    registerController(documentId, {
      activate: (sessionId) => {
        setScreen('workspace');
        if (sessionId) {
          setActiveSessionId(sessionId);
          setSidebarVisible(true);
        }
      },
      sessionAction: (id, action) => applySessionAction(id, action),
      newConversation: () => {
        newChatSession();
        setSidebarVisible(true);
        setScreen('workspace');
      },
      snapshot: readCloseSnapshot,
      notify,
      fileAction: (action) => fileActionRef.current(action),
      requestClose: (done, cancel) => {
        if (confirmBusyRef.current && confirmationRef.current?.kind !== 'close') {
          cancel();
          return;
        }
        cancelPendingNavigation();
        cancelAppClose.current = cancel;
        setModal(null);
        setScreen('workspace');
        setConfirmError('');
        setConfirmation({
          kind: 'close',
          action: (saveFirst) => done(saveFirst ? 'save' : 'discard', readCloseSnapshot()),
        });
      },
    });
    return () => registerController(documentId, null);
  }, [documentId, registerController, readCloseSnapshot]);
  useEffect(() => {
    if (initialNotice) notify(initialNotice);
    else if (recovered) notify('Recovered your previous project draft.', 'recovery');
  }, [recovered, initialNotice]);
  function commitProject(next: Project) {
    try {
      return core.commitProject(next);
    } catch (error) {
      notify((error as Error).message);
      return false;
    }
  }
  const commit = useCallback(
    (next: Circuit) => {
      try {
        return core.replaceSchematic(next);
      } catch (error) {
        notify((error as Error).message);
        return false;
      }
    },
    [core, notify],
  );
  const commitBoard = useCallback(
    (board: PCB) => {
      try {
        return core.replaceBoard(board);
      } catch (error) {
        notify((error as Error).message);
        return false;
      }
    },
    [core, notify],
  );
  const sourcePreparation = useRef<AbortController | null>(null);
  const navigationIntent = useRef(0);
  function cancelPendingNavigation() {
    navigationIntent.current++;
    sourcePreparation.current?.abort();
    return navigationIntent.current;
  }
  useLayoutEffect(
    () => () => sourcePreparation.current?.abort(),
    [core, sourceDraft, coreSnapshot.revision, active],
  );
  async function applySource(signal?: AbortSignal): Promise<Project | null> {
    signal?.throwIfAborted();
    const pending = core.getSnapshot().sourceDraft !== null;
    if (pending) {
      sourcePreparation.current?.abort();
      const control = new AbortController();
      const abort = () => control.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      sourcePreparation.current = control;
      let parsed = false;
      try {
        const candidate = core.previewSource();
        parsed = true;
        if (!candidate) return null;
        const objects = core.pendingModelCadGeometry(candidate);
        if (objects.length) await prepareModelCadObjects(core, objects, control.signal);
        control.signal.throwIfAborted();
      } catch (error) {
        if (control.signal.aborted) {
          signal?.throwIfAborted();
          return null;
        }
        if (!parsed) core.applySource();
        // Applying below retains the normal native Source diagnostics. Kernel
        // failures keep the same drafts and report the actionable host error.
        notify((error as Error).message);
        setSourceOpened(true);
        setView('source');
        setScreen('workspace');
        return null;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (sourcePreparation.current === control) sourcePreparation.current = null;
      }
    }
    const next = core.applySource();
    if (!next) {
      setSourceOpened(true);
      setView('source');
      setScreen('workspace');
      return null;
    }
    if (pending) {
      setSelected(null);
      setTool('select');
    }
    return next;
  }
  async function changeView(next: typeof view, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const intent = cancelPendingNavigation();
    if (next !== 'source' && !(await applySource(signal))) return false;
    signal?.throwIfAborted();
    if (intent !== navigationIntent.current) return false;
    if (next === 'source') setSourceOpened(true);
    if (next === '3d') setObjectOpened(true);
    if (next === 'layout') {
      setLayoutOpened(true);
      if (layoutSyncStatus.error) setLayoutRetry((value) => value + 1);
    }
    if (next !== view) setModal(null);
    setView(next);
    return true;
  }
  async function openProjectHistory(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const intent = cancelPendingNavigation();
    if (!(await applySource(signal))) return false;
    signal?.throwIfAborted();
    if (intent !== navigationIntent.current) return false;
    setGitOpened(true);
    setModal('history');
    return true;
  }
  async function selectSchematic(id: string, signal?: AbortSignal) {
    if (id === doc?.id && view === 'canvas') return;
    const intent = cancelPendingNavigation();
    const latest = await applySource(signal);
    signal?.throwIfAborted();
    if (!latest || intent !== navigationIntent.current || !findSchematic(latest, id)) return;
    setClosedSchematics((ids) => ids.filter((closed) => closed !== id));
    setActiveSchematicId(id);
    setView('canvas');
  }
  async function newSchematicFile() {
    const intent = cancelPendingNavigation();
    if (!(await applySource())) return;
    if (intent !== navigationIntent.current) return;
    try {
      core.execute('schematic.add');
      const files = projectSchematics(core.getSnapshot().project!);
      setActiveSchematicId(files[files.length - 1].id);
      setView('canvas');
    } catch (error) {
      notify((error as Error).message);
    }
  }
  async function closeSchematicFile(id: string) {
    if (!openSchematicFiles.some((file) => file.id === id)) return false;
    const intent = cancelPendingNavigation();
    if (openSchematicFiles.length === 1) {
      requestProjectClose();
      return false;
    }
    if (id === doc?.id) {
      const latest = await applySource();
      if (!latest || intent !== navigationIntent.current) return false;
      const remaining = openSchematicFiles.filter(
        (file) => file.id !== id && findSchematic(latest, file.id),
      );
      if (!remaining.length) {
        requestProjectClose();
        return false;
      }
      const index = openSchematicFiles.findIndex((file) => file.id === id);
      setActiveSchematicId(remaining[Math.min(index, remaining.length - 1)].id);
      setView('canvas');
    }
    setClosedSchematics((ids) => [...ids.filter((closed) => closed !== id), id]);
    return true;
  }
  async function restoreProjectVersion(restored: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const basis = core.getSnapshot();
    if (basis.sourceDraft !== null)
      throw new Error('Apply the source edits before restoring a version.');
    if (basis.editingBlocked) throw new Error(basis.editingBlocked);
    const candidate = parseProject(restored);
    const intent = cancelPendingNavigation(),
      control = new AbortController();
    const abort = () => control.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    sourcePreparation.current = control;
    try {
      const pending = core.pendingModelCadGeometry(candidate);
      if (pending.length) await prepareModelCadObjects(core, pending, control.signal);
      control.signal.throwIfAborted();
      const current = core.getSnapshot();
      if (
        intent !== navigationIntent.current ||
        current.revision !== basis.revision ||
        current.sourceDraft !== basis.sourceDraft ||
        current.project !== basis.project ||
        current.editingBlocked
      )
        throw new Error('The project changed while the version was prepared. Try again.');
      core.commitProject(candidate);
      setSelection([]);
      setSelected(null);
      setTool('select');
      notify('Version restored. Save to write it to disk.');
    } finally {
      signal.removeEventListener('abort', abort);
      if (sourcePreparation.current === control) sourcePreparation.current = null;
    }
  }
  function openAnnotation(position: Point, id?: string) {
    if (sourceDraftRef.current !== null) {
      notify('Apply the source edits before adding annotations.');
      return;
    }
    if (!layers.notes) {
      notify('Show Notes in Visualization before adding annotations.');
      return;
    }
    setAnnotationTarget({ ...position, id });
    setModal('annotation');
  }
  const undoStep = useCallback(() => {
    try {
      if (core.undo()) setSelected(null);
    } catch (error) {
      notify((error as Error).message);
    }
  }, [core, setSelected, notify]);
  const redoStep = useCallback(() => {
    try {
      if (core.redo()) setSelected(null);
    } catch (error) {
      notify((error as Error).message);
    }
  }, [core, setSelected, notify]);
  function remove(targets: string[] = selection) {
    if (!doc || sourcePending || !targets.length) return;
    const ids = targets.filter((id) => !selectedField(id));
    if (!ids.length) {
      notify('Component text fields cannot be deleted.');
      return;
    }
    try {
      if (commit(removeSelection(doc, ids))) setSelected(null);
    } catch (error) {
      notify((error as Error).message);
    }
  }
  function rotate() {
    if (doc && selection.length) commit(transformSelection(doc, selection, 'rotate'));
  }
  function requestSchematicMove(connected: boolean) {
    if (!doc || sourcePending || !selection.length) return;
    setTool('select');
    setSchematicMoveRequest({ id: ++moveRequestSequence.current, schematicId: doc.id, connected });
  }
  function duplicate() {
    if (!doc) return;
    const result = duplicateSelection(doc, selection);
    if (result.selection.length && commit(result.circuit)) setSelection(result.selection);
  }
  function copySelection() {
    if (!doc || !selection.some((id) => !selectedField(id))) return;
    clipboard.current = {
      doc: structuredClone(doc),
      ids: selection.filter((id) => !selectedField(id)),
    };
    notify('Selection copied.');
  }
  function pasteSelection() {
    if (!doc || !clipboard.current) return;
    const clip = clipboard.current;
    try {
      const result = pasteSchematicSelection(doc, clip.doc, clip.ids);
      if (result.selection.length && commit(result.circuit)) setSelection(result.selection);
    } catch (error) {
      notify((error as Error).message);
    }
  }
  async function save(
    saveAs = false,
    signal?: AbortSignal,
  ): Promise<'saved' | 'cancelled' | Error> {
    if (!doc) return 'cancelled';
    if (nativeFileBusy.current || closingDocument.current)
      return new Error('A project file operation is already in progress.');
    nativeFileBusy.current = true;
    try {
      const applied = await applySource(signal);
      if (!applied) throw new Error('Fix the source errors before saving.');
      const snapshot = await completeLayout(applied);
      signal?.throwIfAborted();
      // Carry the current native bytes through the private host adapter too.
      // Defaults and native record order must agree with the visible Source.
      const saveProject = {
        ...snapshot,
        nativeFiles: projectNativeFiles(snapshot, projectFilename(filename)),
      };
      let savedName = saveProject.nativeFiles.entry;
      const checkSaveBasis = () => {
        signal?.throwIfAborted();
        const current = core.getSnapshot();
        if (current.project !== snapshot || current.sourceDraft !== null || current.editingBlocked)
          throw new Error(
            'The project changed while saving. Save again to include the latest edits.',
          );
      };
      await directoryObservation.save(undefined, { check: checkSaveBasis });
      checkSaveBasis();
      if (window.openpe) {
        const result = await window.openpe.save({
          fileId: fileId!,
          source: serializeProject(saveProject),
          name: filename,
          saveAs,
        });
        if (!result) return 'cancelled';
        if (saveAs) setGitDestination((current) => current + 1);
        savedName = result.name;
        setFilename(result.name);
        setLocalExample(result.localExample ?? (saveAs ? false : localExample));
      } else {
        for (const file of saveProject.nativeFiles.files) downloadText(file.source, file.name);
      }
      if (projectRef.current !== snapshot || sourceDraftRef.current !== null) {
        throw new Error(
          'The project changed while saving. Save again to include the latest edits.',
        );
      }
      // Source follows the files actually written, including a Save as stem.
      const nativeFiles = projectNativeFiles(saveProject, savedName);
      if (!core.materialize(snapshot, { ...snapshot, nativeFiles }))
        throw new Error(
          'The project changed while saving. Save again to include the latest edits.',
        );
      core.setNativeEntryName(savedName);
      const savedSource = core.getSnapshot().source;
      setCleanSource(savedSource);
      cleanSourceRef.current = savedSource;
      directoryObservation.refresh();
      notify('Save project');
      return 'saved';
    } catch (e) {
      notify((e as Error).message);
      return e as Error;
    } finally {
      nativeFileBusy.current = false;
    }
  }
  async function exportFile(
    format: ProjectExportFormat,
    signal?: AbortSignal,
  ): Promise<'exported' | 'cancelled' | Error> {
    if (!project || !doc) return new Error('A project export is not available.');
    if (nativeFileBusy.current || closingDocument.current) {
      const error = new Error('A project file operation is already in progress.');
      notify(error.message);
      return error;
    }
    nativeFileBusy.current = true;
    try {
      signal?.throwIfAborted();
      const applied = await applySource(signal);
      if (!applied) throw new Error('Fix the source errors before exporting.');
      const snapshot = format === 'netlist' ? applied : await completeLayout(applied);
      const checkExportBasis = () => {
        signal?.throwIfAborted();
        const current = core.getSnapshot();
        if (current.project !== snapshot || current.sourceDraft !== null || current.editingBlocked)
          throw new Error('The project changed while preparing the export. Try again.');
      };
      if (window.openpe) {
        checkExportBasis();
        const result = await window.openpe.exportProject({
          source: serializeProject(snapshot),
          name: filename,
          format,
        });
        if (!result) return 'cancelled';
      } else {
        const { exportProjectFile } = await import('@/lib/manufacturing-export');
        checkExportBasis();
        const output = exportProjectFile(snapshot, format, filename);
        downloadBytes(output.bytes, output.name, output.mime);
      }
      notify(`Exported ${projectExportFormats.find((entry) => entry.id === format)!.label}`);
      return 'exported';
    } catch (e) {
      notify((e as Error).message);
      return e as Error;
    } finally {
      nativeFileBusy.current = false;
    }
  }
  async function handleFileAction(action: Exclude<ProjectFileAction, 'reveal'>): Promise<boolean> {
    if (nativeFileBusy.current || closingDocument.current || confirmationRef.current) return false;
    if (action === 'close') {
      requestProjectClose();
      return false;
    }
    if (action === 'rename') {
      const current = core.getSnapshot().project;
      if (current)
        setRenameTarget({ kind: 'project', name: current.name ?? current.schematic.title });
      return false;
    }
    return (await save(action === 'save-as')) === 'saved';
  }
  function requestProjectClose() {
    if (confirmationRef.current || closingDocument.current) return;
    cancelPendingNavigation();
    if (!isCloseSnapshotUnsaved(readCloseSnapshot())) {
      void closeProject().catch((e) => {
        onSelectProject(documentId);
        notify((e as Error).message);
      });
      return;
    }
    setModal(null);
    setConfirmError('');
    setConfirmation({ kind: 'close-project', action: closeProject });
  }
  async function closeProject() {
    if (closingDocument.current) return;
    if (nativeFileBusy.current || directoryObservation.saving)
      throw new Error('Wait for the project file operation to finish before closing.');
    closingDocument.current = true;
    core.setEditingBlocked('This project is closing.');
    capabilityHost.suspend('This project is closing.');
    try {
      if (!(await onCloseProject(documentId)))
        throw new Error('Another project is closing. Try again.');
    } catch (error) {
      closingDocument.current = false;
      core.setEditingBlocked(null);
      capabilityHost.resume();
      throw error;
    }
  }
  function cancelConfirmation() {
    if (confirmBusyRef.current) return;
    if (confirmation?.kind === 'close') cancelAppClose.current?.();
    setConfirmation(null);
    setConfirmError('');
  }
  async function finishConfirmation(saveFirst = false) {
    if (!confirmation || confirmBusyRef.current) return;
    confirmBusyRef.current = true;
    setConfirmBusy(true);
    setConfirmError('');
    try {
      if (saveFirst) {
        const result = await save();
        if (result !== 'saved') {
          setConfirmError(
            result === 'cancelled' ? 'Save cancelled. Your project is still open.' : result.message,
          );
          return;
        }
      }
      await confirmation.action(saveFirst);
      // A background edit may have queued a fresh review of this same project.
      setConfirmation((current) => (current === confirmation ? null : current));
    } catch (e) {
      setConfirmError((e as Error).message);
    } finally {
      confirmBusyRef.current = false;
      setConfirmBusy(false);
    }
  }
  async function enterDocument(
    loaded: Project | (() => Promise<Project>),
    name: string,
    unsaved: boolean,
    brief = '',
    grant?: string,
    notice?: string,
    openKey?: string,
  ) {
    await onAddProject(loaded, name, unsaved, brief, grant, notice, openKey);
  }
  function open() {
    void openDocument();
  }
  async function openDocument(recentId?: string) {
    if (window.openpe) {
      try {
        const result = recentId
          ? await window.openpe.openRecent(recentId)
          : await window.openpe.open();
        if (!result) return;
        if ('fileId' in result) {
          onSelectFile(result.fileId);
          return;
        }
        const loaded = importDocument(result.source);
        const grant = await window.openpe.acceptOpen(result.openId);
        await enterDocument(loaded, result.name, false, '', grant);
        setScreen('workspace');
      } catch (e) {
        notify((e as Error).message);
      }
    } else fileInput.current?.click();
  }
  function newFile(example?: ExampleId, brief = '') {
    if (example?.startsWith('recent:')) {
      void openDocument(example);
      return;
    }
    void (async () => {
      try {
        if (example && onSelectExample(`example:${example}`)) return;
        const createNext = async () => {
          const next = example
            ? (await import('@/lib/create-home-example')).createHomeExample(example)
            : createBlankProject();
          return next;
        };
        await enterDocument(
          createNext,
          example
            ? (homeExampleCatalog.find((entry) => entry.id === example)?.title ?? 'KiCad project')
            : DEFAULT_PROJECT_FILENAME,
          false,
          brief,
          undefined,
          undefined,
          example ? `example:${example}` : undefined,
        );
      } catch (error) {
        notify((error as Error).message);
      }
    })();
  }
  async function openProperties(id: string) {
    if (simulationEnabled || !doc || !(await changeView('canvas'))) return;
    showRightSidebar();
    setPropertiesExpanded(true);
    setSelection(visibleSchematicIds(doc, layers).has(id) ? [id] : []);
    setInspectedPartId(id);
    setTool('select');
    setModal(null);
    setPropertiesFocusRequest({ schematicId: doc.id, objectId: id });
  }
  function openObjectProperties(id: string) {
    if (!doc || sourcePending || !selectableSchematicIds(doc, layers, selectionFilters).has(id))
      return;
    const field = selectedField(id);
    if (simulationEnabled && field?.field !== 'Sim.Params') return;
    if (simulationEnabled) setSimulationEnabled(false);
    if (doc.parts.some((part) => part.id === id)) {
      openProperties(id);
      return;
    }
    const note = schematicTexts(doc.original).find((note) => note.id === id);
    if (note) {
      setSelection([id]);
      openAnnotation(note, id);
      return;
    }
    if (
      !field &&
      !doc.labels.some((label) => label.id === id) &&
      !doc.wires.some((wire) => wire.id === id)
    )
      return;
    setSelection([id]);
    setExplicitPropertiesId(id);
    showRightSidebar();
    setPropertiesExpanded(true);
    setTool('select');
    setModal(null);
    setPropertiesFocusRequest({ schematicId: doc.id, objectId: id });
  }
  function saveFields(
    ref: string,
    value: string,
    fields: Record<string, string>,
    partId = selected,
    sourceCircuit: Circuit | null = doc,
    footprintDetail?: FootprintDetail,
  ) {
    if (!sourceCircuit) return false;
    const selectedPart = sourceCircuit.parts.find((p) => p.id === partId);
    if (!selectedPart) return false;
    const d = structuredClone(sourceCircuit);
    for (const p of d.parts.filter((p) => p.ref === selectedPart.ref)) {
      p.ref = ref;
      p.value = value;
      p.fields = structuredClone(fields);
      if (p.raw)
        p.raw = p.raw.filter(
          (n) =>
            !Array.isArray(n) ||
            n[0] !== 'property' ||
            ['Reference', 'Value'].includes(val(n)) ||
            Object.hasOwn(fields, val(n)),
        );
    }
    const assignment = (fields.Footprint || '').trim();
    if (footprintDetail && assignment !== (partFields(selectedPart).Footprint || '').trim()) {
      const latest = core.getSnapshot().project;
      if (!latest || latest.schematic !== sourceCircuit) return false;
      const previous = pcbSync.current.sources.get(assignment);
      const restore = () => {
        if (previous) pcbSync.current.sources.set(assignment, previous);
        else pcbSync.current.sources.delete(assignment);
      };
      try {
        if (footprintDetail.id !== assignment)
          throw new Error('The selected footprint no longer matches this assignment.');
        pcbSync.current.sources.set(assignment, footprintDetail);
        if (!pcbSync.current.prepare({ ...latest, schematic: d }))
          throw new Error('Wait for Layout synchronization before assigning this footprint.');
        const accepted = commit(d);
        if (!accepted) restore();
        return accepted;
      } catch (error) {
        restore();
        notify((error as Error).message);
        return false;
      }
    }
    return commit(d);
  }
  function patchGeometry(
    key: 'x' | 'y' | 'rotation',
    input: string,
  ): { success: boolean; value: number } {
    const existing = doc!.parts.find((p) => p.id === selected)!;
    const limit = key === 'rotation' ? 360 : 100000;
    const value = Number(input);
    if (!input.trim() || !Number.isFinite(value) || Math.abs(value) > limit) {
      notify(
        `${key === 'rotation' ? 'Rotation' : 'Position'} must be between ${-limit} and ${limit}${key === 'rotation' ? '°' : ' mm'}.`,
      );
      return { success: false, value: existing[key] };
    }
    let next: number;
    try {
      next = preparePartGeometry(key, value);
    } catch (error) {
      notify((error as Error).message);
      return { success: false, value: existing[key] };
    }
    if (next !== existing[key]) {
      const d = structuredClone(doc!);
      d.parts.find((p) => p.id === selected)![key] = next;
      if (!commit(d)) return { success: false, value: existing[key] };
    }
    return { success: true, value: next };
  }
  function onApply(ops: Operation[], basis?: string) {
    const latest =
      basis && projectRef.current
        ? projectSchematics(projectRef.current).find((file) => circuitFingerprint(file) === basis)
        : current.current;
    if (!latest) {
      notify('The schematic has changed. Ask your agent for a fresh proposal.');
      return false;
    }
    try {
      const next = applyProposal(latest, ops);
      if (!commit(next)) return false;
      notify(`Applied ${ops.length} changes.`);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const input = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
      if (!active || e.defaultPrevented || e.isComposing || e.keyCode === 229 || hasOpenOverlay())
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (screen === 'workspace') void save(e.shiftKey);
        return;
      }
      if (input || screen === 'plugins' || el.closest('.chat-panel')) return;
      if (e.altKey) return;
      if (e.key === 'Escape') {
        setModal(null);
        setTool('select');
        setSelected(null);
        return;
      }
      if (modal) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (view === 'canvas' && tool === 'annotate' && !['o', 'a', 'c'].includes(k)) {
          e.preventDefault();
          return;
        }
        if (view === 'canvas' && screen === 'workspace' && el.matches('.canvas-wrap > svg')) {
          if (k === 'c') {
            e.preventDefault();
            copySelection();
            return;
          }
          if (k === 'v') {
            e.preventDefault();
            pasteSelection();
            return;
          }
          if (k === 'd') {
            e.preventDefault();
            duplicate();
            return;
          }
          if (k === 'a' && doc) {
            e.preventDefault();
            const visible = selectableSchematicIds(doc, layers, selectionFilters);
            setSelection(
              [...visible].filter((id) => {
                const field = selectedField(id);
                return !field || !visible.has(field.id);
              }),
            );
            return;
          }
        }
        if (k === 'z' && screen === 'workspace') {
          e.preventDefault();
          e.shiftKey ? redoStep() : undoStep();
        }
        if (k === 'o') {
          e.preventDefault();
          void open();
        }
        return;
      }
      if (screen !== 'workspace' || !doc || view !== 'canvas') return;
      if (
        e.code === 'Space' &&
        !e.altKey &&
        !e.shiftKey &&
        view === 'canvas' &&
        el.matches('.canvas-wrap > svg')
      ) {
        e.preventDefault();
        if (!e.repeat) setFitKey((k) => k + 1);
        return;
      }
      if (k === 'v') setTool('select');
      if (tool === 'annotate' && ['r', 'x', 'y', 'delete', 'backspace'].includes(k)) {
        e.preventDefault();
        return;
      }
      if (k === 'h') setTool('hand');
      if (k === 'a') {
        e.preventDefault();
        setModal('library');
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const part = doc?.parts.find((p) => p.id === selected),
    label = doc?.labels.find((l) => l.id === selected),
    wire = doc?.wires.find((w) => w.id === selected);
  const annotation = useMemo(
    () => schematicTexts(doc?.original).find((t) => t.id === selected),
    [doc?.original, selected],
  );
  const inspectedField = inspectedPartId ? null : selectedField(activeSelection);
  const fieldPosition =
    doc && inspectedField && activeSelection ? objectPosition(doc, activeSelection) : null;
  const propertiesMounted =
    tool !== 'annotate' && (!wire || explicitPropertiesId === wire.id) && !propertiesDismissed;
  const propertiesVisible = view === 'canvas' && propertiesMounted;
  const propertiesPresented =
    propertiesVisible &&
    active &&
    screen === 'workspace' &&
    rightSidebarVisible &&
    !simulationVisible;
  const propertiesActive =
    propertiesPresented &&
    propertiesExpanded &&
    !modal &&
    !confirmation &&
    !sourcePending &&
    !coreSnapshot.editingBlocked;
  const canEditProperties = () => propertiesActive && current.current === doc;
  const propertiesDeleteAction = !inspectedField ? (
    <PropertyDeleteButton
      disabled={
        !propertiesActive || (!inspectedPartId && selection.every((id) => !!selectedField(id)))
      }
      onClick={() => remove(inspectedPartId ? [inspectedPartId] : selection)}
    />
  ) : undefined;

  function saveNetName(value: string): boolean {
    if (!canEditProperties() || !doc || !label) return false;
    if (!value.trim()) {
      notify('Enter a net name.');
      return false;
    }
    if (value === label.text) return true;
    return commit(saveLabel(doc, { id: label.id, text: value }).circuit);
  }
  useEffect(() => {
    if (
      !propertiesFocusRequest ||
      !propertiesActive ||
      propertiesFocusRequest.schematicId !== doc?.id ||
      propertiesFocusRequest.objectId !== (inspectedPartId || activeSelection)
    )
      return;
    const inspector = propertiesInspector.current;
    (
      inspector?.querySelector<HTMLElement>('input:not([disabled]), textarea, select') ??
      inspector?.querySelector<HTMLElement>('button:not([disabled])')
    )?.focus({ preventScroll: true });
    setPropertiesFocusRequest(null);
  }, [propertiesFocusRequest, propertiesActive, doc?.id, inspectedPartId, activeSelection]);

  useEffect(() => {
    if (!active || screen !== 'workspace' || !project || datasheetReader) return;
    let cancelled = false;
    void import('@/lib/example-datasheets')
      .then((reader) => {
        if (!cancelled) {
          setDatasheetReader(reader);
        }
      })
      .catch(() => {
        if (!cancelled)
          notify('Could not load IC datasheet references. Save your work and reload OpenPE.');
      });
    return () => {
      cancelled = true;
    };
  }, [active, screen, project?.id, datasheetReader]);

  async function readProjectDatasheet(signal?: AbortSignal) {
    const before = core.getSnapshot();
    signal?.throwIfAborted();
    const reader = await import('@/lib/example-datasheets');
    signal?.throwIfAborted();
    if (closingDocument.current || core.getSnapshot().revision !== before.revision)
      throw new Error('The project changed while reading IC specifications. Read it again.');
    return reader.projectDatasheetContext(before.project);
  }

  async function readProjectDatasheetPage(page: number, image: boolean, signal: AbortSignal) {
    const before = core.getSnapshot();
    const reference = await readProjectDatasheet(signal);
    if (!reference.record)
      throw new Error('No reviewed datasheet is bound to the current controller.');
    const result = await (
      await api('datasheets/page', {
        method: 'POST',
        body: JSON.stringify({ exampleId: reference.record.example.id, page, image }),
        signal,
      })
    ).json();
    signal.throwIfAborted();
    if (closingDocument.current || core.getSnapshot().revision !== before.revision)
      throw new Error('The project changed while reading the datasheet. Read it again.');
    return { ...result, projectId: reference.projectId, bindings: reference.bindings };
  }

  const preparedChatProject = useRef<{ source: string; project: unknown } | null>(null);
  const prepareChatProject = useCallback(() => {
    const { source } = core.getSnapshot();
    if (preparedChatProject.current?.source !== source)
      preparedChatProject.current = { source, project: agentProject(core.query('project.get')) };
    return preparedChatProject.current.project;
  }, [core]);
  useEffect(() => {
    if (source) prepareChatProject();
    else preparedChatProject.current = null;
  }, [source, prepareChatProject]);

  async function readWorkspaceContext(
    signal?: AbortSignal,
    includeReference = true,
  ): Promise<AgentWorkspaceContext> {
    const state = core.getSnapshot();
    const schematic =
      state.project &&
      (findSchematic(state.project, activeSchematicRef.current ?? '') ?? state.project.schematic);
    if (!schematic) throw new Error('Open a project to read workspace content.');
    signal?.throwIfAborted();
    const reference = includeReference ? await readProjectDatasheet(signal) : undefined;
    if (
      core.getSnapshot().revision !== state.revision ||
      core.getSnapshot().sourceDraft !== state.sourceDraft ||
      activeSchematicRef.current !== schematic.id ||
      contextActive.current !== active
    )
      throw new Error(
        'The project or active file changed while preparing Agent context. Submit again.',
      );
    const simulation =
      spiceAvailable && simulationOpened ? simulationAgentContext.current?.() : null;
    const currentSimulation =
      simulation &&
      simulation.circuitId === schematic.id &&
      simulation.basis === circuitFingerprint(schematic)
        ? simulation
        : null;
    // Explicit observations read live Core files even while Source presentation
    // is hidden, retaining the selected resident filename and reference policy.
    const observedSourceFile = sourceFileFrom(core.getNativeFiles().files);
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      // The prepared object stays inside Chat's request serialization. Public
      // observations get their own project container from Core.
      project: includeReference ? agentProject(core.query('project.get')) : prepareChatProject(),
      ...(reference ? { icDatasheet: reference } : {}),
      source: agentSource(state.sourceDraft, state.sourceError),
      ui: {
        active,
        revision: String(core.getSnapshot().revision),
        screen,
        view,
        mode: tool === 'annotate' ? 'annotation' : 'interaction',
        tool,
        activeSchematicId: schematic.id,
        selection,
        inspectedPartId,
        filename,
        sourceFile: diskObservationSelected ? null : (observedSourceFile?.name ?? null),
        sourceReadOnly:
          diskObservationSelected ||
          (!!observedSourceFile && 'readOnly' in observedSourceFile && observedSourceFile.readOnly),
        dirty: nativeProjectDirty(state.project, cleanSourceRef.current, filenameRef.current),
        layers,
        selectionFilters,
        grid,
        gridSpacing,
        layoutGridSpacing,
        modelGridSpacing,
        viewport: fileViewports.current.get(schematic.id) ?? null,
        modelView: pcb3DView.current,
        layoutView: layoutAgentContext.current,
        modal,
        toast: toast ? 'A notification is visible in the workspace.' : '',
        projects: getProjects?.() ?? projects,
        presentation: active
          ? captureAgentPresentation()
          : { text: '', controls: [], drawings: [], truncated: false },
      },
      simulation: !spiceAvailable
        ? { status: 'disabled' }
        : (currentSimulation ?? { status: 'not-opened' }),
      thermal: !thermalAvailable
        ? { status: 'disabled' }
        : (thermalAgentContext.current?.() ?? { status: 'not-opened' }),
    };
  }
  const capabilityPorts = useRef<WorkbenchCapabilityPorts>(null!);
  const nativeActionAvailability = () => {
    if (!active) return 'Activate the originating project before using project file operations.';
    if (closingDocument.current || core.getSnapshot().editingBlocked)
      return core.getSnapshot().editingBlocked || 'This project is closing.';
    if (nativeFileBusy.current) return 'Wait for the current project file operation to finish.';
    if (confirmationRef.current) return 'Finish the current project confirmation first.';
    return true;
  };
  resourcePorts.current = {
    available: nativeActionAvailability,
    spiceAvailable: () =>
      spiceAvailable || 'Install and enable SPICE Simulation in Plugins > Marketplace.',
    getFileId: () => (window.openpe ? fileId : undefined),
    chooseComponentModel:
      typeof window !== 'undefined' && typeof window.openpe?.chooseComponentModel === 'function'
        ? (id) => window.openpe!.chooseComponentModel(id)
        : undefined,
    chooseSpiceModel:
      typeof window !== 'undefined' && typeof window.openpe?.chooseSpiceModel === 'function'
        ? (id, library) => window.openpe!.chooseSpiceModel(id, library)
        : undefined,
    inspectSpiceModel:
      typeof window !== 'undefined' && typeof window.openpe?.inspectSpiceModel === 'function'
        ? (id, library) => window.openpe!.inspectSpiceModel(id, library)
        : undefined,
  };
  projectFilePorts.current = {
    revision: () => String(core.getSnapshot().revision),
    available: (write) => {
      const available = nativeActionAvailability();
      if (available !== true) return available;
      if (!window.openpe || !fileId)
        return 'Open the desktop project to access its directory files.';
      if (write && core.getSnapshot().sourceDraft !== null)
        return 'Apply native Source edits before changing project directory files.';
      return true;
    },
    files: directoryObservation.capabilities,
  };
  capabilityPorts.current = {
    revision: () => String(core.getSnapshot().revision),
    beforeAgentCommand: (id, input) => {
      const snapshot = core.getSnapshot();
      assertAgentSourceDraftSafe(snapshot);
      if (
        snapshot.sourceDraft !== null &&
        ((id === 'workbench.view' && input.view !== 'source') ||
          (id === 'workbench.panel' && ['layers', 'history'].includes(String(input.panel))) ||
          ['workbench.sheet', 'simulation.show', 'thermal.show'].includes(id))
      )
        throw new Error('Apply the pending Source edits before changing the workspace view.');
    },
    state: (signal) => (doc ? readWorkspaceContext(signal) : core.query('project.snapshot')),
    datasheet: readProjectDatasheet,
    datasheetPage: readProjectDatasheetPage,
    view: changeView,
    sheet: async (id, signal) => {
      if (!projectRef.current || !findSchematic(projectRef.current, id))
        throw new Error('Choose a schematic in this project.');
      if (sourceDraftRef.current !== null)
        throw new Error('Apply Source edits before switching schematics.');
      await selectSchematic(id, signal);
    },
    selection: (ids) => {
      if (!doc) throw new Error('Open a schematic before selecting objects.');
      const visible = selectableSchematicIds(doc, layers, selectionFilters);
      if (ids.some((id) => !visible.has(id)))
        throw new Error(
          'Choose visible objects allowed by the active schematic selection filters.',
        );
      setSelection(ids);
    },
    panel: async (panel, signal) => {
      if (panel === 'layers') {
        if (!(await changeView('canvas', signal)))
          throw new Error('Apply valid Source edits before opening schematic layers.');
        setModal(null);
        showRightSidebar();
        setSchematicVisualizationOpen(true);
      } else if (panel === 'history') {
        if (!(await openProjectHistory(signal)))
          throw new Error('Apply valid Source edits before opening Git.');
      } else setModal(panel);
    },
    save,
    export: async (format, signal) => {
      const result = await exportFile(format, signal);
      if (result instanceof Error) throw result;
      return result;
    },
    projectActions: {
      available: (action) => {
        const available = nativeActionAvailability();
        if (available !== true) return available;
        if ((action === 'close' || action === 'reveal') && !projectRef.current)
          return 'Open a project before using this file action.';
        if (directoryEditorRef.current.saving) return 'Wait for the project file write to finish.';
        return window.openpe ? true : 'Use the desktop app for project file operations.';
      },
      examples: async (signal) => {
        signal.throwIfAborted();
        const result = await window.openpe!.listExamples();
        signal.throwIfAborted();
        listedExampleIds.current = new Set(result.entries.map((entry) => entry.id));
        return result;
      },
      request: (action, signal, exampleId) => {
        signal.throwIfAborted();
        if (action === 'new') newFile();
        else if (action === 'open') open();
        else if (action === 'close') requestProjectClose();
        else if (action === 'reveal') onProjectAction(documentId, 'reveal');
        else {
          // Host resolves the current identity again before issuing any grant.
          if (!exampleId || !listedExampleIds.current.has(exampleId))
            throw new Error('Choose an example from the current project.examples list.');
          newFile(exampleId);
        }
      },
      failed: notify,
    },
    enclosureExportAvailable: () => {
      const state = core.getSnapshot();
      if (!state.project?.pcb) return 'Open a PCB layout before exporting a model.';
      if (state.sourceDraft !== null) return 'Apply Source edits before exporting a model.';
      if (state.editingBlocked) return state.editingBlocked;
      if (!modelCadFromProject(state.project)?.objects.length)
        return 'Create a CAD solid before exporting STEP.';
      if (!active || screen !== 'workspace' || view !== '3d')
        return 'Open the active Model view before exporting a model.';
      if (!window.openpe) return 'Use the desktop app to export a model STEP file.';
      return true;
    },
    enclosureExport: async (signal) => {
      signal.throwIfAborted();
      const availability = capabilityPorts.current.enclosureExportAvailable!();
      if (availability !== true)
        throw new Error(
          typeof availability === 'string' ? availability : 'Model STEP export is unavailable.',
        );
      if (nativeFileBusy.current || closingDocument.current)
        throw new Error('A project file operation is already in progress.');
      const current = core.getSnapshot().project!;
      nativeFileBusy.current = true;
      try {
        signal.throwIfAborted();
        const result = await window.openpe!.exportEnclosure({ source: serializeProject(current) });
        signal.throwIfAborted();
        return result;
      } finally {
        nativeFileBusy.current = false;
      }
    },
    historyList: async (offset) => {
      if (!fileId || !window.openpe)
        throw new Error('Open the desktop project to access local version history.');
      return window.openpe.historyList({ fileId, offset });
    },
    historyRead: async (id) => {
      if (!fileId || !window.openpe)
        throw new Error('Open the desktop project to access local version history.');
      return serializeProject(parseProject(await window.openpe.historyRead({ fileId, id })));
    },
    historyCreate: async (message) => {
      const snapshot = core.getSnapshot();
      if (snapshot.sourceDraft !== null)
        throw new Error('Apply Source edits before creating a version.');
      if (!fileId || !window.openpe)
        throw new Error('Open the desktop project to access local version history.');
      if (nativeFileBusy.current || closingDocument.current)
        throw new Error('A project file operation is already in progress.');
      nativeFileBusy.current = true;
      try {
        return await window.openpe.historyCreate({ fileId, source: snapshot.source, message });
      } finally {
        nativeFileBusy.current = false;
      }
    },
    historyRestore: async (id, signal) => {
      signal.throwIfAborted();
      const available = nativeActionAvailability();
      if (available !== true) throw new Error(String(available));
      if (!window.openpe || !fileId)
        throw new Error('Open the desktop project to access local version history.');
      const basis = core.getSnapshot();
      if (basis.sourceDraft !== null)
        throw new Error('Apply Source edits before restoring a version.');
      nativeFileBusy.current = true;
      try {
        const restored = await window.openpe.historyRead({ fileId, id });
        signal.throwIfAborted();
        if (!originRef.current.active || originRef.current.fileId !== fileId)
          throw new Error('The originating project changed while the version was read. Try again.');
        const current = core.getSnapshot();
        if (
          current.revision !== basis.revision ||
          current.sourceDraft !== null ||
          current.editingBlocked
        )
          throw new Error('The project changed while the version was read. Try again.');
        await restoreProjectVersion(restored, signal);
      } finally {
        nativeFileBusy.current = false;
      }
    },
    simulation: async (visible, signal) => {
      if (!spiceAvailable)
        throw new Error('Install and enable SPICE Simulation in Plugins > Marketplace.');
      if (!active && visible) throw new Error('Activate this project before opening Simulation.');
      if (!visible) {
        setSimulationEnabled(false);
        return { visible: false };
      }
      if (!(await changeView('canvas', signal)))
        throw new Error('Apply valid Source edits before opening Simulation.');
      setScreen('workspace');
      setSimulationOpened(true);
      setSimulationEnabled(true);
      setTool('select');
      setModal(null);
      // Lazy mounting is a presentation boundary. Do not report readiness until
      // the plugin has registered its current visible state and commands.
      const started = performance.now();
      while (true) {
        signal.throwIfAborted();
        if (capabilityHost.catalog().some((item) => item.id === 'simulation.status')) {
          const state = (await capabilityHost.query('simulation.status')) as AgentSimulationContext;
          if (state.settingsVisible) return { visible: true };
        }
        if (performance.now() - started > 15000)
          throw new Error('Simulation could not open. Try again.');
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    },
    thermal: async (visible, signal) => {
      if (!thermalAvailable)
        throw new Error('Install and enable Layout Thermal in Plugins > Marketplace.');
      if (!visible) {
        closeThermal();
        return { visible: false };
      }
      if (!active) throw new Error('Activate this project before opening Layout Thermal.');
      if (sourcePending) throw new Error('Apply Source edits before opening Layout Thermal.');
      if (!projectRef.current?.pcb)
        throw new Error('Open a PCB layout before opening Layout Thermal.');
      if (!(await changeView('layout', signal)))
        throw new Error('Apply valid Source edits before opening Layout Thermal.');
      setScreen('workspace');
      setThermalOpened(true);
      setLayoutAnalysis('thermal');
      setModal(null);
      const started = performance.now();
      while (true) {
        signal.throwIfAborted();
        if (capabilityHost.catalog().some((item) => item.id === 'thermal.status')) {
          const status = (await capabilityHost.query('thermal.status')) as { visible?: boolean };
          if (status.visible) return { visible: true };
        }
        if (performance.now() - started > 15000)
          throw new Error('Layout Thermal could not open. Try again.');
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    },
  };
  useEffect(
    () => registerWorkbenchCapabilities(capabilityHost, () => capabilityPorts.current),
    [capabilityHost],
  );
  useEffect(() => {
    capabilityHost.emit('workbench.changed', {
      revision: String(coreSnapshot.revision),
      screen,
      view,
      activeSchematicId: doc?.id ?? null,
      selected: selection.slice(0, 256),
      selectionCount: selection.length,
      modal,
      sourcePending,
    });
  }, [
    capabilityHost,
    coreSnapshot.revision,
    screen,
    view,
    doc?.id,
    selection,
    modal,
    sourcePending,
  ]);
  const canAddSchematicFile = Boolean(doc && schematicFiles.length < MAX_SCHEMATIC_FILES);
  const canExportBoard = Boolean(project?.pcb);
  const canExportModel = Boolean(modelCad?.objects.length);
  const titlebarMenus: TitlebarMenu[] = [
    {
      label: 'File',
      items: [
        { label: 'New project', run: () => newFile() },
        {
          label: 'Open project',
          run: () => {
            void open();
          },
        },
        ...exampleList.sections
          .filter((section) => section.examples.length > 0)
          .map((section, index) => ({
            label: section.title,
            separatorBefore: index === 0,
            items: section.examples.map((example) => ({
              label: example.title,
              run: () => newFile(example.id),
            })),
          })),
        ...(canAddSchematicFile
          ? [
              {
                label: 'New file',
                separatorBefore: true,
                run: () => {
                  void newSchematicFile();
                },
              },
            ]
          : []),
        ...(doc
          ? [
              {
                label: 'Save',
                separatorBefore: !canAddSchematicFile,
                run: () => {
                  void save();
                },
              },
              {
                label: 'Save as',
                run: () => {
                  void save(true);
                },
              },
              {
                label: 'Export',
                items: projectExportFormats
                  .filter(
                    ({ id }) =>
                      id === 'netlist' || (canExportBoard && (id !== 'scad' || canExportModel)),
                  )
                  .map(({ id, label }) => ({
                    label,
                    run: () => {
                      void exportFile(id);
                    },
                  })),
              },
              { label: 'Close project', run: requestProjectClose, separatorBefore: true },
            ]
          : []),
      ],
    },
    {
      label: 'Edit',
      items: [
        ...(screen === 'workspace' && doc && !sourcePending
          ? [
              ...(coreSnapshot.canUndo ? [{ label: 'Undo', run: undoStep }] : []),
              ...(coreSnapshot.canRedo ? [{ label: 'Redo', run: redoStep }] : []),
              ...(view === 'canvas' && selection.length
                ? [{ label: 'Copy', run: copySelection, separatorBefore: true }]
                : []),
              ...(view === 'canvas' && clipboard.current
                ? [{ label: 'Paste', run: pasteSelection, separatorBefore: !selection.length }]
                : []),
              ...(view === 'canvas' && selection.length
                ? [
                    { label: 'Duplicate', run: duplicate },
                    { label: 'Move', run: () => requestSchematicMove(false) },
                    { label: 'Drag connected', run: () => requestSchematicMove(true) },
                    { label: 'Delete', run: remove },
                  ]
                : []),
            ]
          : []),
        { label: 'Settings', run: () => setModal('settings'), separatorBefore: true },
      ],
    },
    {
      label: 'View',
      items: [
        {
          label: 'Home',
          run: () => {
            cancelPendingNavigation();
            setScreen('home');
          },
        },
        { label: 'Plugins', run: openPlugins },
        ...(doc
          ? [
              {
                label: 'Schematic',
                separatorBefore: true,
                run: async () => {
                  if (await changeView('canvas')) setScreen('workspace');
                },
              },
              {
                label: 'Layout',
                run: async () => {
                  if (await changeView('layout')) setScreen('workspace');
                },
              },
              {
                label: 'Model',
                run: async () => {
                  if (await changeView('3d')) setScreen('workspace');
                },
              },
              {
                label: 'Source',
                run: () => {
                  changeView('source');
                  setScreen('workspace');
                },
              },
            ]
          : []),
        ...(screen === 'workspace' && doc
          ? [
              {
                label: sidebarVisible ? 'Hide left panel' : 'Show left panel',
                run: () => setSidebarVisible((value) => !value),
                separatorBefore: true,
              },
              ...(rightSidebarAvailable
                ? [
                    {
                      label: ordinarySidebarVisible ? 'Hide right panel' : 'Show right panel',
                      run: toggleCurrentRightSidebar,
                    },
                  ]
                : []),
            ]
          : []),
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'About OpenPE', run: () => setModal('about') }],
    },
  ];
  const activeGridSpacing =
    view === 'layout' ? layoutGridSpacing : view === '3d' ? modelGridSpacing : gridSpacing;
  const activeGridSpacingOptions =
    view === 'layout' ? layoutGridSpacingOptions : gridSpacingOptions;
  const canvasProperties = useEditorAction(openObjectProperties);
  const canvasDelete = useEditorAction(remove);
  const canvasViewport = useMemo(
    () => (doc ? fileViewports.current.get(doc.id) : undefined),
    [doc?.id],
  );
  const onCanvasViewportChange = useCallback(
    (viewport: CanvasViewport) => {
      if (doc) fileViewports.current.set(doc.id, viewport);
    },
    [doc?.id],
  );
  const onMoveRequestHandled = useCallback((id: number) => {
    setSchematicMoveRequest((request) => (request?.id === id ? null : request));
  }, []);
  const onNavigationRequestHandled = useCallback((id: number) => {
    setSchematicNavigationRequest((request) => (request?.id === id ? null : request));
  }, []);
  const annotations =
    sessions.find((session) => session.id === activeSessionId)?.annotations ?? emptyAnnotations;
  const onAnnotationsChange = useCallback(
    (annotations: AgentAnnotation[]) => {
      validateAnnotations(annotations);
      setSessions((items) =>
        items.map((session) =>
          session.id === activeSessionId ? { ...session, annotations } : session,
        ),
      );
    },
    [activeSessionId],
  );
  const onAnnotationAdd = useCallback(() => {
    setSidebarVisible(true);
  }, []);
  const getChatDesign = useCallback(() => {
    const project = projectRef.current;
    const doc =
      project && projectSchematics(project).find((file) => file.id === activeSchematicRef.current);
    if (!project || !doc) throw new Error('Open a schematic before sending a message.');
    return { doc, pcb: project.pcb, pcbSchematic: project.schematic };
  }, []);
  const chatAnnotationDesign = useMemo(
    () => (doc ? { doc, pcb: project?.pcb, pcbSchematic: project?.schematic } : undefined),
    [doc, project?.pcb, project?.schematic],
  );
  const applySessionAction = useEditorAction((id: string, action: SessionAction) => {
    if (action === 'rename') {
      const session = sessions.find((session) => session.id === id);
      if (session) setRenameTarget({ kind: 'conversation', id, name: sessionTitle(session) });
      return;
    }
    if (runningSessions[id] && (action === 'archive' || action === 'delete')) {
      notify('Stop the conversation before archiving or deleting it.');
      return;
    }
    setSessionState((current) => updateSession(current, id, action));
  });
  const chatCapabilities = useMemo(
    () => agentCapabilitiesForHost(capabilityHost),
    [capabilityHost],
  );
  const readChatContext = useEditorAction((signal?: AbortSignal) =>
    readWorkspaceContext(signal, false),
  );
  const applyChatProposal = useEditorAction(onApply);
  const openChatSettings = useCallback(() => setModal('agent-settings'), []);
  const newChatSession = useEditorAction(() => {
    const candidate = createSession();
    setSessionState((current) => openNewSession(current, candidate, runningSessions));
  });
  const setChatModel = useEditorAction((value: string) =>
    setModels((current) => ({ ...current, [provider]: value })),
  );
  const modelAnnotationProps = useMemo(
    () => ({
      disabled: sourcePending,
      sessionId: activeSessionId,
      annotations,
      onChange: onAnnotationsChange,
      onAdd: onAnnotationAdd,
    }),
    [sourcePending, activeSessionId, annotations, onAnnotationsChange, onAnnotationAdd],
  );
  const openThermal = useEditorAction(() => {
    void capabilityHost
      .execute(thermalEnabled ? 'thermal.hide' : 'thermal.show')
      .catch((error: Error) => notify(error.message));
  });
  const dismissParasitics = useCallback(() => {
    setLayoutAnalysis((current) => (current === 'parasitics' ? null : current));
  }, []);
  const closeParasitics = useCallback(() => {
    dismissParasitics();
    parasiticsButton.current?.focus({ preventScroll: true });
  }, [dismissParasitics]);
  const parasiticsProbe = useMemo(
    () =>
      parasiticsVisible
        ? {
            terminals: parasiticsTerminals,
            composing: parasiticsComposing,
            onPick(terminal: { id: string; netId: string } | null) {
              setParasiticsTerminals((current) => {
                if (!terminal) return current.length ? [] : current;
                if (current.length !== 1) return [terminal];
                const [start] = current;
                return terminal.id !== start.id && terminal.netId === start.netId
                  ? [start, terminal]
                  : current;
              });
            },
            onExit: dismissParasitics,
          }
        : undefined,
    [parasiticsVisible, parasiticsTerminals, dismissParasitics],
  );
  const rightSidebarAction = useMemo(
    () => (
      <SidebarToggle
        visible={ordinarySidebarVisible}
        onToggle={toggleCurrentRightSidebar}
        className="editor-sidebar-toggle"
      />
    ),
    [ordinarySidebarVisible, toggleCurrentRightSidebar],
  );
  const currentThermalPresentation =
    active &&
    screen === 'workspace' &&
    thermalVisible &&
    !sourcePending &&
    thermalPresentation?.project === project &&
    thermalPresentation.fileId === fileId
      ? thermalPresentation
      : null;
  const thermalDrawing = useMemo(
    () =>
      currentThermalPresentation?.shown ? (
        <ThermalField
          result={currentThermalPresentation.result}
          surface={currentThermalPresentation.surface}
          probe={currentThermalPresentation.probe}
          markersShown={false}
        />
      ) : null,
    [currentThermalPresentation],
  );
  const thermalReadout = useMemo(
    () =>
      currentThermalPresentation ? (
        <ThermalLayoutResults
          result={currentThermalPresentation.result}
          controls={currentThermalPresentation.controls}
          project={currentThermalPresentation.project}
          resultConfig={currentThermalPresentation.resultConfig}
          onLocateFootprint={currentThermalPresentation.onLocateFootprint}
          probe={currentThermalPresentation.probe}
          surface={currentThermalPresentation.surface}
          selectedFootprint={
            currentThermalPresentation.shown &&
            thermalSelectedFootprint?.side === currentThermalPresentation.surface &&
            currentThermalPresentation.project.pcb?.footprints.includes(thermalSelectedFootprint)
              ? thermalSelectedFootprint
              : null
          }
        />
      ) : null,
    [currentThermalPresentation, thermalSelectedFootprint],
  );
  const thermalComponentDetail = useMemo(() => {
    if (!currentThermalPresentation?.shown) return undefined;
    const presentation = currentThermalPresentation;
    return (
      footprint: import('@/lib/pcb').Footprint,
      layers: import('@/lib/pcb-display').PCBDisplay,
      scale: number,
    ) => (
      <ThermalComponentHighlight
        presentation={presentation}
        footprint={footprint}
        layers={layers}
        scale={scale}
      />
    );
  }, [currentThermalPresentation]);
  const thermalMarkers = useMemo(() => {
    if (!currentThermalPresentation?.shown) return undefined;
    const { result, surface, probe } = currentThermalPresentation;
    return (scale: number) => (
      <ThermalFieldMarkers result={result} surface={surface} probe={probe} scale={scale} />
    );
  }, [currentThermalPresentation]);
  const locateThermalComponent = useEditorAction((id: string) => {
    const snapshot = core.getSnapshot();
    if (
      !active ||
      screen !== 'workspace' ||
      !thermalVisible ||
      modal ||
      confirmation ||
      snapshot.sourceDraft !== null ||
      snapshot.editingBlocked ||
      snapshot.project?.pcb !== project?.pcb
    )
      return false;
    return thermalLocateRef.current?.(id) ?? false;
  });
  const thermalPanel = useMemo(
    () =>
      thermalAvailable && thermalOpened && project ? (
        <Suspense fallback={null}>
          <ThermalSimulation
            project={project}
            fileId={fileId}
            visible={active && screen === 'workspace' && thermalVisible}
            sourcePending={sourcePending}
            spiceAvailable={spiceAvailable}
            capabilityHost={capabilityHost}
            agentContextRef={thermalAgentContext}
            docked
            onPresentationChange={setThermalPresentation}
            onLocateFootprint={locateThermalComponent}
            onClose={closeThermal}
          />
        </Suspense>
      ) : null,
    [
      thermalAvailable,
      thermalOpened,
      project,
      fileId,
      active,
      screen,
      thermalVisible,
      sourcePending,
      spiceAvailable,
      capabilityHost,
      closeThermal,
      locateThermalComponent,
    ],
  );
  const layoutPluginActions = useMemo(
    () =>
      thermalAvailable || parasiticsAvailable ? (
        <>
          {thermalAvailable && (
            <ToolButton
              label="Layout Thermal"
              active={thermalEnabled}
              disabled={sourcePending || !project?.pcb}
              onClick={openThermal}
            >
              <PluginLogo id={THERMAL_PLUGIN_ID} />
            </ToolButton>
          )}
          {parasiticsAvailable && (
            <ToolButton
              label="Layout Parasitics"
              active={parasiticsVisible}
              buttonRef={parasiticsButton}
              disabled={!canShowParasitics}
              onClick={() =>
                setLayoutAnalysis((current) => (current === 'parasitics' ? null : 'parasitics'))
              }
            >
              <PluginLogo id={LAYOUT_PARASITICS_PLUGIN_ID} />
            </ToolButton>
          )}
        </>
      ) : null,
    [
      thermalAvailable,
      thermalEnabled,
      parasiticsAvailable,
      parasiticsVisible,
      canShowParasitics,
      sourcePending,
      project?.pcb,
      openThermal,
    ],
  );
  const ruleStatus = useMemo(() => {
    const disabled =
      !active ||
      screen !== 'workspace' ||
      sourcePending ||
      Boolean(coreSnapshot.editingBlocked) ||
      (ruleKind !== 'erc' && !project?.pcb);
    if (ruleKind === 'model') {
      const report = currentModelCheckReport;
      const state =
        report?.state === 'ready'
          ? 'ready'
          : report?.state === 'error'
            ? 'failed'
            : report
              ? 'checking'
              : 'unchecked';
      return (
        <RuleStatus
          kind="model"
          state={state}
          report={
            report && report.state !== 'loading'
              ? { issues: report.issues, complete: report.state === 'ready' }
              : null
          }
          expanded={rulePanelVisible}
          disabled={disabled}
          panelId={rulePanelId}
          buttonRef={ruleStatusButton}
          onToggle={() => (rulePanelVisible ? dismissRulePanel() : openRuleChecks())}
        />
      );
    }
    const kind = ruleKind;
    const stored = ruleReports[kind];
    const stale =
      (!!stored && stored.basis !== ruleBases[kind]) ||
      (kind === 'drc' && layoutSyncStatus.pending);
    const failed =
      (doc && ruleFailureBasis.current[kind] === ruleBases[kind]) ||
      (kind === 'drc' && layoutSyncStatus.error);
    const state =
      ruleBusy?.kind === kind && (!ruleBusy.automatic || !stored)
        ? 'checking'
        : failed
          ? 'failed'
          : stale
            ? 'stale'
            : stored
              ? 'ready'
              : 'unchecked';
    return (
      <RuleStatus
        kind={kind}
        report={state === 'ready' ? (stored?.result ?? null) : null}
        state={state}
        expanded={rulePanelVisible}
        disabled={disabled}
        panelId={rulePanelId}
        buttonRef={ruleStatusButton}
        onToggle={() => (rulePanelVisible ? dismissRulePanel() : openRuleChecks())}
      />
    );
  }, [
    ruleKind,
    project?.pcb,
    ruleReports,
    coreSnapshot.revision,
    doc?.id,
    ruleBases,
    layoutSyncStatus.pending,
    layoutSyncStatus.error,
    ruleBusy,
    ruleErrors,
    currentModelCheckReport,
    rulePanelVisible,
    rulePanelId,
    dismissRulePanel,
    active,
    screen,
    sourcePending,
    coreSnapshot.editingBlocked,
    openRuleChecks,
    requestRuleCheck,
  ]);
  useEffect(() => {
    if (
      !active ||
      screen !== 'workspace' ||
      !project ||
      !doc ||
      sourcePending ||
      coreSnapshot.editingBlocked ||
      modal ||
      confirmation ||
      ruleBusy ||
      ruleWork.current ||
      ruleKind === 'model'
    )
      return;
    const kind = ruleKind;
    if (kind === 'drc' && (!project.pcb || layoutSyncStatus.pending || layoutSyncStatus.error))
      return;
    if (rulesOpen === 'drc' && ruleDRCDraftPending) return;
    const stored = ruleReports[kind];
    const opening = rulesOpen === kind && ruleOpenRefresh.current === view;
    if (!opening) {
      if (stored?.basis === ruleBases[kind]) return;
      const basis = ruleBases[kind];
      if (ruleFailureBasis.current[kind] === basis) return;
    }
    const first = !stored;
    const quietMs = first ? 50 : opening ? 250 : 650;
    const earliest = performance.now() + (first ? 0 : quietMs);
    const input = ruleInput.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: number | undefined;
    const waitForIdle = () => {
      timer = undefined;
      if (input.heldPointers.size) return;
      const remaining = Math.max(earliest, input.lastActivity + quietMs) - performance.now();
      if (remaining > 0) {
        timer = setTimeout(waitForIdle, Math.ceil(remaining));
        return;
      }
      idle = window.requestIdleCallback(() => {
        idle = undefined;
        if (input.heldPointers.size || performance.now() - input.lastActivity < quietMs) {
          waitForIdle();
          return;
        }
        input.resume = null;
        requestRuleCheck(kind, view);
      });
    };
    input.resume = () => {
      if (timer === undefined && idle === undefined) waitForIdle();
    };
    waitForIdle();
    return () => {
      input.resume = null;
      clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, [
    active,
    screen,
    view,
    ruleKind,
    project,
    doc?.id,
    sourcePending,
    coreSnapshot.revision,
    coreSnapshot.editingBlocked,
    modal,
    confirmation,
    rulesOpen,
    ruleDRCDraftPending,
    ruleBusy,
    ruleReports,
    ruleErrors,
    ruleBases,
    layoutSyncStatus.pending,
    layoutSyncStatus.error,
    requestRuleCheck,
  ]);
  const undoAction = useMemo(
    () => (
      <>
        <ToolButton label="Undo" disabled={!coreSnapshot.canUndo} onClick={undoStep}>
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton label="Redo" disabled={!coreSnapshot.canRedo} onClick={redoStep}>
          <Redo2 size={16} />
        </ToolButton>
      </>
    ),
    [coreSnapshot.canUndo, coreSnapshot.canRedo, undoStep, redoStep],
  );
  const onSourceChange = useCallback(
    (value: string) => {
      if (!activeSourceFile || sourceReadOnly) return;
      if (diskObservationSelected) directoryObservation.change(activeSourceFile.name, value);
      else core.updateNativeSource(activeSourceFile.name, value);
    },
    [
      core,
      activeSourceFile?.name,
      sourceReadOnly,
      diskObservationSelected,
      directoryObservation.change,
    ],
  );
  const onSourceApply = useEditorAction(async () => {
    if (diskObservationSelected && activeSourceFile) {
      try {
        await directoryObservation.save(activeSourceFile.name);
      } catch (error) {
        notify((error as Error).message);
      }
    } else await applySource();
  });
  const onSourceCopy = useEditorAction(
    () =>
      void navigator.clipboard
        .writeText(activeSourceFile?.source ?? '')
        .then(() => notify('File source copied'))
        .catch(() => notify('Clipboard access is unavailable.')),
  );
  const gridDensityControl = useMemo(
    () => (
      <span className="grid-density">
        <Select
          label="Grid density"
          icon={<Grid3X3 size={14} aria-hidden="true" />}
          showChevron={false}
          popupClassName="grid-density-popup"
          popupPlacement="top-end"
          popupAnchor=".status-bar"
          popupBoundary=".editor-drawing-region, .file-editor-surface"
          active={active && screen === 'workspace'}
          value={grid ? String(activeGridSpacing) : 'off'}
          options={[
            ...activeGridSpacingOptions.map((spacing) => ({
              value: String(spacing),
              label: `${spacing} mm`,
            })),
            { value: 'off', label: 'Off' },
          ]}
          disabled={!appearanceSettings.ready}
          onChange={(value) => {
            const schematicSpacing = gridSpacingOptions.find((item) => String(item) === value);
            const layoutSpacing = layoutGridSpacingOptions.find((item) => String(item) === value);
            if (
              value !== 'off' &&
              (view === 'layout' ? layoutSpacing : schematicSpacing) === undefined
            )
              return;
            appearanceSettings.update({
              ...appearanceSettings.appearance,
              gridSpacing: view === 'canvas' ? (schematicSpacing ?? gridSpacing) : gridSpacing,
              layoutGridSpacing:
                view === 'layout' ? (layoutSpacing ?? layoutGridSpacing) : layoutGridSpacing,
              modelGridSpacing:
                view === '3d' ? (schematicSpacing ?? modelGridSpacing) : modelGridSpacing,
              schematicLayers: { ...layers, grid: value !== 'off' },
            });
          }}
        />
        {appearanceSettings.error && (
          <ToolButton
            label={appearanceSettings.error}
            hint="Appearance settings"
            onClick={() => notify(appearanceSettings.error)}
          >
            <AlertCircle size={14} aria-hidden="true" />
          </ToolButton>
        )}
      </span>
    ),
    [
      activeGridSpacing,
      activeGridSpacingOptions,
      active,
      appearanceSettings,
      screen,
      view,
      gridSpacing,
      layoutGridSpacing,
      modelGridSpacing,
      layers,
      grid,
      notify,
    ],
  );
  const openPartsList = useEditorAction(async () => {
    if (!(await applySource())) return;
    setPropertiesDismissed(true);
    setModal('parts');
  });
  const openHistory = useEditorAction(() => openProjectHistory());
  const projectWindowActions = useMemo(
    () => (
      <>
        <button
          type="button"
          className={`tool-button${modal === 'parts' ? ' active' : ''}`}
          aria-label="List"
          title="List"
          aria-haspopup="dialog"
          aria-expanded={modal === 'parts'}
          onClick={openPartsList}
        >
          <List size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`tool-button${modal === 'history' ? ' active' : ''}`}
          aria-label="Git"
          title="Git"
          aria-haspopup="dialog"
          aria-expanded={modal === 'history'}
          onClick={openHistory}
        >
          <GitIcon size={17} aria-hidden="true" />
        </button>
      </>
    ),
    [modal, openPartsList, openHistory],
  );
  const activateSchematicTool = useEditorAction(async (next: Tool) => {
    if (!(await changeView('canvas'))) return;
    setTool(next);
    queueSchematicNavigation(next, undefined, next === 'select');
  });
  const activateSchematicWire = useEditorAction(async () => {
    if (!(await changeView('canvas'))) return;
    setTool('wire');
    queueSchematicNavigation('wire');
  });
  const openSchematicLibrary = useCallback(() => setModal('library'), []);
  const placeSchematicMarker = useEditorAction(async (value: string) => {
    if (!(await changeView('canvas'))) return;
    if (value === 'power') setModal('power');
    else {
      setTool(value as Tool);
      queueSchematicNavigation(value as Tool);
    }
  });
  const schematicCanvasView = view === 'canvas';
  // These groups have no design/selection/history dependency. Retain their JSX
  // and icons while stable actions read current Source/view state on activation.
  const schematicModeActions = useMemo(
    () => (
      <div className="editor-tool-group" role="group" aria-label="Canvas modes">
        <ToolButton
          label="Interaction mode"
          active={schematicCanvasView && tool === 'select'}
          onClick={() => activateSchematicTool('select')}
        >
          <MousePointer2 size={17} />
        </ToolButton>
        <ToolButton
          label="Annotation mode"
          active={schematicCanvasView && tool === 'annotate'}
          disabled={sourcePending}
          onClick={() => activateSchematicTool('annotate')}
        >
          <MessageSquareText size={17} />
        </ToolButton>
      </div>
    ),
    [schematicCanvasView, tool, sourcePending, activateSchematicTool],
  );
  const schematicPlaceActions = useMemo(
    () => (
      <div className="editor-tool-group" role="group" aria-label="Place and connect">
        <ToolButton label="Add component" onClick={openSchematicLibrary}>
          <SymbolIcon size={17} aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Wire"
          active={schematicCanvasView && tool === 'wire'}
          onClick={activateSchematicWire}
        >
          <WireIcon size={17} aria-hidden="true" />
        </ToolButton>
        <div
          className={
            schematicCanvasView && ['label', 'global-label', 'no-connect'].includes(tool)
              ? 'tool-menu active'
              : 'tool-menu'
          }
        >
          <Select
            label="Place electrical marker"
            value=""
            icon={<Tag size={16} />}
            compact
            iconOnly
            showChevron={false}
            options={[
              { value: 'label', label: 'Net label' },
              { value: 'global-label', label: 'Global label' },
              { value: 'no-connect', label: 'No-connect marker' },
              { value: 'power', label: 'Power symbol' },
            ]}
            onChange={placeSchematicMarker}
          />
        </div>
      </div>
    ),
    [schematicCanvasView, tool, openSchematicLibrary, activateSchematicWire, placeSchematicMarker],
  );
  const selectEditorView = useEditorAction(changeView);
  const closeHistory = useCallback(() => setModal(null), []);
  const saveHistoryProject = useEditorAction(() => save());
  const runHeaderFileAction = useEditorAction((value: string) =>
    runTitlebarMenuAction(titlebarMenus[0].items, value),
  );
  const closeHeaderProject = useEditorAction(requestProjectClose);
  const hasDocument = Boolean(doc);
  const headerProjectTitle = project?.name ?? project?.schematic.title;
  // Keep fallback labels aligned with the latest menu indices used by the guarded actions.
  const headerFileOptions = useMemo(
    () => titlebarMenuOptions(titlebarMenus[0].items),
    [hasDocument, canAddSchematicFile, canExportBoard, canExportModel, exampleList.sections],
  );
  const appHeader = useMemo(
    () => (
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <Logo size={32} />
          </div>
          <strong>OpenPE</strong>
        </div>
        {screen === 'workspace' && hasDocument && (
          <>
            <span className="header-separator" />
            <div className="breadcrumb">
              <strong>{headerProjectTitle}</strong>
            </div>
          </>
        )}
        <div className="app-header-actions">
          {!hasNativeTitlebar && (
            <nav className="header-file-menu" aria-label="Application menus">
              <Select
                label="File"
                value=""
                placeholder="File"
                compact
                showChevron={false}
                popupClassName="application-menu"
                options={headerFileOptions}
                onChange={runHeaderFileAction}
              />
            </nav>
          )}
          {screen === 'workspace' && hasDocument && (
            <RevealButton
              className="header-project-close"
              icon={X}
              iconSize={17}
              label="Close project"
              onClick={closeHeaderProject}
            />
          )}
        </div>
      </header>
    ),
    [
      screen,
      hasDocument,
      headerProjectTitle,
      hasNativeTitlebar,
      headerFileOptions,
      runHeaderFileAction,
      closeHeaderProject,
    ],
  );
  const openWorkspaceHome = useCallback(() => {
    cancelPendingNavigation();
    setModal(null);
    setScreen('home');
  }, []);
  const createWorkspaceProject = useEditorAction(() => newFile());
  const openWorkspaceProject = useEditorAction(() => void open());
  const openWorkspacePlugins = useEditorAction(openPlugins);
  const workspaceNavigationActions = useMemo(
    () => (
      <>
        <NavigationButton compact icon={HomeIcon} label="Home" onClick={openWorkspaceHome} />
        <NavigationButton
          compact
          icon={FolderPlus}
          label="New project"
          onClick={createWorkspaceProject}
        />
        <NavigationButton
          compact
          icon={FolderOpen}
          label="Open project"
          onClick={openWorkspaceProject}
        />
        <NavigationButton compact icon={Blocks} label="Plugins" onClick={openWorkspacePlugins} />
      </>
    ),
    [openWorkspaceHome, createWorkspaceProject, openWorkspaceProject, openWorkspacePlugins],
  );
  const openWorkspaceSettings = useCallback(() => setModal('settings'), []);
  const providerBusy = Boolean(runningSessions[activeSessionId]);
  const workspaceNavigationSettings = useMemo(
    () => (
      <>
        <div className="rail-spacer" />
        <AgentPicker
          compact
          provider={provider}
          agents={agents}
          onChange={setProvider}
          disabled={providerBusy}
        />
        <NavigationButton
          compact
          icon={Settings}
          label="Settings"
          onClick={openWorkspaceSettings}
        />
      </>
    ),
    [provider, agents, setProvider, providerBusy, active, openWorkspaceSettings],
  );
  const requestPropertiesSave = useEditorAction((saveAs: boolean) => {
    // The property commit has already advanced Core beyond this render's doc.
    // Save reads that live Core through applySource(), preserving its guards.
    void save(saveAs);
  });
  const saveCurrentPartProperties = useEditorAction(
    (id: string, ref: string, value: string, fields: Record<string, string>) =>
      canEditProperties() && part?.id === id ? saveFields(ref, value, fields, id) : false,
  );
  const editFootprintText = useEditorAction(
    (board: PCB, schematic: Circuit, id: string, value: string) => {
      const snapshot = core.getSnapshot();
      if (
        !active ||
        screen !== 'workspace' ||
        view !== 'layout' ||
        !rightSidebarVisible ||
        layoutAnalysisVisible ||
        modal ||
        confirmation ||
        snapshot.project?.pcb !== board ||
        snapshot.project.schematic !== schematic
      )
        return false;
      const item = findPCBGraphic(board, id);
      const property = item?.graphic.text?.property;
      if (!item?.owner || item.owner.locked || item.graphic.locked) return false;
      if (property !== 'Reference' && property !== 'Value') return false;
      const changes = property === 'Reference' ? { reference: value } : { value };
      try {
        if (item.owner.symbolId) {
          core.execute('part.properties', {
            schematicId: schematic.id,
            partId: item.owner.symbolId,
            ...changes,
          });
        } else {
          core.execute('layout.footprint.properties', {
            boardId: board.id,
            footprintId: item.owner.id,
            changes,
          });
        }
        return true;
      } catch (error) {
        notify((error as Error).message);
        return false;
      }
    },
  );
  const propertiesPartId = part?.id;
  const propertiesBoard = project?.pcb;
  const propertiesFootprint = propertiesBoard?.footprints.find((f) => f.symbolId === part?.id);
  const getPropertiesRevision = useCallback(() => core.getSnapshot().revision, [core]);
  const saveSelectedPartProperties = useCallback(
    (ref: string, value: string, fields: Record<string, string>) =>
      propertiesPartId ? saveCurrentPartProperties(propertiesPartId, ref, value, fields) : false,
    [propertiesPartId, saveCurrentPartProperties],
  );
  const saveModelBoardThickness = useEditorAction((basis: PCB, thickness: number) => {
    const snapshot = core.getSnapshot();
    if (
      !active ||
      screen !== 'workspace' ||
      view !== '3d' ||
      modal ||
      confirmation ||
      snapshot.sourceDraft !== null ||
      snapshot.editingBlocked !== null ||
      snapshot.project?.pcb !== basis
    )
      return false;
    return commitBoard({ ...basis, thickness });
  });
  const saveComponentFootprint = useEditorAction((basis: PCB, next: PCB['footprints'][number]) => {
    const current = core.getSnapshot();
    if (
      !active ||
      screen !== 'workspace' ||
      !['schematic', 'layout', '3d'].includes(view) ||
      !rightSidebarVisible ||
      modal ||
      confirmation ||
      current.sourceDraft !== null ||
      current.editingBlocked !== null ||
      current.project?.pcb !== basis ||
      !basis.footprints.some((f) => f.id === next.id)
    )
      return false;
    return commitBoard({
      ...basis,
      footprints: basis.footprints.map((f) => (f.id === next.id ? next : f)),
    });
  });
  const saveLayoutPartProperties = useEditorAction(
    (
      schematicBasis: Circuit,
      partId: string,
      ref: string,
      value: string,
      fields: Record<string, string>,
      footprintDetail?: FootprintDetail,
    ) => {
      const snapshot = core.getSnapshot();
      if (
        !active ||
        screen !== 'workspace' ||
        !['schematic', 'layout', '3d'].includes(view) ||
        !rightSidebarVisible ||
        layoutAnalysisVisible ||
        modal ||
        confirmation ||
        snapshot.sourceDraft !== null ||
        snapshot.editingBlocked !== null ||
        !snapshot.project ||
        snapshot.project.schematic !== schematicBasis ||
        !snapshot.project.pcb?.footprints.some((footprint) => footprint.symbolId === partId)
      )
        return false;
      return saveFields(ref, value, fields, partId, schematicBasis, footprintDetail);
    },
  );

  const drawingStatusBar = useMemo(
    () => (
      <EditorStatusBar
        className={view === '3d' ? 'model-editor-status' : undefined}
        hidden={view !== 'canvas' && view !== '3d'}
        active={active && screen === 'workspace'}
        ruleStatus={ruleStatus}
        centerCoordinates
        mode={
          view === '3d'
            ? project?.pcb
              ? modelMode
              : 'Interaction mode'
            : schematicMoveMode
              ? schematicMoveMode === 'drag'
                ? 'Click to place · Keep connections'
                : 'Click to place selection'
              : {
                  select: 'Interaction mode',
                  hand: 'Pan',
                  annotate: 'Annotation mode',
                  wire: 'Click to route · Connect to finish',
                  place: 'Click to place component',
                  label: 'Click to place label',
                  'global-label': 'Click to place global label',
                  'no-connect': 'Click a pin to mark unconnected',
                  drag: 'Drag with connections',
                }[tool]
        }
        coordinates={
          view === 'canvas' ? (
            <CanvasCoordinates coordinates={coordinates} />
          ) : view === '3d' && modelMode === 'Measure distance' ? (
            <MeasurementReadout measurement={modelMeasurement} spatial />
          ) : view === '3d' && modelMode === 'Draw sketch' ? (
            <ModelSketchCoordinates coordinates={modelSketchCoordinates} />
          ) : undefined
        }
        controls={view === 'canvas' ? gridDensityControl : undefined}
        status={draftStatus || undefined}
        actions={
          view === '3d' ? (
            <>
              <span className="model-error-target" ref={setModelErrorTarget} />
              {gridDensityControl}
            </>
          ) : undefined
        }
      />
    ),
    [
      active,
      screen,
      view,
      project?.pcb,
      modelMode,
      schematicMoveMode,
      tool,
      coordinates,
      modelMeasurement,
      modelSketchCoordinates,
      gridDensityControl,
      draftStatus,
      ruleStatus,
    ],
  );
  const rulePanel = rulesOpen && rulePanelVisible && (
    <Suspense fallback={null}>
      <RuleCheckPanel
        panelId={rulePanelId}
        kind={rulesOpen}
        report={currentRuleReport?.result ?? null}
        busy={ruleBusy?.kind === rulesOpen}
        quietRefresh={ruleBusy?.automatic && !!currentRuleReport}
        error={rulesOpen === 'model' ? '' : ruleErrors[rulesOpen]}
        stale={ruleReportStale}
        sourcePending={sourcePending}
        blockedReason={coreSnapshot.editingBlocked ?? ''}
        drcSource={rulesOpen === 'drc' ? project : undefined}
        drcSettings={drcSettings}
        retainedDRCQuickLimits={retainedDRCQuickLimits}
        onDRCDraftChange={setRuleDRCDraftPending}
        onDRCSettingsChange={applyBasicDRCSettings}
        onOpenSettings={
          rulesOpen === 'model'
            ? undefined
            : () => setModal(rulesOpen === 'erc' ? 'erc-settings' : 'drc-settings')
        }
        onRun={(settings) => {
          if (rulesOpen !== 'model') void runRuleChecks(rulesOpen, settings);
        }}
        onSelectIssue={locateRuleIssue}
        modelReport={currentModelCheckReport}
        onSelectModelCheckIssue={locateModelCheckIssue}
        onClose={dismissRulePanel}
      />
    </Suspense>
  );
  return (
    <>
      <DesktopTitlebar
        menus={titlebarMenus}
        onBack={navigation.index > 0 ? () => navigateHistory(-1) : undefined}
        onForward={
          navigation.index < navigation.entries.length - 1 ? () => navigateHistory(1) : undefined
        }
      />
      <main className={'app-shell' + (sidebarVisible ? '' : ' sidebar-hidden')}>
        {appHeader}
        {screen === 'home' && (
          <Home
            exampleList={exampleList}
            active={active}
            brief={homeBrief}
            setBrief={setHomeBrief}
            projects={projects}
            onProjectAction={onProjectAction}
            error={startupError}
            onNew={(brief) => newFile(undefined, brief)}
            onOpen={() => void open()}
            onExample={(id) => newFile(id)}
            onResume={onSelectProject}
            onNewSession={onNewProjectSession}
            onSettings={() => setModal('settings')}
            onPlugins={openPlugins}
            agentPicker={{
              provider,
              agents,
              onChange: setProvider,
              disabled: Boolean(runningSessions[activeSessionId]),
            }}
            composer={{
              provider,
              available: Boolean(agents.find((a) => a.id === provider)?.available),
              agentSupportsEffort: agents.find((a) => a.id === provider)?.supportsEffort,
              effort,
              setEffort,
              approvalMode,
              setApprovalMode,
              model: models[provider] || '',
              setModel: (value) => setModels((current) => ({ ...current, [provider]: value })),
              observedModel: (
                sessions
                  .find((session) => session.id === activeSessionId)
                  ?.messages.slice()
                  .reverse()
                  .find((message) => message.provider === provider && message.model)?.model || ''
              ).split(' · ')[0],
            }}
          />
        )}
        {doc && (
          <div className="workspace" hidden={screen !== 'workspace'}>
            <nav className="nav-rail" aria-label="Workspace navigation">
              {!sidebarVisible && (
                <SidebarToggle
                  side="left"
                  visible={false}
                  onToggle={toggleSidebar}
                  className="conversation-restore"
                />
              )}
              {workspaceNavigationActions}
              <ProjectNavigation
                projects={projects}
                active={active && screen === 'workspace'}
                activeId={documentId}
                onAction={onProjectAction}
                onSessionAction={onProjectSessionAction}
                activeSessionId={activeSessionId}
                onSelectSession={(id, sessionId) => {
                  setSidebarVisible(true);
                  onSelectProject(id, sessionId);
                }}
                onSelect={onSelectProject}
                onNewSession={onNewProjectSession}
              />
              {workspaceNavigationSettings}
            </nav>
            {sessions.map((session) => (
              <ConversationSession
                key={documentKey + ':' + session.id}
                active={active && screen === 'workspace' && session.id === activeSessionId}
                onRunningChange={onRunningChange}
                session={session}
                setSessions={setSessions}
                getDesign={getChatDesign}
                annotationDesign={session.annotations?.length ? chatAnnotationDesign : undefined}
                sidebarVisible={sidebarVisible}
                onToggleSidebar={toggleSidebar}
                getWorkspaceContext={readChatContext}
                capabilities={chatCapabilities}
                agents={agents}
                provider={provider}
                effort={effort}
                approvalMode={approvalMode}
                setApprovalMode={setApprovalMode}
                setEffort={setEffort}
                model={models[provider] || ''}
                setModel={setChatModel}
                onSettings={openChatSettings}
                onApply={applyChatProposal}
              />
            ))}
            <WorkspaceDivider active={active && screen === 'workspace'} />
            <section className="editor" data-editor-view={view}>
              <div className="editor-mode-bar">
                <EditorViewSwitch view={view} onChange={selectEditorView} />
                <div className="editor-mode-actions" role="group" aria-label="Project actions">
                  <ToolButton
                    label="Draw component"
                    disabled={
                      sourcePending || Boolean(coreSnapshot.editingBlocked) || modelDrawingBlocked
                    }
                    onClick={() => {
                      if (!modelDrawingBlocked) setModal('drawing');
                    }}
                  >
                    <PencilRuler size={17} />
                  </ToolButton>
                  {projectWindowActions}
                  {(view === 'canvas' ||
                    ((view === 'layout' || view === '3d') && Boolean(project?.pcb))) &&
                    rightSidebarAction}
                </div>
              </div>
              <div
                ref={schematicTabs}
                className="schematic-sheet-bar"
                hidden={schematicFiles.length < 2 || (view !== 'canvas' && view !== 'source')}
              >
                <SchematicFileTabs
                  files={openSchematicFiles.map((file) => ({
                    id: file.id,
                    name: file.title,
                    modified:
                      savedSchematics.get(file.id) !== currentSchematics.get(file.id) ||
                      sourcePending ||
                      Boolean(file.id === project!.schematic.id && projectMetadataDirty),
                  }))}
                  activeId={doc.id}
                  panelId={`schematic-panel-${documentId}`}
                  onSelect={selectSchematic}
                  onClose={closeSchematicFile}
                />
                {closedSchematicIds.length > 0 && (
                  <span className="schematic-open-file">
                    <Select
                      label="Open file"
                      icon={<FolderOpen size={17} />}
                      iconOnly
                      compact
                      showChevron={false}
                      value=""
                      options={schematicFiles
                        .filter((file) => closedSchematicIds.includes(file.id))
                        .map((file) => ({ value: file.id, label: file.title }))}
                      onChange={selectSchematic}
                    />
                  </span>
                )}
              </div>

              <div
                className="editor-body"
                data-view={view}
                id={`schematic-panel-${documentId}`}
                role="tabpanel"
                aria-label={project!.name ?? project!.schematic.title}
              >
                <div className="file-editor-surface schematic-surface" hidden={view !== 'canvas'}>
                  <div className="schematic-drawing editor-drawing-region">
                    <RetainedSchematicToolbar
                      visible={active && screen === 'workspace' && view === 'canvas'}
                    >
                      {() => (
                        <div
                          className="editor-toolbar"
                          role="group"
                          aria-label="Schematic tools"
                          hidden={view !== 'canvas'}
                        >
                          {schematicModeActions}
                          {schematicPlaceActions}
                          <div
                            className="editor-tool-group"
                            role="group"
                            aria-label="Edit and history"
                          >
                            <div
                              className={
                                view === 'canvas' && (tool === 'drag' || schematicMoveMode)
                                  ? 'tool-menu active'
                                  : 'tool-menu'
                              }
                            >
                              <Select
                                label="Edit schematic"
                                value=""
                                icon={<RotateCw size={16} />}
                                compact
                                iconOnly
                                showChevron={false}
                                options={[
                                  ...(selection.length
                                    ? [{ value: 'move', label: 'Move selection' }]
                                    : []),
                                  ...(selection.some((id) => !selectedField(id))
                                    ? [
                                        { value: 'copy', label: 'Copy selection' },
                                        { value: 'duplicate', label: 'Duplicate selection' },
                                        { value: 'rotate', label: 'Rotate' },
                                        { value: 'mirrorY', label: 'Mirror horizontally' },
                                        { value: 'mirrorX', label: 'Mirror vertically' },
                                        { value: 'delete', label: 'Delete selection' },
                                      ]
                                    : []),
                                  ...(clipboard.current?.doc.id === doc.id
                                    ? [{ value: 'paste', label: 'Paste' }]
                                    : []),
                                  { value: 'drag', label: 'Drag with connections' },
                                  { value: 'simplify', label: 'Simplify wires' },
                                ]}
                                onChange={async (value) => {
                                  if (!(await changeView('canvas'))) return;
                                  if (value === 'copy') copySelection();
                                  else if (value === 'paste') pasteSelection();
                                  else if (value === 'duplicate') duplicate();
                                  else if (value === 'rotate') rotate();
                                  else if (value === 'delete') remove();
                                  else if (value === 'move') requestSchematicMove(false);
                                  else if (value === 'drag') {
                                    if (selection.length) requestSchematicMove(true);
                                    else {
                                      setTool('drag');
                                      queueSchematicNavigation('drag');
                                    }
                                  } else if (value === 'simplify') commit(simplifyWires(doc));
                                  else
                                    commit(
                                      transformSelection(
                                        doc,
                                        selection,
                                        value as 'mirrorX' | 'mirrorY',
                                      ),
                                    );
                                }}
                              />
                            </div>
                            <ToolButton
                              label="Undo"
                              disabled={!coreSnapshot.canUndo}
                              onClick={undoStep}
                            >
                              <Undo2 size={16} />
                            </ToolButton>
                            <ToolButton
                              label="Redo"
                              disabled={!coreSnapshot.canRedo}
                              onClick={redoStep}
                            >
                              <Redo2 size={16} />
                            </ToolButton>
                          </div>
                          {spiceAvailable && (
                            <div
                              className="editor-tool-group editor-plugin-actions"
                              role="group"
                              aria-label="Plugins"
                            >
                              <ToolButton
                                label="SPICE Simulation"
                                active={simulationEnabled}
                                disabled={sourcePending}
                                onClick={() => {
                                  setModal(null);
                                  setSimulationOpened(true);
                                  setSimulationEnabled(true);
                                }}
                              >
                                <PluginLogo id={SPICE_PLUGIN_ID} />
                              </ToolButton>
                            </div>
                          )}
                        </div>
                      )}
                    </RetainedSchematicToolbar>
                    <div className="schematic-canvas-area">
                      <SchematicCanvas
                        ruleFocus={ruleFocus?.kind === 'erc' && !ruleReportStale ? ruleFocus : null}
                        active={active && screen === 'workspace' && view === 'canvas'}
                        editingBlocked={sourcePending}
                        moveRequest={schematicMoveRequest}
                        onMoveStateChange={setSchematicMoveMode}
                        onMoveRequestHandled={onMoveRequestHandled}
                        navigationRequest={
                          schematicNavigationEligible ? schematicNavigationRequest : null
                        }
                        onNavigationRequestHandled={onNavigationRequestHandled}
                        key={doc.id}
                        initialViewport={canvasViewport}
                        onViewportChange={onCanvasViewportChange}
                        doc={doc}
                        selection={selection}
                        onSelection={setSelection}
                        onSelect={setSelected}
                        tool={tool}
                        probing={simulationVisible && !sourcePending}
                        onProbe={setProbe}
                        kind="R"
                        placement={placement}
                        onProperties={canvasProperties}
                        onDelete={canvasDelete}
                        annotationSessionId={activeSessionId}
                        annotations={annotations}
                        onAnnotationsChange={onAnnotationsChange}
                        onAnnotationAdd={onAnnotationAdd}
                        onCommit={commit}
                        setTool={setTool}
                        fitKey={fitKey}
                        onPosition={coordinates.update}
                        grid={grid}
                        gridSpacing={gridSpacing}
                        layers={layers}
                        selectionFilters={selectionFilters}
                        leftButtonDrag={appearanceSettings.appearance.leftButtonDrag}
                        onNotify={notify}
                      />
                    </div>
                    <div
                      ref={waveformHost}
                      className="simulation-host"
                      hidden={!simulationVisible || !waveformRequested}
                    >
                      <BottomPanelResize
                        label="Resize waveform panel"
                        target={waveformHost}
                        visible={simulationVisible && waveformRequested}
                      />
                    </div>
                    {view === 'canvas' && rulePanel}
                    {view === 'canvas' && drawingStatusBar}
                  </div>
                  <InspectorResize
                    target={simulationSettingsHost}
                    size={inspectorSize}
                    onResize={setInspectorSize}
                    label="simulation settings"
                    axes={['width']}
                    gutter
                    hidden={!simulationVisible}
                    minWidth={280}
                    bounds={() => ({
                      width: Math.min(
                        480,
                        Math.max(
                          0,
                          (simulationSettingsHost.current?.parentElement?.clientWidth ?? 440) - 172,
                        ),
                      ),
                      height: simulationSettingsHost.current?.parentElement?.clientHeight ?? 0,
                    })}
                  />
                  <div
                    ref={simulationSettingsHost}
                    className="simulation-settings-host"
                    hidden={!simulationVisible}
                    style={{ width: inspectorSize.width }}
                  />
                  <InspectorResize
                    target={propertiesDock}
                    size={inspectorSize}
                    onResize={setInspectorSize}
                    axes={['width']}
                    gutter
                    hidden={!rightSidebarVisible || simulationVisible}
                    minWidth={280}
                    bounds={() => ({
                      width: Math.min(
                        480,
                        Math.max(
                          0,
                          (propertiesDock.current?.parentElement?.clientWidth ?? 440) - 172,
                        ),
                      ),
                      height: propertiesDock.current?.parentElement?.clientHeight ?? 0,
                    })}
                  />
                  <div
                    ref={propertiesDock}
                    className="schematic-properties-dock editor-sidebar-sections"
                    role="complementary"
                    aria-label="Schematic properties"
                    data-testid="schematic-properties-panel"
                    hidden={!rightSidebarVisible || simulationVisible}
                    style={{ width: inspectorSize.width }}
                  >
                    <EditorDisplayDrawer
                      label="Properties"
                      className="editor-properties-drawer"
                      open={propertiesExpanded}
                      onOpenChange={setPropertiesExpanded}
                      headerActions={
                        inspectedField && part ? (
                          <button
                            className="icon-button"
                            aria-label="Component properties"
                            title="Component properties"
                            disabled={!propertiesActive}
                            onClick={() => openProperties(part.id)}
                          >
                            <SlidersHorizontal size={17} />
                          </button>
                        ) : undefined
                      }
                    >
                      {propertiesMounted && (part || label || wire || annotation) ? (
                        <aside
                          ref={propertiesInspector}
                          inert={!propertiesPresented}
                          className={
                            'inspector' +
                            (part ? ' part-inspector' : '') +
                            (inspectedField ? ' field-inspector' : '')
                          }
                          aria-label="Object properties"
                          key={inspectedField ? activeSelection : selected}
                        >
                          <div className="inspector-body">
                            {part ? (
                              <>
                                {!inspectedField && (
                                  <PartIdentity part={part} library={doc.libraries[part.libId]} />
                                )}
                                {inspectedField && fieldPosition && activeSelection ? (
                                  <FieldProperties
                                    active={propertiesActive}
                                    onRequestSave={requestPropertiesSave}
                                    field={inspectedField.field}
                                    text={
                                      inspectedField.field === 'Reference'
                                        ? part.ref
                                        : inspectedField.field === 'Value'
                                          ? displayPartValue(part)
                                          : partFields(part)[inspectedField.field] || ''
                                    }
                                    position={fieldPosition}
                                    onText={(text) => {
                                      if (!canEditProperties()) return false;
                                      const change = preparePartProperties(
                                        part,
                                        inspectedField.field === 'Reference' ? text : part.ref,
                                        inspectedField.field === 'Value'
                                          ? text
                                          : displayPartValue(part),
                                        Object.entries(partFields(part)).map(([name, value]) => ({
                                          name,
                                          value: name === inspectedField.field ? text : value,
                                        })),
                                      );
                                      return (
                                        !change ||
                                        saveFields(change.ref, change.value, change.fields, part.id)
                                      );
                                    }}
                                    onPosition={(position) =>
                                      canEditProperties() &&
                                      commit(moveText(doc, activeSelection, position))
                                    }
                                  />
                                ) : (
                                  <>
                                    <PartProperties
                                      circuit={doc}
                                      active={propertiesActive}
                                      spiceAvailable={spiceAvailable}
                                      fileId={fileId}
                                      getRevision={getPropertiesRevision}
                                      onRequestSave={requestPropertiesSave}
                                      capabilityHost={capabilityHost}
                                      key={part.id}
                                      part={part}
                                      tabAction={propertiesDeleteAction}
                                      modelFields={
                                        propertiesFootprint && propertiesBoard ? (
                                          <FootprintModels
                                            key={propertiesFootprint.id}
                                            footprint={propertiesFootprint}
                                            projectSource={source}
                                            active={propertiesActive}
                                            fileId={fileId}
                                            getRevision={getPropertiesRevision}
                                            capabilityHost={capabilityHost}
                                            onChange={(models) =>
                                              saveComponentFootprint(propertiesBoard, {
                                                ...propertiesFootprint,
                                                models,
                                              })
                                            }
                                          />
                                        ) : (
                                          <UnassignedModelField />
                                        )
                                      }
                                      geometryFields={
                                        <div className="geometry-fields component-geometry">
                                          {(['x', 'y', 'rotation'] as const).map((key) => (
                                            <NumberField
                                              key={part.id + key}
                                              label={
                                                key === 'rotation'
                                                  ? 'Rotation (°)'
                                                  : key.toUpperCase() + ' (mm)'
                                              }
                                              accessibleLabel={
                                                key === 'rotation'
                                                  ? 'Component rotation'
                                                  : 'Component ' + key.toUpperCase() + ' position'
                                              }
                                              value={part[key]}
                                              format={fmt}
                                              step={key === 'rotation' ? 'any' : '1.27'}
                                              min={key === 'rotation' ? -360 : -100000}
                                              max={key === 'rotation' ? 360 : 100000}
                                              active={propertiesActive}
                                              onCommit={(value) =>
                                                canEditProperties() &&
                                                patchGeometry(key, String(value)).success
                                              }
                                              onRequestSave={requestPropertiesSave}
                                            />
                                          ))}
                                        </div>
                                      }
                                      onSave={saveSelectedPartProperties}
                                    />
                                  </>
                                )}
                              </>
                            ) : annotation ? (
                              <button
                                className="dialog-button secondary"
                                disabled={!propertiesActive}
                                onClick={() => openAnnotation(annotation, annotation.id)}
                              >
                                Edit annotation
                              </button>
                            ) : label ? (
                              <div className="layout-property-section">
                                <label className="layout-field">
                                  Net name
                                  <input
                                    aria-label="Net name"
                                    key={`${label.id}:${label.text}`}
                                    defaultValue={label.text}
                                    disabled={!propertiesActive}
                                    onBlur={(e) => {
                                      saveNetName(e.currentTarget.value);
                                    }}
                                    onKeyDown={(e) => {
                                      if (
                                        !propertiesActive ||
                                        e.nativeEvent.isComposing ||
                                        e.nativeEvent.keyCode === 229
                                      ) {
                                        e.stopPropagation();
                                        return;
                                      }
                                      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (saveNetName(e.currentTarget.value))
                                          requestPropertiesSave(e.shiftKey);
                                        return;
                                      }
                                      if (e.key === 'Escape') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        e.currentTarget.value = label.text;
                                      }
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        e.currentTarget.blur();
                                      }
                                    }}
                                  />
                                </label>
                                {label.scope === 'global' && (
                                  <div className="layout-property-select">
                                    <span>Shape</span>
                                    <Select
                                      label="Global label shape"
                                      disabled={!propertiesActive}
                                      value={label.shape || 'input'}
                                      options={labelShapes.map((value) => ({
                                        value,
                                        label: value.replace('_', ' '),
                                      }))}
                                      onChange={(shape) => {
                                        if (!canEditProperties()) return;
                                        commit(
                                          saveLabel(doc, {
                                            id: label.id,
                                            shape: shape as (typeof labelShapes)[number],
                                          }).circuit,
                                        );
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="wire-properties layout-property-section">
                                <strong>Wire</strong>
                                <div className="layout-property-readout">
                                  <span>Length</span>
                                  <output>
                                    {Math.hypot(
                                      wire!.a.x - wire!.b.x,
                                      wire!.a.y - wire!.b.y,
                                    ).toFixed(2)}{' '}
                                    mm
                                  </output>
                                </div>
                              </div>
                            )}
                          </div>
                          {!part && propertiesDeleteAction && (
                            <footer className="inspector-footer">{propertiesDeleteAction}</footer>
                          )}
                        </aside>
                      ) : (
                        <section className="schematic-properties-empty">
                          <PropertiesEmptyState icon={SymbolIcon}>
                            {simulationEnabled
                              ? 'Close simulation to inspect component properties.'
                              : tool === 'annotate'
                                ? 'Exit annotation mode to inspect component properties.'
                                : 'Select a component to view its properties.'}
                          </PropertiesEmptyState>
                        </section>
                      )}
                    </EditorDisplayDrawer>
                    <div className="editor-display-drawers">
                      <EditorDisplayDrawer
                        label="Visualization"
                        className="editor-visualization-drawer"
                        open={schematicVisualizationOpen}
                        onOpenChange={setSchematicVisualizationOpen}
                      >
                        <SchematicLayers
                          layers={layers}
                          onChange={(schematicLayers) =>
                            appearanceSettings.update({
                              ...appearanceSettings.appearance,
                              schematicLayers,
                            })
                          }
                          disabled={!appearanceSettings.ready}
                          error={appearanceSettings.error}
                        />
                      </EditorDisplayDrawer>
                      <EditorDisplayDrawer
                        label="Selection"
                        className="editor-filters-drawer"
                        defaultOpen
                      >
                        <SchematicSelectionFilters
                          filters={selectionFilters}
                          onChange={setSelectionFilters}
                        />
                      </EditorDisplayDrawer>
                    </div>
                  </div>
                </div>
                {layoutOpened && project && (
                  <div className="file-editor-surface" hidden={view !== 'layout'}>
                    <Suspense fallback={<p role="status">Loading layout editor…</p>}>
                      <RetainedLayoutEditor
                        visible={active && screen === 'workspace' && view === 'layout'}
                        sidebarVisible={rightSidebarVisible && !layoutAnalysisVisible}
                        onShowSidebar={showLayoutSidebar}
                        onToggleSidebar={toggleRightSidebar}
                        ruleFocus={ruleFocus?.kind === 'drc' && !ruleReportStale ? ruleFocus : null}
                        capabilityHost={capabilityHost}
                        agentContextRef={layoutAgentContext}
                        board={project.pcb ?? undefined}
                        schematic={project.schematic}
                        grid={grid}
                        gridSpacing={layoutGridSpacing}
                        leftButtonDrag={appearanceSettings.appearance.leftButtonDrag}
                        gridControl={view === 'layout' ? gridDensityControl : undefined}
                        ruleStatus={view === 'layout' ? ruleStatus : undefined}
                        rulePanel={view === 'layout' ? rulePanel : undefined}
                        draftStatus={draftStatus || undefined}
                        active={
                          active &&
                          screen === 'workspace' &&
                          view === 'layout' &&
                          !modal &&
                          !confirmation
                        }
                        onCommit={commitBoard}
                        fileId={fileId}
                        projectSource={source}
                        getRevision={getPropertiesRevision}
                        spiceAvailable={spiceAvailable}
                        onSavePartProperties={saveLayoutPartProperties}
                        onEditFootprintText={editFootprintText}
                        onRequestSave={requestPropertiesSave}
                        syncStatus={layoutSyncStatus}
                        undoAction={undoAction}
                        analysisAction={layoutPluginActions}
                        analysisDrawing={thermalDrawing}
                        analysisComponentSurface={currentThermalPresentation?.surface}
                        analysisComponentDetail={thermalComponentDetail}
                        analysisMarkers={thermalMarkers}
                        onAnalysisComponentChange={setThermalSelectedFootprint}
                        analysisOutlineSurface={
                          currentThermalPresentation?.shown &&
                          currentThermalPresentation.outlinesShown
                            ? currentThermalPresentation.surface
                            : undefined
                        }
                        analysisReadout={thermalReadout}
                        analysisPanel={layoutAnalysisPanelMount}
                        analysisPanelVisible={layoutAnalysisVisible}
                        analysisLocateRef={thermalLocateRef}
                        onAnalysisProbe={
                          currentThermalPresentation?.probing
                            ? currentThermalPresentation.probeAt
                            : undefined
                        }
                        parasiticsProbe={parasiticsProbe}
                        annotationSessionId={activeSessionId}
                        annotations={annotations}
                        onAnnotationsChange={onAnnotationsChange}
                        annotationDisabled={sourcePending}
                        onAnnotationAdd={onAnnotationAdd}
                      />
                    </Suspense>
                    {/* Keep plugin lifecycle updates outside the retained editor's hidden tree. */}
                    {layoutAnalysisPanelTarget &&
                      createPortal(
                        <>
                          {thermalPanel}
                          {parasiticsVisible && project.pcb && (
                            <Suspense fallback={null}>
                              <LayoutParasiticsPanel
                                board={project.pcb}
                                schematic={project.schematic}
                                host={capabilityHost}
                                revision={coreSnapshot.revision}
                                startId={parasiticsTerminals[0]?.id}
                                endId={parasiticsTerminals[1]?.id}
                                composing={parasiticsComposing}
                                onReset={() => setParasiticsTerminals([])}
                                onClose={closeParasitics}
                              />
                            </Suspense>
                          )}
                        </>,
                        layoutAnalysisPanelTarget,
                      )}
                  </div>
                )}
                {objectOpened && project && (
                  <div className="file-editor-surface pcb-3d-surface" hidden={view !== '3d'}>
                    {project.pcb ? (
                      <Suspense fallback={<p role="status">Loading 3D board…</p>}>
                        <RetainedModelPreview
                          visible={active && screen === 'workspace' && view === '3d'}
                          sidebarVisible={rightSidebarVisible}
                          onShowSidebar={showRightSidebar}
                          onToggleSidebar={toggleRightSidebar}
                          active={
                            active &&
                            screen === 'workspace' &&
                            view === '3d' &&
                            !modal &&
                            !confirmation
                          }
                          board={project.pcb}
                          fileId={fileId}
                          projectSource={source}
                          getRevision={getPropertiesRevision}
                          spiceAvailable={spiceAvailable}
                          onSavePartProperties={saveLayoutPartProperties}
                          onFootprintChange={saveComponentFootprint}
                          onRequestSave={requestPropertiesSave}
                          onBoardThicknessChange={saveModelBoardThickness}
                          onModeChange={setModelMode}
                          onSketchPointerChange={modelSketchCoordinates.update}
                          onEditingDraftChange={setModelDrawingBlocked}
                          distanceMeasurement={modelMeasurement}
                          schematic={project.schematic}
                          grid={grid}
                          gridSpacing={modelGridSpacing}
                          viewState={pcb3DView}
                          statusBar={view === '3d' ? drawingStatusBar : undefined}
                          rulePanel={view === '3d' ? rulePanel : undefined}
                          errorTarget={modelErrorTarget}
                          annotationProps={modelAnnotationProps}
                          modelCad={modelCad}
                          undoDepth={coreSnapshot.undoDepth}
                          redoDepth={coreSnapshot.redoDepth}
                          capabilityHost={capabilityHost}
                          revision={String(coreSnapshot.revision)}
                          sourcePending={sourcePending || Boolean(coreSnapshot.editingBlocked)}
                          onModelChecksChange={onModelChecksChange}
                          modelCheckFocus={modelCheckFocus}
                        />
                      </Suspense>
                    ) : (
                      <div className="pcb-model-preview">
                        <div className="pcb-3d-empty">
                          <p>No PCB layout in this project.</p>
                          <button className="secondary" onClick={() => changeView('layout')}>
                            Open Layout
                          </button>
                        </div>
                        {view === '3d' && rulePanel}
                        {view === '3d' && drawingStatusBar}
                      </div>
                    )}
                  </div>
                )}
                <div className="file-editor-surface" hidden={view !== 'source'}>
                  {sourceOpened && (
                    <Suspense fallback={<p role="status">Loading source editor…</p>}>
                      <RetainedSourceEditor
                        ruleStatus={view === 'source' ? ruleStatus : undefined}
                        rulePanel={view === 'source' ? rulePanel : undefined}
                        visible={sourceVisible}
                        active={
                          active &&
                          screen === 'workspace' &&
                          view === 'source' &&
                          !modal &&
                          !confirmation
                        }
                        status={
                          diskObservationSelected && directoryObservation.selectedPending
                            ? 'Unsaved changes'
                            : draftStatus || undefined
                        }
                        files={sourceFiles}
                        directories={directoryObservation.directories}
                        fileError={directoryObservation.error}
                        onRefreshFiles={
                          fileId && window.openpe ? directoryObservation.refresh : undefined
                        }
                        activeFile={activeSourceFile?.name}
                        onSelectFile={setSelectedSourceFile}
                        value={activeSourceFile?.source ?? ''}
                        pending={
                          diskObservationSelected
                            ? directoryObservation.selectedPending && !directoryObservation.saving
                            : sourcePending
                        }
                        applyLabel={diskObservationSelected ? 'Save file' : 'Apply'}
                        error={sourceError}
                        onChange={onSourceChange}
                        onApply={onSourceApply}
                        onCopy={onSourceCopy}
                      />
                    </Suspense>
                  )}
                </div>
                {gitOpened && project && (
                  <Suspense fallback={null}>
                    <RetainedProjectHistory
                      key={`${fileId}:${filename}:${gitDestination}`}
                      visible={active && screen === 'workspace' && modal === 'history'}
                      onClose={closeHistory}
                      capabilityHost={capabilityHost}
                      fileId={fileId}
                      source={source}
                      sourcePending={sourcePending || Boolean(coreSnapshot.editingBlocked)}
                      onSave={saveHistoryProject}
                    />
                  </Suspense>
                )}
              </div>
            </section>
          </div>
        )}
        {renameTarget && (
          <RenameDialog
            kind={renameTarget.kind}
            initialName={renameTarget.name}
            onClose={() => setRenameTarget(null)}
            onRename={(name) => {
              if (closingDocument.current) throw new Error('This project is closing.');
              if (renameTarget.kind === 'project') {
                const current = core.getSnapshot().project;
                if (!current) throw new Error('The project is no longer open.');
                core.execute('project.rename', { name });
              } else {
                const id = renameTarget.id;
                if (!sessions.some((session) => session.id === id))
                  throw new Error('The conversation is no longer available.');
                setSessionState((current) => renameSession(current, id, name));
              }
              setRenameTarget(null);
            }}
          />
        )}
        {toast && (
          <div className="toast" role="status" data-agent-private>
            <span>{toast.text}</span>
            {toast.dismissible && (
              <button
                aria-label="Dismiss notification"
                title="Dismiss notification"
                onClick={() => setToast(null)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept=".kicad_pro,.kicad_sch,.kicad_pcb"
          onChange={async (e) => {
            const selected = Array.from(e.target.files ?? []);
            const f = selected.find((file) => file.name.endsWith('.kicad_pro')) ?? selected[0];
            if (f)
              try {
                const files = await Promise.all(
                  selected.map(async (file) => ({ name: file.name, source: await file.text() })),
                );
                const d = projectFromNativeFiles({ entry: f.name, files });
                await enterDocument(
                  d,
                  f.name,
                  false,
                  '',
                  undefined,
                  undefined,
                  `browser:${f.name}:${d.id}`,
                );
              } catch (err) {
                notify((err as Error).message);
              }
            e.target.value = '';
          }}
        />
        {screen === 'plugins' && (
          <div className="plugins-layout">
            <nav className="home-sidebar" aria-label="Plugin page navigation">
              <NavigationButton
                compact
                icon={HomeIcon}
                label="Home"
                onClick={() => {
                  cancelPendingNavigation();
                  setScreen('home');
                }}
              />
              <NavigationButton
                compact
                icon={FolderPlus}
                label="New project"
                onClick={() => newFile()}
              />
              <NavigationButton
                compact
                icon={FolderOpen}
                label="Open project"
                onClick={() => void open()}
              />
              <NavigationButton
                compact
                icon={Blocks}
                label="Plugins"
                active
                onClick={openPlugins}
              />
              <ProjectNavigation
                projects={projects}
                active={active && screen === 'plugins'}
                onAction={onProjectAction}
                onSessionAction={onProjectSessionAction}
                activeSessionId={activeSessionId}
                onSelectSession={(id, sessionId) => onSelectProject(id, sessionId)}
                onSelect={onSelectProject}
                onNewSession={onNewProjectSession}
              />
              <div className="rail-spacer" />
              <AgentPicker
                compact
                provider={provider}
                agents={agents}
                onChange={setProvider}
                disabled={Boolean(runningSessions[activeSessionId])}
              />
              <NavigationButton
                compact
                icon={Settings}
                label="Settings"
                onClick={() => setModal('settings')}
              />
            </nav>
            <Suspense fallback={<p role="status">Loading plugins…</p>}>
              <PluginsPage
                capabilityHost={capabilityHost}
                onBack={() => setScreen(beforePlugins.current)}
              />
            </Suspense>
          </div>
        )}
        {modal === 'drawing' && project && doc && (
          <DeferredDialog title="Draw component" onClose={() => setModal(null)}>
            <ComponentDrawingEditor
              project={project}
              schematic={doc}
              capabilityHost={capabilityHost}
              revision={String(coreSnapshot.revision)}
              initialTab={view === 'layout' || view === '3d' ? 'footprint' : 'symbol'}
              onClose={() => setModal(null)}
              onApplied={(kind, id) => {
                if (kind === 'symbol' && id) {
                  setSelected(id);
                  setTool('select');
                  void changeView('canvas');
                } else if (kind === 'footprint') void changeView('layout');
              }}
            />
          </DeferredDialog>
        )}
        {(modal === 'library' || modal === 'power') && doc && (
          <DeferredDialog title="Choose symbol" onClose={() => setModal(null)}>
            <LibraryChooser
              capabilityHost={capabilityHost}
              kind="symbols"
              initialLibrary={modal === 'power' ? 'power' : ''}
              onClose={() => setModal(null)}
              onChoose={async (detail, unit) => {
                if (!('symbol' in detail) || detail.error) return;
                setModal(null);
                if (!(await changeView('canvas'))) return;
                setPlacement({ symbol: detail.symbol, unit });
                setTool('place');
                queueSchematicNavigation('place');
              }}
            />
          </DeferredDialog>
        )}
        {modal === 'annotation' && doc && annotationTarget && (
          <AnnotationDialog
            initialText={
              schematicTexts(doc.original).find((t) => t.id === annotationTarget.id)?.text || ''
            }
            editing={Boolean(annotationTarget.id)}
            onClose={() => setModal(null)}
            onSave={(text) => {
              const latest = current.current;
              if (!latest) throw new Error('The project is no longer open.');
              const result = saveAnnotation(latest, text, annotationTarget, annotationTarget.id);
              if (!commit(result.circuit)) throw new Error('Could not save the annotation.');
              setSelected(result.id);
              setModal(null);
            }}
          />
        )}
        {modal === 'parts' && doc && (
          <PartsList
            size={partsSize}
            onResize={setPartsSize}
            parts={doc.parts}
            selected={selected}
            onEdit={openProperties}
            onLocate={async (id) => {
              if (!(await changeView('canvas'))) return;
              setSelected(id);
              setTool('select');
              setModal(null);
              queueSchematicNavigation('select', id);
            }}
            onClose={() => setModal(null)}
          />
        )}
        {spiceAvailable && simulationProject && (
          <Suspense fallback={null}>
            <SimulationDialog
              capabilityHost={capabilityHost}
              project={simulationProject}
              agentContextRef={simulationAgentContext}
              fileId={fileId}
              visible={active && simulationVisible && screen === 'workspace'}
              onCloseSettings={() => {
                setSimulationEnabled(false);
              }}
              settingsHost={simulationSettingsHost}
              sourcePending={sourcePending}
              onLocatePart={(id) => {
                const snapshot = core.getSnapshot();
                if (
                  !active ||
                  screen !== 'workspace' ||
                  !simulationVisible ||
                  modal ||
                  confirmation ||
                  snapshot.sourceDraft !== null ||
                  snapshot.editingBlocked ||
                  snapshot.revision !== coreSnapshot.revision ||
                  activeSchematicRef.current !== simulationProject.schematic.id ||
                  !doc ||
                  !selectableSchematicIds(doc, layers, selectionFilters).has(id)
                )
                  return false;
                setSelected(id);
                setTool('select');
                queueSchematicNavigation('select', id, true);
                return true;
              }}
              onParticipationChange={(partId, included) => {
                const snapshot = core.getSnapshot();
                if (
                  !active ||
                  screen !== 'workspace' ||
                  !simulationVisible ||
                  modal ||
                  confirmation ||
                  snapshot.revision !== coreSnapshot.revision ||
                  activeSchematicRef.current !== simulationProject.schematic.id
                )
                  return false;
                core.execute(
                  'part.participation',
                  { schematicId: simulationProject.schematic.id, partId, included },
                  { expectedRevision: String(coreSnapshot.revision) },
                );
                return true;
              }}
              probe={probe}
              waveformHost={waveformHost}
              onWaveformVisibilityChange={setWaveformRequested}
              onStoreModels={(models, expectedSource) => {
                if (!window.openpe) return true;
                const latest = projectRef.current;
                if (
                  !latest ||
                  sourceDraftRef.current !== null ||
                  activeSchematicRef.current !== simulationProject.schematic.id
                )
                  return false;
                if (
                  serializeProject(schematicSnapshot(latest, simulationProject.schematic.id)) !==
                  expectedSource
                )
                  return false;
                return commitProject({ ...latest, simulationModels: models });
              }}
            />
          </Suspense>
        )}
        {modal === 'about' && (
          <DeferredDialog title="About OpenPE" onClose={() => setModal(null)}>
            <AboutDialog onClose={() => setModal(null)} />
          </DeferredDialog>
        )}
        {(modal === 'settings' ||
          modal === 'agent-settings' ||
          modal === 'erc-settings' ||
          modal === 'drc-settings') && (
          <DeferredDialog title="Settings" onClose={() => setModal(null)}>
            <SettingsDialog
              initialSection={
                modal === 'agent-settings'
                  ? 'agents'
                  : modal === 'erc-settings' || modal === 'drc-settings'
                    ? 'rules'
                    : 'appearance'
              }
              ruleSettings={
                screen === 'workspace' && project
                  ? {
                      erc: ercSeverities,
                      drc: drcSettings,
                      retainedDraft: ruleSettingsDraft,
                      initialTab: modal === 'drc-settings' ? 'Copper & Routing' : 'Schematic',
                      blockedReason:
                        coreSnapshot.editingBlocked ??
                        (sourcePending ? 'Apply Source edits before changing rules.' : ''),
                      onApply: applyRuleSettings,
                    }
                  : undefined
              }
              appearance={appearanceSettings}
              agents={agents}
              detecting={detecting}
              error={agentError}
              onDetect={detectAgents}
              onClose={() => setModal(null)}
            />
          </DeferredDialog>
        )}
        {confirmation && (
          <ConfirmationDialog
            key={confirmation.kind}
            documentTitle={project?.name ?? project?.schematic.title}
            busy={confirmBusy}
            error={confirmError}
            onCancel={cancelConfirmation}
            onConfirm={finishConfirmation}
          />
        )}
      </main>
    </>
  );
}
