import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { registerSW } from 'virtual:pwa-register';

// Register the service worker for PWA offline support safely
try {
  const updateSW = registerSW({
    onNeedRefresh() {
      // Silently wait for the next app restart to apply updates.
      // Do not use window.confirm as it blocks the UI thread and causes issues on iOS.
      console.log('New content available. It will be used when the app is restarted.');
    },
    onOfflineReady() {
      console.log('App is ready to work offline');
    },
  });
} catch (error) {
  console.warn('Service worker registration failed (expected in cross-origin iframe):', error);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
