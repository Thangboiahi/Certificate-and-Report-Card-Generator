import type { Metadata } from 'next';

import { EditorScreen } from './editor-screen';

export const metadata: Metadata = { title: 'Template editor' };

/** The Tap-to-Place editor. Public (guests may try it); saving templates arrives with storage. */
export default function EditorPage() {
  return <EditorScreen />;
}
