import { useEffect, useState } from "react";
import { api } from "./api";

type Remote<T> = {
  url: string | null;
  loading: boolean;
  data?: T;
  error?: string;
};
// The response carries its request identity. During a URL change, data from
// the previous request is never exposed, even before effect cleanup runs.
export function useRemote<T>(url: string | null): Remote<T> {
  const [result, setResult] = useState<Remote<T>>({ url, loading: !!url });
  useEffect(() => {
    if (!url) return;
    const request = new AbortController();
    setResult({ url, loading: true });
    void api<T>(url, { signal: request.signal })
      .then((data) => {
        if (!request.signal.aborted) setResult({ url, loading: false, data });
      })
      .catch((error) => {
        if (!request.signal.aborted)
          setResult({ url, loading: false, error: error.message });
      });
    return () => request.abort();
  }, [url]);
  return result.url === url ? result : { url, loading: !!url };
}
