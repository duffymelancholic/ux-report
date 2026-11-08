import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import * as yaml from 'js-yaml';

const require = createRequire(import.meta.url);

export const DEFAULT_AXE_RULES = ['wcag2a', 'wcag2aa', 'best-practice'];

/**
 * Load a YAML config file. Expected keys: url, outputPdf, outputJson,
 * axeRules (array), timeoutMs.
 */
export async function loadConfig(configPath) {
  const text = await readFile(configPath, 'utf8');
  const data = yaml.load(text) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid config in ${configPath}: expected a YAML mapping`);
  }
  return data;
}

/**
 * Run lightweight UI/UX heuristics inside the page context.
 * Returns plain JSON — no DOM handles leak out.
 */
export async function collectUxChecks(page) {
  return page.evaluate(() => {
    const q = (sel) => Array.from(document.querySelectorAll(sel));
    const title = document.title || '';
    const lang = document.documentElement.getAttribute('lang') || '';
    const viewport = document.querySelector('meta[name="viewport"]');
    const h1s = q('h1');
    const images = q('img');
    const imagesMissingAlt = images
      .filter((img) => !img.hasAttribute('alt'))
      .map((img) => img.src || img.outerHTML.slice(0, 120));
    const buttonsNoName = q('button')
      .filter((b) => !(b.innerText || '').trim() && !b.getAttribute('aria-label'))
      .map((b) => b.outerHTML.slice(0, 120));
    const linksNoName = q('a[href]')
      .filter((a) => !(a.innerText || '').trim() && !a.getAttribute('aria-label'))
      .map((a) => a.getAttribute('href') || a.outerHTML.slice(0, 120));
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      title,
      titleLength: title.length,
      hasTitle: title.trim().length > 0,
      lang,
      hasLang: lang.trim().length > 0,
      hasViewport: Boolean(viewport),
      h1Count: h1s.length,
      h1Ok: h1s.length === 1,
      imageCount: images.length,
      imagesMissingAlt,
      buttonCount: q('button').length,
      buttonsNoName,
      linkCount: q('a[href]').length,
      linksNoName,
      loadTimeMs: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
    };
  });
}

/** Summarize axe violations + UX heuristics into counts + findings list. */
export function summarizeResults(axeResults, ux) {
  const violations = axeResults?.violations ?? [];
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) {
    if (counts[v.impact] !== undefined) counts[v.impact] += v.nodes.length;
  }
  const findings = [];
  if (!ux.hasTitle) findings.push({ level: 'high', check: 'Missing <title>' });
  if (!ux.hasLang) findings.push({ level: 'high', check: 'Missing html lang attribute' });
  if (!ux.hasViewport) findings.push({ level: 'high', check: 'Missing viewport meta tag' });
  if (!ux.h1Ok) findings.push({ level: 'medium', check: `Expected exactly 1 <h1>, found ${ux.h1Count}` });
  if (ux.imagesMissingAlt.length > 0) {
    findings.push({ level: 'high', check: `${ux.imagesMissingAlt.length} image(s) missing alt text` });
  }
  if (ux.buttonsNoName.length > 0) {
    findings.push({ level: 'medium', check: `${ux.buttonsNoName.length} button(s) without accessible name` });
  }
  if (ux.linksNoName.length > 0) {
    findings.push({ level: 'medium', check: `${ux.linksNoName.length} link(s) without accessible name` });
  }
  for (const v of violations) {
    findings.push({
      level: v.impact === 'critical' || v.impact === 'serious' ? 'high' : 'medium',
      check: `axe: ${v.id} — ${v.help} (${v.nodes.length} node(s))`,
    });
  }
  const totalNodes = Object.values(counts).reduce((a, b) => a + b, 0);
  const score = Math.max(0, 100 - totalNodes * 2 - findings.length);
  return { counts, findings, score, violationCount: violations.length };
}

/** Build a printable HTML report (used as the PDF source). */
export function buildHtmlReport({ url, axeResults, ux, summary, generatedAt }) {
  const esc = (s) =>
    String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  const rows = (summary.findings || [])
    .map((f) => `<tr><td>${esc(f.level)}</td><td>${esc(f.check)}</td></tr>`)
    .join('\n');
  const axeRows = (axeResults?.violations ?? [])
    .map(
      (v) =>
        `<tr><td>${esc(v.id)}</td><td>${esc(v.impact)}</td><td>${esc(v.help)}</td><td>${v.nodes.length}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>UX report — ${esc(url)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:40px;color:#111}
table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:13px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}
.meta{color:#555;font-size:13px}
.score{font-size:34px;font-weight:700}
</style></head><body>
<h1>UI/UX + accessibility audit</h1>
<p class="meta">URL: ${esc(url)}<br>Generated: ${esc(generatedAt)}</p>
<p class="score">${summary.score}/100</p>
<h2>Summary</h2>
<table><tr><th>Critical nodes</th><th>Serious nodes</th><th>Moderate nodes</th><th>Minor nodes</th><th>Axe rules failing</th></tr>
<tr><td>${summary.counts.critical}</td><td>${summary.counts.serious}</td><td>${summary.counts.moderate}</td><td>${summary.counts.minor}</td><td>${summary.violationCount}</td></tr></table>
<h2>UX checks</h2>
<table>
<tr><th>Check</th><th>Value</th></tr>
<tr><td>Title</td><td>${esc(ux.title) || '(missing)'} (${ux.titleLength} chars)</td></tr>
<tr><td>html lang</td><td>${esc(ux.lang) || '(missing)'}</td></tr>
<tr><td>Viewport meta</td><td>${ux.hasViewport ? 'yes' : 'no'}</td></tr>
<tr><td>H1 count</td><td>${ux.h1Count}</td></tr>
<tr><td>Images / missing alt</td><td>${ux.imageCount} / ${ux.imagesMissingAlt.length}</td></tr>
<tr><td>Buttons / unnamed</td><td>${ux.buttonCount} / ${ux.buttonsNoName.length}</td></tr>
<tr><td>Links / unnamed</td><td>${ux.linkCount} / ${ux.linksNoName.length}</td></tr>
</table>
<h2>Findings (${summary.findings.length})</h2>
<table><tr><th>Level</th><th>Finding</th></tr>${rows || '<tr><td colspan="2">No findings 🎉</td></tr>'}</table>
<h2>Axe violations</h2>
<table><tr><th>Rule</th><th>Impact</th><th>Help</th><th>Nodes</th></tr>${axeRows || '<tr><td colspan="4">None</td></tr>'}</table>
</body></html>`;
}

/**
 * Audit a URL with Playwright + axe-core.
 * Writes a PDF (via the printable HTML above) and optionally JSON.
 */
export async function runAudit(url, options = {}) {
  const { outputPdf = 'report.pdf', outputJson = null, axeRules = DEFAULT_AXE_RULES, timeoutMs = 30000 } = options;
  const axePath = require.resolve('axe-core/axe.min.js');
  const axeSource = await readFile(axePath, 'utf8');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await page.addScriptTag({ content: axeSource });
    const axeResults = await page.evaluate(
      async (rules) => {
        // eslint-disable-next-line no-undef
        const res = await axe.run(document, {
          runOnly: { type: 'tag', values: rules },
        });
        return { violations: res.violations, passes: res.passes.length };
      },
      axeRules,
    );
    const ux = await collectUxChecks(page);
    const summary = summarizeResults(axeResults, ux);
    const generatedAt = new Date().toISOString();
    const data = { url, generatedAt, axeResults, ux, summary };

    if (outputJson) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputJson, JSON.stringify(data, null, 2), 'utf8');
    }

    // Render printable HTML in a fresh page, then print to PDF.
    const printPage = await browser.newPage();
    await printPage.setContent(buildHtmlReport(data), { waitUntil: 'load' });
    await printPage.pdf({ path: outputPdf, format: 'A4', printBackground: true });
    await printPage.close();
    return { ...data, outputPdf };
  } finally {
    await browser.close();
  }
}

function printHelp() {
  console.log(`ux-report — accessibility & UI/UX PDF report generator

Usage:
  node index.js <url> [--pdf report.pdf] [--json report.json]
  node index.js --config audit.yaml

Config YAML keys: url, outputPdf, outputJson, axeRules, timeoutMs
`);
}

// CLI entrypoint (no-op when imported by tests).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    if (args.includes('--help') || args.includes('-h')) {
      printHelp();
    } else {
      let url = args.find((a) => !a.startsWith('--'));
      let opts = {
        outputPdf: get('--pdf') ?? 'report.pdf',
        outputJson: get('--json') ?? null,
      };
      if (args.includes('--config')) {
        const cfg = await loadConfig(get('--config'));
        url = url ?? cfg.url;
        opts = {
          outputPdf: cfg.outputPdf ?? opts.outputPdf,
          outputJson: cfg.outputJson ?? opts.outputJson,
          axeRules: cfg.axeRules ?? DEFAULT_AXE_RULES,
          timeoutMs: cfg.timeoutMs ?? 30000,
        };
      }
      if (!url) throw new Error('No URL provided. Pass a URL or --config audit.yaml');
      const result = await runAudit(url, opts);
      console.log(`Score ${result.summary.score}/100 — ${result.summary.findings.length} finding(s)`);
      console.log(`PDF: ${result.outputPdf}`);
      if (opts.outputJson) console.log(`JSON: ${opts.outputJson}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
