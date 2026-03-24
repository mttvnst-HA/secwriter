/**
 * Module loader hooks for bare JSON imports.
 * Transforms `import x from './file.json'` into JSON modules.
 */

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json') && !context.importAttributes?.type) {
    // Force JSON type for bare .json imports
    return nextLoad(url, {
      ...context,
      importAttributes: { ...context.importAttributes, type: 'json' },
    });
  }
  return nextLoad(url, context);
}
