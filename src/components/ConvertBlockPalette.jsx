import { useEffect, useMemo, useRef, useState } from 'react';
import { FAMILY_A } from '../lib/blocks.js';
import { NO_EXFIL_PROPS } from '../lib/no-exfil.js';

// UI labels for the Family A types. Order tracks `FAMILY_A` insertion order
// (Set iteration in JS preserves insertion order, so [...FAMILY_A] gives
// the same sequence as the source definition in src/lib/blocks.js).
const FAMILY_A_ENTRIES = [
  { type: 'txt', label: 'Paragraph', icon: '¶' },
  { type: 'note', label: 'Designer Note', icon: '✉' },
  { type: 'oli', label: 'Ordered List', icon: 'a.' },
  { type: 'item', label: 'List Item', icon: '•' },
  { type: 'lst', label: 'List Header', icon: '☰' },
];

// Verify FAMILY_A_ENTRIES aligns with the canonical set at import time.
// This is a DEV-only guard; it does not affect runtime behavior.
if (import.meta.env.DEV) {
  const entryTypes = new Set(FAMILY_A_ENTRIES.map(e => e.type));
  for (const t of FAMILY_A) {
    if (!entryTypes.has(t)) {
      console.warn(`[ConvertBlockPalette] FAMILY_A type "${t}" has no UI entry — add it to FAMILY_A_ENTRIES`);
    }
  }
}

/**
 * ConvertBlockPalette — floating filterable list opened by Ctrl+Shift+M
 * when focus is in a Family A block. Caret preservation: the parent
 * (App) captures the PM selection BEFORE opening; on close (Esc or
 * selection) the parent restores it via the block-registry view handle.
 *
 * Props:
 *   currentType, anchorRect (DOMRect | null), onConvert(newType), onClose
 */
export default function ConvertBlockPalette({ currentType, anchorRect, onConvert, onClose }) {
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  // Exclude the currentType, then filter by typed prefix.
  const items = useMemo(() => {
    const q = filter.toLowerCase();
    return FAMILY_A_ENTRIES
      .filter(e => e.type !== currentType)
      .filter(e => !q || e.label.toLowerCase().startsWith(q));
  }, [filter, currentType]);

  // Clamp selection on filter changes.
  useEffect(() => {
    setSelectedIdx(prev => Math.min(prev, Math.max(items.length - 1, 0)));
  }, [items.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on outside click.
  useEffect(() => {
    const onDocClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  const top = anchorRect ? anchorRect.top + 24 : 80;
  const left = anchorRect ? Math.max(8, anchorRect.left) : 80;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Convert block type"
      style={{
        position: 'fixed', top, left, zIndex: 2000,
        backgroundColor: '#ffffff', border: '1px solid #cbd5e1',
        borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
        width: 260, padding: 6,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="Convert to…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        {...NO_EXFIL_PROPS}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const choice = items[selectedIdx];
            if (choice) onConvert(choice.type);
          }
        }}
        style={{
          width: '100%', padding: '6px 8px', border: '1px solid #e2e8f0',
          borderRadius: 4, fontSize: 13, outline: 'none', boxSizing: 'border-box',
        }}
      />
      <div style={{ marginTop: 4, maxHeight: 220, overflowY: 'auto' }}>
        {items.length === 0 && (
          <div style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>No matches</div>
        )}
        {items.map((item, i) => (
          <div
            key={item.type}
            role="option"
            aria-selected={i === selectedIdx}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onConvert(item.type)}
            onMouseEnter={() => setSelectedIdx(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 8px', cursor: 'pointer', borderRadius: 4,
              backgroundColor: i === selectedIdx ? '#f1f5f9' : 'transparent',
            }}
          >
            <span style={{
              width: 24, height: 24, borderRadius: 4, backgroundColor: '#f1f5f9',
              border: '1px solid #e2e8f0', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 700, color: '#475569',
            }}>{item.icon}</span>
            <span style={{ fontSize: 13, color: '#1e293b' }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
