/** Decorative signal routes, separate from schematic data and simulation results. */
export default function HomeHeroBackdrop() {
  return (
    <div className="home-hero-backdrop" aria-hidden="true">
      <div className="home-hero-grid" />
      <svg viewBox="0 0 1200 440" fill="none" focusable="false">
        <g
          className="home-hero-traces"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M0 106H92L126 72H212V124H286M0 330H66L106 370H220V320H296" />
          <path d="M0 208H66L90 184H146M146 171V197M154 176V192M154 184H180" />
          <path d="M180 184a10 10 0 0 1 20 0a10 10 0 0 1 20 0a10 10 0 0 1 20 0H306" />
          <path d="M256 184V240M245 240H267M245 248H267M256 248V290H130L106 266H0" />
          <path d="M130 290V324M120 324H140M124 330H136M128 336H132" />
          <path d="M32 64H100M20 394H88L114 420H284" />
          <path d="M908 76H1004L1038 110H1200M926 364H1010L1044 330H1200" />
          <path d="M916 154H1200M916 224H1200M916 294H1200" />
          <path d="M940 128V310M1008 128V310M1076 128V310M1144 128V310" strokeDasharray="2 7" />
          {[
            [92, 106],
            [212, 72],
            [256, 184],
            [130, 290],
            [66, 330],
            [1004, 76],
            [1044, 330],
          ].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3" />
          ))}
        </g>
        <g
          className="home-hero-signals"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          <path d="M916 190H942V154H974V190H1010V154H1042V190H1078V154H1110V190H1146V154H1178V190H1200" />
          <path d="M916 272C950 272 946 234 968 234S1000 272 1026 262S1054 241 1078 250S1102 263 1126 258S1156 253 1200 256" />
          <path d="M48 112V140H84L106 162H130" />
          <path
            className="home-signal-current"
            pathLength="100"
            d="M916 190H942V154H974V190H1010V154H1042V190H1078V154H1110V190H1146V154H1178V190H1200"
          />
        </g>
      </svg>
    </div>
  );
}
