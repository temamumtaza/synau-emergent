export const generatorTools = {
  roadmap: {
    name: 'build_learning_roadmap',
    description: 'Create a focused, sequential learning roadmap for a topic. Return only the structured tool arguments.',
  },
  lesson: {
    name: 'write_subchapter_lesson',
    description: 'Write one substantial, natural Markdown learning article for a subchapter. Teach one distinct outcome, use course memory to avoid repetition, choose a fitting structure, and preserve relevant resources without forcing a template.',
  },
  quiz: {
    name: 'write_repeatable_quiz',
    description: 'Write a repeatable assessment for a lesson, chapter, or course. Return only the structured tool arguments.',
  },
} as const;

export type GeneratorKey = keyof typeof generatorTools;
