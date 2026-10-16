// Save markups back into the PDF as standard annotations (engine builds the
// bytes; this module just triggers the browser download), and read
// pdf2takeoff annotations back out when a file is reopened.

import { state, takeoffData } from './state';
import { buildAnnotatedPdf } from '../engine/annotate';
import { readPdfMarkups } from '../engine/read';
import { syncUpsertMarkup } from './session';

export async function saveAnnotatedPdf(): Promise<void> {
  if (!state.fileBytes || state.markups.length === 0) return;
  const bytes = await buildAnnotatedPdf({ bytes: state.fileBytes, ...takeoffData() });
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.fileName.replace(/\.pdf$/i, '') + '-markups.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Read pdf2takeoff-authored annotations from the open document into state. */
export async function importMarkups(): Promise<number> {
  if (!state.fileBytes) return 0;
  const found = await readPdfMarkups(state.fileBytes);
  if (found.length) {
    state.markups = found;
    for (const m of found) syncUpsertMarkup(m);
  }
  return found.length;
}
