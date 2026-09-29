import { styles } from '../styles';

/**
 * The name others see, asked where it matters: making or joining a space.
 * `useMyName` from `@weaveprotocol/core/react` fills it in and saves it.
 */
export function NameField({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={styles.factLabel}>What should people call you?</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Your name"
        maxLength={64}
        autoComplete="name"
        style={styles.input}
      />
    </label>
  );
}
