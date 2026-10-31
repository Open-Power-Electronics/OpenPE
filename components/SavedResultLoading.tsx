export type SavedResultLoadingStage = 'reading' | 'preparing';

export default function SavedResultLoading({
  analysis,
  stage,
}: {
  analysis: 'spice' | 'thermal';
  stage: SavedResultLoadingStage;
}) {
  const message =
    stage === 'reading'
      ? analysis === 'spice'
        ? 'Loading saved SPICE results…'
        : 'Loading saved thermal results…'
      : analysis === 'spice'
        ? 'Preparing saved waveforms…'
        : 'Preparing temperature view…';
  return (
    <span
      className="analysis-saved-loading"
      role="status"
      aria-label={message}
      data-saved-result-loading={stage}
    >
      <span className="analysis-saved-loading-message" title={message}>
        {message}
      </span>
      <span className="analysis-saved-loading-bar" role="progressbar" aria-label={message} />
    </span>
  );
}
