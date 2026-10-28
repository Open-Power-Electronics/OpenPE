import type { PCB } from '../lib/pcb';
import { isOwnedProjectNode } from '../lib/immutable-project';

type BoardTrack = PCB['tracks'][number];
type TrackTarget = Readonly<Pick<BoardTrack, 'id' | 'layer' | 'width'>>;
declare const layoutCameraTrackBinding: unique symbol;
export type LayoutCameraTrackBinding = { readonly [layoutCameraTrackBinding]: true };

/** Only track identity/order, layer and width determine the committed hit-node
 * binding. Coordinate/net/lock previews keep those same DOM target records.
 * The caller publishes its chosen packet after commit; preparation owns no
 * baseline and retains no prior track geometry. Semantic reuse requires both
 * the new array and previous packet to originate from internally owned data. */
export function createLayoutCameraTrackBindings() {
  const trusted = new WeakSet<LayoutCameraTrackBinding>();
  const metadata = new WeakMap<LayoutCameraTrackBinding, readonly TrackTarget[]>();
  const rawSources = new WeakMap<readonly BoardTrack[], WeakSet<LayoutCameraTrackBinding>>();
  return {
    prepare(
      tracks: readonly BoardTrack[],
      previous?: LayoutCameraTrackBinding | null,
    ): LayoutCameraTrackBinding {
      const owned = isOwnedProjectNode(tracks);
      if (previous && trusted.has(previous)) {
        if (owned) {
          const saved = metadata.get(previous);
          if (
            saved &&
            tracks.length === saved.length &&
            tracks.every((track, index) => {
              const target = saved[index];
              return (
                track.id === target.id &&
                track.layer === target.layer &&
                track.width === target.width
              );
            })
          )
            return previous;
        } else if (rawSources.get(tracks)?.has(previous)) return previous;
      }
      const next = Object.freeze({}) as LayoutCameraTrackBinding;
      trusted.add(next);
      if (owned)
        metadata.set(
          next,
          Object.freeze(tracks.map(({ id, layer, width }) => Object.freeze({ id, layer, width }))),
        );
      else {
        let identities = rawSources.get(tracks);
        if (!identities)
          rawSources.set(tracks, (identities = new WeakSet<LayoutCameraTrackBinding>()));
        identities.add(next);
      }
      return next;
    },
  };
}
