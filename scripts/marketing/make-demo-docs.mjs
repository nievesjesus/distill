import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const docsDir = join(root, '.cache', 'marketing', 'docs');

const css = `
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; color: #1b1f24; line-height: 1.45; margin: 0; }
  h1 { font-size: 24pt; margin: 0 0 8pt; }
  h2 { font-size: 14pt; margin: 14pt 0 6pt; border-bottom: 1px solid #ccc; padding-bottom: 3pt; }
  p { margin: 0 0 7pt; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 12pt; font-size: 9.5pt; }
  th, td { border: 1px solid #d0d4da; padding: 6pt 12pt; text-align: left; }
  th { background: #eef0f3; }
  td.n, th.n { text-align: right; }
  .sheet { width: 8.5in; height: 11in; padding: 1.45in 0.8in 1.3in; position: relative; overflow: hidden; page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
  .run-head { position: absolute; top: 0.95in; left: 0.8in; right: 0.8in; font-size: 10.5pt; color: #333; }
  .run-foot { position: absolute; bottom: 0.7in; left: 0.8in; right: 0.8in; font-size: 10.5pt; color: #333; display: flex; justify-content: space-between; }
  .ledger table { font-size: 8.5pt; }
  .ledger th, .ledger td { padding: 3.5pt 7pt; border: none; background: none; }
  .ledger th { border-bottom: 1px solid #999; }
  .run-page { position: absolute; bottom: 0.45in; left: 0; right: 0; text-align: center; font-size: 10.5pt; color: #333; }
  a { color: #1a56c4; }
  .small { font-size: 9pt; color: #555; }
`;

function table(headers, rows, numeric = []) {
  const head = headers.map((h, i) => `<th class="${numeric.includes(i) ? 'n' : ''}">${h}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${numeric.includes(i) ? 'n' : ''}">${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function sheets(label, pages) {
  const total = pages.length;
  return pages
    .map((page, i) => {
      const extra = /^<div class="page ?([^"]*)">/.exec(page)?.[1] ?? '';
      const inner = page.replace(/^<div class="page[^"]*">/, '').replace(/<\/div>$/, '');
      return `<section class="sheet ${extra}"><div class="run-head">${label}</div>${inner}<div class="run-foot"><span>${label}</span></div><div class="run-page">Page ${i + 1} of ${total}</div></section>`;
    })
    .join('');
}

function financialReport() {
  const rand = seeded(7);
  const regions = ['North America', 'EMEA', 'APAC', 'LATAM', 'Public Sector'];
  const products = ['Aurora Platform', 'Beacon Analytics', 'Cobalt Connect', 'Delta Vault', 'Ember Insights', 'Flux Pipeline'];
  const months = ['July', 'August', 'September'];
  const pages = [];
  pages.push(`<div class="page"><h1>Q3 2026 Financial Report</h1><p class="small">Northwind Labs, Inc. Confidential, for internal distribution only. Prepared by the Finance &amp; Strategy team.</p>
    <h2>Executive summary</h2>
    <p>Northwind Labs closed the third quarter of fiscal 2026 with revenue of $48.2 million, up 21 percent year over year, and an operating margin of 17.4 percent. Recurring revenue accounted for 88 percent of the total, and net revenue retention held at 112 percent for the trailing twelve months.</p>
    <p>The quarter was shaped by three developments: the general availability of Aurora Platform 4.0, the expansion of the EMEA sales team, and the migration of 64 percent of enterprise workloads to the new regional data centers. Each is discussed in the sections that follow. Detailed methodology is published at <a href="https://northwind.example/investors/methodology?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">northwind.example/investors/methodology</a>.</p>
    ${table(['Metric', 'Q3 2026', 'Q2 2026', 'Q3 2025', 'YoY change'], [
      ['Total revenue ($M)', '48.2', '45.1', '39.8', '+21.1%'],
      ['Recurring revenue ($M)', '42.4', '39.9', '33.2', '+27.7%'],
      ['Gross margin', '74.8%', '73.9%', '71.2%', '+3.6 pts'],
      ['Operating margin', '17.4%', '15.2%', '11.0%', '+6.4 pts'],
      ['Net revenue retention', '112%', '111%', '106%', '+6 pts'],
      ['Customers (&gt;$100k ARR)', '412', '389', '310', '+32.9%'],
    ], [1, 2, 3, 4])}</div>`);
  for (const [idx, region] of regions.entries()) {
    const rows = products.map((p) => {
      const q3 = Math.round(500 + rand() * 2400) * 10;
      const q2 = Math.round(q3 * (0.88 + rand() * 0.1));
      const q3p = Math.round(q3 * (0.74 + rand() * 0.14));
      return [p, fmt(q3), fmt(q2), fmt(q3p), `${(((q3 - q3p) / q3p) * 100).toFixed(1)}%`];
    });
    const monthly = months.map((m) => {
      const bookings = Math.round(1200 + rand() * 900);
      const churn = (1 + rand() * 1.4).toFixed(2);
      return [m, fmt(bookings), `${churn}%`, fmt(Math.round(bookings * 0.31)), fmt(Math.round(bookings * 0.12))];
    });
    pages.push(`<div class="page"><h2>${idx + 2}. ${region}: revenue and bookings</h2>
      <p>${region} delivered a solid quarter, with bookings ahead of plan in two of three months. Pipeline coverage entering Q4 stands at ${(2.8 + rand()).toFixed(1)}x, supported by the new partner program announced in August. See the <a href="https://northwind.example/investors/${region.toLowerCase().replace(/[^a-z]+/g, '-')}">regional dashboard</a> for weekly updates.</p>
      <p>Revenue by product line, in thousands of dollars, is shown below. Figures are unaudited and may be revised in the Form 10-Q.</p>
      ${table(['Product line', 'Q3 2026', 'Q2 2026', 'Q3 2025', 'Growth YoY'], rows, [1, 2, 3, 4])}
      <p>Monthly bookings, churn and expansion for the quarter, in thousands of dollars:</p>
      ${table(['Month', 'New bookings', 'Gross churn', 'Expansion', 'Services'], monthly, [1, 2, 3, 4])}
      <p>Management expects ${region} to remain the primary growth driver through fiscal 2027, subject to currency and procurement cycles. Headcount in the region grew by ${Math.round(6 + rand() * 18)} during the quarter.</p></div>`);
  }
  const segments = ['Enterprise', 'Mid-market', 'Small business', 'Public sector', 'Partners', 'Self-serve'];
  for (const part of ['Customer segments', 'Cohort retention']) {
    const rows = segments.map((seg) => {
      const a = Math.round(300 + rand() * 4200);
      return [seg, fmt(a), fmt(Math.round(a * (0.9 + rand() * 0.2))), `${(88 + rand() * 24).toFixed(1)}%`, `${(1 + rand() * 4).toFixed(2)}%`, fmt(Math.round(a * 0.37))];
    });
    const rows2 = ['2022', '2023', '2024', '2025', '2026'].map((y) => [`${y} cohort`, ...[1, 2, 3, 4].map(() => `${(70 + rand() * 40).toFixed(1)}%`)]);
    pages.push(`<div class="page"><h2>${pages.length}. ${part}</h2><p>${part} metrics are computed on a trailing twelve month basis and exclude one-time services revenue. Definitions are documented in the <a href="https://northwind.example/investors/definitions?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">metrics glossary</a>.</p>
      ${table(['Segment', 'ARR Q3 ($K)', 'ARR Q2 ($K)', 'NRR', 'Logo churn', 'Net new ($K)'], rows, [1, 2, 3, 4, 5])}
      ${table(['Cohort', 'Year 1', 'Year 2', 'Year 3', 'Year 4'], rows2, [1, 2, 3, 4])}
      ${table(['Quarter', 'New logos', 'Expansion ($K)', 'Contraction ($K)', 'Churned ($K)', 'Ending ARR ($K)'], ['Q4 2025', 'Q1 2026', 'Q2 2026', 'Q3 2026'].map((q) => [q, fmt(Math.round(40 + rand() * 60)), fmt(Math.round(900 + rand() * 900)), fmt(Math.round(100 + rand() * 200)), fmt(Math.round(200 + rand() * 300)), fmt(Math.round(150000 + rand() * 40000))]), [1, 2, 3, 4, 5])}</div>`);
  }
  const detailRows = (offset) =>
    Array.from({ length: 18 }, (_, i) => {
      const base = Math.round(800 + rand() * 3200);
      return [`${regions[(i + offset) % 5]} / ${products[i % 6]}`, fmt(base), fmt(Math.round(base * 0.94)), fmt(Math.round(base * 1.06)), `${(rand() * 9 - 2).toFixed(1)}%`, fmt(Math.round(base * 0.31)), fmt(Math.round(base * 0.12)), `${(60 + rand() * 30).toFixed(1)}%`];
    });
  for (const [title, off] of [['Appendix A: revenue detail by region and product', 0], ['Appendix B: bookings detail by region and product', 2]]) {
    pages.push(`<div class="page"><h2>${title}</h2><p>All figures in thousands of dollars. Source: general ledger, closed books as of October 9, 2026. Reconciliation notes are in the <a href="https://northwind.example/finance/close-calendar/q3-2026/reconciliation-notes?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">close package</a>.</p>
      ${table(['Region / product', 'Actual', 'Plan', 'Forecast', 'Var', 'Recurring', 'Services', 'Margin'], detailRows(off), [1, 2, 3, 4, 5, 6, 7])}</div>`);
  }
  const opex = [
    ['Research and development', '11,820', '11,240', '9,870'],
    ['Sales and marketing', '17,460', '16,980', '15,120'],
    ['General and administrative', '5,310', '5,190', '4,880'],
    ['Depreciation and amortization', '1,940', '1,880', '1,760'],
    ['Stock-based compensation', '3,720', '3,540', '3,010'],
    ['Total operating expenses', '40,250', '38,830', '34,640'],
  ];
  pages.push(`<div class="page"><h2>7. Operating expenses</h2><p>Operating expenses rose 3.7 percent sequentially, below the pace of revenue growth, reflecting disciplined hiring and the first full quarter of the vendor consolidation program.</p>
    ${table(['Category ($K)', 'Q3 2026', 'Q2 2026', 'Q3 2025'], opex, [1, 2, 3])}
    <p>Capital expenditure was $6.4 million, concentrated in the Frankfurt and Singapore data center build-outs. Free cash flow reached $9.1 million for the quarter.</p></div>`);
  pages.push(`<div class="page"><h2>8. Outlook and guidance</h2><p>For the fourth quarter of fiscal 2026, Northwind Labs expects revenue between $50.5 million and $52.0 million and an operating margin between 17 and 19 percent. Full-year revenue is expected to be $189 to $191 million.</p>
    ${table(['Guidance item', 'Q4 2026 low', 'Q4 2026 high', 'FY 2026 low', 'FY 2026 high'], [
      ['Revenue ($M)', '50.5', '52.0', '189.0', '191.0'],
      ['Operating margin', '17%', '19%', '15.8%', '16.6%'],
      ['Capital expenditure ($M)', '5.5', '6.5', '24.0', '25.0'],
    ], [1, 2, 3, 4])}
    <p class="small">This document contains forward-looking statements. Actual results may differ materially. Contact investor-relations@northwind.example with questions.</p></div>`);
  return pages;
}

function roadmap() {
  const rand = seeded(21);
  const themes = [
    ['Foundation', ['Single sign-on for all tiers', 'Audit log export', 'Regional data residency', 'Role-based access v2']],
    ['Intelligence', ['Semantic search across workspaces', 'Auto-tagging of incoming records', 'Anomaly alerts', 'Natural language reports']],
    ['Integrations', ['Webhook retries and replay', 'Marketplace for connectors', 'Bi-directional CRM sync', 'Streaming export API']],
    ['Experience', ['Redesigned onboarding', 'Mobile offline mode', 'Keyboard-first navigation', 'Accessibility conformance audit']],
  ];
  const quarters = ['Q4 2026', 'Q1 2027', 'Q2 2027', 'Q3 2027'];
  const status = ['Planned', 'In design', 'In progress', 'Shipped'];
  const pages = [];
  pages.push(`<div class="page"><h1>Helios Product Roadmap</h1><p class="small">Brightpath Software. Product &amp; Engineering. Version 2026.4. Subject to change; not a commitment.</p>
    <h2>Vision</h2><p>Helios turns scattered operational data into decisions the whole team can trust. Over the next four quarters we focus on four themes: foundation, intelligence, integrations and experience. The full changelog lives at <a href="https://brightpath.example/helios/changelog?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">brightpath.example/helios/changelog</a>.</p>
    <p>Priorities were set using customer interviews, support volume, and the quarterly planning survey described in <a href="https://brightpath.example/helios/planning?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">our planning notes</a>.</p></div>`);
  for (const [theme, items] of themes) {
    const rows = items.map((item, i) => [
      item,
      quarters[Math.min(3, i)],
      status[Math.floor(rand() * 4)],
      ['Platform', 'Data', 'Growth', 'Design'][Math.floor(rand() * 4)],
      `${Math.round(3 + rand() * 14)} eng-weeks`,
    ]);
    pages.push(`<div class="page"><h2>Theme: ${theme}</h2><p>The ${theme.toLowerCase()} theme groups work that unblocks the largest number of customer requests. Each initiative has an owner, a target quarter and an estimated engineering cost.</p>
      ${table(['Initiative', 'Target', 'Status', 'Owning team', 'Estimate'], rows)}
      ${items.map((item) => `<h2>${item}</h2><p>${item} addresses a recurring request from enterprise customers and reduces manual work for administrators. Success is measured by adoption within 90 days of release and by a reduction in related support tickets of at least 15 percent. Design documents are linked in the <a href="https://brightpath.example/helios/specs/${item.toLowerCase().replace(/[^a-z]+/g, '-')}">spec index</a>.</p>`).join('')}</div>`);
  }
  const matrix = ['Single sign-on', 'Audit log export', 'Data residency', 'Role-based access', 'Semantic search', 'Auto-tagging', 'Anomaly alerts', 'Webhook replay', 'Connector marketplace', 'CRM sync', 'Streaming export', 'Offline mobile', 'Custom dashboards', 'Scheduled reports', 'Sandbox tenants', 'Priority support'];
  const tiers = ['Free', 'Team', 'Business', 'Enterprise'];
  pages.push(`<div class="page"><h2>Feature availability by plan</h2><p>Planned availability once each initiative ships. Entitlements may change before launch; see the <a href="https://brightpath.example/helios/pricing/entitlements?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">entitlements page</a>.</p>
    ${table(['Capability', ...tiers, 'Owner', 'Target'], matrix.map((m, i) => [m, ...tiers.map((_, t) => (i + t * 3) % 5 < 2 + t ? 'Yes' : 'No'), ['Platform', 'Data', 'Growth', 'Design'][i % 4], quarters[i % 4]]))}</div>`);
  const refs = ['interviews/2026/q3/enterprise-admins', 'interviews/2026/q3/data-engineers', 'surveys/2026/q3/planning-survey-results', 'support/2026/q3/top-ticket-themes', 'benchmarks/2026/q3/query-latency-report', 'benchmarks/2026/q3/ingest-throughput-report', 'security/2026/q3/pentest-summary', 'accessibility/2026/q3/wcag-audit-findings', 'competitive/2026/q3/market-landscape', 'pricing/2026/q3/packaging-experiments'];
  pages.push(`<div class="page"><h2>References</h2><p>Supporting research and data behind the priorities in this roadmap:</p>
    <ol>${refs.map((r) => `<li><a href="https://brightpath.example/helios/research/${r}?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">Helios research: ${r.split('/').pop().replace(/-/g, ' ')}</a>. Reviewed by the product council in the third quarter and archived with the planning notes.</li>`).join('')}</ol></div>`);
  const rows = quarters.map((q) => [q, `${Math.round(40 + rand() * 30)}`, `${Math.round(8 + rand() * 12)}`, `${Math.round(15 + rand() * 20)}`, `${Math.round(70 + rand() * 25)}%`]);
  pages.push(`<div class="page"><h2>Capacity plan</h2><p>Engineering capacity by quarter, after accounting for on-call load and maintenance work.</p>
    ${table(['Quarter', 'Feature work (eng-weeks)', 'Maintenance', 'Reliability', 'Allocation used'], rows, [1, 2, 3, 4])}</div>`);
  return pages;
}

function contract() {
  const clauses = [
    ['Definitions', 'In this Agreement, "Services" means the cloud-hosted analytics services described in Schedule A; "Customer Data" means all data submitted by the Customer to the Services; and "Effective Date" means the date of last signature below.'],
    ['Term and Renewal', 'This Agreement begins on the Effective Date and continues for an initial term of thirty-six (36) months. Thereafter it renews automatically for successive twelve (12) month terms unless either party gives written notice of non-renewal at least ninety (90) days before the end of the then-current term.'],
    ['Fees and Payment', 'The Customer shall pay the fees set out in Schedule B within thirty (30) days of the invoice date. Late amounts accrue interest at 1.5 percent per month or the maximum rate permitted by law, whichever is lower. All fees are exclusive of applicable taxes.'],
    ['Service Levels', 'The Vendor shall make the Services available at least 99.9 percent of the time in each calendar month, excluding scheduled maintenance announced at least five (5) business days in advance. Service credits are the Customer\'s sole remedy for availability failures.'],
    ['Confidentiality', 'Each party shall protect the other party\'s Confidential Information with at least the same degree of care it uses for its own, and no less than reasonable care. These obligations survive for five (5) years after termination of this Agreement.'],
    ['Data Protection', 'The Vendor shall process Customer Data only on documented instructions from the Customer and shall implement the technical and organizational measures described in Schedule C. The Vendor shall notify the Customer of any personal data breach without undue delay and in any event within seventy-two (72) hours.'],
    ['Limitation of Liability', 'Except for liability that cannot be limited by law, each party\'s aggregate liability arising out of this Agreement shall not exceed the fees paid or payable in the twelve (12) months preceding the claim. Neither party is liable for indirect or consequential losses.'],
    ['Termination', 'Either party may terminate this Agreement for material breach that remains uncured thirty (30) days after written notice. On termination the Vendor shall make Customer Data available for export for a period of sixty (60) days.'],
  ];
  const pages = [];
  pages.push(`<div class="page"><h1>Master Services Agreement</h1><p class="small">Between Granite Ridge Systems Ltd. ("Vendor") and Halcyon Freight Group ("Customer"). Reference MSA-2026-0417.</p>
    <p>This Master Services Agreement ("Agreement") is entered into by the parties identified above. The parties agree as follows. Policies referenced in this Agreement are available at <a href="https://graniteridge.example/legal/policies?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">graniteridge.example/legal/policies</a>.</p>
    ${clauses.slice(0, 2).map(([t, b], i) => `<h2>${i + 1}. ${t}</h2><p>${b}</p><p>${i + 1}.1 The parties acknowledge that the provisions of this section have been negotiated at arm's length and reflect a fair allocation of risk. ${i + 1}.2 Any amendment to this section must be made in writing and signed by authorized representatives of both parties.</p>`).join('')}</div>`);
  pages.push(`<div class="page">${clauses.slice(2, 5).map(([t, b], i) => `<h2>${i + 3}. ${t}</h2><p>${b}</p><p>${i + 3}.1 The parties acknowledge that the provisions of this section have been negotiated at arm's length and reflect a fair allocation of risk. ${i + 3}.2 Any amendment to this section must be made in writing and signed by authorized representatives of both parties.</p>`).join('')}</div>`);
  pages.push(`<div class="page">${clauses.slice(5).map(([t, b], i) => `<h2>${i + 6}. ${t}</h2><p>${b}</p><p>${i + 6}.1 The parties acknowledge that the provisions of this section have been negotiated at arm's length and reflect a fair allocation of risk. ${i + 6}.2 Any amendment to this section must be made in writing and signed by authorized representatives of both parties.</p>`).join('')}</div>`);
  pages.push(`<div class="page"><h2>Schedule A: Services</h2>
    ${table(['Service', 'Description', 'Metric', 'Included volume'], [
      ['Analytics Core', 'Dashboards, saved queries and scheduled reports', 'Named users', '250'],
      ['Data Ingest', 'Batch and streaming ingestion from customer systems', 'Events per month', '500,000,000'],
      ['Premium Support', '24x7 incident response with named contacts', 'Severity 1 response', '30 minutes'],
      ['Sandbox Environment', 'Non-production tenant for testing', 'Environments', '2'],
    ])}
    <h2>Schedule B: Fees</h2>
    ${table(['Item', 'Unit price (USD)', 'Quantity', 'Annual fee (USD)'], [
      ['Analytics Core', '960.00', '250', '240,000.00'],
      ['Data Ingest', '0.00024', '500,000,000', '120,000.00'],
      ['Premium Support', 'flat', '1', '48,000.00'],
      ['Sandbox Environment', '6,000.00', '2', '12,000.00'],
      ['Total', '', '', '420,000.00'],
    ], [1, 2, 3])}</div>`);
  const subs = ['Cobalt Hosting GmbH', 'Meridian Email Services', 'Tidewater Logging Inc.', 'Quartz Payments Ltd.', 'Alder Support Partners', 'Vantage Backup Systems', 'Lumen CDN Networks', 'Pinnacle Identity Co.', 'Harbor Monitoring Ltd.', 'Orchid Translation Labs'];
  const locations = ['Frankfurt, DE', 'Dublin, IE', 'Virginia, US', 'Singapore, SG', 'Toronto, CA'];
  pages.push(`<div class="page"><h2>Schedule D: Approved sub-processors</h2><p>The Vendor may engage the following sub-processors. Notice of additions is published at <a href="https://graniteridge.example/legal/subprocessors/changes?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">graniteridge.example/legal/subprocessors/changes</a>.</p>
    ${table(['Sub-processor', 'Purpose', 'Location', 'Certification', 'Data category'], subs.map((n, i) => [n, ['Hosting', 'Email delivery', 'Log storage', 'Billing', 'Support tooling'][i % 5], locations[i % 5], ['ISO 27001', 'SOC 2 Type II', 'ISO 27018'][i % 3], ['Customer Data', 'Account data', 'Usage metadata'][i % 3]]))}</div>`);
  const docsRef = ['acceptable-use-policy', 'data-processing-addendum', 'service-level-schedule', 'security-whitepaper', 'business-continuity-plan', 'incident-response-summary', 'insurance-certificates', 'privacy-notice'];
  pages.push(`<div class="page"><h2>Schedule E: Incorporated documents</h2><p>The following documents are incorporated by reference. In the event of conflict, this Agreement prevails.</p>
    <ol>${docsRef.map((d) => `<li><a href="https://graniteridge.example/legal/documents/${d}/v2026-04?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">${d.replace(/-/g, ' ')}</a>, version 2026-04, as published on the Vendor trust portal.</li>`).join('')}</ol></div>`);
  pages.push(`<div class="page"><h2>Schedule C: Security measures</h2><p>The Vendor maintains an information security program aligned with ISO/IEC 27001, including encryption of Customer Data at rest and in transit, role-based access control, quarterly penetration tests, and annual third-party audits. The current attestation summary is at <a href="https://graniteridge.example/trust?utm_source=internal-report&utm_medium=pdf&utm_campaign=2026-q3-review">graniteridge.example/trust</a>.</p>
    <h2>Signatures</h2>
    ${table(['', 'Vendor', 'Customer'], [
      ['Name', 'Marta Okonkwo', 'Daniel Reyes'],
      ['Title', 'Chief Revenue Officer', 'VP Operations'],
      ['Signature', '', ''],
      ['Date', '', ''],
    ])}</div>`);
  return pages;
}

function ledger() {
  const rand = seeded(99);
  const reps = ['A. Moreau', 'J. Tanaka', 'L. Okafor', 'P. Silva', 'R. Haddad', 'S. Lindqvist', 'T. Novak', 'Y. Chen'];
  const items = ['Starter license', 'Team license', 'Enterprise license', 'Onboarding package', 'Premium support', 'Training workshop', 'API add-on', 'Storage add-on'];
  const pages = [];
  let order = 41000;
  for (let pg = 0; pg < 7; pg += 1) {
    const rows = Array.from({ length: 24 }, () => {
      order += 1 + Math.floor(rand() * 4);
      const qty = 1 + Math.floor(rand() * 40);
      const price = [490, 1900, 7400, 2500, 3600, 1200, 800, 600][Math.floor(rand() * 8)];
      const gross = qty * price;
      const disc = Math.round(rand() * 18);
      return [`SO-${order}`, `2026-0${7 + (pg % 3)}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`, items[Math.floor(rand() * 8)], reps[Math.floor(rand() * 8)], qty, fmt(price), `${disc}%`, fmt(Math.round(gross * (1 - disc / 100))), ['Paid', 'Invoiced', 'Pending'][Math.floor(rand() * 3)]];
    });
    pages.push(`<div class="page ledger"><h2>Order ledger, part ${pg + 1}</h2>${table(['Order', 'Date', 'Item', 'Rep', 'Qty', 'Unit ($)', 'Disc.', 'Net ($)', 'Status'], rows, [4, 5, 6, 7])}</div>`);
  }
  return pages;
}

function inventory() {
  const rand = seeded(5150);
  const products = ['Hex bolt M8', 'Ball bearing 6204', 'Steel bracket L', 'Pallet wrap 500mm', 'LED panel 60x60', 'Cable gland PG16', 'Rubber gasket 40mm', 'Thermal paste 30g', 'Safety gloves L', 'Copper pipe 22mm', 'Fuse 16A slow', 'Zip ties 300mm'];
  const warehouses = ['Rotterdam DC', 'Memphis Hub', 'Osaka North', 'Lyon Central', 'Austin West'];
  const statuses = ['In stock', 'Low stock', 'Reorder', 'Backorder', 'In stock'];
  const pages = [];
  let sku = 700100;
  for (let pg = 0; pg < 9; pg += 1) {
    const rows = Array.from({ length: 22 }, () => {
      sku += 1 + Math.floor(rand() * 9);
      const qty = Math.floor(rand() * 4800);
      const cost = Math.round((0.4 + rand() * 90) * 100) / 100;
      return [`NW-${sku}`, products[Math.floor(rand() * products.length)], warehouses[Math.floor(rand() * 5)], fmt(qty), cost.toFixed(2), fmt(Math.round(qty * cost * 100) / 100), statuses[Math.floor(rand() * 5)], `2026-09-${String(1 + Math.floor(rand() * 30)).padStart(2, '0')}`];
    });
    pages.push(`<div class="page ledger"><h2>Stock position, part ${pg + 1}</h2>${table(['SKU', 'Product', 'Warehouse', 'Qty', 'Unit cost', 'Total', 'Status', 'Updated'], rows, [3, 4, 5])}</div>`);
  }
  return pages;
}

const docs = [
  { file: 'q3-financial-report.pdf', header: 'Northwind Labs — Q3 2026 Report — Internal', pages: financialReport() },
  { file: 'sales-ledger.pdf', header: 'Orbit Retail Group — Q3 2026 Order Ledger Export — Finance', pages: ledger() },
  { file: 'inventory-export.pdf', header: 'Northwind Labs — Inventory Export — Operations', pages: inventory() },
  { file: 'product-roadmap.pdf', header: 'Brightpath Software — Helios Roadmap 2026.4 — Confidential', pages: roadmap() },
  { file: 'vendor-contract.pdf', header: 'Granite Ridge Systems — Master Services Agreement MSA-2026-0417', pages: contract() },
];

export async function makeDemoDocs() {
  mkdirSync(docsDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const doc of docs) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${sheets(doc.header, doc.pages)}</body></html>`);
    await page.pdf({
      path: join(docsDir, doc.file),
      preferCSSPageSize: true,
      printBackground: true,
    });
    console.log(`wrote ${join(docsDir, doc.file)}`);
  }
  await browser.close();
  return docs.map((doc) => join(docsDir, doc.file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await makeDemoDocs();
}
