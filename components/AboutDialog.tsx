'use client';

import Dialog from './Dialog';
import LibraryLicenses from './LibraryLicenses';
import Logo from './Logo';
import styles from './AboutDialog.module.css';

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="OpenPE"
      label="About OpenPE"
      icon={<Logo size={20} />}
      compact
      wide
      onClose={onClose}
    >
      <div className={styles.introduction}>
        <p className={styles.descriptor}>AI-Native Workbench for Power Electronic Engineer</p>
        <p className={styles.description}>
          A local workbench for circuit design, PCB layout, 3D modeling, and simulation.
        </p>
      </div>
      <LibraryLicenses />
    </Dialog>
  );
}
