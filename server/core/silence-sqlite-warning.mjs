/**
 * node:sqlite is still marked experimental in Node 24 and prints a warning on
 * every start. This project uses it deliberately (zero-dependency self-hosted
 * deployment), so the warning is filtered to keep operational logs clean.
 * Other ProcessWarnings are passed through untouched.
 */
const originalEmitWarning = process.emitWarning;

process.emitWarning = function filteredEmitWarning(warning, ...args) {
  const text = typeof warning === 'string' ? warning : warning?.message || String(warning);
  if (/SQLite is an experimental feature/i.test(text)) return;
  return originalEmitWarning.call(process, warning, ...args);
};
