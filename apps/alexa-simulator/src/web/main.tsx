import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Conversation, httpTransport } from './conversation.js';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App conversation={new Conversation(httpTransport())} />);
