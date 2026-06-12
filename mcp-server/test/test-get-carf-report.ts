/**
 * Direct function test for get_carf_report tool.
 * Imports and calls the tool function directly (server registration is Wave 7).
 *
 * Skip gracefully if CELOSCAN_API_KEY is not set.
 */

import { getCarfReport } from '../src/tools/get-carf-report.js';

const DEMO_ADDRESS = '0x46788b60daf46448668c7abaeea4ac8745451c25';

async function main() {
  console.log('=== get_carf_report Integration Test ===\n');

  if (!process.env.CELOSCAN_API_KEY) {
    console.log('⚠ CELOSCAN_API_KEY not set — skipping test');
    return;
  }

  console.log('Calling getCarfReport(address=0x4678..., userJurisdiction=US, 2024-2025)...\n');

  const result = await getCarfReport({
    address: DEMO_ADDRESS,
    network: 'mainnet',
    fromYear: 2024,
    toYear: 2025,
    userJurisdiction: 'US',
  });

  // ── Error check ─────────────────────────────────────────────────────────────

  if ((result as Record<string, unknown>).error) {
    const err = result as { error: string; message?: string };
    console.error(`✗ Tool error: ${err.error} — ${err.message ?? 'no message'}`);
    process.exit(1);
  }

  const data = result as Record<string, unknown>;

  // ── Assertions ───────────────────────────────────────────────────────────────

  const checks = [
    { label: 'has reportingPeriod', pass: typeof data.reportingPeriod === 'string' },
    { label: 'schemaVersion = oecd-carf-v0', pass: data.schemaVersion === 'oecd-carf-v0' },
    { label: 'reportType = CARF', pass: data.reportType === 'CARF' },
    { label: 'userJurisdiction = US', pass: data.userJurisdiction === 'US' },
    { label: 'has csv string', pass: typeof data.csv === 'string' && (data.csv as string).length > 0 },
    { label: 'has csvBase64', pass: typeof data.csvBase64 === 'string' },
    { label: 'has yearSummaries (2 years)', pass: Array.isArray(data.yearSummaries) && (data.yearSummaries as unknown[]).length === 2 },
    { label: 'yearSummaries[0].year = 2024', pass: (data.yearSummaries as { year: number }[])?.[0]?.year === 2024 },
    { label: 'yearSummaries[1].year = 2025', pass: (data.yearSummaries as { year: number }[])?.[1]?.year === 2025 },
    { label: 'has carfMetadata', pass: typeof data.carfMetadata === 'object' },
    { label: 'carfMetadata.frameworkVersion = OECD-CARF-2022', pass: (data.carfMetadata as Record<string, unknown>)?.frameworkVersion === 'OECD-CARF-2022' },
    { label: 'carfMetadata.taxResidency = US', pass: (data.carfMetadata as Record<string, unknown>)?.taxResidency === 'US' },
    { label: 'has summary', pass: typeof data.summary === 'object' },
    { label: 'has summary.byAssetType', pass: typeof (data.summary as Record<string, unknown>)?.byAssetType === 'object' },
    { label: 'filename includes CARF', pass: typeof data.filename === 'string' && (data.filename as string).includes('CARF') },
    { label: 'reportingPeriod covers 2024-2025', pass: typeof data.reportingPeriod === 'string' && (data.reportingPeriod as string).includes('2024') && (data.reportingPeriod as string).includes('2025') },
  ];

  let passed = 0;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.label}`);
    if (c.pass) passed++;
  }

  console.log(`\n  ${passed}/${checks.length} assertions passed`);

  if (passed < checks.length) {
    console.log('\nFull response:', JSON.stringify(data, null, 2).slice(0, 1200));
    process.exit(1);
  }

  // base64 round-trip
  const decoded = Buffer.from(data.csvBase64 as string, 'base64').toString('utf8');
  if (decoded === data.csv) {
    console.log('  ✓ csvBase64 round-trip OK');
  } else {
    console.error('  ✗ csvBase64 round-trip FAILED');
    process.exit(1);
  }

  console.log('\n=== All tests passed ===');
}

main().catch(console.error);
