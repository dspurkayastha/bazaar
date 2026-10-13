/** A one-line toast channel for sample mode ("Preview only"). The component that shows it is sample/Chrome.tsx. */
type Listener = (text: string | null) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | undefined;

export const PREVIEW_ONLY = 'Preview only';

export function showToast(text: string = PREVIEW_ONLY, ms = 2200): void {
  listeners.forEach((l) => l(text));
  clearTimeout(timer);
  timer = setTimeout(() => listeners.forEach((l) => l(null)), ms);
}

export function onToast(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
