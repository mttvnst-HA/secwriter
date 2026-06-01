import { useState, useRef, useEffect } from "react";
import { NO_EXFIL_PROPS } from "../lib/no-exfil.js";

/**
 * Get the current author name from localStorage, or null if not set.
 */
export function getAuthorName() {
  return localStorage.getItem('sim-comment-author') || null;
}

/**
 * Set the author name in localStorage.
 */
export function setAuthorName(name) {
  localStorage.setItem('sim-comment-author', name);
}

// Approx. card height reserved when clamping the popup to the viewport.
const POPUP_CARD_HEIGHT = 300;
const POPUP_MIN_TOP = 8;

/**
 * Pure vertical-position calc for the comment popup, given its comment span's
 * viewport rect (from getBoundingClientRect) and the editor text pane's
 * viewport bounds (paneTop = ribbon bottom edge, paneBottom = status-bar top
 * edge). The card is clamped to the pane — it never floats over the toolbar
 * ribbon or below the bottom bar. Returns { top, hidden }; `hidden` is true
 * when the span has scrolled out of the pane so the caller hides the card
 * instead of pinning it to a pane edge.
 */
export function computeCommentPopupPosition(rect, paneTop, paneBottom) {
  const minTop = Math.max(paneTop, POPUP_MIN_TOP);
  const maxTop = Math.max(paneBottom - POPUP_CARD_HEIGHT, minTop);
  if (!rect) return { top: Math.min(Math.max(200, minTop), maxTop), hidden: false };
  const top = Math.min(Math.max(rect.top, minTop), maxTop);
  const hidden = rect.bottom <= paneTop || rect.top >= paneBottom;
  return { top, hidden };
}

/**
 * Generate initials from a name (e.g. "John Smith" → "JS")
 */
function getInitials(name) {
  if (!name) return "?";
  return name.split(/\s+/).map(w => w[0]?.toUpperCase() || "").join("").slice(0, 2);
}

/**
 * Avatar circle with initials
 */
function Avatar({ name, color, size = 28 }) {
  const colors = ["#4285f4", "#ea4335", "#fbbc04", "#34a853", "#8e24aa", "#e67c73"];
  const colorIdx = (name || "").split("").reduce((s, c) => s + c.charCodeAt(0), 0) % colors.length;
  const bg = color || colors[colorIdx];
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      backgroundColor: bg,
      color: "white", fontSize: size * 0.4, fontWeight: 600,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      {getInitials(name)}
    </div>
  );
}

// Read the editor text-pane bounds (the scroll viewport) in viewport coords.
// Falls back to the full window when the ref isn't wired (e.g. unit tests).
function readPaneBounds(paneRef) {
  const el = paneRef?.current;
  if (el && typeof el.getBoundingClientRect === 'function') {
    const r = el.getBoundingClientRect();
    return [r.top, r.bottom];
  }
  return [0, typeof window !== 'undefined' ? window.innerHeight : 0];
}

export default function CommentPopup({ comment, rect, onReply, onResolve, onReopen, onDelete, onClose, onUpdateCreate, editorRef, paneRef }) {
  const isNewComment = comment.entries.length === 1 && comment.entries[0].type === "create" && !comment.entries[0].text;
  const [replyText, setReplyText] = useState("");
  const [createText, setCreateText] = useState("");
  const [authorName, setAuthorLocal] = useState(getAuthorName() || "");
  const [showAuthorInput, setShowAuthorInput] = useState(!getAuthorName());
  const createInputRef = useRef(null);
  const popupRef = useRef(null);

  // Submitted comments persist on de-select — only the "hide comment
  // highlights" toggle closes them (issue #195 follow-up). Only the
  // unsubmitted draft composer dismisses on outside click, discarding an
  // empty draft so it never floats with no way to cancel.
  useEffect(() => {
    if (!isNewComment) return;
    const dismiss = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        if (!createText.trim()) {
          onDelete(comment.id);
        }
        onClose();
      }
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [onClose, isNewComment, createText, comment.id, onDelete]);

  useEffect(() => {
    if (!showAuthorInput && isNewComment) createInputRef.current?.focus();
  }, [isNewComment, showAuthorInput]);

  // Active-highlight styling:
  // - PM-mounted editable blocks: `activeCommentPlugin` emits an inline
  //   decoration with class 'mark-comment-active' over the matching mark
  //   range. App.jsx calls `setActiveComment(view, commentId)` via
  //   block-registry. See src/lib/pm-plugins/active-comment.js.
  // - RefBlock / TableBlock: render `data-active="true"` from the
  //   `activeCommentId` prop directly in JSX (see renderCellContent /
  //   renderWithCommentMarks). CSS uses `[data-active="true"]` selector.

  const handleSaveAuthor = () => {
    if (!authorName.trim()) return;
    setAuthorName(authorName.trim());
    setShowAuthorInput(false);
  };

  const handleCreateSubmit = () => {
    if (!createText.trim()) return;
    onUpdateCreate(comment.id, createText.trim());
    setCreateText("");
  };

  const handleReply = () => {
    if (!replyText.trim()) return;
    onReply(comment.id, replyText.trim());
    setReplyText("");
  };

  const isResolved = comment.status === "resolved";

  // Position: track the comment span on scroll/resize so the card stays aligned
  // with its highlighted text instead of freezing at the open-time viewport top.
  const [pos, setPos] = useState(() => {
    const [pt, pb] = readPaneBounds(paneRef);
    return computeCommentPopupPosition(rect, pt, pb);
  });
  useEffect(() => {
    let raf = 0;
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape : (s) => s;
    const recompute = () => {
      raf = 0;
      const el = document.querySelector(`[data-comment-id="${esc(comment.id)}"]`);
      const r = el ? el.getBoundingClientRect() : rect;
      const [pt, pb] = readPaneBounds(paneRef);
      setPos(computeCommentPopupPosition(r, pt, pb));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(recompute); };
    recompute();
    // Capture phase so the editor's inner scroll container is also observed.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [comment.id, rect]);

  const cardStyle = {
    position: "fixed",
    top: pos.top,
    display: pos.hidden ? "none" : undefined,
    right: 16,
    width: 280,
    background: "white",
    borderRadius: 8,
    boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.06)",
    border: "1px solid #dadce0",
    zIndex: 200,
    fontSize: 13,
    lineHeight: 1.5,
    overflow: "hidden",
  };

  // Author name prompt
  if (showAuthorInput) {
    return (
      <div ref={popupRef} data-test="comment-popup" style={{ ...cardStyle, padding: 16 }}>
        <div style={{ fontWeight: 500, marginBottom: 8, color: "#202124" }}>Enter your name</div>
        <div style={{ fontSize: 11, color: "#5f6368", marginBottom: 8 }}>Used for all your comments.</div>
        <div style={{ display: "flex", gap: 4 }}>
          <input
            autoFocus
            type="text"
            value={authorName}
            onChange={(e) => setAuthorLocal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSaveAuthor(); } }}
            placeholder="Your name..."
            {...NO_EXFIL_PROPS}
            style={{
              flex: 1, padding: "6px 8px", border: "1px solid #dadce0",
              borderRadius: 4, fontSize: 13, outline: "none",
            }}
          />
          <button
            onClick={handleSaveAuthor}
            disabled={!authorName.trim()}
            style={{
              border: "none", background: "#1a73e8", color: "white",
              fontSize: 12, borderRadius: 4, padding: "6px 12px", cursor: "pointer",
              opacity: authorName.trim() ? 1 : 0.5,
            }}
          >Save</button>
        </div>
      </div>
    );
  }

  // New comment — prompt for text
  if (isNewComment) {
    return (
      <div ref={popupRef} data-test="comment-popup" style={{ ...cardStyle, padding: 12 }}>
        <textarea
          ref={createInputRef}
          value={createText}
          onChange={(e) => setCreateText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleCreateSubmit(); } }}
          placeholder="Add a comment..."
          rows={2}
          {...NO_EXFIL_PROPS}
          style={{
            width: "100%", padding: "8px", border: "none", outline: "none",
            fontSize: 13, resize: "none", fontFamily: "inherit", boxSizing: "border-box",
            borderBottom: "1px solid #dadce0",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 0 0" }}>
          <button
            onClick={() => { onDelete(comment.id); onClose(); }}
            style={{
              border: "none", background: "transparent", color: "#5f6368",
              fontSize: 13, cursor: "pointer", padding: "4px 12px", borderRadius: 4,
            }}
          >Cancel</button>
          <button
            onClick={handleCreateSubmit}
            disabled={!createText.trim()}
            style={{
              border: "none", background: createText.trim() ? "#1a73e8" : "#e8eaed",
              color: createText.trim() ? "white" : "#80868b",
              fontSize: 13, borderRadius: 4, padding: "4px 16px", cursor: "pointer",
            }}
          >Comment</button>
        </div>
      </div>
    );
  }

  // Existing comment — Google Docs style card
  return (
    <div ref={popupRef} data-test="comment-popup" style={cardStyle}>
      {/* Thread entries */}
      <div style={{ padding: "12px 12px 0" }}>
        {comment.entries.map((entry, i) => {
          const name = entry.authorName;
          const color = entry.authorColor;
          const ts = entry.ts;
          return (
            <div key={i} style={{ marginBottom: 12 }}>
              {entry.type === "resolve" ? (
                <div style={{ fontSize: 12, color: "#188038", display: "flex", alignItems: "center", gap: 6 }}>
                  <Avatar name={name} color={color} size={20} />
                  <span><strong>{name}</strong> marked as resolved</span>
                </div>
              ) : entry.type === "reopen" ? (
                <div style={{ fontSize: 12, color: "#b06000", display: "flex", alignItems: "center", gap: 6 }}>
                  <Avatar name={name} color={color} size={20} />
                  <span><strong>{name}</strong> reopened</span>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Avatar name={name} color={color} />
                    <div>
                      <div style={{ fontWeight: 500, color: "#202124", fontSize: 13 }}>{name}</div>
                      <div style={{ fontSize: 11, color: "#5f6368" }}>
                        {ts ? new Date(ts).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }) : ""}
                        {" "}
                        {ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ""}
                      </div>
                    </div>
                    {i === 0 && (
                      <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                        {isResolved ? (
                          <button onClick={() => onReopen(comment.id)} title="Reopen"
                            style={{ border: "none", background: "transparent", color: "#5f6368", cursor: "pointer", fontSize: 16, padding: 2 }}>&#x21BA;</button>
                        ) : (
                          <button onClick={() => onResolve(comment.id)} title="Resolve"
                            style={{ border: "none", background: "transparent", color: "#1a73e8", cursor: "pointer", fontSize: 16, padding: 2 }}>&#x2713;</button>
                        )}
                        <button onClick={() => onDelete(comment.id)} title="Delete"
                          style={{ border: "none", background: "transparent", color: "#d93025", cursor: "pointer", fontSize: 16, padding: 2, fontWeight: 600 }}>&#x2715;</button>
                      </div>
                    )}
                  </div>
                  <div style={{ marginTop: 4, marginLeft: 36, color: "#202124", wordBreak: "break-word" }}>{entry.text}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Reply form */}
      {!isResolved && (
        <div style={{ borderTop: "1px solid #dadce0", padding: "8px 12px", display: "flex", gap: 4 }}>
          <input
            type="text"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleReply(); } }}
            placeholder="Reply..."
            {...NO_EXFIL_PROPS}
            style={{
              flex: 1, padding: "6px 8px", border: "1px solid #dadce0",
              borderRadius: 20, fontSize: 12, outline: "none",
            }}
          />
          {replyText.trim() && (
            <button onClick={handleReply} style={{
              border: "none", background: "#1a73e8", color: "white",
              fontSize: 11, borderRadius: 20, padding: "4px 12px", cursor: "pointer",
            }}>Reply</button>
          )}
        </div>
      )}
    </div>
  );
}
