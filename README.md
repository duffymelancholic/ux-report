# ux-report

Reusable axe-core accessibility & UI/UX PDF report generator.

Uses [Playwright](https://playwright.dev/) to load a page, runs
[axe-core](https://github.com/dequelabs/axe-core) plus lightweight UI/UX
heuristics (title, lang, viewport, headings, image alt text, accessible
button/link names), and writes a printable PDF (plus optional JSON).

## Install

```bash
npm install
npx playwright install chromium
```

## Use

```bash
node index.js https://example.com --pdf report.pdf --json report.json
node index.js --config audit.yaml
```

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
