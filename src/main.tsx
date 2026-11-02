import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './styles/base.css';
import { App } from './App.tsx';
import { watchAlarms } from './state/alarms.ts';
import { watchRun } from './state/runEvents.ts';
import { startThreads } from './state/threads.ts';

// One conversation per experiment (state/threads.ts), and what is done by hand on the run written into it.
startThreads();
watchRun();
// Every experiment's timers ring, on any screen and on the lock screen (state/alarms.ts).
watchAlarms();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
