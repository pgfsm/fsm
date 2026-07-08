

CREATE TABLE fsm_core.fsm_json (
    id SERIAL PRIMARY KEY,
    fsm_name TEXT,
    fsm_type TEXT, -- childFSM | FSM
    fsm_version TEXT,
    fsm_json JSONB
);



-- FSM state table
-- DROP TABLE IF EXISTS fsm_core.fsm_transitions CASCADE;
-- DROP TABLE IF EXISTS fsm_core.fsm_states CASCADE;

-- DO $$ BEGIN
--     IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fsm_state_type') THEN
--         CREATE TYPE fsm_state_type AS ENUM ('atomic', 'compound', 'parallel', 'final', 'history');
--     END IF;
-- END$$;

CREATE TYPE fsm_core.fsm_state_type AS ENUM ('atomic', 'compound', 'parallel', 'final', 'history');

CREATE TABLE fsm_core.fsm_states (
  state_id_with_fsm_name_and_fsm_version TEXT PRIMARY KEY,                -- Unique state node id (required)
  
  id TEXT NOT NULL,                   -- state node id (required)
  computed_state_id_ltree LTREE NOT NULL,

  key TEXT NOT NULL,                  -- State node key (required)
  computed_state_key_ltree LTREE NOT NULL,

  parent_node TEXT,                     -- Parent state node id (optional, null for root) 

  type fsm_core.fsm_state_type NOT NULL,       -- State node type: atomic, compound, parallel, final, history (required)
  description TEXT,                   -- Markdown description (optional)
  fsm_order INTEGER,                      -- Order (optional)

  context JSONB,                      -- State context (object, optional)
  states JSONB,                       -- Nested states (object, required for compound/parallel)
  initial JSONB,                      -- Initial transition object (optional)
  
  fsm_on JSONB,                           -- Transitions object (optional)
  transitions JSONB,                  -- Array of transition objects (optional)
  
  entry JSONB,                        -- Array of entry actions (optional)
  exit JSONB,                         -- Array of exit actions (optional)
  
  invoke JSONB,                       -- Array of invoke objects (optional)
  data JSONB,                         -- Data for final state (optional)
  
  history TEXT,                       -- History type for history state (optional)
  fsm_version TEXT,                        -- Version (optional)
  fsm_name TEXT
);


CREATE TABLE fsm_core.fsm_transitions (
    id SERIAL PRIMARY KEY,
    
    actions JSONB,                 -- Array of action objects (required)
    cond JSONB,                    -- Condition object (optional)
    event_type TEXT NOT NULL,       -- Event type (required)
    source TEXT NOT NULL,  -- Source state id (required)
    computed_sanitized_source_ltree LTREE NOT NULL,
    target TEXT[],         -- Array of target state ids (each should reference fsm_states(id))
    computed_sanitized_target_ltree_array LTREE[], -- Sanitized target state ids as ltree array
    reenter BOOLEAN DEFAULT FALSE, -- Reentry flag (optional, default false) 

    computed_transition_domain_lca text,  -- LCA path for source and target (ltree)
    
    fsm_name TEXT,
    fsm_version TEXT
);