create extension if not exists "ltree" with schema "public" version '1.2';

create type "public"."fsm_state_type" as enum ('atomic', 'compound', 'parallel', 'final', 'history');

create sequence "public"."fsm_transitions_id_seq";

create table "public"."fsm_states" (
    "state_id_with_fsm_name_and_fsm_version" text not null,
    "id" text not null,
    "computed_state_id_ltree" ltree not null,
    "key" text not null,
    "computed_state_key_ltree" ltree not null,
    "parent_node" text,
    "type" fsm_state_type not null,
    "description" text,
    "fsm_order" integer,
    "context" jsonb,
    "states" jsonb,
    "initial" jsonb,
    "fsm_on" jsonb,
    "transitions" jsonb,
    "entry" jsonb,
    "exit" jsonb,
    "invoke" jsonb,
    "data" jsonb,
    "history" text,
    "fsm_version" text,
    "fsm_name" text
);


create table "public"."fsm_transitions" (
    "id" integer not null default nextval('fsm_transitions_id_seq'::regclass),
    "actions" jsonb,
    "cond" jsonb,
    "event_type" text not null,
    "source" text not null,
    "computed_sanitized_source_ltree" ltree not null,
    "target" text[],
    "computed_sanitized_target_ltree_array" ltree[],
    "reenter" boolean default false,
    "computed_transition_domain_lca" text,
    "fsm_name" text,
    "fsm_version" text
);


alter sequence "public"."fsm_transitions_id_seq" owned by "public"."fsm_transitions"."id";

CREATE UNIQUE INDEX fsm_states_pkey ON public.fsm_states USING btree (state_id_with_fsm_name_and_fsm_version);

CREATE UNIQUE INDEX fsm_transitions_pkey ON public.fsm_transitions USING btree (id);

alter table "public"."fsm_states" add constraint "fsm_states_pkey" PRIMARY KEY using index "fsm_states_pkey";

alter table "public"."fsm_transitions" add constraint "fsm_transitions_pkey" PRIMARY KEY using index "fsm_transitions_pkey";

grant delete on table "public"."fsm_states" to "anon";

grant insert on table "public"."fsm_states" to "anon";

grant references on table "public"."fsm_states" to "anon";

grant select on table "public"."fsm_states" to "anon";

grant trigger on table "public"."fsm_states" to "anon";

grant truncate on table "public"."fsm_states" to "anon";

grant update on table "public"."fsm_states" to "anon";

grant delete on table "public"."fsm_states" to "authenticated";

grant insert on table "public"."fsm_states" to "authenticated";

grant references on table "public"."fsm_states" to "authenticated";

grant select on table "public"."fsm_states" to "authenticated";

grant trigger on table "public"."fsm_states" to "authenticated";

grant truncate on table "public"."fsm_states" to "authenticated";

grant update on table "public"."fsm_states" to "authenticated";

grant delete on table "public"."fsm_states" to "service_role";

grant insert on table "public"."fsm_states" to "service_role";

grant references on table "public"."fsm_states" to "service_role";

grant select on table "public"."fsm_states" to "service_role";

grant trigger on table "public"."fsm_states" to "service_role";

grant truncate on table "public"."fsm_states" to "service_role";

grant update on table "public"."fsm_states" to "service_role";

grant delete on table "public"."fsm_transitions" to "anon";

grant insert on table "public"."fsm_transitions" to "anon";

grant references on table "public"."fsm_transitions" to "anon";

grant select on table "public"."fsm_transitions" to "anon";

grant trigger on table "public"."fsm_transitions" to "anon";

grant truncate on table "public"."fsm_transitions" to "anon";

grant update on table "public"."fsm_transitions" to "anon";

grant delete on table "public"."fsm_transitions" to "authenticated";

grant insert on table "public"."fsm_transitions" to "authenticated";

grant references on table "public"."fsm_transitions" to "authenticated";

grant select on table "public"."fsm_transitions" to "authenticated";

grant trigger on table "public"."fsm_transitions" to "authenticated";

grant truncate on table "public"."fsm_transitions" to "authenticated";

grant update on table "public"."fsm_transitions" to "authenticated";

grant delete on table "public"."fsm_transitions" to "service_role";

grant insert on table "public"."fsm_transitions" to "service_role";

grant references on table "public"."fsm_transitions" to "service_role";

grant select on table "public"."fsm_transitions" to "service_role";

grant trigger on table "public"."fsm_transitions" to "service_role";

grant truncate on table "public"."fsm_transitions" to "service_role";

grant update on table "public"."fsm_transitions" to "service_role";


