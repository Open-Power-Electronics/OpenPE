export default function Icon() {
  return (
    <>
      <path d="M10 19v26a5 5 0 0 0 5 5h34a5 5 0 0 0 5-5V19a5 5 0 0 0-5-5H15a5 5 0 0 0-5 5Z" />
      <path d="M20 50v6m12-6v6m12-6v6M20 8v6m12-6v6m12-6v6" />
      <path className="plugin-logo-signal" d="M7 34h13l6-12 9 22 6-12h16" />
      <circle className="plugin-logo-node" cx="7" cy="34" r="2.5" stroke="none" />
      <circle className="plugin-logo-node" cx="57" cy="32" r="2.5" stroke="none" />
    </>
  );
}
