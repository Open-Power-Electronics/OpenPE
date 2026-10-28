export default function Logo({ size = 30 }: { size?: number }) {
  return (
    <img
      src="/brand/openpe-mark.svg"
      width={size}
      height={size}
      alt="OpenPE — Signal E"
      draggable={false}
    />
  );
}
