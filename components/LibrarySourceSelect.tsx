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
  browseCategoryId?: string;
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
  const cascading =
    source === 'NextPCB' ||
    (online && (!categories || categories.some((item) => item.children.length)));
  const categoryPending = !categories || loading === source;
  const categoryError = errors[source] ?? '';
  const browseCategoryId = categoryPath(catalogs.NextPCB ?? [], '1737')?.at(-1)?.id;
  useEffect(() => {
    onStatus?.({
      source,
      pending: categoryPending && !categoryError,
      error: categoryError,
      reloadSerial: completedReload,
      browseCategoryId,
    });
  }, [source, categoryPending, categoryError, completedReload, browseCategoryId, onStatus]);
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
  return (
    <div
      className="library-source-filters"
      data-source={source}
      data-category-levels={cascading ? 2 : 1}
    >
      <Select
        label="Library source"
        value={source}
        options={librarySources.map((value) => ({ value, label: value }))}
        onChange={(provider) => {
          if (provider !== source) onChange(provider === 'KiCad' ? '' : provider, '');
        }}
      />
      {cascading ? (
        [0, 1].map((level) => {
          const parent = level ? path[level - 1] : undefined;
          const children = level ? (parent?.children ?? []) : (categories ?? []);
          const unavailable = level > 0 && !children.length;
          const leafSelected = path.length > 0 && !path.at(-1)!.children.length;
          const value = level === 1 && path.length > 1 ? path.at(-1)!.id : (path[level]?.id ?? '');
          const choices: SelectOption[] =
            level === 0
              ? options
              : [
                  {
                    value: '',
                    label: unavailable
                      ? parent || leafSelected
                        ? 'No subcategories'
                        : 'All subcategories'
                      : 'All subcategories',
                  },
                  ...(level === 1
                    ? finalLevelOptions(children)
                    : children.map((item) => ({
                        value: item.id,
                        label: item.name,
                      }))),
                ];
          return (
            <Select
              key={level}
              label={`Category level ${level + 1}`}
              hint={
                path
                  .slice(0, level + 1)
                  .map((item) => item.name)
                  .join(' / ') || `Category level ${level + 1}`
              }
              value={value}
              options={choices}
              disabled={unavailable}
              popupMaxHeight={280}
              onChange={(next) => {
                if (next === 'action:retry') load(source, true);
                else onChange(source, next || parent?.id || '');
              }}
            />
          );
        })
      ) : (
        <Select
          label="Category"
          value={activeCategory}
          options={options}
          popupMaxHeight={280}
          onChange={(value) => {
            if (value === 'action:retry') load(source, true);
            else if (online) onChange(source, value);
            else onChange(value, '');
          }}
        />
      )}
    </div>
  );
}
