'use client';
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { createLayoutGridApplicator } from '../lib/drawing-grid';
import { registerLayoutCameraFlush } from '../lib/layout-camera-presentation';
import { readLayoutCameraStyle } from './layoutCameraStyles';

export type LayoutView = { x: number; y: number; width: number };
export type LayoutCameraPanLease = { update: (run: () => void) => void; release: () => void };

export function layoutZoomWidth(width: number, factor: number) {
  return Math.min(2000, Math.max(8, width * factor));
}

/** Preserve the exact pointer anchor; clamped zooms retain the current pose. */
export function zoomLayoutView(
  view: LayoutView,
  factor: number,
  ratio: number,
  at?: { x: number; y: number },
): LayoutView {
  const width = layoutZoomWidth(view.width, factor);
  if (width === view.width) return view;
  const center = at ?? { x: view.x + view.width / 2, y: view.y + view.width / ratio / 2 };
  return {
    x: center.x - ((center.x - view.x) * width) / view.width,
    y: center.y - ((center.y - view.y) * width) / view.width,
    width,
  };
}

/** Rebase a mapped world point after a camera change without another layout
 * read. The unchanged viewport and any outer CSS affine transform cancel. */
export function rebaseLayoutCameraPoint(
  point: { x: number; y: number },
  before: LayoutView,
  after: LayoutView,
) {
  if (before.x === after.x && before.y === after.y && before.width === after.width) return point;
  const scale = after.width / before.width;
  return {
    x: after.x + (point.x - before.x) * scale,
    y: after.y + (point.y - before.y) * scale,
  };
}

/** Camera state is presentation-only. Drawing events read the latest values;
 * only small overlays and readouts subscribe to camera changes. */
export function createLayoutCamera(initial: LayoutView) {
  let snapshot = { ...initial };
  const listeners = new Set<() => void>();
  const view = Object.defineProperties({} as LayoutView, {
    x: { enumerable: true, get: () => snapshot.x },
    y: { enumerable: true, get: () => snapshot.y },
    width: { enumerable: true, get: () => snapshot.width },
  });
  return {
    view,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setView: (value: LayoutView | ((previous: LayoutView) => LayoutView)) => {
      const next = typeof value === 'function' ? value(snapshot) : value;
      if (snapshot.x === next.x && snapshot.y === next.y && snapshot.width === next.width) return;
      snapshot = { x: next.x, y: next.y, width: next.width };
      for (const listener of listeners) listener();
    },
  };
}
type LayoutCamera = ReturnType<typeof createLayoutCamera>;

export function LayoutCameraRender({
  camera,
  children,
}: {
  camera: LayoutCamera;
  children: (view: LayoutView) => ReactNode;
}) {
  const view = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  return children(view);
}

/** Translation does not change screen-space widths, radii or scale readouts. */
export function LayoutCameraScaleRender({
  camera,
  children,
}: {
  camera: LayoutCamera;
  children: (view: Pick<LayoutView, 'width'>) => ReactNode;
}) {
  const snapshot = useCallback(() => camera.getSnapshot().width, [camera]);
  const width = useSyncExternalStore(camera.subscribe, snapshot, snapshot);
  return children({ width });
}

const attribute = (node: Element, name: string, value: string | number) => {
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
};

function cameraTrackTargets(svg: SVGSVGElement) {
  return Array.from(svg.querySelectorAll<SVGLineElement>('[data-layout-track-target]'), (node) => ({
    node,
    width: Number(node.dataset.layoutTrackTarget),
  }));
}

function applyTrackCameraTargets(
  tracks: ReturnType<typeof cameraTrackTargets>,
  scale: number,
  fixedTargets: boolean,
) {
  for (const { node, width } of tracks) {
    if (fixedTargets) {
      attribute(node, 'vector-effect', 'non-scaling-stroke');
      attribute(node, 'stroke-width', 7);
      attribute(node, 'data-layout-fixed-track', 'true');
    } else {
      if (node.getAttribute('data-layout-fixed-track') === 'true') {
        node.removeAttribute('vector-effect');
        node.removeAttribute('data-layout-fixed-track');
      }
      attribute(node, 'stroke-width', String(Math.max(width, scale * 7)));
    }
  }
}

function cameraTargets(svg: SVGSVGElement, hits = true) {
  return {
    fixed: false,
    tracksFixed: false,
    grid: createLayoutGridApplicator(svg),
    frames: Array.from(
      svg.querySelectorAll(
        '[data-layout-background], [data-layout-grid], [data-layout-interaction-surface]',
      ),
    ),
    tracks: hits ? cameraTrackTargets(svg) : [],
    vias: hits
      ? Array.from(svg.querySelectorAll<SVGCircleElement>('[data-layout-via-target]'), (node) => ({
          node,
          radius: Number(node.dataset.layoutViaTarget),
        }))
      : [],
    bodies: hits
      ? Array.from(svg.querySelectorAll<SVGRectElement>('[data-layout-body-bounds]'), (node) => ({
          node,
          bounds: node.dataset.layoutBodyBounds!.split(' ').map(Number),
        }))
      : [],
    graphics: hits
      ? Array.from(svg.querySelectorAll<SVGGElement>('[data-layout-graphic-target]'), (node) => ({
          width: Number(node.dataset.layoutGraphicTarget),
          nodes: Array.from(node.querySelectorAll('[stroke-width]')),
        }))
      : [],
  };
}

function applyCameraFrameBounds(frames: Element[], bounds: readonly number[]) {
  for (const rect of frames) {
    attribute(rect, 'x', bounds[0]);
    attribute(rect, 'y', bounds[1]);
    attribute(rect, 'width', bounds[2]);
    attribute(rect, 'height', bounds[3]);
  }
}

function applyCameraFrames(
  frames: Element[],
  view: LayoutView,
  size: { width: number; height: number },
) {
  applyCameraFrameBounds(frames, [
    view.x,
    view.y,
    view.width,
    view.width / (size.width / size.height),
  ]);
}

function applyCameraTargets(
  svg: SVGSVGElement,
  targets: ReturnType<typeof cameraTargets>,
  view: LayoutView,
  size: { width: number; height: number },
  hitTargets: boolean,
  fixedTargets = false,
  setViewport?: (value: string) => LayoutView | void,
) {
  const height = view.width / (size.width / size.height);
  const viewport = `${view.x} ${view.y} ${view.width} ${height}`;
  const frameView = setViewport?.(viewport);
  if (!setViewport) attribute(svg, 'viewBox', viewport);
  applyCameraFrames(targets.frames, frameView || view, size);
  targets.grid(view.width / size.width);
  if (!hitTargets) return;
  const scale = view.width / size.width;
  if (!fixedTargets || !targets.tracksFixed)
    applyTrackCameraTargets(targets.tracks, scale, fixedTargets);
  targets.tracksFixed = fixedTargets;
  for (const { node, radius } of targets.vias)
    attribute(node, 'r', String(Math.max(radius, scale * 4)));
  if (!fixedTargets || !targets.fixed)
    for (const { node, bounds } of targets.bodies) {
      const [minX, minY, maxX, maxY] = bounds;
      // pointerEvents="all" on the original unstroked rect includes its implicit
      // one-world-unit stroke. Keep that half-unit expansion before adding the
      // two-screen-pixel margin with an explicit non-scaling miter stroke.
      const margin = fixedTargets ? 0.5 : scale * 2;
      if (fixedTargets) {
        attribute(node, 'stroke', 'transparent');
        attribute(node, 'stroke-width', 4);
        attribute(node, 'stroke-linejoin', 'miter');
        attribute(node, 'vector-effect', 'non-scaling-stroke');
        attribute(node, 'data-layout-fixed-body', 'true');
      } else if (node.getAttribute('data-layout-fixed-body') === 'true') {
        for (const name of [
          'stroke',
          'stroke-width',
          'stroke-linejoin',
          'vector-effect',
          'data-layout-fixed-body',
        ])
          node.removeAttribute(name);
      }
      attribute(node, 'x', String(minX - margin));
      attribute(node, 'y', String(minY - margin));
      attribute(node, 'width', String(maxX - minX + margin * 2));
      attribute(node, 'height', String(maxY - minY + margin * 2));
    }
  targets.fixed = fixedTargets;
  for (const target of targets.graphics) {
    const width = String(Math.max(target.width, scale * 6));
    for (const graphic of target.nodes) attribute(graphic, 'stroke-width', width);
  }
}

/** Keep the root SVG as the world-coordinate, picking and export boundary. */
export function applyLayoutCamera(
  svg: SVGSVGElement,
  view: LayoutView,
  size: { width: number; height: number },
  hitTargets = true,
) {
  applyCameraTargets(svg, cameraTargets(svg, hitTargets), view, size, hitTargets);
}

/** Bind only after a drawing commit; rebuild when geometry/display inputs
 * change. The closure owns DOM references and parsed target metadata for that
 * exact committed tree, without querying the complete board on every zoom. */
export function createLayoutCameraApplicator(
  svg: SVGSVGElement,
  {
    fixedTargets = false,
    compositor = false,
    frameScheduled = false,
    panFrameReserve = false,
    frameReserve = false,
  }: {
    fixedTargets?: boolean;
    compositor?: boolean;
    frameScheduled?: boolean;
    panFrameReserve?: boolean;
    frameReserve?: boolean;
  } = {},
) {
  let presentation: ReturnType<typeof createCompositorViewport> | null = null;
  let presented: { view: LayoutView; size: { width: number; height: number } } | null = null;
  let pending: {
    view: LayoutView;
    size: { width: number; height: number };
    hitTargets: boolean;
    pan: object | null;
  } | null = null;
  let panLease: object | null = null;
  let panUpdate: object | null = null;
  let panFrames: {
    lease: object;
    view: LayoutView;
    width: number;
    size: { width: number; height: number };
  } | null = null;
  let frame: number | undefined;
  let disposed = false;
  const cancelFrame = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const retire = () => {
    if (disposed) return;
    cancelFrame();
    pending = null;
    panLease = null;
    panUpdate = null;
    disposed = true;
    presentation?.dispose();
    restorePanFrames();
    presented = null;
  };
  // Retire the previous owner before reading its viewport or capturing styles.
  // It drops queued work; an ordinary dispose instead consumes its final pose.
  const unregister = registerLayoutCameraFlush(svg, () => flush(), retire);
  const isCurrent = () => !disposed && unregister.isCurrent();
  const targets = cameraTargets(svg);
  // Compare the untransformed SVG viewport with the editor's measured viewport.
  // Ancestor CSS transforms use the original dynamic target path. This check
  // belongs to the committed binding, never the per-wheel hot path.
  let viewport: { width: number; height: number } | null = null;
  if (fixedTargets || compositor) {
    const bounds = svg.getBoundingClientRect();
    viewport = { width: bounds.width, height: bounds.height };
    for (let element: Element | null = svg; element; element = element.parentElement) {
      const current = getComputedStyle(element);
      if (
        ['transform', 'translate', 'rotate', 'scale', 'perspective'].some((name) => {
          const value = current.getPropertyValue(name);
          return value && value !== 'none';
        }) ||
        !['', 'normal', '1'].includes(current.getPropertyValue('zoom'))
      ) {
        viewport = null;
        break;
      }
    }
  }
  presentation =
    compositor && viewport
      ? createCompositorViewport(svg, viewport, frameReserve ? targets.frames : null)
      : null;
  const restorePanFrames = () => {
    if (!panFrames) return;
    panFrames = null;
    if (presented) applyCameraFrames(targets.frames, presented.view, presented.size);
  };
  const preparePanFrames = (
    view: LayoutView,
    size: { width: number; height: number },
    lease: object,
  ) => {
    const value = `${view.x} ${view.y} ${view.width} ${view.width / (size.width / size.height)}`;
    if (!panFrameReserve || !presentation?.canReplayNative(value, size)) return;
    // A reserve is prepared before the compositor owns the host clip. The
    // native SVG must therefore already clip both axes during a pan pickup.
    const style = readLayoutCameraStyle(svg);
    if (
      !['hidden', 'clip'].includes(style('overflow-x')) ||
      !['hidden', 'clip'].includes(style('overflow-y'))
    )
      return;
    const bounds = svg.getBoundingClientRect();
    if (
      Math.abs(bounds.width - size.width) >= 0.000001 ||
      Math.abs(bounds.height - size.height) >= 0.000001
    )
      return;
    const height = view.width / (size.width / size.height);
    const reserve = { x: view.x - view.width / 2, y: view.y - height / 2, width: view.width * 2 };
    const reserveHeight = reserve.width / (size.width / size.height);
    if (
      ![
        reserve.x,
        reserve.y,
        reserve.width,
        reserve.x + reserve.width,
        reserve.y + reserveHeight,
      ].every(Number.isFinite) ||
      !(reserve.width > 0 && height > 0) ||
      !(
        reserve.x < view.x &&
        reserve.y < view.y &&
        reserve.x + reserve.width > view.x + view.width &&
        reserve.y + reserveHeight > view.y + height
      )
    )
      return;
    panFrames = { lease, view: reserve, width: view.width, size: { ...size } };
    applyCameraFrames(targets.frames, reserve, size);
    return reserve;
  };
  const useFixedTargets = (size: { width: number; height: number }, untransformed: boolean) =>
    Boolean(
      fixedTargets &&
      viewport &&
      Math.abs(viewport.width - size.width) < 0.000001 &&
      Math.abs(viewport.height - size.height) < 0.000001 &&
      untransformed,
    );
  const draw = (
    view: LayoutView,
    size: { width: number; height: number },
    hitTargets: boolean,
    pan: object | null,
  ) => {
    if (!hitTargets && presentation && (!panFrames || pan === null)) {
      const value = `${view.x} ${view.y} ${view.width} ${view.width / (size.width / size.height)}`;
      if (presentation.canReplayNative(value, size)) {
        // A drawing commit can replay old frame/grid props without changing
        // the settled camera. Restore only those attributes; no CSS is owned
        // or changed on this path, and picking targets were not requested.
        panFrames = null;
        applyCameraTargets(
          svg,
          targets,
          view,
          size,
          false,
          false,
          frameReserve
            ? (current) =>
                presentation!.retainFrames(current, size, presentation!.supportsFixedTargets())
            : undefined,
        );
        presented = { view: { ...view }, size: { ...size } };
        return;
      }
    }
    const untransformed = !presentation || presentation.supportsFixedTargets();
    if (
      panFrames &&
      (!untransformed ||
        pan !== panLease ||
        pan !== panFrames.lease ||
        view.width !== panFrames.width ||
        size.width !== panFrames.size.width ||
        size.height !== panFrames.size.height)
    )
      panFrames = null;
    applyCameraTargets(
      svg,
      targets,
      view,
      size,
      hitTargets,
      useFixedTargets(size, untransformed),
      presentation
        ? (value) => {
            if (panFrames) {
              const reserve = panFrames.view;
              const height = view.width / (size.width / size.height);
              if (
                view.x < reserve.x ||
                view.y < reserve.y ||
                view.x + view.width > reserve.x + reserve.width ||
                view.y + height > reserve.y + reserve.width / (size.width / size.height)
              ) {
                // Rebase before exposing a pose beyond the finite reserve.
                // The next reserve is again only twice this native viewport.
                panFrames = null;
                presentation.rebase(value);
                return preparePanFrames(view, size, pan!);
              }
            }
            if (!presentation.apply(value, size, untransformed, pan !== null && pan === panLease))
              panFrames = null;
            return frameReserve
              ? presentation.retainFrames(value, size, untransformed)
              : panFrames?.view;
          }
        : undefined,
    );
    presented = { view: { ...view }, size: { ...size } };
  };
  const drawNow = (
    view: LayoutView,
    size: { width: number; height: number },
    hitTargets: boolean,
    pan: object | null,
  ) => {
    if (!isCurrent()) return;
    const updateHits = hitTargets || Boolean(pending?.hitTargets);
    cancelFrame();
    pending = null;
    draw(view, size, updateHits, pan);
  };
  const applyNow = (view: LayoutView, size: { width: number; height: number }, hitTargets = true) =>
    drawNow(view, size, hitTargets, null);
  const consume = () => {
    cancelFrame();
    const next = pending;
    pending = null;
    if (next && isCurrent()) draw(next.view, next.size, next.hitTargets, next.pan);
  };
  const apply = (view: LayoutView, size: { width: number; height: number }, hitTargets = true) => {
    if (!isCurrent()) return;
    const pan = panUpdate !== null && panUpdate === panLease ? panUpdate : null;
    const sameSize =
      presented && presented.size.width === size.width && presented.size.height === size.height;
    // First application, viewport changes and explicit drawing replays must
    // match the committed tree before paint. Only navigation is coalesced.
    if (!frameScheduled || !sameSize) {
      drawNow(view, size, hitTargets, sameSize ? pan : null);
      return;
    }
    pending = {
      view: { ...view },
      size: { ...size },
      hitTargets: hitTargets || Boolean(pending?.hitTargets),
      pan,
    };
    if (frame === undefined) {
      const scheduled = requestAnimationFrame(() => {
        if (!isCurrent() || frame !== scheduled) return;
        frame = undefined;
        consume();
      });
      frame = scheduled;
    }
  };
  const flush = () => {
    if (!isCurrent()) return;
    const hadPendingPose = pending !== null;
    consume();
    // A just-consumed pose has written a fresh matrix in this same call. Keep
    // its native check rather than laying it out only to remove that matrix.
    presentation?.flush(!hadPendingPose);
    restorePanFrames();
  };
  return Object.assign(apply, {
    applyNow,
    beginPan(): LayoutCameraPanLease {
      if (panLease || panFrameReserve || frameReserve) flush();
      const lease = {};
      if (isCurrent()) {
        panLease = lease;
        if (!frameReserve && panFrameReserve && presented && presentation?.supportsFixedTargets())
          preparePanFrames(presented.view, presented.size, lease);
      }
      return {
        update(run) {
          if (!isCurrent() || panLease !== lease) return;
          // The numerical camera notifies synchronously. Capture this source
          // in the queued pose rather than inspecting held buttons at draw time.
          const previous = panUpdate;
          panUpdate = lease;
          try {
            run();
          } finally {
            panUpdate = previous;
          }
        },
        release() {
          if (!isCurrent() || panLease !== lease) return;
          panLease = null;
          flush();
        },
      };
    },
    refreshTracks() {
      if (!isCurrent()) return;
      // New committed track nodes need current padding, not a new camera,
      // footprint/grid binding or compositor promotion lifetime.
      flush();
      targets.tracks = cameraTrackTargets(svg);
      targets.tracksFixed = false;
      if (!presented) return;
      const untransformed = !presentation || presentation.supportsFixedTargets();
      const fixed = useFixedTargets(presented.size, untransformed);
      if (fixed !== targets.fixed) {
        // A foreign transform can switch the established body-padding mode.
        // Reapply captured hit bindings together without collecting the tree.
        applyCameraTargets(svg, targets, presented.view, presented.size, true, fixed);
      } else {
        applyTrackCameraTargets(targets.tracks, presented.view.width / presented.size.width, fixed);
        targets.tracksFixed = fixed;
      }
    },
    getPresentedView: () => (isCurrent() && presented ? { ...presented.view } : null),
    flush,
    dispose() {
      if (disposed) return;
      flush();
      retire();
      unregister();
    },
  });
}

export const layoutCameraRebaseDelayMs = 120;

/** Transient camera motion stays in the compositor. The native viewBox remains
 * the exact settled camera before picking, document commits and captures. */
function createCompositorViewport(
  svg: SVGSVGElement,
  viewport: { width: number; height: number },
  reserveFrames: Element[] | null = null,
) {
  const host = svg.parentElement;
  const missingRootStyle = !svg.hasAttribute('style');
  const promotion = {
    value: svg.style.getPropertyValue('will-change'),
    priority: svg.style.getPropertyPriority('will-change'),
    owned: '',
  };
  const hints = promotion.value
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value && value !== 'auto');
  if (!hints.includes('transform')) hints.push('transform');
  svg.style.setProperty('will-change', hints.join(', '));
  promotion.owned = svg.style.getPropertyValue('will-change');
  let base = '';
  let desired = '';
  let metadata = '';
  let transform = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let frameCover: number[] | null = null;
  let reserveViewportValid = true;
  let reserveInitialized = false;
  const ownedStyles = new Map<
    HTMLElement | SVGSVGElement,
    Map<
      string,
      {
        value: string;
        priority: string;
        owned: string;
        ownedPriority: string;
      }
    >
  >();
  const missingStyle = new Set<HTMLElement | SVGSVGElement>();
  let strokes: {
    node: SVGElement;
    values: { name: string; original: string; numbers: number[]; owned: string }[];
  }[] = [];
  const ownStyle = (node: HTMLElement | SVGSVGElement, name: string, value: string) => {
    let values = ownedStyles.get(node);
    if (!values) {
      if (!node.hasAttribute('style')) missingStyle.add(node);
      ownedStyles.set(node, (values = new Map()));
    }
    if (!values.has(name))
      values.set(name, {
        value: node.style.getPropertyValue(name),
        priority: node.style.getPropertyPriority(name),
        owned: value,
        ownedPriority: '',
      });
    node.style.setProperty(name, value);
    values.get(name)!.owned = node.style.getPropertyValue(name);
    values.get(name)!.ownedPriority = node.style.getPropertyPriority(name);
    return values.get(name)!.owned;
  };
  const restore = () => {
    for (const { node, values } of strokes)
      for (const { name, original, owned } of values)
        if (node.getAttribute(name) === owned) node.setAttribute(name, original);
    strokes = [];
    for (const [node, values] of ownedStyles)
      for (const [name, value] of values)
        if (
          node.style.getPropertyValue(name) === value.owned &&
          node.style.getPropertyPriority(name) === value.ownedPriority
        ) {
          if (value.value) node.style.setProperty(name, value.value, value.priority);
          else node.style.removeProperty(name);
        }
    ownedStyles.clear();
    for (const node of missingStyle) if (!node.style.length) node.removeAttribute('style');
    missingStyle.clear();
    transform = '';
    if (svg.getAttribute('data-layout-camera-view') === metadata)
      svg.removeAttribute('data-layout-camera-view');
    metadata = '';
  };
  const settleNative = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!transform) {
      if (reserveFrames && desired) attribute(svg, 'viewBox', desired);
      return;
    }
    attribute(svg, 'viewBox', desired);
    base = desired;
    restore();
  };
  const flush = (measureBeforeNative = true) => {
    if (disposed) return;
    const measuredViewport = measureBeforeNative ? measureReserveBeforeNative() : undefined;
    settleNative();
    settleFrameCover(measuredViewport);
  };
  const matchesTransform = (value: string) => {
    try {
      const expected = new DOMMatrixReadOnly(transform);
      const actual = new DOMMatrixReadOnly(value === 'none' ? undefined : value);
      return (
        actual.is2D &&
        Math.abs(actual.a - expected.a) * viewport.width +
          Math.abs(actual.c - expected.c) * viewport.height +
          Math.abs(actual.e - expected.e) <
          0.01 &&
        Math.abs(actual.b - expected.b) * viewport.width +
          Math.abs(actual.d - expected.d) * viewport.height +
          Math.abs(actual.f - expected.f) <
          0.01
      );
    } catch {
      return false;
    }
  };
  const computedTransform = () => readLayoutCameraStyle(svg)('transform');
  const untransformed = () => {
    for (let element: Element | null = svg; element; element = element.parentElement) {
      const style = readLayoutCameraStyle(element);
      for (const name of ['transform', 'translate', 'rotate', 'scale', 'perspective']) {
        if (
          element === svg &&
          name === 'transform' &&
          transform &&
          svg.style.getPropertyValue('transform') === transform &&
          svg.style.getPropertyPriority('transform') === '' &&
          matchesTransform(style('transform'))
        )
          continue;
        const value = style(name);
        if (value && value !== 'none') return false;
      }
      if (!['', 'normal', '1'].includes(style('zoom'))) return false;
    }
    return true;
  };
  const parsedView = (value: string) => value.split(' ').map(Number);
  const clipped = (node: Element) => {
    const style = readLayoutCameraStyle(node);
    return (
      ['hidden', 'clip'].includes(style('overflow-x')) &&
      ['hidden', 'clip'].includes(style('overflow-y'))
    );
  };
  const reserveEligible = (size: { width: number; height: number }, eligible: boolean) =>
    Boolean(
      reserveFrames?.length &&
      reserveViewportValid &&
      eligible &&
      host &&
      Math.abs(viewport.width - size.width) < 0.000001 &&
      Math.abs(viewport.height - size.height) < 0.000001 &&
      (transform ? clipped(host) : clipped(svg)),
    );
  const coverIncludes = (cover: readonly number[], view: readonly number[]) =>
    view.every(Number.isFinite) &&
    view[2] > 0 &&
    view[3] > 0 &&
    view[0] >= cover[0] &&
    view[1] >= cover[1] &&
    view[0] + view[2] <= cover[0] + cover[2] &&
    view[1] + view[3] <= cover[1] + cover[3] &&
    cover[2] <= view[2] * 4 &&
    cover[3] <= view[3] * 4;
  const coverMatches = (value: string) =>
    Boolean(
      frameCover &&
      coverIncludes(frameCover, parsedView(value)) &&
      coverIncludes(frameCover, parsedView(base)),
    );
  const viewportMatches = (bounds: { width: number; height: number }, scale = 1) =>
    Math.abs(bounds.width / scale - viewport.width) < 0.000001 &&
    Math.abs(bounds.height / scale - viewport.height) < 0.000001;
  const checkReserveViewport = () => {
    // A public flush can precede ResizeObserver and the next measured-size
    // application. Read the settled root, never its scaled transient bounds.
    const bounds = svg.getBoundingClientRect();
    reserveViewportValid = viewportMatches(bounds);
    return reserveViewportValid;
  };
  const measureReserveBeforeNative = () => {
    if (!frameCover || !reserveViewportValid || !transform || !untransformed()) return;
    // Verify the matrix is still ours before interpreting transformed bounds.
    // A release must not dirty the complete SVG with native camera writes and
    // then synchronously lay it out just to measure its unchanged CSS viewport.
    if (
      svg.style.getPropertyValue('transform') !== transform ||
      svg.style.getPropertyPriority('transform') !== ''
    )
      return;
    let scale: number;
    try {
      const value = computedTransform();
      if (!matchesTransform(value)) return;
      const matrix = new DOMMatrixReadOnly(value);
      if (
        !matrix.is2D ||
        !(matrix.a > 0) ||
        matrix.a !== matrix.d ||
        matrix.b !== 0 ||
        matrix.c !== 0
      )
        return;
      scale = matrix.a;
    } catch {
      // Unsupported matrix readings retain the original native measurement.
      return;
    }
    const bounds = svg.getBoundingClientRect();
    // Scaled DOMRects may round more than native ones. An inconclusive or
    // changed measurement uses the original settled check and tolerance.
    if (viewportMatches(bounds, scale)) return true;
  };
  const dropFrameCover = () => {
    if (!frameCover) return;
    frameCover = null;
    if (reserveFrames && desired) applyCameraFrameBounds(reserveFrames, parsedView(desired));
  };
  const settleFrameCover = (measuredViewport?: boolean) => {
    if (!frameCover) return;
    if (
      !reserveEligible(viewport, untransformed()) ||
      !(measuredViewport ?? checkReserveViewport()) ||
      !coverMatches(desired)
    )
      dropFrameCover();
    else if (reserveFrames) applyCameraFrameBounds(reserveFrames, frameCover);
  };
  const retainFrames = (
    value: string,
    size: { width: number; height: number },
    eligible: boolean,
  ) => {
    if (!reserveFrames) return;
    // The first committed application reuses the binding's measured viewport.
    // Native replays must also notice a physical resize not yet delivered to React.
    if (reserveInitialized && !transform) checkReserveViewport();
    reserveInitialized = true;
    if (!reserveEligible(size, eligible)) {
      dropFrameCover();
      return;
    }
    if (!coverMatches(value)) {
      // Rebase before preparing a different finite cover. It stays clipped at
      // the native pose until the next bounded compositor application.
      desired = value;
      settleNative();
      attribute(svg, 'viewBox', value);
      base = value;
      frameCover = null;
      if (!reserveEligible(size, untransformed())) return;
      const next = parsedView(value);
      const width = next[2] * 2,
        height = width / (size.width / size.height);
      const cover = [next[0] - next[2] / 2, next[1] - next[3] / 2, width, height];
      if (
        ![...cover, cover[0] + width, cover[1] + height].every(Number.isFinite) ||
        !(
          cover[0] < next[0] &&
          cover[1] < next[1] &&
          cover[0] + width > next[0] + next[2] &&
          cover[1] + height > next[1] + next[3]
        ) ||
        !coverIncludes(cover, next)
      )
        return;
      frameCover = cover;
    }
    return frameCover ? { x: frameCover[0], y: frameCover[1], width: frameCover[2] } : undefined;
  };
  return {
    canReplayNative(value: string, size: { width: number; height: number }) {
      return (
        !disposed &&
        !transform &&
        timer === undefined &&
        !ownedStyles.size &&
        !strokes.length &&
        base === value &&
        desired === value &&
        svg.getAttribute('viewBox') === base &&
        Math.abs(viewport.width - size.width) < 0.000001 &&
        Math.abs(viewport.height - size.height) < 0.000001
      );
    },
    supportsFixedTargets: untransformed,
    retainFrames,
    rebase(value: string) {
      desired = value;
      settleNative();
      attribute(svg, 'viewBox', value);
      base = value;
    },
    apply(
      value: string,
      size: { width: number; height: number },
      untransformed: boolean,
      heldPan = false,
    ) {
      if (disposed) return false;
      desired = value;
      const sameSize =
        Math.abs(viewport.width - size.width) < 0.000001 &&
        Math.abs(viewport.height - size.height) < 0.000001;
      if (!sameSize) reserveViewportValid = false;
      if (!base || !sameSize || !host || !untransformed) {
        flush();
        attribute(svg, 'viewBox', value);
        base = value;
        return false;
      }
      if (frameCover && (!reserveEligible(size, untransformed) || !coverMatches(value))) {
        // Never expose a CSS overflow pose outside the old finite cover, or
        // scale it beyond four current/native viewport dimensions.
        settleNative();
        attribute(svg, 'viewBox', value);
        base = value;
        dropFrameCover();
        return false;
      }
      if (value === base && !transform) {
        attribute(svg, 'viewBox', value);
        return true;
      }
      const previous = base.split(' ').map(Number),
        next = value.split(' ').map(Number);
      const scale = previous[2] / next[2];
      const x = ((previous[0] - next[0]) * size.width) / next[2];
      const y = ((previous[1] - next[1]) * size.width) / next[2];
      // Bound raster extents without changing the accepted native camera range.
      if (
        scale < 0.25 ||
        scale > 4 ||
        Math.abs(x) > size.width * 3 ||
        Math.abs(y) > size.height * 3
      ) {
        flush();
        attribute(svg, 'viewBox', value);
        base = value;
        return false;
      }
      if (!transform) {
        const bounds = svg.getBoundingClientRect();
        if (
          Math.abs(bounds.width - size.width) >= 0.000001 ||
          Math.abs(bounds.height - size.height) >= 0.000001
        ) {
          reserveViewportValid = false;
          attribute(svg, 'viewBox', value);
          base = value;
          return false;
        }
        reserveViewportValid = true;
        strokes = Array.from(
          svg.querySelectorAll<SVGElement>('[vector-effect="non-scaling-stroke"][stroke-width]'),
        )
          .filter(
            (node) =>
              !node.matches('[data-layout-track-target], [data-layout-body-bounds]') &&
              !node.closest('[data-layout-graphic-target]') &&
              node.getAttribute('stroke') !== 'transparent',
          )
          .map((node) => ({
            node,
            values: ['stroke-width', 'stroke-dasharray', 'stroke-dashoffset']
              .filter((name) => node.hasAttribute(name))
              .map((name) => {
                const original = node.getAttribute(name)!;
                return {
                  name,
                  original,
                  numbers: original.trim().split(/[ ,]+/).map(Number),
                  owned: '',
                };
              }),
          }));
        if (
          strokes.some((stroke) =>
            stroke.values.some((value) => value.numbers.some((number) => !Number.isFinite(number))),
          )
        ) {
          strokes = [];
          attribute(svg, 'viewBox', value);
          base = value;
          return false;
        }
        ownStyle(svg, 'transform-origin', '0px 0px');
        ownStyle(svg, 'overflow-x', 'visible');
        ownStyle(svg, 'overflow-y', 'visible');
        ownStyle(host, 'overflow-x', 'hidden');
        ownStyle(host, 'overflow-y', 'hidden');
      }
      // CSS scales the rasterized non-scaling strokes too. Compensate them so
      // visible airwires and handles remain exact. Transparent hit geometry is
      // restored by the native rebase before every actual pick.
      for (const stroke of strokes) {
        for (const metric of stroke.values) {
          metric.owned = metric.numbers.map((number) => number / scale).join(' ');
          attribute(stroke.node, metric.name, metric.owned);
        }
      }
      transform = ownStyle(svg, 'transform', `matrix(${scale}, 0, 0, ${scale}, ${x}, ${y})`);
      // Computed Typed OM values avoid the synchronous layout needed to obtain
      // a resolved CSS transform immediately after writing the camera matrix.
      if (!matchesTransform(computedTransform())) {
        flush();
        return false;
      }
      attribute(svg, 'data-layout-camera-view', value);
      metadata = value;
      clearTimeout(timer);
      // Pure translation can remain exact while a captured pan pauses. Zoom
      // and all ordinary camera updates keep the bounded idle native rebase.
      timer = heldPan && scale === 1 ? undefined : setTimeout(flush, layoutCameraRebaseDelayMs);
      return true;
    },
    flush,
    dispose() {
      settleNative();
      dropFrameCover();
      disposed = true;
      if (
        svg.style.getPropertyValue('will-change') === promotion.owned &&
        svg.style.getPropertyPriority('will-change') === ''
      ) {
        if (promotion.value)
          svg.style.setProperty('will-change', promotion.value, promotion.priority);
        else svg.style.removeProperty('will-change');
      }
      if (missingRootStyle && !svg.style.length) svg.removeAttribute('style');
    },
  };
}
