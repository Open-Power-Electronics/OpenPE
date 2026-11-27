import { child, children, type SExpr } from './sexpr';
import {
  maxPCBTeardropParameter,
  pcbTeardropDimensionFields as dimensions,
  pcbTeardropOptionFields as options,
} from './pcb-teardrop-settings';
export type PCBTeardropSettings = Partial<
  Record<keyof typeof dimensions, number> & Record<keyof typeof options, boolean>
>;
export type PCBTeardropKind = 'padvia' | 'track_end';

export function readPCBTeardropSettings(
  owner: SExpr,
  fail: (message: string) => never,
): PCBTeardropSettings | undefined {
  const records = children(owner, 'teardrops');
  if (!records.length) return undefined;
  const [record] = records;
  if (records.length !== 1 || record.length < 2) return fail('Invalid teardrop settings.');
  const settings: PCBTeardropSettings = {};
  const remaining = new Set(record.slice(1));
  for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) {
    const field = child(record, dimensions[key]);
    if (!field) continue;
    const value = field[1];
    const number = Number(value);
    if (
      field.length !== 2 ||
      typeof value !== 'string' ||
      !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(number) ||
      number > maxPCBTeardropParameter
    )
      return fail(`Invalid teardrop ${dimensions[key]}.`);
    settings[key] = number;
    remaining.delete(field);
  }
  for (const key of Object.keys(options) as (keyof typeof options)[]) {
    const field = child(record, options[key]);
    if (!field) continue;
    const value = field[1];
    if (field.length !== 2 || (value !== 'yes' && value !== 'no'))
      return fail(`Invalid teardrop ${options[key]}.`);
    settings[key] = value === 'yes';
    remaining.delete(field);
  }
  if (remaining.size) return fail('Teardrop settings contain an unsupported or duplicate field.');
  return settings;
}

export function writePCBTeardropSettings(settings: PCBTeardropSettings | undefined): string {
  if (!settings) return '';
  const fields: string[] = [];
  for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) {
    if (settings[key] !== undefined) fields.push(`(${dimensions[key]} ${settings[key]})`);
  }
  for (const key of Object.keys(options) as (keyof typeof options)[]) {
    if (settings[key] !== undefined)
      fields.push(`(${options[key]} ${settings[key] ? 'yes' : 'no'})`);
  }
  return fields.length ? `(teardrops ${fields.join(' ')})` : '';
}

export function readPCBTeardropKind(
  zone: SExpr,
  fail: (message: string) => never,
): PCBTeardropKind | undefined {
  const records = children(zone, 'attr');
  if (!records.length) return undefined;
  const [record] = records;
  const teardrop = child(record, 'teardrop');
  const type = child(teardrop ?? [], 'type');
  const value = type?.[1];
  if (
    records.length !== 1 ||
    record.length !== 2 ||
    teardrop?.length !== 2 ||
    type?.length !== 2 ||
    (value !== 'padvia' && value !== 'track_end')
  )
    return fail('Unsupported PCB zone attribute.');
  return value;
}
