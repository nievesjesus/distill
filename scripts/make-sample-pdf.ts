import { writeFileSync } from 'node:fs';
import { makeSamplePdf } from '../tests/fixtures/make-pdf';

const target = process.argv[2];
if (!target) {
  console.error('usage: make-sample-pdf <output.pdf>');
  process.exit(1);
}
writeFileSync(target, makeSamplePdf(['Example Co. - Report', '', 'Quarterly summary of revenue and costs.', 'Revenue 1200 steady']));
