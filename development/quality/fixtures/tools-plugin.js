export const manifest = { id: 'fixture-tools', version: '1', apiVersion: 1, exports: ['tool'] };
export const tool = {
  id: 'echo_text', description: 'Echo text through the external tool contract', resource: 'fixture:echo', effect: 'read',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  async invoke({ text }) { return text; },
};
