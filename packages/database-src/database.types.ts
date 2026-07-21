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
      async_operation_instance_and_async_operation_workerlet: {
        Row: {
          async_operation_instance_and_async_operation_workerlet_id: string;
          async_operation_instance_id: string;
          async_operation_language: string;
          async_operation_name: string;
          async_operation_type: string;
          async_operation_version: string;
          async_operation_workerlet_id: string | null;
          created_at: string;
          parent_fsm_name: string;
          parent_fsm_version: string;
          scheduled_at: string | null;
          status: string;
        };
        Insert: {
          async_operation_instance_and_async_operation_workerlet_id?: string;
          async_operation_instance_id: string;
          async_operation_language: string;
          async_operation_name: string;
          async_operation_type: string;
          async_operation_version: string;
          async_operation_workerlet_id?: string | null;
          created_at?: string;
          parent_fsm_name: string;
          parent_fsm_version: string;
          scheduled_at?: string | null;
          status?: string;
        };
        Update: {
          async_operation_instance_and_async_operation_workerlet_id?: string;
          async_operation_instance_id?: string;
          async_operation_language?: string;
          async_operation_name?: string;
          async_operation_type?: string;
          async_operation_version?: string;
          async_operation_workerlet_id?: string | null;
          created_at?: string;
          parent_fsm_name?: string;
          parent_fsm_version?: string;
          scheduled_at?: string | null;
          status?: string;
        };
        Relationships: [];
      };
      async_operation_meta: {
        Row: {
          async_operation_language: string;
          async_operation_meta_id: string;
          async_operation_name: string;
          async_operation_type: string;
          async_operation_version: string;
          max_concurrency: number;
          parent_fsm_name: string;
          parent_fsm_version: string;
          updated_at: string;
          updated_by_pid: string;
        };
        Insert: {
          async_operation_language: string;
          async_operation_meta_id?: string;
          async_operation_name: string;
          async_operation_type: string;
          async_operation_version: string;
          max_concurrency?: number;
          parent_fsm_name: string;
          parent_fsm_version: string;
          updated_at?: string;
          updated_by_pid: string;
        };
        Update: {
          async_operation_language?: string;
          async_operation_meta_id?: string;
          async_operation_name?: string;
          async_operation_type?: string;
          async_operation_version?: string;
          max_concurrency?: number;
          parent_fsm_name?: string;
          parent_fsm_version?: string;
          updated_at?: string;
          updated_by_pid?: string;
        };
        Relationships: [];
      };
      async_operation_workerlet: {
        Row: {
          active_pid_number: number;
          async_operation_workerlet_id: string;
          async_operation_workerlet_pid: string;
          last_heartbeat: string;
          max_pid_number: number;
          registered_at: string;
          supported_async_operations: Json;
        };
        Insert: {
          active_pid_number?: number;
          async_operation_workerlet_id?: string;
          async_operation_workerlet_pid: string;
          last_heartbeat?: string;
          max_pid_number: number;
          registered_at?: string;
          supported_async_operations?: Json;
        };
        Update: {
          active_pid_number?: number;
          async_operation_workerlet_id?: string;
          async_operation_workerlet_pid?: string;
          last_heartbeat?: string;
          max_pid_number?: number;
          registered_at?: string;
          supported_async_operations?: Json;
        };
        Relationships: [];
      };
      fsm_dependencies: {
        Row: {
          child_fsm_name: string;
          child_fsm_version: string;
          parent_fsm_name: string;
          parent_fsm_version: string;
        };
        Insert: {
          child_fsm_name: string;
          child_fsm_version: string;
          parent_fsm_name: string;
          parent_fsm_version: string;
        };
        Update: {
          child_fsm_name?: string;
          child_fsm_version?: string;
          parent_fsm_name?: string;
          parent_fsm_version?: string;
        };
        Relationships: [];
      };
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
      fsm_instance_and_fsm_workerlet: {
        Row: {
          created_at: string;
          dispatch_type: string;
          fsm_instance_and_fsm_workerlet_id: string;
          fsm_instance_id: string;
          fsm_name: string;
          fsm_version: string;
          fsm_workerlet_id: string | null;
          scheduled_at: string | null;
          status: string;
        };
        Insert: {
          created_at?: string;
          dispatch_type?: string;
          fsm_instance_and_fsm_workerlet_id?: string;
          fsm_instance_id: string;
          fsm_name: string;
          fsm_version: string;
          fsm_workerlet_id?: string | null;
          scheduled_at?: string | null;
          status?: string;
        };
        Update: {
          created_at?: string;
          dispatch_type?: string;
          fsm_instance_and_fsm_workerlet_id?: string;
          fsm_instance_id?: string;
          fsm_name?: string;
          fsm_version?: string;
          fsm_workerlet_id?: string | null;
          scheduled_at?: string | null;
          status?: string;
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
      fsm_workerlet: {
        Row: {
          active_workers: number;
          fsm_modules: Json;
          fsm_workerlet_id: string;
          fsm_workerlet_pid: string;
          last_heartbeat: string;
          max_concurrency: number;
          registered_at: string;
        };
        Insert: {
          active_workers?: number;
          fsm_modules?: Json;
          fsm_workerlet_id?: string;
          fsm_workerlet_pid: string;
          last_heartbeat?: string;
          max_concurrency: number;
          registered_at?: string;
        };
        Update: {
          active_workers?: number;
          fsm_modules?: Json;
          fsm_workerlet_id?: string;
          fsm_workerlet_pid?: string;
          last_heartbeat?: string;
          max_concurrency?: number;
          registered_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      api_system_event_name: { Args: never; Returns: string };
      api_system_queue_type: { Args: never; Returns: string };
      api_system_queue_uuid: { Args: never; Returns: string };
      archive_event_from_fsm_promise_type_worker_v2: {
        Args: {
          input_error_message: string;
          input_event_action_type: string;
          input_event_data: Json;
          input_event_delay: number;
          input_event_name: string;
          input_event_output: Json;
          input_event_status: string;
          input_execution_duration: number;
          input_execution_finished_at: string;
          input_execution_started_at: string;
          input_promise_queue_msg_id: number;
          input_promise_queue_name: string;
          input_promise_queue_type: string;
          input_promise_queue_version: string;
          input_send_to_parent_queue_id: string;
          input_send_to_parent_queue_id_event_name: string;
        };
        Returns: Json;
      };
      archive_event_from_fsm_type_worker_v2: {
        Args: {
          fsm_instance_data_save_fsm_context: Json;
          fsm_instance_data_save_fsm_state: Json;
          fsm_instance_data_save_fsm_status: Json;
          fsm_instance_data_save_fsm_xstate_state: Json;
          input_total_promise_queue_data: Json;
          input_total_schedule_queue_data: Json;
          remove_current_queue_msg_id: number;
          remove_from_current_fsm_instance_queue_id: string;
          send_to_parent_queue_id: string;
          send_to_parent_queue_id_event_name: string;
          send_to_parent_queue_type: string;
          to_be_added_promise_queue_data: Json;
          to_be_added_schedule_queue_data: Json;
          to_be_removed_promise_queue_msg_ids: Json;
          to_be_removed_schedule_queue_msg_ids: Json;
        };
        Returns: Json;
      };
      async_operation_schedule_next_pending: {
        Args: { input_stale_threshold_seconds?: number };
        Returns: boolean;
      };
      build_nested_json_recursive: { Args: { paths: string[] }; Returns: Json };
      cancel_event_for_fsm_promise_type_worker_v2: {
        Args: { promise_type_worker_name: string; queue_msg_id: number };
        Returns: Json;
      };
      check_registry_and_working_for_async_actors_for_fsm_instance_an: {
        Args: {
          input_async_actors: Json;
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      check_registry_for_async_actors: {
        Args: {
          input_async_actors: Json;
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      claim_scheduled_for_async_operation_workerlet: {
        Args: { input_workerlet_id: string };
        Returns: Json;
      };
      claim_scheduled_for_fsmlet: {
        Args: { input_fsmlet_id: string };
        Returns: Json;
      };
      compute_child_exit_set_v1: {
        Args: { state_node_set: unknown[]; transition_domain_lca: unknown };
        Returns: string[];
      };
      compute_child_exit_set_v2: {
        Args: { state_node_set: unknown[]; transition_domain_lca: unknown };
        Returns: string[];
      };
      compute_entry_actions_v1: {
        Args: {
          fsm_name_param: string;
          fsm_version_param: string;
          is_initial_transition: boolean;
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
        };
        Returns: Json;
      };
      compute_entry_actions_v2: {
        Args: {
          fsm_name_param: string;
          fsm_version_param: string;
          is_initial_transition: boolean;
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
        };
        Returns: Json;
      };
      compute_exit_actions_v1: {
        Args: {
          p_fsm_name: string;
          p_fsm_version: string;
          p_state_node_set: string[];
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
        };
        Returns: Json;
      };
      compute_exit_actions_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_state_node_set: string[];
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
        };
        Returns: Json;
      };
      compute_full_exit_set_v1: {
        Args: {
          state_node_set: string[];
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
        };
        Returns: string[];
      };
      compute_full_exit_set_v2: {
        Args: {
          state_node_set: string[];
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
        };
        Returns: string[];
      };
      create_async_operation_instance_and_notify_async_operation_sche: {
        Args: {
          input_async_operation_instance_id: string;
          input_async_operation_language: string;
          input_async_operation_name: string;
          input_async_operation_type: string;
          input_async_operation_version: string;
          input_parent_fsm_name: string;
          input_parent_fsm_version: string;
        };
        Returns: undefined;
      };
      create_fsm_instance_from_name_v2: {
        Args: {
          create_pgmq_queue?: boolean;
          input_fsm_context: Json;
          input_fsm_name: string;
          input_fsm_version: string;
        };
        Returns: Json;
      };
      create_fsm_queue_and_send_event_from_fsm_instance_id_v2: {
        Args: {
          action_type: string;
          event_input: Json;
          event_name: string;
          from_source_fsm_instance_id: string;
          fsmname: string;
          fsmtype: string;
          fsmversion: string;
          id: string;
          parentfsmname: string;
          parentfsmversion: string;
          src: string;
        };
        Returns: Json;
      };
      create_promise_queue_and_send_event_from_fsm_instance_id_v2: {
        Args: {
          action_type: string;
          event_input: Json;
          event_name: string;
          from_source_fsm_instance_id: string;
          fsmname: string;
          fsmtype: string;
          fsmversion: string;
          id: string;
          parentfsmname: string;
          parentfsmversion: string;
          src: string;
        };
        Returns: Json;
      };
      enqueue_fsm_dispatch_v1: {
        Args: {
          input_dispatch_type?: string;
          input_fsm_name: string;
          input_fsm_version: string;
          input_instance_id: string;
        };
        Returns: undefined;
      };
      enqueue_fsm_dispatch_v2: {
        Args: {
          input_dispatch_type?: string;
          input_fsm_name: string;
          input_fsm_version: string;
          input_instance_id: string;
        };
        Returns: undefined;
      };
      fsm_get_all_state_nodes_v1: {
        Args: {
          p_fsm_name: string;
          p_fsm_version: string;
          p_state_paths: string[];
        };
        Returns: string[];
      };
      fsm_get_all_state_nodes_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_state_paths: string[];
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
      fsm_json_schema: { Args: never; Returns: Json };
      fsm_worker_v1: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          p_state_value: Json;
        };
        Returns: Json;
      };
      fsm_worker_v2: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          input_state_value: Json;
        };
        Returns: Json;
      };
      get_ancestor_states_for_entry_v1: {
        Args: {
          ancestors: string[];
          fsm_name_param: string;
          fsm_version_param: string;
          reentrancy_domain: string;
        };
        Returns:
          Database["fsm_core"]["CompositeTypes"]["ancestor_states_result_v1"];
        SetofOptions: {
          from: "*";
          to: "ancestor_states_result_v1";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      get_ancestor_states_for_entry_v2: {
        Args: {
          ancestors: string[];
          fsm_name_param: string;
          fsm_version_param: string;
          reentrancy_domain: string;
        };
        Returns:
          Database["fsm_core"]["CompositeTypes"]["ancestor_states_result_v2"];
        SetofOptions: {
          from: "*";
          to: "ancestor_states_result_v2";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      get_descendant_states_for_entry_v1: {
        Args: {
          fsm_name_param: string;
          fsm_version_param: string;
          input_state_id: string;
        };
        Returns:
          Database["fsm_core"]["CompositeTypes"]["descendant_states_result_v1"];
        SetofOptions: {
          from: "*";
          to: "descendant_states_result_v1";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      get_descendant_states_for_entry_v2: {
        Args: {
          fsm_name_param: string;
          fsm_version_param: string;
          input_state_id: string;
        };
        Returns:
          Database["fsm_core"]["CompositeTypes"]["descendant_states_result_v2"];
        SetofOptions: {
          from: "*";
          to: "descendant_states_result_v2";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      get_entry_actions_v1: {
        Args: {
          p_fsm_name: string;
          p_fsm_version: string;
          p_state_paths: string[];
        };
        Returns: Json;
      };
      get_entry_actions_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_state_paths: string[];
        };
        Returns: Json;
      };
      get_exit_actions_v1: {
        Args: {
          p_fsm_name: string;
          p_fsm_version: string;
          p_state_paths: string[];
        };
        Returns: Json;
      };
      get_exit_actions_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_state_paths: string[];
        };
        Returns: Json;
      };
      get_fsm_data_resolve_state_value_v2: {
        Args: { input_fsm_id: string };
        Returns: Json;
      };
      get_initial_actions_v1: {
        Args: {
          p_fsm_name: string;
          p_fsm_version: string;
          p_state_paths: string[];
        };
        Returns: Json;
      };
      get_initial_actions_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_state_paths: string[];
        };
        Returns: Json;
      };
      get_proper_ancestors: {
        Args: { state_path_ltree: string; to_state_path_ltree: string };
        Returns: string[];
      };
      get_proper_ancestors_ltree: {
        Args: { state_path_ltree: unknown; to_state_path_ltree: unknown };
        Returns: unknown[];
      };
      hello: { Args: { input_text: string }; Returns: undefined };
      hello_niraj: { Args: { input_text: string }; Returns: undefined };
      insert_fsm_dependencies: {
        Args: {
          p_dependent_children: Json;
          p_parent_name: string;
          p_parent_version: string;
        };
        Returns: undefined;
      };
      json_matches_schema: {
        Args: { instance: Json; schema: Json };
        Returns: boolean;
      };
      jsonb_all_paths: {
        Args: { j: Json; prefix?: string };
        Returns: string[];
      };
      jsonb_deep_merge: { Args: { a: Json; b: Json }; Returns: Json };
      jsonb_matches_schema: {
        Args: { instance: Json; schema: Json };
        Returns: boolean;
      };
      jsonschema_is_valid: { Args: { schema: Json }; Returns: boolean };
      jsonschema_validation_errors: {
        Args: { instance: Json; schema: Json };
        Returns: string[];
      };
      load_async_operation_meta_v2: {
        Args: {
          input_async_operation_language: string;
          input_async_operation_name: string;
          input_async_operation_type: string;
          input_async_operation_version: string;
          input_parent_fsm_name: string;
          input_parent_fsm_version: string;
          input_updated_by_pid: string;
        };
        Returns: Json;
      };
      load_fsm_from_json_v2: {
        Args: {
          input_dependent_children?: Json;
          input_fsm_name: string;
          input_fsm_type: string;
          input_fsm_version: string;
          json_input: Json;
          root_node_text: string;
        };
        Returns: Json;
      };
      load_fsm_state_from_json_v1: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          json_input: Json;
          root_node_text: string;
        };
        Returns: Json;
      };
      load_fsm_state_from_json_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          json_input: Json;
          root_node_text: string;
        };
        Returns: Json;
      };
      load_fsm_transition_from_json_v1: {
        Args: {
          fsm_name: string;
          fsm_version: string;
          json_input: Json;
          root_node_text: string;
        };
        Returns: Json;
      };
      load_fsm_transition_from_json_v2: {
        Args: {
          fsm_name: string;
          fsm_version: string;
          json_input: Json;
          root_node_text: string;
        };
        Returns: Json;
      };
      lock_fsm_instance: {
        Args: { input_fsm_instance_id: string; input_locked_by: string };
        Returns: boolean;
      };
      macrostep_v1: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          p_state_value: string[];
        };
        Returns: Json;
      };
      macrostep_v2: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          input_state_value: string[];
        };
        Returns: Json;
      };
      microstep_v1: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          state_value_node_set: string[];
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
        };
        Returns: Json;
      };
      microstep_v2: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          state_value_node_set: string[];
          transition_record:
            Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"];
        };
        Returns: Json;
      };
      path_string_to_jsonb: { Args: { path: string }; Returns: Json };
      pg_advisory_unlock:
        | { Args: { key: number }; Returns: boolean }
        | { Args: { key1: number; key2: number }; Returns: boolean };
      pg_system_event_name: { Args: never; Returns: string };
      pg_system_queue_type: { Args: never; Returns: string };
      pg_system_queue_uuid: { Args: never; Returns: string };
      pg_try_advisory_lock:
        | { Args: { key: number }; Returns: boolean }
        | { Args: { key1: number; key2: number }; Returns: boolean };
      remove_hashtag_from_text: {
        Args: { input_text: string };
        Returns: string;
      };
      resolve_state_value_v1: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_json: Json;
        };
        Returns: Json;
      };
      resolve_state_value_v2: {
        Args: {
          input_fsm_name: string;
          input_fsm_version: string;
          input_json: Json;
        };
        Returns: Json;
      };
      resume_event_for_fsm_worker_v2: {
        Args: { input_fsm_instance_id: string };
        Returns: Json;
      };
      sanitize_text_array_to_ltree_array: {
        Args: { input_array: string[] };
        Returns: unknown[];
      };
      sanitize_text_array_to_ltree_text_array: {
        Args: { input_array: string[] };
        Returns: string[];
      };
      sanitize_text_to_ltree: {
        Args: { input_text: string };
        Returns: unknown;
      };
      schedule_next_pending: {
        Args: { input_stale_threshold_seconds?: number };
        Returns: boolean;
      };
      select_all_transitions_v1: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          p_state_value: string[];
        };
        Returns: Json;
      };
      select_all_transitions_v2: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          input_state_value: string[];
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
        SetofOptions: {
          from: "*";
          to: "fsm_transitions";
          isOneToOne: false;
          isSetofReturn: true;
        };
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
        SetofOptions: {
          from: "*";
          to: "fsm_transitions";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      send_event_to_fsm_queue_with_event_logs_v2: {
        Args: {
          input_error_message?: string;
          input_event_action_type: string;
          input_event_data: Json;
          input_event_delay?: number;
          input_event_name: string;
          input_event_output?: Json;
          input_event_status?: string;
          input_execution_duration?: number;
          input_execution_finished_at?: string;
          input_execution_started_at?: string;
          input_fsm_instance_id: string;
          input_fsm_instance_id_fsm_type: string;
          input_fsm_instance_id_fsm_version: string;
          input_send_to_parent_queue_id: string;
          input_send_to_parent_queue_id_event_name: string;
          input_send_to_parent_queue_type: string;
        };
        Returns: Json;
      };
      send_event_to_promise_queue_with_event_logs_v2: {
        Args: {
          input_error_message?: string;
          input_event_action_type: string;
          input_event_data: Json;
          input_event_delay?: number;
          input_event_name: string;
          input_event_output?: Json;
          input_event_status?: string;
          input_execution_duration?: number;
          input_execution_finished_at?: string;
          input_execution_started_at?: string;
          input_promise_fn_name: string;
          input_promise_queue_name: string;
          input_promise_queue_type: string;
          input_promise_queue_version: string;
          input_send_to_parent_queue_id: string;
          input_send_to_parent_queue_id_event_name: string;
          input_send_to_parent_queue_type: string;
        };
        Returns: Json;
      };
      send_event_to_queue_from_fsm_instance_id_v2: {
        Args: {
          action_type: string;
          event_input: Json;
          event_name: string;
          from_source_fsm_instance_id: string;
          fsmname: string;
          fsmtype: string;
          fsmversion: string;
          id: string;
          parentfsmname: string;
          parentfsmversion: string;
          src: string;
        };
        Returns: Json;
      };
      sql_lca_for_transition: { Args: { transition: Json }; Returns: unknown };
      sql_lca_from_array: { Args: { paths: unknown[] }; Returns: unknown };
      stop_event_for_fsm_worker_v1: {
        Args: { input_fsm_instance_id: string };
        Returns: Json;
      };
      stop_event_for_fsm_worker_v2: {
        Args: { input_fsm_instance_id: string };
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
        Args: { input_jsonb: Json };
        Returns: {
          original: Json;
          paths: string[];
          reconstructed: Json;
        }[];
      };
      unlock_fsm_instance: {
        Args: { input_fsm_instance_id: string };
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
      _belongs_to_pgmq: { Args: { table_name: string }; Returns: boolean };
      _ensure_pg_partman_installed: { Args: never; Returns: undefined };
      _get_partition_col: {
        Args: { partition_interval: string };
        Returns: string;
      };
      _get_pg_partman_major_version: { Args: never; Returns: number };
      _get_pg_partman_schema: { Args: never; Returns: string };
      archive:
        | { Args: { msg_id: number; queue_name: string }; Returns: boolean }
        | {
          Args: { msg_ids: number[]; queue_name: string };
          Returns: number[];
        };
      convert_archive_partitioned: {
        Args: {
          leading_partition?: number;
          partition_interval?: string;
          retention_interval?: string;
          table_name: string;
        };
        Returns: undefined;
      };
      create: { Args: { queue_name: string }; Returns: undefined };
      create_non_partitioned: {
        Args: { queue_name: string };
        Returns: undefined;
      };
      create_partitioned: {
        Args: {
          partition_interval?: string;
          queue_name: string;
          retention_interval?: string;
        };
        Returns: undefined;
      };
      create_unlogged: { Args: { queue_name: string }; Returns: undefined };
      delete:
        | { Args: { msg_id: number; queue_name: string }; Returns: boolean }
        | {
          Args: { msg_ids: number[]; queue_name: string };
          Returns: number[];
        };
      detach_archive: { Args: { queue_name: string }; Returns: undefined };
      drop_queue: { Args: { queue_name: string }; Returns: boolean };
      format_table_name: {
        Args: { prefix: string; queue_name: string };
        Returns: string;
      };
      list_queues: {
        Args: never;
        Returns: Database["pgmq"]["CompositeTypes"]["queue_record"][];
        SetofOptions: {
          from: "*";
          to: "queue_record";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      metrics: {
        Args: { queue_name: string };
        Returns: Database["pgmq"]["CompositeTypes"]["metrics_result"];
        SetofOptions: {
          from: "*";
          to: "metrics_result";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      metrics_all: {
        Args: never;
        Returns: Database["pgmq"]["CompositeTypes"]["metrics_result"][];
        SetofOptions: {
          from: "*";
          to: "metrics_result";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      pop: {
        Args: { queue_name: string };
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][];
        SetofOptions: {
          from: "*";
          to: "message_record";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      purge_queue: { Args: { queue_name: string }; Returns: number };
      read: {
        Args: { qty: number; queue_name: string; vt: number };
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][];
        SetofOptions: {
          from: "*";
          to: "message_record";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      read_with_poll: {
        Args: {
          max_poll_seconds?: number;
          poll_interval_ms?: number;
          qty: number;
          queue_name: string;
          vt: number;
        };
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][];
        SetofOptions: {
          from: "*";
          to: "message_record";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      send: {
        Args: { delay?: number; msg: Json; queue_name: string };
        Returns: number[];
      };
      send_batch: {
        Args: { delay?: number; msgs: Json[]; queue_name: string };
        Returns: number[];
      };
      set_vt: {
        Args: { msg_id: number; queue_name: string; vt: number };
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][];
        SetofOptions: {
          from: "*";
          to: "message_record";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      validate_queue_name: { Args: { queue_name: string }; Returns: undefined };
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
      test_event_transition_for_exit_v2: {
        Args: {
          event_name: string;
          fsm_name_param: string;
          fsm_version_param: string;
          input_state_node_set: string[];
        };
        Returns: Json;
      };
      text2ltree: { Args: { "": string }; Returns: unknown };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema =
  DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  } ? keyof (
      & DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]][
        "Tables"
      ]
      & DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]][
        "Views"
      ]
    )
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
} ? (
    & DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]][
      "Tables"
    ]
    & DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]][
      "Views"
    ]
  )[TableName] extends {
    Row: infer R;
  } ? R
  : never
  : DefaultSchemaTableNameOrOptions extends keyof (
    & DefaultSchema["Tables"]
    & DefaultSchema["Views"]
  ) ? (
      & DefaultSchema["Tables"]
      & DefaultSchema["Views"]
    )[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R;
    } ? R
    : never
  : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  } ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]][
      "Tables"
    ]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
} ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]][
    "Tables"
  ][TableName] extends {
    Insert: infer I;
  } ? I
  : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I;
    } ? I
    : never
  : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  } ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]][
      "Tables"
    ]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
} ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]][
    "Tables"
  ][TableName] extends {
    Update: infer U;
  } ? U
  : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U;
    } ? U
    : never
  : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  } ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]][
      "Enums"
    ]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
} ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][
    EnumName
  ]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  } ? keyof DatabaseWithoutInternals[
      PublicCompositeTypeNameOrOptions["schema"]
    ]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
} ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]][
    "CompositeTypes"
  ][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never;

export const Constants = {
  fsm_core: {
    Enums: {
      fsm_state_type: ["atomic", "compound", "parallel", "final", "history"],
    },
  },
  pgmq: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
