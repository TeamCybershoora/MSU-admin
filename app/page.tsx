import Link from "next/link";
import { GraduationCap, Shield } from "lucide-react";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.iconWrap}>
          <GraduationCap />
        </div>
        <h1 className={styles.title}>MSU Admin Portal</h1>
        <p className={styles.subtitle}>
          <Shield size={14} /> Maa Shakumbhari University Administration System
        </p>

        <Link href="/admin/login" className={styles.loginBtn}>
          Sign In to Admin Portal
        </Link>

        <div className={styles.footer}>
          <p>Secure administrator access only</p>
        </div>
      </div>
    </div>
  );
}
