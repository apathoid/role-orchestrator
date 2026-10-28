function promptCapabilities(initializeResponse) {
  return initializeResponse?.agentCapabilities?.promptCapabilities ?? {};
}

/**
 * Preserve native ACP content blocks while respecting the nested agent's
 * advertised prompt capabilities. Text blocks here are supplemental markers
 * produced by the outer orchestrator (for example historical attachment
 * provenance); the current user task text remains in the provider role prompt.
 */
export function passthroughPromptBlocks(blocks, initializeResponse) {
  const caps = promptCapabilities(initializeResponse);
  const result = [];
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text) result.push(block);
      continue;
    }
    if (block.type === 'image') {
      if (caps.image === true) result.push(block);
      continue;
    }
    if (block.type === 'resource_link') {
      // ACP requires all agents to support resource links. Preserve link
      // semantics; the orchestrator never dereferences the URI here.
      result.push(block);
      continue;
    }
    if (block.type === 'resource') {
      if (caps.embeddedContext === true) result.push(block);
      continue;
    }
    if (block.type === 'audio') {
      if (caps.audio === true) result.push(block);
      else throw new Error('The selected ACP runtime does not advertise audio prompt support.');
      continue;
    }
    // Forward future ACP content blocks optimistically. The nested ACP agent is
    // the authority on whether a newly-added protocol block is supported.
    result.push(block);
  }
  return result;
}
