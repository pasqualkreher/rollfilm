import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";

interface ImportSessionState {
  sessionId: string | null;
  sourceLabel: string;
  uploadProgress: number | null;
  uploadError: string | null;
  isUploading: boolean;
  startUpload: (files: File[], label: string) => void;
  cancelUpload: () => void;
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
  // Held for the lifetime of an in-flight upload so cancelUpload() can abort the
  // XHRs; the created staging session id is captured so a mid-upload cancel can
  // clean up whatever was already staged on the backend.
  const abortRef = useRef<AbortController | null>(null);
  const uploadSessionRef = useRef<string | null>(null);

  function startUpload(files: File[], label: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    uploadSessionRef.current = null;
    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(0);
    api.import
      .upload(files, label, setUploadProgress, controller.signal, (id) => {
        uploadSessionRef.current = id;
      })
      .then((session) => {
        setSourceLabel(session.source_path);
        setSessionId(session.id);
      })
      .catch((err: Error) => {
        // A user cancel isn't a failure: drop the partially-staged session on
        // the backend (best effort) and clear the screen instead of erroring.
        if (controller.signal.aborted || err.name === "AbortError") {
          const staged = uploadSessionRef.current;
          if (staged) api.import.discard(staged).catch(() => {});
          reset();
        } else {
          setUploadError(err.message);
        }
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        setIsUploading(false);
        setUploadProgress(null);
      });
  }

  function cancelUpload() {
    abortRef.current?.abort();
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    uploadSessionRef.current = null;
    setSessionId(null);
    setSourceLabel("");
    setUploadError(null);
  }

  return (
    <ImportSessionContext.Provider
      value={{
        sessionId,
        sourceLabel,
        uploadProgress,
        uploadError,
        isUploading,
        startUpload,
        cancelUpload,
        reset,
      }}
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
