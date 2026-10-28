'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Blocks, CircleHelp, RefreshCw, Search, Store } from 'lucide-react';
import { api } from '@/lib/bridge';
import type { CapabilityHost } from '@/api/capabilities';
import {
  SPICE_PLUGIN_ID,
  THERMAL_PLUGIN_ID,
  PCB_DESIGN_PLUGIN_ID,
  changeWorkbenchPlugin,
  loadWorkbenchPlugins,
  useWorkbenchPlugins,
  type PluginAction as Action,
  type WorkbenchPlugin as Plugin,
  type WorkbenchPluginCatalog as Catalog,
} from '@/lib/workbench-plugins';
import Dialog from './Dialog';
import AgentLogo from './AgentLogo';
import PluginLogo from './PluginLogo';

const providers = ['openpe', 'codex', 'claude'] as const;
type Provider = (typeof providers)[number];
const providerNames = { openpe: 'OpenPE', codex: 'Codex', claude: 'Claude Code' };
type Operation = { provider: Provider; id: string; action: Action };
type InstalledPlugin = Plugin & { provider: Provider };
const pluginKey = (plugin: InstalledPlugin) => `${plugin.provider}:${plugin.id}:${plugin.scope}`;
const categoryOf = (plugin: InstalledPlugin) =>
  plugin.origin === 'agent' ? plugin.provider : plugin.origin;
const categories = [
  {
    id: 'openpe',
    label: 'OpenPE',
    description: 'Workbench plugins and Agent plugins installed through OpenPE.',
  },
  { id: 'codex', label: 'Codex', description: 'Plugins from your Codex setup.' },
  { id: 'claude', label: 'Claude Code', description: 'Plugins from your Claude Code setup.' },
  {
    id: 'unknown',
    label: 'Unknown origin',
    description: 'OpenPE installation records could not be read.',
  },
];
function CategoryIcon({ id }: { id: string }) {
  if (id === 'marketplace') return <Store size={20} />;
  if (id === 'openpe') return <img src="/brand/openpe-mark.svg" width={20} height={20} alt="" />;
  if (id === 'unknown') return <CircleHelp size={20} />;
  return <AgentLogo provider={id} size={20} />;
}
const catalogCache = new Map<string, Catalog>();
function currentCatalog(catalog: Catalog) {
  return catalog.controlsVersion === 1;
}
function cachedCatalog(provider: string) {
  const saved = catalogCache.get(provider);
  return saved && currentCatalog(saved) && Date.now() - saved.updatedAt < 300000 ? saved : null;
}
const labels: Record<Action, string> = {
  install: 'Install',
  uninstall: 'Uninstall',
  enable: 'Enable',
  disable: 'Disable',
};
function PluginIcon({ plugin }: { plugin: Plugin }) {
  const bundled =
    plugin.scope === 'application' &&
    plugin.origin === 'openpe' &&
    [SPICE_PLUGIN_ID, THERMAL_PLUGIN_ID, PCB_DESIGN_PLUGIN_ID].includes(plugin.id);
  return (
    <span className={`plugin-mark${bundled ? ' plugin-mark-bundled' : ''}`} aria-hidden="true">
      {bundled ? (
        <PluginLogo id={plugin.id} />
      ) : plugin.icon ? (
        <img
          src={plugin.icon}
          alt=""
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : (
        <span>{plugin.name.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}

export default function PluginsPage({
  onBack,
  capabilityHost,
}: {
  onBack: () => void;
  capabilityHost?: CapabilityHost;
}) {
  const workbenchPlugins = useWorkbenchPlugins();
  const [catalogs, setCatalogs] = useState<Record<Provider, Catalog | null>>(() => ({
    openpe: workbenchPlugins.catalog,
    codex: cachedCatalog('codex'),
    claude: cachedCatalog('claude'),
  }));
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState<Record<Provider, boolean>>({
    openpe: false,
    codex: false,
    claude: false,
  });
  const [working, setWorking] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Provider, string>>>({});
  const [confirmation, setConfirmation] = useState<Operation | null>(null);
  const control = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(
    async (provider: Provider, signal: AbortSignal, force = false) => {
      setErrors((current) => ({ ...current, [provider]: '' }));
      if (force) catalogCache.delete(provider);
      const saved = provider === 'openpe' ? null : cachedCatalog(provider);
      if (!force && saved) {
        setCatalogs((current) => ({ ...current, [provider]: saved }));
        setLoading((current) => ({ ...current, [provider]: false }));
        return;
      }
      setLoading((current) => ({ ...current, [provider]: true }));
      try {
        const result = capabilityHost
          ? ((await capabilityHost.query(
              provider === 'openpe' ? 'workbench.plugins.list' : 'provider.plugins.list',
              provider === 'openpe' ? { refresh: force } : { provider, refresh: force },
              { signal },
            )) as Catalog)
          : provider === 'openpe'
            ? await loadWorkbenchPlugins(force)
            : await (
                await api(`plugins?provider=${provider}${force ? '&refresh=true' : ''}`, { signal })
              ).json();
        if (!signal.aborted) {
          if (provider !== 'openpe' && currentCatalog(result)) catalogCache.set(provider, result);
          else catalogCache.delete(provider);
          setCatalogs((current) => ({ ...current, [provider]: result }));
        }
      } catch (err) {
        if (!signal.aborted)
          setErrors((current) => ({ ...current, [provider]: (err as Error).message }));
      } finally {
        if (!signal.aborted) setLoading((current) => ({ ...current, [provider]: false }));
      }
    },
    [capabilityHost],
  );
  useEffect(() => {
    if (workbenchPlugins.catalog)
      setCatalogs((current) => ({ ...current, openpe: workbenchPlugins.catalog }));
  }, [workbenchPlugins.catalog]);
  const refresh = useCallback(
    (force = false) => {
      control.current?.abort();
      const next = new AbortController();
      control.current = next;
      void Promise.all(providers.map((provider) => load(provider, next.signal, force)));
    },
    [load],
  );
  useEffect(() => {
    refresh();
    return () => control.current?.abort();
  }, [refresh]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [selected]);
  async function change(operation = confirmation) {
    if (!operation || working || loading[operation.provider] || control.current?.signal.aborted)
      return;
    const provider = operation.provider;
    setConfirmation(null);
    setWorking(true);
    setErrors((current) => ({ ...current, [provider]: '' }));
    catalogCache.delete(provider);
    const next = new AbortController();
    control.current = next;
    try {
      if (capabilityHost)
        await capabilityHost.execute(
          provider === 'openpe' ? 'workbench.plugins.change' : 'provider.plugins.change',
          provider === 'openpe' ? { action: operation.action, id: operation.id } : operation,
          { signal: next.signal, actor: 'human' },
        );
      else if (provider === 'openpe') await changeWorkbenchPlugin(operation.action, operation.id);
      else
        await api('plugins', {
          method: 'POST',
          signal: next.signal,
          body: JSON.stringify(operation),
        });
      if (next.signal.aborted) return;
      await load(provider, next.signal, provider !== 'openpe');
    } catch (err) {
      if (!next.signal.aborted) {
        setErrors((current) => ({
          ...current,
          [provider]: `${(err as Error).message} Refresh to check the current plugin state.`,
        }));
      }
    } finally {
      if (!next.signal.aborted) setWorking(false);
    }
  }
  const busy = providers.some((provider) => loading[provider]) || working;
  const entries = providers.flatMap((provider) =>
    (catalogs[provider]?.plugins || [])
      .filter((plugin) => provider === 'openpe' || plugin.installed)
      .map((plugin) => ({ ...plugin, provider })),
  );
  const installed = entries.filter((plugin) => plugin.installed);
  const selectedPlugin = entries.find((plugin) => pluginKey(plugin) === selected);
  const catalogWarnings = providers
    .filter((provider) => catalogs[provider]?.warning)
    .map((provider) => `${providerNames[provider]}: ${catalogs[provider]?.warning}`)
    .join('\n');
  function outdatedService(provider: Provider) {
    const catalog = catalogs[provider];
    return catalog !== null && !currentCatalog(catalog);
  }
  function categoryReady(id: string) {
    if (id === 'marketplace' || id === 'openpe') return !!catalogs.openpe?.browse;
    return id === 'codex' || id === 'claude'
      ? catalogs[id]?.browse
      : providers.every((provider) => catalogs[provider]?.browse);
  }
  const shown = (
    filter === 'marketplace' ? entries.filter((plugin) => plugin.provider === 'openpe') : installed
  ).filter(
    (plugin) =>
      (filter === 'all' || filter === 'marketplace' || categoryOf(plugin) === filter) &&
      `${plugin.name} ${plugin.description} ${plugin.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function actions(plugin: InstalledPlugin) {
    if (outdatedService(plugin.provider)) return [];
    return (
      plugin.installed
        ? (['enable', 'disable', 'uninstall'] as Action[]).filter(
            (action) =>
              action === 'uninstall' ||
              (plugin.enabled !== null && action === (plugin.enabled ? 'disable' : 'enable')),
          )
        : (['install'] as Action[])
    ).filter((action) => catalogs[plugin.provider]?.actions.includes(action));
  }
  function browse(nextFilter: string) {
    setFilter(nextFilter);
    setSelected(null);
  }
  return (
    <section className="plugins-page" aria-label="Plugins">
      <aside className="plugins-sidebar" aria-label="Plugin navigation">
        <div className="plugins-sidebar-title">
          <h2>Plugins</h2>
          <button
            className="icon-button"
            aria-label="Return to workspace"
            title="Workspace"
            onClick={onBack}
          >
            <ArrowLeft size={17} />
          </button>
        </div>
        <button
          className={`plugins-nav-item ${filter === 'all' && !selected ? 'active' : ''}`}
          onClick={() => browse('all')}
          aria-current={filter === 'all' && !selected ? 'page' : undefined}
        >
          <span className="plugins-nav-icon" aria-hidden="true">
            <Blocks size={20} />
          </span>
          <span className="plugins-nav-label">All plugins</span>
          <span className="plugins-count">{installed.length}</span>
        </button>
        <div className="plugins-nav-categories">
          <button
            className={`plugins-nav-item ${filter === 'marketplace' && !selected ? 'active' : ''}`}
            onClick={() => browse('marketplace')}
            aria-current={filter === 'marketplace' && !selected ? 'page' : undefined}
            aria-description="Bundled OpenPE workbench plugins"
          >
            <span className="plugins-nav-icon" aria-hidden="true">
              <Store size={20} />
            </span>
            <span className="plugins-nav-label">Marketplace</span>
            <span className="plugins-count">{catalogs.openpe?.plugins.length || 0}</span>
          </button>
          {categories
            .filter(
              (origin) =>
                origin.id !== 'unknown' || installed.some((plugin) => plugin.origin === 'unknown'),
            )
            .map((origin) => (
              <button
                key={origin.id}
                className={`plugins-nav-item ${filter === origin.id && !selected ? 'active' : ''}`}
                onClick={() => browse(origin.id)}
                aria-current={filter === origin.id && !selected ? 'page' : undefined}
                aria-description={origin.description}
              >
                <span className="plugins-nav-icon" aria-hidden="true">
                  <CategoryIcon id={origin.id} />
                </span>
                <span className="plugins-nav-label">{origin.label}</span>
                <span className="plugins-count">
                  {installed.filter((plugin) => categoryOf(plugin) === origin.id).length}
                </span>
              </button>
            ))}
        </div>
      </aside>
      <div className="plugins-main">
        <header className="plugins-page-header">
          <h1 ref={heading} tabIndex={-1}>
            {selectedPlugin?.name ||
              (filter === 'all'
                ? 'Plugins'
                : filter === 'marketplace'
                  ? 'Marketplace'
                  : categories.find((category) => category.id === filter)?.label)}
          </h1>
          <div className="plugins-toolbar">
            <label className="plugins-search">
              <Search size={17} aria-hidden="true" />
              <input
                aria-label="Search plugins"
                placeholder="Search plugins"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSelected(null);
                }}
              />
            </label>
            <button
              className="icon-button"
              aria-label="Refresh plugins"
              title="Refresh plugins"
              aria-description={catalogWarnings || undefined}
              disabled={busy}
              onClick={() => refresh(true)}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        {providers
          .filter(
            (provider) =>
              filter === 'all' ||
              (filter === 'marketplace' && provider === 'openpe') ||
              filter === 'openpe' ||
              filter === 'unknown' ||
              filter === provider ||
              selectedPlugin?.provider === provider,
          )
          .map((provider) => (
            <div key={provider}>
              {errors[provider] && (
                <p className="plugins-error" role="alert">
                  {providerNames[provider]}: {errors[provider]}
                </p>
              )}
              {outdatedService(provider) && (
                <p className="plugins-error" role="alert">
                  {providerNames[provider]} plugin controls need the updated local service. Save
                  your work and restart OpenPE; refreshing this page does not restart the service.
                </p>
              )}
            </div>
          ))}
        {selectedPlugin ? (
          <article className="plugin-detail">
            <button className="dialog-button" onClick={() => setSelected(null)}>
              <ArrowLeft size={16} /> Back to plugins
            </button>
            <div className="plugin-detail-heading">
              <PluginIcon plugin={selectedPlugin} />
              <div>
                <h2>{selectedPlugin.name}</h2>
                <p>{selectedPlugin.author || selectedPlugin.marketplace}</p>
              </div>
            </div>
            <p>
              {selectedPlugin.detail ||
                selectedPlugin.description ||
                'No description provided by this plugin.'}
            </p>
            <dl className="plugin-facts">
              <div>
                <dt>Status</dt>
                <dd>
                  {!selectedPlugin.installed
                    ? 'Not installed'
                    : selectedPlugin.enabled === null
                      ? 'Unknown'
                      : selectedPlugin.enabled
                        ? 'Enabled'
                        : 'Disabled'}
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{selectedPlugin.marketplace}</dd>
              </div>
              <div>
                <dt>Origin</dt>
                <dd>
                  {selectedPlugin.origin === 'openpe'
                    ? 'OpenPE'
                    : selectedPlugin.origin === 'agent'
                      ? providerNames[selectedPlugin.provider]
                      : 'Unknown'}
                </dd>
              </div>
              <div>
                <dt>{selectedPlugin.provider === 'openpe' ? 'Resources' : 'Agent'}</dt>
                <dd>
                  {selectedPlugin.provider === 'openpe'
                    ? selectedPlugin.id === PCB_DESIGN_PLUGIN_ID
                      ? 'Bundled workflow and references'
                      : selectedPlugin.id === THERMAL_PLUGIN_ID
                        ? 'OpenPE workbench · bundled Gmsh + Elmer'
                        : 'OpenPE workbench · bundled ngspice'
                    : providerNames[selectedPlugin.provider]}
                </dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{selectedPlugin.scope}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{selectedPlugin.version || 'Not provided'}</dd>
              </div>
              <div>
                <dt>Plugin ID</dt>
                <dd>{selectedPlugin.id}</dd>
              </div>
            </dl>
            {!!selectedPlugin.capabilities?.length && (
              <div className="plugin-tags">
                {selectedPlugin.capabilities.map((value) => (
                  <span key={value}>{value}</span>
                ))}
              </div>
            )}
            <div className="plugin-actions">
              {selectedPlugin.managed ? (
                <p>Managed by provider · {selectedPlugin.scope}</p>
              ) : (
                actions(selectedPlugin).map((action) => (
                  <button
                    key={action}
                    className={`dialog-button ${action === 'install' ? 'primary' : ''}`}
                    disabled={working || loading[selectedPlugin.provider]}
                    onClick={() => {
                      const operation = {
                        provider: selectedPlugin.provider,
                        id: selectedPlugin.id,
                        action,
                      };
                      if (action !== 'uninstall') void change(operation);
                      else setConfirmation(operation);
                    }}
                  >
                    {labels[action]}
                  </button>
                ))
              )}
            </div>
          </article>
        ) : (
          <>
            {(filter === 'marketplace'
              ? [
                  {
                    id: 'openpe',
                    label: 'OpenPE',
                    description:
                      'Bundled workbench plugins. Install and enable to add tools to your workspace.',
                  },
                ]
              : categories
            )
              .filter(
                (origin) =>
                  (filter === 'all' || filter === 'marketplace' || origin.id === filter) &&
                  (origin.id !== 'unknown' || shown.some((plugin) => plugin.origin === 'unknown')),
              )
              .map((origin) => (
                <section
                  className="plugin-category"
                  key={origin.id}
                  aria-label={`${origin.label} plugins`}
                >
                  <h2 className="plugin-category-heading" aria-description={origin.description}>
                    <span className="plugins-nav-icon" aria-hidden="true">
                      <CategoryIcon id={origin.id} />
                    </span>
                    {origin.label}
                    <span className="plugins-count">
                      {shown.filter((plugin) => categoryOf(plugin) === origin.id).length}
                    </span>
                  </h2>
                  {(origin.id === 'codex' || origin.id === 'claude' || origin.id === 'openpe') &&
                    loading[origin.id] &&
                    !working && (
                      <p className="plugins-notice" role="status">
                        {catalogs[origin.id] ? 'Refreshing plugins…' : 'Loading plugins…'}
                      </p>
                    )}
                  <div className="plugins-grid">
                    {shown
                      .filter((plugin) => categoryOf(plugin) === origin.id)
                      .map((plugin) => (
                        <article className="plugin-card" key={pluginKey(plugin)}>
                          <button
                            className="plugin-card-detail"
                            onClick={() => setSelected(pluginKey(plugin))}
                            aria-label={`View ${plugin.name}`}
                          >
                            <PluginIcon plugin={plugin} />
                            <span>
                              <strong>{plugin.name}</strong>
                              <span>{plugin.description || plugin.marketplace}</span>
                              {(origin.id === 'openpe' || origin.id === 'unknown') &&
                                plugin.provider !== 'openpe' && (
                                  <span>{providerNames[plugin.provider]}</span>
                                )}
                            </span>
                          </button>
                          {!plugin.installed ? (
                            <button
                              className="dialog-button primary"
                              disabled={working || loading[plugin.provider]}
                              onClick={() =>
                                void change({
                                  provider: plugin.provider,
                                  id: plugin.id,
                                  action: 'install',
                                })
                              }
                            >
                              Install
                            </button>
                          ) : plugin.enabled === null ? (
                            <span className="plugins-notice">Unknown</span>
                          ) : (
                            <button
                              type="button"
                              role="switch"
                              className="appearance-toggle plugin-toggle"
                              aria-label={`${plugin.name} enabled`}
                              aria-checked={plugin.enabled}
                              disabled={
                                working ||
                                loading[plugin.provider] ||
                                outdatedService(plugin.provider) ||
                                plugin.managed ||
                                !catalogs[plugin.provider]?.actions.includes(
                                  plugin.enabled ? 'disable' : 'enable',
                                )
                              }
                              aria-description={
                                outdatedService(plugin.provider)
                                  ? 'Restart OpenPE to load plugin controls'
                                  : plugin.managed
                                    ? 'Managed by provider'
                                    : !catalogs[plugin.provider]?.actions.includes(
                                          plugin.enabled ? 'disable' : 'enable',
                                        )
                                      ? 'This Agent cannot switch plugins'
                                      : `${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`
                              }
                              onClick={() =>
                                void change({
                                  provider: plugin.provider,
                                  id: plugin.id,
                                  action: plugin.enabled ? 'disable' : 'enable',
                                })
                              }
                            >
                              <span />
                            </button>
                          )}
                        </article>
                      ))}
                  </div>
                  {!search &&
                    !shown.some((plugin) => categoryOf(plugin) === origin.id) &&
                    categoryReady(origin.id) && <p className="plugins-notice">No plugins.</p>}
                </section>
              ))}
            {!busy && !shown.length && (search || categoryReady(filter)) && (
              <p className="plugins-notice">
                {search ? 'No matching plugins.' : 'No plugins found in this view.'}
              </p>
            )}
          </>
        )}
      </div>
      {confirmation && (
        <Dialog
          compact
          title={`${labels[confirmation.action]} plugin?`}
          onClose={() => setConfirmation(null)}
          footer={
            <>
              <button className="dialog-button" onClick={() => setConfirmation(null)}>
                Cancel
              </button>
              <button className="dialog-button primary" onClick={() => void change()}>
                {labels[confirmation.action]}
              </button>
            </>
          }
        >
          <p className="dialog-document">{confirmation.id}</p>
          <p className="plugins-notice">
            {confirmation.provider === 'openpe'
              ? 'This removes the plugin from the workbench and stops active simulations. Project design data and model files are kept. You can reinstall it from Marketplace.'
              : confirmation.action === 'uninstall'
                ? `This removes the plugin from your shared ${providerNames[confirmation.provider]} setup, including its local cache.`
                : `This changes your shared ${providerNames[confirmation.provider]} setup for future sessions.${confirmation.action === 'install' ? ' Plugins can include skills, hooks and external tools.' : ''}`}
          </p>
        </Dialog>
      )}
    </section>
  );
}
