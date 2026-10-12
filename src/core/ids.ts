import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

/** New ULID (monotonic within a process). Optional prefix for readability, e.g. newId('q') → 'q_01J…'. */
export function newId(prefix?: string): string {
  const id = next();
  return prefix ? `${prefix}_${id}` : id;
}

const ULID_RE = /^(?:[a-z]+_)?[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: string): boolean {
  return ULID_RE.test(value);
}
