import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "../api/client";

interface ImportSessionState {
  sessionId: string | null;
  sourceLabel: string;
  uploadProgress: number | null;
  uploadError: string | null;
  isUploading: boolean;
  startUpload: (files: File[], label: string) => void;
  reset: () => void;
}

const ImportSessionContext = createContext<ImportSessionState | null>(null);

/**
 * Lives above <Routes> in App.tsx so it survives switching nav tabs mid-upload
 * (e.g. clicking "Library" while an SD card is still uploading). The browser
 * keeps the XHR running regardless of which component is mounted, but without
 * this, the *tracking* of it (session id, progress) would be lost the moment
 * ImportWizard unmounts - the import would look "stopped" even though the
 * backend received and staged everything.
 */
export function ImportSessionProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  function startUpload(files: File[], label: string) {
    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(0);
    api.import
      .upload(files, label, setUploadProgress)
      .then((session) => {
        setSourceLabel(session.source_path);
        setSessionId(session.id);
      })
      .catch((err: Error) => setUploadError(err.message))
      .finally(() => {
        setIsUploading(false);
        setUploadProgress(null);
      });
  }

  function reset() {
    setSessionId(null);
    setSourceLabel("");
    setUploadError(null);
  }

  return (
    <ImportSessionContext.Provider
      value={{ sessionId, sourceLabel, uploadProgress, uploadError, isUploading, startUpload, reset }}
    >
      {children}
    </ImportSessionContext.Provider>
  );
}

export function useImportSession(): ImportSessionState {
  const ctx = useContext(ImportSessionContext);
  if (!ctx) throw new Error("useImportSession must be used within ImportSessionProvider");
  return ctx;
}
