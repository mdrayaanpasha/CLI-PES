use std::panic;

pub fn init() {
    log::set_logger(&LOGGER).unwrap();
    tracing::subscriber::set_global_default(make_subscriber()).unwrap();
    panic::set_hook(Box::new(|info| {
        eprintln!("panic: {:?}", info);
    }));
}
