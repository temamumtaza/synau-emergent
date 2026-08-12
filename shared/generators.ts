export const generatorTools = {
  roadmap: {
    name: 'build_learning_roadmap',
    description: 'Create a focused, sequential learning roadmap for a topic. Return only the structured tool arguments.',
  },
  lesson: {
    name: 'write_subchapter_lesson',
    description: 'Write one concise learning subchapter, using course memory to avoid repeating previously covered material.',
  },
  quiz: {
    name: 'write_repeatable_quiz',
    description: 'Write a repeatable assessment for a lesson, chapter, or course. Return only the structured tool arguments.',
  },
} as const;

export type GeneratorKey = keyof typeof generatorTools;
