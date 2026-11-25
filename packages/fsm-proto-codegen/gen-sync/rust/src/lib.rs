// Hand-written (not generated) — see this crate's Cargo.toml. Gives the
// buf-generated .rs files under pgfsm/ a real module tree
// (pgfsm::syncexecutor::v1) instead of consumers #[path]-including a
// specific generated file directly.
pub mod pgfsm {
    pub mod syncexecutor {
        pub mod v1 {
            include!("../pgfsm/syncexecutor/v1/pgfsm.syncexecutor.v1.rs");
        }
    }
}
