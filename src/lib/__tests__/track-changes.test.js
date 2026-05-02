import { describe, it, expect } from 'vitest';
import * as tc from '../track-changes.js';

const block = (id, html) => ({ id, type: 'txt', part: 1, depth: 1, html });

describe('createInitial', () => {
  it('starts disabled with empty snapshots and zero publishSeq', () => {
    const s = tc.createInitial();
    expect(tc.isEnabled(s)).toBe(false);
    expect(s.snapshots.size).toBe(0);
    expect(s.publishSeq).toBe(0);
  });
});

describe('enable', () => {
  it('flips enabled flag', () => {
    const s = tc.enable(tc.createInitial(), []);
    expect(tc.isEnabled(s)).toBe(true);
  });

  it('snapshots visible text of every html-bearing block', () => {
    const blocks = [
      block('a', 'hello'),
      block('b', 'world <del class="mark-del">gone</del>'),
      { id: 'c', type: 'pagebreak' },
    ];
    const s = tc.enable(tc.createInitial(), blocks);
    expect(tc.getSnapshot(s, 'a')).toBe('hello');
    expect(tc.getSnapshot(s, 'b')).toBe('world ');
    expect(tc.getSnapshot(s, 'c')).toBeUndefined();
  });

  it('bumps publishSeq', () => {
    const s0 = tc.createInitial();
    const s1 = tc.enable(s0, []);
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
  });

  it('returns a new state object (immutable)', () => {
    const s0 = tc.createInitial();
    const s1 = tc.enable(s0, [block('a', 'x')]);
    expect(s1).not.toBe(s0);
    expect(s1.snapshots).not.toBe(s0.snapshots);
  });
});

describe('disable', () => {
  it('flips enabled flag and clears snapshots', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'hello')]);
    const s1 = tc.disable(s0);
    expect(tc.isEnabled(s1)).toBe(false);
    expect(s1.snapshots.size).toBe(0);
  });

  it('bumps publishSeq', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'hello')]);
    const s1 = tc.disable(s0);
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
  });
});

describe('acceptInline / rejectInline / applyResolveAtBlock', () => {
  it('refreshes the snapshot for the touched block to the new visible text', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'hello world')]);
    const s1 = tc.acceptInline(s0, 'a', 'hello brave world');
    expect(tc.getSnapshot(s1, 'a')).toBe('hello brave world');
  });

  it('strips inline del marks when computing the new snapshot', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'old')]);
    const s1 = tc.acceptInline(s0, 'a', 'new <del class="mark-del">deleted</del>text');
    expect(tc.getSnapshot(s1, 'a')).toBe('new text');
  });

  it('rejectInline behaves the same way at the snapshot level', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'a')]);
    const s1 = tc.rejectInline(s0, 'a', 'after');
    expect(tc.getSnapshot(s1, 'a')).toBe('after');
  });

  it('applyResolveAtBlock is the generic refresh verb', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'a')]);
    const s1 = tc.applyResolveAtBlock(s0, 'a', 'after');
    expect(tc.getSnapshot(s1, 'a')).toBe('after');
  });

  it('is a no-op when disabled', () => {
    const s0 = tc.createInitial();
    const s1 = tc.acceptInline(s0, 'a', 'whatever');
    expect(s1).toBe(s0);
  });

  it('does not touch snapshots for other blocks', () => {
    const blocks = [block('a', 'aaa'), block('b', 'bbb')];
    const s0 = tc.enable(tc.createInitial(), blocks);
    const s1 = tc.acceptInline(s0, 'a', 'AAA');
    expect(tc.getSnapshot(s1, 'a')).toBe('AAA');
    expect(tc.getSnapshot(s1, 'b')).toBe('bbb');
  });

  it('bumps publishSeq when enabled', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'a')]);
    const s1 = tc.acceptInline(s0, 'a', 'b');
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
  });
});

describe('acceptAll / rejectAll', () => {
  it('rebuilds snapshots from the post-resolution blocks', () => {
    const before = [block('a', 'old <del class="mark-del">x</del>'), block('b', 'b')];
    const after  = [block('a', 'old '), block('b', 'b')];
    const s0 = tc.enable(tc.createInitial(), before);
    const s1 = tc.acceptAll(s0, after);
    expect(tc.getSnapshot(s1, 'a')).toBe('old ');
    expect(tc.getSnapshot(s1, 'b')).toBe('b');
  });

  it('rejectAll rebuilds snapshots the same way', () => {
    const after = [block('a', 'restored'), block('b', 'b')];
    const s0 = tc.enable(tc.createInitial(), [block('a', 'partial')]);
    const s1 = tc.rejectAll(s0, after);
    expect(tc.getSnapshot(s1, 'a')).toBe('restored');
    expect(tc.getSnapshot(s1, 'b')).toBe('b');
  });

  it('is a no-op when disabled', () => {
    const s0 = tc.createInitial();
    const s1 = tc.acceptAll(s0, [block('a', 'x')]);
    expect(s1).toBe(s0);
  });

  it('bumps publishSeq when enabled', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'x')]);
    const s1 = tc.acceptAll(s0, [block('a', 'x')]);
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
  });
});

describe('markBlockCreated', () => {
  it('seeds an empty-string snapshot when enabled', () => {
    const s0 = tc.enable(tc.createInitial(), []);
    const s1 = tc.markBlockCreated(s0, 'newId');
    expect(tc.getSnapshot(s1, 'newId')).toBe('');
  });

  it('is a no-op when disabled', () => {
    const s0 = tc.createInitial();
    const s1 = tc.markBlockCreated(s0, 'newId');
    expect(s1).toBe(s0);
  });

  it('bumps publishSeq when enabled', () => {
    const s0 = tc.enable(tc.createInitial(), []);
    const s1 = tc.markBlockCreated(s0, 'newId');
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
  });
});

describe('selectors', () => {
  it('revisionFlagForCreate returns "add" when enabled, undefined otherwise', () => {
    expect(tc.revisionFlagForCreate(tc.createInitial())).toBeUndefined();
    expect(tc.revisionFlagForCreate(tc.enable(tc.createInitial(), []))).toBe('add');
  });

  it('revisionFlagForDelete returns "del" when enabled and block is not a pending add', () => {
    const enabled = tc.enable(tc.createInitial(), []);
    expect(tc.revisionFlagForDelete(enabled, { id: 'a', html: 'x' })).toBe('del');
  });

  it('revisionFlagForDelete returns null for a pending-add block (real delete)', () => {
    const enabled = tc.enable(tc.createInitial(), []);
    expect(tc.revisionFlagForDelete(enabled, { id: 'a', revision: 'add' })).toBeNull();
  });

  it('revisionFlagForDelete returns null when disabled (real delete)', () => {
    expect(tc.revisionFlagForDelete(tc.createInitial(), { id: 'a' })).toBeNull();
  });

  it('getPublishableState returns enabled flag and snapshots-as-object', () => {
    const s = tc.enable(tc.createInitial(), [block('a', 'aa'), block('b', 'bb')]);
    const pub = tc.getPublishableState(s);
    expect(pub.enabled).toBe(true);
    expect(pub.snapshots).toEqual({ a: 'aa', b: 'bb' });
  });

  it('getPublishableState returns empty snapshots when disabled, regardless of stored map', () => {
    const enabled = tc.enable(tc.createInitial(), [block('a', 'aa')]);
    const disabled = tc.disable(enabled);
    const pub = tc.getPublishableState(disabled);
    expect(pub.enabled).toBe(false);
    expect(pub.snapshots).toEqual({});
  });
});

describe('applyRemote', () => {
  it('replaces enabled + snapshots from a remote update', () => {
    const s0 = tc.createInitial();
    const s1 = tc.applyRemote(s0, { enabled: true, snapshots: { a: 'aa' } });
    expect(tc.isEnabled(s1)).toBe(true);
    expect(tc.getSnapshot(s1, 'a')).toBe('aa');
  });

  it('does NOT bump publishSeq (would round-trip back to peers)', () => {
    const s0 = tc.createInitial();
    const s1 = tc.applyRemote(s0, { enabled: true, snapshots: { a: 'aa' } });
    expect(s1.publishSeq).toBe(s0.publishSeq);
  });

  it('coerces missing fields safely', () => {
    const s = tc.applyRemote(tc.createInitial(), null);
    expect(tc.isEnabled(s)).toBe(false);
    expect(s.snapshots.size).toBe(0);
  });
});

describe('invariant: snapshot[id] === visibleText(html)', () => {
  it('holds after acceptInline', () => {
    const s0 = tc.enable(tc.createInitial(), [block('a', 'before')]);
    const html = 'after <del class="mark-del">cut</del>edit';
    const s1 = tc.acceptInline(s0, 'a', html);
    expect(tc.getSnapshot(s1, 'a')).toBe('after edit');
  });

  it('holds after acceptAll across many blocks', () => {
    const after = [
      block('a', 'A'),
      block('b', 'B <del class="mark-del">gone</del>!'),
      block('c', 'C'),
    ];
    const s0 = tc.enable(tc.createInitial(), [block('a', 'old'), block('b', 'old'), block('c', 'old')]);
    const s1 = tc.acceptAll(s0, after);
    for (const b of after) {
      expect(tc.getSnapshot(s1, b.id)).toBe(
        b.html.replace(/<del\b[^>]*>[\s\S]*?<\/del>/gi, '').replace(/<[^>]+>/g, '')
      );
    }
  });
});
