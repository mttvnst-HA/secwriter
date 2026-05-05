// R4 spike — per-block EditorView mount-cost benchmark.
//
// What this measures: the cost of mounting N PM EditorViews bound to N
// Y.XmlFragments via y-prosemirror's ySyncPlugin, on first paint.
// Output JSON is exposed at window.__benchResult for the Playwright runner
// to read.
//
// Decision thresholds (from issue #47 v2 plan, Q29b, P50 over 5 runs):
//   < 200ms  → mount-on-render proceeds.
//   200-500ms → mount-on-render with skeleton state.
//   > 500ms  → lazy-mount mandatory; reshapes 1e.

import * as Y from 'yjs';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, prosemirrorToYXmlFragment } from 'y-prosemirror';

const status = (msg) => { document.getElementById('status').textContent = msg; };

// Minimal v2-shaped schema. Enough to exercise paragraph + text + a few
// inline marks during ySyncPlugin's initial render. Not the full final schema —
// this bench is about EditorView mount cost, not schema correctness.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: { group: 'inline' },
  },
  marks: {
    bold: { toDOM: () => ['b', 0], parseDOM: [{ tag: 'b' }, { tag: 'strong' }] },
    italic: { toDOM: () => ['i', 0], parseDOM: [{ tag: 'i' }, { tag: 'em' }] },
    underline: { toDOM: () => ['u', 0], parseDOM: [{ tag: 'u' }] },
    inlineMark: {
      attrs: { kind: { default: 'rid' } },
      toDOM: (m) => ['span', { class: `mark-${m.attrs.kind}` }, 0],
      parseDOM: [{
        tag: 'span[class]',
        getAttrs: (el) => {
          const m = (el.className || '').match(/mark-(rid|srf|sub|eng|met|tai|tst|url|att|hls|hl1|hl2|hl3|hl4)/);
          return m ? { kind: m[1] } : false;
        },
      }],
    },
  },
});

// Build a representative paragraph PM doc programmatically. Approximates a
// typical UFGS paragraph: ~80 words plain text plus 3-4 inline marks
// (citations, submittals, bold spans). Uses programmatic node creation
// rather than DOMParser to keep the bench independent of HTML parsing cost
// (we're measuring EditorView mount, not parse).
function buildSampleDoc() {
  const t = (text, marks) => schema.text(text, marks);
  const rid = schema.marks.inlineMark.create({ kind: 'rid' });
  const sub = schema.marks.inlineMark.create({ kind: 'sub' });
  const bold = schema.marks.bold.create();
  const para = (...children) => schema.nodes.paragraph.create(null, children);

  return schema.nodes.doc.create(null, [
    para(
      t('Submit '),
      t('SD-03 Product Data', [sub]),
      t(' for review prior to incorporation. Comply with '),
      t('ASTM C150', [rid]),
      t(' and '),
      t('ASTM C595', [rid]),
      t(' as applicable. Materials shall conform to manufacturer recommendations and project specifications.'),
    ),
    para(
      t('All '),
      t('cementitious materials', [bold]),
      t(' must be stored in dry conditions with '),
      t('AASHTO M85', [rid]),
      t(' compliance documented. Protect against contamination and moisture exposure during transport, on-site storage, and placement operations.'),
    ),
  ]);
}

const NUM_BLOCKS = 300;
const NUM_RUNS = 5;

// Force a layout/paint between sync barriers. Without this, the elapsed time
// only measures JS execution, not the moment the user actually sees content.
function nextFramePainted() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function quantile(sortedArr, q) {
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] !== undefined) {
    return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  }
  return sortedArr[base];
}

async function runOnce(runIdx) {
  status(`run ${runIdx + 1}/${NUM_RUNS}: setup…`);

  // Fresh Y.Doc per run so we don't accumulate ops.
  const ydoc = new Y.Doc();
  const yStore = ydoc.getMap('store');

  const sampleDoc = buildSampleDoc();

  // Seed 300 Y.XmlFragments. Done outside the timed window — we're measuring
  // EditorView mount, not seeding cost. Seeding via prosemirrorToYXmlFragment
  // exercises the same path the substrate adapter will use.
  ydoc.transact(() => {
    for (let i = 0; i < NUM_BLOCKS; i++) {
      const yMap = new Y.Map();
      const yXml = new Y.XmlFragment();
      yMap.set('html', yXml);
      yStore.set(`b${i}`, yMap);
      prosemirrorToYXmlFragment(sampleDoc, yXml);
    }
  }, 'seed');

  // Container fresh per run.
  const root = document.getElementById('blocks');
  root.innerHTML = '';
  const targets = [];
  for (let i = 0; i < NUM_BLOCKS; i++) {
    const el = document.createElement('div');
    el.dataset.blockId = `b${i}`;
    root.appendChild(el);
    targets.push(el);
  }

  // Wait for layout to settle before timing.
  await nextFramePainted();

  status(`run ${runIdx + 1}/${NUM_RUNS}: mounting…`);
  const t0 = performance.now();

  const views = [];
  for (let i = 0; i < NUM_BLOCKS; i++) {
    const yXml = yStore.get(`b${i}`).get('html');
    const state = EditorState.create({
      schema,
      plugins: [ySyncPlugin(yXml)],
    });
    const view = new EditorView(targets[i], { state });
    views.push(view);
  }

  // Wait for first paint after the last EditorView mounts so the timing
  // reflects time-to-interactive, not just JS execution.
  await nextFramePainted();
  const t1 = performance.now();
  const elapsed = t1 - t0;

  // Cleanup: destroy views and ydoc so next run starts clean.
  for (const v of views) v.destroy();
  ydoc.destroy();

  return elapsed;
}

async function main() {
  // Warm-up run, discarded — first run pays JIT + module-graph costs that
  // bias the P50.
  status('warm-up…');
  await runOnce(-1);

  const results = [];
  for (let i = 0; i < NUM_RUNS; i++) {
    const ms = await runOnce(i);
    results.push(ms);
  }

  const sorted = [...results].sort((a, b) => a - b);
  const p50 = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  const summary = {
    numBlocks: NUM_BLOCKS,
    numRuns: NUM_RUNS,
    runs: results.map((ms) => Number(ms.toFixed(1))),
    p50: Number(p50.toFixed(1)),
    p95: Number(p95.toFixed(1)),
    min: Number(min.toFixed(1)),
    max: Number(max.toFixed(1)),
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
  };

  document.getElementById('result').textContent = JSON.stringify(summary, null, 2);
  status(`done. P50 = ${summary.p50}ms, P95 = ${summary.p95}ms`);

  // Expose for the Playwright runner.
  window.__benchResult = summary;
}

main().catch((err) => {
  status(`error: ${err.message}`);
  // eslint-disable-next-line no-console
  console.error(err);
  window.__benchResult = { error: err.message, stack: err.stack };
});
