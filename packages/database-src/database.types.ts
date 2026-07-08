export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  fsm_core: {
    Tables: {
      fsm_instance: {
        Row: {
          childrens: Json | null;
          ended_at: string | null;
          fsm_instance_context: Json | null;
          fsm_instance_error: Json | null;
          fsm_instance_output: Json | null;
          fsm_instance_state: Json | null;
          fsm_instance_status: Json | null;
          fsm_instance_xstate_state: Json | null;
          fsm_name: string | null;
          fsm_type: string | null;
          fsm_version: string | null;
          id: string;
          parent: string | null;
          started_at: string | null;
          total_promise_queue_data: Json | null;
          total_schedule_queue_data: Json | null;
          worker_lock_expires_at: string | null;
          worker_locked: boolean | null;
          worker_locked_at: string | null;
          worker_locked_by: string | null;
        };
        Insert: {
          childrens?: Json | null;
          ended_at?: string | null;
          fsm_instance_context?: Json | null;
          fsm_instance_error?: Json | null;
          fsm_instance_output?: Json | null;
          fsm_instance_state?: Json | null;
          fsm_instance_status?: Json | null;
          fsm_instance_xstate_state?: Json | null;
          fsm_name?: string | null;
          fsm_type?: string | null;
          fsm_version?: string | null;
          id?: string;
          parent?: string | null;
          started_at?: string | null;
          total_promise_queue_data?: Json | null;
          total_schedule_queue_data?: Json | null;
          worker_lock_expires_at?: string | null;
          worker_locked?: boolean | null;
          worker_locked_at?: string | null;
          worker_locked_by?: string | null;
        };
        Update: {
          childrens?: Json | null;
          ended_at?: string | null;
          fsm_instance_context?: Json | null;
          fsm_instance_error?: Json | null;
          fsm_instance_output?: Json | null;
          fsm_instance_state?: Json | null;
          fsm_instance_status?: Json | null;
          fsm_instance_xstate_state?: Json | null;
          fsm_name?: string | null;
          fsm_type?: string | null;
          fsm_version?: string | null;
          id?: string;
          parent?: string | null;
          started_at?: string | null;
          total_promise_queue_data?: Json | null;
          total_schedule_queue_data?: Json | null;
          worker_lock_expires_at?: string | null;
          worker_locked?: boolean | null;
          worker_locked_at?: string | null;
          worker_locked_by?: string | null;
        };
        Relationships: [];
      };
      fsm_instance_lock: {
        Row: {
          expires_at: string | null;
          fsm_instance_id: string;
          locked: boolean | null;
          locked_at: string | null;
          locked_by: string | null;
        };
        Insert: {
          expires_at?: string | null;
          fsm_instance_id: string;
          locked?: boolean | null;
          locked_at?: string | null;
          locked_by?: string | null;
        };
        Update: {
          expires_at?: string | null;
          fsm_instance_id?: string;
          locked?: boolean | null;
          locked_at?: string | null;
          locked_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fsm_instance_lock_fsm_instance_id_fkey";
            columns: ["fsm_instance_id"];
            isOneToOne: true;
            referencedRelation: "fsm_instance";
            referencedColumns: ["id"];
          },
        ];
      };
      fsm_instance_queue_event_logs: {
        Row: {
          error_message: string | null;
          event_data: Json | null;
          event_delay: number | null;
          event_name: string | null;
          event_output: Json | null;
          event_status: string | null;
          execution_duration: number | null;
          execution_finished_at: string | null;
          execution_started_at: string | null;
          fsm_instance_id: string | null;
          fsm_instance_id_fsm_type: string | null;
          fsm_instance_id_fsm_version: string | null;
          fsm_instance_queue_event_log_id: string;
          fsm_instance_queue_msg_id: number | null;
          send_to_parent_queue_id: string | null;
          send_to_parent_queue_id_event_name: string | null;
        };
        Insert: {
          error_message?: string | null;
          event_data?: Json | null;
          event_delay?: number | null;
          event_name?: string | null;
          event_output?: Json | null;
          event_status?: string | null;
          execution_duration?: number | null;
          execution_finished_at?: string | null;
          execution_started_at?: string | null;
          fsm_instance_id?: string | null;
          fsm_instance_id_fsm_type?: string | null;
          fsm_instance_id_fsm_version?: string | null;
          fsm_instance_queue_event_log_id?: string;
          fsm_instance_queue_msg_id?: number | null;
          send_to_parent_queue_id?: string | null;
          send_to_parent_queue_id_event_name?: string | null;
        };
        Update: {
          error_message?: string | null;
          event_data?: Json | null;
          event_delay?: number | null;
          event_name?: string | null;
          event_output?: Json | null;
          event_status?: string | null;
          execution_duration?: number | null;
          execution_finished_at?: string | null;
          execution_started_at?: string | null;
          fsm_instance_id?: string | null;
          fsm_instance_id_fsm_type?: string | null;
          fsm_instance_id_fsm_version?: string | null;
          fsm_instance_queue_event_log_id?: string;
          fsm_instance_queue_msg_id?: number | null;
          send_to_parent_queue_id?: string | null;
          send_to_parent_queue_id_event_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName:
              "fsm_instance_queue_event_logs_fsm_instance_id_fkey";
            columns: ["fsm_instance_id"];
            isOneToOne: false;
            referencedRelation: "fsm_instance";
            referencedColumns: ["id"];
          },
        ];
      };
      fsm_instance_transitions_auth: {
        Row: {
          fsm_instance_event_type: string | null;
          fsm_instance_id: string | null;
          fsm_name: string | null;
          fsm_type: string | null;
          fsm_version: string | null;
          groups: Json[] | null;
          id: string;
          meta_info: Json | null;
          module_tag: Json | null;
          users: Json[] | null;
        };
        Insert: {
          fsm_instance_event_type?: string | null;
          fsm_instance_id?: string | null;
          fsm_name?: string | null;
          fsm_type?: string | null;
          fsm_version?: string | null;
          groups?: Json[] | null;
          id?: string;
          meta_info?: Json | null;
          module_tag?: Json | null;
          users?: Json[] | null;
        };
        Update: {
          fsm_instance_event_type?: string | null;
          fsm_instance_id?: string | null;
          fsm_name?: string | null;
          fsm_type?: string | null;
          fsm_version?: string | null;
          groups?: Json[] | null;
          id?: string;
          meta_info?: Json | null;
          module_tag?: Json | null;
          users?: Json[] | null;
        };
        Relationships: [
          {
            foreignKeyName:
              "fsm_instance_transitions_auth_fsm_instance_id_fkey";
            columns: ["fsm_instance_id"];
            isOneToOne: false;
            referencedRelation: "fsm_instance";
            referencedColumns: ["id"];
          },
        ];
      };
      fsm_json: {
        Row: {
          fsm_json: Json | null;
          fsm_name: string | null;
          fsm_type: string | null;
          fsm_version: string | null;
          id: number;
        };
        Insert: {
          fsm_json?: Json | null;
          fsm_name?: string | null;
          fsm_type?: string | null;
          fsm_version?: string | null;
          id?: number;
        };
        Update: {
          fsm_json?: Json | null;
          fsm_name?: string | null;
          fsm_type?: string | null;
          fsm_version?: string | null;
          id?: number;
        };
        Relationships: [];
      };
      fsm_promise_queue_event_logs: {
        Row: {
          error_message: string | null;
          event_data: Json | null;
          event_delay: number | null;
          event_name: string | null;
          event_output: Json | null;
          event_status: string | null;
          execution_duration: number | null;
          execution_finished_at: string | null;
          execution_started_at: string | null;
          promise_fn_name: string | null;
          promise_queue_event_log_id: string;
          promise_queue_msg_id: number | null;
          promise_queue_name: string | null;
          promise_queue_type: string | null;
          promise_queue_version: string | null;
          send_to_parent_queue_id: string | null;
          send_to_parent_queue_id_event_name: string | null;
        };
        Insert: {
          error_message?: string | null;
          event_data?: Json | null;
          event_delay?: number | null;
          event_name?: string | null;
          event_output?: Json | null;
          event_status?: string | null;
          execution_duration?: number | null;
          execution_finished_at?: string | null;
          execution_started_at?: string | null;
          promise_fn_name?: string | null;
          promise_queue_event_log_id?: string;
          promise_queue_msg_id?: number | null;
          promise_queue_name?: string | null;
          promise_queue_type?: string | null;
          promise_queue_version?: string | null;
          send_to_parent_queue_id?: string | null;
          send_to_parent_queue_id_event_name?: string | null;
        };
        Update: {
          error_message?: string | null;
          event_data?: Json | null;
          event_delay?: number | null;
          event_name?: string | null;
          event_output?: Json | null;
          event_status?: string | null;
          execution_duration?: number | null;
          execution_finished_at?: string | null;
          execution_started_at?: string | null;
          promise_fn_name?: string | null;
          promise_queue_event_log_id?: string;
          promise_queue_msg_id?: number | null;
          promise_queue_name?: string | null;
          promise_queue_type?: string | null;
          promise_queue_version?: string | null;
          send_to_parent_queue_id?: string | null;
          send_to_parent_queue_id_event_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName:
              "fsm_promise_queue_event_logs_send_to_parent_queue_id_fkey";
            columns: ["send_to_parent_queue_id"];
            isOneToOne: false;
            referencedRelation: "fsm_instance";
            referencedColumns: ["id"];
          },
        ];
      };
      fsm_states: {
        Row: {
          computed_state_id_ltree: unknown;
          computed_state_key_ltree: unknown;
          context: Json | null;
          data: Json | null;
          description: string | null;
          entry: Json | null;
          exit: Json | null;
          fsm_name: string | null;
          fsm_on: Json | null;
          fsm_order: number | null;
          fsm_version: string | null;
          history: string | null;
          id: string;
          initial: Json | null;
          invoke: Json | null;
          key: string;
          parent_node: string | null;
          state_id_with_fsm_name_and_fsm_version: string;
          states: Json | null;
          transitions: Json | null;
          type: Database["fsm_core"]["Enums"]["fsm_state_type"];
        };
        Insert: {
          computed_state_id_ltree: unknown;
          computed_state_key_ltree: unknown;
          context?: Json | null;
          data?: Json | null;
          description?: string | null;
          entry?: Json | null;
          exit?: Json | null;
          fsm_name?: string | null;
          fsm_on?: Json | null;
          fsm_order?: number | null;
          fsm_version?: string | null;
          history?: string | null;
          id: string;
          initial?: Json | null;
          invoke?: Json | null;
          key: string;
          parent_node?: string | null;
          state_id_with_fsm_name_and_fsm_version: string;
          states?: Json | null;
          transitions?: Json | null;
          type: Database["fsm_core"]["Enums"]["fsm_state_type"];
        };
        Update: {
          computed_state_id_ltree?: unknown;
          computed_state_key_ltree?: unknown;
          context?: Json | null;
          data?: Json | null;
          description?: string | null;
          entry?: Json | null;
          exit?: Json | null;
          fsm_name?: string | null;
          fsm_on?: Json | null;
          fsm_order?: number | null;
          fsm_version?: string | null;
          history?: string | null;
          id?: string;
          initial?: Json | null;
          invoke?: Json | null;
          key?: string;
          parent_node?: string | null;
          state_id_with_fsm_name_and_fsm_version?: string;
          states?: Json | null;
          transitions?: Json | null;
          type?: Database["fsm_core"]["Enums"]["fsm_state_type"];
        };
        Relationships: [];
      };
      fsm_transitions: {
        Row: {
          actions: Json | null;
          computed_sanitized_source_ltree: unknown;
          computed_sanitized_target_ltree_array: unknown[] | null;
          computed_transition_domain_lca: string | null;
          cond: Json | null;
          event_type: string;
          fsm_name: string | null;
          fsm_version: string | null;
          id: number;
          reenter: boolean | null;
          source: string;
          target: string[] | null;
        };
        Insert: {
          actions?: Json | null;
          computed_sanitized_source_ltree: unknown;
          computed_sanitized_target_ltree_array?: unknown[] | null;
          computed_transition_domain_lca?: string | null;
          cond?: Json | null;
          event_type: string;
          fsm_name?: string | null;
          fsm_version?: string | null;
          id?: number;
          reenter?: boolean | null;
          source: string;
          target?: string[] | null;
        };
        Update: {
          actions?: Json | null;
          computed_sanitized_source_ltree?: unknown;
          computed_sanitized_target_ltree_array?: unknown[] | null;
          computed_transition_domain_lca?: string | null;
          cond?: Json | null;
          event_type?: string;
          fsm_name?: string | null;
          fsm_version?: string | null;
          id?: number;
          reenter?: boolean | null;
          source?: string;
          target?: string[] | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      api_system_event_name: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      api_system_queue_type: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      api_system_queue_uuid: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      archive_event_from_fsm_promise_type_worker_v2: {
        Args: {
          input_promise_queue_name: string;
          input_promise_queue_type: string;
          input_promise_queue_version: string;
          input_promise_queue_msg_id: number;
          input_event_name: string;
          input_event_action_type: string;
          input_event_data: Json;
          input_event_delay: number;
          input_send_to_parent_queue_id: string;
          input_send_to_parent_queue_id_event_name: string;
          input_execution_started_at: string;
          input_execution_duration: number;
          input_execution_finished_at: string;
          input_event_status: string;
          input_event_output: Json;
          input_error_message: string;
        };
        Returns: Json;
      };
      archive_event_from_fsm_type_worker_v2: {
        Args: {
          remove_from_current_fsm_instance_queue_id: string;
          remove_current_queue_msg_id: number;
          to_be_removed_schedule_queue_msg_ids: Json;
          to_be_removed_promise_queue_msg_ids: Json;
          to_be_added_schedule_queue_data: Json;
          to_be_added_promise_queue_data: Json;
          input_total_schedule_queue_data: Json;
          input_total_promise_queue_data: Json;
          fsm_instance_data_save_fsm_status: Json;
          fsm_instance_data_save_fsm_state: Json;
          fsm_instance_data_save_fsm_context: Json;
          fsm_instance_data_save_fsm_xstate_state: Json;
          send_to_parent_queue_id: string;
          send_to_parent_queue_type: string;
          send_to_parent_queue_id_event_name: string;
        };
        Returns: Json;
      };
      build_nested_json_recursive: {
        Args: {
          paths: string[];
        };
        Returns: Json;
      };
      cancel_event_for_fsm_promise_type_worker_v2: {
        Args: {
          promise_type_worker_name: string;
          queue_msg_id: number;
        };
        Returns: Json;
      };
      compute_child_exit_set_v1: {
        Args: {
          transition_domain_lca: unknown;
          state_node_set: unknown[];
        };
        Returns: string[];
      };
      compute_child_exit_set_v2: {
        Args: {
          transition_domain_lca: unknown;
          state_node_set: unknown[];
        };
        Returns: string[];
      };
      compute_entry_actions_v1: {
        Args: {
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
          fsm_name_param: string;
          fsm_version_param: string;
          is_initial_transition: boolean;
        };
        Returns: Json;
      };
      compute_entry_actions_v2: {
        Args: {
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
          fsm_name_param: string;
          fsm_version_param: string;
          is_initial_transition: boolean;
        };
        Returns: Json;
      };
      compute_exit_actions_v1: {
        Args: {
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
          p_state_node_set: string[];
          p_fsm_name: string;
          p_fsm_version: string;
        };
        Returns: Json;
      };
      compute_exit_actions_v2: {
        Args: {
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
          input_state_node_set: string[];
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      compute_full_exit_set_v1: {
        Args: {
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
          state_node_set: string[];
        };
        Returns: string[];
      };
      compute_full_exit_set_v2: {
        Args: {
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
          state_node_set: string[];
        };
        Returns: string[];
      };
      create_fsm_instance_from_name_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_fsm_context: Json;
          create_pgmq_queue?: boolean;
        };
        Returns: Json;
      };
      create_fsm_queue_and_send_event_from_fsm_instance_id_v2: {
        Args: {
          event_name: string;
          event_input: Json;
          id: string;
          action_type: string;
          src: string;
          fsmname: string;
          fsmtype: string;
          fsmversion: string;
          parentfsmname: string;
          parentfsmversion: string;
          from_source_fsm_instance_id: string;
        };
        Returns: Json;
      };
      create_promise_queue_and_send_event_from_fsm_instance_id_v2: {
        Args: {
          event_name: string;
          event_input: Json;
          id: string;
          action_type: string;
          src: string;
          fsmname: string;
          fsmtype: string;
          fsmversion: string;
          parentfsmname: string;
          parentfsmversion: string;
          from_source_fsm_instance_id: string;
        };
        Returns: Json;
      };
      fsm_get_all_state_nodes_v1: {
        Args: {
          p_state_paths: string[];
          p_fsm_name: string;
          p_fsm_version: string;
        };
        Returns: string[];
      };
      fsm_get_all_state_nodes_v2: {
        Args: {
          input_state_paths: string[];
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: string[];
      };
      fsm_get_initial_state_nodes_v1: {
        Args: {
          p_fsm_name: string;
          p_fsm_version: string;
          p_state_path: unknown;
        };
        Returns: string[];
      };
      fsm_get_initial_state_nodes_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_state_path: unknown;
        };
        Returns: string[];
      };
      fsm_get_initial_state_nodes_with_ancestors_v1: {
        Args: {
          p_fsm_name: string;
          p_fsm_version: string;
          p_state_path: unknown;
        };
        Returns: string[];
      };
      fsm_get_initial_state_nodes_with_ancestors_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_state_path: unknown;
        };
        Returns: string[];
      };
      fsm_json_schema: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      fsm_worker_v1: {
        Args: {
          event_name: string;
          p_state_value: Json;
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      fsm_worker_v2: {
        Args: {
          event_name: string;
          input_state_value: Json;
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      get_ancestor_states_for_entry_v1: {
        Args: {
          ancestors: string[];
          reentrancy_domain: string;
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns:
          Database["fsm_core"]["CompositeTypes"]["ancestor_states_result_v1"];
      };
      get_ancestor_states_for_entry_v2: {
        Args: {
          ancestors: string[];
          reentrancy_domain: string;
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns:
          Database["fsm_core"]["CompositeTypes"]["ancestor_states_result_v2"];
      };
      get_descendant_states_for_entry_v1: {
        Args: {
          input_state_id: string;
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns:
          Database["fsm_core"]["CompositeTypes"]["descendant_states_result_v1"];
      };
      get_descendant_states_for_entry_v2: {
        Args: {
          input_state_id: string;
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns:
          Database["fsm_core"]["CompositeTypes"]["descendant_states_result_v2"];
      };
      get_entry_actions_v1: {
        Args: {
          p_state_paths: string[];
          p_fsm_name: string;
          p_fsm_version: string;
        };
        Returns: Json;
      };
      get_entry_actions_v2: {
        Args: {
          input_state_paths: string[];
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      get_exit_actions_v1: {
        Args: {
          p_state_paths: string[];
          p_fsm_name: string;
          p_fsm_version: string;
        };
        Returns: Json;
      };
      get_exit_actions_v2: {
        Args: {
          input_state_paths: string[];
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      get_fsm_data_resolve_state_value_v2: {
        Args: {
          input_fsm_id: string;
        };
        Returns: Json;
      };
      get_initial_actions_v1: {
        Args: {
          p_state_paths: string[];
          p_fsm_name: string;
          p_fsm_version: string;
        };
        Returns: Json;
      };
      get_initial_actions_v2: {
        Args: {
          input_state_paths: string[];
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      get_proper_ancestors: {
        Args: {
          state_path_ltree: string;
          to_state_path_ltree: string;
        };
        Returns: string[];
      };
      get_proper_ancestors_ltree: {
        Args: {
          state_path_ltree: unknown;
          to_state_path_ltree: unknown;
        };
        Returns: unknown[];
      };
      hello: {
        Args: {
          input_text: string;
        };
        Returns: undefined;
      };
      json_matches_schema: {
        Args: {
          schema: Json;
          instance: Json;
        };
        Returns: boolean;
      };
      jsonb_all_paths: {
        Args: {
          j: Json;
          prefix?: string;
        };
        Returns: string[];
      };
      jsonb_deep_merge: {
        Args: {
          a: Json;
          b: Json;
        };
        Returns: Json;
      };
      jsonb_matches_schema: {
        Args: {
          schema: Json;
          instance: Json;
        };
        Returns: boolean;
      };
      jsonschema_is_valid: {
        Args: {
          schema: Json;
        };
        Returns: boolean;
      };
      jsonschema_validation_errors: {
        Args: {
          schema: Json;
          instance: Json;
        };
        Returns: string[];
      };
      load_fsm_from_json_v2: {
        Args: {
          json_input: Json;
          root_node_text: string;
          input_fsm_type: string;
          input_fsm_name: string;
          input_fsm_version: string;
          input_dependent_children?: Json;
        };
        Returns: Json;
      };
      insert_fsm_dependencies: {
        Args: {
          p_parent_name: string;
          p_parent_version: string;
          p_dependent_children: Json;
        };
        Returns: undefined;
      };
      load_fsm_state_from_json_v1: {
        Args: {
          json_input: Json;
          root_node_text: string;
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      load_fsm_state_from_json_v2: {
        Args: {
          json_input: Json;
          root_node_text: string;
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      load_fsm_transition_from_json_v1: {
        Args: {
          json_input: Json;
          root_node_text: string;
          fsm_name: string;
          fsm_version: string;
        };
        Returns: Json;
      };
      load_fsm_transition_from_json_v2: {
        Args: {
          json_input: Json;
          root_node_text: string;
          fsm_name: string;
          fsm_version: string;
        };
        Returns: Json;
      };
      lock_fsm_instance: {
        Args: {
          input_fsm_instance_id: string;
          input_locked_by: string;
        };
        Returns: boolean;
      };
      macrostep_v1: {
        Args: {
          event_name: string;
          p_state_value: string[];
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      macrostep_v2: {
        Args: {
          event_name: string;
          input_state_value: string[];
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      microstep_v1: {
        Args: {
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
          event_name: string;
          state_value_node_set: string[];
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      microstep_v2: {
        Args: {
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
          event_name: string;
          state_value_node_set: string[];
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      path_string_to_jsonb: {
        Args: {
          path: string;
        };
        Returns: Json;
      };
      pg_advisory_unlock:
        | {
          Args: {
            key: number;
          };
          Returns: boolean;
        }
        | {
          Args: {
            key1: number;
            key2: number;
          };
          Returns: boolean;
        };
      pg_system_event_name: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      pg_system_queue_type: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      pg_system_queue_uuid: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      pg_try_advisory_lock:
        | {
          Args: {
            key: number;
          };
          Returns: boolean;
        }
        | {
          Args: {
            key1: number;
            key2: number;
          };
          Returns: boolean;
        };
      remove_hashtag_from_text: {
        Args: {
          input_text: string;
        };
        Returns: string;
      };
      resolve_state_value_v1: {
        Args: {
          input_json: Json;
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      resolve_state_value_v2: {
        Args: {
          input_json: Json;
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      sanitize_text_array_to_ltree_array: {
        Args: {
          input_array: string[];
        };
        Returns: unknown[];
      };
      sanitize_text_array_to_ltree_text_array: {
        Args: {
          input_array: string[];
        };
        Returns: string[];
      };
      sanitize_text_to_ltree: {
        Args: {
          input_text: string;
        };
        Returns: unknown;
      };
      select_all_transitions_v1: {
        Args: {
          event_name: string;
          p_state_value: string[];
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      select_all_transitions_v2: {
        Args: {
          event_name: string;
          input_state_value: string[];
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      select_transitions_with_guard_eval_v1: {
        Args: {
          input_all_transitions:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"][];
        };
        Returns: {
          actions: Json | null;
          computed_sanitized_source_ltree: unknown;
          computed_sanitized_target_ltree_array: unknown[] | null;
          computed_transition_domain_lca: string | null;
          cond: Json | null;
          event_type: string;
          fsm_name: string | null;
          fsm_version: string | null;
          id: number;
          reenter: boolean | null;
          source: string;
          target: string[] | null;
        }[];
      };
      select_transitions_with_guard_eval_v2: {
        Args: {
          input_all_transitions:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"][];
        };
        Returns: {
          actions: Json | null;
          computed_sanitized_source_ltree: unknown;
          computed_sanitized_target_ltree_array: unknown[] | null;
          computed_transition_domain_lca: string | null;
          cond: Json | null;
          event_type: string;
          fsm_name: string | null;
          fsm_version: string | null;
          id: number;
          reenter: boolean | null;
          source: string;
          target: string[] | null;
        }[];
      };
      send_event_to_fsm_queue_with_event_logs_v2: {
        Args: {
          input_fsm_instance_id: string;
          input_fsm_instance_id_fsm_type: string;
          input_fsm_instance_id_fsm_version: string;
          input_send_to_parent_queue_id: string;
          input_send_to_parent_queue_type: string;
          input_send_to_parent_queue_id_event_name: string;
          input_event_name: string;
          input_event_action_type: string;
          input_event_data: Json;
          input_event_delay?: number;
          input_event_status?: string;
          input_event_output?: Json;
          input_error_message?: string;
          input_execution_started_at?: string;
          input_execution_duration?: number;
          input_execution_finished_at?: string;
        };
        Returns: Json;
      };
      send_event_to_promise_queue_with_event_logs_v2: {
        Args: {
          input_promise_queue_name: string;
          input_promise_fn_name: string;
          input_promise_queue_type: string;
          input_promise_queue_version: string;
          input_send_to_parent_queue_id: string;
          input_send_to_parent_queue_type: string;
          input_send_to_parent_queue_id_event_name: string;
          input_event_name: string;
          input_event_action_type: string;
          input_event_data: Json;
          input_event_delay?: number;
          input_event_status?: string;
          input_event_output?: Json;
          input_error_message?: string;
          input_execution_started_at?: string;
          input_execution_duration?: number;
          input_execution_finished_at?: string;
        };
        Returns: Json;
      };
      send_event_to_queue_from_fsm_instance_id_v2: {
        Args: {
          event_name: string;
          event_input: Json;
          id: string;
          action_type: string;
          src: string;
          fsmname: string;
          fsmtype: string;
          fsmversion: string;
          parentfsmname: string;
          parentfsmversion: string;
          from_source_fsm_instance_id: string;
        };
        Returns: Json;
      };
      sql_lca_for_transition: {
        Args: {
          transition: Json;
        };
        Returns: unknown;
      };
      sql_lca_from_array: {
        Args: {
          paths: unknown[];
        };
        Returns: unknown;
      };
      stop_event_for_fsm_worker_v2: {
        Args: {
          input_fsm_instance_id: string;
        };
        Returns: Json;
      };
      test_event_transition_for_entry_v1: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      test_event_transition_for_entry_v2: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      test_jsonb_roundtrip: {
        Args: {
          input_jsonb: Json;
        };
        Returns: {
          original: Json;
          reconstructed: Json;
          paths: string[];
        }[];
      };
      unlock_fsm_instance: {
        Args: {
          input_fsm_instance_id: string;
        };
        Returns: boolean;
      };
    };
    Enums: {
      fsm_state_type: "atomic" | "compound" | "parallel" | "final" | "history";
    };
    CompositeTypes: {
      ancestor_states_result_v1: {
        ancestor_states_to_enter: string[] | null;
        ancestor_states_for_default_entry: string[] | null;
      };
      ancestor_states_result_v2: {
        ancestor_states_to_enter: string[] | null;
        ancestor_states_for_default_entry: string[] | null;
      };
      descendant_states_result_v1: {
        descendant_states_to_enter: string[] | null;
        descendant_states_for_default_entry: string[] | null;
      };
      descendant_states_result_v2: {
        descendant_states_to_enter: string[] | null;
        descendant_states_for_default_entry: string[] | null;
      };
      fsm_event_data_v2: {
        eventType: string | null;
        eventPayload: Json | null;
        actionType: string | null;
      };
      fsm_queue_msg_data_v2: {
        eventData:
          | Database["fsm_core"]["CompositeTypes"]["fsm_event_data_v2"]
          | null;
        queueId: string | null;
        queueType: string | null;
        queueVersion: string | null;
        sendToParentQueueId: string | null;
        sendToParentQueueType: string | null;
        sendToParentQueueIdEventName: string | null;
        queueMsgId: number | null;
        queueMsgDelay: number | null;
        queueFnName: string | null;
      };
    };
  };
  pgmq: {
    Tables: {
      meta: {
        Row: {
          created_at: string;
          is_partitioned: boolean;
          is_unlogged: boolean;
          queue_name: string;
        };
        Insert: {
          created_at?: string;
          is_partitioned: boolean;
          is_unlogged: boolean;
          queue_name: string;
        };
        Update: {
          created_at?: string;
          is_partitioned?: boolean;
          is_unlogged?: boolean;
          queue_name?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      _belongs_to_pgmq: {
        Args: {
          table_name: string;
        };
        Returns: boolean;
      };
      _ensure_pg_partman_installed: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      _get_partition_col: {
        Args: {
          partition_interval: string;
        };
        Returns: string;
      };
      _get_pg_partman_major_version: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      _get_pg_partman_schema: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      archive:
        | {
          Args: {
            queue_name: string;
            msg_id: number;
          };
          Returns: boolean;
        }
        | {
          Args: {
            queue_name: string;
            msg_ids: number[];
          };
          Returns: number[];
        };
      convert_archive_partitioned: {
        Args: {
          table_name: string;
          partition_interval?: string;
          retention_interval?: string;
          leading_partition?: number;
        };
        Returns: undefined;
      };
      create: {
        Args: {
          queue_name: string;
        };
        Returns: undefined;
      };
      create_non_partitioned: {
        Args: {
          queue_name: string;
        };
        Returns: undefined;
      };
      create_partitioned: {
        Args: {
          queue_name: string;
          partition_interval?: string;
          retention_interval?: string;
        };
        Returns: undefined;
      };
      create_unlogged: {
        Args: {
          queue_name: string;
        };
        Returns: undefined;
      };
      delete:
        | {
          Args: {
            queue_name: string;
            msg_id: number;
          };
          Returns: boolean;
        }
        | {
          Args: {
            queue_name: string;
            msg_ids: number[];
          };
          Returns: number[];
        };
      detach_archive: {
        Args: {
          queue_name: string;
        };
        Returns: undefined;
      };
      drop_queue: {
        Args: {
          queue_name: string;
        };
        Returns: boolean;
      };
      format_table_name: {
        Args: {
          queue_name: string;
          prefix: string;
        };
        Returns: string;
      };
      list_queues: {
        Args: Record<PropertyKey, never>;
        Returns: Database["pgmq"]["CompositeTypes"]["queue_record"][];
      };
      metrics: {
        Args: {
          queue_name: string;
        };
        Returns: Database["pgmq"]["CompositeTypes"]["metrics_result"];
      };
      metrics_all: {
        Args: Record<PropertyKey, never>;
        Returns: Database["pgmq"]["CompositeTypes"]["metrics_result"][];
      };
      pop: {
        Args: {
          queue_name: string;
        };
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][];
      };
      purge_queue: {
        Args: {
          queue_name: string;
        };
        Returns: number;
      };
      read: {
        Args: {
          queue_name: string;
          vt: number;
          qty: number;
        };
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][];
      };
      read_with_poll: {
        Args: {
          queue_name: string;
          vt: number;
          qty: number;
          max_poll_seconds?: number;
          poll_interval_ms?: number;
        };
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][];
      };
      send: {
        Args: {
          queue_name: string;
          msg: Json;
          delay?: number;
        };
        Returns: number[];
      };
      send_batch: {
        Args: {
          queue_name: string;
          msgs: Json[];
          delay?: number;
        };
        Returns: number[];
      };
      set_vt: {
        Args: {
          queue_name: string;
          msg_id: number;
          vt: number;
        };
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][];
      };
      validate_queue_name: {
        Args: {
          queue_name: string;
        };
        Returns: undefined;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      message_record: {
        msg_id: number | null;
        read_ct: number | null;
        enqueued_at: string | null;
        vt: string | null;
        message: Json | null;
      };
      metrics_result: {
        queue_name: string | null;
        queue_length: number | null;
        newest_msg_age_sec: number | null;
        oldest_msg_age_sec: number | null;
        total_messages: number | null;
        scrape_time: string | null;
      };
      queue_record: {
        queue_name: string | null;
        is_partitioned: boolean | null;
        is_unlogged: boolean | null;
        created_at: string | null;
      };
    };
  };
  public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      _ltree_compress: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      _ltree_gist_options: {
        Args: {
          "": unknown;
        };
        Returns: undefined;
      };
      lca: {
        Args: {
          "": unknown[];
        };
        Returns: unknown;
      };
      lquery_in: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      lquery_out: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      lquery_recv: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      lquery_send: {
        Args: {
          "": unknown;
        };
        Returns: string;
      };
      ltree_compress: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltree_decompress: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltree_gist_in: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltree_gist_options: {
        Args: {
          "": unknown;
        };
        Returns: undefined;
      };
      ltree_gist_out: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltree_in: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltree_out: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltree_recv: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltree_send: {
        Args: {
          "": unknown;
        };
        Returns: string;
      };
      ltree2text: {
        Args: {
          "": unknown;
        };
        Returns: string;
      };
      ltxtq_in: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltxtq_out: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltxtq_recv: {
        Args: {
          "": unknown;
        };
        Returns: unknown;
      };
      ltxtq_send: {
        Args: {
          "": unknown;
        };
        Returns: string;
      };
      nlevel: {
        Args: {
          "": unknown;
        };
        Returns: number;
      };
      test_event_transition_for_exit_v2: {
        Args: {
          event_name: string;
          input_state_node_set: string[];
          fsm_name_param: string;
          fsm_version_param: string;
        };
        Returns: Json;
      };
      text2ltree: {
        Args: {
          "": string;
        };
        Returns: unknown;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database[Extract<keyof Database, "public">];

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (PublicSchema["Tables"] & PublicSchema["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (
      & Database[PublicTableNameOrOptions["schema"]]["Tables"]
      & Database[PublicTableNameOrOptions["schema"]]["Views"]
    )
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database } ? (
    & Database[PublicTableNameOrOptions["schema"]]["Tables"]
    & Database[PublicTableNameOrOptions["schema"]]["Views"]
  )[TableName] extends {
    Row: infer R;
  } ? R
  : never
  : PublicTableNameOrOptions extends keyof (
    & PublicSchema["Tables"]
    & PublicSchema["Views"]
  ) ? (
      & PublicSchema["Tables"]
      & PublicSchema["Views"]
    )[PublicTableNameOrOptions] extends {
      Row: infer R;
    } ? R
    : never
  : never;

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
    Insert: infer I;
  } ? I
  : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
      Insert: infer I;
    } ? I
    : never
  : never;

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
    Update: infer U;
  } ? U
  : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
      Update: infer U;
    } ? U
    : never
  : never;

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof PublicSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof PublicSchema["Enums"]
    ? PublicSchema["Enums"][PublicEnumNameOrOptions]
  : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof PublicSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database;
  } ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]][
      "CompositeTypes"
    ]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][
    CompositeTypeName
  ]
  : PublicCompositeTypeNameOrOptions extends
    keyof PublicSchema["CompositeTypes"]
    ? PublicSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never;
