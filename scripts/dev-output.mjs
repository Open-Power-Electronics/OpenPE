import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

const tailLimit = 64 * 1024;
const rendererStatus =
  /^(?:▲ Next\.js\b|-\s+(?:Local|Network):|✓\s+(?:Starting|Ready in|Running next\.config\.\w+ took)\b)/;

export function createDevLogger({
  verbose = false,
  stdout = /** @type {Pick<import('node:stream').Writable, 'write'>} */ (process.stdout),
  stderr = /** @type {Pick<import('node:stream').Writable, 'write'>} */ (process.stderr),
} = {}) {
  return {
    status: (message) => stdout.write(`[OpenPE] ${message}\n`),
    error: (message) => stderr.write(`[OpenPE] ${message}\n`),
    /**
     * @param {{ stdout: import('node:stream').Readable, stderr: import('node:stream').Readable }} child
     * @param {string} label
     * @param {{ quiet?: boolean, onLine?: (text: string, stream: string) => void }} [options]
     */
    attach(child, label, { quiet = false, onLine } = {}) {
      let tail = Buffer.alloc(0),
        truncated = false;
      for (const [name, stream, destination] of [
        ['stdout', child.stdout, stdout],
        ['stderr', child.stderr, stderr],
      ]) {
        const decoder = new StringDecoder('utf8');
        let pending = '';
        const line = (raw) => {
          const text = stripVTControlCharacters(
            raw.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, ''),
          ).trimEnd();
          if (!text) return;
          onLine?.(text, name);
          if (name === 'stdout') {
            const bytes = Buffer.from(text + '\n');
            truncated ||= tail.length + bytes.length > tailLimit;
            const combined = bytes.length >= tailLimit ? bytes : Buffer.concat([tail, bytes]);
            let start = Math.max(0, combined.length - tailLimit);
            while (start < combined.length && (combined[start] & 0xc0) === 0x80) start++;
            tail = Buffer.from(combined.subarray(start));
          }
          if (verbose) return;
          if (name === 'stdout') {
            if (quiet && !/^Downloading\b/.test(text)) return;
            if (label === 'renderer' && rendererStatus.test(text.trimStart())) return;
          }
          destination.write(`[${label}] ${text}\n`);
        };
        const consume = (text) => {
          pending += text;
          let end;
          while ((end = pending.search(/[\r\n]/)) !== -1) {
            line(pending.slice(0, end));
            pending = pending.slice(end + 1);
          }
        };
        stream.on('data', (chunk) => {
          if (verbose) destination.write(chunk);
          consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
        });
        stream.on('end', () => {
          consume(decoder.end());
          if (pending) line(pending);
        });
      }
      return {
        replayStdout() {
          if (verbose || !tail.length) return;
          if (truncated) stderr.write(`[${label}] Earlier preparation output omitted.\n`);
          for (const text of tail.toString('utf8').trimEnd().split('\n'))
            stderr.write(`[${label}] ${text}\n`);
        },
      };
    },
  };
}
