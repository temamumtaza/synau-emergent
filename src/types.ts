import type {
  AuthCodeResponse,
  Course,
  CourseLesson,
  CourseSection,
  LessonMaterial,
  LessonNode,
  LessonArticle,
  LessonArticleBlock,
  LessonSource,
  CreditSummary,
  RedeemCreditResponse,
  GoogleAuthResponse,
  TopUpResponse,
  ProductProgress,
  PublicQuiz as Quiz,
  QuizScope,
  Roadmap,
  User,
} from '../shared/schemas';

export type {
  AuthCodeResponse,
  Course,
  CourseLesson,
  CourseSection,
  LessonMaterial,
  LessonNode,
  LessonArticle,
  LessonArticleBlock,
  LessonSource,
  CreditSummary,
  RedeemCreditResponse,
  GoogleAuthResponse,
  TopUpResponse,
  ProductProgress,
  Quiz,
  QuizScope,
  Roadmap,
  User,
};

export type AuthResponse = {
  token: string;
  user: User;
};

export type QuizResult = {
  questionId: string;
  correct: boolean;
  answerIndex: number;
  explanation: string;
};

export type QuizSubmission = {
  score: number;
  results: QuizResult[];
  quiz: Quiz;
};

export type LessonWithSection = {
  lesson: CourseLesson;
  section: CourseSection;
};
