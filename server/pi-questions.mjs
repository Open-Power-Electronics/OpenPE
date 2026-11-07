// The sole explicitly loaded Pi extension. No filesystem, shell or project tools.
export default function install(pi) {
  pi.registerTool({
    name: 'openpe_ask_user',
    label: 'Ask user',
    description:
      'Ask the user for missing information. Waits for their explicit answer. Never grants file, shell or network permissions.',
    parameters: {
      type: 'object',
      required: ['questions'],
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            required: ['id', 'question'],
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              header: { type: 'string' },
              multiSelect: { type: 'boolean' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['label'],
                  properties: { label: { type: 'string' }, description: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    async execute(_id, input, signal) {
      const response = await fetch(process.env.OPENPE_QUESTIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenPE-Agent-Token': process.env.OPENPE_QUESTIONS_TOKEN,
        },
        body: JSON.stringify(input),
        signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'OpenPE question failed.');
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  });
  pi.on('session_start', () => pi.setActiveTools(['openpe_ask_user']));
  pi.on('tool_call', (event) =>
    event.toolName === 'openpe_ask_user'
      ? undefined
      : { block: true, reason: 'Only user questions are available in OpenPE.' },
  );
}
