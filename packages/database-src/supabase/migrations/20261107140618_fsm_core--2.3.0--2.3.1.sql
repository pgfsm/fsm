-- fsm_core 2.3.0 -> 2.3.1 (SPEC-016, #688). Applied to any other version, it
-- stops here and changes nothing.
SELECT fsm_core.require_version('2.3.0');

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION fsm_core.version()
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select '2.3.1'::text
$function$
;


