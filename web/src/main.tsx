import { render } from 'preact';
import { App } from './app';
import './styles.css';

render(<App />, document.getElementById('root')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
