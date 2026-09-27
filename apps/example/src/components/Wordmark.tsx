/** The product's name, small, above every onboarding step */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: compact ? 0 : 40 }}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
        <path d="M2 5 L7 15 L10 8 L13 15 L18 5" fill="none" stroke="#000" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: '-0.03em', color: '#000' }}>Weave</span>
    </div>
  );
}
