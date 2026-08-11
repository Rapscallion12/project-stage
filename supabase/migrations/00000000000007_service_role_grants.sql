-- service_role was introduced in migration 00000000000006 (issue #13),
-- but no migration has ever granted it anything, and this project's
-- tables turned out not to inherit the standard Supabase default-
-- privilege bootstrap that normally gives service_role blanket table
-- access. Confirmed by a real failure while running issue #13's
-- integration tests: the service client got "permission denied for table
-- events" despite service_role bypassing RLS — RLS bypass and the
-- underlying Postgres table GRANT are separate privilege layers, and only
-- the first one was actually in place.
--
-- Unlike the anon/authenticated grants elsewhere in this project (each a
-- deliberate, per-table access-control decision — see ARCHITECTURE.md's
-- Data model section), this isn't one: service_role is Supabase's
-- documented trusted-backend role, and "full access to every table" is
-- what that role means by definition, not something to decide
-- table-by-table. Granted broadly, on existing tables and future ones
-- alike, once, here — rather than adding a service_role grant line to
-- every future migration by hand and risking one being forgotten.
grant select, insert, update, delete on all tables in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
