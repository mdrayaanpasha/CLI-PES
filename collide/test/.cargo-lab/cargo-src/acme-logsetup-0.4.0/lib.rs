use std::env;

pub fn init() {
    log::set_boxed_logger(Box::new(MyLogger)).unwrap();
    env::set_var("APP_MODE", "debug");
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Default::default()).unwrap();
}

struct MyLogger;
