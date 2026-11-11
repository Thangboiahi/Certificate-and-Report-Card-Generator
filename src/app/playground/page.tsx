import type { Metadata } from 'next';

import { Playground } from './playground';

export const metadata: Metadata = {
  title: 'Engine playground',
  description: 'Runs the PDF generation engine on a sample job, in this browser.',
};

export default function PlaygroundPage() {
  return (
    <main>
      <Playground />
    </main>
  );
}
