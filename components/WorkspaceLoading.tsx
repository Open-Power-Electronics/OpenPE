import Logo from './Logo';

export default function WorkspaceLoading({
  label = 'Loading workspace',
  panel = false,
}: {
  label?: string;
  panel?: boolean;
}) {
  return (
    <div className={panel ? 'panel-loading' : 'loading-screen'} role="status" aria-label={label}>
      <span className="loading-content" aria-hidden="true">
        <span className="loading-mark">
          <Logo size={80} />
          <span className="loading-signal" />
        </span>
        <span className="loading-caption">Loading...</span>
      </span>
    </div>
  );
}
