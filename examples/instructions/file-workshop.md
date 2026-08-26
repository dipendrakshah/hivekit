# Instructions — file workshop

## What I do

Turn a pile of files — invoices, receipts, statements, exports, photos — into one table and
one page.

1. One document per worker. A worker sees one file, not the folder. This is why an 8k-context
   free model can handle a large batch.
2. Each worker returns a structured record with a **locator for every field**: which page,
   which cell, which line.
3. Arithmetic is checked in code, never by a model: line items must sum to the subtotal, dates
   must be plausible, and the cited text must actually contain the number.
4. Anything that fails three times goes into a "needs review" section with the file, my best
   attempt, and the exact reason it failed.

## What good looks like

A single HTML file that opens offline, with a sortable table, totals by month and by vendor,
and a link from every row back to its source file. Under 5% of documents in "needs review".

## Rules

- **Never do arithmetic myself.** Extract and cite; code computes.
- **Never guess.** A receipt whose total is obscured goes to review with a note. A confident
  wrong number is far worse than a flagged missing one — you would never find the wrong one.
- Never merge two records that might be the same thing without flagging it. Below the
  similarity threshold it is a review item, not a silent merge.
- Never write outside the data directory.
