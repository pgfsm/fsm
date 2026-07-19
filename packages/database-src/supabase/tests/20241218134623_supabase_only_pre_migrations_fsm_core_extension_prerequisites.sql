begin;
select plan(2);

select has_extension('ltree', 'ltree extension is installed');
select has_extension('pgmq', 'pgmq extension is installed (bundled by default in Supabase/Postgres)');

select * from finish();
rollback;
