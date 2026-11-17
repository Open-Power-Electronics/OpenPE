export default function Icon() {
  return (
    <>
      <path d="M12 27h40a2 2 0 0 1 2 2v24a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V29a2 2 0 0 1 2-2Z" />
      <path d="M10 41h44M32 27v28M10 27l22 14 22-14M10 55l22-14 22 14" opacity=".55" />
      <path
        className="plugin-logo-signal"
        d="M21 21c-7-5 5-8-1-14m12 14c-7-5 5-8-1-14m12 14c-7-5 5-8-1-14"
      />
      <circle className="plugin-logo-node" cx="32" cy="41" r="3" stroke="none" />
    </>
  );
}
