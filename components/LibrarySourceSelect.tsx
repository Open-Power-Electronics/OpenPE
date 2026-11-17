'use client';
import { useEffect, useState } from 'react';
import type { CapabilityHost } from '@/api/capabilities';
import { api } from '@/lib/bridge';
import Select, { type SelectOption } from './Select';

type Source = 'KiCad' | 'NextPCB';
type Category = { id: string; name: string; children: Category[] };

function categoryPath(categories: Category[], id: string): string[] | undefined {
  for (const category of categories) {
    if (category.id === id) return [category.name];
    const path = categoryPath(category.children, id);
    if (path) return [category.name, ...path];
  }
}

export default function LibrarySourceSelect({
  kind,
  library,
  category,
  libraries,
  capabilityHost,
  browseOnEmpty = false,
  onChange,
}: {
  kind: 'symbols' | 'footprints';
  library: string;
  category: string;
  libraries: string[];
  capabilityHost?: CapabilityHost;
  browseOnEmpty?: boolean;
  onChange: (library: string, category: string) => void;
}) {
  const [catalogs, setCatalogs] = useState<Partial<Record<Source, Category[]>>>({});
  const [errors, setErrors] = useState<Partial<Record<Source, string>>>({});
  const [request, setRequest] = useState<{ source: Source; serial: number } | null>(null);
  const [loading, setLoading] = useState<Source | null>(null);
  const source: Source = library === 'NextPCB' ? 'NextPCB' : 'KiCad';
  const activeCategory = source === 'NextPCB' ? category : library;
  const localCategories = libraries
    .filter((name) => name !== 'NextPCB')
    .map((name) => ({ id: name, name, children: [] }));
  const categoriesFor = (provider: Source) =>
    provider === 'KiCad' && localCategories.length ? localCategories : catalogs[provider];

  function load(provider: Source, retry = false) {
    if (!retry && (categoriesFor(provider) || loading === provider)) return;
    setLoading(provider);
    setErrors((current) => ({ ...current, [provider]: undefined }));
    setRequest((current) => ({ source: provider, serial: (current?.serial ?? 0) + 1 }));
  }

  useEffect(() => {
    setRequest(null);
    setLoading(null);
    if (!categoriesFor(source)) load(source, true);
  }, [source, kind]);

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
      })
      .catch((error) => {
        if (control.signal.aborted) return;
        setErrors((current) => ({ ...current, [provider]: error.message }));
        setLoading(null);
      });
    return () => control.abort();
  }, [request, kind, capabilityHost]);

  function categoryOptions(categories: Category[]): SelectOption[] {
    return categories.map((item) => ({
      value: item.children.length ? `branch:${item.id}` : item.id,
      label: item.name,
      ...(item.children.length
        ? {
            children: [
              { value: item.id, label: `All ${item.name}` },
              ...categoryOptions(item.children),
            ],
          }
        : {}),
    }));
  }

  const categories = categoriesFor(source);
  useEffect(() => {
    if (
      browseOnEmpty &&
      source === 'NextPCB' &&
      !category &&
      categoryPath(categories ?? [], '1737')
    )
      onChange('NextPCB', '1737');
  }, [browseOnEmpty, source, category, categories, onChange]);
  const options: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...(categories
      ? categories.length
        ? categoryOptions(categories)
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
  const path = activeCategory
    ? (categoryPath(categoriesFor(source) ?? [], activeCategory) ?? [activeCategory])
    : ['All categories'];
  return (
    <div className="library-source-filters">
      <Select
        label="Library source"
        value={source}
        options={[
          { value: 'KiCad', label: 'KiCad' },
          { value: 'NextPCB', label: 'NextPCB' },
        ]}
        onChange={(provider) => {
          if (provider !== source) onChange(provider === 'NextPCB' ? 'NextPCB' : '', '');
        }}
      />
      <Select
        label="Category"
        hint={path.join(' / ')}
        selectedLabel={path.join(' / ')}
        value={activeCategory}
        options={options}
        popupMaxHeight={280}
        onChange={(value) => {
          if (value === 'action:retry') {
            load(source, true);
            return;
          }
          onChange(source === 'NextPCB' ? 'NextPCB' : value, source === 'NextPCB' ? value : '');
        }}
      />
    </div>
  );
}
