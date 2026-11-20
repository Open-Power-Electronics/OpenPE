import type { RefObject } from 'react';
import Select from './Select';

const options = [
  { value: 'workbench', label: 'Workbench' },
  { value: 'raw-kicad', label: 'Raw KiCad' },
];

export default function WorkspaceModeSelect({
  mode,
  composing,
  disabled,
  onChange,
}: {
  mode: 'workbench' | 'raw-kicad';
  composing: RefObject<boolean>;
  disabled: boolean;
  onChange: () => void | Promise<void>;
}) {
  return (
    <Select
      label="Workspace mode"
      value={mode}
      options={options}
      disabled={disabled}
      onBeforeOpen={() => !composing.current}
      onChange={(value) => {
        if (value !== mode && !composing.current) void onChange();
      }}
    />
  );
}
