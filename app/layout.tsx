import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';
import './workspace.css';
import './layout-editor.css';
export const metadata: Metadata = {
  title: 'OpenPE · Electrical Engineering Studio',
  description:
    'A local electrical engineering studio for circuits, simulation and AI-assisted design',
  icons: { icon: '/brand/openpe-mark.svg' },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
