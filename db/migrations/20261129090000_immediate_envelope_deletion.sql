-- Finished envelopes are now deleted as soon as an administrator asks, so
-- there is nothing to schedule. Requests still waiting when this runs are
-- dropped, which cancels them: those envelopes are kept, and can be
-- deleted again from their page.

drop table if exists public.scheduled_envelope_deletions;
