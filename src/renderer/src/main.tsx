import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BridgeApi } from '@shared/types';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { App } from './App';

declare global {
  interface Window {
    api: BridgeApi;
    menu: { onCommand(listener: (command: string) => void): () => void };
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
