// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ConnectionBanner from '../ConnectionBanner.jsx';

describe('ConnectionBanner', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders nothing when state is connected', () => {
    const { container } = render(<ConnectionBanner state="connected" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows connecting message', () => {
    render(<ConnectionBanner state="connecting" />);
    expect(screen.getByText(/connecting to room/i)).toBeTruthy();
  });

  it('shows disconnected message with countdown', () => {
    render(<ConnectionBanner state="disconnected" reconnectIn={5} />);
    expect(screen.getByText(/connection lost/i)).toBeTruthy();
    expect(screen.getByText(/5/)).toBeTruthy();
  });

  it('shows syncing message', () => {
    render(<ConnectionBanner state="syncing" />);
    expect(screen.getByText(/syncing/i)).toBeTruthy();
  });

  it('shows incompatible message (1b.1 schema-version gate)', () => {
    render(<ConnectionBanner state="incompatible" />);
    expect(screen.getByText(/requires a newer client/i)).toBeTruthy();
    expect(screen.getByText(/please reload/i)).toBeTruthy();
  });

  it('shows migration-partial message (1d broker partial outcome)', () => {
    render(<ConnectionBanner state="migration-partial" />);
    expect(screen.getByText(/migration had issues/i)).toBeTruthy();
    expect(screen.getByText(/legacy mode/i)).toBeTruthy();
  });

  it('counts down each second when disconnected', () => {
    render(<ConnectionBanner state="disconnected" reconnectIn={3} />);
    expect(screen.getByText(/3/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/2/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/1/)).toBeTruthy();
  });
});
