import { useEffect, useState } from 'preact/hooks';
import { onToast } from './toast';

/** The "Preview — sample data" strip and the toast. Mounted once, only in sample mode. */
export function SampleChrome() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => onToast(setToast), []);
  return (
    <>
      <p class="sample-banner">Preview — sample data</p>
      {toast && (
        <p class="sample-toast" role="status">
          {toast}
        </p>
      )}
    </>
  );
}
