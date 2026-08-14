import 'dotenv/config';
import { RoadmapSchema } from '../shared/schemas.js';
import { newId } from './utils.js';
import { assertSupabaseRuntime, getSupabaseAdmin } from './supabase.js';
import { remoteGetUserByLoginIdentifier } from './supabase-auth.js';
import { remoteGrantNewUserCredits } from './supabase-credits.js';
import { remoteCreateCourse } from './supabase-store.js';

assertSupabaseRuntime();

const email = (process.env.SYNAU_SEED_EMAIL ?? '').trim().toLowerCase();
if (!email) throw new Error('Set SYNAU_SEED_EMAIL to an existing Google-linked Synau profile.');

const user = await remoteGetUserByLoginIdentifier(email);
if (!user) throw new Error(`Supabase profile not found for ${email}. Sign in with Google once before seeding.`);

await remoteGrantNewUserCredits(user.id);

const existing = (await getSupabaseAdmin()
  .from('courses')
  .select('id')
  .eq('user_id', user.id)
  .eq('topic', 'Supabase seeded workflow')
  .limit(1)
  .maybeSingle()).data as { id: string } | null;

const roadmap = RoadmapSchema.parse({
  title: 'Supabase seeded workflow',
  description: 'A small remote course used to verify the complete lazy-learning workflow.',
  topic: 'Supabase seeded workflow',
  language: 'id',
  outcomes: [
    'Review and approve a learning roadmap',
    'Generate a lesson only when it is opened',
    'Complete a repeatable quiz without gating progress',
  ],
  sections: [
    {
      id: newId(),
      title: 'Fondasi alur belajar',
      summary: 'Memahami bagaimana roadmap berubah menjadi ruang belajar yang bisa dijalankan.',
      position: 0,
      lessons: [
        { id: newId(), title: 'Dari topik ke roadmap', summary: 'Membaca struktur dan tujuan sebuah learning path.', estimatedMinutes: 12, position: 0 },
        { id: newId(), title: 'Membuka materi saat dibutuhkan', summary: 'Memahami prinsip lazy lesson generation.', estimatedMinutes: 15, position: 1 },
      ],
    },
    {
      id: newId(),
      title: 'Menerapkan dan menguji pemahaman',
      summary: 'Menggunakan artikel, progres, dan kuis untuk membangun pemahaman yang bertahan.',
      position: 1,
      lessons: [
        { id: newId(), title: 'Membaca artikel secara aktif', summary: 'Menghubungkan konsep, contoh, dan pertanyaan.', estimatedMinutes: 15, position: 0 },
        { id: newId(), title: 'Mengulang dengan kuis', summary: 'Menguji pemahaman tanpa mengunci progres.', estimatedMinutes: 12, position: 1 },
      ],
    },
  ],
});

const course = existing ? null : await remoteCreateCourse(user.id, roadmap);
console.log(JSON.stringify({
  seeded: true,
  storage: 'supabase',
  email,
  userId: user.id,
  courseId: course?.id ?? existing?.id ?? null,
  courseAlreadyExisted: Boolean(existing),
}, null, 2));
