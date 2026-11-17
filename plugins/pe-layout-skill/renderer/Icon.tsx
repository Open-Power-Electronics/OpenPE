export default function Icon() {
  return (
    <>
      <rect x="9" y="10" width="46" height="44" rx="5" />
      <rect x="18" y="19" width="12" height="15" rx="2" />
      <path d="M22 15v4m5-4v4m-5 15v4m5-4v4M14 23h4m-4 7h4m12-7h4m-4 7h4" />
      <path className="plugin-logo-signal" d="M40 19h7v23H23v6" />
      <circle className="plugin-logo-node" cx="40" cy="19" r="3" stroke="none" />
      <circle className="plugin-logo-node" cx="23" cy="48" r="3" stroke="none" />
    </>
  );
}
