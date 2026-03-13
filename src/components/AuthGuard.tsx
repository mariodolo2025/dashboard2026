import { useState, useEffect } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSession, onAuthStateChange } from '@/lib/auth';
import LoginPage from '@/components/LoginPage';
import { Loader2 } from 'lucide-react';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | 'loading'>('loading');

  useEffect(() => {
    getSession().then(({ data }) => setSession(data.session ?? null));
    const {
      data: { subscription },
    } = onAuthStateChange((_, s) => setSession((s as Session | null) ?? null));
    return () => subscription.unsubscribe();
  }, []);

  if (session === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!session) {
    return <LoginPage />;
  }

  return <>{children}</>;
}
