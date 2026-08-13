import crypto from 'node:crypto';
import { z } from 'zod';
import { db, json, newId, nowIso } from './db.js';
import { getUserById } from './auth.js';
import { createSnapToken, getMidtransTransactionStatus } from './midtrans.js';
import {
  CreditSummarySchema,
  CreditTransactionSchema,
  RedeemCreditResponseSchema,
  TopUpResponseSchema,
  type CreditProduct,
  type CreditSummary,
  type TopUpResponse,
} from '../shared/schemas.js';

const demoCredits = Math.max(0, Math.floor(Number(process.env.SYNAU_DEMO_CREDITS ?? 10_000)));
const GENERATOR_CREDIT_COST = 1;
const STALE_HOLD_RECOVERY_MS = 15 * 60 * 1_000;
export const NEW_USER_FREE_CREDITS = 100;
const PROMO_CREDITS = 1_500;

export const CREDIT_PRODUCTS: CreditProduct[] = [
  { id: 'topup-15000', label: '1.500 credits', baseCredits: 1_500, bonusCredits: 0, credits: 1_500, amountIdr: 15_000 },
  { id: 'topup-30000', label: '3.010 credits', baseCredits: 3_000, bonusCredits: 10, credits: 3_010, amountIdr: 30_000 },
  { id: 'topup-50000', label: '5.025 credits', baseCredits: 5_000, bonusCredits: 25, credits: 5_025, amountIdr: 50_000 },
  { id: 'topup-100000', label: '10.050 credits', baseCredits: 10_000, bonusCredits: 50, credits: 10_050, amountIdr: 100_000 },
];

export class CreditError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 402, code = 'credit_error') {
    super(message);
    this.name = 'CreditError';
    this.status = status;
    this.code = code;
  }
}

type CreditLedgerType = 'grant' | 'topup' | 'hold' | 'refund' | 'usage' | 'adjustment';

function providerSummary() {
  return {
    id: process.env.SYNAU_PROVIDER_ID ?? 'sumopod',
    displayName: process.env.SYNAU_PROVIDER_NAME ?? 'Sumopod',
    model: process.env.SYNAU_OPENAI_MODEL ?? 'deepseek-v4-flash',
  };
}

function ensureAccountTx(userId: string) {
  db.prepare(`INSERT OR IGNORE INTO credit_accounts (user_id, balance, updated_at) VALUES (?, 0, ?)`)
    .run(userId, nowIso());
}

function ensureReviewerPromoCode() {
  const existing = db.prepare('SELECT id FROM credit_promo_codes WHERE active = 1 AND credits = ? LIMIT 1').get(PROMO_CREDITS) as { id: string } | undefined;
  if (existing) return;
  const token = `SYN-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  db.prepare(`INSERT INTO credit_promo_codes (id, token, credits, active, max_redemptions, redeemed_count, created_at)
    VALUES (?, ?, ?, 1, 1, 0, ?)`).run(newId(), token, PROMO_CREDITS, nowIso());
}

function applyCreditDeltaTx(args: {
  userId: string;
  delta: number;
  type: CreditLedgerType;
  referenceId: string;
  description: string;
  metadata?: unknown;
}) {
  ensureAccountTx(args.userId);
  const existing = db.prepare('SELECT id FROM credit_ledger WHERE user_id = ? AND reference_id = ?')
    .get(args.userId, args.referenceId) as { id: string } | undefined;
  if (existing) return false;

  const account = db.prepare('SELECT balance FROM credit_accounts WHERE user_id = ?')
    .get(args.userId) as { balance: number };
  const nextBalance = account.balance + args.delta;
  if (nextBalance < 0) {
    throw new CreditError('Not enough credits to run this generation.', 402, 'insufficient_credits');
  }

  const createdAt = nowIso();
  db.prepare('UPDATE credit_accounts SET balance = ?, updated_at = ? WHERE user_id = ?')
    .run(nextBalance, createdAt, args.userId);
  db.prepare(`INSERT INTO credit_ledger
    (id, user_id, type, delta, reference_id, description, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId(), args.userId, args.type, args.delta, args.referenceId, args.description, args.metadata ? json(args.metadata) : null, createdAt);
  return true;
}

function ensureDemoGrant(userId: string) {
  const user = getUserById(userId);
  if (!user || user.email !== 'demo@synau.local' || demoCredits <= 0) return;
  db.transaction(() => {
    applyCreditDeltaTx({
      userId,
      delta: demoCredits,
      type: 'grant',
      referenceId: 'demo-initial-grant',
      description: 'Demo account starting credits',
      metadata: { credits: demoCredits, amountIdr: 100_000 },
    });
  })();
}

function recoverStaleLlmHolds(userId: string) {
  const cutoff = new Date(Date.now() - STALE_HOLD_RECOVERY_MS).toISOString();
  const holds = db.prepare(`SELECT reference_id, created_at
    FROM credit_ledger
    WHERE user_id = ? AND type = 'hold' AND reference_id LIKE 'llm:%:hold' AND created_at < ?`).all(userId, cutoff) as Array<{
      reference_id: string;
      created_at: string;
    }>;
  for (const hold of holds) {
    const match = /^llm:(.+):hold$/.exec(hold.reference_id);
    if (!match) continue;
    const generationId = match[1];
    const settled = db.prepare('SELECT id, status FROM llm_usage WHERE user_id = ? AND generation_id = ?')
      .get(userId, generationId) as { id: string; status: 'success' | 'failed' } | undefined;
    const refunded = db.prepare('SELECT id FROM credit_ledger WHERE user_id = ? AND reference_id IN (?, ?)')
      .get(userId, `llm:${generationId}:refund`, `llm:${generationId}:recovery`) as { id: string } | undefined;
    if (settled?.status === 'success' || refunded) continue;
    db.transaction(() => {
      applyCreditDeltaTx({
        userId,
        delta: GENERATOR_CREDIT_COST,
        type: 'refund',
        referenceId: `llm:${generationId}:recovery`,
        description: 'Returned a stale generation reservation',
        metadata: { generationId, recoveredFrom: hold.created_at, reason: 'stale_hold_recovery' },
      });
    })();
  }
}

export function grantCredits(args: {
  userId: string;
  credits: number;
  referenceId: string;
  description: string;
  type?: Extract<CreditLedgerType, 'grant' | 'topup' | 'adjustment'>;
  metadata?: unknown;
}) {
  if (!Number.isInteger(args.credits) || args.credits <= 0) {
    throw new CreditError('Credit grant must be a positive integer.', 400, 'invalid_credit_grant');
  }
  ensureCredits(args.userId);
  db.transaction(() => {
    applyCreditDeltaTx({
      userId: args.userId,
      delta: args.credits,
      type: args.type ?? 'adjustment',
      referenceId: args.referenceId,
      description: args.description,
      metadata: args.metadata,
    });
  })();
}

export function grantNewUserCredits(userId: string) {
  grantCredits({
    userId,
    credits: NEW_USER_FREE_CREDITS,
    referenceId: 'new-user-welcome-100',
    description: 'Welcome credits for a new account',
    type: 'grant',
    metadata: { credits: NEW_USER_FREE_CREDITS, source: 'new-user-welcome' },
  });
}

export function ensureCredits(userId: string) {
  ensureReviewerPromoCode();
  db.transaction(() => {
    ensureAccountTx(userId);
  })();
  recoverStaleLlmHolds(userId);
  ensureDemoGrant(userId);
}

export function redeemCreditToken(userId: string, rawToken: string) {
  const token = rawToken.trim().toUpperCase();
  if (!token) throw new CreditError('Enter a redeem token.', 400, 'invalid_redeem_token');
  ensureCredits(userId);
  return db.transaction(() => {
    const promo = db.prepare(`SELECT id, credits, max_redemptions, redeemed_count
      FROM credit_promo_codes WHERE token = ? AND active = 1`).get(token) as {
        id: string; credits: number; max_redemptions: number; redeemed_count: number;
      } | undefined;
    if (!promo) throw new CreditError('This redeem token is invalid or inactive.', 400, 'invalid_redeem_token');
    const already = db.prepare('SELECT id FROM credit_promo_redemptions WHERE promo_code_id = ? AND user_id = ?')
      .get(promo.id, userId) as { id: string } | undefined;
    if (already) {
      const balance = (db.prepare('SELECT balance FROM credit_accounts WHERE user_id = ?').get(userId) as { balance: number }).balance;
      return RedeemCreditResponseSchema.parse({ creditsAdded: 0, alreadyRedeemed: true, balance });
    }
    if (promo.redeemed_count >= promo.max_redemptions) throw new CreditError('This redeem token has already been claimed.', 409, 'redeem_token_exhausted');
    const redemptionId = newId();
    db.prepare(`INSERT INTO credit_promo_redemptions (id, promo_code_id, user_id, credits, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(redemptionId, promo.id, userId, promo.credits, nowIso());
    db.prepare('UPDATE credit_promo_codes SET redeemed_count = redeemed_count + 1 WHERE id = ?').run(promo.id);
    applyCreditDeltaTx({
      userId,
      delta: promo.credits,
      type: 'grant',
      referenceId: `promo:${redemptionId}:credit`,
      description: `Redeem token credit grant (${promo.credits.toLocaleString('id-ID')} credits)`,
      metadata: { redemptionId, promoCodeId: promo.id },
    });
    const balance = (db.prepare('SELECT balance FROM credit_accounts WHERE user_id = ?').get(userId) as { balance: number }).balance;
    return RedeemCreditResponseSchema.parse({ creditsAdded: promo.credits, alreadyRedeemed: false, balance });
  })();
}

function currentBalance(userId: string) {
  ensureCredits(userId);
  return (db.prepare('SELECT balance FROM credit_accounts WHERE user_id = ?').get(userId) as { balance: number }).balance;
}

export function getCreditSummary(userId: string): CreditSummary {
  const balance = currentBalance(userId);
  const rows = db.prepare(`SELECT id, type, delta, description, created_at
    FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(userId) as Array<{
      id: string;
      type: CreditLedgerType;
      delta: number;
      description: string;
      created_at: string;
    }>;
  return CreditSummarySchema.parse({
    balance,
    unit: 'credits',
    currencyNote: '1 generator = 1 credit. Top-ups use 100 credits per Rp1.000 plus up to 50 bonus credits. New accounts receive 100 free credits.',
    provider: providerSummary(),
    products: CREDIT_PRODUCTS,
    recentTransactions: rows.map((row) => CreditTransactionSchema.parse({
      id: row.id,
      type: row.type,
      delta: row.delta,
      description: row.description,
      createdAt: row.created_at,
    })),
  });
}

export type ProviderUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

function nonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export class LlmBilling {
  readonly generationId = newId();
  private readonly usages: ProviderUsage[] = [];

  constructor(
    readonly userId: string,
    readonly generator: string,
    readonly providerId: string,
    readonly model: string,
    readonly holdCredits: number,
  ) {}

  addUsage(usage: ProviderUsage | null | undefined) {
    if (usage) this.usages.push(usage);
  }

  finish(status: 'success' | 'failed') {
    const usage = this.usages.reduce<ProviderUsage>((total, item) => ({
      inputTokens: total.inputTokens + nonNegativeInteger(item.inputTokens),
      cachedInputTokens: total.cachedInputTokens + nonNegativeInteger(item.cachedInputTokens),
      outputTokens: total.outputTokens + nonNegativeInteger(item.outputTokens),
      totalTokens: total.totalTokens + nonNegativeInteger(item.totalTokens),
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const calculatedCost = status === 'success' ? GENERATOR_CREDIT_COST : 0;
    const settledCost = Math.min(calculatedCost, this.holdCredits);
    const refund = this.holdCredits - settledCost;
    const underHeld = calculatedCost > this.holdCredits;
    const metadata = {
      generator: this.generator,
      providerId: this.providerId,
      model: this.model,
      requestCount: this.usages.length,
      pricing: 'one-credit-per-successful-generator',
      calculatedCost,
      holdCredits: this.holdCredits,
      underHeld,
    };

    db.transaction(() => {
      if (refund > 0) {
        applyCreditDeltaTx({
          userId: this.userId,
          delta: refund,
          type: 'refund',
          referenceId: `llm:${this.generationId}:refund`,
          description: status === 'success' ? 'Unused generation credit hold returned' : 'Failed generation credit hold returned',
          metadata,
        });
      }
      db.prepare(`INSERT INTO llm_usage
        (id, user_id, generation_id, generator, provider_id, model, input_tokens, cached_input_tokens,
          output_tokens, total_tokens, request_count, credit_cost, status, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId(), this.userId, this.generationId, this.generator, this.providerId, this.model,
          usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.totalTokens,
          this.usages.length, settledCost, status, json(metadata), nowIso());
    })();
  }
}

export function beginLlmBilling(userId: string, generator: string, providerId: string, model: string) {
  ensureCredits(userId);
  const billing = new LlmBilling(userId, generator, providerId, model, GENERATOR_CREDIT_COST);
  db.transaction(() => {
    applyCreditDeltaTx({
      userId,
      delta: -GENERATOR_CREDIT_COST,
      type: 'hold',
      referenceId: `llm:${billing.generationId}:hold`,
      description: `Reserved credits for ${generator}`,
      metadata: { generator, providerId, model, holdCredits: GENERATOR_CREDIT_COST, pricing: 'one-credit-per-successful-generator' },
    });
  })();
  return billing;
}

const MidtransNotificationSchema = z.object({
  order_id: z.string().trim().min(1).max(100),
  status_code: z.coerce.string().trim().min(1).max(10),
  gross_amount: z.coerce.string().trim().min(1).max(40),
  signature_key: z.string().trim().min(1).max(200).optional(),
  transaction_status: z.string().trim().min(1).max(40),
  fraud_status: z.string().trim().max(40).optional(),
  transaction_id: z.string().trim().max(100).optional(),
  payment_type: z.string().trim().max(80).optional(),
}).passthrough();

function validSignature(orderId: string, statusCode: string, grossAmount: string, signature: string) {
  const serverKey = process.env.SYNAU_MIDTRANS_SERVER_KEY ?? '';
  if (!serverKey) return false;
  const expected = crypto.createHash('sha512').update(`${orderId}${statusCode}${grossAmount}${serverKey}`).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function statusFromNotification(transactionStatus: string, fraudStatus?: string) {
  const normalized = transactionStatus.toLowerCase();
  if (normalized === 'settlement' || (normalized === 'capture' && (fraudStatus ?? '').toLowerCase() === 'accept')) return 'paid' as const;
  if (['deny', 'cancel', 'expire', 'failure'].includes(normalized)) return normalized === 'expire' ? 'expired' as const : 'failed' as const;
  return 'pending' as const;
}

function applyTopUpStatus(payload: unknown, requireSignature: boolean) {
  const parsed = MidtransNotificationSchema.parse(payload);
  if (requireSignature && (!parsed.signature_key || !validSignature(parsed.order_id, parsed.status_code, parsed.gross_amount, parsed.signature_key))) {
    throw new CreditError('Invalid Midtrans notification signature.', 400, 'invalid_midtrans_signature');
  }
  const topUp = db.prepare('SELECT * FROM credit_topups WHERE order_id = ?').get(parsed.order_id) as {
    id: string; user_id: string; credits: number; amount_idr: number; status: 'pending' | 'paid' | 'failed' | 'expired';
  } | undefined;
  if (!topUp) return { matched: false as const, status: 'unknown' as const };
  if (Math.round(Number(parsed.gross_amount)) !== topUp.amount_idr) {
    throw new CreditError('Midtrans amount does not match the pending top-up.', 400, 'midtrans_amount_mismatch');
  }
  const nextStatus = statusFromNotification(parsed.transaction_status, parsed.fraud_status);
  db.transaction(() => {
    const now = nowIso();
    db.prepare(`UPDATE credit_topups SET status = ?, midtrans_transaction_id = ?, payment_type = ?, raw_json = ?, updated_at = ?, settled_at = CASE WHEN ? = 'paid' THEN COALESCE(settled_at, ?) ELSE settled_at END WHERE id = ?`)
      .run(nextStatus, parsed.transaction_id ?? null, parsed.payment_type ?? null, json(parsed), now, nextStatus, now, topUp.id);
    if (nextStatus === 'paid' && topUp.status !== 'paid') {
      ensureAccountTx(topUp.user_id);
      applyCreditDeltaTx({
        userId: topUp.user_id,
        delta: topUp.credits,
        type: 'topup',
        referenceId: `topup:${topUp.id}:credit`,
        description: `Top-up ${topUp.credits.toLocaleString('id-ID')} credits`,
        metadata: { topUpId: topUp.id, orderId: parsed.order_id, amountIdr: topUp.amount_idr },
      });
    }
  })();
  return { matched: true as const, topUpId: topUp.id, status: nextStatus };
}

export function handleMidtransNotification(payload: unknown) {
  return applyTopUpStatus(payload, true);
}

export async function createCreditTopUp(userId: string, productId: string): Promise<TopUpResponse> {
  const product = CREDIT_PRODUCTS.find((candidate) => candidate.id === productId);
  if (!product) throw new CreditError('This credit package is not available.', 400, 'unknown_credit_product');
  const user = getUserById(userId);
  if (!user) throw new CreditError('User not found.', 404, 'user_not_found');
  const topUpId = newId();
  const orderId = `synau-${Date.now()}-${topUpId.replaceAll('-', '').slice(0, 14)}`;
  const createdAt = nowIso();
  db.prepare(`INSERT INTO credit_topups
    (id, user_id, order_id, product_id, credits, amount_idr, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(topUpId, userId, orderId, product.id, product.credits, product.amountIdr, createdAt, createdAt);
  try {
    const snap = await createSnapToken({
      orderId,
      grossAmount: product.amountIdr,
      customerName: user.name,
      customerEmail: user.email,
    });
    db.prepare('UPDATE credit_topups SET snap_token = ?, redirect_url = ?, updated_at = ? WHERE id = ?')
      .run(snap.token, snap.redirectUrl ?? null, nowIso(), topUpId);
    return TopUpResponseSchema.parse({
      topUpId,
      orderId,
      product,
      status: 'pending',
      snapToken: snap.token,
      ...(snap.redirectUrl ? { redirectUrl: snap.redirectUrl } : {}),
      clientKey: process.env.SYNAU_MIDTRANS_CLIENT_KEY ?? '',
      environment: process.env.SYNAU_MIDTRANS_PRODUCTION === 'true' ? 'production' : 'sandbox',
    });
  } catch (error) {
    db.prepare('UPDATE credit_topups SET status = \'failed\', updated_at = ? WHERE id = ?').run(nowIso(), topUpId);
    throw error;
  }
}

export async function syncCreditTopUp(userId: string, topUpId: string) {
  const row = db.prepare('SELECT * FROM credit_topups WHERE id = ? AND user_id = ?').get(topUpId, userId) as {
    id: string; order_id: string; status: 'pending' | 'paid' | 'failed' | 'expired';
  } | undefined;
  if (!row) throw new CreditError('Top-up not found.', 404, 'topup_not_found');
  if (row.status === 'paid') return { topUpId: row.id, status: row.status };
  const status = await getMidtransTransactionStatus(row.order_id);
  return applyTopUpStatus(status, false);
}

export function billingStatusCode(error: unknown) {
  return error instanceof CreditError ? { status: error.status, body: { error: error.message, code: error.code } } : null;
}

export function parseUsage(payload: unknown): ProviderUsage | null {
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

export function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
