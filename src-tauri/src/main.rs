// Prevents an extra console window on Windows in release. (macOS-only app, kept for hygiene.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// mimalloc returns memory to the OS promptly after large log scans; macOS's
// default allocator keeps freed multi-megabyte buffers resident.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Runs before `main` and before the first allocation, so the heap is
/// labelled as app memory rather than as IOAccelerator (GPU) memory in
/// `footprint`/`vmmap`, and freed pages are returned promptly. See
/// `configure_allocator`.
#[cfg(target_os = "macos")]
#[used]
#[link_section = "__DATA,__mod_init_func"]
static LABEL_HEAP: extern "C" fn() = {
    extern "C" fn label() {
        tokenstreak_core::engine::configure_allocator();
    }
    label
};

fn main() {
    tokenstreak_lib::run()
}
