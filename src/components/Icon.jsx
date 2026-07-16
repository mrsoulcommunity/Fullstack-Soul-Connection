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
