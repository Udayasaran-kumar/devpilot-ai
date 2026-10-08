import * as React from 'react';
import type { Conversation } from './conversation.js';
import { ConversationView, TRANSCRIPT_ID, type ConversationActions } from './view.js';

export function App({ conversation }: { readonly conversation: Conversation }) {
  const snapshot = React.useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const actions = React.useMemo<ConversationActions>(
    () => ({
      setDraft: (draft) => conversation.setDraft(draft),
      submit: () => void conversation.submit(),
      checkResult: () => void conversation.checkResult(),
      chooseRepository: (choice) => void conversation.chooseRepository(choice),
      clear: () => conversation.clear(),
    }),
    [conversation],
  );

  React.useEffect(() => {
    void conversation.refreshConnection();
  }, [conversation]);

  React.useEffect(() => {
    const transcript = document.getElementById(TRANSCRIPT_ID);
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
  }, [snapshot.messages.length, snapshot.pending]);

  return <ConversationView snapshot={snapshot} actions={actions} />;
}
