CREATE TABLE fsm_core.fsm_dependencies (
    parent_fsm_name    TEXT NOT NULL,
    parent_fsm_version TEXT NOT NULL,
    child_fsm_name     TEXT NOT NULL,
    child_fsm_version  TEXT NOT NULL,
    PRIMARY KEY (parent_fsm_name, parent_fsm_version, child_fsm_name, child_fsm_version)
);


CREATE OR REPLACE FUNCTION fsm_core.check_fsm_circular_dependency()
RETURNS TRIGGER AS $$
DECLARE
    loop_detected BOOLEAN;
BEGIN
    IF NEW.parent_fsm_name = NEW.child_fsm_name
       AND NEW.parent_fsm_version = NEW.child_fsm_version THEN
        RAISE EXCEPTION 'Circular dependency: FSM (% %) cannot depend on itself.',
            NEW.parent_fsm_name, NEW.parent_fsm_version;
    END IF;

    -- Walk downstream from NEW.child; if we reach NEW.parent a cycle exists.
    WITH RECURSIVE fsm_graph AS (
        SELECT child_fsm_name, child_fsm_version
        FROM fsm_core.fsm_dependencies
        WHERE parent_fsm_name    = NEW.child_fsm_name
          AND parent_fsm_version = NEW.child_fsm_version

        UNION ALL

        SELECT d.child_fsm_name, d.child_fsm_version
        FROM fsm_core.fsm_dependencies d
        JOIN fsm_graph g
          ON d.parent_fsm_name    = g.child_fsm_name
         AND d.parent_fsm_version = g.child_fsm_version
    )
    SELECT EXISTS (
        SELECT 1 FROM fsm_graph
        WHERE child_fsm_name    = NEW.parent_fsm_name
          AND child_fsm_version = NEW.parent_fsm_version
    ) INTO loop_detected;

    IF loop_detected THEN
        RAISE EXCEPTION 'Circular dependency: linking (% %) -> (% %) creates an infinite loop.',
            NEW.parent_fsm_name, NEW.parent_fsm_version,
            NEW.child_fsm_name,  NEW.child_fsm_version;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


CREATE TRIGGER enforce_fsm_no_cycles
BEFORE INSERT OR UPDATE ON fsm_core.fsm_dependencies
FOR EACH ROW EXECUTE FUNCTION fsm_core.check_fsm_circular_dependency();


-- Inserts one row per element in p_dependent_children.
-- The trigger fires per-row; any cycle raises EXCEPTION and rolls back the caller transaction entirely.
CREATE OR REPLACE FUNCTION fsm_core.insert_fsm_dependencies(
    p_parent_name        TEXT,
    p_parent_version     TEXT,
    p_dependent_children JSONB  -- [{fsm_name: TEXT, fsm_version: TEXT}, ...]
) RETURNS VOID AS $$
DECLARE
    v_child RECORD;
BEGIN
    FOR v_child IN
        SELECT fsm_name, fsm_version
        FROM jsonb_to_recordset(p_dependent_children)
             AS x(fsm_name TEXT, fsm_version TEXT)
    LOOP
        INSERT INTO fsm_core.fsm_dependencies
            (parent_fsm_name, parent_fsm_version, child_fsm_name, child_fsm_version)
        VALUES
            (p_parent_name, p_parent_version, v_child.fsm_name, v_child.fsm_version)
        ON CONFLICT DO NOTHING;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
