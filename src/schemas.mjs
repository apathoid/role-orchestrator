import { validateTaskSpec, PRIORITY_AREA_PATTERN, QUALITY_GOALS } from './routing/task-spec.mjs';
import { routingShapeError } from './routing/output-failures.mjs';
export const schemas = {
  routing: {
    type: 'object', additionalProperties: false,
    required: ['mode', 'writeIntent', 'complexity', 'risk', 'reason', 'task'],
    properties: {
      mode: { type: 'string', enum: ['change', 'review', 'investigate'] },
      writeIntent: { type: 'string', enum: ['explicit', 'not_requested', 'ambiguous'] },
      complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
      risk: { type: 'string', enum: ['normal', 'architecture', 'security_or_data'] },
      reason: { type: 'string' },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      task: { type:'object', additionalProperties:false, required:['version','operation','writeIntent','target','constraints','continuation','ambiguities'], properties:{
        version:{type:'integer',const:1},qualityGoals:{type:'array',maxItems:4,uniqueItems:true,items:{type:'string',enum:QUALITY_GOALS}},skillName:{type:'string',minLength:1,maxLength:64,pattern:'^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'},
        operation:{type:'string',enum:['investigate','review','change','plan']},
        writeIntent:{type:'string',enum:['explicit','not_requested','ambiguous']},
        target:{type:'object',additionalProperties:false,required:['kind','selector'],properties:{
          kind:{type:'string',enum:['none','git']},selector:{anyOf:[{type:'null'}, {type:'object',additionalProperties:false,required:['type'],properties:{
            type:{type:'string',enum:['recent_commits','commit','range','relative_ref','worktree','staged','unstaged','ticket_commits','files','union']},
            count:{type:'integer',minimum:1,maximum:128},ref:{type:'string'},left:{type:'string'},right:{type:'string'},notation:{type:'string',enum:['..','...']},ticket:{type:'string'},paths:{type:'array',minItems:1,maxItems:128,uniqueItems:true,items:{type:'string'}},mergeParentIndex:{type:'integer',minimum:1,maximum:16},
            selectors:{type:'array',minItems:2,maxItems:4,items:{type:'object',additionalProperties:false,required:['type'],properties:{
              type:{type:'string',enum:['recent_commits','commit','range','relative_ref','worktree','staged','unstaged','ticket_commits','files']},
              count:{type:'integer',minimum:1,maximum:128},ref:{type:'string'},left:{type:'string'},right:{type:'string'},notation:{type:'string',enum:['..','...']},ticket:{type:'string'},paths:{type:'array',minItems:1,maxItems:128,uniqueItems:true,items:{type:'string'}},mergeParentIndex:{type:'integer',minimum:1,maximum:16}
            }}}
          }}]}
        }},
        constraints:{type:'object',additionalProperties:false,required:['excludedPaths','reviewDepth','priorityAreas','resourcePreference','verification'],properties:{
          excludedPaths:{type:'array',maxItems:64,items:{type:'string'}},reviewDepth:{type:'string',enum:['unspecified','focused','standard','deep']},
          priorityAreas:{type:'array',maxItems:24,items:{type:'string',minLength:1,maxLength:240,pattern:PRIORITY_AREA_PATTERN}},resourcePreference:{type:'string',enum:['unspecified','efficient','thorough']},
          verification:{type:'string',enum:['unspecified','required','not_requested']},
          writeScope:{type:'string',enum:['unspecified','tests_only','production_only','combined']},
          reviewChecks:{type:'array',maxItems:64,items:{type:'object',additionalProperties:false,required:['kind','description'],properties:{kind:{type:'string',enum:['step','acceptance']},description:{type:'string',minLength:1,maxLength:500}}}},
          expectedFileCount:{type:'integer',minimum:0,maximum:100000}
        }},
        continuation:{type:'object',additionalProperties:false,required:['mode'],properties:{
          mode:{type:'string',enum:['new','current_review','current_implementation','saved_implementation','saved_review','information','revise_plan','reconcile','ambiguous']},operationId:{type:'string',minLength:8,maxLength:128,pattern:'^[a-zA-Z0-9_-]{8,128}$'},decision:{type:'string',enum:['accept_checkout','decline']}
        }},
        ambiguities:{type:'array',maxItems:12,items:{type:'string',minLength:1,maxLength:350}}
      } },
    },
  },
  exploration: {
    type: 'object', additionalProperties: false,
    required: ['summary', 'relevantFiles', 'constraints', 'existingPatterns', 'likelyVerification', 'unknowns'],
    properties: {
      summary: { type: 'string' },
      relevantFiles: { type: 'array', items: { type: 'string' }, maxItems: 30 },
      constraints: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      existingPatterns: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      likelyVerification: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      unknowns: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    },
  },
  plan: {
    type: 'object', additionalProperties: false,
    required: ['goal', 'steps', 'acceptanceCriteria', 'risks', 'expectedFiles', 'engineeringFrame'],
    properties: {
      goal: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 },
      acceptanceCriteria: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 },
      acceptanceChecks: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['id', 'commands'], properties: { id: { type: 'string' }, commands: { type: 'array', maxItems: 16, items: { type: 'string' } } } } },
      acceptanceReviews: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false,
        required: ['id', 'paths'], properties: { id: { type: 'string' }, paths: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } } } } },
      risks: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      expectedFiles: { type: 'array', items: { type: 'string' }, maxItems: 200 },
      engineeringFrame: {
        type: 'object', additionalProperties: false,
        required: ['currentOwner', 'existingAbstractions', 'generalMechanism', 'specificPolicy', 'targetPlacement', 'stateOwnership', 'resourceOwnership', 'contractRisks', 'avoid', 'uncertainties'],
        properties: {
          currentOwner: { type: 'string' },
          existingAbstractions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          generalMechanism: { type: 'string' },
          specificPolicy: { type: 'string' },
          targetPlacement: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          stateOwnership: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          resourceOwnership: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          contractRisks: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          avoid: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          uncertainties: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        },
      },
    },
  },
  implementation: {
    type: 'object', additionalProperties: false,
    required: ['action', 'summary', 'changedFiles', 'notes'],
    properties: {
      action: { type: 'string', enum: ['changed', 'no_change'] },
      summary: { type: 'string' },
      changedFiles: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      notes: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    },
  },
  review: {
    type: 'object', additionalProperties: false,
    required: ['verdict', 'summary', 'issues'],
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fix', 'escalate'] },
      summary: { type: 'string' },
      issues: { type: 'array', maxItems: 30, items: { $ref: '#/$defs/issue' } },
    },
    $defs: { issue: issueSchema() },
  },
  finalValidation: {
    type: 'object', additionalProperties: false,
    required: ['verdict', 'summary', 'issues'],
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fix'] },
      summary: { type: 'string' },
      issues: { type: 'array', maxItems: 30, items: { $ref: '#/$defs/issue' } },
      assessment: {
        type: 'object', additionalProperties: false,
        required: ['correctness', 'taskCompliance', 'fixAuthorization'],
        properties: {
          correctness: { type: 'string', enum: ['no_defect', 'defect_confirmed', 'unknown'] },
          taskCompliance: { type: 'string', enum: ['verified', 'incomplete', 'unknown'] },
          fixAuthorization: { type: 'string', enum: ['in_scope', 'requires_approval', 'unknown'] },
        },
      },
    },
    $defs: { issue: issueSchema() },
  },
};


// Read-only analysis only. Its verdict is advisory, never permission to write.
schemas.implementationReconciliation = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'summary', 'risks', 'verification', 'affectedStages'],
  properties: {
    decision: { type: 'string', enum: ['compatible', 'reverify', 'blocked'] },
    summary: { type: 'string' },
    risks: { type: 'array', maxItems: 20, items: { type: 'string' } },
    verification: { type: 'array', maxItems: 20, items: { type: 'string' } },
    affectedStages: { type: 'array', maxItems: 12, items: { type: 'string' } },
  },
};

// Separate from the normal change-workflow reviewer schema: only read-only
// scoped reviews must account for explicit checklist items and file inventory.
schemas.scopedReview = {
  ...schemas.review,
  required: [...schemas.review.required, 'coverage', 'inventory'],
  properties: {
    ...schemas.review.properties,
    coverage: {
      type: 'array', maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['id', 'status', 'evidence'],
        properties: {
          id: { type: 'string' },
          reviewedPaths: { type: 'array', maxItems: 64, items: { type: 'string' } },
          fileEvidence: { type: 'array', maxItems: 16, items: {
            type: 'object', additionalProperties: false, required: ['path', 'evidence'],
            properties: { path: { type: 'string' }, evidence: { type: 'string' } },
          } },
          status: { type: 'string', enum: ['checked', 'blocked', 'not_checked'] },
          evidence: { type: 'string' },
      contractId: { type: 'string', maxLength: 300 },
      reproductionKey: { type: 'string', maxLength: 500 },
        },
      },
    },
    // Optional for old providers; enforce mode requires assessments at the
    // workflow boundary, not by modifying the universal reviewer schema.
    riskAssessments: { type:'array', maxItems:32, items:{ type:'object', additionalProperties:false,
      required:['riskId','status','outcome','evidence','sourceRefs'], properties:{
        riskId:{type:'string',maxLength:64}, status:{type:'string',enum:['investigated','blocked']},
        outcome:{type:'string',enum:['issue_found','no_issue_supported','uncertain']},
        evidence:{type:'string',maxLength:1000},
        sourceRefs:{type:'array',maxItems:16,items:{type:'string',maxLength:400}}
      } } },
    openQuestions: { type:'array', maxItems:8, items:{type:'object',additionalProperties:false,
      required:['statement','sourceRefs','relatedUnitIds','materiality'], properties:{
        statement:{type:'string',maxLength:500},
        materiality:{type:'string',enum:['normal','high','critical']},
        sourceRefs:{type:'array',maxItems:16,items:{type:'string',maxLength:400}},
        relatedUnitIds:{type:'array',maxItems:16,items:{type:'string',maxLength:90}}
      } } },
    inventory: {
      type: 'object', additionalProperties: false,
      required: ['changedFiles', 'reviewedFiles', 'source'],
      properties: {
        changedFiles: { type: ['integer', 'null'], minimum: 0 },
        reviewedFiles: { type: ['integer', 'null'], minimum: 0 },
        source: { type: 'string' },
      },
    },
  },
};

// Stage-specific evidence is separate from the ordinary implementation
// contract. All normal/fixer coder calls retain their original schema.
schemas.stagedImplementation = {
  ...schemas.implementation,
  required: [...schemas.implementation.required, 'stepResults'],
  properties: {
    ...schemas.implementation.properties,
    stepResults: { type: 'array', maxItems: 64, items: {
      type: 'object', additionalProperties: false, required: ['id', 'status', 'evidence'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['implemented', 'already_satisfied', 'blocked'] },
        evidence: { type: 'string' },
      contractId: { type: 'string', maxLength: 300 },
      reproductionKey: { type: 'string', maxLength: 500 },
        proofKind: { type: 'string', enum: ['change', 'verification', 'analysis', 'existing'] },
        checks: { type: 'array', maxItems: 20, items: {
          type: 'object', additionalProperties: false, required: ['command', 'outcome', 'evidence'],
          properties: { command: { type: 'string' }, outcome: { type: 'string', enum: ['passed', 'failed', 'unavailable'] }, evidence: { type: 'string' } },
        } },
      },
    } },
  },
};

schemas.implementationReview = {
  ...schemas.review,
  required: [...schemas.review.required, 'acceptanceResults'],
  properties: {
    ...schemas.review.properties,
    acceptanceResults: { type: 'array', maxItems: 64, items: {
      type: 'object', additionalProperties: false, required: ['id', 'status', 'evidence'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['verified', 'blocked', 'not_verified'] },
        evidence: { type: 'string' },
      contractId: { type: 'string', maxLength: 300 },
      reproductionKey: { type: 'string', maxLength: 500 },
        sourceAnchors: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
          required: ['path', 'excerpt'], properties: { path: { type: 'string' }, excerpt: { type: 'string' } } } },
      },
    } },
  },
};

function issueSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['severity', 'path', 'message', 'suggestedFix'],
    properties: {
      severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
      path: { type: ['string', 'null'] },
      startLine: { type: 'integer', minimum: 1, maximum: 10000000 },
      endLine: { type: 'integer', minimum: 1, maximum: 10000000 },
      sourceRevision: { type: 'string', maxLength: 128 },
      message: { type: 'string' },
      suggestedFix: { type: ['string', 'null'] },
      // Optional for backward compatibility with existing providers and saved outputs.
      origin: { type: 'string', enum: ['introduced', 'exposed_existing', 'pre_existing', 'preexisting', 'related', 'unknown'] },
      taskRelation: { type: 'string', enum: ['requirement', 'dependency', 'independent', 'unknown'] },
      remediationScope: { type: 'string', enum: ['in_scope', 'outside_scope', 'unknown'] },
      evidence: { type: 'string' },
      contractId: { type: 'string', maxLength: 300 },
      reproductionKey: { type: 'string', maxLength: 500 },
      affectedBehavior: { type: 'string', maxLength: 180 },
      failureMode: { type: 'string', maxLength: 180 },
    },
  };
}

export function assertShape(kind, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw kind === 'routing'
      ? routingShapeError('invalid_routing_root', 'routing output must be a JSON object.')
      : new Error(`${kind} output must be a JSON object.`);
  }

  const requireString = (key) => {
    if (typeof value[key] !== 'string') throw new Error(`${kind}.${key} must be a string.`);
  };
  const requireStringArray = (key, { min = 0 } = {}) => {
    if (!Array.isArray(value[key]) || value[key].length < min || value[key].some((x) => typeof x !== 'string')) {
      throw new Error(`${kind}.${key} must be an array of strings${min ? ` with at least ${min} item(s)` : ''}.`);
    }
  };
  const validateIssues = () => {
    if (!Array.isArray(value.issues)) throw new Error(`${kind}.issues must be an array.`);
    for (const [i, issue] of value.issues.entries()) {
      if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error(`${kind}.issues[${i}] must be an object.`);
      if (!['blocking', 'major', 'minor'].includes(issue.severity)) throw new Error(`${kind}.issues[${i}].severity is invalid.`);
      if (issue.path !== null && typeof issue.path !== 'string') throw new Error(`${kind}.issues[${i}].path must be string|null.`);
      if (typeof issue.message !== 'string') throw new Error(`${kind}.issues[${i}].message must be a string.`);
      if (issue.suggestedFix !== null && typeof issue.suggestedFix !== 'string') throw new Error(`${kind}.issues[${i}].suggestedFix must be string|null.`);
      for (const lineField of ['startLine','endLine']) if (issue[lineField] !== undefined &&
        (!Number.isSafeInteger(issue[lineField]) || issue[lineField] < 1 || issue[lineField] > 10000000))
        throw new Error(`${kind}.issues[${i}].${lineField} is invalid.`);
      if (issue.startLine && issue.endLine && issue.endLine < issue.startLine) throw new Error(`${kind}.issues[${i}] invalid line range.`);
      if (issue.sourceRevision !== undefined && (typeof issue.sourceRevision !== 'string' || issue.sourceRevision.length > 128))
        throw new Error(`${kind}.issues[${i}].sourceRevision is invalid.`);
      for (const field of ['contractId', 'reproductionKey', 'affectedBehavior', 'failureMode']) {
        if (issue[field] !== undefined && (typeof issue[field] !== 'string' || issue[field].length > (field === 'contractId' ? 300 : ['affectedBehavior','failureMode'].includes(field) ? 180 : 500)))
          throw new Error(`${kind}.issues[${i}].${field} is invalid.`);
      }
    }
  };

  if (kind === 'routing') {
    if (!['change', 'review', 'investigate'].includes(value.mode))
      throw routingShapeError('invalid_routing_mode', 'Invalid routing.mode.');
    if (!['explicit', 'not_requested', 'ambiguous'].includes(value.writeIntent))
      throw routingShapeError('invalid_routing_write_intent', 'Invalid routing.writeIntent.');
    if (!['low', 'medium', 'high'].includes(value.complexity))
      throw routingShapeError('invalid_routing_complexity', 'Invalid routing.complexity.');
    if (!['normal', 'architecture', 'security_or_data'].includes(value.risk))
      throw routingShapeError('invalid_routing_risk', 'Invalid routing.risk.');
    if (typeof value.reason !== 'string')
      throw routingShapeError('invalid_routing_reason', 'routing.reason must be a string.');
    if (value.title !== undefined && (typeof value.title !== 'string' ||
        value.title.length < 1 || value.title.length > 120))
      throw routingShapeError('invalid_routing_title', 'routing.title is invalid.');
    if (Object.keys(value).some(key => !Object.hasOwn(schemas.routing.properties, key)))
      throw routingShapeError('invalid_routing_extra_fields', 'routing output has unknown fields.');
    // The schema requires a typed task. Never synthesize one for a failed route.
    if (!Object.hasOwn(value, 'task')) throw Object.assign(new Error('missing_task_spec'), { code: 'ROUTER_TASK_MISSING' });
    validateTaskSpec(value.task);
  } else if (kind === 'exploration') {
    requireString('summary');
    for (const key of ['relevantFiles', 'constraints', 'existingPatterns', 'likelyVerification', 'unknowns']) requireStringArray(key);
  } else if (kind === 'plan') {
    requireString('goal');
    requireStringArray('steps', { min: 1 });
    requireStringArray('acceptanceCriteria', { min: 1 });
    if (value.acceptanceChecks !== undefined && (!Array.isArray(value.acceptanceChecks) || value.acceptanceChecks.length > 64 ||
      value.acceptanceChecks.some((entry, i) => !entry || entry.id !== `A${i + 1}` || !Array.isArray(entry.commands) ||
        entry.commands.length > 16 || entry.commands.some((cmd) => typeof cmd !== 'string' || !cmd.trim())))) {
      throw new Error('plan.acceptanceChecks must map A1..An to explicit command lists.');
    }
    if (value.acceptanceReviews !== undefined && (!Array.isArray(value.acceptanceReviews) ||
      value.acceptanceReviews.length > 64 || value.acceptanceReviews.some((entry, i) =>
        entry?.id !== `A${i + 1}` || !Array.isArray(entry.paths) || !entry.paths.length ||
        entry.paths.length > 8 || entry.paths.some((p) => typeof p !== 'string' || !p.trim())))) {
      throw new Error('plan.acceptanceReviews must map A1..An to inspected repository paths.');
    }
    requireStringArray('risks');
    requireStringArray('expectedFiles');
    if (!value.engineeringFrame || typeof value.engineeringFrame !== 'object' || Array.isArray(value.engineeringFrame)) {
      throw new Error('plan.engineeringFrame must be an object.');
    }
    const frame = value.engineeringFrame;
    if (typeof frame.currentOwner !== 'string') throw new Error('plan.engineeringFrame.currentOwner must be a string.');
    if (typeof frame.generalMechanism !== 'string') throw new Error('plan.engineeringFrame.generalMechanism must be a string.');
    if (typeof frame.specificPolicy !== 'string') throw new Error('plan.engineeringFrame.specificPolicy must be a string.');
    for (const key of ['existingAbstractions', 'targetPlacement', 'stateOwnership', 'resourceOwnership', 'contractRisks', 'avoid', 'uncertainties']) {
      if (!Array.isArray(frame[key]) || frame[key].some((x) => typeof x !== 'string')) {
        throw new Error(`plan.engineeringFrame.${key} must be an array of strings.`);
      }
    }
  } else if (kind === 'implementationReconciliation') {
    if (!['compatible', 'reverify', 'blocked'].includes(value.decision)) throw new Error('Invalid reconciliation decision.');
    requireString('summary');
    requireStringArray('risks');
    requireStringArray('verification');
    requireStringArray('affectedStages');
  } else if (kind === 'implementation' || kind === 'stagedImplementation') {
    if (!['changed', 'no_change'].includes(value.action)) throw new Error('Invalid implementation.action.');
    requireString('summary');
    requireStringArray('changedFiles');
    requireStringArray('notes');
    if (kind === 'stagedImplementation') {
      if (!Array.isArray(value.stepResults) || value.stepResults.length > 64) throw new Error('stagedImplementation.stepResults is invalid.');
      for (const row of value.stepResults) {
        if (typeof row?.id !== 'string' || !['implemented', 'already_satisfied', 'blocked'].includes(row.status) || typeof row.evidence !== 'string') {
          throw new Error('stagedImplementation.stepResults has invalid ID, status or evidence.');
        }
        if (row.proofKind !== undefined && !['change', 'verification', 'analysis', 'existing'].includes(row.proofKind))
          throw new Error('stagedImplementation.stepResults has invalid proofKind.');
        if (row.checks !== undefined && (!Array.isArray(row.checks) || row.checks.length > 20 || row.checks.some((check) =>
          typeof check?.command !== 'string' || !['passed', 'failed', 'unavailable'].includes(check.outcome) || typeof check.evidence !== 'string')))
          throw new Error('stagedImplementation.stepResults has invalid checks.');
      }
    }
  } else if (kind === 'review' || kind === 'scopedReview' || kind === 'implementationReview') {
    if (!['pass', 'fix', 'escalate'].includes(value.verdict)) throw new Error('Invalid review.verdict.');
    requireString('summary');
    validateIssues();
    if (kind === 'implementationReview') {
      if (!Array.isArray(value.acceptanceResults) || value.acceptanceResults.length > 64) throw new Error('implementationReview.acceptanceResults is invalid.');
      for (const row of value.acceptanceResults) {
        if (typeof row?.id !== 'string' || !['verified', 'blocked', 'not_verified'].includes(row.status) || typeof row.evidence !== 'string') {
          throw new Error('implementationReview.acceptanceResults has invalid ID, status or evidence.');
        }
        if (row.sourceAnchors !== undefined && (!Array.isArray(row.sourceAnchors) || row.sourceAnchors.length > 8 ||
          row.sourceAnchors.some((a) => typeof a?.path !== 'string' || typeof a?.excerpt !== 'string' ||
            a.excerpt.length < 12 || a.excerpt.length > 300))) {
          throw new Error('implementationReview.acceptanceResults.sourceAnchors must reference actual bounded source excerpts.');
        }
      }
    }
    if (kind === 'scopedReview') {
      if (!Array.isArray(value.coverage) || value.coverage.length > 8) throw new Error('scopedReview.coverage must be an array of up to 8 items.');
      for (const [index, row] of value.coverage.entries()) {
        if (typeof row?.id !== 'string' || !['checked', 'blocked', 'not_checked'].includes(row.status) || typeof row.evidence !== 'string' ||
            (row.reviewedPaths !== undefined && (!Array.isArray(row.reviewedPaths) || row.reviewedPaths.length > 64 || row.reviewedPaths.some((path) => typeof path !== 'string'))) ||
            (row.fileEvidence !== undefined && (!Array.isArray(row.fileEvidence) || row.fileEvidence.length > 16 || row.fileEvidence.some((item) => typeof item?.path !== 'string' || typeof item?.evidence !== 'string')))) {
          throw new Error(`scopedReview.coverage[${index}] has invalid ID, status or evidence.`);
        }
      }
      if (value.riskAssessments !== undefined && (!Array.isArray(value.riskAssessments) ||
          value.riskAssessments.length > 32 || value.riskAssessments.some(row =>
            typeof row?.riskId !== 'string' || row.riskId.length > 64 ||
            !['investigated','blocked'].includes(row.status) ||
            !['issue_found','no_issue_supported','uncertain'].includes(row.outcome) ||
            typeof row.evidence !== 'string' || row.evidence.length > 1000 ||
            !Array.isArray(row.sourceRefs) || row.sourceRefs.length > 16 ||
            row.sourceRefs.some(p => typeof p !== 'string' || p.length > 400))))
        throw new Error('scopedReview.riskAssessments is invalid.');
      if (value.openQuestions !== undefined && (!Array.isArray(value.openQuestions) ||
          value.openQuestions.length > 8 || value.openQuestions.some(row =>
            typeof row?.statement !== 'string' || row.statement.length > 500 ||
            !['normal','high','critical'].includes(row.materiality) ||
            !Array.isArray(row.sourceRefs) || row.sourceRefs.length > 16 ||
            row.sourceRefs.some(p => typeof p !== 'string' || p.length > 400) ||
            !Array.isArray(row.relatedUnitIds) || row.relatedUnitIds.length > 16 ||
            row.relatedUnitIds.some(id => typeof id !== 'string' || id.length > 90))))
        throw new Error('scopedReview.openQuestions is invalid.');
      const inventory = value.inventory;
      if (!inventory || typeof inventory !== 'object' ||
          ![inventory.changedFiles, inventory.reviewedFiles].every((v) => v === null || (Number.isSafeInteger(v) && v >= 0)) ||
          typeof inventory.source !== 'string') {
        throw new Error('scopedReview.inventory must contain changedFiles, reviewedFiles (non-negative integers or null) and source.');
      }
    }
  } else if (kind === 'finalValidation') {
    if (!['pass', 'fix'].includes(value.verdict)) throw new Error('Invalid finalValidation.verdict.');
    requireString('summary');
    validateIssues();
    if (value.assessment !== undefined) {
      const a = value.assessment;
      if (!a || !['no_defect', 'defect_confirmed', 'unknown'].includes(a.correctness) ||
          !['verified', 'incomplete', 'unknown'].includes(a.taskCompliance) ||
          !['in_scope', 'requires_approval', 'unknown'].includes(a.fixAuthorization)) {
        throw new Error('Invalid finalValidation.assessment.');
      }
    }
  } else {
    throw new Error(`Unknown schema kind: ${kind}`);
  }
  return value;
}
