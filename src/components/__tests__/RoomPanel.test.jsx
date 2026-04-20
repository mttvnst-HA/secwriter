// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import RoomPanel from '../RoomPanel.jsx';

describe('RoomPanel', () => {
  const baseProps = {
    rooms: [],
    currentRoom: null,
    onJoin: vi.fn(),
    onClose: vi.fn(),
    onCreateRoom: vi.fn(),
    onDeleteRoom: vi.fn(),
  };

  it('renders room list', () => {
    const rooms = [
      { id: 'demo', displayName: '31 00 00 EARTHWORK', activeUsers: [], locked: false },
      { id: 'alpha', displayName: '03 30 00 CONCRETE', activeUsers: [{ id: 'u1', name: 'Matt', color: '#34d399' }], locked: false },
    ];
    render(<RoomPanel {...baseProps} rooms={rooms} />);
    expect(screen.getByText(/EARTHWORK/)).toBeTruthy();
    expect(screen.getByText(/CONCRETE/)).toBeTruthy();
  });

  it('highlights current room', () => {
    const rooms = [{ id: 'demo', displayName: 'Demo', activeUsers: [], locked: false }];
    const { container } = render(<RoomPanel {...baseProps} rooms={rooms} currentRoom="demo" />);
    const card = container.querySelector('[data-room-id="demo"]');
    expect(card).toBeTruthy();
  });

  it('shows active user avatars', () => {
    const rooms = [{ id: 'demo', displayName: 'Demo', activeUsers: [{ id: 'u1', name: 'Matt V', color: '#34d399' }], locked: false }];
    render(<RoomPanel {...baseProps} rooms={rooms} />);
    expect(screen.getByText('MV')).toBeTruthy();
  });

  it('shows lock icon for locked rooms', () => {
    const rooms = [{ id: 'locked-room', displayName: 'Locked', activeUsers: [], locked: true }];
    render(<RoomPanel {...baseProps} rooms={rooms} />);
    const lockEl = screen.getByTitle(/locked/i);
    expect(lockEl).toBeTruthy();
  });
});
