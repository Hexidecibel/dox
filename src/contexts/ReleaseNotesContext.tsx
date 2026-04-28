import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { ReleaseNotesModal } from '../components/ReleaseNotesModal';

interface ReleaseNotesContextValue {
  openReleaseNotes: (version?: string) => void;
}

const ReleaseNotesContext = createContext<ReleaseNotesContextValue | null>(null);

export function ReleaseNotesProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | undefined>(undefined);

  const openReleaseNotes = useCallback((v?: string) => {
    setVersion(v);
    setOpen(true);
  }, []);

  return (
    <ReleaseNotesContext.Provider value={{ openReleaseNotes }}>
      {children}
      <ReleaseNotesModal
        open={open}
        onClose={() => setOpen(false)}
        initialVersion={version}
      />
    </ReleaseNotesContext.Provider>
  );
}

export function useReleaseNotes(): ReleaseNotesContextValue {
  const ctx = useContext(ReleaseNotesContext);
  if (!ctx) throw new Error('useReleaseNotes must be used within ReleaseNotesProvider');
  return ctx;
}
