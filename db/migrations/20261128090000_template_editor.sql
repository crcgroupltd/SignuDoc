-- Templates made and edited on their own, without an envelope, and boxes
-- the sender fills in when using a template.
--
--   pages:           the size of each page, as an envelope keeps them, so
--                    the field editor can lay the pages out. Templates
--                    saved before this have none until first opened.
--   prefill_fields:  boxes the sender fills in before sending, placed like
--                    fields but belonging to no role. Their values are
--                    written into the document when the template is used.
--   fields_revision: counts saves of the field list, so the editor can
--                    refuse a save made against an older list.

alter table public.templates
  add column if not exists pages jsonb,
  add column if not exists prefill_fields jsonb not null default '[]'::jsonb,
  add column if not exists fields_revision integer not null default 0;

alter table public.templates
  drop constraint if exists templates_pages_check;
alter table public.templates
  add constraint templates_pages_check
    check (pages is null or jsonb_typeof(pages) = 'array');

alter table public.templates
  drop constraint if exists templates_prefill_fields_check;
alter table public.templates
  add constraint templates_prefill_fields_check
    check (jsonb_typeof(prefill_fields) = 'array');
