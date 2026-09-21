import styles from './page.module.css';

/** Minimal landing page for the Vercel-hosted web shell. */
export default function HomePage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.brand}>DBZ IHL</h1>
      <p className={styles.tagline}>Web companion coming soon.</p>
    </main>
  );
}
