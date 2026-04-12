import { useState } from 'react';
import { X, Plus, Lock, Trash2, Users } from 'lucide-react';
import { initialsFor } from '../lib/identity.js';

export default function RoomPanel({
  rooms,
  currentRoom,
  onJoin,
  onClose,
  onCreateRoom,
  onDeleteRoom,
  onLockRoom,
  currentUserId,
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');

  const handleCreate = () => {
    const sanitized = newName.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!sanitized) return;
    onCreateRoom(sanitized);
    setNewName('');
    setShowCreate(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleCreate();
    if (e.key === 'Escape') { setShowCreate(false); setNewName(''); }
  };

  return (
    <div style={{
      width: 320,
      borderLeft: '1px solid #e2e8f0',
      backgroundColor: '#f8fafc',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px',
        borderBottom: '1px solid #e2e8f0',
        backgroundColor: '#fff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Users size={16} style={{ color: '#64748b' }} />
          <span style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>Rooms</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={() => setShowCreate(!showCreate)}
            title="Create room"
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              color: '#64748b',
            }}
          >
            <Plus size={16} />
          </button>
          <button
            onClick={onClose}
            title="Close panel"
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              color: '#64748b',
            }}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          gap: 6,
        }}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Room name..."
            style={{
              flex: 1,
              border: '1px solid #cbd5e1',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 12,
              outline: 'none',
            }}
            autoFocus
          />
          <button
            onClick={handleCreate}
            style={{
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Create
          </button>
        </div>
      )}

      {/* Room list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {rooms.length === 0 && (
          <div style={{
            padding: '24px 16px',
            textAlign: 'center',
            color: '#94a3b8',
            fontSize: 12,
          }}>
            No rooms yet. Click + to create one.
          </div>
        )}
        {rooms.map((room) => {
          const isCurrent = room.id === currentRoom;
          return (
            <div
              key={room.id}
              data-room-id={room.id}
              onClick={() => onJoin(room.id)}
              style={{
                padding: '8px 12px',
                margin: '0 8px 4px',
                borderRadius: 6,
                cursor: 'pointer',
                borderLeft: isCurrent ? '3px solid #3b82f6' : '3px solid transparent',
                backgroundColor: isCurrent ? '#eff6ff' : '#fff',
                border: isCurrent ? undefined : '1px solid #e2e8f0',
                borderLeftWidth: 3,
                borderLeftStyle: 'solid',
                borderLeftColor: isCurrent ? '#3b82f6' : 'transparent',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {/* Top row: name + lock/delete */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#1e293b',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}>
                  {room.displayName}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4, flexShrink: 0 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); onLockRoom(room.id, !room.locked); }}
                    title={room.locked ? `Locked by ${room.lockedByName || 'unknown'} — click to unlock` : 'Lock room'}
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      padding: 2,
                      display: 'flex',
                      alignItems: 'center',
                      color: room.locked ? '#f59e0b' : '#94a3b8',
                      opacity: room.locked ? 1 : 0.6,
                    }}
                  >
                    <Lock size={12} />
                  </button>
                  {!isCurrent && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteRoom(room.id); }}
                      title="Delete room"
                      style={{
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        padding: 2,
                        display: 'flex',
                        alignItems: 'center',
                        color: '#94a3b8',
                        opacity: 0.6,
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Bottom row: users + lastModified */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 2 }}>
                  {room.activeUsers.map((u) => (
                    <span
                      key={u.id}
                      title={u.name}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        backgroundColor: u.color,
                        color: '#fff',
                        fontSize: 9,
                        fontWeight: 700,
                      }}
                    >
                      {initialsFor(u.name)}
                    </span>
                  ))}
                </div>
                {room.lastModified && (
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>
                    {new Date(room.lastModified).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
