import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHtmlReport, buildMarkdownReport, loadConfig, summarizeResults } from '../index.js';

const fakeUx = {
  title: 'Test page',
  titleLength: 9,
  hasTitle: true,
  lang: 'en',
  hasLang: true,
  hasViewport: true,
  h1Count: 1,
  h1Ok: true,
  imageCount: 1,
  imagesMissingAlt: [],
  buttonCount: 1,
  buttonsNoName: [],
  linkCount: 1,
  linksNoName: [],
  loadTimeMs: 100,
  domContentLoadedMs: 50,
};

describe('summarizeResults', () => {
  it('scores 100 with no violations and clean UX', () => {
    const s = summarizeResults({ violations: [] }, fakeUx);
    assert.equal(s.score, 100);
    assert.equal(s.findings.length, 0);
  });

  it('flags missing alt text and axe violations', () => {
    const ux = { ...fakeUx, imagesMissingAlt: ['https://x/img.png'] };
    const axe = {
      violations: [{ id: 'image-alt', impact: 'critical', help: 'Images must have alt', nodes: [{}, {}] }],
    };
    const s = summarizeResults(axe, ux);
    assert.equal(s.counts.critical, 2);
    assert.ok(s.findings.some((f) => f.check.includes('missing alt')));
    assert.ok(s.findings.some((f) => f.check.includes('axe: image-alt')));
    assert.ok(s.score < 100);
  });
});

describe('buildHtmlReport', () => {
  it('embeds url, score and findings', () => {
    const summary = summarizeResults({ violations: [] }, fakeUx);
    const html = buildHtmlReport({
      url: 'https://example.com',
      axeResults: { violations: [] },
      ux: fakeUx,
      summary,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.ok(html.includes('https://example.com'));
    assert.ok(html.includes('100/100'));
    assert.ok(!html.includes('<img'), 'no screenshot section without screenshotDataUri');
  });

  it('embeds the screenshot when screenshotDataUri is provided', () => {
    const summary = summarizeResults({ violations: [] }, fakeUx);
    const html = buildHtmlReport({
      url: 'https://example.com',
      axeResults: { violations: [] },
      ux: fakeUx,
      summary,
      generatedAt: '2026-01-01T00:00:00.000Z',
      screenshotDataUri: 'data:image/png;base64,iVBORw0KGgo=',
    });
    assert.ok(html.includes('<img src="data:image/png;base64,iVBORw0KGgo="'));
  });
});

describe('buildMarkdownReport', () => {
  it('mirrors the html report content in markdown', () => {
    const summary = summarizeResults({ violations: [] }, fakeUx);
    const md = buildMarkdownReport({
      url: 'https://example.com',
      axeResults: { violations: [] },
      ux: fakeUx,
      summary,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.ok(md.includes('# UI/UX + accessibility audit'));
    assert.ok(md.includes('https://example.com'));
    assert.ok(md.includes('Score: 100/100'));
    assert.ok(md.includes('## Findings (0)'));
  });

  it('lists findings and violations', () => {
    const ux = { ...fakeUx, imagesMissingAlt: ['https://x/img.png'] };
    const axe = {
      violations: [{ id: 'image-alt', impact: 'critical', help: 'Images must have alt', nodes: [{}] }],
    };
    const md = buildMarkdownReport({
      url: 'https://example.com',
      axeResults: axe,
      ux,
      summary: summarizeResults(axe, ux),
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.ok(md.includes('missing alt'));
    assert.ok(md.includes('| image-alt | critical | Images must have alt | 1 |'));
  });
});

describe('loadConfig', () => {
  it('rejects non-mapping yaml', async () => {
    await assert.rejects(() => loadConfig('./test/fixtures/list.yaml'), /expected a YAML mapping/);
  });
});
