import type { Home } from '../accounts';
import { ChooseStorageSummary } from './StorageSummary';
import { Option, Wordmark } from './ChooseStorage';
import { styles } from '../styles';

/** The second question, once storage is settled and it holds no accounts: new here, or not? */
export function Welcome({
  home,
  loading,
  onCreate,
  onHaveAccount,
  onChangeStorage,
}: {
  home: Home;
  loading: boolean;
  onCreate: () => void;
  onHaveAccount: () => void;
  onChangeStorage: () => void;
}) {
  return (
    <div style={styles.container}>
      <div data-card style={styles.card}>
        <Wordmark />
        <h1 style={styles.title}>Do you have a Weave account?</h1>
        <p style={styles.subtitle}>One account works in every Weave app.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Option title="Create a new account" description="We'll make you a strong password to save in your password manager." onClick={onCreate} disabled={loading} />
          <Option title="I already have one" description="Sign in with the account password you saved when you made it." onClick={onHaveAccount} disabled={loading} />
        </div>
        <ChooseStorageSummary home={home} onChange={onChangeStorage} />
      </div>
    </div>
  );
}
