/**
 * Kal — w3 soak harness evidence printer (test/e2e/w3-soak/**).
 *
 * Emits the per-profile evidence table the GR gate re-runs against: counts
 * (ops pushed/acked/duplicated/lost=0), fault counts, invariant-check
 * results, and runtimes. Written to stdout so the run log IS the evidence
 * artifact (per-profile run logs with counts — task contract).
 */
import type { ProfileReportRow } from './invariants.js';

export function printHeader(invocation: string, runLabel: string): void {
  process.stdout.write(`\n=== w3 soak harness — ${runLabel} ===\n`);
  process.stdout.write(`invocation: ${invocation}\n`);
  process.stdout.write(`release gate: zero duplicates, zero losses, convergence on the frozen tiebreak (task s4b; criterion 9)\n\n`);
}

export function printProfileChecks(profile: string, checks: ReadonlyArray<{ readonly name: string; readonly pass: boolean; readonly detail: string }>, findings: ReadonlyArray<string> = []): void {
  process.stdout.write(`\n-- ${profile}: invariant checks\n`);
  for (const check of checks) {
    process.stdout.write(`   ${check.pass ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}\n`);
  }
  for (const finding of findings) {
    process.stdout.write(`   FINDING  ${finding}\n`);
  }
}

export function printProfileTable(rows: readonly ProfileReportRow[]): void {
  const columns: Array<{ readonly header: string; readonly value: (row: ProfileReportRow) => string }> = [
    { header: 'profile', value: (row) => row.profile },
    { header: 'users/dev', value: (row) => `${String(row.users)}/${String(row.devices)}` },
    { header: 'ops', value: (row) => String(row.opsEnqueued) },
    { header: 'acked', value: (row) => String(row.acksApplied) },
    { header: 'dup-acks', value: (row) => String(row.acksDuplicate) },
    { header: 'rej-term', value: (row) => String(row.acksRejectedTerminal) },
    { header: 'drops-pre', value: (row) => String(row.faultsDropsBefore) },
    { header: 'drops-post', value: (row) => String(row.faultsDropsAfter) },
    { header: 'stalls', value: (row) => String(row.faultsStalls) },
    { header: 'refused', value: (row) => String(row.faultsRefused) },
    { header: 'dup-deliv', value: (row) => String(row.faultsDuplicates) },
    { header: 'byte-replays', value: (row) => String(row.byteIdenticalReplays) },
    { header: 'push-retry', value: (row) => String(row.pushRetries) },
    { header: 'pull-retry', value: (row) => String(row.pullRetries) },
    { header: 'pages', value: (row) => String(row.pagesPulled) },
    { header: 'changes', value: (row) => String(row.changesReceived) },
    { header: 'census', value: (row) => String(row.censusChanges) },
    { header: 'checks', value: (row) => String(row.checks) },
    { header: 'violations', value: (row) => (row.violations === 0 ? '0' : `!! ${String(row.violations)}`) },
    { header: 'ms', value: (row) => String(row.runtimeMs) },
  ];
  const header = columns.map((column) => column.header);
  const table = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = header.map((cell, index) => Math.max(cell.length, ...table.map((line) => line[index]?.length ?? 0)));
  const line = (cells: readonly string[]): string => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(' | ');
  process.stdout.write(`\n-- per-profile results (dupes=0/losses=0 enforced by checks)\n`);
  process.stdout.write(`${line(header)}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('-+-')}\n`);
  for (const cells of table) {
    process.stdout.write(`${line(cells)}\n`);
  }
  process.stdout.write('\n');
}

export function printVerdict(rows: readonly ProfileReportRow[], totalViolations: number, runtimeMs: number): void {
  const green = totalViolations === 0 && rows.every((row) => row.violations === 0);
  process.stdout.write(
    green
      ? `\nSOAK VERDICT: GREEN — ${String(rows.length)} profiles, ${String(rows.reduce((sum, row) => sum + row.checks, 0))} invariant checks, 0 violations, ${String(runtimeMs)}ms total\n`
      : `\nSOAK VERDICT: RED — ${String(totalViolations)} violations across ${String(rows.length)} profiles\n`,
  );
}
