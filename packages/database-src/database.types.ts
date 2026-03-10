export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  fsm_core: {
    Tables: {
      fsm_states: {
        Row: {
          computed_state_id_ltree: unknown
          computed_state_key_ltree: unknown
          context: Json | null
          data: Json | null
          description: string | null
          entry: Json | null
          exit: Json | null
          fsm_name: string | null
          fsm_on: Json | null
          fsm_order: number | null
          fsm_version: string | null
          history: string | null
          id: string
          initial: Json | null
          invoke: Json | null
          key: string
          parent_node: string | null
          state_id_with_fsm_name_and_fsm_version: string
          states: Json | null
          transitions: Json | null
          type: Database["fsm_core"]["Enums"]["fsm_state_type"]
        }
        Insert: {
          computed_state_id_ltree: unknown
          computed_state_key_ltree: unknown
          context?: Json | null
          data?: Json | null
          description?: string | null
          entry?: Json | null
          exit?: Json | null
          fsm_name?: string | null
          fsm_on?: Json | null
          fsm_order?: number | null
          fsm_version?: string | null
          history?: string | null
          id: string
          initial?: Json | null
          invoke?: Json | null
          key: string
          parent_node?: string | null
          state_id_with_fsm_name_and_fsm_version: string
          states?: Json | null
          transitions?: Json | null
          type: Database["fsm_core"]["Enums"]["fsm_state_type"]
        }
        Update: {
          computed_state_id_ltree?: unknown
          computed_state_key_ltree?: unknown
          context?: Json | null
          data?: Json | null
          description?: string | null
          entry?: Json | null
          exit?: Json | null
          fsm_name?: string | null
          fsm_on?: Json | null
          fsm_order?: number | null
          fsm_version?: string | null
          history?: string | null
          id?: string
          initial?: Json | null
          invoke?: Json | null
          key?: string
          parent_node?: string | null
          state_id_with_fsm_name_and_fsm_version?: string
          states?: Json | null
          transitions?: Json | null
          type?: Database["fsm_core"]["Enums"]["fsm_state_type"]
        }
        Relationships: []
      }
      fsm_transitions: {
        Row: {
          actions: Json | null
          computed_sanitized_source_ltree: unknown
          computed_sanitized_target_ltree_array: unknown[] | null
          computed_transition_domain_lca: string | null
          cond: Json | null
          event_type: string
          fsm_name: string | null
          fsm_version: string | null
          id: number
          reenter: boolean | null
          source: string
          target: string[] | null
        }
        Insert: {
          actions?: Json | null
          computed_sanitized_source_ltree: unknown
          computed_sanitized_target_ltree_array?: unknown[] | null
          computed_transition_domain_lca?: string | null
          cond?: Json | null
          event_type: string
          fsm_name?: string | null
          fsm_version?: string | null
          id?: number
          reenter?: boolean | null
          source: string
          target?: string[] | null
        }
        Update: {
          actions?: Json | null
          computed_sanitized_source_ltree?: unknown
          computed_sanitized_target_ltree_array?: unknown[] | null
          computed_transition_domain_lca?: string | null
          cond?: Json | null
          event_type?: string
          fsm_name?: string | null
          fsm_version?: string | null
          id?: number
          reenter?: boolean | null
          source?: string
          target?: string[] | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      archive:
        | {
            Args: {
              queue_name: string
              message_id: number
            }
            Returns: boolean
          }
        | {
            Args: {
              queue_name: string
              message_ids: number[]
            }
            Returns: number[]
          }
      build_nested_json_recursive: {
        Args: {
          paths: string[]
        }
        Returns: Json
      }
      compute_child_exit_set_v1: {
        Args: {
          transition_domain_lca: unknown
          state_node_set: unknown[]
        }
        Returns: string[]
      }
      compute_child_exit_set_v2: {
        Args: {
          transition_domain_lca: unknown
          state_node_set: unknown[]
        }
        Returns: string[]
      }
      compute_entry_actions_v1: {
        Args: {
          transition_record: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
          fsm_name_param: string
          fsm_version_param: string
          is_initial_transition: boolean
        }
        Returns: Json
      }
      compute_entry_actions_v2: {
        Args: {
          transition_record: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
          fsm_name_param: string
          fsm_version_param: string
          is_initial_transition: boolean
        }
        Returns: Json
      }
      compute_exit_actions_v1: {
        Args: {
          transition_record: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
          p_state_node_set: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: Json
      }
      compute_exit_actions_v2: {
        Args: {
          transition_record: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
          p_state_node_set: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: Json
      }
      compute_full_exit_set_v1: {
        Args: {
          transition_record: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
          state_node_set: string[]
        }
        Returns: string[]
      }
      compute_full_exit_set_v2: {
        Args: {
          transition_record: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
          state_node_set: string[]
        }
        Returns: string[]
      }
      create: {
        Args: {
          queue_name: string
        }
        Returns: undefined
      }
      delete:
        | {
            Args: {
              queue_name: string
              message_id: number
            }
            Returns: boolean
          }
        | {
            Args: {
              queue_name: string
              message_ids: number[]
            }
            Returns: number[]
          }
      drop_queue: {
        Args: {
          queue_name: string
        }
        Returns: boolean
      }
      fsm_get_all_state_nodes_v1: {
        Args: {
          p_state_paths: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: string[]
      }
      fsm_get_all_state_nodes_v2: {
        Args: {
          p_state_paths: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: string[]
      }
      fsm_get_initial_state_nodes_v1: {
        Args: {
          p_fsm_name: string
          p_fsm_version: string
          p_state_path: unknown
        }
        Returns: string[]
      }
      fsm_get_initial_state_nodes_v2: {
        Args: {
          p_fsm_name: string
          p_fsm_version: string
          p_state_path: unknown
        }
        Returns: string[]
      }
      fsm_get_initial_state_nodes_with_ancestors_v1: {
        Args: {
          p_fsm_name: string
          p_fsm_version: string
          p_state_path: unknown
        }
        Returns: string[]
      }
      fsm_get_initial_state_nodes_with_ancestors_v2: {
        Args: {
          p_fsm_name: string
          p_fsm_version: string
          p_state_path: unknown
        }
        Returns: string[]
      }
      fsm_worker_v1: {
        Args: {
          event_name: string
          p_state_value: Json
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      fsm_worker_v2: {
        Args: {
          event_name: string
          p_state_value: Json
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      get_ancestor_states_for_entry_v1: {
        Args: {
          ancestors: string[]
          reentrancy_domain: string
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Database["fsm_core"]["CompositeTypes"]["ancestor_states_result_v1"]
      }
      get_ancestor_states_for_entry_v2: {
        Args: {
          ancestors: string[]
          reentrancy_domain: string
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Database["fsm_core"]["CompositeTypes"]["ancestor_states_result_v2"]
      }
      get_descendant_states_for_entry_v1: {
        Args: {
          input_state_id: string
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Database["fsm_core"]["CompositeTypes"]["descendant_states_result_v1"]
      }
      get_descendant_states_for_entry_v2: {
        Args: {
          input_state_id: string
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Database["fsm_core"]["CompositeTypes"]["descendant_states_result_v2"]
      }
      get_entry_actions_v1: {
        Args: {
          p_state_paths: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: Json
      }
      get_entry_actions_v2: {
        Args: {
          p_state_paths: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: Json
      }
      get_exit_actions_v1: {
        Args: {
          p_state_paths: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: Json
      }
      get_exit_actions_v2: {
        Args: {
          p_state_paths: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: Json
      }
      get_initial_actions_v1: {
        Args: {
          p_state_paths: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: Json
      }
      get_initial_actions_v2: {
        Args: {
          p_state_paths: string[]
          p_fsm_name: string
          p_fsm_version: string
        }
        Returns: Json
      }
      get_proper_ancestors: {
        Args: {
          state_path_ltree: string
          to_state_path_ltree: string
        }
        Returns: string[]
      }
      get_proper_ancestors_ltree: {
        Args: {
          state_path_ltree: unknown
          to_state_path_ltree: unknown
        }
        Returns: unknown[]
      }
      hello: {
        Args: {
          input_text: string
        }
        Returns: undefined
      }
      jsonb_all_paths: {
        Args: {
          j: Json
          prefix?: string
        }
        Returns: string[]
      }
      jsonb_deep_merge: {
        Args: {
          a: Json
          b: Json
        }
        Returns: Json
      }
      list_queues: {
        Args: Record<PropertyKey, never>
        Returns: Database["pgmq"]["CompositeTypes"]["queue_record"][]
      }
      load_fsm_state_from_json_v1: {
        Args: {
          json_input: Json
          root_node_text: string
          input_fsm_name: string
          input_fsm_version: string
        }
        Returns: Json
      }
      load_fsm_state_from_json_v2: {
        Args: {
          json_input: Json
          root_node_text: string
          input_fsm_name: string
          input_fsm_version: string
        }
        Returns: Json
      }
      load_fsm_transition_from_json_v1: {
        Args: {
          json_input: Json
          root_node_text: string
          fsm_name: string
          fsm_version: string
        }
        Returns: Json
      }
      load_fsm_transition_from_json_v2: {
        Args: {
          json_input: Json
          root_node_text: string
          fsm_name: string
          fsm_version: string
        }
        Returns: Json
      }
      macrostep_v1: {
        Args: {
          event_name: string
          p_state_value: string[]
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      macrostep_v2: {
        Args: {
          event_name: string
          p_state_value: string[]
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      microstep_v1: {
        Args: {
          transition_record: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
          event_name: string
          state_value_node_set: string[]
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      microstep_v2: {
        Args: {
          transition_record: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"]
          event_name: string
          state_value_node_set: string[]
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      path_string_to_jsonb: {
        Args: {
          path: string
        }
        Returns: Json
      }
      pg_advisory_unlock:
        | {
            Args: {
              key: number
            }
            Returns: boolean
          }
        | {
            Args: {
              key1: number
              key2: number
            }
            Returns: boolean
          }
      pg_try_advisory_lock:
        | {
            Args: {
              key: number
            }
            Returns: boolean
          }
        | {
            Args: {
              key1: number
              key2: number
            }
            Returns: boolean
          }
      pop: {
        Args: {
          queue_name: string
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      purge_queue: {
        Args: {
          queue_name: string
        }
        Returns: number[]
      }
      read: {
        Args: {
          queue_name: string
          vt: number
          qty: number
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      remove_hashtag_from_text: {
        Args: {
          input_text: string
        }
        Returns: string
      }
      resolve_state_value_v1: {
        Args: {
          input_json: Json
          input_fsm_name: string
          input_fsm_version: string
        }
        Returns: Json
      }
      resolve_state_value_v2: {
        Args: {
          input_json: Json
          input_fsm_name: string
          input_fsm_version: string
        }
        Returns: Json
      }
      sanitize_text_array_to_ltree_array: {
        Args: {
          input_array: string[]
        }
        Returns: unknown[]
      }
      sanitize_text_array_to_ltree_text_array: {
        Args: {
          input_array: string[]
        }
        Returns: string[]
      }
      sanitize_text_to_ltree: {
        Args: {
          input_text: string
        }
        Returns: unknown
      }
      select_all_transitions_v1: {
        Args: {
          event_name: string
          p_state_value: string[]
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      select_all_transitions_v2: {
        Args: {
          event_name: string
          p_state_value: string[]
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      select_transitions_with_guard_eval_v1: {
        Args: {
          input_all_transitions: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"][]
        }
        Returns: {
          actions: Json | null
          computed_sanitized_source_ltree: unknown
          computed_sanitized_target_ltree_array: unknown[] | null
          computed_transition_domain_lca: string | null
          cond: Json | null
          event_type: string
          fsm_name: string | null
          fsm_version: string | null
          id: number
          reenter: boolean | null
          source: string
          target: string[] | null
        }[]
      }
      select_transitions_with_guard_eval_v2: {
        Args: {
          input_all_transitions: Database["fsm_core"]["Tables"]["fsm_transitions"]["Row"][]
        }
        Returns: {
          actions: Json | null
          computed_sanitized_source_ltree: unknown
          computed_sanitized_target_ltree_array: unknown[] | null
          computed_transition_domain_lca: string | null
          cond: Json | null
          event_type: string
          fsm_name: string | null
          fsm_version: string | null
          id: number
          reenter: boolean | null
          source: string
          target: string[] | null
        }[]
      }
      send: {
        Args: {
          queue_name: string
          msg: Json
          delay?: number
        }
        Returns: number[]
      }
      set_vt: {
        Args: {
          queue_name: string
          message_id: number
          vt_offset: number
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      sql_lca_for_transition: {
        Args: {
          transition: Json
        }
        Returns: unknown
      }
      sql_lca_from_array: {
        Args: {
          paths: unknown[]
        }
        Returns: unknown
      }
      test_event_transition_for_entry_v1: {
        Args: {
          event_name: string
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      test_event_transition_for_entry_v2: {
        Args: {
          event_name: string
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      test_jsonb_roundtrip: {
        Args: {
          input_jsonb: Json
        }
        Returns: {
          original: Json
          reconstructed: Json
          paths: string[]
        }[]
      }
    }
    Enums: {
      fsm_state_type: "atomic" | "compound" | "parallel" | "final" | "history"
    }
    CompositeTypes: {
      ancestor_states_result_v1: {
        ancestor_states_to_enter: string[] | null
        ancestor_states_for_default_entry: string[] | null
      }
      ancestor_states_result_v2: {
        ancestor_states_to_enter: string[] | null
        ancestor_states_for_default_entry: string[] | null
      }
      descendant_states_result_v1: {
        descendant_states_to_enter: string[] | null
        descendant_states_for_default_entry: string[] | null
      }
      descendant_states_result_v2: {
        descendant_states_to_enter: string[] | null
        descendant_states_for_default_entry: string[] | null
      }
    }
  }
  pgmq: {
    Tables: {
      meta: {
        Row: {
          created_at: string
          is_partitioned: boolean
          is_unlogged: boolean
          queue_name: string
        }
        Insert: {
          created_at?: string
          is_partitioned: boolean
          is_unlogged: boolean
          queue_name: string
        }
        Update: {
          created_at?: string
          is_partitioned?: boolean
          is_unlogged?: boolean
          queue_name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _belongs_to_pgmq: {
        Args: {
          table_name: string
        }
        Returns: boolean
      }
      _ensure_pg_partman_installed: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      _get_partition_col: {
        Args: {
          partition_interval: string
        }
        Returns: string
      }
      _get_pg_partman_major_version: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      _get_pg_partman_schema: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      archive:
        | {
            Args: {
              queue_name: string
              msg_id: number
            }
            Returns: boolean
          }
        | {
            Args: {
              queue_name: string
              msg_ids: number[]
            }
            Returns: number[]
          }
      convert_archive_partitioned: {
        Args: {
          table_name: string
          partition_interval?: string
          retention_interval?: string
          leading_partition?: number
        }
        Returns: undefined
      }
      create: {
        Args: {
          queue_name: string
        }
        Returns: undefined
      }
      create_non_partitioned: {
        Args: {
          queue_name: string
        }
        Returns: undefined
      }
      create_partitioned: {
        Args: {
          queue_name: string
          partition_interval?: string
          retention_interval?: string
        }
        Returns: undefined
      }
      create_unlogged: {
        Args: {
          queue_name: string
        }
        Returns: undefined
      }
      delete:
        | {
            Args: {
              queue_name: string
              msg_id: number
            }
            Returns: boolean
          }
        | {
            Args: {
              queue_name: string
              msg_ids: number[]
            }
            Returns: number[]
          }
      detach_archive: {
        Args: {
          queue_name: string
        }
        Returns: undefined
      }
      drop_queue: {
        Args: {
          queue_name: string
        }
        Returns: boolean
      }
      format_table_name: {
        Args: {
          queue_name: string
          prefix: string
        }
        Returns: string
      }
      list_queues: {
        Args: Record<PropertyKey, never>
        Returns: Database["pgmq"]["CompositeTypes"]["queue_record"][]
      }
      metrics: {
        Args: {
          queue_name: string
        }
        Returns: Database["pgmq"]["CompositeTypes"]["metrics_result"]
      }
      metrics_all: {
        Args: Record<PropertyKey, never>
        Returns: Database["pgmq"]["CompositeTypes"]["metrics_result"][]
      }
      pop: {
        Args: {
          queue_name: string
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      purge_queue: {
        Args: {
          queue_name: string
        }
        Returns: number
      }
      read: {
        Args: {
          queue_name: string
          vt: number
          qty: number
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      read_with_poll: {
        Args: {
          queue_name: string
          vt: number
          qty: number
          max_poll_seconds?: number
          poll_interval_ms?: number
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      send: {
        Args: {
          queue_name: string
          msg: Json
          delay?: number
        }
        Returns: number[]
      }
      send_batch: {
        Args: {
          queue_name: string
          msgs: Json[]
          delay?: number
        }
        Returns: number[]
      }
      set_vt: {
        Args: {
          queue_name: string
          msg_id: number
          vt: number
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      validate_queue_name: {
        Args: {
          queue_name: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      message_record: {
        msg_id: number | null
        read_ct: number | null
        enqueued_at: string | null
        vt: string | null
        message: Json | null
      }
      metrics_result: {
        queue_name: string | null
        queue_length: number | null
        newest_msg_age_sec: number | null
        oldest_msg_age_sec: number | null
        total_messages: number | null
        scrape_time: string | null
      }
      queue_record: {
        queue_name: string | null
        is_partitioned: boolean | null
        is_unlogged: boolean | null
        created_at: string | null
      }
    }
  }
  public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _ltree_compress: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      _ltree_gist_options: {
        Args: {
          "": unknown
        }
        Returns: undefined
      }
      archive:
        | {
            Args: {
              queue_name: string
              message_id: number
            }
            Returns: boolean
          }
        | {
            Args: {
              queue_name: string
              message_ids: number[]
            }
            Returns: number[]
          }
      create: {
        Args: {
          queue_name: string
        }
        Returns: undefined
      }
      delete:
        | {
            Args: {
              queue_name: string
              message_id: number
            }
            Returns: boolean
          }
        | {
            Args: {
              queue_name: string
              message_ids: number[]
            }
            Returns: number[]
          }
      drop_queue: {
        Args: {
          queue_name: string
        }
        Returns: boolean
      }
      lca: {
        Args: {
          "": unknown[]
        }
        Returns: unknown
      }
      list_queues: {
        Args: Record<PropertyKey, never>
        Returns: Database["pgmq"]["CompositeTypes"]["queue_record"][]
      }
      lquery_in: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      lquery_out: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      lquery_recv: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      lquery_send: {
        Args: {
          "": unknown
        }
        Returns: string
      }
      ltree_compress: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltree_decompress: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltree_gist_in: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltree_gist_options: {
        Args: {
          "": unknown
        }
        Returns: undefined
      }
      ltree_gist_out: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltree_in: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltree_out: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltree_recv: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltree_send: {
        Args: {
          "": unknown
        }
        Returns: string
      }
      ltree2text: {
        Args: {
          "": unknown
        }
        Returns: string
      }
      ltxtq_in: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltxtq_out: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltxtq_recv: {
        Args: {
          "": unknown
        }
        Returns: unknown
      }
      ltxtq_send: {
        Args: {
          "": unknown
        }
        Returns: string
      }
      nlevel: {
        Args: {
          "": unknown
        }
        Returns: number
      }
      pop: {
        Args: {
          queue_name: string
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      purge_queue: {
        Args: {
          queue_name: string
        }
        Returns: number[]
      }
      read: {
        Args: {
          queue_name: string
          vt: number
          qty: number
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      send: {
        Args: {
          queue_name: string
          msg: Json
          delay?: number
        }
        Returns: number[]
      }
      set_vt: {
        Args: {
          queue_name: string
          message_id: number
          vt_offset: number
        }
        Returns: Database["pgmq"]["CompositeTypes"]["message_record"][]
      }
      test_event_transition_for_exit_v2: {
        Args: {
          event_name: string
          p_state_node_set: string[]
          fsm_name_param: string
          fsm_version_param: string
        }
        Returns: Json
      }
      text2ltree: {
        Args: {
          "": string
        }
        Returns: unknown
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (PublicSchema["Tables"] & PublicSchema["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (PublicSchema["Tables"] &
        PublicSchema["Views"])
    ? (PublicSchema["Tables"] &
        PublicSchema["Views"])[PublicTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

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
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof PublicSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof PublicSchema["CompositeTypes"]
    ? PublicSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

