import { useLayoutEffect, type RefObject } from 'react';
import { literalPanelMatches, panelFindLimit } from './panel-find';

export type ModelFindTarget = { kind: 'footprint' | 'solid'; id: string; label: string };
const queryEvent = 'openpe:model-find-query';
const locateEvent = 'openpe:model-find-locate';
export const modelFindChangedEvent = 'openpe:model-find-changed';
type ModelFindResult = { matches: ModelFindTarget[]; truncated: boolean };

export function modelPanelMatches(
  targets: readonly ModelFindTarget[],
  query: string,
): ModelFindResult {
  const matches: ModelFindTarget[] = [];
  if (!query) return { matches, truncated: false };
  for (const target of targets) {
    if (!literalPanelMatches([target.label], query, 1).matches.length) continue;
    if (matches.length === panelFindLimit) return { matches, truncated: true };
    matches.push({ ...target });
  }
  return { matches, truncated: false };
}

export function queryModelPanel(root: Element, query: string): ModelFindResult {
  const request = { query, result: { matches: [], truncated: false } as ModelFindResult };
  root.dispatchEvent(new CustomEvent(queryEvent, { detail: request }));
  return request.result;
}

export function locateModelPanel(root: Element, target: ModelFindTarget) {
  root.dispatchEvent(new CustomEvent(locateEvent, { detail: target }));
}

/** One active scene's bounded metadata and existing selection/camera adapters. */
export function useModelPanelFind(
  root: RefObject<HTMLDivElement | null>,
  targets: () => ModelFindTarget[],
  locate: (target: ModelFindTarget) => void,
) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const query = (event: Event) => {
      const request = (event as CustomEvent<{ query: string; result: ModelFindResult }>).detail;
      if (!request || typeof request.query !== 'string') return;
      request.result = modelPanelMatches(targets(), request.query);
    };
    const reveal = (event: Event) => {
      const target = (event as CustomEvent<ModelFindTarget>).detail;
      if (!target || typeof target.id !== 'string') return;
      // Re-resolve eligibility against the current scene, never a cached result.
      const current = targets().find((item) => item.kind === target.kind && item.id === target.id);
      if (current) locate(current);
    };
    element.addEventListener(queryEvent, query);
    element.addEventListener(locateEvent, reveal);
    element.dispatchEvent(new Event(modelFindChangedEvent));
    return () => {
      element.removeEventListener(queryEvent, query);
      element.removeEventListener(locateEvent, reveal);
    };
  });
}
