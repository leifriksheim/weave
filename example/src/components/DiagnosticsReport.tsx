import { useState } from 'react';
import type { PasskeyDiagnostics } from 'weave-protocol';
import { styles } from '../styles';

/**
 * Shows what the browser and credential provider actually did with the PRF
 * request, so a failure can be pinned on a link in the chain instead of guessed.
 */
export function DiagnosticsReport({
  report,
  onRun,
  running,
}: {
  report: PasskeyDiagnostics | null;
  onRun: () => void;
  running: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!report) return;
    try {
      await globalThis.navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div style={styles.diagnostics}>
      <button onClick={onRun} disabled={running} data-variant="ghost" style={styles.linkButton}>
        {running ? 'Running…' : report ? 'Run diagnostics again' : 'Run passkey diagnostics'}
      </button>

      {report && (
        <>
          <p style={{ ...styles.errorHint, color: report.prfWorks ? '#22c55e' : '#a98a8a' }}>
            {report.summary}
          </p>
          <dl style={styles.factList}>
            <Fact label="Provider" value={report.provider.name ?? report.provider.aaguid ?? 'unknown'} />
            <Fact
              label="Declared at create"
              value={
                report.prfDeclaredAtCreate === undefined
                  ? 'nothing reported'
                  : String(report.prfDeclaredAtCreate)
              }
            />
            <Fact
              label="Secret from create"
              value={report.create.prfOutputBytes ? `${report.create.prfOutputBytes} bytes` : 'none'}
            />
            <Fact
              label="Secret from assertion"
              value={report.assert.prfOutputBytes ? `${report.assert.prfOutputBytes} bytes` : 'none'}
            />
            {report.create.error && <Fact label="Create error" value={report.create.error} />}
            {report.assert.error && <Fact label="Assertion error" value={report.assert.error} />}
          </dl>
          <code style={styles.token}>
            {JSON.stringify({ create: report.create, assert: report.assert }, null, 1)}
          </code>
          <button onClick={copy} data-variant="ghost" style={styles.linkButton}>
            {copied ? 'Copied' : 'Copy full report'}
          </button>
        </>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={styles.factLabel}>{label}</dt>
      <dd style={styles.factValue}>{value}</dd>
    </>
  );
}
