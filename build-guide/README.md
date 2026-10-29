# LOOP Build Record — derivation pipeline

The PDF (LOOP-Build-Record.pdf, 356 pages) is DERIVED from the repository's
primary sources. It is never hand-copied, so it cannot drift from the record.

## Pipeline (run in order)

1. `python3 build-guide/extractor.py`
   Walks git ls-files / git log / worklog.md / postmortems/ / dev.log and
   writes `build-guide/data.json`. All narrative numbers in the PDF come from
   this file via {placeholder} substitution.
2. `python3 build-guide/charts.py`
   Renders the three figures into `build-guide/charts/` from data.json
   (cascade palette, charts.md rules).
3. Cover: `build-guide/cover.html` (Template 01, cascade CSS aliases) ->
   `node skills/pdf/scripts/html2poster.js build-guide/cover.html
   --output build-guide/cover.pdf --width 794px`
   (validated first by poster_validate.py check-html and cover_validate.js).
4. `python3 build-guide/generate.py`
   Builds body.pdf (ReportLab, TocDocTemplate + multiBuild) and merges
   cover.pdf as page 1 -> /home/z/my-project/LOOP-Build-Record.pdf.

## QA chain (after every regeneration)

- skills/pdf/scripts/pdf.py meta.brand LOOP-Build-Record.pdf
- skills/pdf/scripts/pdf.py pages.clean (no-op check)
- skills/pdf/scripts/pdf.py font.check
- skills/pdf/scripts/toc_validate.py check-pdf
- skills/pdf/scripts/pdf_qa.py

## Live captures

`build-guide/capture/` holds the three perishable dashboard states taken
while the record was compiled (cooldown chip mid-countdown, config panel,
mobile viewport with gate at level 2). They exist only while the system
runs; they cannot be re-taken later.

## Re-derivation

Re-runnable at any commit: checkout the commit, run steps 1-4. Numbers in
the narrative re-substitute from the new data.json; the text itself is in
content_ch1_4.py / content_ch5_6.py / content_ch7_8.py.
