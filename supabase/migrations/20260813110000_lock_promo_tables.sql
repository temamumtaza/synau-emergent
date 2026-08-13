-- Reviewer redeem tokens are server-only secrets. Browser roles must not be
-- able to enumerate, create, update, or delete promo codes or redemptions.
alter table public.credit_promo_codes enable row level security;
alter table public.credit_promo_redemptions enable row level security;

revoke all on table public.credit_promo_codes, public.credit_promo_redemptions from anon, authenticated;
grant all on table public.credit_promo_codes, public.credit_promo_redemptions to service_role;
