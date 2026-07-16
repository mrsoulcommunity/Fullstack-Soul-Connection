import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

async function bootstrap() {
  if (import.meta.env.DEV && !window.soul) {
    const { installDevMock } = await import('./devMock.js');
    installDevMock();
  }
  createRoot(document.getElementById('root')).render(<App />);
}

bootstrap();
