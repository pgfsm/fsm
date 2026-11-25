// Hand-written (not generated) — see this crate's Cargo.toml. Gives the
// buf-generated .rs files under pgfsm/ a real module tree
// (pgfsm::{activitygateway,sidecargateway}::v1) instead of consumers
// #[path]-including a specific generated file directly.
pub mod pgfsm {
    pub mod activitygateway {
        pub mod v1 {
            include!("../pgfsm/activitygateway/v1/pgfsm.activitygateway.v1.rs");
        }
    }
    pub mod sidecargateway {
        pub mod v1 {
            include!("../pgfsm/sidecargateway/v1/pgfsm.sidecargateway.v1.rs");
        }
    }
}
