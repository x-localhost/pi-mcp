export function capabilities(config) {
  const mcp = mode => (config.approvedMcp?.servers || []).flatMap(server =>
    (server.tools || []).filter(tool => mode === 'implement' || server.reviewTools?.includes(tool.name))
      .map(tool => ({ name: `mcp__${server.id}__${tool.name}`, description: tool.description })));
  const base = ['read', 'grep', 'find', 'ls'].map(name => ({ name, description: '' }));
  return {
    version: 1,
    models: config.provider && config.model ? [{ provider: config.provider, model: config.model }] : [],
    verifiers: (config.verification?.commands || []).map(item => ({ id: item.id, description: item.description || '', readOnly: !!item.readOnly,
      trust: item.protectedFiles?.length ? 'declared_packaged_files' : 'repository_controlled_command' })),
    materials: (config.offlineMaterials?.materials || []).map(item => ({ id: item.id, description: item.description || '' })),
    tools: { implement: [...base, ...['write', 'edit', 'safe_shell'].map(name => ({ name, description: '' })), ...mcp('implement')], review: [...base, ...mcp('review')] },
    continuations: ['pi_followup', 'pi_fork', 'pi_rollover', 'pi_review'],
    acceptance: { version: 1, fields: ['required_verification_ids', 'required_artifact_paths', 'require_review'], reviewAttestationAuthority: 'caller' },
    context: { version: 1, ...(config.context || {}) }, observation: { version: 1, ...(config.observation || {}) },
    limits: { maxConcurrent: config.maxConcurrent, maxTimeoutSeconds: config.maxTimeoutSeconds, defaultMaxTurns: config.defaultMaxTurns,
      maxSelectedVerifiers: config.verification?.maxSelected, maxMaterials: 32, maxInlineImages: 4 }
  };
}
