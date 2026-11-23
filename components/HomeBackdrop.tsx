// Match the four supply traces in public/brand/site-circuit.svg.
const supplyTraces = [
  'M156 0V132L92 196V382L166 456V648L268 750H329L398 819V972L327 1043H242L156 1129V1320',
  'M440 0V126L502 188V315L447 370V505L485 543V601L458 628V705L536 783V900L478 958V1094L440 1132V1320',
  'M944 0V203L1016 275V436L1103 523V591L1035 659V850L984 901V1016L944 1056V1320',
  'M1288 0V118L1360 190V391L1264 487V653L1356 745V908L1288 976V1320',
];

export default function HomeBackdrop() {
  return (
    <div className="home-backdrop" aria-hidden="true">
      <svg
        viewBox="0 0 1440 1320"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        focusable="false"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {supplyTraces.map((route, index) => (
          <path
            key={route}
            className="home-signal-current"
            pathLength="100"
            style={{ animationDelay: `-${index * 1.5}s` }}
            d={route}
          />
        ))}
      </svg>
    </div>
  );
}
