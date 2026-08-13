import { z } from 'zod';
import { beginLlmBilling, parseUsage, type LlmBilling } from './credits.js';
import { isSupabaseStorage } from './supabase.js';
import { beginRemoteLlmBilling, type RemoteLlmBilling } from './supabase-credits.js';
import { generatorTools } from '../shared/generators.js';
import {
  LessonGenerationInputSchema,
  LessonMaterialSchema,
  GeneratedQuizSchema,
  type LessonGenerationInput,
  type LessonArticle,
  type LessonNode,
  type GeneratedQuiz,
  QuizGenerationInputSchema,
  QuizSchema,
  RoadmapSchema,
  TopicInputSchema,
  lessonArticleBlockContext,
  type LessonMaterial,
  type Quiz,
  type QuizGenerationInput,
  type CourseLanguage,
  type Roadmap,
} from '../shared/schemas.js';

type ToolParameterSchema = Record<string, unknown>;

type GeneratorSettings = {
  providerId: string;
  displayName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

const configuredProviderTimeout = Number(process.env.SYNAU_PROVIDER_TIMEOUT_MS ?? 120_000);
const PROVIDER_TIMEOUT_MS = Number.isFinite(configuredProviderTimeout) && configuredProviderTimeout >= 10_000
  ? Math.min(configuredProviderTimeout, 300_000)
  : 120_000;

const defaultSettings = (): GeneratorSettings => ({
  providerId: process.env.SYNAU_PROVIDER_ID ?? 'sumopod',
  displayName: process.env.SYNAU_PROVIDER_NAME ?? 'Sumopod',
  baseUrl: process.env.SYNAU_OPENAI_BASE_URL ?? 'https://ai.sumopod.com/v1',
  model: process.env.SYNAU_OPENAI_MODEL ?? 'deepseek-v4-flash',
  apiKey: process.env.SYNAU_OPENAI_API_KEY ?? '',
});

export function getFixedProviderSettings(): GeneratorSettings {
  return defaultSettings();
}

function completionUrl(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}


function providerErrorDetail(body: string) {
  const trimmed = body.trim();
  if (!trimmed) return '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    parsed = undefined;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const root = parsed as Record<string, unknown>;
    const nestedError = root.error;
    const nestedMessage = nestedError && typeof nestedError === 'object' && !Array.isArray(nestedError)
      ? (nestedError as Record<string, unknown>).message
      : undefined;
    const message = [root.message, root.detail, typeof nestedError === 'string' ? nestedError : undefined, nestedMessage]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (message) return message.replace(/\s+/g, ' ').trim().slice(0, 360);
  }

  // Never echo an entire upstream response into the UI or logs. Plain-text
  // provider errors are still useful when bounded to a short diagnostic.
  return trimmed.replace(/\s+/g, ' ').slice(0, 360);
}

const stringArray = { type: 'array', items: { type: 'string' } };

const toolParameters: Record<keyof typeof generatorTools, ToolParameterSchema> = {
  roadmap: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'description', 'topic', 'outcomes', 'sections'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      topic: { type: 'string' },
      language: { type: 'string', enum: ['en', 'id'] },
      outcomes: stringArray,
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'summary', 'position', 'lessons'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            position: { type: 'integer' },
            lessons: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'title', 'summary', 'estimatedMinutes', 'position'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  summary: { type: 'string' },
                  estimatedMinutes: { type: 'integer' },
                  position: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
  lesson: {
    type: 'object',
    additionalProperties: false,
    required: ['lessonId', 'title', 'overview', 'article', 'sources', 'keyTakeaway'],
    properties: {
      lessonId: { type: 'string' },
      title: { type: 'string' },
      overview: { type: 'string' },
      article: {
        type: 'object',
        additionalProperties: false,
        required: ['sections'],
        properties: {
          sections: {
            type: 'array', minItems: 2, maxItems: 5,
            items: {
              type: 'object', additionalProperties: false,
              required: ['heading', 'content'],
              properties: {
                heading: { type: 'string' },
                content: {
                  type: 'array', minItems: 2, maxItems: 10,
                  items: {
                    type: 'object', additionalProperties: false,
                    required: ['type'],
                    properties: {
                      type: { type: 'string', enum: ['paragraph', 'code', 'equation', 'mermaid', 'table', 'quote'] },
                      text: { type: 'string' },
                      language: { type: 'string' },
                      code: { type: 'string' },
                      latex: { type: 'string' },
                      caption: { type: 'string' },
                      attribution: { type: 'string' },
                      sourceId: { type: 'string' },
                      columns: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
                      rows: {
                        type: 'array', minItems: 2, maxItems: 8,
                        items: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      sources: {
        type: 'array', minItems: 1, maxItems: 4,
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'title', 'url', 'publisher', 'kind'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
            publisher: { type: 'string' },
            kind: { type: 'string', enum: ['article', 'video', 'documentation', 'course', 'paper', 'book', 'other'] },
          },
        },
      },
      keyTakeaway: { type: 'string' },
    },
  },
  quiz: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'scope', 'scopeId', 'title', 'instructions', 'questions'],
    properties: {
      id: { type: 'string' },
      scope: { type: 'string', enum: ['lesson', 'chapter', 'course'] },
      scopeId: { type: 'string' },
      title: { type: 'string' },
      instructions: { type: 'string' },
      questions: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'prompt', 'options', 'answerIndex', 'explanation', 'kind', 'articleAnchor'],
          properties: {
            id: { type: 'string' },
            prompt: { type: 'string' },
            options: { type: 'array', minItems: 3, maxItems: 4, uniqueItems: true, items: { type: 'string', maxLength: 180 } },
            answerIndex: { type: 'integer', minimum: 0, maximum: 4 },
            explanation: { type: 'string', maxLength: 280 },
            kind: { type: 'string', enum: ['article', 'challenge'] },
            articleAnchor: { type: 'string', minLength: 8, maxLength: 180 },
          },
        },
      },
    },
  },
};

function useDemoProvider(settings: GeneratorSettings) {
  return process.env.SYNAU_DEMO_MODE === 'true'
    || (process.env.SYNAU_DEMO_MODE !== 'false' && !settings.apiKey);
}

type CompletionPayload = {
  choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
  usage?: unknown;
};

type CompletionAttempt = {
  response: Response;
  body: string;
  usage: ReturnType<typeof parseUsage>;
};

async function requestCompletion(settings: GeneratorSettings, requestBody: Record<string, unknown>): Promise<CompletionAttempt> {
  let response: Response;
  try {
    const requestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 9router defaults omitted `stream` to SSE. Synau consumes complete
        // tool calls as JSON, so make the non-streaming usage-tracked path
        // explicit for every generator and repair attempt.
        accept: 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      body: JSON.stringify(requestBody),
    } satisfies RequestInit;
    if (!settings.apiKey) throw new Error('The fixed Sumopod provider is not configured on the backend.');
    response = await fetch(completionUrl(settings.baseUrl), requestInit);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The fixed Sumopod')) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`Model provider timed out after ${PROVIDER_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new Error('Model provider request failed.');
  }
  const body = await response.text();
  return { response, body, usage: parseUsage(parseCompletionPayload(body)) };
}

function shouldRetryWithoutToolChoice(attempt: CompletionAttempt) {
  if (attempt.response.status !== 400 && attempt.response.status !== 403 && attempt.response.status !== 404) return false;
  const message = attempt.body.toLocaleLowerCase();
  return message.includes('tool_choice')
    || message.includes('tool choice')
    || message.includes('function calling')
    || /thinking mode.*(support|tool)/.test(message);
}

function parseCompletionPayload(body: string): CompletionPayload | null {
  const trimmed = body.trim();
  const candidates = [trimmed];
  const doneIndex = trimmed.indexOf('data: [DONE]');
  if (doneIndex > 0) candidates.unshift(trimmed.slice(0, doneIndex).trim());
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) candidates.push(line.slice('data:'.length).trim());
  }
  for (const candidate of candidates) {
    if (!candidate || candidate === '[DONE]') continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as CompletionPayload;
    } catch {
      // Some OpenAI-compatible routers append an SSE DONE marker to a JSON response.
    }
  }
  return null;
}

type ToolRequestContext = {
  key: keyof typeof generatorTools;
  settings: GeneratorSettings;
  onUsage?: (usage: ReturnType<typeof parseUsage>) => void;
};

async function requestToolArguments(args: ToolRequestContext, requestBody: Record<string, unknown>) {
  let attempt = await requestCompletion(args.settings, {
    ...requestBody,
    tool_choice: { type: 'function', function: { name: generatorTools[args.key].name } },
  });
  args.onUsage?.(attempt.usage);
  if (!attempt.response.ok && shouldRetryWithoutToolChoice(attempt)) {
    attempt = await requestCompletion(args.settings, requestBody);
    args.onUsage?.(attempt.usage);
  }
  if (!attempt.response.ok) {
    const detail = providerErrorDetail(attempt.body);
    throw new Error(`Model provider error (${attempt.response.status})${detail ? `: ${detail}` : '.'}`);
  }
  const payload = parseCompletionPayload(attempt.body);
  if (!payload) {
    throw new Error('Model provider returned invalid JSON.');
  }
  const toolCall = payload.choices?.[0]?.message?.tool_calls?.find((call) => call.function?.name === generatorTools[args.key].name);
  if (!toolCall?.function?.arguments) {
    throw new Error(`Model provider did not return the required ${generatorTools[args.key].name} tool call.`);
  }
  try {
    return JSON.parse(toolCall.function.arguments) as unknown;
  } catch {
    throw new Error(`Model provider returned invalid ${args.key} arguments.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLessonArticleBlock(value: unknown) {
  if (!isRecord(value)) return value;
  const type = typeof value.type === 'string' ? value.type : '';
  const text = typeof value.text === 'string' ? value.text : typeof value.body === 'string' ? value.body : undefined;
  if (type === 'paragraph') {
    return { type, text };
  }
  if (type === 'code') {
    return {
      type,
      language: value.language,
      code: typeof value.code === 'string' ? value.code : text,
      ...(typeof value.caption === 'string' ? { caption: value.caption } : {}),
    };
  }
  if (type === 'equation') {
    return {
      type,
      latex: typeof value.latex === 'string' ? value.latex : text,
      ...(typeof value.caption === 'string' ? { caption: value.caption } : {}),
    };
  }
  if (type === 'mermaid') {
    return {
      type,
      code: typeof value.code === 'string' ? value.code : text,
      ...(typeof value.caption === 'string' ? { caption: value.caption } : {}),
    };
  }
  if (type === 'table') {
    return {
      type,
      ...(typeof value.caption === 'string' ? { caption: value.caption } : {}),
      columns: value.columns,
      rows: value.rows,
    };
  }
  if (type === 'quote') {
    return {
      type,
      text,
      ...(typeof value.attribution === 'string' ? { attribution: value.attribution } : {}),
      ...(typeof value.sourceId === 'string' ? { sourceId: value.sourceId } : {}),
    };
  }
  return value;
}

function normalizeLessonToolArguments(value: unknown) {
  if (!isRecord(value) || !isRecord(value.article) || !Array.isArray(value.article.sections)) return value;
  return {
    ...value,
    article: {
      ...value.article,
      sections: value.article.sections.map((section) => {
        if (!isRecord(section)) return section;
        const heading = typeof section.heading === 'string' ? section.heading : section.title;
        return {
          heading,
          ...(Array.isArray(section.paragraphs) ? { paragraphs: section.paragraphs } : {}),
          content: Array.isArray(section.content) ? section.content.map(normalizeLessonArticleBlock) : section.content,
        };
      }),
    },
  };
}

async function callTool<T>(args: {
  key: keyof typeof generatorTools;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  settings: GeneratorSettings;
  userId: string;
  fallback: () => T;
}) {
  if (useDemoProvider(args.settings)) {
    const localToolName = generatorTools[args.key].name;
    console.info(`[tool:${localToolName}] deterministic local invocation`);
    const qaDelayMs = Math.min(5_000, Math.max(0, Number(process.env.SYNAU_QA_GENERATION_DELAY_MS ?? 0)));
    if (qaDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, qaDelayMs));
    return args.schema.parse(args.fallback());
  }
  if (!args.settings.apiKey) {
    throw new Error('The fixed Sumopod provider is not configured on the backend.');
  }

  const generationArgs = args;
  let billing: LlmBilling | RemoteLlmBilling | null = null;
  let completed = false;
  const requestBody: Record<string, unknown> = {
    model: args.settings.model,
    temperature: 0.25,
    stream: false,
    // Keep all Synau generation deterministic and compatible with tool calls.
    // Some routers enable reasoning by default, which can reject tool_choice.
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
    tools: [{
      type: 'function',
      function: {
        name: generatorTools[args.key].name,
        description: generatorTools[args.key].description,
        parameters: toolParameters[args.key],
      },
    }],
  };
  try {
    billing = isSupabaseStorage()
      ? await beginRemoteLlmBilling(args.userId, args.key, args.settings.providerId, args.settings.model)
      : beginLlmBilling(args.userId, args.key, args.settings.providerId, args.settings.model);
    const onUsage = (usage: ReturnType<typeof parseUsage>) => billing?.addUsage(usage);
    const requestContext = { ...generationArgs, onUsage };
    let repairRequestBody = requestBody;
    for (let repairPass = 0; repairPass <= 2; repairPass += 1) {
      let toolArguments: unknown;
      try {
        toolArguments = await requestToolArguments(requestContext, repairRequestBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (repairPass >= 2 || (!message.includes('returned invalid') && !message.includes('did not return the required'))) throw error;
        console.warn(`[tool:${generatorTools[args.key].name}] provider response format failed; requesting a corrected tool call`, { repairPass: repairPass + 1, message });
        repairRequestBody = addToolRepairMessage(repairRequestBody, args.key, message);
        continue;
      }
      const normalizedToolArguments = args.key === 'lesson'
        ? normalizeLessonToolArguments(toolArguments)
        : toolArguments;
      const parsed = args.schema.safeParse(normalizedToolArguments);
      if (parsed.success) {
        completed = true;
        return parsed.data;
      }
      const issues = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ');
      if (repairPass >= 2) {
        console.error(`[tool:${generatorTools[args.key].name}] schema validation failed after repair`, parsed.error.issues);
        throw new Error(`Model provider returned invalid ${args.key} data: ${issues}`);
      }
      console.warn(`[tool:${generatorTools[args.key].name}] schema validation failed; requesting a corrected tool call`, { repairPass: repairPass + 1, issues });
      repairRequestBody = addToolRepairMessage(repairRequestBody, args.key, issues);
    }
    throw new Error(`Model provider returned invalid ${args.key} data.`);
  } finally {
    if (billing) await billing.finish(completed ? 'success' : 'failed');
  }
}

function addToolRepairMessage(requestBody: Record<string, unknown>, key: keyof typeof generatorTools, issue: string) {
  const guidance = key === 'quiz'
    ? 'Return exactly 3 questions in order: exactly 2 with kind article and 1 with kind challenge. Article questions must be answerable directly from the supplied material context; the challenge must apply the same ideas to a new situation. Every question needs an articleAnchor of 8 to 180 characters, exactly 4 unique options under 180 characters, an explanation under 280 characters, and an answerIndex from 0 through options.length - 1.'
    : key === 'lesson'
      ? 'Article must contain 2 to 5 sections with ordered content blocks, a two-sentence overview, and a distinct opening paragraph of at least 45 words. Use the learner\'s language and write with a natural editorial voice. If the material explains a process, sequence, causal chain, feedback loop, decision tree, system relationship, framework, or lifecycle, include one simple valid mermaid diagram immediately after the relevant explanation. Use code, equation, table, or quote only when it improves this lesson. Every [[source-id]] marker must match a source id. Omit legacy nodes, blocks, practice, dataLab, reflection, and source-note fields.'
      : 'Keep every lesson object complete with id, title, summary, estimatedMinutes, and position.';
  return {
    ...requestBody,
    messages: [
      ...(Array.isArray(requestBody.messages) ? requestBody.messages : []),
      {
        role: 'user',
        content: `Your previous ${generatorTools[key].name} tool response failed validation. Return a corrected tool call only. Fix this issue: ${issue}. ${guidance} Respect every required field, every string length limit, and every array limit. Omit optional fields instead of returning them in the wrong type.`,
      },
    ],
  };
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'topic';
}

type DecisionDataConcept = 'metrics' | 'baselines' | 'uncertainty' | 'bias' | 'causality' | 'constraints';

type DecisionDataLessonDefinition = {
  title: string;
  summary: string;
  estimatedMinutes: number;
  focus: string;
  overview: string;
  blocks: LessonMaterial['blocks'];
  keyTakeaway: string;
  reflectivePrompt: string;
  practice: NonNullable<LessonMaterial['practice']>;
  dataLab: NonNullable<LessonMaterial['dataLab']>;
  questions: Array<Omit<Quiz['questions'][number], 'id'>>;
};

const decisionDataConceptOrder: DecisionDataConcept[] = [
  'metrics',
  'baselines',
  'uncertainty',
  'bias',
  'causality',
  'constraints',
];

const decisionDataCurriculum: {
  title: string;
  description: string;
  outcomes: string[];
  sections: Array<{
    id: string;
    title: string;
    summary: string;
    concepts: DecisionDataConcept[];
  }>;
  lessons: Record<DecisionDataConcept, DecisionDataLessonDefinition>;
} = {
  title: 'Decision making with data: from evidence to action',
  description: 'A practical path for framing a decision, choosing useful metrics and baselines, reading uncertain or biased evidence, separating correlation from causation, and acting within real constraints.',
  outcomes: [
    'Frame a concrete decision and define an outcome metric with a guardrail',
    'Choose a comparable baseline and interpret estimates without false certainty',
    'Detect common sources of bias and distinguish correlation from causation',
    'Choose and document an action that respects costs, risks, and reversibility',
  ],
  sections: [
    {
      id: 'metrics-baselines',
      title: 'Metrics and baselines',
      summary: 'Define what success means and establish a comparison that makes the number interpretable.',
      concepts: ['metrics', 'baselines'],
    },
    {
      id: 'uncertainty-bias',
      title: 'Uncertainty and bias',
      summary: 'Read noisy evidence carefully and inspect how the data was produced before trusting it.',
      concepts: ['uncertainty', 'bias'],
    },
    {
      id: 'causality-constraints',
      title: 'Causality and constrained decisions',
      summary: 'Ask what would change because of an action, then choose a feasible move with explicit tradeoffs.',
      concepts: ['causality', 'constraints'],
    },
  ],
  lessons: {
    metrics: {
      title: 'From a decision to useful metrics',
      summary: 'Turn a vague goal into a decision, an outcome metric, and a guardrail that protects against obvious harm.',
      estimatedMinutes: 15,
      focus: 'a decision-first metric definition',
      overview: 'Data becomes useful only after the decision is clear. This subchapter turns a broad goal into an action an owner could take, then defines one outcome metric and one guardrail with explicit denominators, segments, and time windows.',
      blocks: [
        {
          heading: 'Name the decision before the dashboard',
          body: '“Improve attendance” is a goal, not a decision. A decision states the available action, owner, and horizon: “Should the operations lead expand appointment reminders to all eligible customers next month?” That framing tells you which evidence matters and which data is merely interesting.',
          bullets: ['Action: what could change?', 'Owner: who can commit?', 'Horizon: when must the choice be made?'],
        },
        {
          heading: 'Pair an outcome with a guardrail',
          body: 'For the illustrative reminder decision, an outcome could be completed appointments per eligible customer. A guardrail could be opt-out complaints per 1,000 delivered reminders. “Messages sent” is an activity count; it does not show whether the intended outcome improved or whether the rollout caused avoidable harm.',
          bullets: ['Define numerator and denominator.', 'Name the population and time window.', 'Add a guardrail for a plausible downside.'],
        },
        {
          heading: 'Write the metric contract',
          body: 'A metric contract is a short definition everyone can reproduce: event, eligible population, exclusions, unit, time window, and data owner. If two analysts can calculate different answers from the same words, the decision is not ready for measurement.',
          bullets: ['Event: what exactly counts?', 'Eligibility: who could have produced the event?', 'Ownership: who checks definition or instrumentation changes?'],
        },
      ],
      keyTakeaway: 'Start with a concrete decision, then define an outcome metric and guardrail precisely enough that another person could calculate them the same way.',
      reflectivePrompt: 'Which metric in your current work looks useful but does not yet point to a specific decision?',
      practice: {
        prompt: 'Create a one-page measurement card for one real decision. Include the decision, owner, horizon, outcome metric, guardrail, and exact population.',
        steps: ['Write the decision as a choice between actions.', 'Define the outcome metric with numerator and denominator.', 'Add one guardrail for a credible downside.', 'Specify segment, window, exclusions, and data owner.'],
        rubric: ['The decision could lead to a concrete action.', 'The metric definition is reproducible.', 'The guardrail protects against a named downside.', 'The population and time window are explicit.'],
      },
      dataLab: {
        title: 'Illustrative reminder pilot: choose the useful measures',
        context: 'Illustrative one-week practice data, not external evidence. Both cohorts contain 1,000 eligible appointments; the current process sends no reminders.',
        columns: ['Measure', 'Current process', 'Reminder pilot', 'Definition'],
        rows: [
          ['Eligible appointments', '1,000', '1,000', 'Appointments in the assigned cohort'],
          ['Reminders delivered', '0', '920', 'Successfully delivered messages'],
          ['Completed appointments', '500', '540', 'Completed appointments among eligible appointments'],
          ['Completion rate', '50.0%', '54.0%', 'Completed divided by eligible'],
          ['Opt-out complaints', 'Not applicable', '7.6 per 1,000', 'Complaints divided by delivered reminders'],
        ],
        prompts: [
          'Which row measures activity rather than the outcome of the decision?',
          'Which measure would you use as the outcome, and which as the guardrail?',
          'What event, eligibility, or time-window definitions would you confirm before using this table?',
        ],
        workedReading: 'Reminders delivered is an activity measure. Completion rate is the outcome because it keeps the eligible-population denominator visible: the illustrative pilot is 4 percentage points higher than the current process. Opt-out complaints per 1,000 delivered reminders is a plausible guardrail. This table helps define what to inspect, but it does not establish causality or show whether the observed gap is precise enough to act on.',
      },
      questions: [
        {
          prompt: 'A team is deciding whether to expand appointment reminders. Which metric pair best supports that decision?',
          options: ['Total reminders sent and total dashboard views', 'Completed appointments per eligible customer and opt-out complaints per 1,000 delivered reminders', 'Number of planning meetings and campaign launch date', 'Average message length and number of templates'],
          answerIndex: 1,
          explanation: 'The pair measures the intended outcome for the eligible population and a plausible downside of the action.',
        },
        {
          prompt: 'What makes a metric definition reproducible?',
          options: ['A memorable label and a rising chart', 'A target chosen after results arrive', 'An explicit event, denominator, population, window, exclusions, and owner', 'As many tracked events as possible'],
          answerIndex: 2,
          explanation: 'Those details prevent people from calculating materially different numbers under the same metric name.',
        },
        {
          prompt: 'Why is “messages sent” weak as the primary outcome for the reminder decision?',
          options: ['It measures activity rather than whether eligible customers completed appointments', 'It can never be counted accurately', 'Primary metrics must always be financial', 'Activity data is only useful after a randomized trial'],
          answerIndex: 0,
          explanation: 'Sending messages is the intervention activity; the decision needs evidence about the intended customer outcome.',
        },
      ],
    },
    baselines: {
      title: 'Build a baseline you can trust',
      summary: 'Choose a fair comparator and keep definitions stable so a change in the number can be interpreted.',
      estimatedMinutes: 14,
      focus: 'comparable baselines and denominators',
      overview: 'A number without a comparator cannot show improvement. This subchapter builds a baseline that matches the metric definition, population, and time window, then shows why changed denominators or instrumentation can create a false story.',
      blocks: [
        {
          heading: 'A baseline answers “compared with what?”',
          body: 'Suppose appointment completion is 54% after a reminder pilot. The number is not evidence of improvement by itself. A useful baseline might be the completion rate for comparable eligible customers under the current process, measured with the same event definition and over a representative window.',
          bullets: ['Use the same outcome definition.', 'Compare like populations.', 'Choose a window that represents normal conditions.'],
        },
        {
          heading: 'Keep the denominator visible',
          body: 'Counts can rise while performance falls. If completed appointments rise from 800 to 900 while eligible appointments rise from 1,000 to 1,500, the completion rate moves from 80% to 60%. The illustrative calculation changes the decision because it preserves the denominator.',
          bullets: ['Report counts and rates together.', 'Check eligibility changes.', 'Segment before averaging unlike groups.'],
        },
        {
          heading: 'Audit comparability before interpreting movement',
          body: 'A new tracking event, holiday period, pricing change, or customer mix can break the comparison. Write a short comparability note before discussing causes: what stayed constant, what changed, and which difference could plausibly explain the movement.',
          bullets: ['Instrumentation version', 'Population and channel mix', 'Seasonality or simultaneous policy changes'],
        },
      ],
      keyTakeaway: 'A trustworthy baseline uses the same definition, denominator, population, and representative window as the result you want to interpret.',
      reflectivePrompt: 'What changed between your current result and its baseline besides the action you are evaluating?',
      practice: {
        prompt: 'Audit one metric comparison from your work and write a baseline note that identifies the comparator, denominator, window, and comparability risks.',
        steps: ['Record the current value as a count and rate.', 'Name the comparison population and period.', 'List definition or instrumentation changes.', 'State whether the baseline is comparable enough for the decision.'],
        rubric: ['The denominator is visible.', 'The comparator matches the decision population.', 'The time window is justified.', 'Comparability risks are named rather than hidden.'],
      },
      dataLab: {
        title: 'Illustrative baseline check: when a higher count misleads',
        context: 'Illustrative practice data, not external evidence. The pilot week had a larger eligible population and launched with a new event-tracking version.',
        columns: ['Period', 'Eligible appointments', 'Completed', 'Completion rate', 'Tracking version'],
        rows: [
          ['Four-week normal baseline', '1,000 per week', '800 per week', '80.0%', 'v1'],
          ['Reminder pilot week', '1,500', '900', '60.0%', 'v2'],
        ],
        prompts: [
          'What story do the completed counts tell, and what different story do the rates tell?',
          'Is the four-week baseline directly comparable with the pilot week?',
          'Which checks would you complete before attributing movement to the reminder pilot?',
        ],
        workedReading: 'Completed appointments increased by 100, but the eligible population increased by 500. Once the denominator is retained, the illustrative completion rate falls from 80% to 60%. The tracking-version change is a separate comparability break, so the table is not yet sufficient to attribute the movement to reminders. Recalculate both periods under a stable event definition and inspect population mix and calendar effects before making the comparison.',
      },
      questions: [
        {
          prompt: 'A pilot reports 54% appointment completion. What is the best first question?',
          options: ['Can the chart use a more dramatic scale?', 'Did the team exceed its message-volume target?', 'What comparable baseline used the same definition, population, and window?', 'Which stakeholder likes the result most?'],
          answerIndex: 2,
          explanation: 'The baseline is needed before 54% can be interpreted as an improvement, decline, or ordinary level.',
        },
        {
          prompt: 'Completions rose from 800 to 900 while eligible appointments rose from 1,000 to 1,500. What should the team notice?',
          options: ['The count rose, so performance necessarily improved', 'The completion rate fell from 80% to 60%, so the denominator changes the story', 'The denominator is irrelevant once the count exceeds 850', 'The result proves the reminder caused harm'],
          answerIndex: 1,
          explanation: 'Counts and rates answer different questions; here the rate reveals worse completion among eligible appointments without proving a cause.',
        },
        {
          prompt: 'Tracking changed on the same day as a reported improvement. What should happen before interpreting the trend?',
          options: ['Check whether the old and new event definitions produce a comparable series', 'Ignore the change if the result supports the plan', 'Replace the baseline with the highest historical value', 'Attribute the full movement to the rollout'],
          answerIndex: 0,
          explanation: 'An instrumentation change can create apparent movement even when customer behavior did not change.',
        },
      ],
    },
    uncertainty: {
      title: 'Reason with uncertainty, not point estimates',
      summary: 'Treat observed differences as estimates, define what would matter in practice, and choose a proportionate next move.',
      estimatedMinutes: 17,
      focus: 'uncertainty and decision thresholds',
      overview: 'Observed results vary because samples, timing, and measurement are imperfect. This subchapter separates a point estimate from the uncertainty around it, asks what difference would matter in practice, and matches the next action to the cost of being wrong.',
      blocks: [
        {
          heading: 'An estimate is not the underlying truth',
          body: 'If a pilot shows 54% completion and a comparison shows 50%, the four-point gap is an estimate. Without sample size, variation, and study design, “the pilot worked” is too certain. The honest reading is that the observed result is promising or unpromising to a stated degree, not that uncertainty disappeared.',
          bullets: ['Report the estimate, not only the direction.', 'Show a range or sensitivity analysis when available.', 'Name uncertainty the data cannot quantify.'],
        },
        {
          heading: 'Define practical importance before seeing the result',
          body: 'A tiny, precisely estimated change can still be too small to justify implementation. Before analyzing the pilot, state the smallest effect that would change the decision and the downside you are willing to accept. This reduces the temptation to move the threshold after seeing a convenient number.',
          bullets: ['Minimum useful improvement', 'Maximum acceptable guardrail change', 'Decision deadline and cost of delay'],
        },
        {
          heading: 'Match commitment to confidence',
          body: 'Weak evidence does not always mean “do nothing.” For a cheap, reversible action, run a bounded rollout with a review trigger. For an expensive or irreversible action, gather stronger evidence or reduce the scope. Uncertainty should shape the size of the bet.',
          bullets: ['Reversible: test with a cap and stop condition.', 'Costly: seek stronger evidence.', 'Urgent: document the risk accepted by acting now.'],
        },
      ],
      keyTakeaway: 'Treat results as uncertain estimates, define the smallest practically useful change in advance, and scale the commitment to the cost of being wrong.',
      reflectivePrompt: 'For your next decision, what result would be large enough to matter and what uncertainty would make you reduce the bet?',
      practice: {
        prompt: 'Write a decision threshold for one pending test, including the minimum useful effect, guardrail limit, uncertainty you can tolerate, and action for an inconclusive result.',
        steps: ['Name the point estimate you expect to observe.', 'Set the minimum useful change before reviewing results.', 'Choose an acceptable guardrail limit.', 'Define a smaller reversible action if evidence is inconclusive.'],
        rubric: ['Practical importance is explicit.', 'Uncertainty is not reduced to a yes/no label.', 'The action matches the cost of error.', 'An inconclusive result has a planned response.'],
      },
      dataLab: {
        title: 'Illustrative pilot estimate: read beyond the point estimate',
        context: 'Illustrative practice calculation, not external evidence. The range is an approximate 95% interval for two independent groups; the minimum useful improvement was set at 5 percentage points before analysis.',
        columns: ['Evidence', 'Value', 'Decision note'],
        rows: [
          ['Current process', '500 / 1,000 (50.0%)', 'Comparison group'],
          ['Reminder pilot', '540 / 1,000 (54.0%)', 'Pilot group'],
          ['Observed difference', '+4.0 percentage points', 'Point estimate'],
          ['Approximate 95% interval', '−0.4 to +8.4 percentage points', 'Plausible range under the illustrative calculation'],
          ['Minimum useful improvement', '+5.0 percentage points', 'Pre-set decision threshold'],
        ],
        prompts: [
          'What does the +4-point estimate say, and what does it leave uncertain?',
          'Does the range exclude no improvement?',
          'Does the evidence clearly establish an improvement large enough to matter?',
          'What next move would be proportionate if a full rollout is costly but a bounded test is reversible?',
        ],
        workedReading: 'The point estimate favors the pilot by 4 percentage points, but the illustrative interval includes no improvement and effects larger than the 5-point practical threshold. The data therefore do not clearly establish either no benefit or a benefit large enough to justify a costly commitment. A bounded follow-up test with a pre-set review trigger may be proportionate if it is cheap and reversible; an irreversible rollout would call for stronger evidence.',
      },
      questions: [
        {
          prompt: 'A pilot shows 54% completion versus 50%, but sample size and variation are not reported. Which conclusion is justified?',
          options: ['The rollout definitely caused a four-point gain', 'The observed gap may be promising, but its uncertainty and design must be examined before a strong claim', 'The result is useless under every decision context', 'Any positive point estimate is enough for full rollout'],
          answerIndex: 1,
          explanation: 'The point estimate alone does not show how stable the gap is or whether the action caused it.',
        },
        {
          prompt: 'When should a team define the smallest improvement worth acting on?',
          options: ['After seeing which threshold the pilot clears', 'Only when the result is negative', 'Before analyzing the result, tied to costs and decision consequences', 'After the full rollout removes uncertainty'],
          answerIndex: 2,
          explanation: 'Defining practical importance in advance makes the decision rule less vulnerable to a convenient result.',
        },
        {
          prompt: 'Evidence is weak, but the proposed action is cheap and reversible. What is a proportionate response?',
          options: ['Run a bounded rollout with a review trigger and stop condition', 'Treat uncertainty as proof the action works', 'Commit irreversibly before more data arrives', 'Hide the uncertainty from the decision record'],
          answerIndex: 0,
          explanation: 'A small reversible bet can create information while limiting downside; the commitment should match confidence.',
        },
      ],
    },
    bias: {
      title: 'Find bias before it steers the decision',
      summary: 'Inspect who entered the data, who is missing, and how measurement choices could systematically distort the result.',
      estimatedMinutes: 16,
      focus: 'selection, missingness, and measurement bias',
      overview: 'More rows do not repair systematically distorted data. This subchapter audits who was selected, who or what is missing, and how the measurement process could push an estimate in one direction before a team acts on it.',
      blocks: [
        {
          heading: 'Ask who had a chance to appear',
          body: 'If reminder users opted into a pilot, they may already be more engaged than customers who did not opt in. Their higher completion rate could reflect selection rather than the reminder. Compare the decision population with the observed sample instead of assuming they are interchangeable.',
          bullets: ['Who was eligible?', 'Who entered the sample?', 'Which trait affects both selection and outcome?'],
        },
        {
          heading: 'Treat missingness as evidence',
          body: 'Missing delivery logs concentrated on older devices are not a random inconvenience. If those customers also complete appointments differently, dropping the rows can distort the estimate. Report missingness by relevant segment and test how plausible assumptions change the result.',
          bullets: ['Measure missingness by segment.', 'Do not silently discard failed records.', 'Use sensitivity checks when recovery is impossible.'],
        },
        {
          heading: 'Audit the data-generating process',
          body: 'Trace the path from real behavior to the dashboard: eligibility rule, assignment, event capture, transformation, and exclusion. At each step ask what could be recorded differently for one group. This turns “the data says” into an inspectable chain of choices.',
          bullets: ['Selection and assignment', 'Instrumentation and labels', 'Cleaning rules and exclusions'],
        },
      ],
      keyTakeaway: 'Bias is systematic distortion, so inspect selection, missingness, instrumentation, and exclusions—not only sample size—before applying evidence to a wider population.',
      reflectivePrompt: 'Which people or events are least likely to appear in the data behind one decision you currently trust?',
      practice: {
        prompt: 'Create a bias audit for one dataset by mapping eligibility, selection, missing records, measurement, and exclusions to the decision population.',
        steps: ['Name the population the decision affects.', 'Describe how rows enter the dataset.', 'Break down missingness across a relevant segment.', 'List one distortion and a mitigation or sensitivity check.'],
        rubric: ['Sample and decision population are distinguished.', 'Missingness is inspected rather than ignored.', 'A plausible direction of distortion is stated.', 'The mitigation is proportionate and testable.'],
      },
      dataLab: {
        title: 'Illustrative delivery-log audit: find patterned missingness',
        context: 'Illustrative practice data, not external evidence. Completion is shown only for appointments with a usable delivery log.',
        columns: ['Device segment', 'Eligible appointments', 'Usable delivery logs', 'Log coverage', 'Recorded completion rate'],
        rows: [
          ['Newer devices', '800', '760', '95.0%', '56.0%'],
          ['Older devices', '400', '240', '60.0%', '45.0%'],
        ],
        prompts: [
          'Which segment is least represented in a complete-log analysis?',
          'How could dropping missing logs change the overall completion estimate?',
          'What breakdown or sensitivity check would you request before rollout?',
        ],
        workedReading: 'Older-device appointments make up one third of the eligible population but have much lower log coverage. A complete-log analysis would therefore overrepresent newer devices, whose recorded completion rate is higher in this illustrative table. That pattern could inflate the aggregate estimate, although the missing outcomes prevent a precise correction. Report coverage by segment and test conclusions under plausible completion rates for the missing older-device records.',
      },
      questions: [
        {
          prompt: 'Customers opted into a reminder pilot and show higher appointment completion. What is the clearest immediate concern?',
          options: ['Selection bias: volunteers may already be more engaged than the rollout population', 'Every opt-in study has zero useful information', 'The sample is biased only if it is small', 'Completion cannot be measured for volunteers'],
          answerIndex: 0,
          explanation: 'Opt-in status may be related to engagement and completion, so the observed group may not represent everyone affected by rollout.',
        },
        {
          prompt: 'Delivery logs are disproportionately missing on older devices. Why is dropping all missing rows risky?',
          options: ['It always makes the sample too large', 'It proves older devices caused lower completion', 'Missingness may be related to both device segment and outcome, systematically changing the estimate', 'A complete-case analysis never uses metrics'],
          answerIndex: 2,
          explanation: 'When missingness is patterned, retained records can tell a different story from the population the decision affects.',
        },
        {
          prompt: 'Which audit best examines how measurement bias could enter?',
          options: ['Count dashboard colors and chart types', 'Trace eligibility, assignment, event capture, transformations, and exclusions', 'Choose the largest available table', 'Remove every outlier before defining the metric'],
          answerIndex: 1,
          explanation: 'The trace exposes points where behavior can be recorded or excluded differently across groups.',
        },
      ],
    },
    causality: {
      title: 'Separate correlation from causation',
      summary: 'Use a causal question, plausible alternatives, and an appropriate comparison design before predicting what an intervention will change.',
      estimatedMinutes: 18,
      focus: 'causal reasoning and fair comparisons',
      overview: 'Correlation describes how variables move together; a decision asks what would happen if an action changed. This subchapter identifies confounders, writes the missing counterfactual, and chooses a comparison design that can support the strength of claim required.',
      blocks: [
        {
          heading: 'Prediction and intervention are different questions',
          body: 'Customers who enable reminders may complete more appointments. That association can help predict completion, but it does not show that enabling reminders will increase completion. Existing engagement could cause both reminder adoption and attendance.',
          bullets: ['Association: who tends to have the outcome?', 'Causal effect: what changes because we intervene?', 'Decision: which question does the action require?'],
        },
        {
          heading: 'Write the counterfactual and confounders',
          body: 'For each pilot customer, the missing quantity is what that same customer would have done without the reminder at the same time. Because both outcomes cannot be observed together, use a comparison group and list variables—such as prior attendance or engagement—that may influence both exposure and outcome.',
          bullets: ['Treatment or action', 'Outcome and timing', 'Common causes of treatment and outcome'],
        },
        {
          heading: 'Match the design to the claim',
          body: 'Random assignment can create a fair comparison when it is feasible and ethical. When it is not, use the strongest credible alternative: matched comparisons, phased rollout, discontinuities, or careful before-and-after analysis with explicit limitations. The wording of the conclusion must not outrun the design.',
          bullets: ['Prefer planned comparisons.', 'Check whether groups differed before treatment.', 'State which alternative explanations remain.'],
        },
      ],
      keyTakeaway: 'An association supports a causal decision only when the comparison makes the no-action counterfactual credible and alternative explanations are addressed.',
      reflectivePrompt: 'What variable could plausibly cause both the action and outcome in a correlation your team currently discusses?',
      practice: {
        prompt: 'Turn one observed correlation into a causal decision note with an intervention, outcome, counterfactual, likely confounders, and feasible comparison design.',
        steps: ['Write the intervention and outcome with timing.', 'State the missing no-action counterfactual.', 'List two plausible common causes.', 'Choose a comparison design and limit the claim to what it supports.'],
        rubric: ['Prediction and intervention are separated.', 'The counterfactual is explicit.', 'Plausible confounders are named.', 'The conclusion matches the design strength.'],
      },
      dataLab: {
        title: 'Illustrative opt-in comparison: association is not an effect',
        context: 'Illustrative practice data, not external evidence. Customers chose whether to enable reminders; they were not randomly assigned.',
        columns: ['Group', 'Customers', 'Prior completion rate', 'Current completion rate', 'Reminder status'],
        rows: [
          ['Opted in', '600', '68.0%', '75.0%', 'Enabled'],
          ['Did not opt in', '600', '45.0%', '50.0%', 'Not enabled'],
        ],
        prompts: [
          'What is the raw current-period association between reminder status and completion?',
          'What pre-existing difference weakens a causal interpretation?',
          'Which design would create a more credible no-reminder counterfactual?',
        ],
        workedReading: 'The current-period rates differ by 25 percentage points, but the groups already differed by 23 points before the reminder period. Opt-in customers may be more engaged, so the raw association cannot be read as the reminder effect. Even the change over time—7 points for opt-ins versus 5 for non-opt-ins—can reflect different trends or concurrent changes. Random assignment, or the strongest feasible planned comparison with pre-treatment checks, would support a more credible causal claim.',
      },
      questions: [
        {
          prompt: 'Customers who enable reminders complete more appointments. What can this observation establish by itself?',
          options: ['Reminders caused the entire difference', 'An association that may predict completion, not yet the effect of enabling reminders', 'No relationship of any kind exists', 'A full rollout will reproduce the same gap'],
          answerIndex: 1,
          explanation: 'Self-selection or other common causes can explain the association, so an intervention claim needs a credible comparison.',
        },
        {
          prompt: 'Why can random assignment strengthen a causal comparison when feasible?',
          options: ['It guarantees every measurement is accurate', 'It makes the treatment effect identical for every person', 'It tends to balance pre-existing causes across groups before the action', 'It removes the need to define an outcome'],
          answerIndex: 2,
          explanation: 'Balancing pre-existing differences makes the no-action group a more credible counterfactual for the treated group.',
        },
        {
          prompt: 'Prior customer engagement affects both reminder adoption and appointment completion. What role does engagement play?',
          options: ['A plausible confounder that can create a misleading treatment-outcome association', 'A guardrail metric', 'A randomized assignment mechanism', 'Proof that reminders have no effect'],
          answerIndex: 0,
          explanation: 'A common cause of exposure and outcome can make an association differ from the causal effect of the action.',
        },
      ],
    },
    constraints: {
      title: 'Choose under real constraints',
      summary: 'Compare feasible actions across expected value, downside, cost, confidence, and reversibility, then set a review trigger.',
      estimatedMinutes: 17,
      focus: 'tradeoffs, reversibility, and review triggers',
      overview: 'The largest estimated metric lift is not automatically the best decision. This subchapter combines evidence with budget, time, risk, fairness, and reversibility, then records a choice and the conditions that would cause the team to continue, stop, or revise it.',
      blocks: [
        {
          heading: 'Separate hard constraints from preferences',
          body: 'A legal requirement, fixed launch date, or budget ceiling removes options; a preferred channel or familiar tool does not. Marking the difference prevents teams from presenting habits as unavoidable facts and keeps the feasible set honest.',
          bullets: ['Hard boundary: cannot be violated.', 'Soft preference: carries a tradeoff.', 'Assumption: needs an owner and check.'],
        },
        {
          heading: 'Compare options with a decision table',
          body: 'For each feasible option, record expected outcome, guardrail risk, cost, confidence, time to learn, and reversibility. Do not collapse the table into a decorative total score. The purpose is to expose why a phased rollout might dominate a larger launch when evidence is uncertain and downside is costly.',
          bullets: ['Expected benefit and downside', 'Cost and time to learn', 'Confidence and reversibility'],
        },
        {
          heading: 'Commit with a review trigger',
          body: 'A decision record should state the chosen action, owner, assumptions, stop condition, and review date. Example: expand reminders to one additional segment for two weeks; stop if the complaint guardrail crosses the agreed limit; review completion and delivery quality before further expansion. The figures and thresholds must come from the real context.',
          bullets: ['Choose and assign an owner.', 'Set continue, stop, or revise conditions.', 'Schedule the next decision, not just the next report.'],
        },
      ],
      keyTakeaway: 'A defensible data-informed decision selects among feasible options, makes tradeoffs and uncertainty visible, and includes a trigger for revisiting the choice.',
      reflectivePrompt: 'Which “constraint” in a current decision is truly fixed, and which one is a preference that could be traded?',
      practice: {
        prompt: 'Build a decision table for three actions, then write a decision record with owner, assumptions, guardrail, and review trigger.',
        steps: ['Separate hard constraints, preferences, and assumptions.', 'Compare three feasible options across benefit, downside, cost, confidence, and reversibility.', 'Choose one action and explain the tradeoff.', 'Set a stop condition and next review date.'],
        rubric: ['Only feasible options are compared.', 'Tradeoffs are visible without a fake precision score.', 'Uncertainty affects commitment size.', 'The record includes an owner and review trigger.'],
      },
      dataLab: {
        title: 'Illustrative decision table: size the commitment',
        context: 'Illustrative practice estimates, not external evidence. Cost symbols compare options only within this scenario; ranges summarize current uncertainty rather than guaranteed outcomes.',
        columns: ['Option', 'Estimated completion', 'Complaint risk', 'Relative cost', 'Confidence', 'Reversibility'],
        rows: [
          ['Keep current process', 'About 50%', 'Low', '$', 'High', 'High'],
          ['Two-week bounded rollout', '52–55%', 'Low to moderate', '$$', 'Medium', 'High'],
          ['Immediate full rollout', '54–58%', 'Moderate to high', '$$$$', 'Low', 'Low'],
        ],
        prompts: [
          'Which option has the largest estimated upside, and what does that row hide if read alone?',
          'Which option creates useful learning while limiting credible downside?',
          'What stop condition and review trigger would make the bounded rollout actionable?',
        ],
        workedReading: 'The full rollout has the highest estimated range, but it also has the weakest confidence, greatest complaint risk, highest cost, and lowest reversibility. The bounded rollout is the proportionate choice when learning has value and delay is acceptable: it preserves upside while limiting the initial bet. A complete decision record still needs a complaint threshold, an owner, a two-week review date, and explicit criteria for expanding, revising, or stopping.',
      },
      questions: [
        {
          prompt: 'A full rollout has the largest estimated lift but high downside, low confidence, and is difficult to reverse. A phased rollout is feasible. What is the strongest decision?',
          options: ['Always choose the highest point estimate', 'Ignore downside because it is a guardrail', 'Prefer the phased rollout when its smaller commitment creates learning while limiting credible harm', 'Wait until every uncertainty disappears'],
          answerIndex: 2,
          explanation: 'The decision should combine expected benefit with downside, confidence, and reversibility rather than maximize one estimate.',
        },
        {
          prompt: 'Which item is most likely a hard constraint rather than a preference?',
          options: ['A binding legal requirement for customer consent', 'The team usually uses email', 'A manager prefers blue charts', 'The analyst knows one dashboard tool best'],
          answerIndex: 0,
          explanation: 'A binding legal requirement limits the feasible set; familiar tools and channels remain choices with tradeoffs.',
        },
        {
          prompt: 'What makes a review trigger useful?',
          options: ['It promises the original decision will never change', 'It defines evidence, guardrail conditions, and timing that cause the team to continue, stop, or revise', 'It replaces the need for an owner', 'It reports every available metric without a decision'],
          answerIndex: 1,
          explanation: 'A trigger connects incoming evidence to a future action and makes revision an explicit part of the decision.',
        },
      ],
    },
  },
};

function isDecisionDataTopic(topic: string) {
  const normalized = topic.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized === 'decision making with data'
    || normalized === 'data informed decision making'
    || normalized === 'data driven decision making';
}

function decisionDataRoadmap(topic: string): Roadmap {
  const key = slug(topic);
  return {
    title: decisionDataCurriculum.title,
    description: decisionDataCurriculum.description,
    topic,
    language: 'en',
    outcomes: decisionDataCurriculum.outcomes,
    sections: decisionDataCurriculum.sections.map((section, sectionPosition) => ({
      id: `${key}-${section.id}`,
      title: section.title,
      summary: section.summary,
      position: sectionPosition,
      lessons: section.concepts.map((concept, lessonPosition) => {
        const lesson = decisionDataCurriculum.lessons[concept];
        return {
          id: `${key}-${concept}`,
          title: lesson.title,
          summary: lesson.summary,
          estimatedMinutes: lesson.estimatedMinutes,
          position: lessonPosition,
        };
      }),
    })),
  };
}

function decisionDataConceptFromLesson(input: Pick<LessonGenerationInput, 'lessonTitle' | 'lessonSummary' | 'sectionTitle'>): DecisionDataConcept {
  const lesson = `${input.lessonTitle} ${input.lessonSummary}`.toLowerCase();
  if (/baseline|comparator|denominator|building blocks/.test(lesson)) return 'baselines';
  if (/uncertaint|point estimate|sample noise|first .*workflow/.test(lesson)) return 'uncertainty';
  if (/bias|missingness|data quality|feedback|iteration/.test(lesson)) return 'bias';
  if (/correlation|caus|counterfactual|realistic .*scenario/.test(lesson)) return 'causality';
  if (/constraint|trade.?off|reversib|next deliberate step|decision table/.test(lesson)) return 'constraints';
  if (/metric|measure|outcome|guardrail|mental model/.test(lesson)) return 'metrics';

  const section = input.sectionTitle.toLowerCase();
  if (/practice|uncertainty|bias/.test(section)) return 'uncertainty';
  if (/integration|caus|constraint/.test(section)) return 'causality';
  return 'metrics';
}

function fallbackLessonNodes(input: LessonGenerationInput, blocks: LessonMaterial['blocks']): LessonNode[] {
  const prose = blocks.slice(0, 2).map((block) => ({ type: 'prose' as const, heading: block.heading, body: block.body, bullets: block.bullets }));
  const text = `${input.lessonTitle} ${input.lessonSummary}`.toLowerCase();
  if (/scenario|decision|trade.?off/.test(text)) {
    return [
      prose[0],
      {
        type: 'scenario',
        heading: 'Pause at the decision point',
        situation: `Imagine you must apply ${input.lessonTitle.toLowerCase()} to a real situation with incomplete information and a limited window to act.`,
        choices: ['Choose the smallest reversible next step.', 'Wait until every uncertainty is removed.'],
        prompt: 'Which choice protects learning while keeping the downside visible?',
        reasoning: 'A small reversible step creates evidence without pretending that uncertainty can be eliminated first.',
      },
      prose[1] ?? prose[0],
    ];
  }
  if (/metric|baseline|compare|difference|bias|uncertainty/.test(text)) {
    return [
      prose[0],
      {
        type: 'comparison',
        heading: 'Keep the contrast visible',
        leftLabel: 'Weak reading',
        rightLabel: 'Useful reading',
        rows: [
          { criterion: 'Question', left: 'What number changed?', right: 'What decision could change?' },
          { criterion: 'Evidence', left: 'One isolated result', right: 'A comparable signal with context' },
        ],
      },
      prose[1] ?? prose[0],
    ];
  }
  if (/workflow|process|practice|feedback|iteration/.test(text)) {
    return [
      prose[0],
      {
        type: 'flow',
        heading: 'Use a compact working loop',
        sequence: [
          { label: 'Frame', description: 'Name the problem, decision, and constraint.' },
          { label: 'Try', description: 'Run the smallest useful version of the approach.' },
          { label: 'Inspect', description: 'Review the signal and revise the highest-leverage assumption.' },
        ],
        outcome: 'The next action is visible, and the next revision has a reason.',
      },
      prose[1] ?? prose[0],
    ];
  }
  return [
    prose[0],
    {
      type: 'example',
      heading: 'See the idea in a small case',
      context: `Start with one realistic ${input.topic} situation instead of trying to solve the whole subject at once.`,
      steps: ['Name the current context.', 'Make one deliberate move.', 'Inspect what changed and what remains unclear.'],
      insight: 'A small case makes the underlying idea testable and gives the learner something concrete to adapt.',
    },
    prose[1] ?? prose[0],
  ];
}

function fallbackLessonArticle(input: LessonGenerationInput, blocks: LessonMaterial['blocks']): LessonArticle {
  return {
    sections: blocks.slice(0, 5).map((block) => {
      const openingBody = block.body.split(/\s+/).filter(Boolean).length < 45
        ? `${block.body} That distinction gives you a concrete question to carry into the next conversation instead of another label to memorize.`
        : block.body;
      const paragraphs = [
        openingBody,
        block.bullets.length > 0 ? `Keep these questions in view: ${block.bullets.join(' ')}` : 'Pause here and connect the idea to one situation in your own context.',
      ];
      return {
        heading: block.heading,
        paragraphs,
        content: paragraphs.map((text) => ({ type: 'paragraph' as const, text })),
      };
    }),
  };
}

function indonesianLesson(input: LessonGenerationInput): LessonMaterial {
  const blocks = [
    {
      heading: 'Mulai dari pertanyaan yang tepat',
      body: `${input.lessonSummary} Cara paling berguna untuk memahami ${input.lessonTitle.toLowerCase()} bukan dengan menghafal istilah, melainkan dengan melihat keputusan apa yang dibantu oleh konsep ini. Mulailah dari situasi nyata, batasan yang terlihat, dan hasil yang ingin kamu periksa.`,
      bullets: ['Sebutkan masalah sebelum memilih metode.', 'Pisahkan fakta, asumsi, dan hal yang belum diketahui.', 'Tentukan sinyal yang akan kamu amati.'],
    },
    {
      heading: 'Jadikan gagasannya terlihat',
      body: `Ketika sebuah ide terasa abstrak, ubah ia menjadi langkah kecil yang bisa diamati. Dalam konteks ${input.topic}, kamu dapat mencoba satu perubahan, mencatat apa yang terjadi, lalu membandingkannya dengan tujuan awal. Dengan begitu, pemahaman tidak berhenti sebagai definisi, tetapi menjadi cara membaca situasi.`,
      bullets: ['Pilih satu contoh yang cukup kecil untuk dicoba.', 'Tulis batasan yang dapat mengubah keputusan.', 'Periksa hasil sebelum menambah kompleksitas.'],
    },
    {
      heading: 'Bawa ke situasi nyata',
      body: `Gunakan subbab ini sebagai lensa untuk satu pekerjaan atau keputusan yang sedang kamu hadapi. Tidak perlu membuat rencana besar. Pilih langkah berikutnya yang paling kecil, jelaskan mengapa langkah itu masuk akal, dan tentukan bukti apa yang akan membuatmu mempertahankan atau mengubah pendekatan.`,
      bullets: ['Apa tindakan berikutnya yang dapat diamati?', 'Kendala mana yang paling penting?', 'Apa yang akan membuatmu merevisi pendekatan?'],
    },
  ];
  return {
    lessonId: input.lessonId,
    title: input.lessonTitle,
    overview: `Subbab ini membantu kamu memahami ${input.lessonTitle.toLowerCase()} dalam konteks ${input.topic}. Kamu akan melihat cara mengubah gagasan tersebut menjadi langkah yang dapat diuji, bukan sekadar ringkasan untuk diingat.`,
    article: fallbackLessonArticle(input, blocks),
    nodes: [],
    blocks,
    keyTakeaway: `Pemahaman yang berguna tentang ${input.topic} terlihat dari cara kamu membingkai masalah, mengambil langkah kecil, membaca sinyal, dan memperbaiki langkah berikutnya.`,
    reflectivePrompt: 'Di situasi mana kamu dapat memakai lensa ini dalam tujuh hari ke depan, dan bukti apa yang akan menunjukkan bahwa pendekatanmu membantu?',
    sourceNote: 'Materi ini dibuat untuk kursus dan subbab yang sedang dibuka. Contoh bersifat ilustratif; sesuaikan dengan konteksmu sendiri.',
    sources: [],
  };
}

function decisionDataLesson(input: LessonGenerationInput): LessonMaterial {
  const concept = decisionDataConceptFromLesson(input);
  const definition = decisionDataCurriculum.lessons[concept];
  const continuity = input.courseMemory.length
    ? `It assumes the earlier generated course material and adds ${definition.focus} instead of repeating prior takeaways.`
    : 'It establishes the first decision tool in this course without assuming statistical training.';
  return {
    lessonId: input.lessonId,
    title: input.lessonTitle,
    overview: `${definition.overview} ${continuity}`,
    article: fallbackLessonArticle(input, definition.blocks),
    nodes: fallbackLessonNodes(input, definition.blocks),
    blocks: definition.blocks,
    keyTakeaway: definition.keyTakeaway,
    reflectivePrompt: definition.reflectivePrompt,
    sourceNote: 'This is original course material. All scenarios and numbers are illustrative, not external evidence; use definitions, thresholds, and constraints from your own context.',
    sources: [],
    practice: definition.practice,
    dataLab: definition.dataLab,
  };
}

function indonesianFallbackRoadmap(topic: string): Roadmap {
  const key = slug(topic);
  return {
    title: `${topic}: jalur belajar praktis`,
    description: `Jalur terarah dari fondasi hingga penerapan ${topic}. Materi tiap subbab dibuat saat kamu membukanya agar tetap relevan dengan ritme belajar dan kebutuhanmu.`,
    topic,
    language: 'id',
    outcomes: [
      `Menjelaskan gagasan inti ${topic} dengan bahasa sederhana`,
      `Menerapkan ${topic} pada masalah nyata dengan proses yang dapat diulang`,
      `Menilai batasan dan menentukan kapan pendekatan ini tepat digunakan`,
      `Membuat artefak kecil yang menunjukkan pemahaman yang bisa dipakai`,
    ],
    sections: [
      {
        id: `${key}-fondasi`,
        title: 'Fondasi',
        summary: 'Bangun model mental dan kosakata yang diperlukan sebelum berlatih.',
        position: 0,
        lessons: [
          { id: `${key}-model-mental`, title: `Model mental ${topic}`, summary: 'Beberapa konsep utama yang membuat bagian lain lebih mudah dipahami.', estimatedMinutes: 12, position: 0 },
          { id: `${key}-blok-dasar`, title: 'Blok dasar', summary: 'Cara bagian-bagian penting saling terhubung dan kesalahan yang sering terjadi.', estimatedMinutes: 14, position: 1 },
        ],
      },
      {
        id: `${key}-praktik`,
        title: 'Praktik',
        summary: 'Pindahkan pemahaman ke penerapan kecil yang dapat diamati.',
        position: 1,
        lessons: [
          { id: `${key}-alur-pertama`, title: `Alur pertama untuk ${topic}`, summary: 'Proses konkret yang dapat kamu ulangi pada masalahmu sendiri.', estimatedMinutes: 18, position: 0 },
          { id: `${key}-umpan-balik`, title: 'Umpan balik dan iterasi', summary: 'Cara membaca hasil, memilih perubahan bernilai tinggi, lalu mencoba lagi.', estimatedMinutes: 16, position: 1 },
        ],
      },
      {
        id: `${key}-integrasi`,
        title: 'Integrasi',
        summary: 'Gunakan keterampilan dalam konteks nyata dan ambil keputusan dengan batasan yang jelas.',
        position: 2,
        lessons: [
          { id: `${key}-skenario-nyata`, title: `Skenario nyata untuk ${topic}`, summary: 'Contoh dengan ambiguitas, batasan, dan keputusan yang perlu dibuat.', estimatedMinutes: 20, position: 0 },
          { id: `${key}-langkah-berikutnya`, title: 'Langkah berikutnya', summary: 'Ubah gagasan menjadi rencana latihan pribadi yang realistis.', estimatedMinutes: 10, position: 1 },
        ],
      },
    ],
  };
}

function fallbackRoadmap(topic: string, language: CourseLanguage = 'en'): Roadmap {
  if (language === 'id') return indonesianFallbackRoadmap(topic);
  if (isDecisionDataTopic(topic)) {
    return decisionDataRoadmap(topic);
  }
  const key = slug(topic);
  return {
    title: `${topic}: a practical learning path`,
    description: `A focused path from first principles to confident application of ${topic}. Each subchapter is generated when you open it so the course stays relevant to your pace.`,
    topic,
    language: 'en',
    outcomes: [
      `Explain the core ideas behind ${topic} in plain language`,
      `Apply ${topic} to a realistic problem with a repeatable process`,
      `Evaluate tradeoffs and decide when to use the approach`,
      `Build a small artifact that demonstrates working knowledge`,
    ],
    sections: [
      {
        id: `${key}-foundations`,
        title: 'Foundations',
        summary: 'Build the mental model and vocabulary you need before practicing.',
        position: 0,
        lessons: [
          { id: `${key}-mental-model`, title: `The mental model for ${topic}`, summary: 'The few concepts that make the rest of the subject click.', estimatedMinutes: 12, position: 0 },
          { id: `${key}-building-blocks`, title: 'The building blocks', summary: 'How the parts fit together and where beginners tend to go wrong.', estimatedMinutes: 14, position: 1 },
        ],
      },
      {
        id: `${key}-practice`,
        title: 'Practice',
        summary: 'Move from understanding to a small, guided application.',
        position: 1,
        lessons: [
          { id: `${key}-first-workflow`, title: `A first ${topic} workflow`, summary: 'A concrete process you can repeat on your own problem.', estimatedMinutes: 18, position: 0 },
          { id: `${key}-feedback-loop`, title: 'Feedback and iteration', summary: 'How to inspect the result, find the highest-value change, and iterate.', estimatedMinutes: 16, position: 1 },
        ],
      },
      {
        id: `${key}-integration`,
        title: 'Integration',
        summary: 'Use the skill in context and make sound decisions under constraints.',
        position: 2,
        lessons: [
          { id: `${key}-real-scenario`, title: `A realistic ${topic} scenario`, summary: 'A worked example with ambiguity, constraints, and a decision to make.', estimatedMinutes: 20, position: 0 },
          { id: `${key}-next-step`, title: 'Your next deliberate step', summary: 'Turn the ideas into a personal practice plan.', estimatedMinutes: 10, position: 1 },
        ],
      },
    ],
  };
}

function productBriefLesson(input: LessonGenerationInput) {
  const lesson = input.lessonTitle.toLowerCase();
  const isReview = /feedback|iteration/i.test(lesson);
  const isWorkflow = /workflow|scenario|next step/i.test(lesson);
  const overview = isReview
    ? 'A useful brief is a decision that can improve. This subchapter gives you a review loop for finding the weakest assumption and revising the brief without polishing everything at once.'
    : isWorkflow
      ? 'A brief becomes useful when it turns an ambiguous request into a decision, a test, and a shared definition of success. This subchapter walks through one realistic product example.'
      : 'A product brief is a decision aid, not a document dump. This subchapter shows how to turn a vague request into a specific problem, an explicit decision, and a small test.';
  const blocks = isReview
    ? [
        {
          heading: 'Find the weakest field',
          body: 'Read the brief once as a teammate who has to act on it. Circle the first place where you would ask “what does this mean?” Usually the highest-value revision is the decision, user problem, or success signal—not another paragraph of context.',
          bullets: ['Can a teammate name the decision in one sentence?', 'Is the user problem observable rather than aspirational?', 'Does the success signal tell you what to inspect?'],
        },
        {
          heading: 'Revise from evidence',
          body: 'Suppose the first draft says, “Improve activation.” A better revision names the observed friction and the next test: “New project leads abandon during setup; test a three-field starter brief and measure first saved brief within one session.” The second sentence gives the team something to learn.',
          bullets: ['Keep the original evidence visible.', 'Change one high-leverage assumption.', 'State what would change your mind.'],
        },
        {
          heading: 'Leave a trace of the decision',
          body: 'Record what the team chose not to solve yet. A non-goal such as “not redesigning the full editor this cycle” protects the brief from becoming a wish list and makes later feedback more honest.',
          bullets: ['Name the next decision date.', 'Keep non-goals explicit.', 'Invite one targeted disagreement.'],
        },
      ]
    : [
        {
          heading: 'Start with the decision',
          body: 'Weak: “Make onboarding better.” Strong: “Help first-time project leads create their first saved brief in one session; test a three-field starting template.” The strong version identifies a decision, a user, and a signal without pretending the solution is already known.',
          bullets: ['Decision: what will the team choose?', 'User: who is experiencing the problem?', 'Signal: what observable behavior should change?'],
        },
        {
          heading: 'Use six fields, not six pages',
          body: 'A practical brief can fit on one screen: decision, problem, evidence, proposed test, non-goals, and success signal. Keep context only when it changes the decision. This gives collaborators a useful object to challenge instead of a document to admire.',
          bullets: ['Decision: what are we deciding now?', 'Evidence: what have we observed?', 'Test: what is the smallest useful move?'],
        },
        {
          heading: isWorkflow ? 'Make the next conversation easier' : 'Show the contrast',
          body: 'Read the brief aloud as if you joined the team today. If a collaborator cannot tell what to do next, the brief is still describing intent rather than enabling a decision. Ask for one concrete objection and revise the weakest sentence first.',
          bullets: ['Invite a specific objection.', 'Separate facts from assumptions.', 'End with a next action and owner.'],
        },
      ];
  return {
    lessonId: input.lessonId,
    title: input.lessonTitle,
    overview,
    article: fallbackLessonArticle(input, blocks),
    nodes: fallbackLessonNodes(input, blocks),
    blocks,
    keyTakeaway: 'A strong product brief makes one decision easier: it names the user problem, shows the evidence, proposes a small test, and makes success observable.',
    reflectivePrompt: 'Write the six fields for a real decision you are facing: decision, problem, evidence, test, non-goal, and success signal.',
    sourceNote: 'This worked example is original course material. Any numbers in the example are illustrative; replace them with evidence from your own product context.',
    sources: [],
    practice: {
      prompt: 'Turn one vague request from your current work into a six-field brief. Keep the draft short enough that a teammate can challenge it in two minutes.',
      steps: ['Write the vague request exactly as you received it.', 'Rewrite it as a decision with a user and observable signal.', 'Add one piece of evidence and one non-goal.', 'Choose the smallest test that would change your mind.'],
      rubric: ['The decision is explicit and narrow.', 'The user problem is observable, not a wish.', 'The test and success signal could be inspected.', 'A non-goal protects the brief from scope creep.'],
    },
  };
}

export async function generateRoadmap(topic: string, userId: string, language: CourseLanguage = 'en') {
  const parsed = TopicInputSchema.parse({ topic, language });
  const settings = getFixedProviderSettings();
  const generated = await callTool({
    key: 'roadmap',
    schema: RoadmapSchema,
    settings,
    userId,
    system: `You are Synau, an exacting learning designer. Create a coherent course roadmap in ${parsed.language === 'id' ? 'natural Indonesian (Bahasa Indonesia)' : 'English'}. Use 3 to 5 sections with 2 to 4 subchapters each. Sequence concepts from foundations to practice to integration. Avoid vague titles and duplicate coverage. Return only the requested tool call.`,
    user: `Topic: ${parsed.topic}\nLanguage: ${parsed.language}\nKeep the path practical for a motivated adult learner.`,
    fallback: () => fallbackRoadmap(parsed.topic, parsed.language),
  });
  return RoadmapSchema.parse({ ...generated, language: parsed.language });
}

function fallbackLesson(input: LessonGenerationInput): LessonMaterial {
  if (input.language === 'id') {
    return indonesianLesson(input);
  }
  if (/product brief|writing better product briefs/i.test(input.topic)) {
    return productBriefLesson(input);
  }
  if (isDecisionDataTopic(input.topic)) {
    return decisionDataLesson(input);
  }
  const memoryCue = input.courseMemory.length
    ? `The course already has ${Math.ceil(input.courseMemory.length / 2)} generated subchapters, so this lesson adds a new angle instead of restating their takeaways.`
    : 'This is the first generated subchapter, so it establishes the shared vocabulary for the course.';
  const isPractice = /workflow|practice|feedback|iteration/i.test(input.lessonTitle);
  const isIntegration = /scenario|next step/i.test(input.lessonTitle);
  const angle = isIntegration
    ? 'decision-making in context'
    : isPractice
      ? 'a repeatable working process'
      : 'a clear mental model';
  const blocks = [
    {
      heading: 'Start with the central idea',
      body: `${input.lessonSummary} The useful test is whether you can explain what changes, why it matters, and what evidence would tell you that it is working. Keep the scope narrow enough that you can act on it today.`,
      bullets: ['Name the problem before choosing a method.', 'Prefer one explicit decision over a collection of tips.', 'Make the expected signal visible.'],
    },
    {
      heading: 'Use a small deliberate loop',
      body: `For ${input.topic}, begin with a small case, make your assumptions explicit, and inspect the result. If the result is weak, change the highest-leverage assumption first. This keeps practice grounded instead of turning into theory collection.`,
      bullets: ['Write down the starting context.', 'Run the smallest useful version.', 'Review the result against the original goal.'],
    },
    {
      heading: 'Connect it to your work',
      body: `Choose a real situation where ${input.lessonTitle.toLowerCase()} would matter. Decide what you would do first and what you would deliberately leave out. The quality of the decision is more important than producing a long artifact.`,
      bullets: ['What is the next observable action?', 'Which constraint matters most?', 'What would make you revise your approach?'],
    },
  ];
  return {
    lessonId: input.lessonId,
    title: input.lessonTitle,
    overview: `This subchapter focuses on ${angle} for ${input.topic}. ${memoryCue} It is intentionally compact: understand the idea, see how it changes a decision, then connect it to your own context.`,
    article: fallbackLessonArticle(input, blocks),
    nodes: fallbackLessonNodes(input, blocks),
    blocks,
    keyTakeaway: `Good ${input.topic} practice is a visible loop: frame the problem, make one deliberate move, inspect the signal, and refine the next move.`,
    reflectivePrompt: `Where could you apply this idea in the next seven days, and what evidence would tell you it helped?`,
    sourceNote: 'This lesson was generated for this course and scoped to the current subchapter. Verify examples against your own context.',
    sources: [],
    practice: {
      prompt: `Apply ${input.lessonTitle.toLowerCase()} to one real situation. Write the next observable action, the main constraint, and the signal you will inspect.`,
      steps: ['Choose one real situation.', 'Write the smallest useful action.', 'Name the constraint that matters most.', 'Decide what evidence you will inspect.'],
      rubric: ['The action is concrete.', 'The constraint is visible.', 'The signal can be observed.', 'The next revision is clear.'],
    },
  };
}

function ensureInlineSourceCitations(material: LessonMaterial): LessonMaterial {
  if (material.sources.length === 0 || material.article.sections.length === 0) return material;

  const cited = new Set<string>();
  for (const section of material.article.sections) {
    for (const paragraph of section.paragraphs) {
      for (const match of paragraph.matchAll(/\[\[([^\]]+)\]\]/g)) cited.add(match[1]);
    }
    for (const block of section.content) {
      for (const match of lessonArticleBlockContext(block).matchAll(/\[\[([^\]]+)\]\]/g)) cited.add(match[1]);
      if (block.type === 'quote' && block.sourceId) cited.add(block.sourceId);
    }
  }
  const missing = material.sources.filter((source) => !cited.has(source.id));
  if (missing.length === 0) return material;

  // Keep the article's voice intact. If a model forgets an inline citation,
  // add only the clickable markers; never inject a translated stock sentence
  // into the learner's prose.
  const citationMarkers = ` ${missing.map((source) => `[[${source.id}]]`).join(' ')}`;
  const sections = material.article.sections.map((section) => ({
    ...section,
    paragraphs: [...section.paragraphs],
    content: [...section.content],
  }));
  let inserted = false;
  for (const section of [...sections].reverse()) {
    for (let index = section.content.length - 1; index >= 0; index -= 1) {
      const block = section.content[index];
      if (block.type !== 'paragraph') continue;
      if (block.text.length + citationMarkers.length <= 1400) {
        section.content[index] = { ...block, text: `${block.text}${citationMarkers}` };
        inserted = true;
        break;
      }
    }
    if (inserted) break;
    for (let index = section.paragraphs.length - 1; index >= 0; index -= 1) {
      const paragraph = section.paragraphs[index];
      if (paragraph.length + citationMarkers.length <= 1400) {
        section.paragraphs[index] = `${paragraph}${citationMarkers}`;
        inserted = true;
        break;
      }
    }
    if (inserted) break;
  }
  return inserted ? { ...material, article: { sections } } : material;
}

function lessonWords(value: string) {
  return new Set(
    value
      .replace(/\[\[[^\]]+\]\]/g, ' ')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

function lessonWordOverlap(left: string, right: string) {
  const leftWords = lessonWords(left);
  const rightWords = lessonWords(right);
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let shared = 0;
  for (const word of leftWords) if (rightWords.has(word)) shared += 1;
  return shared / Math.min(leftWords.size, rightWords.size);
}

function lessonNeedsDiagram(input: LessonGenerationInput) {
  const text = `${input.topic} ${input.sectionTitle} ${input.lessonTitle} ${input.lessonSummary}`.toLocaleLowerCase();
  return /\b(workflow|process|sequence|framework|lifecycle|pipeline|funnel|journey|feedback loop|decision tree|causal chain|cause and effect|relationship|intersection|overlap|matrix|three circles|niche|passion|positioning|target audience|value proposition|alur|proses|langkah|kerangka|siklus|hubungan|sebab|akibat|irisan|lingkaran|tahapan)\b/i.test(text);
}

function firstLessonParagraph(lesson: LessonMaterial) {
  for (const section of lesson.article.sections) {
    const richParagraph = section.content.find((block) => block.type === 'paragraph');
    if (richParagraph?.type === 'paragraph') return richParagraph.text;
    if (section.paragraphs[0]) return section.paragraphs[0];
  }
  return '';
}

const GeneratedLessonMaterialSchema = LessonMaterialSchema.superRefine((lesson, ctx) => {
  if (lesson.article.sections.length === 0) return;
  const overviewSentences = lesson.overview.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  if (overviewSentences.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['overview'], message: 'The lesson overview must be a two-sentence editorial deck, not a one-line summary.' });
  }
  const firstSection = lesson.article.sections[0];
  if (firstSection.content.length > 0 && firstSection.content[0]?.type !== 'paragraph') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['article', 'sections', 0, 'content', 0], message: 'The article must begin with a paragraph before any diagram, code, equation, table, or quote.' });
  }
  const opening = firstLessonParagraph(lesson);
  if (!opening) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['article', 'sections', 0], message: 'The article must open with a natural paragraph before optional visual blocks.' });
    return;
  }
  if (opening.split(/\s+/).filter(Boolean).length < 45) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['article', 'sections', 0], message: 'The opening paragraph needs enough substance to feel like an article, not a one-line lesson summary.' });
  }
  if (lessonWordOverlap(lesson.overview, opening) >= 0.78) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['article', 'sections', 0], message: 'The opening paragraph repeats the overview. Start with a distinct concrete hook or situation.' });
  }
});

function lessonGenerationSchema(input: LessonGenerationInput) {
  return GeneratedLessonMaterialSchema.superRefine((lesson, ctx) => {
    if (lessonNeedsDiagram(input) && !lesson.article.sections.some((section) => section.content.some((block) => block.type === 'mermaid'))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['article'], message: 'This lesson has a process, framework, relationship, or sequence that needs one simple Mermaid diagram placed after the relevant explanation.' });
    }
  });
}

function addFallbackLessonDiagram(material: LessonMaterial, input: LessonGenerationInput) {
  if (!lessonNeedsDiagram(input) || material.article.sections.some((section) => section.content.some((block) => block.type === 'mermaid'))) return material;
  const sections = material.article.sections.map((section) => ({ ...section, paragraphs: [...section.paragraphs], content: [...section.content] }));
  const target = sections[0];
  if (!target || target.content.length >= 10) return material;
  const paragraphIndex = target.content.findIndex((block) => block.type === 'paragraph');
  const diagram = {
    type: 'mermaid' as const,
    code: 'flowchart LR\n  A[Frame the question] --> B[Make one deliberate move]\n  B --> C[Inspect the signal]\n  C --> D[Revise the next move]',
    caption: 'A compact learning loop for turning an idea into an observable next step',
  };
  target.content.splice(paragraphIndex >= 0 ? paragraphIndex + 1 : 0, 0, diagram);
  return { ...material, article: { sections } };
}

const LESSON_GENERATION_SYSTEM_PROMPT = `You are Synau's senior curriculum editor and article writer. Create one premium learning article for one subchapter, written for a motivated adult learner.

The reading should feel like a thoughtful Medium essay or a high-quality professional course: confident, clear, warm, specific, and close to the learner without sounding casual or salesy. Write in the learner's language; if the topic and brief are Indonesian, use natural Indonesian rather than translated English. Do not write a slide deck, outline, card collection, or generic summary.

Editorial shape:
- The overview is an editorial deck of 2 sentences: establish the stakes and promise what the reader will be able to see or do. It must not repeat the lesson title, brief, or opening paragraph.
- Open the article with a concrete tension, recognizable situation, question, surprising observation, or useful contrast. The first paragraph must be a distinct, substantial paragraph of at least 45 words; never begin with “In this lesson”, “This subchapter”, “Teknik…”, or a one-sentence restatement of the brief.
- Build a natural arc suited to the topic: context or problem, the mental model, how it works, a concrete example or implication, and a transfer or boundary. Use 3 to 5 sections when the topic supports it. Give each section real prose; do not manufacture headings just to fill a template.
- Prefer paragraphs as the primary medium. Vary sentence rhythm, explain important terms at first use, use concrete details, and let the reasoning develop. Avoid motivational filler, repeated conclusions, mechanical numbering, “first/second/third” lists unless the subject truly requires sequence, and awkward translated phrasing.

Representation decision:
- Before writing, identify the lesson's dominant structure. If it contains a process, sequence, causal chain, feedback loop, decision tree, system relationship, framework, lifecycle, or spatial relationship, include one clean Mermaid diagram. This is a positive requirement for those structures, not a rare fallback: prose explains the meaning and the diagram lets the reader see the relationships at a glance.
- Use a Mermaid block for flowcharts, sequences, causal loops, decision trees, or system relationships. Keep it simple, valid Mermaid, and place it immediately after the prose that explains it. Include a short caption. Do not use a decorative diagram for a purely narrative or definitional idea.
- Use a code block only when executable code or a command is genuinely part of the topic; an equation only when a formula is central; and a table only when rows make a real comparison or classification clearer. Optional blocks must support the article rather than interrupt it. Never force a format and never invent an unsupported format.

Output rules:
- Return 2 to 5 sections with an ordered content stream using only paragraph, code, equation, mermaid, table, and quote blocks. Keep paragraphs at least 45 words where the article is explaining an idea. Do not return legacy nodes, blocks, practice, reflection, source-note, or dataLab fields.
- Use 1 to 3 relevant sources with stable URLs you know are real. Cite claims naturally inline with [[source-id]]; do not append a generic citation sentence or cite a source for a claim it does not support. References are shown separately at the end.
- Label illustrative assumptions in the prose. Return only the requested tool call.`;

export async function generateLesson(input: LessonGenerationInput, userId: string) {
  const parsed = LessonGenerationInputSchema.parse(input);
  const settings = getFixedProviderSettings();
  const fallback = () => addFallbackLessonDiagram(fallbackLesson(parsed), parsed);
  const generated = await callTool({
    key: 'lesson',
    schema: lessonGenerationSchema(parsed),
    settings,
    userId,
    system: LESSON_GENERATION_SYSTEM_PROMPT,
    user: `Course: ${parsed.courseTitle}\nTopic: ${parsed.topic}\nLanguage: ${parsed.language}\nSection: ${parsed.sectionTitle}\nSubchapter ID: ${parsed.lessonId}\nSubchapter: ${parsed.lessonTitle}\nBrief: ${parsed.lessonSummary}\nPreviously covered course memory:\n${parsed.courseMemory.join('\n') || 'None yet.'}`,
    fallback,
  });
  const fallbackMaterial = fallback();
  const material = LessonMaterialSchema.parse({
    ...generated,
    lessonId: parsed.lessonId,
    article: generated.article.sections.length > 0 ? generated.article : fallbackMaterial.article,
    sources: generated.sources.length > 0 ? generated.sources : fallbackMaterial.sources,
    // Legacy fields stay parseable for old rows but never enter new lesson output.
    blocks: [],
    nodes: [],
    practice: undefined,
    dataLab: undefined,
    reflectivePrompt: undefined,
    sourceNote: undefined,
  });
  return LessonMaterialSchema.parse(ensureInlineSourceCitations(material));
}

function decisionDataQuizConcepts(input: QuizGenerationInput): DecisionDataConcept[] {
  const text = `${input.scopeTitle} ${input.materialContext.join(' ')}`.toLowerCase();
  const matches = decisionDataConceptOrder.filter((concept) => {
    const patterns: Record<DecisionDataConcept, RegExp> = {
      metrics: /metric|measure|outcome|guardrail|dashboard/,
      baselines: /baseline|comparator|denominator|instrumentation|building block/,
      uncertainty: /uncertaint|estimate|sample|noise|threshold|practice/,
      bias: /bias|missing|selection|data quality|feedback/,
      causality: /caus|correlation|counterfactual|scenario|intervention/,
      constraints: /constraint|trade.?off|reversib|decision table|next step|integration/,
    };
    return patterns[concept].test(text);
  });

  if (input.scope === 'course') return decisionDataConceptOrder;
  if (input.scope === 'chapter') {
    if (matches.length >= 2) return matches.slice(0, 2);
    if (/foundation|metric|baseline/.test(text)) return ['metrics', 'baselines'];
    if (/practice|uncertaint|bias/.test(text)) return ['uncertainty', 'bias'];
    if (/integration|caus|constraint/.test(text)) return ['causality', 'constraints'];
    const firstIndex = Math.max(0, decisionDataConceptOrder.indexOf(matches[0] ?? 'metrics'));
    return decisionDataConceptOrder.slice(firstIndex, firstIndex + 2);
  }
  return [matches[0] ?? 'metrics'];
}

function fallbackQuiz(input: QuizGenerationInput): Quiz {
  const prefix = `${input.scope}-${input.scopeId}`;
  if (/product brief|writing better product briefs/i.test(input.topic)) {
    return {
      id: prefix,
      scope: input.scope,
      scopeId: input.scopeId,
      title: `${input.scopeTitle} applied review`,
      instructions: 'Use the worked example, then choose the answer that would make a product decision clearer. You can repeat this review at any time; it never gates progress.',
      questions: [
        {
          id: `${prefix}-1`,
          prompt: 'Which rewrite is the stronger product-brief opening?',
          options: ['Make onboarding more delightful for everyone.', 'Help first-time project leads create their first saved brief in one session; test a three-field starting template.', 'Redesign the onboarding experience across every surface.', 'Add more context so the team understands the vision.'],
          answerIndex: 1,
          explanation: 'The stronger opening names a user, a behavior, a testable move, and an observable signal without pretending the solution is final.',
        },
        {
          id: `${prefix}-2`,
          prompt: 'A team wants to solve the entire editor in one cycle. Which brief field protects the decision from scope creep?',
          options: ['A longer background section', 'A non-goal that states what is intentionally out of scope', 'A list of every future feature', 'A more aspirational headline'],
          answerIndex: 1,
          explanation: 'A visible non-goal keeps the current decision narrow and makes later requests easier to evaluate.',
        },
        {
          id: `${prefix}-3`,
          prompt: 'The brief says “improve activation,” but nobody can tell whether the change helped. What should happen next?',
          options: ['Choose one observable behavior and define how the smallest test will be inspected.', 'Add another page of context before deciding.', 'Ask the team to agree that activation feels better.', 'Start building the most obvious solution immediately.'],
          answerIndex: 0,
          explanation: 'The team needs an observable signal and a small test so the decision can learn from evidence.',
        },
      ],
    };
  }
  if (isDecisionDataTopic(input.topic)) {
    const concepts = decisionDataQuizConcepts(input);
    const perConcept = input.scope === 'lesson' ? 3 : input.scope === 'chapter' ? 2 : 1;
    const questions = concepts
      .flatMap((concept) => decisionDataCurriculum.lessons[concept].questions.slice(0, perConcept))
      .slice(0, 8)
      .map((question, index) => ({ ...question, id: `${prefix}-${index + 1}` }));
    return {
      id: prefix,
      scope: input.scope,
      scopeId: input.scopeId,
      title: `${input.scopeTitle} applied review`,
      instructions: 'Use the decision examples and choose the answer that best matches the evidence. You can repeat this review at any time; it never gates progress.',
      questions,
    };
  }
  return {
    id: prefix,
    scope: input.scope,
    scopeId: input.scopeId,
    title: `${input.scopeTitle} check-in`,
    instructions: 'Choose the best answer. You can repeat this quiz at any time; it does not lock or gate course progress.',
    questions: [
      {
        id: `${prefix}-1`,
        prompt: `What is the most useful starting move when working on ${input.scopeTitle.toLowerCase()}?`,
        options: ['Name the problem and desired signal', 'Collect every possible tool first', 'Skip context and copy an example', 'Wait until the final answer is obvious'],
        answerIndex: 0,
        explanation: 'A clear problem and observable signal keep practice focused and make iteration possible.',
      },
      {
        id: `${prefix}-2`,
        prompt: 'Which behavior best supports deliberate learning?',
        options: ['Repeat the same step without checking', 'Make a small move, inspect the result, and refine', 'Add more complexity before testing', 'Treat every topic as interchangeable'],
        answerIndex: 1,
        explanation: 'The learning loop depends on acting, inspecting evidence, and choosing the next improvement.',
      },
      {
        id: `${prefix}-3`,
        prompt: 'What should course-level memory prevent?',
        options: ['All review and retrieval practice', 'Learners from revisiting a quiz', 'Unhelpful repetition across subchapters', 'The learner from changing direction'],
        answerIndex: 2,
        explanation: 'Synau keeps lightweight memory so new material adds coverage while review remains available on demand.',
      },
    ],
  };
}

function quizAnchors(input: QuizGenerationInput) {
  const anchors = input.materialContext
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .filter((entry) => entry.length >= 24)
    .map((entry) => entry.length > 180 ? `${entry.slice(0, 177).trimEnd()}...` : entry)
    .slice(0, 3);
  while (anchors.length < 3) {
    const fallback = `${input.scopeTitle}: ${input.topic}`;
    anchors.push(fallback.length > 180 ? `${fallback.slice(0, 177).trimEnd()}...` : fallback);
  }
  return anchors;
}

function quizAnswerFromAnchor(anchor: string) {
  const sentence = anchor.split(/(?<=[.!?])\s+/)[0]?.trim() || anchor.trim();
  return sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}...` : sentence;
}

function diversifyQuizAnswerPositions(quiz: GeneratedQuiz): GeneratedQuiz {
  const preferredPositions = [0, 1, 2];
  return {
    ...quiz,
    questions: quiz.questions.map((question, index) => {
      const targetPosition = Math.min(preferredPositions[index] ?? index, question.options.length - 1);
      if (question.answerIndex === targetPosition) return question;
      const options = [...question.options];
      [options[question.answerIndex], options[targetPosition]] = [options[targetPosition], options[question.answerIndex]];
      return { ...question, options, answerIndex: targetPosition };
    }),
  };
}

function fallbackGeneratedQuiz(input: QuizGenerationInput) {
  if (input.language === 'id') {
    const base = fallbackQuiz(input);
    const anchors = quizAnchors(input);
    return GeneratedQuizSchema.parse({
      ...base,
      title: `${input.scopeTitle}: ulasan berbahasa Indonesia`,
      instructions: 'Gunakan materi bacaan sebagai dasar. Kuis ini dapat diulang kapan saja dan tidak mengunci progres.',
      questions: [
        {
          id: `${input.scope}-${input.scopeId}-1`,
          prompt: 'Pernyataan mana yang didukung langsung oleh artikel?',
          options: [anchors[0], 'Artikel menyarankan melewati konteks sebelum bertindak.', 'Artikel menyatakan semua situasi dapat diperlakukan sama.', 'Artikel menghapus kebutuhan untuk memeriksa bukti.'],
          answerIndex: 0,
          explanation: 'Jawaban ini dirujuk langsung oleh konteks artikel yang tersedia.',
          kind: 'article' as const,
          articleAnchor: anchors[0],
        },
        {
          id: `${input.scope}-${input.scopeId}-2`,
          prompt: 'Gagasan kedua apa yang dinyatakan secara jelas dalam artikel?',
          options: ['Salin solusi pertama tanpa memeriksa hasilnya.', anchors[1], 'Tambahkan kompleksitas sebelum menguji apa pun.', 'Kendala tidak perlu disebutkan.'],
          answerIndex: 1,
          explanation: 'Jawaban ini merupakan parafrasa langsung dari konteks artikel.',
          kind: 'article' as const,
          articleAnchor: anchors[1],
        },
        {
          id: `${input.scope}-${input.scopeId}-3`,
          prompt: 'Situasi baru mengubah satu kendala penting. Langkah mana yang paling tepat?',
          options: ['Sesuaikan gagasan dengan kendala baru, tentukan sinyal, lalu periksa hasilnya.', 'Salin respons lama tanpa memeriksa kecocokannya.', 'Perluas cakupan sampai semua trade-off hilang.', 'Abaikan bukti karena contoh awal pernah berhasil.'],
          answerIndex: 0,
          explanation: 'Tantangan meminta kamu memindahkan gagasan artikel ke situasi baru dan menggunakan bukti untuk memilih langkah berikutnya.',
          kind: 'challenge' as const,
          articleAnchor: anchors[2],
        },
      ],
    });
  }
  const base = fallbackQuiz(input);
  const anchors = quizAnchors(input);
  const directQuestions = [0, 1].map((index) => {
    const answer = quizAnswerFromAnchor(anchors[index]);
    const options = index === 0
      ? [answer, 'The material says context can be skipped before acting.', 'The material recommends adding scope before checking evidence.', 'The material treats every situation as interchangeable.']
      : ['The material recommends copying the first available solution.', answer, 'The material says a result cannot be inspected.', 'The material removes the need to name a constraint.'];
    return {
      id: `${input.scope}-${input.scopeId}-${index + 1}`,
      prompt: index === 0
        ? 'Which statement is directly supported by the article?'
        : 'Which second idea is explicitly stated in the article?',
      options,
      answerIndex: index,
      explanation: 'The correct answer is stated directly in the supplied article context.',
      kind: 'article' as const,
      articleAnchor: anchors[index],
    };
  });
  const challenge = {
    id: `${input.scope}-${input.scopeId}-3`,
    prompt: `A new situation changes one important constraint in ${input.scopeTitle.toLowerCase()}. Which next move best transfers the article's idea?`,
    options: ['Adapt the article’s idea to the changed constraint, define a signal, and inspect the result.', 'Copy the original response without checking whether the constraint still fits.', 'Add more scope until no trade-off remains.', 'Ignore the evidence because the original example worked once.'],
    answerIndex: 0,
    explanation: 'The challenge asks you to transfer the article’s idea to a new situation, make the constraint visible, and use evidence to refine the next move.',
  };
  return GeneratedQuizSchema.parse({
    ...base,
    questions: [
      ...directQuestions,
      { ...challenge, kind: 'challenge' as const, articleAnchor: anchors[2] },
    ],
  });
}

export async function generateQuiz(input: QuizGenerationInput, userId: string) {
  const parsed = QuizGenerationInputSchema.parse(input);
  const settings = getFixedProviderSettings();
  const compactPromptContext = (entries: string[], maxCharacters: number) => {
    const output: string[] = [];
    let used = 0;
    for (const entry of entries) {
      const normalized = entry.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      const remaining = maxCharacters - used;
      if (remaining < 80) break;
      const clipped = normalized.length > Math.min(560, remaining)
        ? `${normalized.slice(0, Math.min(557, remaining - 3)).trimEnd()}...`
        : normalized;
      output.push(clipped);
      used += clipped.length + 1;
    }
    return output;
  };
  const materialPromptContext = compactPromptContext(parsed.materialContext, 8_000);
  const memoryPromptContext = compactPromptContext(parsed.courseMemory, 3_000);
  const generated = await callTool({
    key: 'quiz',
    schema: GeneratedQuizSchema,
    settings,
    userId,
    system: 'You are Synau, an assessment designer. Write a fair, repeatable, low-stakes quiz grounded only in the supplied lesson material. Return exactly 3 questions in this order: two article questions whose correct answers are directly stated or unambiguously paraphrased in the material, followed by one challenge question that applies the same concepts to a new but relevant situation and requires analysis. Mark the first two kind=article and the last kind=challenge. Every question needs an articleAnchor of 8 to 180 characters copied from or closely matching the supplied material. Use exactly 4 unique plausible options per question, keep each option under 180 characters and each explanation under 280 characters, vary answer positions, keep explanations tied to the material, and return only the requested tool call. Do not test product-system trivia, unrelated background knowledge, or concepts absent from the material.',
    user: `Course: ${parsed.courseTitle}\nTopic: ${parsed.topic}\nLanguage: ${parsed.language}\nScope: ${parsed.scope}\nScope title: ${parsed.scopeTitle}\nMaterial context (the only source of truth for article questions):\n${materialPromptContext.join('\n') || 'No generated material is available; use the scope brief conservatively.'}\nCourse memory (use only to avoid repeating the same angle):\n${memoryPromptContext.join('\n') || 'None yet.'}`,
    fallback: () => fallbackGeneratedQuiz(parsed),
  });
  return diversifyQuizAnswerPositions(generated);
}
