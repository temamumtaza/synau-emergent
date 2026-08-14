-- Application sessions are opaque secrets. Store only their SHA-256 digest so
-- a database read cannot be used as a live Synau session.
-- The predicate keeps already-hashed sessions untouched and makes this safe to
-- re-run against environments that were created after the cookie hardening.
update public.sessions
set token = encode(extensions.digest(token, 'sha256'), 'hex')
where token !~ '^[0-9a-f]{64}$';
