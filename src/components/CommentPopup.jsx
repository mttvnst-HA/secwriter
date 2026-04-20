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

/**
 * Extract the displayable name and color for a comment entry.
 * Prefers the new identity-based fields (authorName/authorColor) from
 * room-based comments but falls back to the legacy `author` string for
 * single-user / pre-identity comments.
 */
function resolveEntryAuthor(entry) {
  return {
    name: entry.authorName || entry.author || 'User',
    color: entry.authorColor || null,
  };
}

/**
 * Extract the display timestamp for an entry. Prefers the new `ts`
 * (number) field, falls back to legacy `timestamp` (ISO string).
 */
function resolveEntryTs(entry) {
  if (typeof entry.ts === 'number') return entry.ts;
  if (entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export default function CommentPopup({ comment, rect, onReply, onResolve, onReopen, onDelete, onClose, onUpdateCreate, editorRef }) {
  const isNewComment = comment.entries.length === 1 && comment.entries[0].type === "create" && !comment.entries[0].text;
  const [replyText, setReplyText] = useState("");
  const [createText, setCreateText] = useState("");
  const [authorName, setAuthorLocal] = useState(getAuthorName() || "");
  const [showAuthorInput, setShowAuthorInput] = useState(!getAuthorName());
  const createInputRef = useRef(null);
  const popupRef = useRef(null);

  useEffect(() => {
    const dismiss = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        if (isNewComment && !createText.trim()) {
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

  // Activate highlight on the comment span
  useEffect(() => {
    const el = document.querySelector(`[data-comment-id="${comment.id}"]`);
    if (el && !el.className.includes('resolved')) {
      el.className = "mark-comment-active";
      return () => { el.className = comment.status === "resolved" ? "mark-comment-resolved" : "mark-comment"; };
    }
  }, [comment.id, comment.status]);

  const handleSaveAuthor = () => {
    if (!authorName.trim()) return;
    setAuthorName(authorName.trim());
    setShowAuthorInput(false);
  };

  const handleCreateSubmit = () => {
    if (!createText.trim()) return;
    onUpdateCreate(comment.id, createText.trim(), getAuthorName() || "User");
    setCreateText("");
  };

  const handleReply = () => {
    if (!replyText.trim()) return;
    onReply(comment.id, replyText.trim(), getAuthorName() || "User");
    setReplyText("");
  };

  const isResolved = comment.status === "resolved";

  // Position: align vertically with the highlighted text, in the right margin
  const topPos = rect ? rect.top : 200;

  const cardStyle = {
    position: "fixed",
    top: Math.min(topPos, window.innerHeight - 300),
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
      <div ref={popupRef} style={{ ...cardStyle, padding: 16 }}>
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
      <div ref={popupRef} style={{ ...cardStyle, padding: 12 }}>
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
    <div ref={popupRef} style={cardStyle}>
      {/* Thread entries */}
      <div style={{ padding: "12px 12px 0" }}>
        {comment.entries.map((entry, i) => {
          const a = resolveEntryAuthor(entry);
          const ts = resolveEntryTs(entry);
          return (
            <div key={i} style={{ marginBottom: 12 }}>
              {entry.type === "resolve" ? (
                <div style={{ fontSize: 12, color: "#188038", display: "flex", alignItems: "center", gap: 6 }}>
                  <Avatar name={a.name} color={a.color} size={20} />
                  <span><strong>{a.name}</strong> marked as resolved</span>
                </div>
              ) : entry.type === "reopen" ? (
                <div style={{ fontSize: 12, color: "#b06000", display: "flex", alignItems: "center", gap: 6 }}>
                  <Avatar name={a.name} color={a.color} size={20} />
                  <span><strong>{a.name}</strong> reopened</span>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Avatar name={a.name} color={a.color} />
                    <div>
                      <div style={{ fontWeight: 500, color: "#202124", fontSize: 13 }}>{a.name}</div>
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
