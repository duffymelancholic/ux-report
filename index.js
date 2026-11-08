import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process';
import { createInterface } from 'node:readline/promises';
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
  if (!ux.hasTitle) {
    findings.push({
      level: 'high',
      check: 'Missing <title>',
      fix: 'Add a unique <title> of about 50–60 characters inside <head> describing the page; every page needs its own.',
    });
  }
  if (!ux.hasLang) {
    findings.push({
      level: 'high',
      check: 'Missing html lang attribute',
      fix: 'Add a lang attribute to <html> (e.g. <html lang="en">) so screen readers use the correct pronunciation.',
    });
  }
  if (!ux.hasViewport) {
    findings.push({
      level: 'high',
      check: 'Missing viewport meta tag',
      fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> inside <head> so the layout adapts to mobile screens.',
    });
  }
  if (!ux.h1Ok) {
    findings.push({
      level: 'medium',
      check: `Expected exactly 1 <h1>, found ${ux.h1Count}`,
      fix: 'Use exactly one <h1> per page for the main topic, then structure subsections with <h2>–<h6> in order without skipping levels.',
    });
  }
  if (ux.imagesMissingAlt.length > 0) {
    findings.push({
      level: 'high',
      check: `${ux.imagesMissingAlt.length} image(s) missing alt text`,
      fix: 'Add concise, meaningful alt text to every informative image; use alt="" for purely decorative ones. First offender: ' + ux.imagesMissingAlt[0],
    });
  }
  if (ux.buttonsNoName.length > 0) {
    findings.push({
      level: 'medium',
      check: `${ux.buttonsNoName.length} button(s) without accessible name`,
      fix: 'Give each <button> visible text or an aria-label describing its action (e.g. aria-label="Close menu").',
    });
  }
  if (ux.linksNoName.length > 0) {
    findings.push({
      level: 'medium',
      check: `${ux.linksNoName.length} link(s) without accessible name`,
      fix: 'Give each link descriptive text (or aria-label) stating its purpose — avoid bare "click here" links.',
    });
  }
  for (const v of violations) {
    findings.push({
      level: v.impact === 'critical' || v.impact === 'serious' ? 'high' : 'medium',
      check: `axe: ${v.id} — ${v.help} (${v.nodes.length} node(s))`,
      fix: `${v.description}. Fix guide: ${v.helpUrl}`,
    });
  }
  const totalNodes = Object.values(counts).reduce((a, b) => a + b, 0);
  const score = Math.max(0, 100 - totalNodes * 2 - findings.length);
  return { counts, findings, score, violationCount: violations.length };
}

/** Build a printable HTML report (used as the PDF source). */
export function buildHtmlReport({ url, axeResults, ux, summary, generatedAt, screenshotDataUri = null }) {
  const esc = (s) =>
    String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  const rows = (summary.findings || [])
    .map((f) => `<tr><td>${esc(f.level)}</td><td>${esc(f.check)}</td><td>${esc(f.fix)}</td></tr>`)
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
${screenshotDataUri ? `<h2>Screenshot</h2>\n<img src="${screenshotDataUri}" alt="Screenshot of ${esc(url)}" style="max-width:100%;border:1px solid #ccc">` : ''}
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
<table><tr><th>Level</th><th>Finding</th><th>Suggested fix</th></tr>${rows || '<tr><td colspan="3">No findings 🎉</td></tr>'}</table>
<h2>Axe violations</h2>
<table><tr><th>Rule</th><th>Impact</th><th>Help</th><th>Nodes</th></tr>${axeRows || '<tr><td colspan="4">None</td></tr>'}</table>
</body></html>`;
}

/** Build a Markdown version of the report (same content as the PDF). */
export function buildMarkdownReport({ url, axeResults, ux, summary, generatedAt }) {
  const lines = [
    '# UI/UX + accessibility audit',
    '',
    `URL: ${url}`,
    `Generated: ${generatedAt}`,
    '',
    `Score: ${summary.score}/100`,
    '',
    '## Summary',
    '',
    '| Critical | Serious | Moderate | Minor | Rules failing |',
    '| --- | --- | --- | --- | --- |',
    `| ${summary.counts.critical} | ${summary.counts.serious} | ${summary.counts.moderate} | ${summary.counts.minor} | ${summary.violationCount} |`,
    '',
    '## UX checks',
    '',
    `- Title: ${ux.title || '(missing)'} (${ux.titleLength} chars)`,
    `- html lang: ${ux.lang || '(missing)'}`,
    `- Viewport meta: ${ux.hasViewport ? 'yes' : 'no'}`,
    `- H1 count: ${ux.h1Count}`,
    `- Images / missing alt: ${ux.imageCount} / ${ux.imagesMissingAlt.length}`,
    `- Buttons / unnamed: ${ux.buttonCount} / ${ux.buttonsNoName.length}`,
    `- Links / unnamed: ${ux.linkCount} / ${ux.linksNoName.length}`,
    '',
    `## Findings (${summary.findings.length})`,
    '',
    ...(summary.findings.length > 0
      ? summary.findings.map((f) => `- [${f.level}] ${f.check}\n  Fix: ${f.fix}`)
      : ['No findings 🎉']),
    '',
    '## Axe violations',
    '',
    '| Rule | Impact | Help | Nodes |',
    '| --- | --- | --- | --- |',
    ...((axeResults?.violations ?? []).map(
      (v) => `| ${v.id} | ${v.impact} | ${v.help} | ${v.nodes.length} |`,
    ) || []),
    ...((axeResults?.violations?.length ?? 0) === 0 ? ['_None_'] : []),
    '',
  ];
  return lines.join('\n');
}

/** Render report data to a PDF file (launches its own browser). */
export async function writePdfReport(data, path) {
  const browser = await chromium.launch({ headless: true });
  try {
    const printPage = await browser.newPage();
    await printPage.setContent(buildHtmlReport(data), { waitUntil: 'load' });
    await printPage.pdf({ path, format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }
}

/**
 * Audit a URL with Playwright + axe-core.
 * Writes a PDF (via the printable HTML above) and optionally JSON.
 */
export async function runAudit(url, options = {}) {
  const { outputPdf = 'report.pdf', outputJson = null, outputMd = null, axeRules = DEFAULT_AXE_RULES, timeoutMs = 30000, screenshot = true } = options;
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
    const screenshotDataUri = screenshot
      ? `data:image/png;base64,${(await page.screenshot({ fullPage: true })).toString('base64')}`
      : null;

    if (outputJson) {
      await writeFile(outputJson, JSON.stringify(data, null, 2), 'utf8');
    }

    if (outputMd) {
      await writeFile(outputMd, buildMarkdownReport(data), 'utf8');
    }

    // Render printable HTML in a fresh page, then print to PDF.
    if (outputPdf) {
      const printPage = await browser.newPage();
      await printPage.setContent(buildHtmlReport({ ...data, screenshotDataUri }), { waitUntil: 'load' });
      await printPage.pdf({ path: outputPdf, format: 'A4', printBackground: true });
      await printPage.close();
    }
    return { ...data, screenshotDataUri, outputPdf, outputMd };
  } finally {
    await browser.close();
  }
}

function printHelp() {
  console.log(`ux-report — accessibility & UI/UX report generator (PDF + Markdown)

Usage:
  node index.js [<url>] [--pdf report.pdf] [--md report.md] [--json report.json] [--no-screenshot]
  node index.js --config audit.yaml

With no URL and no --config, you are prompted to paste one.
With no --pdf/--md/--json output flags, you are asked after the audit
which format to export (pdf, markdown, or both).

Config YAML keys: url, outputPdf, outputMd, outputJson, axeRules, timeoutMs, screenshot
`);
}

/** Prompt for one line of input (used for the URL and export questions). */
export async function promptInput(question, def = '') {
  const rl = createInterface({ input: stdinStream, output: stdoutStream });
  try {
    const answer = (await rl.question(`${question}${def ? ` [${def}]` : ''}: `)).trim();
    return answer || def;
  } finally {
    rl.close();
  }
}

// CLI entrypoint (no-op when imported by tests).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // Positional args are those that are not flags and not values of flags.
  const takesValue = new Set(['--pdf', '--md', '--json', '--config']);
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (takesValue.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('--')) positionals.push(a);
  }
  const interactive = stdinStream.isTTY && !args.includes('--no-input');
  try {
    if (args.includes('--help') || args.includes('-h')) {
      printHelp();
    } else {
      let cfg = {};
      if (args.includes('--config')) cfg = await loadConfig(get('--config'));
      let url = positionals[0] ?? cfg.url ?? null;
      if (!url) {
        if (!interactive) throw new Error('No URL provided. Pass a URL or --config audit.yaml');
        url = await promptInput('Paste the URL to audit');
      }
      if (!url) throw new Error('No URL provided.');
      const screenshot = !args.includes('--no-screenshot') && (cfg.screenshot ?? true);
      const explicitPdf = get('--pdf') ?? cfg.outputPdf ?? null;
      const explicitMd = get('--md') ?? cfg.outputMd ?? null;
      const explicitJson = get('--json') ?? cfg.outputJson ?? null;
      const opts = {
        outputPdf: explicitPdf,
        outputMd: explicitMd,
        outputJson: explicitJson,
        axeRules: cfg.axeRules ?? DEFAULT_AXE_RULES,
        timeoutMs: cfg.timeoutMs ?? 30000,
        screenshot,
      };
      const askedLater = interactive && !explicitPdf && !explicitMd && !explicitJson;
      if (!askedLater && !explicitPdf && !explicitMd && !explicitJson) {
        opts.outputPdf = 'report.pdf'; // non-interactive default
      }
      const result = await runAudit(url, opts);
      console.log(`Score ${result.summary.score}/100 — ${result.summary.findings.length} finding(s)`);
      if (result.outputPdf) console.log(`PDF: ${result.outputPdf}`);
      if (result.outputMd) console.log(`Markdown: ${result.outputMd}`);
      if (result.outputJson) console.log(`JSON: ${result.outputJson}`);
      if (askedLater) {
        const choice = (await promptInput('Export format (pdf / md / both)', 'pdf')).toLowerCase();
        const wantPdf = ['pdf', 'both'].includes(choice);
        const wantMd = ['md', 'markdown', 'both'].includes(choice);
        if (!wantPdf && !wantMd) {
          console.log('No export selected — nothing written.');
        } else {
          const base = await promptInput('File name (without extension)', 'report');
          if (wantPdf) {
            const pdfPath = base.endsWith('.pdf') ? base : `${base}.pdf`;
            await writePdfReport(result, pdfPath);
            console.log(`PDF: ${pdfPath}`);
          }
          if (wantMd) {
            const mdPath = base.endsWith('.md') ? base : `${base}.md`;
            await writeFile(mdPath, buildMarkdownReport(result), 'utf8');
            console.log(`Markdown: ${mdPath}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
