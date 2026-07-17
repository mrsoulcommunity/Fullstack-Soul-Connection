import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

const MARGIN = 8;

function clampPosition(x, y, width, height) {
  const { innerWidth, innerHeight } = window;
  // Prefer opening to the bottom-right of the cursor; flip to whichever side
  // actually has room instead of letting the menu run off the viewport.
  const flipX = x + width > innerWidth - MARGIN;
  const flipY = y + height > innerHeight - MARGIN;
  let left = flipX ? x - width : x;
  let top = flipY ? y - height : y;
  left = Math.max(MARGIN, Math.min(left, innerWidth - width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, innerHeight - height - MARGIN));
  const origin = `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`;
  return { left, top, origin };
}

// Generic right-click menu. items: [{ icon, label, onClick, danger?, disabled?, sepBefore? }]
export default function ContextMenu({ x, y, title, items, onClose }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, origin: 'top left', ready: false });

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Measure the menu after it mounts (its real size depends on the item
  // list/title) and only then place it, so it never flashes off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const reposition = () => {
      // offsetWidth/offsetHeight (unlike getBoundingClientRect) ignore the
      // mount-in CSS transform (scale(0.95) -> scale(1)), so sizing here
      // isn't thrown off by measuring mid-animation.
      setPos({ ...clampPosition(x, y, el.offsetWidth, el.offsetHeight), ready: true });
    };
    reposition();
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [x, y, items]);

  return (
    <div className="ctx-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={menuRef}
        className="ctx-menu"
        style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin, visibility: pos.ready ? 'visible' : 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="ctx-title">{title}</div>}
        {items.map((item, i) => (
          <React.Fragment key={i}>
            {item.sepBefore && <div className="ctx-sep" />}
            <button
              className={`ctx-item ${item.danger ? 'danger' : ''}`}
              disabled={item.disabled}
              onClick={() => { item.onClick(); onClose(); }}
            >
              <Icon name={item.icon} size={13} /> {item.label}
            </button>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
