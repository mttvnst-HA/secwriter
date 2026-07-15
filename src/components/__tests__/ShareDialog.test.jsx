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

  it('#267: email add routes to the email branch and refreshes', async () => {
    const loadAcl = vi.fn(async () => ({ ownerId: 'owner', roles: {}, pending: {}, display: {} }));
    const submitShare = vi.fn(async () => ({ roles: {} }));
    render(<ShareDialog roomId="r1" loadAcl={loadAcl} submitShare={submitShare} onClose={vi.fn()} />);
    await waitFor(() => expect(loadAcl).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(/email/i), { target: { value: 'bob@corp.com' } });
    fireEvent.click(screen.getByText('Invite').closest('button'));
    await waitFor(() => expect(submitShare).toHaveBeenCalledWith('r1', { email: 'bob@corp.com', action: 'add', role: 'editor' }));
    await waitFor(() => expect(loadAcl).toHaveBeenCalledTimes(2));
  });
  it('#267: renders pending invites (email + role) with a remove control', async () => {
    const loadAcl = vi.fn(async () => ({ ownerId: 'owner', roles: {}, pending: { 'bob@corp.com': { role: 'editor', invitedAt: '2026-07-14T00:00:00Z' } }, display: {} }));
    const submitShare = vi.fn(async () => ({ roles: {} }));
    render(<ShareDialog roomId="r1" loadAcl={loadAcl} submitShare={submitShare} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('bob@corp.com')).toBeTruthy());
    expect(screen.getByText(/invited/i)).toBeTruthy();
    // Revoke control exists and routes to the email-remove branch.
    const revoke = screen.getByTitle('Revoke invite');
    expect(revoke).toBeTruthy();
    fireEvent.click(revoke);
    await waitFor(() => expect(submitShare).toHaveBeenCalledWith('r1', { email: 'bob@corp.com', action: 'remove' }));
  });
  it('#267: bound collaborator shows display name with raw-sub fallback', async () => {
    const loadAcl = vi.fn(async () => ({ ownerId: 'owner', roles: { s1: 'editor', s2: 'viewer' }, pending: {}, display: { s1: { name: 'Alice A', email: 'a@corp.com' } } }));
    render(<ShareDialog roomId="r1" loadAcl={loadAcl} submitShare={vi.fn(async () => ({ roles: {} }))} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Alice A')).toBeTruthy());
    expect(screen.getByText('s2')).toBeTruthy(); // no display → raw sub
  });
  it('#267: bound collaborator row shows the cached email next to the display name', async () => {
    // So an owner who invited by email can still identify the (now-promoted,
    // sub-bound) collaborator and remove them via the X — the email cache is
    // cosmetic only, never an authz/removal input.
    const loadAcl = vi.fn(async () => ({ ownerId: 'owner', roles: { s1: 'editor' }, pending: {}, display: { s1: { name: 'Bob B', email: 'bob@corp.com' } } }));
    render(<ShareDialog roomId="r1" loadAcl={loadAcl} submitShare={vi.fn(async () => ({ roles: {} }))} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Bob B')).toBeTruthy());
    expect(screen.getByText('bob@corp.com')).toBeTruthy();
  });
  it('#267: Copy room link writes the room URL to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    const prevClipboard = navigator.clipboard;
    Object.assign(navigator, { clipboard: { writeText } });
    try {
      render(<ShareDialog roomId="r1" loadAcl={vi.fn(async () => ({ ownerId: 'owner', roles: {}, pending: {}, display: {} }))} submitShare={vi.fn()} onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByText(/Copy room link/i)).toBeTruthy());
      fireEvent.click(screen.getByText(/Copy room link/i).closest('button'));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('room=r1')));
    } finally {
      Object.assign(navigator, { clipboard: prevClipboard });
    }
  });
  it('#239 raw-sub add path still works (acceptance criterion)', async () => {
    const submitShare = vi.fn(async () => ({ roles: { x: 'editor' } }));
    render(<ShareDialog roomId="r1" loadAcl={vi.fn(async () => ({ ownerId: 'owner', roles: {}, pending: {}, display: {} }))} submitShare={submitShare} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/subject id/i)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/subject id/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Add').closest('button'));
    await waitFor(() => expect(submitShare).toHaveBeenCalledWith('r1', { userId: 'x', action: 'add', role: 'editor' }));
  });
});
