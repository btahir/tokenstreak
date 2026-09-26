// Prevents an extra console window on Windows in release. (macOS-only app, kept for hygiene.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// mimalloc returns memory to the OS promptly after large log scans; macOS's
// default allocator keeps freed multi-megabyte buffers resident.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    tokenstreak_lib::run()
}
