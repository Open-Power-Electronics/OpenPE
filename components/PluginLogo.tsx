import { SPICE_PLUGIN_ID, THERMAL_PLUGIN_ID, PCB_DESIGN_PLUGIN_ID } from '@/lib/workbench-plugins';

export default function PluginLogo({ id }: { id: string }) {
  if (![SPICE_PLUGIN_ID, THERMAL_PLUGIN_ID, PCB_DESIGN_PLUGIN_ID].includes(id)) return null;
  return (
    <svg
      className="plugin-logo"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {id === SPICE_PLUGIN_ID ? (
        <>
          <path d="M10 19v26a5 5 0 0 0 5 5h34a5 5 0 0 0 5-5V19a5 5 0 0 0-5-5H15a5 5 0 0 0-5 5Z" />
          <path d="M20 50v6m12-6v6m12-6v6M20 8v6m12-6v6m12-6v6" />
          <path className="plugin-logo-signal" d="M7 34h13l6-12 9 22 6-12h16" />
          <circle className="plugin-logo-node" cx="7" cy="34" r="2.5" stroke="none" />
          <circle className="plugin-logo-node" cx="57" cy="32" r="2.5" stroke="none" />
        </>
      ) : id === PCB_DESIGN_PLUGIN_ID ? (
        <>
          <rect x="9" y="10" width="46" height="44" rx="5" />
          <rect x="18" y="19" width="12" height="15" rx="2" />
          <path d="M22 15v4m5-4v4m-5 15v4m5-4v4M14 23h4m-4 7h4m12-7h4m-4 7h4" />
          <path className="plugin-logo-signal" d="M40 19h7v23H23v6" />
          <circle className="plugin-logo-node" cx="40" cy="19" r="3" stroke="none" />
          <circle className="plugin-logo-node" cx="23" cy="48" r="3" stroke="none" />
        </>
      ) : (
        <>
          <path d="M12 27h40a2 2 0 0 1 2 2v24a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V29a2 2 0 0 1 2-2Z" />
          <path d="M10 41h44M32 27v28M10 27l22 14 22-14M10 55l22-14 22 14" opacity=".55" />
          <path
            className="plugin-logo-signal"
            d="M21 21c-7-5 5-8-1-14m12 14c-7-5 5-8-1-14m12 14c-7-5 5-8-1-14"
          />
          <circle className="plugin-logo-node" cx="32" cy="41" r="3" stroke="none" />
        </>
      )}
    </svg>
  );
}
