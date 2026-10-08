import * as React from 'react';
import type { DialogCard, DialogKind, RepositoryChoice } from '../../../voice-demo/src/dialog.js';
import { MAX_UTTERANCE_LENGTH } from '../../../voice-demo/src/intents.js';
import type { ConnectionStatus, ConversationSnapshot, Message } from './conversation.js';

export const TRANSCRIPT_ID = 'transcript';
export const EMPTY_STATE_TEXT = 'Ask DevPilot to investigate a failing test.';

/** What the view can ask for; each one becomes at most one `POST /api/dialog`. */
export interface ConversationActions {
  setDraft(draft: string): void;
  submit(): void;
  checkResult(): void;
  chooseRepository(choice: RepositoryChoice): void;
  clear(): void;
}

interface ViewProps {
  readonly snapshot: ConversationSnapshot;
  readonly actions: ConversationActions;
}

/** Whether the simulator backend can reach DevPilot; never derived from the investigation. */
export const CONNECTION_LABEL: Readonly<Record<ConnectionStatus, string>> = {
  checking: 'Checking…',
  connected: 'Available',
  unavailable: 'Unavailable',
};

export const INVESTIGATION_LABEL = {
  active: 'Investigation in progress',
  none: 'No active investigation',
} as const;

type Verdict = 'verified' | 'unverified' | 'in-progress' | 'failed';

const VERDICTS: Partial<Record<DialogKind, { readonly verdict: Verdict; readonly title: string }>> = {
  verified: { verdict: 'verified', title: 'Verified repair' },
  not_verified: { verdict: 'unverified', title: 'Repair not verified' },
  started: { verdict: 'in-progress', title: 'Investigation in progress' },
  in_progress: { verdict: 'in-progress', title: 'Investigation in progress' },
  failed: { verdict: 'failed', title: 'Investigation failed' },
};

/** The whole page, as a pure function of the conversation snapshot. */
export function ConversationView({ snapshot, actions }: ViewProps) {
  return (
    <div className="app">
      <Header connection={snapshot.connection} />
      <InvestigationStatus active={snapshot.jobActive} repository={snapshot.activeRepository} />
      <main className="transcript" id={TRANSCRIPT_ID} aria-live="polite" aria-busy={snapshot.pending}>
        {snapshot.messages.length === 0 ? (
          <EmptyState />
        ) : (
          snapshot.messages.map((message) => <MessageItem key={message.id} message={message} pending={snapshot.pending} actions={actions} />)
        )}
        {snapshot.pending ? <p className="typing">DevPilot is working…</p> : null}
      </main>
      <Composer snapshot={snapshot} actions={actions} />
    </div>
  );
}

function Header({ connection }: { readonly connection: ConnectionStatus }) {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          DP
        </span>
        <div>
          <h1>DevPilot</h1>
          <p className="subtitle">Developer Incident Assistant</p>
        </div>
        <span className="badge">Alexa+ style simulation</span>
      </div>
      <p className={`connection connection--${connection}`} role="status" aria-label={`DevPilot: ${CONNECTION_LABEL[connection]}`}>
        <span className="connection-dot" aria-hidden="true" />
        {CONNECTION_LABEL[connection]}
      </p>
    </header>
  );
}

function InvestigationStatus({ active, repository }: { readonly active: boolean; readonly repository: RepositoryChoice | undefined }) {
  return (
    <section className={`investigation investigation--${active ? 'active' : 'none'}`} aria-label="Investigation">
      <span className="investigation-label">Investigation</span>
      <span className="investigation-value">{active ? INVESTIGATION_LABEL.active : INVESTIGATION_LABEL.none}</span>
      {active && repository ? <span className="investigation-repository">{repository.displayName}</span> : null}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <p className="empty-title">{EMPTY_STATE_TEXT}</p>
      <p className="empty-hint">Try “Investigate the failing tests”, then “What did you find?”</p>
    </div>
  );
}

function MessageItem({ message, pending, actions }: { readonly message: Message; readonly pending: boolean; readonly actions: ConversationActions }) {
  if (message.role === 'user') {
    return (
      <div className="message message--user">
        <p className="bubble">{message.text}</p>
      </div>
    );
  }
  return (
    <div className="message message--assistant">
      <p className="bubble">{message.text}</p>
      {message.card ? <ResultCard card={message.card} kind={message.kind} pending={pending} actions={actions} /> : null}
    </div>
  );
}

/** Renders the card's own fields only, in the dialog's words. */
export function ResultCard({ card, kind, pending, actions }: { readonly card: DialogCard; readonly kind: DialogKind | undefined; readonly pending: boolean; readonly actions: ConversationActions }) {
  const heading = kind === undefined ? undefined : VERDICTS[kind];
  return (
    <section className={`card${heading ? ` card--${heading.verdict}` : ''}`} aria-label={heading?.title ?? 'Details'}>
      {heading ? <h2 className="card-title">{heading.title}</h2> : null}
      {card.repositories ? (
        <div className="choices">
          {card.repositories.map((choice) => (
            <button key={choice.repositoryId} type="button" className="choice" disabled={pending} onClick={() => actions.chooseRepository(choice)}>
              <span className="choice-name">{choice.displayName}</span>
              <span className="choice-id">{choice.repositoryId}</span>
            </button>
          ))}
        </div>
      ) : null}
      {card.repository || card.jobStatus || card.verified !== undefined || card.repairStatus !== undefined ? (
        <dl className="facts">
          {card.repository ? <Fact label="Repository" value={`${card.repository.displayName} (${card.repository.repositoryId})`} /> : null}
          {card.jobStatus ? <Fact label="Status" value={card.jobStatus} /> : null}
          {card.verified !== undefined ? <Fact label="Verified" value={card.verified ? 'Yes' : 'No'} /> : null}
          {card.repairStatus !== undefined ? <Fact label="Repair" value={card.repairStatus ?? 'none'} /> : null}
        </dl>
      ) : null}
      {card.claims && card.claims.length > 0 ? (
        <CardSection title="Claims">
          <ul className="claims">
            {card.claims.map((claim, index) => (
              <li key={index}>
                <span className={`claim-kind claim-kind--${claim.kind}`}>{claim.kind}</span> {claim.statement}
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}
      {card.baselineFailures && card.baselineFailures.length > 0 ? (
        <CardSection title="Failing tests">
          <ul>
            {card.baselineFailures.map((failure, index) => (
              <li key={index}>
                {[...failure.suite, failure.testName].join(' › ')} <code>{failure.testFile}</code>
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}
      {card.affectedFiles && card.affectedFiles.length > 0 ? (
        <CardSection title="Affected files">
          <ul>
            {card.affectedFiles.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}
      {card.limitations && card.limitations.length > 0 ? (
        <CardSection title="Limitations">
          <ul className="limitations">
            {card.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
        </CardSection>
      ) : null}
    </section>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CardSection({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="card-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Composer({ snapshot, actions }: ViewProps) {
  return (
    <footer className="composer">
      <form
        className="composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          actions.submit();
        }}
      >
        <label className="visually-hidden" htmlFor="utterance">
          Message DevPilot
        </label>
        <input
          id="utterance"
          className="composer-input"
          type="text"
          autoComplete="off"
          placeholder="Ask DevPilot…"
          maxLength={MAX_UTTERANCE_LENGTH}
          value={snapshot.draft}
          disabled={snapshot.pending}
          onChange={(event) => actions.setDraft(event.target.value)}
        />
        <button type="submit" className="button button--primary" disabled={snapshot.pending || snapshot.draft.trim() === ''}>
          Send
        </button>
      </form>
      <div className="controls">
        {snapshot.jobActive ? (
          <button type="button" className="button" disabled={snapshot.pending} onClick={() => actions.checkResult()}>
            Check result
          </button>
        ) : null}
        <button type="button" className="button button--quiet" disabled={snapshot.messages.length === 0 && snapshot.draft === ''} onClick={() => actions.clear()}>
          Clear conversation
        </button>
      </div>
    </footer>
  );
}
