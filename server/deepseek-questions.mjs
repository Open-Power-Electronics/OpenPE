// Runs inside the private ACP patch, composing the harness's native question seam.
export const name = 'openpe-questions';
export const inject = ['userQuestions'];
export function apply(ctx) {
  ctx.on(
    'user-questions/request',
    async (request) => {
      const response = await fetch(process.env.OPENPE_QUESTIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenPE-Agent-Token': process.env.OPENPE_QUESTIONS_TOKEN,
        },
        body: JSON.stringify({ questions: request.questions }),
        signal: request.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'OpenPE question failed.');
      return {
        answers: request.questions.map((q) => {
          const values = result.answers[q.id];
          const labels = new Set((q.options || []).map((o) => o.label));
          const custom = values.filter((value) => !labels.has(value)).join('\n');
          return {
            id: q.id,
            selected: values.filter((value) => labels.has(value)),
            ...(custom ? { custom } : {}),
          };
        }),
      };
    },
    { global: true },
  );
  ctx.provide('openpeQuestions', true);
}
