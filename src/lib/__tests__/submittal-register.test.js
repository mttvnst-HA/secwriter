import { describe, it, expect } from 'vitest';
import { extractSubmittals, groupBySD, compileRegister } from '../submittal-register.js';

describe('extractSubmittals', () => {
  it('extracts item name and classification from SUB marks', () => {
    const blocks = [
      { id: 't1', type: 'title', depth: 1, part: 1, html: 'SUBMITTALS' },
      { id: 'b1', type: 'lst', part: 1, section: 't1', html: '<span class="mark-sub">SD-01 Preconstruction Submittals</span>' },
      { id: 'b2', type: 'item', part: 1, section: 't1', html: '<span class="mark-sub">Excavation Plan</span> ; <span class="mark-sub">G</span>' },
    ];
    const items = extractSubmittals(blocks);
    expect(items).toHaveLength(1);
    expect(items[0].itemName).toBe('Excavation Plan');
    expect(items[0].classification).toBe('G');
    expect(items[0].sdNumber).toBe(1);
    expect(items[0].sdTitle).toBe('Preconstruction Submittals');
  });

  it('handles items without classification', () => {
    const blocks = [
      { id: 't1', type: 'title', depth: 1, part: 1, html: 'SUBMITTALS' },
      { id: 'b1', type: 'lst', part: 1, section: 't1', html: '<span class="mark-sub">SD-04 Samples</span>' },
      { id: 'b2', type: 'item', part: 1, section: 't1', html: '<span class="mark-sub">Geotextiles</span>' },
    ];
    const items = extractSubmittals(blocks);
    expect(items).toHaveLength(1);
    expect(items[0].itemName).toBe('Geotextiles');
    expect(items[0].classification).toBe('');
  });

  it('captures section number from nearest title', () => {
    const blocks = [
      { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
      { id: 't1', type: 'title', depth: 1, part: 1, html: 'SUBMITTALS' },
      { id: 'b1', type: 'lst', part: 1, section: 't1', html: '<span class="mark-sub">SD-01 Data</span>' },
      { id: 'b2', type: 'item', part: 1, section: 't1', html: '<span class="mark-sub">Plan A</span> ; <span class="mark-sub">G</span>' },
    ];
    const items = extractSubmittals(blocks);
    expect(items[0].sectionTitle).toBe('SUBMITTALS');
  });

  it('does not create items from SD headers alone', () => {
    const blocks = [
      { id: 'b1', type: 'lst', part: 1, html: '<span class="mark-sub">SD-01 Preconstruction Submittals</span>' },
    ];
    const items = extractSubmittals(blocks);
    expect(items).toHaveLength(0);
  });

  it('filters out standalone classification codes as items', () => {
    // The "G" after semicolon should be treated as classification, not a separate item
    const blocks = [
      { id: 'b1', type: 'lst', part: 1, html: '<span class="mark-sub">SD-01 Test</span>' },
      { id: 'b2', type: 'item', part: 1, html: '<span class="mark-sub">Meeting</span> ; <span class="mark-sub">G</span>' },
    ];
    const items = extractSubmittals(blocks);
    expect(items).toHaveLength(1);
    expect(items[0].itemName).toBe('Meeting');
    expect(items[0].classification).toBe('G');
  });

  it('returns empty for blocks with no SUB marks', () => {
    const blocks = [{ id: 'b1', type: 'txt', html: 'No submittals' }];
    expect(extractSubmittals(blocks)).toEqual([]);
  });

  it('extracts submittals referenced outside SUBMITTALS section', () => {
    const blocks = [
      { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
      { id: 't1', type: 'title', depth: 1, part: 1, html: 'SUBMITTALS' },
      { id: 'b1', type: 'lst', part: 1, section: 't1', html: '<span class="mark-sub">SD-06 Test Reports</span>' },
      { id: 'b2', type: 'item', part: 1, section: 't1', html: '<span class="mark-sub">Material Report</span> ; <span class="mark-sub">G</span>' },
      { id: 'p2', type: 'title', depth: 0, part: 2, html: 'PRODUCTS' },
      { id: 't2', type: 'title', depth: 1, part: 2, html: 'FLOWABLE FILL' },
      { id: 'b3', type: 'txt', part: 2, section: 't2', html: 'Submit <span class="mark-sub">mix design</span> data' },
    ];
    const items = extractSubmittals(blocks);
    expect(items).toHaveLength(2);
    expect(items[0].itemName).toBe('Material Report');
    expect(items[1].itemName).toBe('mix design');
    expect(items[1].sectionTitle).toBe('FLOWABLE FILL');
  });
});

describe('groupBySD', () => {
  it('groups items by SD number', () => {
    const items = [
      { itemName: 'Plan A', sdNumber: 1, sdTitle: 'Preconstruction' },
      { itemName: 'Plan B', sdNumber: 1, sdTitle: 'Preconstruction' },
      { itemName: 'Data X', sdNumber: 3, sdTitle: 'Product Data' },
    ];
    const groups = groupBySD(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].sd).toBe('SD-01');
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].sd).toBe('SD-03');
    expect(groups[1].items).toHaveLength(1);
  });

  it('puts items without SD number in uncategorized group', () => {
    const items = [
      { itemName: 'Orphan', sdNumber: null, sdTitle: '' },
    ];
    const groups = groupBySD(items);
    expect(groups[0].sd).toBe('SD-??');
  });

  it('returns empty for empty input', () => {
    expect(groupBySD([])).toEqual([]);
  });
});

describe('compileRegister', () => {
  it('compiles register with correct total', () => {
    const blocks = [
      { id: 't1', type: 'title', depth: 1, part: 1, html: 'SUBMITTALS' },
      { id: 'b1', type: 'lst', part: 1, section: 't1', html: '<span class="mark-sub">SD-01 Preconstruction</span>' },
      { id: 'b2', type: 'item', part: 1, section: 't1', html: '<span class="mark-sub">Plan A</span> ; <span class="mark-sub">G</span>' },
      { id: 'b3', type: 'item', part: 1, section: 't1', html: '<span class="mark-sub">Plan B</span>' },
    ];
    const register = compileRegister(blocks, { sectionNumber: '31 00 00' });
    expect(register.totalItems).toBe(2);
    expect(register.groups).toHaveLength(1);
    expect(register.specSection).toBe('31 00 00');
  });
});
