'use client';
import { useEffect, useRef, useState } from 'react';
import type { CapabilityHost } from '@/api/capabilities';
import { api } from '@/lib/bridge';
import {
  catalogSource,
  isOnlineLibrary,
  librarySources,
  type LibrarySource as Source,
} from '@/lib/library';
import Select, { type SelectOption } from './Select';

type Category = { id: string; name: string; children: Category[] };
export type LibraryCategoryReload = { source: Source; serial: number };
export type LibraryCategoryStatus = {
  source: string;
  pending: boolean;
  error: string;
  reloadSerial: number;
};

function categoryPath(categories: Category[], id: string): Category[] | undefined {
  for (const category of categories) {
    if (category.id === id) return [category];
    const path = categoryPath(category.children, id);
    if (path) return [category, ...path];
  }
}

function finalLevelOptions(categories: Category[], parents: string[] = []): SelectOption[] {
  return categories.flatMap((item) => {
    const path = [...parents, item.name];
    return [{ value: item.id, label: path.join(' / ') }, ...finalLevelOptions(item.children, path)];
  });
}

export default function LibrarySourceSelect({
  kind,
  library,
  category,
  libraries,
  capabilityHost,
  reload,
  onStatus,
  onChange,
}: {
  kind: 'symbols' | 'footprints';
  library: string;
  category: string;
  libraries: string[];
  capabilityHost?: CapabilityHost;
  reload?: LibraryCategoryReload | null;
  onStatus?: (status: LibraryCategoryStatus) => void;
  onChange: (library: string, category: string) => void;
}) {
  const [catalogs, setCatalogs] = useState<Partial<Record<Source, Category[]>>>({});
  const [errors, setErrors] = useState<Partial<Record<Source, string>>>({});
  const [request, setRequest] = useState<{
    source: Source;
    serial: number;
    reloadSerial: number;
  } | null>(null);
  const [loading, setLoading] = useState<Source | null>(null);
  const [completedReload, setCompletedReload] = useState(0);
  const consumedReload = useRef(0);
  const source = catalogSource(library);
  const online = isOnlineLibrary(source);
  const activeCategory = online ? category : library;
  const localCategories = libraries
    .filter((name) => catalogSource(name) === 'KiCad')
    .map((name) => ({ id: name, name, children: [] }));
  const categoriesFor = (provider: Source) =>
    provider === 'KiCad' && localCategories.length ? localCategories : catalogs[provider];

  function load(provider: Source, retry = false, reloadSerial = 0) {
    if (!retry && (categoriesFor(provider) || loading === provider)) return;
    setLoading(provider);
    setErrors((current) => ({ ...current, [provider]: undefined }));
    setRequest((current) => ({
      source: provider,
      serial: (current?.serial ?? 0) + 1,
      reloadSerial,
    }));
  }

  useEffect(() => {
    setRequest(null);
    setLoading(null);
    if (!categoriesFor(source)) load(source, true);
  }, [source, kind]);

  useEffect(() => {
    if (!reload || consumedReload.current === reload.serial) return;
    consumedReload.current = reload.serial;
    if (reload.source === source) load(source, true, reload.serial);
  }, [reload, source, kind]);

  useEffect(() => {
    if (!request) return;
    const control = new AbortController();
    const { source: provider } = request;
    void (
      capabilityHost
        ? capabilityHost.query(
            'library.categories',
            { kind, source: provider },
            { signal: control.signal },
          )
        : api(`libraries/${kind}?categories=${provider}`, { signal: control.signal }).then(
            (response) => response.json(),
          )
    )
      .then((value) => {
        if (control.signal.aborted) return;
        const data = value as { categories?: Category[] } | null;
        if (!Array.isArray(data?.categories))
          throw new Error('The library returned an invalid category catalog.');
        setCatalogs((current) => ({
          ...current,
          [provider]: data.categories,
        }));
        setLoading(null);
        setCompletedReload(request.reloadSerial);
      })
      .catch((error) => {
        if (control.signal.aborted) return;
        setErrors((current) => ({ ...current, [provider]: error.message }));
        setLoading(null);
        setCompletedReload(request.reloadSerial);
      });
    return () => control.abort();
  }, [request, kind, capabilityHost]);

  const categories = categoriesFor(source);
  const categoryPending = !categories || loading === source;
  const categoryError = errors[source] ?? '';
  useEffect(() => {
    onStatus?.({
      source,
      pending: categoryPending && !categoryError,
      error: categoryError,
      reloadSerial: completedReload,
    });
  }, [source, categoryPending, categoryError, completedReload, onStatus]);
  const options: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...(categories
      ? categories.length
        ? categories.map((item) => ({ value: item.id, label: item.name }))
        : [{ value: 'status:empty', label: 'No categories available', disabled: true }]
      : [
          {
            value: 'status:loading',
            label: errors[source] ? 'Categories unavailable' : 'Loading categories…',
            disabled: true,
          },
        ]),
    ...(errors[source]
      ? [{ value: 'action:retry', label: 'Retry categories', description: errors[source] }]
      : []),
  ];
  const path = activeCategory ? (categoryPath(categories ?? [], activeCategory) ?? []) : [];
  const root = path[0];
  const subcategories = root?.children ?? [];
  return (
    <div className="library-source-filters">
      <Select
        label="Library source"
        value={source}
        options={librarySources.map((value) => ({ value, label: value }))}
        onChange={(provider) => {
          if (provider !== source) onChange(provider === 'KiCad' ? '' : provider, '');
        }}
      />
      <Select
        label="Category level 1"
        value={online ? (root?.id ?? '') : activeCategory}
        options={options}
        popupMaxHeight={280}
        onChange={(value) => {
          if (value === 'action:retry') load(source, true);
          else if (online) onChange(source, value);
          else onChange(value, '');
        }}
      />
      <Select
        label="Category level 2"
        value={path.length > 1 ? activeCategory : ''}
        disabled={!subcategories.length}
        options={[
          {
            value: '',
            label:
              !subcategories.length && (root || !online) ? 'No subcategories' : 'All subcategories',
          },
          ...finalLevelOptions(subcategories),
        ]}
        popupMaxHeight={280}
        onChange={(value) => {
          if (root) onChange(source, value || root.id);
        }}
      />
    </div>
  );
}
