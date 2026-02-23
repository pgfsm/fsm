use pgrx::prelude::*;

::pgrx::pg_module_magic!(name, version);

#[pg_extern]
fn hello_fsm_core() -> &'static str {
    "Hello, fsm_core"
}
// extension_sql_file!("../sql/fsm_core--1.0.sql", name = "fsm_core_sql", requires = [hello_fsm_core]);

// extension_sql_file!("../sql/fsm_core--1.0.sql");
extension_sql_file!("../sql/fsm_core--1.0.sql", name = "fsm_core_1_0_sql");

#[cfg(any(test, feature = "pg_test"))]
#[pg_schema]
mod tests {
    use pgrx::prelude::*;

    #[pg_test]
    fn test_hello_fsm_core() {
        assert_eq!("Hello, fsm_core", crate::hello_fsm_core());
    }

}

/// This module is required by `cargo pgrx test` invocations.
/// It must be visible at the root of your extension crate.
#[cfg(test)]
pub mod pg_test {
    pub fn setup(_options: Vec<&str>) {
        // perform one-off initialization when the pg_test framework starts
    }

    #[must_use]
    pub fn postgresql_conf_options() -> Vec<&'static str> {
        // return any postgresql.conf settings that are required for your tests
        vec![]
    }
}
