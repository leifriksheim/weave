import type { TodoView } from '../space-session';
import { styles } from '../styles';

/** One signed Expression, rendered with its verification verdict. */
export function TodoItem({
  todo,
  onToggle,
  onDelete,
  readOnly = false,
}: {
  todo: TodoView;
  onToggle: () => void;
  onDelete: () => void;
  /** Following someone else's personal list: shown, not changed */
  readOnly?: boolean;
}) {
  const { verification } = todo;
  const verified = verification.signatureValid && verification.authorized;
  const badgeTitle = verified
    ? `Signed by ${todo.author}\nDelegated by ${verification.rootDid}`
    : `Unverified: ${verification.reason ?? 'unknown reason'}`;

  return (
    <div data-row style={styles.todoItem}>
      {/* A real checkbox rather than an emoji button: it gets the platform's
          own look, keyboard behaviour and accessible name for free. */}
      <input
        type="checkbox"
        checked={todo.body.completed}
        onChange={onToggle}
        disabled={readOnly}
        style={styles.checkbox}
        aria-label={`Mark "${todo.body.text}" ${todo.body.completed ? 'not done' : 'done'}`}
      />
      <div style={styles.todoContent}>
        <span
          style={{
            ...styles.todoText,
            textDecoration: todo.body.completed ? 'line-through' : 'none',
            opacity: todo.body.completed ? 0.5 : 1,
          }}
        >
          {todo.body.text}
        </span>
        <span style={styles.todoMeta}>
          <span title={badgeTitle} style={verified ? styles.ok : styles.bad}>
            {verified ? '🔐' : '⚠️'}
          </span>
          {todo.wasEncrypted && <span title="Stored encrypted; opened with the space key"> 🔑</span>}{' '}
          {todo.key.slice(0, 8)}…{todo.seq > 0 ? ` · v${todo.seq + 1}` : ''} · {new Date(todo.createdAt).toLocaleTimeString()} · by{' '}
          {todo.author.slice(-6)}
        </span>
      </div>
      {!readOnly && (
        <button
          onClick={onDelete}
          data-row-action
          data-variant="danger"
          style={styles.rowAction}
          title="Delete"
          aria-label={`Delete "${todo.body.text}"`}
        >
          ✕
        </button>
      )}
    </div>
  );
}
