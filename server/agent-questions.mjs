import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;

// Normalize only clarification questions, never approvals or arbitrary tool schemas.
export function agentQuestions(provider, input) {
  if (
    !['codex', 'claude', 'deepseek', 'pi'].includes(provider) ||
    !Array.isArray(input) ||
    !input.length ||
    input.length > 4
  )
    throw new Error('Unsupported Agent questions.');
  const questions = input.map((q, index) => {
    if (
      !object(q) ||
      !text(q.question, 4000) ||
      (q.header !== undefined && !text(q.header, 100)) ||
      (provider !== 'claude' && !text(q.id, 200)) ||
      q.isSecret === true ||
      q.intent !== undefined ||
      (q.detail !== undefined && !text(q.detail, 16000)) ||
      (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') ||
      (q.options != null && (!Array.isArray(q.options) || q.options.length > 8))
    )
      throw new Error('Unsupported Agent question format.');
    const options = (q.options || []).map((option) => {
      if (
        !object(option) ||
        !text(option.label, 200) ||
        (option.description !== undefined &&
          (typeof option.description !== 'string' || option.description.length > 2000))
      )
        throw new Error('Unsupported Agent question option.');
      return { label: option.label, description: option.description || '' };
    });
    if (new Set(options.map((o) => o.label)).size !== options.length)
      throw new Error('Duplicate Agent question options.');
    return {
      id: provider === 'claude' ? String(index) : q.id,
      header: q.header || 'Question',
      question: q.question,
      ...(q.detail ? { detail: q.detail } : {}),
      options,
      multiSelect: q.multiSelect === true,
    };
  });
  if (
    new Set(questions.map((q) => q.id)).size !== questions.length ||
    new Set(questions.map((q) => q.question)).size !== questions.length
  )
    throw new Error('Duplicate Agent questions.');
  return questions;
}

export function createAgentQuestionBridge({ sessionId, origin, emit, signal }) {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const pending = new Map();
  let count = 0,
    closed = false;
  const close = () => {
    closed = true;
    signal.removeEventListener('abort', close);
    for (const entry of pending.values()) {
      entry.cleanup();
      entry.reject(new Error('Agent question is no longer active.'));
    }
    pending.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  return {
    id,
    token,
    close,
    authorized: (value) =>
      !closed &&
      typeof value === 'string' &&
      Buffer.byteLength(value) === Buffer.byteLength(token) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(token)),
    waiting: () => pending.size > 0,
    /** @param {import('../lib/chat-stream').AgentQuestion[]} questions @param {AbortSignal} [questionSignal] */
    ask(questions, questionSignal = undefined) {
      questionSignal?.throwIfAborted();
      if (closed || pending.size >= 4 || ++count > 32)
        throw new Error('Agent question is inactive or exceeds the request limit.');
      const requestId = randomUUID(),
        token = randomBytes(32).toString('hex');
      return new Promise((resolve, reject) => {
        const cancel = () => {
          if (!pending.delete(requestId)) return;
          cleanup();
          emit({ type: 'question-closed', requestId, sessionId });
          reject(new Error('Agent question is no longer active.'));
        };
        const cleanup = () => questionSignal?.removeEventListener('abort', cancel);
        pending.set(requestId, {
          questions: structuredClone(questions),
          token,
          resolve,
          reject,
          cleanup,
        });
        questionSignal?.addEventListener('abort', cancel, { once: true });
        try {
          emit({ type: 'question-request', runId: id, sessionId, requestId, token, questions });
        } catch (error) {
          pending.delete(requestId);
          cleanup();
          reject(error);
        }
      });
    },
    respond(body, responseOrigin) {
      const entry = pending.get(body?.requestId);
      if (
        closed ||
        body?.runId !== id ||
        body?.sessionId !== sessionId ||
        responseOrigin !== origin ||
        !entry ||
        typeof body.token !== 'string' ||
        Buffer.byteLength(body.token) !== Buffer.byteLength(entry.token) ||
        !timingSafeEqual(Buffer.from(body.token), Buffer.from(entry.token))
      )
        throw new Error('Unknown, expired or already answered Agent question.');
      if (
        Object.keys(body).some(
          (key) => !['runId', 'sessionId', 'requestId', 'token', 'answers'].includes(key),
        ) ||
        !object(body.answers) ||
        Object.keys(body.answers).length !== entry.questions.length
      )
        throw new Error('Invalid Agent answers.');
      for (const q of entry.questions) {
        const answer = body.answers[q.id];
        if (
          !Object.hasOwn(body.answers, q.id) ||
          !Array.isArray(answer) ||
          !answer.length ||
          answer.length > (q.multiSelect ? 9 : 1) ||
          answer.some((a) => !text(a, 16000)) ||
          new Set(answer).size !== answer.length
        )
          throw new Error('Answer every Agent question before continuing.');
      }
      pending.delete(body.requestId);
      entry.cleanup();
      entry.resolve(structuredClone(body.answers));
    },
  };
}
