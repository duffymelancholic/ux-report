# ux-report

Reusable axe-core accessibility & UI/UX PDF report generator.

Uses [Playwright](https://playwright.dev/) to load a page, runs
[axe-core](https://github.com/dequelabs/axe-core) plus lightweight UI/UX
heuristics (title, lang, viewport, headings, image alt text, accessible
button/link names). Every finding ships with a concrete suggested fix,
and the tool writes a printable PDF, Markdown, and optional JSON.

## Install

```bash
npm install
npx playwright install chromium
```

## Use

```bash
node index.js https://example.com --pdf report.pdf --json report.json
node index.js https://example.com --md report.md --no-screenshot
node index.js --config audit.yaml
node index.js   # prompts for URL, then asks which format to export
```

The PDF includes a full-page screenshot of the audited site by default;
pass `--no-screenshot` (or `screenshot: false` in YAML) to skip it.
Run with no `--pdf`/`--md`/`--json` flags in a terminal and, after the
audit, you are asked whether to export PDF, Markdown, or both.

Example `audit.yaml`:

```yaml
url: https://example.com
outputPdf: report.pdf
outputJson: report.json
axeRules: [wcag2a, wcag2aa, best-practice]
timeoutMs: 30000
```

## Test

```bash
npm test
```

## Output

- PDF: human-readable audit with score, UX checks, findings, axe violations.
- JSON (optional): full `{ url, generatedAt, axeResults, ux, summary }` payload.
