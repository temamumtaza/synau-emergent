import { z } from 'zod';

const EntityIdSchema = z.string().trim().min(1).max(200);

export const UserSchema = z.object({
  id: EntityIdSchema,
  email: z.string().email(),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  username: z.string().trim().min(3).max(32),
  name: z.string().min(1),
});
export type User = z.infer<typeof UserSchema>;

export const GoogleAuthRequestSchema = z.object({
  accessToken: z.string().trim().min(20).max(10_000),
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,30}[a-zA-Z0-9]$/, 'Username must use letters, numbers, dots, underscores, or hyphens.').optional(),
}).strict();
export type GoogleAuthRequest = z.infer<typeof GoogleAuthRequestSchema>;

const GoogleProfileSuggestionSchema = z.object({
  email: z.string().email(),
  firstName: z.string().max(60),
  lastName: z.string().max(60),
  username: z.string().min(3).max(32),
}).strict();

export const GoogleAuthResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('profile_required'),
    profile: GoogleProfileSuggestionSchema,
  }).strict(),
  z.object({
    status: z.literal('authenticated'),
    token: z.string().min(20),
    user: UserSchema,
    created: z.boolean(),
  }).strict(),
]);
export type GoogleAuthResponse = z.infer<typeof GoogleAuthResponseSchema>;

export const AuthCodePurposeSchema = z.enum(['sign_in', 'sign_up']);
export type AuthCodePurpose = z.infer<typeof AuthCodePurposeSchema>;

const AuthEmailSchema = z.string().trim().email().max(254);
const AuthUsernameSchema = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,30}[a-zA-Z0-9]$/, 'Username must use letters, numbers, dots, underscores, or hyphens.');

export const AuthCodeRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('sign_in'),
    identifier: z.string().trim().min(3).max(254),
  }).strict(),
  z.object({
    mode: z.literal('sign_up'),
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    username: AuthUsernameSchema,
    email: AuthEmailSchema,
  }).strict(),
]);
export type AuthCodeRequest = z.infer<typeof AuthCodeRequestSchema>;

export const AuthCodeVerifySchema = z.object({
  challengeId: EntityIdSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Verification code must be six digits.'),
}).strict();
export type AuthCodeVerify = z.infer<typeof AuthCodeVerifySchema>;

export const AuthCodeResponseSchema = z.object({
  challengeId: EntityIdSchema,
  maskedEmail: z.string().min(1),
  expiresAt: z.string(),
  retryAfterSeconds: z.number().int().min(0),
  isDemo: z.boolean(),
  message: z.string().min(1),
});
export type AuthCodeResponse = z.infer<typeof AuthCodeResponseSchema>;

export const TopicInputSchema = z.object({
  topic: z.string().trim().min(3).max(120),
});

export const RoadmapLessonSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(280),
  estimatedMinutes: z.number().int().min(5).max(180),
  position: z.number().int().min(0),
});
export type RoadmapLesson = z.infer<typeof RoadmapLessonSchema>;

export const RoadmapSectionSchema = z.object({
  id: EntityIdSchema,
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(280),
  position: z.number().int().min(0),
  lessons: z.array(RoadmapLessonSchema).min(1).max(8),
});
export type RoadmapSection = z.infer<typeof RoadmapSectionSchema>;

export const RoadmapSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(500),
  topic: z.string().min(3).max(120),
  outcomes: z.array(z.string().min(1).max(180)).min(3).max(6),
  sections: z.array(RoadmapSectionSchema).min(2).max(8),
});
export type Roadmap = z.infer<typeof RoadmapSchema>;

export const LessonGenerationInputSchema = z.object({
  courseId: EntityIdSchema,
  lessonId: EntityIdSchema,
  topic: z.string(),
  courseTitle: z.string(),
  sectionTitle: z.string(),
  lessonTitle: z.string(),
  lessonSummary: z.string(),
  courseMemory: z.array(z.string()).max(40),
});
export type LessonGenerationInput = z.infer<typeof LessonGenerationInputSchema>;

export const LessonBlockSchema = z.object({
  heading: z.string().min(1).max(140),
  body: z.string().min(1).max(1800),
  bullets: z.array(z.string().min(1).max(180)).max(5),
});

const LessonNodeTextArraySchema = z.array(z.string().min(1).max(240)).max(6);
const LessonNodeRowSchema = z.object({
  criterion: z.string().min(1).max(120),
  left: z.string().min(1).max(240),
  right: z.string().min(1).max(240),
}).strict();
const LessonTimelineEventSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(300),
}).strict();

export const LessonNodeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('prose'),
    heading: z.string().min(1).max(140),
    body: z.string().min(1).max(1800),
    bullets: LessonNodeTextArraySchema,
  }).strict(),
  z.object({
    type: z.literal('example'),
    heading: z.string().min(1).max(140),
    context: z.string().min(1).max(700),
    steps: LessonNodeTextArraySchema.min(2),
    insight: z.string().min(1).max(500),
  }).strict(),
  z.object({
    type: z.literal('comparison'),
    heading: z.string().min(1).max(140),
    leftLabel: z.string().min(1).max(80),
    rightLabel: z.string().min(1).max(80),
    rows: z.array(LessonNodeRowSchema).min(2).max(6),
  }).strict(),
  z.object({
    type: z.literal('scenario'),
    heading: z.string().min(1).max(140),
    situation: z.string().min(1).max(900),
    choices: z.array(z.string().min(1).max(240)).min(2).max(4),
    prompt: z.string().min(1).max(300),
    reasoning: z.string().min(1).max(700),
  }).strict(),
  z.object({
    type: z.literal('flow'),
    heading: z.string().min(1).max(140),
    sequence: z.array(z.object({
      label: z.string().min(1).max(100),
      description: z.string().min(1).max(260),
    }).strict()).min(2).max(6),
    outcome: z.string().min(1).max(400),
  }).strict(),
  z.object({
    type: z.literal('timeline'),
    heading: z.string().min(1).max(140),
    events: z.array(LessonTimelineEventSchema).min(2).max(8),
  }).strict(),
  z.object({
    type: z.literal('code'),
    heading: z.string().min(1).max(140),
    language: z.string().min(1).max(40),
    code: z.string().min(1).max(2400),
    explanation: z.string().min(1).max(900),
    bullets: LessonNodeTextArraySchema,
  }).strict(),
]);
export type LessonNode = z.infer<typeof LessonNodeSchema>;
export const LESSON_NODE_TYPES = ['prose', 'example', 'comparison', 'scenario', 'flow', 'timeline', 'code'] as const;
export type LessonNodeType = typeof LESSON_NODE_TYPES[number];

export const LessonArticleSectionSchema = z.object({
  heading: z.string().trim().min(1).max(140),
  paragraphs: z.array(z.string().trim().min(40).max(1400)).min(1).max(3),
}).strict();

export const LessonArticleSchema = z.object({
  sections: z.array(LessonArticleSectionSchema).max(5).default([]),
}).strict();
export type LessonArticle = z.infer<typeof LessonArticleSchema>;

export const LessonSourceSchema = z.object({
  id: EntityIdSchema,
  title: z.string().trim().min(1).max(180),
  url: z.string().trim().url().max(2048),
  publisher: z.string().trim().min(1).max(120),
  kind: z.enum(['article', 'video', 'documentation', 'course', 'paper', 'book', 'other']),
}).strict();
export type LessonSource = z.infer<typeof LessonSourceSchema>;

export const LessonPracticeSchema = z.object({
  prompt: z.string().min(1).max(600),
  steps: z.array(z.string().min(1).max(240)).max(6),
  rubric: z.array(z.string().min(1).max(240)).min(2).max(5),
});

const LessonDataLabColumnsSchema = z.array(z.string().trim().min(1).max(80)).min(2).max(6).superRefine((columns, ctx) => {
  const seen = new Set<string>();
  for (const [index, column] of columns.entries()) {
    const normalized = column.toLocaleLowerCase();
    if (seen.has(normalized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'Data lab column labels must be unique.' });
    }
    seen.add(normalized);
  }
});

export const LessonDataLabSchema = z.object({
  title: z.string().trim().min(1).max(140),
  context: z.string().trim().min(1).max(400),
  columns: LessonDataLabColumnsSchema,
  rows: z.array(z.array(z.string().trim().min(1).max(160)).min(2).max(6)).min(2).max(10),
  prompts: z.array(z.string().trim().min(1).max(280)).min(2).max(4),
  workedReading: z.string().trim().min(1).max(1400),
}).superRefine((dataLab, ctx) => {
  for (const [index, row] of dataLab.rows.entries()) {
    if (row.length !== dataLab.columns.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rows', index],
        message: 'Each data lab row must contain one cell for every column.',
      });
    }
  }
});
export type LessonDataLab = z.infer<typeof LessonDataLabSchema>;

export const LessonMaterialSchema = z.object({
  lessonId: EntityIdSchema,
  title: z.string().min(1).max(160),
  overview: z.string().min(1).max(600),
  // `blocks` is retained for already-generated courses. New provider output uses
  // the renderer-backed `nodes` collection below.
  blocks: z.array(LessonBlockSchema).max(6).default([]),
  nodes: z.array(LessonNodeSchema).max(5).default([]),
  article: LessonArticleSchema.default({ sections: [] }),
  sources: z.array(LessonSourceSchema).max(6).default([]),
  keyTakeaway: z.string().min(1).max(280),
  reflectivePrompt: z.string().min(1).max(280),
  sourceNote: z.string().min(1).max(280),
  practice: LessonPracticeSchema.optional(),
  dataLab: LessonDataLabSchema.optional(),
}).superRefine((lesson, ctx) => {
  if (lesson.article.sections.length < 2 && lesson.blocks.length < 2 && lesson.nodes.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['article'], message: 'A lesson requires at least two article sections or renderable components.' });
  }
  const sourceIds = new Set<string>();
  for (const [index, source] of lesson.sources.entries()) {
    if (sourceIds.has(source.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', index, 'id'], message: 'Lesson source IDs must be unique.' });
    }
    sourceIds.add(source.id);
  }
  const citedSourceIds = new Set<string>();
  for (const [sectionIndex, section] of lesson.article.sections.entries()) {
    for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
      for (const match of paragraph.matchAll(/\[\[([^\]]+)\]\]/g)) {
        citedSourceIds.add(match[1]);
        if (!sourceIds.has(match[1])) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['article', 'sections', sectionIndex, 'paragraphs', paragraphIndex], message: `Citation ${match[1]} does not reference a lesson source.` });
        }
      }
    }
  }
});
export type LessonMaterial = z.infer<typeof LessonMaterialSchema>;

export function lessonNodeContext(node: LessonNode): string {
  switch (node.type) {
    case 'prose': return `${node.heading}: ${node.body}`;
    case 'example': return `${node.heading}: ${node.context} ${node.insight}`;
    case 'comparison': return `${node.heading}: ${node.rows.map((row) => `${row.criterion} ${row.left} / ${row.right}`).join('; ')}`;
    case 'scenario': return `${node.heading}: ${node.situation} ${node.reasoning}`;
    case 'flow': return `${node.heading}: ${node.sequence.map((step) => `${step.label} ${step.description}`).join('; ')} ${node.outcome}`;
    case 'timeline': return `${node.heading}: ${node.events.map((event) => `${event.label} ${event.description}`).join('; ')}`;
    case 'code': return `${node.heading}: ${node.explanation} ${node.bullets.join(' ')}`;
  }
}

export function lessonMaterialContext(material: Pick<LessonMaterial, 'nodes' | 'blocks' | 'article'>): string[] {
  return [
    ...material.article.sections.flatMap((section) => section.paragraphs.map((paragraph) => `${section.heading}: ${paragraph}`)),
    ...material.nodes.map(lessonNodeContext),
    ...material.blocks.map((block) => `${block.heading}: ${block.body}`),
  ];
}

export const QuizScopeSchema = z.enum(['lesson', 'chapter', 'course']);
export type QuizScope = z.infer<typeof QuizScopeSchema>;

export const QuizGenerationInputSchema = z.object({
  courseId: EntityIdSchema,
  scope: QuizScopeSchema,
  scopeId: EntityIdSchema,
  courseTitle: z.string(),
  topic: z.string(),
  scopeTitle: z.string(),
  materialContext: z.array(z.string()).max(80),
  courseMemory: z.array(z.string()).max(40),
});
export type QuizGenerationInput = z.infer<typeof QuizGenerationInputSchema>;

export const QuizRequestSchema = z.object({
  courseId: EntityIdSchema,
  scope: QuizScopeSchema,
  scopeId: EntityIdSchema,
});
export type QuizRequest = z.infer<typeof QuizRequestSchema>;

const QuizQuestionBaseSchema = z.object({
  id: EntityIdSchema,
  prompt: z.string().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(240)).min(3).max(5).superRefine((options, ctx) => {
    const seen = new Set<string>();
    for (const [index, option] of options.entries()) {
      const normalized = option.toLocaleLowerCase();
      if (seen.has(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'Quiz options must be unique.' });
      }
      seen.add(normalized);
    }
  }),
  answerIndex: z.number().int().min(0).max(4),
  explanation: z.string().min(1).max(500),
});

export const QuizQuestionSchema = QuizQuestionBaseSchema.superRefine((question, ctx) => {
  if (question.answerIndex >= question.options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answerIndex'], message: 'answerIndex must point to an option.' });
  }
});

const QuizQuestionsSchema = z.array(QuizQuestionSchema).min(2).max(8).superRefine((questions, ctx) => {
  const seen = new Set<string>();
  for (const [index, question] of questions.entries()) {
    if (seen.has(question.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'Quiz question IDs must be unique.' });
    }
    seen.add(question.id);
  }
  if (questions.length >= 3 && new Set(questions.map((question) => question.answerIndex)).size < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'Quiz answer positions must vary across questions.' });
  }
});

export const QuizSchema = z.object({
  id: EntityIdSchema,
  scope: QuizScopeSchema,
  scopeId: EntityIdSchema,
  title: z.string().min(1).max(180),
  instructions: z.string().min(1).max(400),
  questions: QuizQuestionsSchema,
});
export type Quiz = z.infer<typeof QuizSchema>;

export const QuizPublicQuestionSchema = QuizQuestionBaseSchema.omit({ answerIndex: true, explanation: true });
export const QuizPublicSchema = QuizSchema.omit({ questions: true }).extend({
  questions: z.array(QuizPublicQuestionSchema).min(2).max(8),
});
export type PublicQuiz = z.infer<typeof QuizPublicSchema>;

export const QuizReviewResultSchema = z.object({
  questionId: z.string(),
  correct: z.boolean(),
  answerIndex: z.number().int().min(0).max(4),
  explanation: z.string(),
});

export const QuizSubmissionSchema = z.object({
  answers: z.record(EntityIdSchema, z.number().int().min(0).max(4)),
});

export function createQuizSubmissionSchema(quiz: Quiz) {
  const questions = new Map(quiz.questions.map((question) => [question.id, question]));
  return QuizSubmissionSchema.superRefine((submission, ctx) => {
    for (const questionId of questions.keys()) {
      if (!(questionId in submission.answers)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers', questionId], message: 'Every quiz question requires an answer.' });
      }
    }
    for (const [questionId, answerIndex] of Object.entries(submission.answers)) {
      const question = questions.get(questionId);
      if (!question) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers', questionId], message: 'Answer references an unknown question.' });
      } else if (answerIndex >= question.options.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers', questionId], message: 'Answer index must point to an option.' });
      }
    }
  });
}

export const CourseStatusSchema = z.enum(['active', 'archived']);
export type CourseStatus = z.infer<typeof CourseStatusSchema>;

export const CoursePatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  status: CourseStatusSchema.optional(),
}).strict().refine((patch) => patch.title !== undefined || patch.status !== undefined, {
  message: 'At least one course field must be updated.',
});
export type CoursePatch = z.infer<typeof CoursePatchSchema>;

export const CourseLessonSchema = RoadmapLessonSchema.extend({
  sectionId: EntityIdSchema,
  material: LessonMaterialSchema.nullable(),
  completedAt: z.string().nullable(),
});
export type CourseLesson = z.infer<typeof CourseLessonSchema>;

export const CourseSectionSchema = RoadmapSectionSchema.omit({ lessons: true }).extend({
  lessons: z.array(CourseLessonSchema),
});
export type CourseSection = z.infer<typeof CourseSectionSchema>;

export const CourseSchema = z.object({
  id: EntityIdSchema,
  topic: z.string(),
  title: z.string(),
  description: z.string(),
  outcomes: z.array(z.string()),
  status: CourseStatusSchema,
  createdAt: z.string(),
  sections: z.array(CourseSectionSchema),
  progress: z.object({ completedLessons: z.number(), totalLessons: z.number(), percent: z.number() }),
});
export type Course = z.infer<typeof CourseSchema>;

export const ProductProgressSchema = z.object({
  updatedAt: z.string(),
  overall: z.number().min(0).max(100),
  comparisonBar: z.string(),
  currentComparison: z.object({
    target: z.string(),
    result: z.string(),
    evidence: z.string(),
  }),
  biggestGap: z.string(),
  latestResults: z.array(z.object({
    area: z.string(),
    status: z.enum(['pass', 'in-progress', 'gap']),
    result: z.string(),
    timestamp: z.string(),
  })),
});
export type ProductProgress = z.infer<typeof ProductProgressSchema>;

export const CreditProductSchema = z.object({
  id: EntityIdSchema,
  label: z.string().min(1).max(120),
  baseCredits: z.number().int().positive().max(1_000_000),
  bonusCredits: z.number().int().nonnegative().max(50),
  credits: z.number().int().positive().max(1_000_000),
  amountIdr: z.number().int().positive().max(100_000_000),
}).strict().superRefine((product, context) => {
  if (product.credits !== product.baseCredits + product.bonusCredits) {
    context.addIssue({ code: 'custom', path: ['credits'], message: 'Credits must equal base credits plus bonus credits.' });
  }
});
export type CreditProduct = z.infer<typeof CreditProductSchema>;

export const CreditTransactionSchema = z.object({
  id: EntityIdSchema,
  type: z.enum(['grant', 'topup', 'hold', 'refund', 'usage', 'adjustment']),
  delta: z.number().int(),
  description: z.string().min(1).max(180),
  createdAt: z.string(),
}).strict();
export type CreditTransaction = z.infer<typeof CreditTransactionSchema>;

export const CreditSummarySchema = z.object({
  balance: z.number().int().nonnegative(),
  unit: z.literal('credits'),
  currencyNote: z.string().min(1).max(180),
  provider: z.object({
    id: EntityIdSchema,
    displayName: z.string().min(1).max(120),
    model: z.string().min(1).max(120),
  }).strict(),
  products: z.array(CreditProductSchema).max(12),
  recentTransactions: z.array(CreditTransactionSchema).max(20),
}).strict();
export type CreditSummary = z.infer<typeof CreditSummarySchema>;

export const CreateTopUpInputSchema = z.object({
  productId: EntityIdSchema,
}).strict();
export type CreateTopUpInput = z.infer<typeof CreateTopUpInputSchema>;

export const TopUpResponseSchema = z.object({
  topUpId: EntityIdSchema,
  orderId: EntityIdSchema,
  product: CreditProductSchema,
  status: z.enum(['pending', 'paid', 'failed', 'expired']),
  snapToken: z.string().min(1),
  redirectUrl: z.string().url().optional(),
  clientKey: z.string().min(1),
  environment: z.enum(['sandbox', 'production']),
}).strict();
export type TopUpResponse = z.infer<typeof TopUpResponseSchema>;
