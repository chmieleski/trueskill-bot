import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'DBZ IHL',
  description: 'Ranked Dragon Ball Z Warcraft III league — web companion coming soon.',
};

/** Root layout for the public web shell. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
