import { render } from 'preact';
import { App } from './app';
// Fonts are bundled and served from our own origin: the server's CSP allows no third-party hosts.
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource/noto-sans-bengali/400.css';
import '@fontsource/noto-sans-bengali/600.css';
import '@fontsource/noto-sans-devanagari/400.css';
import '@fontsource/noto-sans-devanagari/600.css';
import './styles.css';

render(<App />, document.getElementById('root')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
