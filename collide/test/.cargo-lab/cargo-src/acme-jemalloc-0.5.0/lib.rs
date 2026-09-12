use jemallocator::Jemalloc;

#[global_allocator]
static ALLOC: Jemalloc = Jemalloc;
