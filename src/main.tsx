import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import AuthGuard from './components/AuthGuard.tsx';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';
import { installStaleBuildRecovery } from './lib/staleBuild';
import './index.css';

// A tab left open across a deploy asks for files that no longer exist; reload
// into the new build instead of going blank. See src/lib/staleBuild.ts.
installStaleBuildRecovery();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <AuthGuard>
        <App />
      </AuthGuard>
    </AppErrorBoundary>
  </StrictMode>
);
