import { describe, it, expect } from 'vitest';
import * as comments from '../comments.js';

const ALICE = { id: 'a-1', name: 'Alice', color: '#ff0000' };
const BOB = { id: 'b-1', name: 'Bob', color: '#00ff00' };

const draftPayload = (overrides = {}) => ({
  commentId: 'c1',
  blockId: 'b1',
  highlightText: 'highlighted text',
  identity: ALICE,
  ts: 1000,
  ...overrides,
});

const createPayload = (overrides = {}) => ({
  commentId: 'c1',
  text: 'hello world',
  identity: ALICE,
  ts: 2000,
  ...overrides,
});

describe('createInitial', () => {
  it('returns empty byId Map and empty seenRemoteIds Set', () => {
    const s = comments.createInitial();
    expect(s.byId).toBeInstanceOf(Map);
    expect(s.byId.size).toBe(0);
    expect(s.seenRemoteIds).toBeInstanceOf(Set);
    expect(s.seenRemoteIds.size).toBe(0);
  });
});

describe('createDraft', () => {
  it('inserts a comment with one create entry whose text is empty', () => {
    const { state } = comments.createDraft(comments.createInitial(), draftPayload());
    const c = state.byId.get('c1');
    expect(c).toBeDefined();
    expect(c.id).toBe('c1');
    expect(c.blockId).toBe('b1');
    expect(c.status).toBe('open');
    expect(c.highlightText).toBe('highlighted text');
    expect(c.createdAt).toBe(1000);
    expect(c.authorId).toBe(ALICE.id);
    expect(c.authorName).toBe(ALICE.name);
    expect(c.authorColor).toBe(ALICE.color);
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0].type).toBe('create');
    expect(c.entries[0].text).toBe('');
    expect(c.entries[0].authorId).toBe(ALICE.id);
    expect(c.entries[0].ts).toBe(1000);
  });

  it('returns publish: null (deferred publish for drafts)', () => {
    const { publish } = comments.createDraft(comments.createInitial(), draftPayload());
    expect(publish).toBeNull();
  });

  it('does not mutate prior state', () => {
    const prev = comments.createInitial();
    comments.createDraft(prev, draftPayload());
    expect(prev.byId.size).toBe(0);
  });

  it('preserves existing comments', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload({ commentId: 'c1' })).state;
    const s1 = comments.createDraft(s0, draftPayload({ commentId: 'c2', blockId: 'b2' })).state;
    expect(s1.byId.size).toBe(2);
    expect(s1.byId.has('c1')).toBe(true);
    expect(s1.byId.has('c2')).toBe(true);
  });
});

describe('updateCreate', () => {
  it('updates entries[0].text with the submitted text', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const { state } = comments.updateCreate(s0, createPayload());
    expect(state.byId.get('c1').entries[0].text).toBe('hello world');
  });

  it('emits a publish envelope of kind=create with the full payload', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const { publish } = comments.updateCreate(s0, createPayload());
    expect(publish).toEqual({
      kind: 'create',
      commentId: 'c1',
      payload: {
        blockId: 'b1',
        status: 'open',
        highlightText: 'highlighted text',
        createdAt: 1000,
        author: ALICE,
        initialText: 'hello world',
      },
    });
  });

  it('is a no-op when the comment does not exist', () => {
    const s0 = comments.createInitial();
    const { state, publish } = comments.updateCreate(s0, createPayload({ commentId: 'missing' }));
    expect(state).toBe(s0);
    expect(publish).toBeNull();
  });
});

describe('reply', () => {
  it('appends a reply entry with the submitted text', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.updateCreate(s0, createPayload()).state;
    const { state } = comments.reply(s1, { commentId: 'c1', text: 'a reply', identity: BOB, ts: 3000 });
    const entries = state.byId.get('c1').entries;
    expect(entries).toHaveLength(2);
    expect(entries[1].type).toBe('reply');
    expect(entries[1].text).toBe('a reply');
    expect(entries[1].authorId).toBe(BOB.id);
    expect(entries[1].ts).toBe(3000);
  });

  it('emits a publish envelope of kind=reply', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.updateCreate(s0, createPayload()).state;
    const { publish } = comments.reply(s1, { commentId: 'c1', text: 'a reply', identity: BOB, ts: 3000 });
    expect(publish).toEqual({
      kind: 'reply',
      commentId: 'c1',
      reply: { author: BOB, text: 'a reply', ts: 3000 },
    });
  });

  it('is a no-op when the comment does not exist', () => {
    const s0 = comments.createInitial();
    const { state, publish } = comments.reply(s0, { commentId: 'missing', text: 'x', identity: ALICE, ts: 1 });
    expect(state).toBe(s0);
    expect(publish).toBeNull();
  });
});

describe('resolve', () => {
  it('flips status to resolved and appends a resolve entry', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.updateCreate(s0, createPayload()).state;
    const { state } = comments.resolve(s1, { commentId: 'c1', identity: BOB, ts: 4000 });
    const c = state.byId.get('c1');
    expect(c.status).toBe('resolved');
    expect(c.entries[c.entries.length - 1].type).toBe('resolve');
    expect(c.entries[c.entries.length - 1].authorId).toBe(BOB.id);
    expect(c.entries[c.entries.length - 1].ts).toBe(4000);
  });

  it('emits a publish envelope of kind=status with status=resolved', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.updateCreate(s0, createPayload()).state;
    const { publish } = comments.resolve(s1, { commentId: 'c1', identity: BOB, ts: 4000 });
    expect(publish).toEqual({
      kind: 'status',
      commentId: 'c1',
      status: 'resolved',
      meta: { author: BOB, ts: 4000 },
    });
  });

  it('is a no-op when the comment does not exist', () => {
    const s0 = comments.createInitial();
    const { state, publish } = comments.resolve(s0, { commentId: 'missing', identity: ALICE, ts: 1 });
    expect(state).toBe(s0);
    expect(publish).toBeNull();
  });
});

describe('reopen', () => {
  it('flips status to open and appends a reopen entry', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.updateCreate(s0, createPayload()).state;
    const s2 = comments.resolve(s1, { commentId: 'c1', identity: BOB, ts: 4000 }).state;
    const { state } = comments.reopen(s2, { commentId: 'c1', identity: ALICE, ts: 5000 });
    const c = state.byId.get('c1');
    expect(c.status).toBe('open');
    expect(c.entries[c.entries.length - 1].type).toBe('reopen');
    expect(c.entries[c.entries.length - 1].authorId).toBe(ALICE.id);
  });

  it('emits a publish envelope of kind=status with status=open', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.updateCreate(s0, createPayload()).state;
    const s2 = comments.resolve(s1, { commentId: 'c1', identity: BOB, ts: 4000 }).state;
    const { publish } = comments.reopen(s2, { commentId: 'c1', identity: ALICE, ts: 5000 });
    expect(publish).toEqual({
      kind: 'status',
      commentId: 'c1',
      status: 'open',
      meta: { author: ALICE, ts: 5000 },
    });
  });
});

describe('remove', () => {
  it('removes the comment from byId', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const { state } = comments.remove(s0, { commentId: 'c1' });
    expect(state.byId.has('c1')).toBe(false);
  });

  it('emits a publish envelope of kind=delete', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const { publish } = comments.remove(s0, { commentId: 'c1' });
    expect(publish).toEqual({ kind: 'delete', commentId: 'c1' });
  });

  it('is a no-op when the comment does not exist (still emits delete envelope)', () => {
    const s0 = comments.createInitial();
    const { state, publish } = comments.remove(s0, { commentId: 'missing' });
    expect(state).toBe(s0);
    // remove always emits — peer might still have the entry. Idempotent on receipt.
    expect(publish).toEqual({ kind: 'delete', commentId: 'missing' });
  });
});

describe('selectors', () => {
  it('size returns the number of comments', () => {
    const s0 = comments.createInitial();
    expect(comments.size(s0)).toBe(0);
    const s1 = comments.createDraft(s0, draftPayload({ commentId: 'c1' })).state;
    const s2 = comments.createDraft(s1, draftPayload({ commentId: 'c2', blockId: 'b2' })).state;
    expect(comments.size(s2)).toBe(2);
  });

  it('get returns the comment by id, or undefined', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    expect(comments.get(s0, 'c1')?.id).toBe('c1');
    expect(comments.get(s0, 'missing')).toBeUndefined();
  });

  it('all returns a fresh Comment[] containing all comments', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload({ commentId: 'c1' })).state;
    const s1 = comments.createDraft(s0, draftPayload({ commentId: 'c2', blockId: 'b2' })).state;
    const arr = comments.all(s1);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(2);
    expect(arr.map(c => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('all returns a different array on each call (no mutation hazard)', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const a = comments.all(s0);
    const b = comments.all(s0);
    expect(a).not.toBe(b);
  });

  it('isDraft is true for a freshly-created comment with empty entries[0].text', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const c = comments.get(s0, 'c1');
    expect(comments.isDraft(c)).toBe(true);
  });

  it('isDraft is false after updateCreate fills in the text', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.updateCreate(s0, createPayload()).state;
    const c = comments.get(s1, 'c1');
    expect(comments.isDraft(c)).toBe(false);
  });

  it('isDraft is false once a reply has been added', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.reply(s0, { commentId: 'c1', text: 'r', identity: ALICE, ts: 2 }).state;
    const c = comments.get(s1, 'c1');
    expect(comments.isDraft(c)).toBe(false);
  });

  it('getCreateEntry returns the first entry with type=create', () => {
    const s0 = comments.createDraft(comments.createInitial(), draftPayload()).state;
    const s1 = comments.updateCreate(s0, createPayload()).state;
    const c = comments.get(s1, 'c1');
    const e = comments.getCreateEntry(c);
    expect(e?.type).toBe('create');
    expect(e?.text).toBe('hello world');
  });

  it('getCreateEntry returns undefined when no create entry exists', () => {
    expect(comments.getCreateEntry({ entries: [] })).toBeUndefined();
    expect(comments.getCreateEntry({ entries: [{ type: 'reply', text: 'x' }] })).toBeUndefined();
  });
});

describe('normalizeForLoad', () => {
  it('passes through canonical-shape entries unchanged', () => {
    const raw = {
      c1: {
        id: 'c1', blockId: 'b1', status: 'open', highlightText: 'h', createdAt: 1,
        authorId: 'a1', authorName: 'Alice', authorColor: '#f00',
        entries: [{ id: 'e1', type: 'create', text: 't', authorId: 'a1', authorName: 'Alice', authorColor: '#f00', ts: 1 }],
      },
    };
    const out = comments.normalizeForLoad(raw);
    expect(out.c1.entries[0].authorName).toBe('Alice');
    expect(out.c1.entries[0].ts).toBe(1);
  });

  it('promotes legacy author string to authorName when authorName is missing', () => {
    const raw = {
      c1: {
        id: 'c1',
        entries: [{ type: 'create', text: 't', author: 'LegacyAlice', timestamp: '2026-03-17T10:00:00Z' }],
      },
    };
    const out = comments.normalizeForLoad(raw);
    expect(out.c1.entries[0].authorName).toBe('LegacyAlice');
  });

  it('parses legacy timestamp ISO string to ts number when ts is missing', () => {
    const raw = {
      c1: {
        id: 'c1',
        entries: [{ type: 'create', text: 't', author: 'X', timestamp: '2026-03-17T10:00:00Z' }],
      },
    };
    const out = comments.normalizeForLoad(raw);
    const expected = Date.parse('2026-03-17T10:00:00Z');
    expect(out.c1.entries[0].ts).toBe(expected);
  });

  it('does not overwrite existing canonical fields with legacy ones', () => {
    const raw = {
      c1: {
        id: 'c1',
        entries: [{
          type: 'create', text: 't',
          author: 'LegacyAlice', authorName: 'CanonicalAlice',
          timestamp: '2026-03-17T10:00:00Z', ts: 9999,
        }],
      },
    };
    const out = comments.normalizeForLoad(raw);
    expect(out.c1.entries[0].authorName).toBe('CanonicalAlice');
    expect(out.c1.entries[0].ts).toBe(9999);
  });
});
