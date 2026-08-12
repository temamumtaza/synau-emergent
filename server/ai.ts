import { z } from 'zod';
import { beginLlmBilling, parseUsage, type LlmBilling } from './credits.js';
import { isSupabaseStorage } from './supabase.js';
import { beginRemoteLlmBilling, type RemoteLlmBilling } from './supabase-credits.js';
import { generatorTools } from '../shared/generators.js';
import {
  LessonGenerationInputSchema,
  LessonMaterialSchema,
  LESSON_NODE_TYPES,
  type LessonGenerationInput,
  type LessonArticle,
  type LessonNode,
  QuizGenerationInputSchema,
  QuizSchema,
  RoadmapSchema,
  TopicInputSchema,
  type LessonMaterial,
  type Quiz,
  type QuizGenerationInput,
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
    required: ['lessonId', 'title', 'overview', 'article', 'sources', 'keyTakeaway', 'reflectivePrompt', 'sourceNote'],
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
              required: ['heading', 'paragraphs'],
              properties: {
                heading: { type: 'string' },
                paragraphs: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
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
      nodes: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'heading'],
          properties: {
            type: { type: 'string', enum: [...LESSON_NODE_TYPES] },
            heading: { type: 'string' },
            body: { type: 'string' },
            bullets: { type: 'array', maxItems: 6, items: { type: 'string' } },
            context: { type: 'string' },
            steps: { type: 'array', maxItems: 6, items: { type: 'string' } },
            insight: { type: 'string' },
            leftLabel: { type: 'string' },
            rightLabel: { type: 'string' },
            rows: {
              type: 'array', maxItems: 6,
              items: {
                type: 'object', additionalProperties: false,
                required: ['criterion', 'left', 'right'],
                properties: { criterion: { type: 'string' }, left: { type: 'string' }, right: { type: 'string' } },
              },
            },
            situation: { type: 'string' },
            choices: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' } },
            prompt: { type: 'string' },
            reasoning: { type: 'string' },
            sequence: {
              type: 'array', maxItems: 6,
              items: {
                type: 'object', additionalProperties: false,
                required: ['label', 'description'],
                properties: { label: { type: 'string' }, description: { type: 'string' } },
              },
            },
            outcome: { type: 'string' },
            events: {
              type: 'array', minItems: 2, maxItems: 8,
              items: {
                type: 'object', additionalProperties: false,
                required: ['label', 'description'],
                properties: { label: { type: 'string' }, description: { type: 'string' } },
              },
            },
            language: { type: 'string' },
            code: { type: 'string' },
            explanation: { type: 'string' },
          },
        },
      },
      keyTakeaway: { type: 'string' },
      reflectivePrompt: { type: 'string' },
      sourceNote: { type: 'string' },
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
        minItems: 2,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'prompt', 'options', 'answerIndex', 'explanation'],
          properties: {
            id: { type: 'string' },
            prompt: { type: 'string' },
            options: { type: 'array', minItems: 3, maxItems: 5, uniqueItems: true, items: { type: 'string' } },
            answerIndex: { type: 'integer', minimum: 0, maximum: 4 },
            explanation: { type: 'string' },
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
      const parsed = args.schema.safeParse(toolArguments);
      if (parsed.success) {
        completed = true;
        return parsed.data;
      }
      // Supporting nodes are deliberately optional. If a provider returns a
      // valid article but one visual node uses an unsupported shape, keep the
      // article and discard only that optional surface instead of failing the
      // whole lesson generation.
      if (args.key === 'lesson' && toolArguments && typeof toolArguments === 'object' && 'nodes' in toolArguments) {
        const articleOnly = args.schema.safeParse({ ...toolArguments, nodes: [] });
        if (articleOnly.success) {
          console.warn(`[tool:${generatorTools[args.key].name}] ignored invalid optional lesson nodes; article contract passed`);
          completed = true;
          return articleOnly.data;
        }
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
    ? 'For every question, answerIndex must be an integer from 0 through options.length - 1; use 3 to 5 unique options and vary correct answer positions.'
    : key === 'lesson'
      ? 'Article must contain 2 to 5 sections with 1 to 3 natural paragraphs each. Every [[source-id]] marker must match a source id. Use at most 2 supporting nodes, match each node type, and omit unused fields. Do not return blocks, practice, or dataLab.'
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
    sections: blocks.slice(0, 5).map((block) => ({
      heading: block.heading,
      paragraphs: [
        block.body,
        block.bullets.length > 0 ? `Keep these questions in view: ${block.bullets.join(' ')}` : 'Pause here and connect the idea to one situation in your own context.',
      ],
    })),
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

function fallbackRoadmap(topic: string): Roadmap {
  if (isDecisionDataTopic(topic)) {
    return decisionDataRoadmap(topic);
  }
  const key = slug(topic);
  return {
    title: `${topic}: a practical learning path`,
    description: `A focused path from first principles to confident application of ${topic}. Each subchapter is generated when you open it so the course stays relevant to your pace.`,
    topic,
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

export async function generateRoadmap(topic: string, userId: string) {
  const parsed = TopicInputSchema.parse({ topic });
  const settings = getFixedProviderSettings();
  return callTool({
    key: 'roadmap',
    schema: RoadmapSchema,
    settings,
    userId,
    system: 'You are Synau, an exacting learning designer. Create a coherent course roadmap. Use 3 to 5 sections with 2 to 4 subchapters each. Sequence concepts from foundations to practice to integration. Avoid vague titles and duplicate coverage. Return only the requested tool call.',
    user: `Topic: ${parsed.topic}\nKeep the path practical for a motivated adult learner.`,
    fallback: () => fallbackRoadmap(parsed.topic),
  });
}

function fallbackLesson(input: LessonGenerationInput): LessonMaterial {
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
  }
  const missing = material.sources.filter((source) => !cited.has(source.id));
  if (missing.length === 0) return material;

  const sentence = `For further reading on this topic, see ${missing.map((source) => `[[${source.id}]]`).join(', ')}.`;
  const sections = material.article.sections.map((section) => ({
    ...section,
    paragraphs: [...section.paragraphs],
  }));
  let inserted = false;
  for (const section of sections) {
    for (let index = 0; index < section.paragraphs.length; index += 1) {
      const paragraph = section.paragraphs[index];
      if (paragraph.length + sentence.length + 1 <= 1400) {
        section.paragraphs[index] = `${paragraph} ${sentence}`;
        inserted = true;
        break;
      }
    }
    if (inserted) break;
  }
  if (!inserted && sections[0].paragraphs.length < 3) {
    sections[0].paragraphs.push(sentence);
    inserted = true;
  }
  if (!inserted) {
    const paragraph = sections[0].paragraphs[0];
    const room = Math.max(40, 1400 - sentence.length - 1);
    sections[0].paragraphs[0] = `${paragraph.slice(0, room).trimEnd()} ${sentence}`;
  }
  return { ...material, article: { sections } };
}

export async function generateLesson(input: LessonGenerationInput, userId: string) {
  const parsed = LessonGenerationInputSchema.parse(input);
  const settings = getFixedProviderSettings();
  const generated = await callTool({
    key: 'lesson',
    schema: LessonMaterialSchema,
    settings,
    userId,
    system: 'You are Synau, a concise expert instructor. Write one flowing article for one subchapter. The article is the lesson; do not turn the main reading into numbered cards. Return 2 to 5 sections with 1 to 3 natural paragraphs each, no section numbering, and a clear progression from idea to example to application. Include 1 to 3 relevant sources with stable URLs you know are real; use ids src-1, src-2, etc. Cite a source inline with [[source-id]] only when the claim is supported by it, and never invent a citation or URL. Supporting components are optional: return 0 to 2 nodes only when a flow, comparison, scenario, timeline, code walkthrough, or worked example genuinely improves the article. Allowed node fields: prose(heading,body,bullets); example(heading,context,steps,insight); comparison(heading,leftLabel,rightLabel,rows); scenario(heading,situation,choices,prompt,reasoning); flow(heading,sequence[{label,description}],outcome); timeline(heading,events[{label,description}]); code(heading,language,code,explanation,bullets). Keep the article compact, label illustrative assumptions, do not return blocks, practice, or dataLab, and return only the requested tool call.',
    user: `Course: ${parsed.courseTitle}\nTopic: ${parsed.topic}\nSection: ${parsed.sectionTitle}\nSubchapter ID: ${parsed.lessonId}\nSubchapter: ${parsed.lessonTitle}\nBrief: ${parsed.lessonSummary}\nPreviously covered course memory:\n${parsed.courseMemory.join('\n') || 'None yet.'}`,
    fallback: () => fallbackLesson(parsed),
  });
  const fallback = fallbackLesson(parsed);
  const material = LessonMaterialSchema.parse({
    ...generated,
    lessonId: parsed.lessonId,
    article: generated.article.sections.length > 0 ? generated.article : fallback.article,
    sources: generated.sources.length > 0 ? generated.sources : fallback.sources,
    nodes: generated.nodes.length > 0 ? generated.nodes : fallback.nodes,
    practice: generated.practice ?? fallback.practice,
    dataLab: generated.dataLab ?? fallback.dataLab,
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

export async function generateQuiz(input: QuizGenerationInput, userId: string) {
  const parsed = QuizGenerationInputSchema.parse(input);
  const settings = getFixedProviderSettings();
  return callTool({
    key: 'quiz',
    schema: QuizSchema,
    settings,
    userId,
    system: 'You are Synau, an assessment designer. Write a fair, repeatable, low-stakes quiz. Test topic-specific understanding and decisions, not product-system trivia. Use a realistic scenario or worked example when possible. Keep answer options plausible, vary the correct answer position, and make explanations point back to the lesson. Return only the requested tool call.',
    user: `Course: ${parsed.courseTitle}\nTopic: ${parsed.topic}\nScope: ${parsed.scope}\nScope title: ${parsed.scopeTitle}\nMaterial context:\n${parsed.materialContext.join('\n') || 'Use the scope title and topic.'}\nCourse memory:\n${parsed.courseMemory.join('\n') || 'None yet.'}`,
    fallback: () => fallbackQuiz(parsed),
  });
}
