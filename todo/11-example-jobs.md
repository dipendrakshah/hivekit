# 11 — Example jobs (acceptance)

## What to do

Prove the product with the three jobs the PRD promised.

Work:

1. Sample pack in `examples/briefing/`: three tiny PDFs.
2. Sample pack in `examples/news-site/`: a static index + sources.md + two RSS fixtures.
3. Sample pack in `examples/tax/`: mixed fake invoices (no real personal data).
4. Scripts: `hivekit job run examples/briefing`, etc.
5. Record traces in `qa/examples/`.

## Definition of done

- [ ] Briefing job: `out/briefing.md` exists and quotes at least one line from each PDF.
- [ ] News site job: one new post file appears and `state.json` updates; git commit waits for approval.
- [ ] Tax job: `dashboard.html` opens and shows at least 8 parsed rows from 10 files, with the rest listed as unparsed — not silently dropped.
- [ ] Worker model slug changed between run A and run B; both reports name the model they used.
- [ ] A person who did not author the runtime follows README and completes briefing in ≤ 15 minutes. Note their name and date here.

Independent run:

- Name:
- Date:
- Minutes:
- Blockers:
