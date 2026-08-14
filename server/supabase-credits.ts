import crypto from 'node:crypto';
import { z } from 'zod';
import { getSupabaseAdmin } from './supabase.js';
import { remoteGetUserById } from './supabase-auth.js';
import { recordSupabaseQuery } from './performance.js';
import { createSnapToken, getMidtransTransactionStatus } from './midtrans.js';
import {
  CreditSummarySchema,
  CreditTransactionSchema,
  TopUpResponseSchema,
  type CreditProduct,
  type CreditSummary,
  type TopUpResponse,
} from '../shared/schemas.js';

const demoCredits = Math.max(0, Math.floor(Number(process.env.SYNAU_DEMO_CREDITS ?? 10_000)));
const GENERATOR_CREDIT_COST = 1;
const STALE_HOLD_RECOVERY_MS = 15 * 60 * 1_000;
const CREDIT_ENSURE_CACHE_MS = 30_000;
const REVIEWER_PROMO_CACHE_MS = 300_000;
export const REMOTE_NEW_USER_FREE_CREDITS = 100;
const REMOTE_PROMO_CREDITS = 1_500;
const ensuredCreditUsers = new Map<string, number>();
const ensuringCreditUsers = new Map<string, Promise<void>>();
let reviewerPromoReadyUntil = 0;
let reviewerPromoFlight: Promise<void> | undefined;

export const REMOTE_CREDIT_PRODUCTS: CreditProduct[] = [
  { id: 'topup-15000', label: '1.500 credits', baseCredits: 1_500, bonusCredits: 0, credits: 1_500, amountIdr: 15_000 },
  { id: 'topup-30000', label: '3.010 credits', baseCredits: 3_000, bonusCredits: 10, credits: 3_010, amountIdr: 30_000 },
  { id: 'topup-50000', label: '5.025 credits', baseCredits: 5_000, bonusCredits: 25, credits: 5_025, amountIdr: 50_000 },
  { id: 'topup-100000', label: '10.050 credits', baseCredits: 10_000, bonusCredits: 50, credits: 10_050, amountIdr: 100_000 },
];

export class RemoteCreditError extends Error {
  constructor(readonly status = 402, readonly code = 'credit_error', message = 'Credit operation failed.') {
    super(message);
    this.name = 'RemoteCreditError';
  }
}

async function read<T>(query: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>, kind: 'operation' | 'support' = 'support') {
  const startedAt = performance.now();
  let result: { data: T; error: { message: string; code?: string } | null };
  try {
    result = await query;
  } finally {
    recordSupabaseQuery(performance.now() - startedAt, kind);
  }
  if (result.error) throw new RemoteCreditError(502, 'supabase_credit_query_failed', result.error.message);
  return result.data;
}

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function providerSummary() {
  return {
    id: process.env.SYNAU_PROVIDER_ID ?? 'sumopod',
    displayName: process.env.SYNAU_PROVIDER_NAME ?? 'Sumopod',
    model: process.env.SYNAU_OPENAI_MODEL ?? 'deepseek-v4-flash',
  };
}

async function applyCreditDelta(args: {
  userId: string;
  delta: number;
  type: 'grant' | 'topup' | 'hold' | 'refund' | 'usage' | 'adjustment';
  referenceId: string;
  description: string;
  metadata?: unknown;
}) {
  try {
    return await read(getSupabaseAdmin().rpc('apply_credit_delta', {
      p_user_id: args.userId,
      p_delta: args.delta,
      p_type: args.type,
      p_reference_id: args.referenceId,
      p_description: args.description,
      p_metadata: args.metadata ?? null,
    }));
  } catch (error) {
    if (error instanceof Error && /Not enough credits/i.test(error.message)) {
      throw new RemoteCreditError(402, 'insufficient_credits', 'Not enough credits to run this generation.');
    }
    throw error;
  }
}

async function ensureReviewerPromoCode() {
  if (reviewerPromoReadyUntil > Date.now()) return;
  if (reviewerPromoFlight) return reviewerPromoFlight;
  reviewerPromoFlight = (async () => {
    const existing = await read(getSupabaseAdmin().from('credit_promo_codes').select('id').eq('active', true).eq('credits', REMOTE_PROMO_CREDITS).limit(1).maybeSingle<{ id: string }>());
    if (!existing) {
      const token = `SYN-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
      await read(getSupabaseAdmin().from('credit_promo_codes').insert({ id: uuid(), token, credits: REMOTE_PROMO_CREDITS, active: true, max_redemptions: 1, redeemed_count: 0, created_at: now() }));
    }
    reviewerPromoReadyUntil = Date.now() + REVIEWER_PROMO_CACHE_MS;
  })().finally(() => { reviewerPromoFlight = undefined; });
  return reviewerPromoFlight;
}

async function ensureCreditsUncached(userId: string) {
  await ensureReviewerPromoCode();
  await read(getSupabaseAdmin().from('credit_accounts').upsert({ user_id: userId, balance: 0, updated_at: now() }, { onConflict: 'user_id', ignoreDuplicates: true }));
  const [user, staleHolds] = await Promise.all([
    remoteGetUserById(userId),
    read(getSupabaseAdmin().from('credit_ledger')
      .select('reference_id, created_at')
      .eq('user_id', userId)
      .eq('type', 'hold')
      .like('reference_id', 'llm:%:hold')
      .lt('created_at', new Date(Date.now() - STALE_HOLD_RECOVERY_MS).toISOString())),
  ]);
  if (user?.email === 'demo@synau.local' && demoCredits > 0) {
    await applyCreditDelta({ userId, delta: demoCredits, type: 'grant', referenceId: 'demo-initial-grant', description: 'Demo account starting credits', metadata: { credits: demoCredits, amountIdr: 100_000 } });
  }
  const typedStaleHolds = staleHolds as Array<{ reference_id: string; created_at: string }>;
  const generationIds = typedStaleHolds.flatMap((hold) => {
    const match = /^llm:(.+):hold$/.exec(hold.reference_id);
    return match ? [match[1]] : [];
  });
  if (!generationIds.length) return;

  const [usageRows, refundRows] = await Promise.all([
    read(getSupabaseAdmin().from('llm_usage').select('generation_id').eq('user_id', userId).in('generation_id', generationIds)),
    read(getSupabaseAdmin().from('credit_ledger').select('reference_id').eq('user_id', userId).in('reference_id', generationIds.flatMap((id) => [`llm:${id}:refund`, `llm:${id}:recovery`]))),
  ]);
  const settledGenerationIds = new Set((usageRows as Array<{ generation_id: string }>).map((row) => row.generation_id));
  const recoveredReferences = new Set((refundRows as Array<{ reference_id: string }>).map((row) => row.reference_id));
  for (const hold of typedStaleHolds) {
    const match = /^llm:(.+):hold$/.exec(hold.reference_id);
    if (!match || settledGenerationIds.has(match[1]) || recoveredReferences.has(`llm:${match[1]}:refund`) || recoveredReferences.has(`llm:${match[1]}:recovery`)) continue;
    await applyCreditDelta({ userId, delta: GENERATOR_CREDIT_COST, type: 'refund', referenceId: `llm:${match[1]}:recovery`, description: 'Returned a stale generation reservation', metadata: { generationId: match[1], recoveredFrom: hold.created_at, reason: 'stale_hold_recovery' } });
  }
}

async function ensureCredits(userId: string) {
  const cachedUntil = ensuredCreditUsers.get(userId);
  if (cachedUntil && cachedUntil > Date.now()) return;
  if (cachedUntil) ensuredCreditUsers.delete(userId);
  const existingFlight = ensuringCreditUsers.get(userId);
  if (existingFlight) return existingFlight;
  const flight = ensureCreditsUncached(userId)
    .then(() => { ensuredCreditUsers.set(userId, Date.now() + CREDIT_ENSURE_CACHE_MS); })
    .finally(() => { ensuringCreditUsers.delete(userId); });
  ensuringCreditUsers.set(userId, flight);
  return flight;
}

export async function remoteRedeemCreditToken(userId: string, rawToken: string) {
  const token = rawToken.trim().toUpperCase();
  if (!token) throw new RemoteCreditError(400, 'invalid_redeem_token', 'Enter a redeem token.');
  await ensureCredits(userId);
  const promo = await read(getSupabaseAdmin().from('credit_promo_codes').select('id, credits, max_redemptions, redeemed_count').eq('token', token).eq('active', true).maybeSingle<{ id: string; credits: number; max_redemptions: number; redeemed_count: number }>());
  if (!promo) throw new RemoteCreditError(400, 'invalid_redeem_token', 'This redeem token is invalid or inactive.');
  const existing = await read(getSupabaseAdmin().from('credit_promo_redemptions').select('id').eq('promo_code_id', promo.id).eq('user_id', userId).maybeSingle<{ id: string }>());
  if (existing) {
    const account = await read(getSupabaseAdmin().from('credit_accounts').select('balance').eq('user_id', userId).single<{ balance: number }>());
    if (!account) throw new RemoteCreditError(503, 'credit_account_unavailable', 'Credit account is temporarily unavailable.');
    return { creditsAdded: 0, alreadyRedeemed: true, balance: account.balance };
  }
  if (promo.redeemed_count >= promo.max_redemptions) throw new RemoteCreditError(409, 'redeem_token_exhausted', 'This redeem token has already been claimed.');
  const redemptionId = uuid();
  await read(getSupabaseAdmin().from('credit_promo_redemptions').insert({ id: redemptionId, promo_code_id: promo.id, user_id: userId, credits: promo.credits, created_at: now() }));
  await read(getSupabaseAdmin().from('credit_promo_codes').update({ redeemed_count: promo.redeemed_count + 1 }).eq('id', promo.id));
  await applyCreditDelta({ userId, delta: promo.credits, type: 'grant', referenceId: `promo:${redemptionId}:credit`, description: `Redeem token credit grant (${promo.credits.toLocaleString('id-ID')} credits)`, metadata: { redemptionId, promoCodeId: promo.id } });
  const account = await read(getSupabaseAdmin().from('credit_accounts').select('balance').eq('user_id', userId).single<{ balance: number }>());
  if (!account) throw new RemoteCreditError(503, 'credit_account_unavailable', 'Credit account is temporarily unavailable.');
  ensuredCreditUsers.delete(userId);
  return { creditsAdded: promo.credits, alreadyRedeemed: false, balance: account.balance };
}

export async function remoteGrantCredits(args: { userId: string; credits: number; referenceId: string; description: string; type?: 'grant' | 'topup' | 'adjustment'; metadata?: unknown }) {
  if (!Number.isInteger(args.credits) || args.credits <= 0) throw new RemoteCreditError(400, 'invalid_credit_grant', 'Credit grant must be a positive integer.');
  await applyCreditDelta({ ...args, delta: args.credits, type: args.type ?? 'adjustment' });
}

export async function remoteGrantNewUserCredits(userId: string) {
  return remoteGrantCredits({ userId, credits: REMOTE_NEW_USER_FREE_CREDITS, referenceId: 'new-user-welcome-100', description: 'Welcome credits for a new account', type: 'grant', metadata: { credits: REMOTE_NEW_USER_FREE_CREDITS, source: 'new-user-welcome' } });
}

export async function remoteGetCreditSummary(userId: string): Promise<CreditSummary> {
  const summary = await read(getSupabaseAdmin().rpc('get_credit_summary_json', { p_user_id: userId }), 'operation') as {
    balance?: unknown;
    recentTransactions?: unknown;
  } | null;
  if (!summary || typeof summary.balance !== 'number' || !Array.isArray(summary.recentTransactions)) {
    throw new RemoteCreditError(503, 'credit_account_unavailable', 'Credit account is temporarily unavailable.');
  }
  return CreditSummarySchema.parse({
    balance: summary.balance,
    unit: 'credits',
    currencyNote: '1 generator = 1 credit. Top-ups use 100 credits per Rp1.000 plus up to 50 bonus credits. New accounts receive 100 free credits.',
    provider: providerSummary(),
    products: REMOTE_CREDIT_PRODUCTS,
    recentTransactions: (summary.recentTransactions as Array<{ id?: unknown; type?: unknown; delta?: unknown; description?: unknown; createdAt?: unknown }>).map((row) => CreditTransactionSchema.parse({ id: row.id, type: row.type, delta: row.delta, description: row.description, createdAt: row.createdAt })),
  });
}

export type RemoteProviderUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number };

function nonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function parseUsage(payload: unknown): RemoteProviderUsage | null {
  if (!payload || typeof payload !== 'object') return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  const promptTokens = nonNegativeInteger(record.prompt_tokens ?? record.input_tokens);
  const outputTokens = nonNegativeInteger(record.completion_tokens ?? record.output_tokens);
  const details = record.prompt_tokens_details ?? record.input_tokens_details;
  const cachedInputTokens = details && typeof details === 'object'
    ? nonNegativeInteger((details as Record<string, unknown>).cached_tokens ?? (details as Record<string, unknown>).cache_read_input_tokens)
    : nonNegativeInteger(record.cached_tokens ?? record.cache_read_input_tokens);
  const totalTokens = nonNegativeInteger(record.total_tokens) || promptTokens + outputTokens;
  if (promptTokens + outputTokens + totalTokens <= 0) return null;
  return { inputTokens: promptTokens, cachedInputTokens, outputTokens, totalTokens };
}

export class RemoteLlmBilling {
  readonly generationId = uuid();
  private readonly usages: RemoteProviderUsage[] = [];

  constructor(readonly userId: string, readonly generator: string, readonly providerId: string, readonly model: string, readonly holdCredits: number) {}

  addUsage(usage: RemoteProviderUsage | null | undefined) {
    if (usage) this.usages.push(usage);
  }

  async finish(status: 'success' | 'failed') {
    const usage = this.usages.reduce<RemoteProviderUsage>((total, item) => ({
      inputTokens: total.inputTokens + Math.max(0, Math.floor(item.inputTokens || 0)),
      cachedInputTokens: total.cachedInputTokens + Math.max(0, Math.floor(item.cachedInputTokens || 0)),
      outputTokens: total.outputTokens + Math.max(0, Math.floor(item.outputTokens || 0)),
      totalTokens: total.totalTokens + Math.max(0, Math.floor(item.totalTokens || 0)),
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const calculatedCost = status === 'success' ? GENERATOR_CREDIT_COST : 0;
    await read(getSupabaseAdmin().rpc('record_llm_usage', {
      p_id: uuid(), p_user_id: this.userId, p_generation_id: this.generationId,
      p_generator: this.generator, p_provider_id: this.providerId, p_model: this.model,
      p_input_tokens: usage.inputTokens, p_cached_input_tokens: usage.cachedInputTokens,
      p_output_tokens: usage.outputTokens, p_total_tokens: usage.totalTokens,
      p_request_count: this.usages.length, p_credit_cost: calculatedCost,
      p_status: status, p_hold_credits: this.holdCredits,
      p_metadata: { generator: this.generator, providerId: this.providerId, model: this.model, requestCount: this.usages.length, pricing: 'one-credit-per-successful-generator', calculatedCost, holdCredits: this.holdCredits, underHeld: calculatedCost > this.holdCredits },
    }));
  }
}

export async function beginRemoteLlmBilling(userId: string, generator: string, providerId: string, model: string) {
  await ensureCredits(userId);
  const billing = new RemoteLlmBilling(userId, generator, providerId, model, GENERATOR_CREDIT_COST);
  await applyCreditDelta({ userId, delta: -GENERATOR_CREDIT_COST, type: 'hold', referenceId: `llm:${billing.generationId}:hold`, description: `Reserved credits for ${generator}`, metadata: { generator, providerId, model, holdCredits: GENERATOR_CREDIT_COST, pricing: 'one-credit-per-successful-generator' } });
  return billing;
}

const MidtransNotificationSchema = z.object({
  order_id: z.string().trim().min(1).max(100), status_code: z.coerce.string().trim().min(1).max(10), gross_amount: z.coerce.string().trim().min(1).max(40), signature_key: z.string().trim().min(1).max(200).optional(), transaction_status: z.string().trim().min(1).max(40), fraud_status: z.string().trim().max(40).optional(), transaction_id: z.string().trim().max(100).optional(), payment_type: z.string().trim().max(80).optional(),
}).passthrough();

function validSignature(orderId: string, statusCode: string, grossAmount: string, signature: string) {
  const serverKey = process.env.SYNAU_MIDTRANS_SERVER_KEY ?? '';
  if (!serverKey) return false;
  const expected = crypto.createHash('sha512').update(`${orderId}${statusCode}${grossAmount}${serverKey}`).digest('hex');
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function statusFromNotification(transactionStatus: string, fraudStatus?: string) {
  const normalized = transactionStatus.toLowerCase();
  if (normalized === 'settlement' || (normalized === 'capture' && (fraudStatus ?? '').toLowerCase() === 'accept')) return 'paid' as const;
  if (['deny', 'cancel', 'expire', 'failure'].includes(normalized)) return normalized === 'expire' ? 'expired' as const : 'failed' as const;
  return 'pending' as const;
}

async function applyTopUpStatus(payload: unknown, requireSignature: boolean) {
  const parsed = MidtransNotificationSchema.parse(payload);
  if (requireSignature && (!parsed.signature_key || !validSignature(parsed.order_id, parsed.status_code, parsed.gross_amount, parsed.signature_key))) throw new RemoteCreditError(400, 'invalid_midtrans_signature', 'Invalid Midtrans notification signature.');
  const topUp = await read(getSupabaseAdmin().from('credit_topups').select('*').eq('order_id', parsed.order_id).maybeSingle<{ id: string; user_id: string; credits: number; amount_idr: number; status: 'pending' | 'paid' | 'failed' | 'expired' }>());
  if (!topUp) return { matched: false as const, status: 'unknown' as const };
  if (Math.round(Number(parsed.gross_amount)) !== topUp.amount_idr) throw new RemoteCreditError(400, 'midtrans_amount_mismatch', 'Midtrans amount does not match the pending top-up.');
  const nextStatus = statusFromNotification(parsed.transaction_status, parsed.fraud_status);
  await read(getSupabaseAdmin().from('credit_topups').update({ status: nextStatus, midtrans_transaction_id: parsed.transaction_id ?? null, payment_type: parsed.payment_type ?? null, raw_json: parsed, updated_at: now(), ...(nextStatus === 'paid' ? { settled_at: now() } : {}) }).eq('id', topUp.id));
  if (nextStatus === 'paid' && topUp.status !== 'paid') await applyCreditDelta({ userId: topUp.user_id, delta: topUp.credits, type: 'topup', referenceId: `topup:${topUp.id}:credit`, description: `Top-up ${topUp.credits.toLocaleString('id-ID')} credits`, metadata: { topUpId: topUp.id, orderId: parsed.order_id, amountIdr: topUp.amount_idr } });
  return { matched: true as const, topUpId: topUp.id, status: nextStatus };
}

export async function remoteHandleMidtransNotification(payload: unknown) {
  return applyTopUpStatus(payload, true);
}

export async function remoteCreateCreditTopUp(userId: string, productId: string): Promise<TopUpResponse> {
  const product = REMOTE_CREDIT_PRODUCTS.find((candidate) => candidate.id === productId);
  if (!product) throw new RemoteCreditError(400, 'unknown_credit_product', 'This credit package is not available.');
  const user = await remoteGetUserById(userId);
  if (!user) throw new RemoteCreditError(404, 'user_not_found', 'User not found.');
  const topUpId = uuid();
  const orderId = `synau-${Date.now()}-${topUpId.replaceAll('-', '').slice(0, 14)}`;
  await read(getSupabaseAdmin().from('credit_topups').insert({ id: topUpId, user_id: userId, order_id: orderId, product_id: product.id, credits: product.credits, amount_idr: product.amountIdr, status: 'pending', created_at: now(), updated_at: now() }));
  try {
    const snap = await createSnapToken({ orderId, grossAmount: product.amountIdr, customerName: user.name, customerEmail: user.email });
    await read(getSupabaseAdmin().from('credit_topups').update({ snap_token: snap.token, redirect_url: snap.redirectUrl ?? null, updated_at: now() }).eq('id', topUpId));
    return TopUpResponseSchema.parse({ topUpId, orderId, product, status: 'pending', snapToken: snap.token, ...(snap.redirectUrl ? { redirectUrl: snap.redirectUrl } : {}), clientKey: process.env.SYNAU_MIDTRANS_CLIENT_KEY ?? '', environment: process.env.SYNAU_MIDTRANS_PRODUCTION === 'true' ? 'production' : 'sandbox' });
  } catch (error) {
    await read(getSupabaseAdmin().from('credit_topups').update({ status: 'failed', updated_at: now() }).eq('id', topUpId));
    throw error;
  }
}

export async function remoteSyncCreditTopUp(userId: string, topUpId: string) {
  const row = await read(getSupabaseAdmin().from('credit_topups').select('id, order_id, status').eq('id', topUpId).eq('user_id', userId).maybeSingle<{ id: string; order_id: string; status: 'pending' | 'paid' | 'failed' | 'expired' }>());
  if (!row) throw new RemoteCreditError(404, 'topup_not_found', 'Top-up not found.');
  if (row.status === 'paid') return { topUpId: row.id, status: row.status };
  return applyTopUpStatus(await getMidtransTransactionStatus(row.order_id), false);
}

export function remoteBillingStatusCode(error: unknown) {
  if (!(error instanceof RemoteCreditError)) return null;
  const message = error.code === 'supabase_credit_query_failed'
    ? 'Credit service is temporarily unavailable.'
    : error.message;
  return { status: error.status, body: { error: message, code: error.code } };
}
