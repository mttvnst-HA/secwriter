import { useEffect, useRef, useState } from 'react';
import { FAMILY_A } from '../lib/blocks.js';

// Family A targets exposed in the convert menu. Note: `title` is NOT
// included — title conversion is a separate flow (slash menu / delete +
// recreate). The 4 entries shown are always "the OTHER family A types".
const FAMILY_A_LABELS = {
  txt: { label: 'Paragraph', icon: '¶' },
  note: { label: 'Designer Note', icon: '✉' },
  oli: { label: 'Ordered List', icon: 'a.' },
  item: { label: 'List Item', icon: '•' },
  lst: { label: 'List Header', icon: '☰' },
};
const FAMILY_A_ORDER = [...FAMILY_A];

/**
 * BlockGutterMenu — left-gutter popover for converting between Family A
 * block types. Visible only on hover of the parent PmEditableBlock; the
 * parent controls the hover state via its own :hover listener and passes
 * `visible` to this component.
 *
 * Click flow:
 *   onMouseDown(button)   — preventDefault to keep PM focus
 *   onClick(button)       — toggle popover open
 *   onClick(menu item)    — call onConvert(newType); close popover
 *
 * After dispatch, the parent re-focuses the PM EditorView via the block
 * registry (handled in PmEditableBlock — see Task 4 step 2).
 *
 * anchorLeft default = -18 because the editor surface's padding-left is
 * 24px (App.jsx). -22 would leave only 2px clearance from the scroll
 * container edge; -18 leaves 6px which is comfortable for hover targets.
 */
export default function BlockGutterMenu({ currentType, visible, onConvert, anchorLeft = -18 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!visible && !open) return null;

  const targets = FAMILY_A_ORDER.filter(t => t !== currentType);

  return (
    <div ref={ref} style={{ position: 'absolute', left: anchorLeft, top: 4, zIndex: 12 }}>
      <button
        type="button"
        aria-label="Convert block"
        title="Convert block type"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(o => !o)}
        style={{
          width: 14, height: 14, border: '1px solid #cbd5e1',
          borderRadius: 3, backgroundColor: '#ffffff', color: '#64748b',
          fontSize: 11, cursor: 'pointer', padding: 0, lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >&#8645;</button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', left: 18, top: 0, zIndex: 1000,
            backgroundColor: '#ffffff', border: '1px solid #e2e8f0',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            width: 220, padding: '4px 0', overflow: 'hidden',
          }}
        >
          <div style={{
            padding: '6px 12px 4px', fontSize: 10, color: '#94a3b8',
            fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>Turn into</div>
          {targets.map(t => (
            <div
              key={t}
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                onConvert(t);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 12px', cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <span style={{
                width: 24, height: 24, borderRadius: 4, backgroundColor: '#f1f5f9',
                border: '1px solid #e2e8f0', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 700, color: '#475569',
              }}>{FAMILY_A_LABELS[t].icon}</span>
              <span style={{ fontSize: 13, color: '#1e293b' }}>{FAMILY_A_LABELS[t].label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
