import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import * as comments from '../comments.js';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.document = document;

const ALICE = { id: 'a', name: 'Alice', color: '#f00' };

const remoteComment = (id, status = 'open') => ({
  id,
  blockId: 'b1',
  status,
  highlightText: 'h',
  createdAt: 1,
  authorId: 'a',
  authorName: 'Alice',
  authorColor: '#f00',
  entries: [{ id: 'e1', type: 'create', text: 't', authorId: 'a', authorName: 'Alice', authorColor: '#f00', ts: 1 }],
});

describe('mergeRemote', () => {
  it('empty prev + empty remote = empty result', () => {
    const out = comments.mergeRemote(comments.createInitial(), {});
    expect(out.byId.size).toBe(0);
    expect(out.seenRemoteIds.size).toBe(0);
  });

  it('empty prev + non-empty remote = byId populated from remote', () => {
    const out = comments.mergeRemote(comments.createInitial(), { c1: remoteComment('c1') });
    expect(out.byId.size).toBe(1);
    expect(out.byId.get('c1')?.id).toBe('c1');
    expect(out.seenRemoteIds.has('c1')).toBe(true);
  });

  it('preserves a local draft (never seen remote) when remote does not include it', () => {
    const s0 = comments.createDraft(comments.createInitial(), {
      commentId: 'draft1', blockId: 'b1', highlightText: 'h', identity: ALICE, ts: 1,
    }).state;
    const out = comments.mergeRemote(s0, {});
    expect(out.byId.has('draft1')).toBe(true);
  });

  it('remote wins on echo: local entry replaced by the remote payload for the same id', () => {
    const s0 = comments.createDraft(comments.createInitial(), {
      commentId: 'c1', blockId: 'b1', highlightText: 'local', identity: ALICE, ts: 1,
    }).state;
    const out = comments.mergeRemote(s0, { c1: remoteComment('c1') });
    expect(out.byId.get('c1').highlightText).toBe('h'); // remote value, not 'local'
  });

  it('drops a seen comment that disappears from remote (tombstone)', () => {
    const s1 = comments.mergeRemote(comments.createInitial(), { c1: remoteComment('c1') });
    expect(s1.byId.has('c1')).toBe(true);
    const s2 = comments.mergeRemote(s1, {});
    expect(s2.byId.has('c1')).toBe(false);
  });

  it('seenRemoteIds is monotonically non-shrinking across merges', () => {
    let s = comments.createInitial();
    s = comments.mergeRemote(s, { c1: remoteComment('c1') });
    s = comments.mergeRemote(s, { c2: remoteComment('c2') });
    expect(s.seenRemoteIds.has('c1')).toBe(true);
    expect(s.seenRemoteIds.has('c2')).toBe(true);
    s = comments.mergeRemote(s, {});
    expect(s.seenRemoteIds.has('c1')).toBe(true);
    expect(s.seenRemoteIds.has('c2')).toBe(true);
  });

  it('does not mutate the prior state', () => {
    const prev = comments.createInitial();
    comments.mergeRemote(prev, { c1: remoteComment('c1') });
    expect(prev.byId.size).toBe(0);
    expect(prev.seenRemoteIds.size).toBe(0);
  });

  it('property: applying the same remote payload twice is a fixed point', () => {
    const remote = { c1: remoteComment('c1', 'open'), c2: remoteComment('c2', 'resolved') };
    const s1 = comments.mergeRemote(comments.createInitial(), remote);
    const s2 = comments.mergeRemote(s1, remote);
    expect(s2.byId.size).toBe(s1.byId.size);
    expect(Array.from(s2.byId.keys()).sort()).toEqual(Array.from(s1.byId.keys()).sort());
    expect(s2.byId.get('c1')).toEqual(s1.byId.get('c1'));
    expect(s2.byId.get('c2')).toEqual(s1.byId.get('c2'));
  });
});

const stateWith = (entries) => {
  const byId = new Map();
  for (const [id, status] of entries) byId.set(id, { id, status, entries: [] });
  return { byId, seenRemoteIds: new Set() };
};

describe('reconcileBlocks', () => {
  it('returns original reference when no block has mark-comment', () => {
    const blocks = [{ id: 'b1', html: '<p>plain</p>' }, { id: 'b2', html: 'no spans' }];
    const out = comments.reconcileBlocks(blocks, stateWith([['c1', 'open']]));
    expect(out).toBe(blocks);
  });

  it('returns original reference when every span already matches state', () => {
    const blocks = [
      { id: 'b1', html: '<span class="mark-comment" data-comment-id="c1">hi</span>' },
      { id: 'b2', html: '<span class="mark-comment-resolved" data-comment-id="c2">there</span>' },
    ];
    const out = comments.reconcileBlocks(blocks, stateWith([['c1', 'open'], ['c2', 'resolved']]));
    expect(out).toBe(blocks);
  });

  it('unwraps spans whose data-comment-id is missing from state', () => {
    const blocks = [
      { id: 'b1', html: '<span class="mark-comment" data-comment-id="orphan">hello</span>' },
    ];
    const out = comments.reconcileBlocks(blocks, stateWith([]));
    expect(out).not.toBe(blocks);
    expect(out[0].html).toContain('hello');
    expect(out[0].html).not.toContain('mark-comment');
  });

  it('reclasses an open-styled span when state says resolved', () => {
    const blocks = [
      { id: 'b1', html: '<span class="mark-comment" data-comment-id="c1">x</span>' },
    ];
    const out = comments.reconcileBlocks(blocks, stateWith([['c1', 'resolved']]));
    expect(out[0].html).toContain('class="mark-comment-resolved"');
    expect(out[0].html).not.toContain('class="mark-comment"');
  });

  it('reclasses a resolved-styled span when state says open', () => {
    const blocks = [
      { id: 'b1', html: '<span class="mark-comment-resolved" data-comment-id="c1">x</span>' },
    ];
    const out = comments.reconcileBlocks(blocks, stateWith([['c1', 'open']]));
    expect(out[0].html).toContain('class="mark-comment"');
    expect(out[0].html).not.toContain('mark-comment-resolved');
  });

  it('preserves blocks that did not change by reference', () => {
    const blocks = [
      { id: 'b1', html: '<p>untouched</p>' },
      { id: 'b2', html: '<span class="mark-comment" data-comment-id="orphan">x</span>' },
    ];
    const out = comments.reconcileBlocks(blocks, stateWith([]));
    expect(out).not.toBe(blocks);
    expect(out[0]).toBe(blocks[0]);
    expect(out[1]).not.toBe(blocks[1]);
  });

  it('passes through blocks without an html field (ref / table)', () => {
    const blocks = [
      { id: 'r1', type: 'ref', ref: { org: 'X', entries: [] } },
      { id: 't1', type: 'table', table: { columns: 1, rows: [[{ text: '' }]] } },
    ];
    const out = comments.reconcileBlocks(blocks, stateWith([]));
    expect(out).toBe(blocks);
  });

  it('mixes valid and orphan spans within the same block', () => {
    const blocks = [
      {
        id: 'b1',
        html:
          '<span class="mark-comment" data-comment-id="keep">A</span>' +
          '<span class="mark-comment" data-comment-id="drop">B</span>',
      },
    ];
    const out = comments.reconcileBlocks(blocks, stateWith([['keep', 'open']]));
    expect(out[0].html).toContain('data-comment-id="keep"');
    expect(out[0].html).toContain('A');
    expect(out[0].html).toContain('B');
    expect(out[0].html).not.toContain('data-comment-id="drop"');
  });

  it('property: reconcile is idempotent (running twice == running once)', () => {
    const blocks = [
      { id: 'b1', html: '<span class="mark-comment" data-comment-id="orphan">x</span>' },
      { id: 'b2', html: '<span class="mark-comment" data-comment-id="c1">y</span>' },
      { id: 'b3', html: '<span class="mark-comment-resolved" data-comment-id="c2">z</span>' },
    ];
    const state = stateWith([['c1', 'resolved'], ['c2', 'open']]);
    const once = comments.reconcileBlocks(blocks, state);
    const twice = comments.reconcileBlocks(once, state);
    expect(twice).toBe(once);
  });
});
