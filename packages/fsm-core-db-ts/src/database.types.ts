// deno-lint-ignore no-unused-vars
import type { MergeDeep } from "type-fest";
import type { Database as DatabaseGenerated } from "../../../packages/database-src/database.types.ts";
import type { Json as JsonGenerated } from "../../../packages/database-src/database.types.ts";

// TODO: narrow this back to just `JsonGenerated`. The `| any` is a temporary
// escape hatch for callers passing values the Supabase-generated Json type
// can't yet express (e.g. arbitrary payloads before we tighten the FSM
// schemas); remove once those call sites are typed properly.
// deno-lint-ignore no-explicit-any
export type Json = JsonGenerated | any;
export type Database = DatabaseGenerated;

// Override the type for a specific column in a view:
// export type Database = MergeDeep<
//   DatabaseGenerated,
//   {
//     public: {
//       Views: {
//         movies_view: {
//           Row: {
//             // id is a primary key in public.movies, so it must be `not null`
//             id: number
//           }
//         }
//       }
//     }
//   }
// >
