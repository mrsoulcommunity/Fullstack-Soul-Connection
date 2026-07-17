import React from 'react';

// A small, consistent line-icon set (2px stroke, rounded caps) so the app
// doesn't lean on inconsistent platform emoji rendering for its controls.
const PATHS = {
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 13a7.4 7.4 0 0 0 .1-1 7.4 7.4 0 0 0-.1-1l1.9-1.5a.6.6 0 0 0 .1-.8l-1.8-3a.6.6 0 0 0-.7-.3l-2.2.9a7.2 7.2 0 0 0-1.7-1L14.6 3a.6.6 0 0 0-.6-.5h-3.6a.6.6 0 0 0-.6.5l-.4 2.3a7.2 7.2 0 0 0-1.7 1l-2.2-.9a.6.6 0 0 0-.7.3l-1.8 3a.6.6 0 0 0 .1.8L4.6 11a7.4 7.4 0 0 0 0 2l-1.9 1.5a.6.6 0 0 0-.1.8l1.8 3a.6.6 0 0 0 .7.3l2.2-.9a7.2 7.2 0 0 0 1.7 1l.4 2.3a.6.6 0 0 0 .6.5h3.6a.6.6 0 0 0 .6-.5l.4-2.3a7.2 7.2 0 0 0 1.7-1l2.2.9a.6.6 0 0 0 .7-.3l1.8-3a.6.6 0 0 0-.1-.8L19.4 13Z',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  plus: 'M12 5v14M5 12h14',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  chevron: 'M6 9l6 6 6-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  signal: 'M4 20v-3M9 20v-7M14 20v-11M19 20V4',
  arrowDown: 'M12 4v14M6 12l6 6 6-6',
  arrowUp: 'M12 20V6M6 12l6-6 6 6',
  wifi: 'M5 12.55a11 11 0 0 1 14.08 0 M1.42 9a16 16 0 0 1 21.16 0 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01',
  database: 'M3 5c0-1.66 4-3 9-3s9 1.34 9 3-4 3-9 3-9-1.34-9-3Z M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5 M3 12c0 1.66 4 3 9 3s9-1.34 9-3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  sliders: 'M4 21V14 M4 10V3 M12 21V12 M12 8V3 M20 21V16 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M12 16v-4 M12 8h.01',
  power: 'M12 3v9 M18.36 6.64a9 9 0 1 1-12.72 0',
  star: 'M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8L12 3Z',
  play: 'M7 4.5v15l12-7.5L7 4.5Z',
  pause: 'M8.5 5v14 M15.5 5v14',
  stop: 'M6.5 6.5h11v11h-11Z',
  filter: 'M4 5h16 M7 12h10 M10 19h4',
  gauge: 'M20.5 17a9.5 9.5 0 1 0-17 0 M12 13.5l4.2-4.7 M12 13.5h.01',
  target: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M12 12h.01',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.8-6.3 M3.5 4.5V9H8 M12 7.5V12l3 3',
  check: 'M4.5 12.5l5 5 10-11',
  edit: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  copy: 'M9 9h11v11H9Z M5 15V5a1 1 0 0 1 1-1h9',
  radar: 'M16.2 12a4.2 4.2 0 1 1-1.23-2.97 M21.2 8A10 10 0 1 1 16 2.9 M12 12l7-7',
  winMinimize: 'M5 12.5h14',
  winMaximize: 'M6 6h12v12H6Z',
  winRestore: 'M9 6h8v8h-8Z M6 9h8v8H6Z',
  qrcode: 'M3 3h7v7H3V3Z M14 3h7v7h-7V3Z M3 14h7v7H3v-7Z M14 14h3v3h-3v-3Z M18 14h3v3h-3v-3Z M14 18h3v3h-3v-3Z M18 18h3v3h-3v-3Z M6 6h1v1H6V6Z M17 6h1v1h-1V6Z M6 17h1v1H6v-1Z',
  download: 'M12 3v13 M7 12l5 5 5-5 M4 21h16',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M3 3l18 18 M10.6 5.2A11 11 0 0 1 12 5c7 0 11 7 11 7a17.6 17.6 0 0 1-3.2 4 M6.5 6.6C3.4 8.5 1 12 1 12s4 7 11 7c1.4 0 2.7-.3 3.9-.7 M9.9 9.9a3 3 0 0 0 4.2 4.2',
};

export default function Icon({ name, size = 16, strokeWidth = 2, className = '' }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      className={`icon icon-${name} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
