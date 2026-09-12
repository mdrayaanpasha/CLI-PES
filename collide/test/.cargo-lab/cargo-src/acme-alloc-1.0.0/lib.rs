use std::alloc::System;
use std::env;

#[global_allocator]
static GLOBAL: System = System;

pub fn configure() {
    env::set_var("APP_MODE", "prod");
}
