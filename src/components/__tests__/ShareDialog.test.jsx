// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import ShareDialog from '../ShareDialog.jsx';

describe('ShareDialog (#239)', () => {
  afterEach(cleanup);

  // Stateful fake mirroring the server: mutations return the evolving roles
  // map so the UI keeps the untouched rows (a fixed return would wipe them).
  const makeProps = (over = {}) => {
    const roles = { ed: 'editor', vi: 'viewer' };
    return {
      roomId: 'r1',
      loadAcl: vi.fn(async () => ({ ownerId: 'owner', roles: { ...roles } })),
      submitShare: vi.fn(async (_room, { userId, action, role }) => {
        if (action === 'add') roles[userId] = role || 'editor'; else delete roles[userId];
        return { roles: { ...roles } };
      }),
      onClose: vi.fn(),
      ...over,
    };
  };

  it('loads and lists owner + graded collaborators', async () => {
    const props = makeProps();
    render(<ShareDialog {...props} />);
    await waitFor(() => expect(props.loadAcl).toHaveBeenCalledWith('r1'));
    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText('ed')).toBeTruthy();
    expect(screen.getByText('vi')).toBeTruthy();
    // Each collaborator's current role is reflected in its select.
    expect(screen.getByLabelText('Role for ed').value).toBe('editor');
    expect(screen.getByLabelText('Role for vi').value).toBe('viewer');
  });

  it('adds a collaborator with the chosen role, changes a role, and removes one', async () => {
    const props = makeProps();
    render(<ShareDialog {...props} />);
    await waitFor(() => expect(props.loadAcl).toHaveBeenCalled());

    // Add as viewer.
    fireEvent.change(screen.getByPlaceholderText(/Collaborator subject id/), { target: { value: 'newbie' } });
    fireEvent.change(screen.getByLabelText('New collaborator role'), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByText('Add').closest('button'));
    await waitFor(() => expect(props.submitShare).toHaveBeenCalledWith('r1', { userId: 'newbie', action: 'add', role: 'viewer' }));

    // Change ed's role to viewer (upsert via add).
    fireEvent.change(screen.getByLabelText('Role for ed'), { target: { value: 'viewer' } });
    await waitFor(() => expect(props.submitShare).toHaveBeenCalledWith('r1', { userId: 'ed', action: 'add', role: 'viewer' }));

    // Remove vi.
    fireEvent.click(screen.getByLabelText('Role for vi').parentElement.querySelector('button'));
    await waitFor(() => expect(props.submitShare).toHaveBeenCalledWith('r1', { userId: 'vi', action: 'remove' }));
  });

  it('surfaces a load error and does not crash', async () => {
    const props = makeProps({ loadAcl: vi.fn(async () => { throw new Error('Room not found'); }) });
    render(<ShareDialog {...props} />);
    await waitFor(() => expect(screen.getByText('Room not found')).toBeTruthy());
  });
});
