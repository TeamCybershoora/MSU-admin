import { Suspense } from "react";
import SyllabusBrowser from "./syllabus-browser";
import styles from "./page.module.css";

/**
 * Public Syllabus page — Programme → Academic Session → Semester → syllabus.
 *
 * Server shell: owns the page metadata and wraps the interactive browser in a
 * Suspense boundary, which Next.js requires for any client component that
 * reads useSearchParams() during prerendering. The browser itself lives in
 * ./syllabus-browser (client component); the data comes exclusively from the
 * public read-only API (/api/syllabus/*), never from admin routes.
 */
export const metadata = {
  title: "Syllabus | Maa Shakumbhari University",
  description:
    "Programme-wise syllabus of Maa Shakumbhari University, organised by academic session and semester.",
};

export default function SyllabusPage() {
  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Syllabus</h1>
        <p className={styles.pageSubtitle}>
          Maa Shakumbhari University — curriculum and syllabus documents by
          programme, academic session and semester.
        </p>
      </header>

      <Suspense
        fallback={
          <div className={styles.loadingState} role="status">
            <div className={styles.spinner} />
            <p>Loading syllabus…</p>
          </div>
        }
      >
        <SyllabusBrowser />
      </Suspense>
    </main>
  );
}
