import { useEffect, useRef, useState } from "react";

// Create an object URL for a File and revoke it when the file changes or the
// component unmounts, so the blob is released and never leaks. Shared by the
// session view's video player (a ~60 MB recording) and each task's screenshot
// thumbnail (TASK-18) — both hold blobs that add up if left dangling.
export function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // Keep the latest URL in a ref so cleanup revokes the exact one it created.
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    urlRef.current = next;
    setUrl(next);
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [file]);

  return url;
}
