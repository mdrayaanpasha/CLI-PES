use std::panic;

pub fn init() {
    panic::set_hook(Box::new(|_| {}));
    unsafe {
        libc::signal(libc::SIGTERM, handle as usize);
    }
}

extern "C" fn handle(_: i32) {}
