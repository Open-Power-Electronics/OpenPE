import { useEffect, useRef, useState } from 'react';
import type { PCB } from '@/lib/pcb';
import { createPCBFillWorkerClient, type PCBFillWorkerResult } from './pcbFillWorkerClient';

/** Background drawing only. Core always prepares and validates the final edit. */
export function usePCBFillWorker(basis: PCB, candidate: PCB, enabled: boolean, revision?: number) {
  const client = useRef<ReturnType<typeof createPCBFillWorkerClient> | null>(null);
  const origin = useRef(revision);
  const [completed, setCompleted] = useState<{
    result: PCBFillWorkerResult;
    revision?: number;
  } | null>(null);
  const [failure, setFailure] = useState<{ basis: PCB; error: string } | null>(null);

  useEffect(() => {
    if (origin.current !== revision) {
      client.current?.dispose();
      client.current = null;
      origin.current = revision;
      setCompleted(null);
      setFailure(null);
    }
    if (!enabled) {
      client.current?.dispose();
      client.current = null;
      setCompleted(null);
      setFailure(null);
      return;
    }
    try {
      if (!client.current) {
        const worker = new Worker(new URL('./pcbFill.worker.ts', import.meta.url), {
          type: 'module',
          name: 'OpenPE copper preview',
        });
        client.current = createPCBFillWorkerClient(worker, (result) => {
          if (result.error !== undefined) {
            setFailure({ basis: result.basis, error: result.error });
            if (result.fatal) client.current = null;
          } else {
            setCompleted({ result, revision });
            setFailure(null);
          }
        });
      }
      client.current.submit(basis, candidate);
    } catch (error) {
      client.current?.dispose();
      client.current = null;
      setFailure({ basis, error: (error as Error).message });
    }
  }, [basis, candidate, enabled, revision]);

  useEffect(
    () => () => {
      client.current?.dispose();
      client.current = null;
    },
    [],
  );

  return {
    completed:
      enabled && completed?.result.basis === basis && completed.revision === revision
        ? completed.result
        : null,
    error: enabled && failure?.basis === basis ? failure.error : '',
  };
}
